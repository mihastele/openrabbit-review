import crypto from 'node:crypto';
import path from 'node:path';
import {
  DEFAULT_OPENRABBIT_CONFIG,
  parseYamlConfig,
} from '../config/config-loader.js';
import { handlePRChat } from '../core/chat-engine.js';
import {
  formatInlineCommentMarkdown,
  WALKTHROUGH_COMMENT_MARKER,
} from '../core/markdown-formatter.js';
import { runPullRequestReview } from '../core/review-engine.js';
import {
  remoteMemoryFilePath,
  withRemoteWorkspace,
} from '../core/remote-workspace.js';
import type {
  InlineFinding,
  OpenRabbitConfig,
  ReviewResult,
} from '../types/index.js';

export interface ForgejoPullRequestMetadata {
  owner: string;
  repo: string;
  repository: string;
  pullNumber: number;
  prTitle: string;
  commitSha: string;
  baseBranch: string;
  headBranch: string;
  author: string;
  draft: boolean;
  action: string;
}

export interface ForgejoCommentMetadata {
  owner: string;
  repo: string;
  repository: string;
  issueNumber: number;
  commentId: number;
  body: string;
  prTitle?: string;
  file?: string;
  line?: number;
  diff?: string;
}

function apiUrl(): string {
  return (process.env.FORGEJO_API_URL || 'https://codeberg.org/api/v1').replace(
    /\/$/,
    ''
  );
}

function webHost(): string {
  try {
    return new URL(process.env.FORGEJO_WEB_URL || 'https://codeberg.org').host;
  } catch {
    return 'codeberg.org';
  }
}

function dataDir(): string {
  return process.env.OPENRABBIT_DATA_DIR || path.join(process.cwd(), 'data');
}

function headers(token?: string): Record<string, string> {
  const result: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
  if (token) result.Authorization = `token ${token}`;
  return result;
}

const forgejoUserCache = new Map<string, string>();

export async function resolveForgejoGitUsername(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const cached = forgejoUserCache.get(token);
  if (cached) return cached;
  const response = await fetchImpl(`${apiUrl()}/user`, {
    headers: headers(token),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to resolve Forgejo token user (${response.status}); check FORGEJO_TOKEN`
    );
  }
  const value = (await response.json()) as { login?: unknown };
  if (typeof value.login !== 'string' || !value.login) {
    throw new Error('Forgejo token user response did not include a login');
  }
  forgejoUserCache.set(token, value.login);
  return value.login;
}

function splitRepository(fullName: unknown): { owner: string; repo: string } | null {
  if (typeof fullName !== 'string') return null;
  const [owner, repo, ...rest] = fullName.split('/');
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

export function verifyForgejoWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!signatureHeader) return false;
  const provided = signatureHeader.replace(/^sha256=/, '');
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function mapForgejoPullRequest(
  payload: any
): ForgejoPullRequestMetadata | null {
  const action = payload?.action;
  if (!['opened', 'synchronized', 'reopened', 'ready_for_review'].includes(action)) {
    return null;
  }
  const repository = splitRepository(payload?.repository?.full_name);
  const pullRequest = payload?.pull_request;
  const pullNumber = Number(pullRequest?.number || payload?.number || 0);
  if (!repository || !Number.isInteger(pullNumber) || pullNumber <= 0) return null;

  const commitSha = pullRequest?.head?.sha;
  if (typeof commitSha !== 'string' || !commitSha) return null;

  return {
    ...repository,
    repository: payload.repository.full_name,
    pullNumber,
    prTitle:
      typeof pullRequest.title === 'string' && pullRequest.title
        ? pullRequest.title
        : `Pull Request #${pullNumber}`,
    commitSha,
    baseBranch:
      typeof pullRequest.base?.ref === 'string' ? pullRequest.base.ref : 'main',
    headBranch:
      typeof pullRequest.head?.ref === 'string' ? pullRequest.head.ref : 'update',
    author:
      typeof pullRequest.user?.login === 'string'
        ? pullRequest.user.login
        : 'developer',
    draft: Boolean(pullRequest.draft),
    action,
  };
}

export function mapForgejoComment(payload: any): ForgejoCommentMetadata | null {
  if (payload?.action !== 'created') return null;
  if (payload?.is_pull === false) return null;
  if (!payload?.pull_request && payload?.is_pull !== true) return null;

  const repository = splitRepository(payload?.repository?.full_name);
  if (!repository) return null;
  const issueNumber = Number(
    payload?.issue?.number || payload?.pull_request?.number || 0
  );
  const body = payload?.comment?.body;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || typeof body !== 'string') {
    return null;
  }

  return {
    ...repository,
    repository: payload.repository.full_name,
    issueNumber,
    commentId: Number(payload.comment?.id || 0),
    body,
    prTitle: payload?.pull_request?.title || payload?.issue?.title,
    file: payload?.comment?.path,
    line: payload?.comment?.line,
    diff: payload?.simulated_diff || payload?.comment?.diff_hunk,
  };
}

