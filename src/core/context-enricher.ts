import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FileDiff } from '../types/index.js';

export interface ContextSnippet {
  file: string;
  reason: 'imported-module' | 'symbol-reference';
  content: string;
}

export interface EnrichedContextResult {
  snippets: ContextSnippet[];
  formattedPromptContext: string;
  totalBytes: number;
}

const RESOLVABLE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

const IMPORT_PATTERNS = [
  /(?:import|export)\s+[^'"]*?\s+from\s+['"](\.[^'"]+)['"]/g,
  /require\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /#include\s+"([^"]+)"/g,
];

function isPathInsideRepo(candidate: string, realRoot: string): boolean {
  try {
    const realCandidate = fs.realpathSync(candidate);
    const rel = path.relative(realRoot, realCandidate);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function resolveImportCandidate(
  fromFile: string,
  specifier: string,
  realRoot: string
): string | null {
  // Strip `.js` / `.jsx` ESM suffix when resolving TypeScript sources
  const stripped = specifier.replace(/\.(?:js|jsx|mjs)$/, '');
  const baseDir = path.dirname(path.resolve(realRoot, fromFile));
  const candidates = stripped !== specifier ? [specifier, stripped] : [specifier];

  for (const cand of candidates) {
    for (const ext of RESOLVABLE_EXTENSIONS) {
      const fullPath = path.resolve(baseDir, cand + ext);
      if (
        fs.existsSync(fullPath) &&
        fs.statSync(fullPath).isFile() &&
        isPathInsideRepo(fullPath, realRoot)
      ) {
        return fullPath;
      }
    }
  }
  return null;
}

function extractBoundedHead(fullPath: string, maxLines = 60, maxChars = 2400): string {
  const raw = fs.readFileSync(fullPath, 'utf8');
  const lines = raw.replace(/\r\n/g, '\n').split('\n').slice(0, maxLines);
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) + '\n// ...truncated' : joined;
}

/**
 * Enriches a parsed diff with bounded cross-file context (relative imports and
 * symbol references) from `repoPath` while enforcing strict path-boundary and byte limits.
 */
export function enrichDiffContext(
  repoPath: string,
  files: FileDiff[],
  options: { maxBytes?: number; maxSnippets?: number } = {}
): EnrichedContextResult {
  const maxBytes = options.maxBytes ?? 12000;
  const maxSnippets = options.maxSnippets ?? 8;

  if (!repoPath || !fs.existsSync(repoPath) || files.length === 0) {
    return { snippets: [], formattedPromptContext: '', totalBytes: 0 };
  }

  const realRoot = fs.realpathSync(repoPath);
  const diffFilesSet = new Set(
    files.map((f) => f.newPath.replace(/\\/g, '/').replace(/^\.\//, ''))
  );
  const seenFiles = new Set<string>(diffFilesSet);
  const snippets: ContextSnippet[] = [];
  let totalBytes = 0;

  const pushSnippet = (relPath: string, reason: ContextSnippet['reason'], content: string) => {
    if (snippets.length >= maxSnippets) return;
    const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (seenFiles.has(norm)) return;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (totalBytes + bytes > maxBytes) return;
    seenFiles.add(norm);
    totalBytes += bytes;
    snippets.push({ file: norm, reason, content });
  };

  // 1. Resolve relative imports from changed hunks
  for (const file of files) {
    if (snippets.length >= maxSnippets) break;
    const text = file.hunks
      .flatMap((h) => h.lines.map((l) => l.content))
      .join('\n');

    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const spec = match[1];
        const resolved = resolveImportCandidate(file.newPath, spec, realRoot);
        if (!resolved) continue;
        const rel = path.relative(realRoot, resolved).replace(/\\/g, '/');
        try {
          pushSnippet(rel, 'imported-module', extractBoundedHead(resolved));
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  // 2. Find cross-file callers/references for changed symbols via `git grep`
  const symbols = [...new Set(files.flatMap((f) => f.symbolsChanged))].slice(0, 4);
  for (const sym of symbols) {
    if (snippets.length >= maxSnippets || totalBytes >= maxBytes) break;
    if (!/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(sym)) continue;
    try {
      const out = execFileSync('git', ['grep', '-l', '-F', sym, '--'], {
        cwd: realRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 1024 * 1024,
      });
      for (const rel of out.split(/\r?\n/).filter(Boolean).slice(0, 3)) {
        const full = path.resolve(realRoot, rel);
        if (!isPathInsideRepo(full, realRoot)) continue;
        pushSnippet(rel, 'symbol-reference', extractBoundedHead(full, 40, 1600));
      }
    } catch {
      // Non-git directory or no matches — degrade gracefully
    }
  }

  const formattedPromptContext =
    snippets.length > 0
      ? '\nCross-File Repository Context (read-only reference):\n' +
        snippets
          .map((s) => `--- ${s.file} (${s.reason}) ---\n${s.content}`)
          .join('\n\n')
      : '';

  return { snippets, formattedPromptContext, totalBytes };
}
