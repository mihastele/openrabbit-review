import crypto from 'node:crypto';
import path from 'node:path';
import {
  DEFAULT_OPENRABBIT_CONFIG,
  parseYamlConfig,
} from '../config/config-loader.js';
import { handlePRChat } from '../core/chat-engine.js';
import {
  formatSkippedSummary,
  prepareInlineComments,
} from '../core/inline-comments.js';
import {
  formatInlineCommentMarkdown,
  WALKTHROUGH_COMMENT_MARKER,
} from '../core/markdown-formatter.js';
import { runPullRequestReview } from '../core/review-engine.js';
import {
  remoteMemoryFilePath,
  RemoteWorkspaceRefChangedError,
  withRemoteWorkspace,
} from '../core/remote-workspace.js';
import type {
  InlineFinding,
  OpenRabbitConfig,
  ReviewResult,
} from '../types/index.js';

function githubGitHost(): string {
  if (process.env.GITHUB_WEB_HOST) return process.env.GITHUB_WEB_HOST;
  try {
    const host = new URL(
      process.env.GITHUB_API_URL || 'https://api.github.com'
    ).host;
    return host === 'api.github.com' ? 'github.com' : host;
  } catch {
    return 'github.com';
  }
}

function dataDir(): string {
  return process.env.OPENRABBIT_DATA_DIR || path.join(process.cwd(), 'data');
}

const gitHubCommitSha = /^[a-f0-9]{40}$/i;

export class GitHubPRChangedError extends Error {
  constructor(message: string, readonly postedToGitHub = false) {
    super(message);
  }
}

interface GitHubPRTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  token?: string;
}

interface GitHubPRSnapshot {
  title: string;
  author: string;
  state: 'open' | 'closed';
  draft: boolean;
  baseSha: string;
  baseBranch: string;
  headSha: string;
  headBranch: string;
}

const publishing = new Map<string, Promise<void>>();

export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  const sigBuf = Buffer.from(signatureHeader);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

export async function fetchGitHubPRDiff(
  owner: string,
  repo: string,
  pullNumber: number,
  token?: string
): Promise<string> {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    ''
  );
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3.diff',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `${apiUrl}/repos/${owner}/${repo}/pulls/${pullNumber}`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch GitHub PR diff (${res.status}): ${await res.text()}`);
  }
  return await res.text();
}

export async function fetchGitHubRepoConfig(
  owner: string,
  repo: string,
  ref: string,
  token?: string,
  fallbackConfig: OpenRabbitConfig = DEFAULT_OPENRABBIT_CONFIG
): Promise<OpenRabbitConfig> {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    ''
  );
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3.raw',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (const filename of ['.openrabbit.yaml', '.openrabbit.yml', '.coderabbit.yaml', '.coderabbit.yml']) {
    const res = await fetch(
      `${apiUrl}/repos/${owner}/${repo}/contents/${filename}?ref=${encodeURIComponent(ref)}`,
      { headers, signal: AbortSignal.timeout(30_000) }
    );
    if (res.status === 404) continue;
    if (!res.ok) {
      throw new Error(`Failed to fetch GitHub review configuration (${res.status}).`);
    }
    return parseYamlConfig(await res.text());
  }
  return structuredClone(fallbackConfig);
}

export async function fetchGitHubCompareDiff(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  token?: string
): Promise<string> {
  if (!gitHubCommitSha.test(baseSha) || !gitHubCommitSha.test(headSha)) {
    throw new Error('GitHub comparison requires full base and head commit SHAs.');
  }
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.diff',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiUrl}/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch pinned GitHub diff (${res.status}).`);
  return res.text();
}

interface GitHubPublication {
  id: number;
  body?: string | null;
  user?: { login: string } | null;
}

interface GitHubInlinePublication extends GitHubPublication {
  state: string;
  commit_id?: string;
}

function gitHubPublishHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
}

async function findGitHubPublication<T>(
  endpoint: string,
  headers: Record<string, string>,
  matches: (publication: T) => boolean
): Promise<T | undefined> {
  for (let page = 1; ; page++) {
    const suffix = page === 1 ? '?per_page=100' : `?per_page=100&page=${page}`;
    const response = await fetch(endpoint + suffix, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Failed to list GitHub publications (${response.status}).`);
    }
    const publications: T[] = await response.json();
    const found = publications.find(matches);
    if (found || !response.headers.get('link')?.includes('rel="next"')) return found;
  }
}

async function resolveGitHubPublisher(token: string): Promise<string> {
  const configuredLogin = process.env.GITHUB_BOT_LOGIN?.trim();
  if (configuredLogin) return configuredLogin;
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const response = await fetch(`${apiUrl}/user`, {
    headers: gitHubPublishHeaders(token),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to identify GitHub publisher (${response.status}). Set GITHUB_BOT_LOGIN when using an installation token.`);
  }
  const user: { login?: string } = await response.json();
  if (!user.login) throw new Error('GitHub did not return the publisher login.');
  return user.login;
}

