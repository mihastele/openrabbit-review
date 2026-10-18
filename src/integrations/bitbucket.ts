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

export function verifyBitbucketWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) return true;
  if (!signatureHeader) return false;

  const cleanSig = signatureHeader.replace(/^sha256=/, '');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  const sigBuf = Buffer.from(cleanSig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

export async function fetchBitbucketPRDiff(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
  token?: string
): Promise<string> {
  const apiUrl = (
    process.env.BITBUCKET_API_URL || 'https://api.bitbucket.org/2.0'
  ).replace(/\/$/, '');

  const headers: Record<string, string> = {
    Accept: 'text/plain',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
  if (token) {
    headers.Authorization = token.startsWith('Bearer ')
      ? token
      : `Bearer ${token}`;
  }

  const res = await fetch(
    `${apiUrl}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repoSlug
    )}/pullrequests/${pullRequestId}/diff`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(
      `Failed to fetch Bitbucket PR diff (${res.status}): ${await res.text()}`
    );
  }
  return await res.text();
}

export async function fetchBitbucketCommitDiff(
  workspace: string,
  repoSlug: string,
  commitSha: string,
  token?: string
): Promise<string> {
  const apiUrl = (
    process.env.BITBUCKET_API_URL || 'https://api.bitbucket.org/2.0'
  ).replace(/\/$/, '');

  const headers: Record<string, string> = {
    Accept: 'text/plain',
    'User-Agent': 'OpenRabbit-Bot/1.0',
  };
  if (token) {
    headers.Authorization = token.startsWith('Bearer ')
      ? token
      : `Bearer ${token}`;
  }

  const res = await fetch(
    `${apiUrl}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repoSlug
    )}/diff/${encodeURIComponent(commitSha)}`,
    { headers }
  );

  if (!res.ok) {
    throw new Error(
      `Failed to fetch Bitbucket commit diff (${res.status}): ${await res.text()}`
    );
  }
  return await res.text();
}

export async function postBitbucketPRComment(
  workspace: string,
  repoSlug: string,
  pullRequestId: number,
  markdownBody: string,
  token: string
): Promise<{ id: number }> {
  const apiUrl = (
    process.env.BITBUCKET_API_URL || 'https://api.bitbucket.org/2.0'
  ).replace(/\/$/, '');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
  };

  const res = await fetch(
    `${apiUrl}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repoSlug
    )}/pullrequests/${pullRequestId}/comments`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: {
          raw: markdownBody,
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(
      `Failed to post Bitbucket comment (${res.status}): ${await res.text()}`
    );
  }
  const data = (await res.json()) as any;
  return { id: data.id || 0 };
}

export interface BitbucketWebhookResult {
  handled: boolean;
  action: string;
  reviewResult?: ReviewResult;
  chatReply?: string;
  postedToBitbucket: boolean;
}

export async function handleBitbucketWebhookEvent(
  eventKey: string,
  payload: any,
  fallbackConfig: OpenRabbitConfig = DEFAULT_OPENRABBIT_CONFIG
): Promise<BitbucketWebhookResult> {
  const token = process.env.BITBUCKET_TOKEN;

  // 1. Handle PR created or updated
  if (
    eventKey === 'pullrequest:created' ||
    eventKey === 'pullrequest:updated'
  ) {
    const pr = payload.pullrequest || {};
    const repoFull = payload.repository?.full_name || 'workspace/repo';
    const [workspace, repoSlug] = repoFull.split('/');
    const pullRequestId = Number(pr.id || 1);
    const prTitle = pr.title || 'Pull Request';
    const commitSha = pr.source?.commit?.hash || 'HEAD';
    const baseBranch = pr.destination?.branch?.name || 'main';
    const headBranch = pr.source?.branch?.name || 'feat/update';
    const author =
      pr.author?.display_name || pr.author?.nickname || 'developer';

    let rawDiff = payload.simulated_diff || '';
    if (!rawDiff && workspace && repoSlug) {
      rawDiff = await fetchBitbucketPRDiff(
        workspace,
        repoSlug,
        pullRequestId,
        token
      );
    }

    const reviewResult = await runPullRequestReview({
      rawDiff,
      prTitle,
      repository: repoFull,
      prNumber: pullRequestId,
      author,
      baseBranch,
      headBranch,
      commitSha,
      source: 'bitbucket',
      config: fallbackConfig,
    });

    let postedToBitbucket = false;
    if (token && !payload.simulated_diff && workspace && repoSlug) {
      const combinedComment =
        reviewResult.markdownWalkthrough +
        '\n\n' +
        reviewResult.findings
          .map(
            (f) =>
              `#### \`${f.file}:${f.startLine}\`\n` +
              formatInlineCommentMarkdown(f, 'github')
          )
          .join('\n\n---\n\n');

      await postBitbucketPRComment(
        workspace,
        repoSlug,
        pullRequestId,
        combinedComment,
        token
      );
      postedToBitbucket = true;
    }

    return {
      handled: true,
      action: `Reviewed Bitbucket PR #${pullRequestId} (${eventKey})`,
      reviewResult,
      postedToBitbucket,
    };
  }

  // 2. Handle PR comment (@openrabbit chat command)
  if (eventKey === 'pullrequest:comment_created') {
    const commentBody: string = payload.comment?.content?.raw || '';
    if (!/@openrabbit\b/i.test(commentBody)) {
      return {
        handled: false,
        action: 'Bitbucket comment did not mention @openrabbit',
        postedToBitbucket: false,
      };
    }

    const chatRes = await handlePRChat(
      {
        query: commentBody,
        prTitle: payload.pullrequest?.title,
        diff: payload.simulated_diff,
      },
      fallbackConfig
    );

    let postedToBitbucket = false;
    const repoFull = payload.repository?.full_name || '';
    const [workspace, repoSlug] = repoFull.split('/');
    const pullRequestId = payload.pullrequest?.id;

    if (token && !payload.simulated_diff && workspace && repoSlug && pullRequestId) {
      await postBitbucketPRComment(
        workspace,
        repoSlug,
        pullRequestId,
        chatRes.replyMarkdown,
        token
      );
      postedToBitbucket = true;
    }

    return {
      handled: true,
      action: `Processed Bitbucket @openrabbit ${chatRes.commandDetected} command`,
      chatReply: chatRes.replyMarkdown,
      postedToBitbucket,
    };
  }

  return {
    handled: false,
    action: `Unsupported Bitbucket event: ${eventKey}`,
    postedToBitbucket: false,
  };
}

export async function runBitbucketOnDemandReview(params: {
  workspace: string;
  repoSlug: string;
  pullRequestId?: number;
  commitSha?: string;
  token?: string;
  config?: OpenRabbitConfig;
}): Promise<ReviewResult> {
  const token = params.token || process.env.BITBUCKET_TOKEN;
  let rawDiff = '';
  let prTitle = `Bitbucket Review: ${params.workspace}/${params.repoSlug}`;

  if (params.pullRequestId) {
    rawDiff = await fetchBitbucketPRDiff(
      params.workspace,
      params.repoSlug,
      params.pullRequestId,
      token
    );
    prTitle = `Bitbucket PR #${params.pullRequestId}: ${params.workspace}/${params.repoSlug}`;
  } else if (params.commitSha) {
    rawDiff = await fetchBitbucketCommitDiff(
      params.workspace,
      params.repoSlug,
      params.commitSha,
      token
    );
    prTitle = `Bitbucket Commit ${params.commitSha.slice(0, 7)}: ${params.workspace}/${params.repoSlug}`;
  } else {
    throw new Error('Either pullRequestId or commitSha is required');
  }

  return await runPullRequestReview({
    rawDiff,
    prTitle,
    repository: `${params.workspace}/${params.repoSlug}`,
    prNumber: params.pullRequestId,
    commitSha: params.commitSha,
    source: 'bitbucket',
    config: params.config || DEFAULT_OPENRABBIT_CONFIG,
  });
}
