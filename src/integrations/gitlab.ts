import path from 'node:path';
import { DEFAULT_OPENRABBIT_CONFIG } from '../config/config-loader.js';
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
import type { OpenRabbitConfig, ReviewResult } from '../types/index.js';

function gitlabGitHost(): string {
  if (process.env.GITLAB_WEB_HOST) return process.env.GITLAB_WEB_HOST;
  try {
    return new URL(
      process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4'
    ).host;
  } catch {
    return 'gitlab.com';
  }
}

function dataDir(): string {
  return process.env.OPENRABBIT_DATA_DIR || path.join(process.cwd(), 'data');
}

function gitlabCloneUrl(payload: any): string {
  if (typeof payload?.project?.git_http_url === 'string') {
    return payload.project.git_http_url;
  }
  if (typeof payload?.project?.web_url === 'string') {
    return `${payload.project.web_url.replace(/\/$/, '')}.git`;
  }
  return '';
}

export function verifyGitLabWebhookToken(
  headerToken: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) return process.env.NODE_ENV !== 'production';
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

    const runReview = (repoPath?: string) =>
      runPullRequestReview({
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
        repoPath,
        memoryFilePath: remoteMemoryFilePath(dataDir(), 'gitlab', repoName),
      });

    const reviewResult = payload.simulated_diff
      ? await runReview()
      : await withRemoteWorkspace(
          {
            cloneUrl: gitlabCloneUrl(payload),
            ref: `refs/merge-requests/${mrIid}/head`,
            providerHost: gitlabGitHost(),
            auth: token ? { username: 'oauth2', password: token } : undefined,
          },
          (workspace) => runReview(workspace.path)
        );

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
      const noteResponse = await fetch(
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
      if (!noteResponse.ok) {
        throw new Error(`Failed to post GitLab review note (${noteResponse.status})`);
      }
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

async function fetchGitLabProjectWebUrl(
  projectId: string | number,
  token?: string
): Promise<string> {
  const apiUrl = (
    process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4'
  ).replace(/\/$/, '');
  const response = await fetch(
    `${apiUrl}/projects/${encodeURIComponent(String(projectId))}`,
    { headers: token ? { 'PRIVATE-TOKEN': token } : {} }
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch GitLab project (${response.status})`);
  }
  const value = (await response.json()) as any;
  if (typeof value.web_url !== 'string') {
    throw new Error('GitLab project response did not include web_url');
  }
  return `${value.web_url.replace(/\/$/, '')}.git`;
}

export async function fetchGitLabCommitDiff(
  projectId: string | number,
  commitSha: string,
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
    )}/repository/commits/${encodeURIComponent(commitSha)}/diff`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch GitLab commit diff (${res.status})`);
  }
  const changes = (await res.json()) as any[];
  return changes
    .map(
      (c) =>
        `diff --git a/${c.old_path} b/${c.new_path}\n--- a/${c.old_path}\n+++ b/${c.new_path}\n${c.diff}`
    )
    .join('\n');
}

export async function runGitLabOnDemandReview(params: {
  projectId: string | number;
  mrIid?: number;
  commitSha?: string;
  token?: string;
  config?: OpenRabbitConfig;
}): Promise<ReviewResult> {
  const token = params.token || process.env.GITLAB_TOKEN;
  let rawDiff = '';
  let prTitle = `GitLab Review: Project ${params.projectId}`;

  if (params.mrIid) {
    rawDiff = await fetchGitLabMRDiff(params.projectId, params.mrIid, token);
    prTitle = `GitLab MR !${params.mrIid} (Project ${params.projectId})`;
  } else if (params.commitSha) {
    rawDiff = await fetchGitLabCommitDiff(
      params.projectId,
      params.commitSha,
      token
    );
    prTitle = `GitLab Commit ${params.commitSha.slice(0, 7)} (Project ${params.projectId})`;
  } else {
    throw new Error('Either mrIid or commitSha is required');
  }

  const repository = `gitlab/${params.projectId}`;
  const runReview = (repoPath?: string) =>
    runPullRequestReview({
      rawDiff,
      prTitle,
      repository,
      prNumber: params.mrIid,
      commitSha: params.commitSha,
      source: 'gitlab',
      config: params.config || DEFAULT_OPENRABBIT_CONFIG,
      repoPath,
      memoryFilePath: remoteMemoryFilePath(dataDir(), 'gitlab', repository),
    });

  if (!params.mrIid) return await runReview();

  const cloneUrl = await fetchGitLabProjectWebUrl(params.projectId, token);
  return await withRemoteWorkspace(
    {
      cloneUrl,
      ref: `refs/merge-requests/${params.mrIid}/head`,
      providerHost: gitlabGitHost(),
      auth: token ? { username: 'oauth2', password: token } : undefined,
    },
    (workspace) => runReview(workspace.path)
  );
}

