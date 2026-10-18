import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalCommitInfo, LocalRepoInfo } from '../types/index.js';

export interface LocalGitDiffOptions {
  cwd?: string;
  staged?: boolean;
  baseBranch?: string;
  commitRange?: string;
  commitSha?: string;
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 15 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Validates whether the given directory exists and is a valid git repository.
 */
export function validateGitRepository(targetPath: string): {
  valid: boolean;
  error?: string;
  topLevel?: string;
} {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    return { valid: false, error: `Directory does not exist: ${resolved}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { valid: false, error: `Path is not a directory: ${resolved}` };
  }

  const isInside = safeExec('git rev-parse --is-inside-work-tree', resolved);
  if (isInside !== 'true') {
    return {
      valid: false,
      error: `Path is not a git repository (no .git found): ${resolved}`,
    };
  }

  const topLevel = safeExec('git rev-parse --show-toplevel', resolved);
  const normalizedTopLevel = topLevel ? path.resolve(topLevel) : resolved;
  return { valid: true, topLevel: normalizedTopLevel };
}

/**
 * Extracts metadata for a local git repository.
 */
export function getRepoMetadata(
  targetPath: string,
  customName?: string
): LocalRepoInfo {
  const validation = validateGitRepository(targetPath);
  if (!validation.valid || !validation.topLevel) {
    throw new Error(validation.error || 'Invalid git repository');
  }

  const repoDir = validation.topLevel;
  const branch = safeExec('git rev-parse --abbrev-ref HEAD', repoDir) || 'main';
  const remoteUrl = safeExec('git config --get remote.origin.url', repoDir);
  const headSha = safeExec('git rev-parse HEAD', repoDir) || '';

  // Determine repository display name
  let name = customName?.trim() || '';
  if (!name) {
    if (remoteUrl) {
      const match = remoteUrl.match(/[:/]([^/:]+\/[^/.]+?)(?:\.git)?$/);
      if (match) name = match[1];
    }
    if (!name) {
      name = path.basename(repoDir);
    }
  }

  // Check dirty working tree status
  const statusOutput = safeExec('git status --porcelain', repoDir);
  const isClean = statusOutput.length === 0;

  // Last commit info
  const lastCommitSubject = safeExec('git log -1 --format=%s', repoDir) || '';
  const lastCommitDate = safeExec('git log -1 --format=%aI', repoDir) || '';

  // Deterministic stable ID based on absolute path
  const normalizedPath = repoDir.replace(/\\/g, '/').toLowerCase();
  const id =
    'repo_' +
    crypto.createHash('sha256').update(normalizedPath).digest('hex').slice(0, 12);

  return {
    id,
    name,
    path: repoDir,
    branch,
    remoteUrl: remoteUrl || undefined,
    isClean,
    headSha: headSha || undefined,
    lastCommitMessage: lastCommitSubject || undefined,
    lastCommitDate: lastCommitDate || undefined,
    addedAt: new Date().toISOString(),
  };
}

/**
 * Lists commits from a local git repository with rich metadata and stats.
 */
export function getRepoCommits(
  targetPath: string,
  options: { maxCount?: number; branch?: string } = {}
): LocalCommitInfo[] {
  const validation = validateGitRepository(targetPath);
  if (!validation.valid || !validation.topLevel) {
    throw new Error(validation.error || 'Invalid git repository');
  }

  const repoDir = validation.topLevel;
  const max = Math.max(1, Math.min(options.maxCount || 30, 200));
  const branchRef = options.branch ? ` "${options.branch}"` : ' HEAD';

  // Format: %H (sha), %h (short), %an (author), %ae (email), %aI (iso date), %cr (relative date), %s (subject), %b (body)
  const rawLog = safeExec(
    `git log -n ${max} --pretty=format:"%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cr%x1f%s%x1f%b%x1e"${branchRef}`,
    repoDir
  );

  if (!rawLog) return [];

  const rawEntries = rawLog.split('\x1e').map((e) => e.trim()).filter(Boolean);
  const commits: LocalCommitInfo[] = [];

  for (const entry of rawEntries) {
    const parts = entry.split('\x1f');
    if (parts.length < 7) continue;

    const [sha, shortSha, author, email, date, relativeDate, subject, ...restBody] = parts;
    const body = restBody.join('\x1f').trim();

    // Query commit short stats (files changed, additions, deletions)
    const statLine = safeExec(`git show --shortstat --format="" ${sha}`, repoDir);
    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;

    if (statLine) {
      const filesMatch = statLine.match(/(\d+)\s+file/);
      if (filesMatch) filesChanged = Number(filesMatch[1]);
      const insMatch = statLine.match(/(\d+)\s+insertion/);
      if (insMatch) additions = Number(insMatch[1]);
      const delMatch = statLine.match(/(\d+)\s+deletion/);
      if (delMatch) deletions = Number(delMatch[1]);
    }

    commits.push({
      sha: sha.trim(),
      shortSha: shortSha.trim(),
      author: author.trim(),
      email: email.trim(),
      date: date.trim(),
      relativeDate: relativeDate.trim(),
      subject: subject.trim(),
      body: body || undefined,
      filesChanged,
      additions,
      deletions,
    });
  }

  return commits;
}

/**
 * Retrieves the full unified patch diff for a specific commit in a repository.
 */
export function getCommitDiff(
  targetPath: string,
  sha: string
): {
  diff: string;
  commit: LocalCommitInfo;
} {
  const validation = validateGitRepository(targetPath);
  if (!validation.valid || !validation.topLevel) {
    throw new Error(validation.error || 'Invalid git repository');
  }

  const repoDir = validation.topLevel;
  const safeSha = sha.replace(/[^a-fA-F0-9~^._-]/g, '');
  if (!safeSha) {
    throw new Error('Invalid commit SHA');
  }

  const diff = safeExec(`git show --format="" --patch ${safeSha}`, repoDir);

  // Retrieve commit info
  const rawMeta = safeExec(
    `git show -s --pretty=format:"%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cr%x1f%s%x1f%b" ${safeSha}`,
    repoDir
  );
  const parts = rawMeta.split('\x1f');

  const commit: LocalCommitInfo = {
    sha: parts[0]?.trim() || safeSha,
    shortSha: parts[1]?.trim() || safeSha.slice(0, 7),
    author: parts[2]?.trim() || 'unknown',
    email: parts[3]?.trim() || '',
    date: parts[4]?.trim() || new Date().toISOString(),
    relativeDate: parts[5]?.trim() || '',
    subject: parts[6]?.trim() || `Commit ${safeSha.slice(0, 7)}`,
    body: parts.slice(7).join('\x1f').trim() || undefined,
  };

  return {
    diff: diff ? diff + '\n' : '',
    commit,
  };
}

/**
 * Retrieves diff for a commit range (e.g. HEAD~3..HEAD).
 */
export function getCommitRangeDiff(
  targetPath: string,
  range: string
): {
  diff: string;
  title: string;
  count: number;
} {
  const validation = validateGitRepository(targetPath);
  if (!validation.valid || !validation.topLevel) {
    throw new Error(validation.error || 'Invalid git repository');
  }

  const repoDir = validation.topLevel;
  const safeRange = range.replace(/[^a-fA-F0-9~^._\-@/\\]/g, '');
  const diff = safeExec(`git diff ${safeRange}`, repoDir);
  const countStr = safeExec(`git rev-list --count ${safeRange}`, repoDir);
  const count = Number(countStr) || 1;

  return {
    diff: diff ? diff + '\n' : '',
    title: `Commit range ${range} (${count} commit${count === 1 ? '' : 's'})`,
    count,
  };
}

/**
 * Retrieves the local diff based on options (working tree, staged, branch, commit range, or specific commit SHA).
 */
export function getLocalGitDiff(options: LocalGitDiffOptions = {}): {
  diff: string;
  branch: string;
  repoName: string;
  author: string;
  description: string;
  commitSha?: string;
} {
  const rawCwd = options.cwd || process.cwd();
  const validation = validateGitRepository(rawCwd);
  const cwd = validation.topLevel || path.resolve(rawCwd);

  const branch = safeExec('git rev-parse --abbrev-ref HEAD', cwd) || 'main';
  const remoteUrl = safeExec('git config --get remote.origin.url', cwd);
  let repoName = 'local/openrabbit';
  if (remoteUrl) {
    const match = remoteUrl.match(/[:/]([^/:]+\/[^/.]+?)(?:\.git)?$/);
    if (match) repoName = match[1];
  } else {
    const topLevel = safeExec('git rev-parse --show-toplevel', cwd);
    if (topLevel) {
      const folder = topLevel.replace(/\\/g, '/').split('/').pop();
      if (folder) repoName = `local/${folder}`;
    }
  }
  const author = safeExec('git config user.name', cwd) || 'developer';

  let diff = '';
  let description = '';
  let commitSha: string | undefined = undefined;

  if (options.commitSha) {
    const commitData = getCommitDiff(cwd, options.commitSha);
    diff = commitData.diff;
    description = `Commit ${commitData.commit.shortSha}: ${commitData.commit.subject}`;
    commitSha = commitData.commit.sha;
  } else if (options.commitRange) {
    const rangeData = getCommitRangeDiff(cwd, options.commitRange);
    diff = rangeData.diff;
    description = rangeData.title;
  } else if (options.baseBranch) {
    diff = safeExec(`git diff ${options.baseBranch}...HEAD`, cwd);
    description = `Branch diff against ${options.baseBranch}`;
  } else if (options.staged) {
    diff = safeExec('git diff --staged', cwd);
    description = 'Staged changes (git diff --staged)';
  } else {
    // Try unstaged + staged against HEAD, or fallback to last commit
    diff = safeExec('git diff HEAD', cwd);
    description = 'Working tree changes (git diff HEAD)';
    if (!diff) {
      diff = safeExec('git diff --staged', cwd);
      description = 'Staged changes';
    }
    if (!diff) {
      diff = safeExec('git show --format="" --patch HEAD', cwd);
      description = 'Latest commit (HEAD)';
      commitSha = safeExec('git rev-parse HEAD', cwd) || undefined;
    }
  }

  return {
    diff: diff ? diff + '\n' : '',
    branch,
    repoName,
    author,
    description,
    commitSha,
  };
}