function isOwnedPublication(publication: GitHubPublication, actorLogin: string): boolean {
  return publication.user?.login?.toLowerCase() === actorLogin.toLowerCase();
}

export async function upsertGitHubWalkthroughComment(
  owner: string,
  repo: string,
  pullNumber: number,
  markdownBody: string,
  token: string,
  options?: { actorLogin: string; ensureCurrent: () => Promise<void> }
): Promise<{ commentId: number; updated: boolean }> {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    ''
  );
  const headers = gitHubPublishHeaders(token);
  const endpoint = `${apiUrl}/repos/${owner}/${repo}/issues/${pullNumber}/comments`;
  const existing = await findGitHubPublication<GitHubPublication>(
    endpoint, headers,
    (comment) => Boolean(comment.body?.startsWith(WALKTHROUGH_COMMENT_MARKER)) &&
      (!options || isOwnedPublication(comment, options.actorLogin))
  );
  await options?.ensureCurrent();
  if (existing) {
    if (existing.body === markdownBody) return { commentId: existing.id, updated: false };
    const patchRes = await fetch(
      `${apiUrl}/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body: markdownBody }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!patchRes.ok) {
      throw new Error(`Failed to update walkthrough comment (${patchRes.status})`);
    }
    return { commentId: existing.id, updated: true };
  }

  const createRes = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body: markdownBody }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!createRes.ok) {
    throw new Error(`Failed to post walkthrough comment (${createRes.status})`);
  }
  const created: GitHubPublication = await createRes.json();
  return { commentId: created.id, updated: false };
}

export async function postGitHubInlineReview(
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  findings: InlineFinding[],
  token: string,
  options?: {
    rawDiff?: string;
    maxComments?: number;
    snapshot?: { baseSha: string; actorLogin: string; ensureCurrent: () => Promise<void> };
  }
): Promise<{ reviewId: number; commentsPosted: number; commentsSkipped: number }> {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    ''
  );
  const headers = gitHubPublishHeaders(token);
  const endpoint = `${apiUrl}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;

  const prepared = prepareInlineComments(findings, options?.rawDiff, {
    maxComments: options?.maxComments,
  });
  const inlineComments = prepared.comments.map((f) => ({
    path: f.file,
    line: f.endLine || f.startLine || 1,
     ...(f.startLine && f.endLine && f.startLine < f.endLine
      ? { start_line: f.startLine, start_side: 'RIGHT' }
      : {}),
    side: 'RIGHT',
    body: formatInlineCommentMarkdown(f, 'github'),
  }));

  let body = `🐇 **OpenRabbit** completed an inline code review with **${inlineComments.length}** comment(s)${formatSkippedSummary(prepared.skipped)}.`;
  const snapshot = options?.snapshot;
  if (snapshot) {
    const head = commitSha.toLowerCase();
    const base = snapshot.baseSha.toLowerCase();
    if (!gitHubCommitSha.test(base) || !gitHubCommitSha.test(head)) {
      throw new Error('Inline review publication requires full base and head commit SHAs.');
    }
    const marker = `<!-- openrabbit-inline-review:${base}:${head} -->`;
    const existing = await findGitHubPublication<GitHubInlinePublication>(
      endpoint, headers,
      (review) => review.state === 'COMMENTED' && review.commit_id?.toLowerCase() === head &&
        isOwnedPublication(review, snapshot.actorLogin) && review.body?.trimEnd().endsWith('\n' + marker) === true
    );
    await snapshot.ensureCurrent();
    if (existing) {
      return { reviewId: existing.id, commentsPosted: 0, commentsSkipped: prepared.skipped.length };
    }
    body += '\n\n' + marker;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ commit_id: commitSha, event: 'COMMENT', body, comments: inlineComments }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to post GitHub inline review (${res.status}): ${await res.text()}`
    );
  }
  const data: GitHubPublication = await res.json();
  return {
    reviewId: data.id,
    commentsPosted: inlineComments.length,
    commentsSkipped: prepared.skipped.length,
  };
}

async function reviewGitHubPR(
  target: GitHubPRTarget,
  snapshot: GitHubPRSnapshot,
  config: OpenRabbitConfig
): Promise<ReviewResult> {
  const { owner, repo, pullNumber, token } = target;
  const repository = `${owner}/${repo}`;
  const rawDiff = await fetchGitHubCompareDiff(owner, repo, snapshot.baseSha, snapshot.headSha, token);
  const providerHost = githubGitHost();
  try {
    return await withRemoteWorkspace(
      {
        cloneUrl: `https://${providerHost}/${repository}.git`,
        ref: `refs/pull/${pullNumber}/head`,
        expectedCommit: snapshot.headSha,
        providerHost,
        auth: token ? { username: 'x-access-token', password: token } : undefined,
      },
      ({ path: repoPath }) => runPullRequestReview({
        rawDiff,
        prTitle: snapshot.title,
        repository,
        prNumber: pullNumber,
        author: snapshot.author,
        baseBranch: snapshot.baseBranch,
        headBranch: snapshot.headBranch,
        commitSha: snapshot.headSha,
        source: 'github',
        config,
        repoPath,
        memoryFilePath: remoteMemoryFilePath(dataDir(), 'github', repository),
      })
    );
  } catch (error) {
    if (error instanceof RemoteWorkspaceRefChangedError) {
      throw new GitHubPRChangedError('PR head changed before checkout.');
    }
    throw error;
  }
}

