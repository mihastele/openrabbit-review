import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  FsBrowseResult,
  FsFolderEntry,
  LocalCommitInfo,
  LocalRepoInfo,
  LocalSubrepoInfo,
} from '../types/index.js';


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

  // Detect subrepos count
  let subreposCount = 0;
  try {
    subreposCount = findSubrepos(repoDir).length;
  } catch {
    subreposCount = 0;
  }

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
    subreposCount,
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

/**
 * Detects all subrepositories (git submodules or nested git repositories)
 * inside a root repository.
 */
export function findSubrepos(rootRepoPath: string): LocalSubrepoInfo[] {
  const validation = validateGitRepository(rootRepoPath);
  if (!validation.valid || !validation.topLevel) {
    return [];
  }

  const rootDir = validation.topLevel;
  const subreposMap = new Map<string, LocalSubrepoInfo>();

  // 1. Check .gitmodules if present
  const gitmodulesPath = path.join(rootDir, '.gitmodules');
  if (fs.existsSync(gitmodulesPath)) {
    try {
      const content = fs.readFileSync(gitmodulesPath, 'utf8');
      const submoduleBlockRegex = /\[submodule\s+"?([^"\]]+)"?\]([\s\S]*?)(?=(?:\[submodule|$))/g;
      let blockMatch;
      while ((blockMatch = submoduleBlockRegex.exec(content)) !== null) {
        const subName = blockMatch[1].trim();
        const blockBody = blockMatch[2];
        const pathMatch = blockBody.match(/path\s*=\s*([^\r\n]+)/);
        const urlMatch = blockBody.match(/url\s*=\s*([^\r\n]+)/);
        const branchMatch = blockBody.match(/branch\s*=\s*([^\r\n]+)/);

        if (pathMatch) {
          const subRelPath = pathMatch[1].trim().replace(/\\/g, '/');
          const subFullPath = path.resolve(rootDir, subRelPath);
          if (fs.existsSync(subFullPath)) {
            const subBranch =
              safeExec('git rev-parse --abbrev-ref HEAD', subFullPath) ||
              branchMatch?.[1]?.trim() ||
              'main';
            const headSha = safeExec('git rev-parse HEAD', subFullPath) || undefined;
            const statusOutput = safeExec('git status --porcelain', subFullPath);
            const dirtyCount = statusOutput
              ? statusOutput.split('\n').filter((l) => l.trim()).length
              : 0;
            const isClean = dirtyCount === 0;
            const lastCommitMsg =
              safeExec('git log -1 --format=%s', subFullPath) || undefined;
            const lastCommitDate =
              safeExec('git log -1 --format=%aI', subFullPath) || undefined;
            const subRemoteUrl =
              urlMatch?.[1]?.trim() ||
              safeExec('git config --get remote.origin.url', subFullPath) ||
              undefined;
            const normalizedPath = subFullPath.replace(/\\/g, '/').toLowerCase();
            const id =
              'subrepo_' +
              crypto.createHash('sha256').update(normalizedPath).digest('hex').slice(0, 12);

            subreposMap.set(normalizedPath, {
              id,
              name: subName || path.basename(subRelPath),
              relativePath: subRelPath,
              path: subFullPath,
              branch: subBranch,
              remoteUrl: subRemoteUrl,
              isClean,
              modifiedFilesCount: dirtyCount,
              headSha,
              lastCommitMessage: lastCommitMsg,
              lastCommitDate,
              isSubmodule: true,
            });
          }
        }
      }
    } catch {
      // Ignore gitmodules parse error
    }
  }

  // 2. Scan directories up to depth 3 for nested .git directories or git files
  const IGNORED_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'vendor',
    'target',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    'coverage',
    'tmp',
    'temp',
    '.venv',
    'venv',
    '__pycache__',
  ]);

  function scanDir(currentDir: string, currentDepth: number) {
    if (currentDepth > 3) return;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

      const childPath = path.join(currentDir, entry.name);
      const normalizedChild = childPath.replace(/\\/g, '/').toLowerCase();
      const dotGit = path.join(childPath, '.git');

      if (fs.existsSync(dotGit)) {
        // Nested git repository or submodule
        if (!subreposMap.has(normalizedChild)) {
          const subRelPath = path.relative(rootDir, childPath).replace(/\\/g, '/');
          const subBranch =
            safeExec('git rev-parse --abbrev-ref HEAD', childPath) || 'main';
          const headSha = safeExec('git rev-parse HEAD', childPath) || undefined;
          const statusOutput = safeExec('git status --porcelain', childPath);
          const dirtyCount = statusOutput
            ? statusOutput.split('\n').filter((l) => l.trim()).length
            : 0;
          const isClean = dirtyCount === 0;
          const lastCommitMsg =
            safeExec('git log -1 --format=%s', childPath) || undefined;
          const lastCommitDate =
            safeExec('git log -1 --format=%aI', childPath) || undefined;
          const remoteUrl =
            safeExec('git config --get remote.origin.url', childPath) || undefined;
          let isSubmodule = false;
          try {
            isSubmodule = fs.statSync(dotGit).isFile();
          } catch {
            isSubmodule = false;
          }

          const id =
            'subrepo_' +
            crypto.createHash('sha256').update(normalizedChild).digest('hex').slice(0, 12);

          subreposMap.set(normalizedChild, {
            id,
            name: entry.name,
            relativePath: subRelPath,
            path: childPath,
            branch: subBranch,
            remoteUrl,
            isClean,
            modifiedFilesCount: dirtyCount,
            headSha,
            lastCommitMessage: lastCommitMsg,
            lastCommitDate,
            isSubmodule,
          });
        }
        continue;
      }

      scanDir(childPath, currentDepth + 1);
    }
  }

  scanDir(rootDir, 1);

  return Array.from(subreposMap.values()).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
}

