import { execSync } from 'node:child_process';

export interface LocalGitDiffOptions {
  cwd?: string;
  staged?: boolean;
  baseBranch?: string;
  commitRange?: string;
}

export function getLocalGitDiff(options: LocalGitDiffOptions = {}): {
  diff: string;
  branch: string;
  repoName: string;
  author: string;
  description: string;
} {
  const cwd = options.cwd || process.cwd();

  const safeExec = (cmd: string): string => {
    try {
      return execSync(cmd, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  };

  const branch = safeExec('git rev-parse --abbrev-ref HEAD') || 'main';
  const remoteUrl = safeExec('git config --get remote.origin.url');
  let repoName = 'local/openrabbit';
  if (remoteUrl) {
    const match = remoteUrl.match(/[:/]([^/:]+\/[^/.]+?)(?:\.git)?$/);
    if (match) repoName = match[1];
  } else {
    const topLevel = safeExec('git rev-parse --show-toplevel');
    if (topLevel) {
      const folder = topLevel.replace(/\\/g, '/').split('/').pop();
      if (folder) repoName = `local/${folder}`;
    }
  }
  const author = safeExec('git config user.name') || 'developer';

  let diff = '';
  let description = '';

  if (options.commitRange) {
    diff = safeExec(`git diff ${options.commitRange}`);
    description = `Commit range ${options.commitRange}`;
  } else if (options.baseBranch) {
    diff = safeExec(`git diff ${options.baseBranch}...HEAD`);
    description = `Branch diff against ${options.baseBranch}`;
  } else if (options.staged) {
    diff = safeExec('git diff --staged');
    description = 'Staged changes (git diff --staged)';
  } else {
    // Try unstaged + staged against HEAD, or fallback to last commit
    diff = safeExec('git diff HEAD');
    description = 'Working tree changes (git diff HEAD)';
    if (!diff) {
      diff = safeExec('git diff --staged');
      description = 'Staged changes';
    }
    if (!diff) {
      diff = safeExec('git show --format= HEAD');
      description = 'Latest commit (HEAD)';
    }
  }

  return {
    diff: diff ? diff + '\n' : '',
    branch,
    repoName,
    author,
    description,
  };
}