async function isGitHubSnapshotCurrent(
  target: GitHubPRTarget,
  snapshot: GitHubPRSnapshot,
  allowDraft: boolean
): Promise<boolean> {
  const latest = await fetchGitHubPRSnapshot(target);
  return latest.state === 'open' && (allowDraft || !latest.draft) &&
    latest.headSha === snapshot.headSha && latest.baseSha === snapshot.baseSha &&
    latest.baseBranch === snapshot.baseBranch && latest.headBranch === snapshot.headBranch;
}

export async function publishGitHubPRReview(
  target: GitHubPRTarget & { token: string },
  snapshot: { baseSha: string; headSha: string },
  review: ReviewResult,
  isCurrent: () => Promise<boolean>,
  actor?: string
): Promise<void> {
  const { owner, repo, pullNumber, token } = target;
  const key = `${owner}/${repo}#${pullNumber}`.toLowerCase();
  const previous = publishing.get(key) ?? Promise.resolve();
  const publication = previous.catch(() => {}).then(async () => {
    const actorLogin = actor ?? await resolveGitHubPublisher(token);
    let postedWalkthrough = false;
    const ensureCurrent = async () => {
      if (!(await isCurrent())) {
        const message = postedWalkthrough
          ? 'PR changed after posting the walkthrough. Skipped inline review.'
          : 'PR changed during review.';
        throw new GitHubPRChangedError(message, postedWalkthrough);
      }
    };
    await upsertGitHubWalkthroughComment(owner, repo, pullNumber, review.markdownWalkthrough, token, {
      actorLogin, ensureCurrent,
    });
    postedWalkthrough = true;
    if (review.findings.length > 0) {
      await postGitHubInlineReview(owner, repo, pullNumber, snapshot.headSha, review.findings, token, {
        rawDiff: review.rawDiff,
        snapshot: { baseSha: snapshot.baseSha, actorLogin, ensureCurrent },
      });
    }
  });
  publishing.set(key, publication);
  try {
    await publication;
  } finally {
    if (publishing.get(key) === publication) publishing.delete(key);
  }
}

export interface GitHubWebhookResult {
  handled: boolean;
  action: string;
  reviewResult?: ReviewResult;
  chatReply?: string;
  postedToGitHub: boolean;
}