/**
 * Safe filesystem directory browser for the folder selector modal.
 */
export function browseFilesystem(
  targetPath?: string,
  workspaceDir?: string
): FsBrowseResult {
  const defaultDir = workspaceDir || process.cwd();
  let resolved: string;

  if (targetPath && targetPath.trim()) {
    resolved = path.resolve(targetPath.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      resolved = path.resolve(defaultDir);
    }
  } else {
    resolved = path.resolve(defaultDir);
  }

  // Detect roots (Drives on Windows, / on Unix)
  const roots: string[] = [];
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < letters.length; i++) {
      const drive = `${letters[i]}:\\`;
      try {
        if (fs.existsSync(drive)) roots.push(drive);
      } catch {
        // ignore
      }
    }
    if (roots.length === 0) roots.push('C:\\');
  } else {
    roots.push('/');
  }

  // Determine parent path
  const parsed = path.parse(resolved);
  const parent = path.dirname(resolved);
  const isAtRoot = resolved.toLowerCase() === parsed.root.toLowerCase();
  const parentPath = isAtRoot ? null : parent;

  // Check if current path is a git repo
  const gitValidation = validateGitRepository(resolved);
  const isGit = gitValidation.valid;
  let branch: string | undefined = undefined;
  if (isGit && gitValidation.topLevel) {
    branch = safeExec('git rev-parse --abbrev-ref HEAD', gitValidation.topLevel) || undefined;
  }

  // Read subfolders
  const folders: FsFolderEntry[] = [];
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip recycle bins and volume information
      if (
        entry.name.startsWith('$') ||
        entry.name === 'System Volume Information' ||
        entry.name === 'node_modules'
      ) {
        continue;
      }

      const fullChild = path.join(resolved, entry.name);
      let childIsGit = false;
      let childBranch: string | undefined = undefined;

      try {
        const dotGit = path.join(fullChild, '.git');
        if (fs.existsSync(dotGit)) {
          childIsGit = true;
          childBranch = safeExec('git rev-parse --abbrev-ref HEAD', fullChild) || 'main';
        }
      } catch {
        // ignore
      }

      folders.push({
        name: entry.name,
        path: fullChild,
        isGit: childIsGit,
        branch: childBranch,
      });
    }
  } catch {
    // If directory access denied, return empty folders list
  }

  // Sort folders: git repos first, then alphabetically
  folders.sort((a, b) => {
    if (a.isGit && !b.isGit) return -1;
    if (!a.isGit && b.isGit) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    currentPath: resolved,
    parentPath,
    isGit,
    branch,
    folders,
    roots,
    homeDir: os.homedir(),
    workspaceDir: defaultDir,
  };
}

