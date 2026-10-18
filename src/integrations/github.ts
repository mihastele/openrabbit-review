import crypto from 'node:crypto';
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
import type {
  InlineFinding,
  OpenRabbitConfig,
  ReviewResult,
} from '../types/index.js';

export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) return true; // No secret configured => allow in local/dev mode
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
  token?: string
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

  for (const filename of ['.openrabbit.yaml', '.openrabbit.yml', '.coderabbit.yaml']) {
    try {
      const res = await fetch(
        `${apiUrl}/repos/${owner}/${repo}/contents/${filename}?ref=${encodeURIComponent(
          ref
        )}`,
        { headers }
      );
      if (res.ok) {
        const rawYaml = await res.text();
        return parseYamlConfig(rawYaml);
      }
    } catch {
      // Ignore and try next
    }
  }
  return structuredClone(DEFAULT_OPENRABBIT_CONFIG);
}

export async function upsertGitHubWalkthroughComment(
  owner: string,
  repo: string,
  pullNumber: number,
  markdownBody: string,
  token: string
): Promise<{ commentId: number; updated: boolean }> {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    ''
  );
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };

  // Check if a sticky walkthrough comment already exists
  const listRes = await fetch(
    `${apiUrl}/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=100`,
    { headers }
  );
  if (listRes.ok) {
    const comments = (await listRes.json()) as any[];
    const existing = comments.find(
      (c) => typeof c.body === 'string' && c.body.includes(WALKTHROUGH_COMMENT_MARKER)
    );
    if (existing) {
      const patchRes = await fetch(
        `${apiUrl}/repos/${owner}/${repo}/issues/comments/${existing.id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ body: markdownBody }),
        }
      );
      if (!patchRes.ok) {
        throw new Error(`Failed to update walkthrough comment (${patchRes.status})`);
      }
      return { commentId: existing.id, updated: true };
    }
  }

  const createRes = await fetch(
    `${apiUrl}/repos/${owner}/${repo}/issues/${pullNumber}/comments`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: markdownBody }),
    }
  );
  if (!createRes.ok) {
    throw new Error(`Failed to post walkthrough comment (${createRes.status})`);
  }
  const created = (await createRes.json()) as any;
  return { commentId: created.id, updated: false };
}

export async function postGitHubInlineReview(
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  findings: InlineFinding[],
  token: string
): Promise<{ reviewId: number; commentsPosted: number }> {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    ''
  );
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };

  const inlineComments = findings.map((f) => ({
    path: f.file,
    line: f.endLine || f.startLine || 1,
     ...(f.startLine && f.endLine && f.startLine < f.endLine
      ? { start_line: f.startLine, start_side: 'RIGHT' }
      : {}),
    side: 'RIGHT',
    body: formatInlineCommentMarkdown(f, 'github'),
  }));

  const res = await fetch(
    `${apiUrl}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        commit_id: commitSha,
        event: 'COMMENT',
        body: `🐇 **OpenRabbit** completed an inline code review with **${inlineComments.length}** comment(s).`,
        comments: inlineComments,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(
      `Failed to post GitHub inline review (${res.status}): ${await res.text()}`
    );
  }
  const data = (await res.json()) as any;
  return {
    reviewId: data.id,
    commentsPosted: inlineComments.length,
  };
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

    const pr = payload.pull_request || {};
    const repoFull = payload.repository?.full_name || 'org/repo';
    const [owner, repo] = repoFull.split('/');
    const pullNumber = Number(pr.number || payload.number || 1);
    const prTitle = pr.title || 'Pull Request';
    const commitSha = pr.head?.sha || 'HEAD';
    const baseBranch = pr.base?.ref || 'main';
    const headBranch = pr.head?.ref || 'feat/update';
    const author = pr.user?.login || 'developer';

    if (pr.draft && !fallbackConfig.reviews.auto_review.drafts) {
      return {
        handled: false,
        action: 'Skipped draft PR (reviews.auto_review.drafts is false)',
        postedToGitHub: false,
      };
    }

    let rawDiff = payload.simulated_diff || '';
    let config = fallbackConfig;

    if (!rawDiff && owner && repo) {
      rawDiff = await fetchGitHubPRDiff(owner, repo, pullNumber, token);
      if (token) {
        config = await fetchGitHubRepoConfig(owner, repo, commitSha, token);
      }
    }

    const reviewResult = await runPullRequestReview({
      rawDiff,
      prTitle,
      repository: repoFull,
      prNumber: pullNumber,
      author,
      baseBranch,
      headBranch,
      commitSha,
      source: 'github',
      config,
    });

    let postedToGitHub = false;
    if (token && !payload.simulated_diff && owner && repo) {
      await upsertGitHubWalkthroughComment(
        owner,
        repo,
        pullNumber,
        reviewResult.markdownWalkthrough,
        token
      );
      if (reviewResult.findings.length > 0) {
        await postGitHubInlineReview(
          owner,
          repo,
          pullNumber,
          commitSha,
          reviewResult.findings,
          token
        );
      }
      postedToGitHub = true;
    }

    return {
      handled: true,
      action: `Reviewed PR #${pullNumber} (${action})`,
      reviewResult,
      postedToGitHub,
    };
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
      await fetch(`${apiUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'OpenRabbit-Bot/1.0',
        },
        body: JSON.stringify({ body: chatRes.replyMarkdown }),
      });
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
    { headers }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch GitHub PR details (${res.status}): ${await res.text()}`
    );
  }
  const data = (await res.json()) as any;
  return {
    title: data.title || `PR #${pullNumber}`,
    headSha: data.head?.sha || 'HEAD',
    baseBranch: data.base?.ref || 'main',
    headBranch: data.head?.ref || 'update',
    author: data.user?.login || 'developer',
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
  const token = params.token || process.env.GITHUB_TOKEN;
  let rawDiff = '';
  let prTitle = `GitHub Review: ${params.owner}/${params.repo}`;
  let commitSha = params.commitSha || 'HEAD';
  let baseBranch: string | undefined = undefined;
  let headBranch: string | undefined = undefined;
  let author: string | undefined = undefined;

  let config = params.config || structuredClone(DEFAULT_OPENRABBIT_CONFIG);

  if (params.pullNumber) {
    rawDiff = await fetchGitHubPRDiff(
      params.owner,
      params.repo,
      params.pullNumber,
      token
    );
    try {
      const details = await fetchGitHubPRDetails(
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
    } catch {
      prTitle = `PR #${params.pullNumber} (${params.owner}/${params.repo})`;
    }
    if (token) {
      config = await fetchGitHubRepoConfig(
        params.owner,
        params.repo,
        commitSha,
        token
      );
    }
  } else if (params.commitSha) {
    rawDiff = await fetchGitHubCommitDiff(
      params.owner,
      params.repo,
      params.commitSha,
      token
    );
    prTitle = `Commit ${params.commitSha.slice(0, 7)} (${params.owner}/${params.repo})`;
  } else {
    throw new Error('Either pullNumber or commitSha is required');
  }

  const reviewResult = await runPullRequestReview({
    rawDiff,
    prTitle,
    repository: `${params.owner}/${params.repo}`,
    prNumber: params.pullNumber,
    author,
    baseBranch,
    headBranch,
    commitSha,
    source: 'github',
    config,
  });

  if (params.postComment && token && params.pullNumber) {
    await upsertGitHubWalkthroughComment(
      params.owner,
      params.repo,
      params.pullNumber,
      reviewResult.markdownWalkthrough,
      token
    );
    if (reviewResult.findings.length > 0) {
      await postGitHubInlineReview(
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