export async function handleGitHubWebhookEvent(
  eventName: string,
  payload: any,
  fallbackConfig: OpenRabbitConfig = DEFAULT_OPENRABBIT_CONFIG
): Promise<GitHubWebhookResult> {
  const token = process.env.GITHUB_TOKEN;

  // 1. Handle Pull Request opened / synchronize / reopened
  if (eventName === 'pull_request') {
    const action = payload.action;
    if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action)) {
      return {
        handled: false,
        action: `Ignored pull_request.${action}`,
        postedToGitHub: false,
      };
    }

    const eventPR = payload.pull_request || {};
    const repoFull = payload.repository?.full_name;
    const pullNumber = Number(eventPR.number || payload.number);
    const skip = (reason: string, postedToGitHub = false): GitHubWebhookResult => ({
      handled: false,
      action: reason,
      postedToGitHub,
    });

    if (payload.simulated_diff) {
      if (eventPR.draft && !fallbackConfig.reviews.auto_review.drafts) {
        return skip('Skipped draft PR (reviews.auto_review.drafts is false)');
      }
      const repository = repoFull || 'org/repo';
      const reviewResult = await runPullRequestReview({
        rawDiff: payload.simulated_diff,
        prTitle: eventPR.title || 'Pull Request',
        repository,
        prNumber: pullNumber || 1,
        author: eventPR.user?.login || 'developer',
        baseBranch: eventPR.base?.ref || 'main',
        headBranch: eventPR.head?.ref || 'feat/update',
        commitSha: eventPR.head?.sha || 'HEAD',
        source: 'github',
        config: fallbackConfig,
        memoryFilePath: remoteMemoryFilePath(dataDir(), 'github', repository),
      });
      return {
        handled: true,
        action: `Reviewed PR #${reviewResult.prNumber} (${action})`,
        reviewResult,
        postedToGitHub: false,
      };
    }

    const expectedHead: unknown = eventPR.head?.sha;
    if (typeof repoFull !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repoFull) ||
        !Number.isSafeInteger(pullNumber) || pullNumber < 1 ||
        typeof expectedHead !== 'string' || !gitHubCommitSha.test(expectedHead)) {
      return skip('Skipped PR event with incomplete snapshot metadata.');
    }
    const [owner, repo] = repoFull.split('/');
    const target = { owner, repo, pullNumber, token };
    const snapshot = await fetchGitHubPRSnapshot(target);
    if (snapshot.state !== 'open' || snapshot.headSha !== expectedHead.toLowerCase()) {
      return skip('Skipped PR event because its head is no longer current.');
    }

    const config = token
      ? await fetchGitHubRepoConfig(owner, repo, snapshot.baseSha, token, fallbackConfig)
      : fallbackConfig;
    const policy = config.reviews.auto_review;
    if (!policy.enabled || (snapshot.draft && !policy.drafts) ||
        (policy.base_branches.length > 0 && !policy.base_branches.includes(snapshot.baseBranch))) {
      return skip('Skipped PR under the base branch automatic review policy.');
    }
    try {
      const reviewResult = await reviewGitHubPR(target, snapshot, config);
      if (token) {
        await publishGitHubPRReview({ ...target, token }, snapshot, reviewResult,
          () => isGitHubSnapshotCurrent(target, snapshot, policy.drafts));
      } else if (!(await isGitHubSnapshotCurrent(target, snapshot, policy.drafts))) {
        return skip('PR changed during review.');
      }
      return {
        handled: true,
        action: `Reviewed PR #${pullNumber} (${action})`,
        reviewResult,
        postedToGitHub: Boolean(token),
      };
    } catch (error) {
      if (error instanceof GitHubPRChangedError) return skip(error.message, error.postedToGitHub);
      throw error;
    }
  }

  // 2. Handle @openrabbit interactive comments on PRs
  if (
    eventName === 'issue_comment' ||
    eventName === 'pull_request_review_comment'
  ) {
    const commentBody: string = payload.comment?.body || '';
    if (
      !/(@openrabbit|@coderabbitai)\b/i.test(commentBody) ||
      payload.action !== 'created'
    ) {
      return {
        handled: false,
        action: 'Comment did not mention @openrabbit',
        postedToGitHub: false,
      };
    }

    const chatRes = await handlePRChat(
      {
        query: commentBody,
        file: payload.comment?.path,
        line: payload.comment?.line || payload.comment?.original_line,
        diff: payload.comment?.diff_hunk || payload.simulated_diff,
        prTitle: payload.issue?.title || payload.pull_request?.title,
      },
      fallbackConfig
    );

    let postedToGitHub = false;
    const repoFull = payload.repository?.full_name || '';
    const [owner, repo] = repoFull.split('/');
    const issueNumber = payload.issue?.number || payload.pull_request?.number;

    if (token && !payload.simulated_diff && owner && repo && issueNumber) {
      const apiUrl = (
        process.env.GITHUB_API_URL || 'https://api.github.com'
      ).replace(/\/$/, '');
      const postResponse = await fetch(`${apiUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'User-Agent': 'OpenRabbit-Bot/1.0',
        },
        body: JSON.stringify({ body: chatRes.replyMarkdown }),
      });
      if (!postResponse.ok) {
        throw new Error(`Failed to post GitHub chat reply (${postResponse.status})`);
      }
      postedToGitHub = true;
    }

    return {
      handled: true,
      action: `Processed @openrabbit ${chatRes.commandDetected} command`,
      chatReply: chatRes.replyMarkdown,
      postedToGitHub,
    };
  }

  return {
    handled: false,
    action: `Unsupported GitHub event: ${eventName}`,
    postedToGitHub: false,
  };
}

export async function fetchGitHubCommitDiff(
  owner: string,
  repo: string,
  commitSha: string,
  token?: string
): Promise<string> {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    ''
  );
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3.diff',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `${apiUrl}/repos/${owner}/${repo}/commits/${commitSha}`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch GitHub commit diff (${res.status}): ${await res.text()}`
    );
  }
  return await res.text();
}

