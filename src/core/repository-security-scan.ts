import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shouldReviewFile } from '../config/config-loader.js';
import { validateGitRepository } from './git-utils.js';

/** Build a bounded patch from tracked working-tree text files for offline security rules. */
export function buildRepositorySecurityDiff(repoPath: string, filters: string[]) {
  const validation = validateGitRepository(repoPath);
  if (!validation.valid || !validation.topLevel) throw new Error(validation.error || 'Invalid repository');
  const root = validation.topLevel;
  const realRoot = fs.realpathSync(root);
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const patches: string[] = [];
  let skipped = 0;
  let bytes = 0;
  for (const name of [...new Set(files)]) {
    if (!shouldReviewFile(name, filters)) { skipped++; continue; }
    if (/[\r\n]/.test(name) || name.includes(' b/')) throw new Error(`Unsupported tracked file path: ${JSON.stringify(name)}`);
    const fullPath = path.resolve(root, name);
    const relative = path.relative(root, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Tracked path outside repository');
    let stat: fs.Stats;
    try { stat = fs.lstatSync(fullPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { skipped++; continue; }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) { skipped++; continue; }
    const realFile = fs.realpathSync(fullPath);
    const realRelative = path.relative(realRoot, realFile);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`Tracked file resolves outside the repository: ${name}`);
    }
    if (stat.size > 1024 * 1024) throw new Error(`File exceeds 1 MiB scan limit: ${name}`);
    bytes += stat.size;
    if (bytes > 12 * 1024 * 1024) throw new Error('Repository exceeds 12 MiB scan limit after path filtering.');
    const content = fs.readFileSync(fullPath);
    if (content.includes(0)) { skipped++; continue; }
    const decoded = new TextDecoder('utf-8', { fatal: true });
    let source: string;
    try { source = decoded.decode(content); } catch { skipped++; continue; }
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length) { skipped++; continue; }
    patches.push(`diff --git a/${name} b/${name}\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => '+' + line).join('\n')}\n`);
  }
  return { diff: patches.join(''), scannedFiles: patches.length, skippedFiles: skipped };
}