export async function fetchForgejoPRDiff(
  owner: string,
  repo: string,
  pullNumber: number,
  token?: string
): Promise<string> {
  const response = await fetch(
    `${apiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}.diff`,
    { headers: { ...headers(token), Accept: 'text/plain' } }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch Codeberg PR diff (${response.status})`);
  }
  return response.text();
}

export async function fetchForgejoPRDetails(
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
  draft: boolean;
}> {
  const response = await fetch(
    `${apiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    { headers: headers(token) }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch Codeberg PR details (${response.status})`);
  }
  const value = (await response.json()) as any;
  return {
    title: typeof value.title === 'string' ? value.title : `Pull Request #${pullNumber}`,
    headSha: typeof value.head?.sha === 'string' ? value.head.sha : 'HEAD',
    baseBranch: typeof value.base?.ref === 'string' ? value.base.ref : 'main',
    headBranch: typeof value.head?.ref === 'string' ? value.head.ref : 'update',
    author: typeof value.user?.login === 'string' ? value.user.login : 'developer',
    draft: Boolean(value.draft),
  };
}

export async function fetchForgejoRepoConfig(
  owner: string,
  repo: string,
  ref: string,
  token?: string
): Promise<OpenRabbitConfig> {
  for (const filename of [
    '.openrabbit.yaml',
    '.openrabbit.yml',
    '.coderabbit.yaml',
    '.coderabbit.yml',
  ]) {
    const response = await fetch(
      `${apiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(filename)}?ref=${encodeURIComponent(ref)}`,
      { headers: { ...headers(token), Accept: 'text/plain' } }
    );
    if (response.ok) {
      return parseYamlConfig(await response.text());
    }
  }
  return structuredClone(DEFAULT_OPENRABBIT_CONFIG);
}

export async function upsertForgejoWalkthroughComment(
  owner: string,
  repo: string,
  pullNumber: number,
  markdownBody: string,
  token: string
): Promise<{ commentId: number; updated: boolean }> {
  const base = `${apiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const listResponse = await fetch(
    `${base}/issues/${pullNumber}/comments?per_page=100`,
    { headers: headers(token) }
  );
  if (!listResponse.ok) {
    throw new Error(`Failed to list Codeberg PR comments (${listResponse.status})`);
  }
  const comments = (await listResponse.json()) as any[];
  const existing = comments.find(
    (comment) =>
      typeof comment?.body === 'string' &&
      comment.body.includes(WALKTHROUGH_COMMENT_MARKER)
  );

  if (existing) {
    const patchResponse = await fetch(`${base}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: markdownBody }),
    });
    if (!patchResponse.ok) {
      throw new Error(`Failed to update Codeberg walkthrough (${patchResponse.status})`);
    }
    return { commentId: Number(existing.id), updated: true };
  }

  const createResponse = await fetch(`${base}/issues/${pullNumber}/comments`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: markdownBody }),
  });
  if (!createResponse.ok) {
    throw new Error(`Failed to post Codeberg walkthrough (${createResponse.status})`);
  }
  const created = (await createResponse.json()) as any;
  return { commentId: Number(created.id || 0), updated: false };
}

export async function postForgejoInlineReview(
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  findings: InlineFinding[],
  token: string
): Promise<{ reviewId: number; commentsPosted: number }> {
  const response = await fetch(
    `${apiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
    {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commit_id: commitSha,
        event: 'COMMENT',
        body: `🐇 **OpenRabbit** completed an inline code review with **${findings.length}** comment(s).`,
        comments: findings.map((finding) => ({
          path: finding.file,
          new_line_num: finding.endLine || finding.startLine || 1,
          body: formatInlineCommentMarkdown(finding, 'github'),
        })),
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to post Codeberg inline review (${response.status})`);
  }
  const value = (await response.json()) as any;
  return {
    reviewId: Number(value.id || 0),
    commentsPosted: findings.length,
  };
}