interface GitHubPRResponse {
  title?: string;
  state?: string;
  draft?: boolean;
  head?: { sha?: string; ref?: string };
  base?: { sha?: string; ref?: string };
  user?: { login?: string } | null;
}

async function fetchGitHubPullRequest({
  owner, repo, pullNumber, token,
}: GitHubPRTarget): Promise<GitHubPRResponse> {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) ||
      owner === '.' || owner === '..' || repo === '.' || repo === '..' ||
      !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new Error('Invalid GitHub pull request target.');
  }
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    ''
  );
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `${apiUrl}/repos/${owner}/${repo}/pulls/${pullNumber}`,
    { headers, signal: AbortSignal.timeout(30_000) }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch GitHub PR details (${res.status}): ${await res.text()}`
    );
  }
  return res.json();
}

export async function fetchGitHubPRDetails(
  owner: string,
  repo: string,
  pullNumber: number,
  token?: string
): Promise<{
  title: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  author: string;
}> {
  const data = await fetchGitHubPullRequest({ owner, repo, pullNumber, token });
  return {
    title: data.title || `PR #${pullNumber}`,
    headSha: data.head?.sha || 'HEAD',
    baseBranch: data.base?.ref || 'main',
    headBranch: data.head?.ref || 'update',
    author: data.user?.login || 'developer',
  };
}

async function fetchGitHubPRSnapshot(target: GitHubPRTarget): Promise<GitHubPRSnapshot> {
  const data = await fetchGitHubPullRequest(target);
  const headSha = data.head?.sha;
  const baseSha = data.base?.sha;
  const headBranch = data.head?.ref;
  const baseBranch = data.base?.ref;
  if (!headSha || !gitHubCommitSha.test(headSha) || !baseSha || !gitHubCommitSha.test(baseSha) ||
      !headBranch || !baseBranch || (data.state !== 'open' && data.state !== 'closed')) {
    throw new Error('GitHub PR is missing valid base or head snapshot metadata.');
  }
  return {
    title: data.title || `PR #${target.pullNumber}`,
    author: data.user?.login || 'developer',
    state: data.state,
    draft: data.draft === true,
    headSha: headSha.toLowerCase(),
    baseSha: baseSha.toLowerCase(),
    headBranch,
    baseBranch,
  };
}

export async function runGitHubOnDemandReview(params: {
  owner: string;
  repo: string;
  pullNumber?: number;
  commitSha?: string;
  token?: string;
  postComment?: boolean;
  config?: OpenRabbitConfig;
}): Promise<ReviewResult> {
  const { owner, repo, pullNumber, commitSha, postComment } = params;
  const token = params.token || process.env.GITHUB_TOKEN;
  const config = params.config || DEFAULT_OPENRABBIT_CONFIG;
  if (pullNumber !== undefined) {
    const target = { owner, repo, pullNumber, token };
    const snapshot = await fetchGitHubPRSnapshot(target);
    if (postComment && token && snapshot.state !== 'open') {
      throw new GitHubPRChangedError('PR must be open to publish a review.');
    }
    const reviewConfig = token
      ? await fetchGitHubRepoConfig(owner, repo, snapshot.baseSha, token, config)
      : config;
    const review = await reviewGitHubPR(target, snapshot, reviewConfig);
    if (postComment && token) {
      await publishGitHubPRReview({ ...target, token }, snapshot, review,
        () => isGitHubSnapshotCurrent(target, snapshot, true));
    }
    return review;
  }
  if (!commitSha) {
    throw new Error('Either pullNumber or commitSha is required');
  }

  const repository = `${owner}/${repo}`;
  const rawDiff = await fetchGitHubCommitDiff(owner, repo, commitSha, token);
  return runPullRequestReview({
    rawDiff,
    prTitle: `Commit ${commitSha.slice(0, 7)} (${repository})`,
    repository,
    commitSha,
    source: 'github',
    config,
    memoryFilePath: remoteMemoryFilePath(dataDir(), 'github', repository),
  });
}
