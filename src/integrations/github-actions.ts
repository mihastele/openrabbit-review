import { runPullRequestReview } from '../core/review-engine.js';
import type { OpenRabbitConfig } from '../types/index.js';
import { fetchGitHubCompareDiff, GitHubPRChangedError, publishGitHubPRReview } from './github.js';

interface WorkflowRun {
  event?: string;
  conclusion?: string;
  head_sha?: string;
  head_branch?: string;
  head_repository?: { id: number } | null;
  pull_requests?: Array<{ number: number }>;
}

interface PullRequest {
  number: number;
  state: string;
  draft: boolean;
  title: string;
  user?: { login: string } | null;
  base: { ref: string; sha: string; repo: { full_name: string } };
  head: { ref: string; sha: string; repo: { id: number } | null };
}

const commitSha = /^[a-f0-9]{40}$/i;

export async function reviewGitHubWorkflowRun({
  run, repository, token, config,
}: {
  run?: WorkflowRun;
  repository: string;
  token: string;
  config: OpenRabbitConfig;
}): Promise<string> {
  if (run?.event !== 'pull_request' || run.conclusion !== 'success') {
    return 'Skipped a run that did not pass PR CI.';
  }
  const policy = config.reviews.auto_review;
  if (!policy.enabled) return 'Skipped because automatic reviews are disabled.';

  const headSha = run.head_sha;
  const headRepoId = run.head_repository?.id;
  const headBranch = run.head_branch;
  if (!headSha || !commitSha.test(headSha) || !headRepoId || !headBranch) {
    return 'Skipped because the CI run has no complete PR head metadata.';
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('Invalid GitHub repository for Actions review.');
  }

  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  async function get(path: string): Promise<Response> {
    const response = await fetch(`${apiUrl}/repos/${repository}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'OpenRabbit-Bot/1.0',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub Actions review request failed (${response.status}).`);
    return response;
  }

  async function getPullRequest(number: number): Promise<PullRequest> {
    const response = await get(`/pulls/${number}`);
    return response.json();
  }

  function matchesOpenHead(pr: PullRequest): boolean {
    return pr.state === 'open' &&
      pr.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
      pr.head.sha === headSha &&
      pr.head.ref === headBranch &&
      pr.head.repo?.id === headRepoId;
  }

  // GitHub can omit the PR association for fork runs.
  const numbers = [...new Set(run.pull_requests?.map((pr) => pr.number) ?? [])];
  if (numbers.some((number) => !Number.isSafeInteger(number) || number < 1)) {
    throw new Error('Invalid pull request number in the CI run.');
  }
  let candidates: PullRequest[];
  if (numbers.length > 0) {
    candidates = await Promise.all(numbers.map(getPullRequest));
  } else {
    const associated = await get(`/commits/${headSha}/pulls?per_page=100`);
    if (associated.headers.get('link')?.includes('rel="next"')) {
      return 'Skipped because the PR associated with the CI run could not be determined uniquely.';
    }
    candidates = await associated.json();
  }
  const matching = candidates.filter(matchesOpenHead);
  if (matching.length !== 1) return 'Skipped because there is no unique open PR at the reviewed head.';
  const [pr] = matching;
  if ((!policy.drafts && pr.draft) ||
      (policy.base_branches.length > 0 && !policy.base_branches.includes(pr.base.ref))) {
    return 'Skipped because the PR does not meet the automatic review policy.';
  }
  const baseSha = pr.base.sha;
  if (!commitSha.test(baseSha) || !Number.isSafeInteger(pr.number) || pr.number < 1) {
    throw new Error('Invalid GitHub PR snapshot metadata.');
  }

  const [owner, repo] = repository.split('/');
  const rawDiff = await fetchGitHubCompareDiff(owner, repo, baseSha, headSha, token);
  const review = await runPullRequestReview({
    rawDiff,
    prTitle: pr.title,
    repository,
    prNumber: pr.number,
    author: pr.user?.login,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    commitSha: headSha,
    source: 'github',
    config,
  });

  try {
    await publishGitHubPRReview(
      { owner, repo, pullNumber: pr.number, token },
      { baseSha, headSha },
      review,
      async () => {
        const latest = await getPullRequest(pr.number);
        return matchesOpenHead(latest) && latest.base.sha === baseSha &&
          latest.base.ref === pr.base.ref && (policy.drafts || !latest.draft);
      },
      'github-actions[bot]'
    );
  } catch (error) {
    if (error instanceof GitHubPRChangedError) return error.message;
    throw error;
  }
  return 'Published OpenRabbit review for PR #' + pr.number + '.';
}