export async function postForgejoChatComment(
  owner: string,
  repo: string,
  issueNumber: number,
  markdownBody: string,
  token: string
): Promise<void> {
  const response = await fetch(
    `${apiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: markdownBody }),
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to post Codeberg chat reply (${response.status})`);
  }
}

export interface ForgejoWebhookResult {
  handled: boolean;
  action: string;
  reviewResult?: ReviewResult;
  chatReply?: string;
  postedToForgejo: boolean;
}

export async function handleForgejoWebhookEvent(
  eventName: string,
  payload: any,
  fallbackConfig: OpenRabbitConfig = DEFAULT_OPENRABBIT_CONFIG
): Promise<ForgejoWebhookResult> {
  const token = process.env.FORGEJO_TOKEN;

  if (eventName === 'pull_request') {
    const metadata = mapForgejoPullRequest(payload);
    if (!metadata) {
      return {
        handled: false,
        action: `Ignored Codeberg pull_request.${payload?.action || 'unknown'}`,
        postedToForgejo: false,
      };
    }
    if (!fallbackConfig.reviews.auto_review.enabled) {
      return {
        handled: false,
        action: 'Ignored pull request (reviews.auto_review.enabled is false)',
        postedToForgejo: false,
      };
    }
    if (metadata.draft && !fallbackConfig.reviews.auto_review.drafts) {
      return {
        handled: false,
        action: 'Skipped draft PR (reviews.auto_review.drafts is false)',
        postedToForgejo: false,
      };
    }
    if (
      fallbackConfig.reviews.auto_review.base_branches.length > 0 &&
      !fallbackConfig.reviews.auto_review.base_branches.includes(metadata.baseBranch)
    ) {
      return {
        handled: false,
        action: `Skipped PR targeting unconfigured base branch ${metadata.baseBranch}`,
        postedToForgejo: false,
      };
    }

    let rawDiff = typeof payload.simulated_diff === 'string' ? payload.simulated_diff : '';
    let config = fallbackConfig;
    if (!rawDiff) {
      rawDiff = await fetchForgejoPRDiff(
        metadata.owner,
        metadata.repo,
        metadata.pullNumber,
        token
      );
      if (token) {
        config = await fetchForgejoRepoConfig(
          metadata.owner,
          metadata.repo,
          metadata.commitSha,
          token
        );
      }
    }

    const runReview = (repoPath?: string) =>
      runPullRequestReview({
        rawDiff,
        prTitle: metadata.prTitle,
        repository: metadata.repository,
        prNumber: metadata.pullNumber,
        author: metadata.author,
        baseBranch: metadata.baseBranch,
        headBranch: metadata.headBranch,
        commitSha: metadata.commitSha,
        source: 'forgejo',
        config,
        repoPath,
        memoryFilePath: remoteMemoryFilePath(
          dataDir(),
          'forgejo',
          metadata.repository
        ),
      });

    const reviewResult = payload.simulated_diff
      ? await runReview()
      : await withRemoteWorkspace(
          {
            cloneUrl: payload.repository?.clone_url || '',
            ref: `refs/pull/${metadata.pullNumber}/head`,
            providerHost: webHost(),
            auth: token
              ? {
                  username: await resolveForgejoGitUsername(token),
                  password: token,
                }
              : undefined,
          },
          (workspace) => runReview(workspace.path)
        );

    let postedToForgejo = false;
    if (token && !payload.simulated_diff) {
      await upsertForgejoWalkthroughComment(
        metadata.owner,
        metadata.repo,
        metadata.pullNumber,
        reviewResult.markdownWalkthrough,
        token
      );
      if (reviewResult.findings.length > 0) {
        await postForgejoInlineReview(
          metadata.owner,
          metadata.repo,
          metadata.pullNumber,
          metadata.commitSha,
          reviewResult.findings,
          token
        );
      }
      postedToForgejo = true;
    }

    return {
      handled: true,
      action: `Reviewed Codeberg PR #${metadata.pullNumber} (${metadata.action})`,
      reviewResult,
      postedToForgejo,
    };
  }

  if (eventName === 'issue_comment' || eventName === 'pull_request_comment') {
    const metadata = mapForgejoComment(payload);
    if (!metadata || !/(@openrabbit|@coderabbitai)\b/i.test(metadata.body)) {
      return {
        handled: false,
        action: 'Comment did not mention @openrabbit on a pull request',
        postedToForgejo: false,
      };
    }

    const chat = await handlePRChat(
      {
        query: metadata.body,
        file: metadata.file,
        line: metadata.line,
        diff: metadata.diff,
        prTitle: metadata.prTitle,
      },
      fallbackConfig
    );

    let postedToForgejo = false;
    if (token && !payload.simulated_diff) {
      await postForgejoChatComment(
        metadata.owner,
        metadata.repo,
        metadata.issueNumber,
        chat.replyMarkdown,
        token
      );
      postedToForgejo = true;
    }

    return {
      handled: true,
      action: `Processed Codeberg @openrabbit ${chat.commandDetected} command`,
      chatReply: chat.replyMarkdown,
      postedToForgejo,
    };
  }

  return {
    handled: false,
    action: `Unsupported Codeberg event: ${eventName}`,
    postedToForgejo: false,
  };
}

