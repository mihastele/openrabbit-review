import { DEFAULT_OPENRABBIT_CONFIG } from '../config/config-loader.js';
import { handlePRChat } from '../core/chat-engine.js';
import {
  formatInlineCommentMarkdown,
  WALKTHROUGH_COMMENT_MARKER,
} from '../core/markdown-formatter.js';
import { runPullRequestReview } from '../core/review-engine.js';
import type { OpenRabbitConfig, ReviewResult } from '../types/index.js';

export function verifyGitLabWebhookToken(
  headerToken: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) return true;
  return headerToken === secret;
}

export async function fetchGitLabMRDiff(
  projectId: string | number,
  mrIid: number,
  token?: string
): Promise<string> {
  const apiUrl = (
    process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4'
  ).replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (token) headers['PRIVATE-TOKEN'] = token;

  const res = await fetch(
    `${apiUrl}/projects/${encodeURIComponent(
      String(projectId)
    )}/merge_requests/${mrIid}/changes`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch GitLab MR changes (${res.status})`);
  }
  const data = (await res.json()) as any;
  const changes: any[] = data.changes || [];

  return changes
    .map(
      (c) =>
        `diff --git a/${c.old_path} b/${c.new_path}\n--- a/${c.old_path}\n+++ b/${c.new_path}\n${c.diff}`
    )
    .join('\n');
}

export interface GitLabWebhookResult {
  handled: boolean;
  action: string;
  reviewResult?: ReviewResult;
  chatReply?: string;
  postedToGitLab: boolean;
}

export async function handleGitLabWebhookEvent(
  eventHeader: string,
  payload: any,
  config: OpenRabbitConfig = DEFAULT_OPENRABBIT_CONFIG
): Promise<GitLabWebhookResult> {
  const token = process.env.GITLAB_TOKEN;
  const objectKind = payload.object_kind;

  if (
    objectKind === 'merge_request' ||
    eventHeader === 'Merge Request Hook'
  ) {
    const attrs = payload.object_attributes || {};
    const action = attrs.action || 'open';
    if (!['open', 'reopen', 'update'].includes(action)) {
      return {
        handled: false,
        action: `Ignored GitLab MR action: ${action}`,
        postedToGitLab: false,
      };
    }

    const projectId = payload.project?.id || '1';
    const repoName = payload.project?.path_with_namespace || 'gitlab-org/project';
    const mrIid = Number(attrs.iid || 1);
    const prTitle = attrs.title || 'Merge Request';
    const baseBranch = attrs.target_branch || 'main';
    const headBranch = attrs.source_branch || 'feat/branch';
    const commitSha = attrs.last_commit?.id || 'HEAD';
    const author = payload.user?.username || 'developer';

    let rawDiff = payload.simulated_diff || '';
    if (!rawDiff) {
      rawDiff = await fetchGitLabMRDiff(projectId, mrIid, token);
    }

    const reviewResult = await runPullRequestReview({
      rawDiff,
      prTitle,
      repository: repoName,
      prNumber: mrIid,
      author,
      baseBranch,
      headBranch,
      commitSha,
      source: 'gitlab',
      config,
    });

    let postedToGitLab = false;
    if (token && !payload.simulated_diff) {
      const apiUrl = (
        process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4'
      ).replace(/\/$/, '');
      const headers = {
        'PRIVATE-TOKEN': token,
        'Content-Type': 'application/json',
      };

      // Post Walkthrough Note
      await fetch(
        `${apiUrl}/projects/${encodeURIComponent(
          String(projectId)
        )}/merge_requests/${mrIid}/notes`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            body:
              reviewResult.markdownWalkthrough +
              '\n\n' +
              reviewResult.findings
                .map(
                  (f) =>
                    `#### \`${f.file}:${f.startLine}\`\n` +
                    formatInlineCommentMarkdown(f, 'gitlab')
                )
                .join('\n\n---\n\n'),
          }),
        }
      );
      postedToGitLab = true;
    }

    return {
      handled: true,
      action: `Reviewed GitLab MR !${mrIid} (${action})`,
      reviewResult,
      postedToGitLab,
    };
  }

  if (objectKind === 'note' || eventHeader === 'Note Hook') {
    const noteBody: string = payload.object_attributes?.note || '';
    if (!/@openrabbit\b/i.test(noteBody)) {
      return {
        handled: false,
        action: 'Note did not mention @openrabbit',
        postedToGitLab: false,
      };
    }

    const chatRes = await handlePRChat(
      {
        query: noteBody,
        prTitle: payload.merge_request?.title,
        diff: payload.simulated_diff,
      },
      config
    );

    return {
      handled: true,
      action: `Processed GitLab @openrabbit ${chatRes.commandDetected} command`,
      chatReply: chatRes.replyMarkdown,
      postedToGitLab: false,
    };
  }

  return {
    handled: false,
    action: `Unsupported GitLab event: ${eventHeader || objectKind}`,
    postedToGitLab: false,
  };
}