export async function runForgejoOnDemandReview(params: {
  owner: string;
  repo: string;
  pullNumber?: number;
  commitSha?: string;
  token?: string;
  postComment?: boolean;
  config?: OpenRabbitConfig;
}): Promise<ReviewResult> {
  const token = params.token || process.env.FORGEJO_TOKEN;
  if (!params.pullNumber && !params.commitSha) {
    throw new Error('Either pullNumber or commitSha is required');
  }

  let rawDiff = '';
  let prTitle = `Codeberg Review: ${params.owner}/${params.repo}`;
  let commitSha = params.commitSha || 'HEAD';
  let baseBranch: string | undefined;
  let headBranch: string | undefined;
  let author: string | undefined;
  let config = params.config || structuredClone(DEFAULT_OPENRABBIT_CONFIG);

  if (params.pullNumber) {
    rawDiff = await fetchForgejoPRDiff(
      params.owner,
      params.repo,
      params.pullNumber,
      token
    );
    const details = await fetchForgejoPRDetails(
      params.owner,
      params.repo,
      params.pullNumber,
      token
    );
    prTitle = details.title;
    commitSha = details.headSha;
    baseBranch = details.baseBranch;
    headBranch = details.headBranch;
    author = details.author;
    if (token) {
      config = await fetchForgejoRepoConfig(
        params.owner,
        params.repo,
        commitSha,
        token
      );
    }
  } else {
    throw new Error('Codeberg commit reviews require a pull request number');
  }

  const repoFull = `${params.owner}/${params.repo}`;
  const runReview = (repoPath?: string) =>
    runPullRequestReview({
      rawDiff,
      prTitle,
      repository: repoFull,
      prNumber: params.pullNumber,
      author,
      baseBranch,
      headBranch,
      commitSha,
      source: 'forgejo',
      config,
      repoPath,
      memoryFilePath: remoteMemoryFilePath(dataDir(), 'forgejo', repoFull),
    });

  const reviewResult = await withRemoteWorkspace(
    {
      cloneUrl: `https://${webHost()}/${params.owner}/${params.repo}.git`,
      ref: `refs/pull/${params.pullNumber}/head`,
      providerHost: webHost(),
      auth: token
        ? {
            username: await resolveForgejoGitUsername(token),
            password: token,
          }
        : undefined,
    },
    (workspace) => runReview(workspace.path)
  );

  if (params.postComment && token && params.pullNumber) {
    await upsertForgejoWalkthroughComment(
      params.owner,
      params.repo,
      params.pullNumber,
      reviewResult.markdownWalkthrough,
      token
    );
    if (reviewResult.findings.length > 0) {
      await postForgejoInlineReview(
        params.owner,
        params.repo,
        params.pullNumber,
        commitSha,
        reviewResult.findings,
        token
      );
    }
  }

  return reviewResult;
}

export function parseForgejoTarget(
  input: string
): { owner: string; repo: string; pullNumber: number } | null {
  const short = input.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (short) {
    return {
      owner: short[1],
      repo: short[2],
      pullNumber: Number(short[3]),
    };
  }

  try {
    const url = new URL(input);
    if (url.host !== webHost()) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const pullsIndex = parts.indexOf('pulls');
    if (parts.length !== 4 || pullsIndex !== 2) return null;
    const pullNumber = Number(parts[3]);
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) return null;
    return { owner: parts[0], repo: parts[1], pullNumber };
  } catch {
    return null;
  }
}
