import type { DiffHunk, DiffLine, FileDiff, ParsedDiff } from '../types/index.js';
import { LanguageRegistry } from './languages/index.js';

export function detectLanguage(filePath: string): string {
  return LanguageRegistry.getInstance().detectLanguageName(filePath);
}

export function inferComponentName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (parts.length === 1) return 'Root';
  if (parts[0] === 'src' && parts.length >= 3) {
    return parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
  }
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
}

/**
 * File extensions that carry prose, data, or styling rather than code
 * definitions. Symbol extraction is skipped for these files so review
 * summaries never present shell tokens, prose words, or CSS functions
 * (e.g. `FAILED`, `one`, `rgba`) as changed code symbols.
 */
const NON_CODE_SYMBOL_EXTENSIONS = new Set([
  'md',
  'markdown',
  'rst',
  'adoc',
  'yaml',
  'yml',
  'json',
  'jsonc',
  'json5',
  'toml',
  'ini',
  'cfg',
  'conf',
  'properties',
  'env',
  'txt',
  'csv',
  'tsv',
  'lock',
  'css',
  'scss',
  'less',
]);

/**
 * Tokens that language patterns can capture from calls, keywords, builtins,
 * or prose but that are never useful as "changed symbol" names in a review.
 */
const SYMBOL_STOPWORDS = new Set([
  // Control flow / language keywords
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'else',
  'do',
  'try',
  'finally',
  'return',
  'case',
  'default',
  'break',
  'continue',
  'throw',
  'new',
  'delete',
  'typeof',
  'void',
  'struct',
  'enum',
  'union',
  'static',
  'extern',
  'define',
  'ifdef',
  'ifndef',
  'endif',
  'include',
  // Test globals (calls, not definitions)
  'it',
  'describe',
  'test',
  'expect',
  // Common builtins / globals mis-captured from call sites
  'len',
  'max',
  'min',
  'range',
  'abs',
  'zip',
  'map',
  'filter',
  'list',
  'dict',
  'set',
  'str',
  'int',
  'float',
  'bool',
  'print',
  'open',
  'super',
  'self',
  'isinstance',
  'hasattr',
  'getattr',
  'enumerate',
  'sorted',
  'sum',
  'any',
  'all',
  'repr',
  'type',
  'id',
  'as',
  'is',
  // Prose words mis-captured from docs, comments, and docstrings
  'the',
  'a',
  'an',
  'one',
  'are',
  'be',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'with',
  'counts',
  'least',
  'returns',
]);

/**
 * Returns true for prose, data, or styling files where "changed symbols"
 * and "module" wording would read as gibberish in a review summary.
 */
export function isNonCodeFilePath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return NON_CODE_SYMBOL_EXTENSIONS.has(ext);
}

function isPlausibleSymbolName(name: string): boolean {
  if (!name || name.length < 2) return false;
  if (SYMBOL_STOPWORDS.has(name)) return false;
  if (SYMBOL_STOPWORDS.has(name.toLowerCase())) return false;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  return true;
}

/**
 * Extracts function, class, method, or hook names from hunk headers and diff lines.
 *
 * Patterns are scoped to the language strategy of `filePath` so a C++ or Java
 * pattern can no longer match prose inside Markdown/YAML/Python diffs. Files
 * with non-code extensions yield no symbols.
 */
export function extractChangedSymbols(hunks: DiffHunk[], filePath?: string): string[] {
  const symbols = new Set<string>();

  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (NON_CODE_SYMBOL_EXTENSIONS.has(ext)) {
      return [];
    }
  }

  const registry = LanguageRegistry.getInstance();
  const patterns = filePath
    ? registry.getStrategyForFile(filePath).symbolPatterns
    : registry.getAllSymbolPatterns();

  const collect = (text: string) => {
    for (const regex of patterns) {
      regex.lastIndex = 0;
      const m = text.match(regex);
      if (m && m[1] && isPlausibleSymbolName(m[1])) {
        symbols.add(m[1]);
      }
    }
  };

  for (const hunk of hunks) {
    if (hunk.sectionHeading) {
      collect(hunk.sectionHeading);
    }
    for (const line of hunk.lines) {
      collect(line.content);
    }
  }

  return Array.from(symbols).slice(0, 12);
}

/**
 * Parses a standard unified git diff string into structured FileDiff and DiffHunk objects.
 */
export function parseUnifiedDiff(rawDiff: string): ParsedDiff {
  if (!rawDiff || !rawDiff.trim()) {
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFiles: 0,
    };
  }

  const normalized = rawDiff.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const files: FileDiff[] = [];

  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLineCounter = 0;
  let newLineCounter = 0;
  let currentPatchLines: string[] = [];

  const flushFile = () => {
    if (currentFile) {
      currentFile.rawPatch = currentPatchLines.join('\n').trim();
      currentFile.symbolsChanged = extractChangedSymbols(
        currentFile.hunks,
        currentFile.newPath
      );
      files.push(currentFile);
    }
    currentFile = null;
    currentHunk = null;
    currentPatchLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      flushFile();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const oldPath = match ? match[1] : 'unknown';
      const newPath = match ? match[2] : oldPath;
      currentFile = {
        oldPath,
        newPath,
        status: 'modified',
        language: detectLanguage(newPath),
        additions: 0,
        deletions: 0,
        hunks: [],
        rawPatch: '',
        symbolsChanged: [],
      };
      currentPatchLines.push(line);
      continue;
    }

    // Support diffs that start directly with --- a/file and +++ b/file without `diff --git`
    if (!currentFile && line.startsWith('--- ')) {
      const nextLine = lines[i + 1] || '';
      if (nextLine.startsWith('+++ ')) {
        const oldRaw = line.slice(4).trim().replace(/^a\//, '');
        const newRaw = nextLine.slice(4).trim().replace(/^b\//, '');
        const resolvedPath = newRaw === '/dev/null' ? oldRaw : newRaw;
        currentFile = {
          oldPath: oldRaw,
          newPath: resolvedPath,
          status:
            oldRaw === '/dev/null'
              ? 'added'
              : newRaw === '/dev/null'
              ? 'deleted'
              : 'modified',
          language: detectLanguage(resolvedPath),
          additions: 0,
          deletions: 0,
          hunks: [],
          rawPatch: '',
          symbolsChanged: [],
        };
        currentPatchLines.push(line);
        continue;
      }
    }

    if (!currentFile) {
      continue;
    }

    currentPatchLines.push(line);

    if (line.startsWith('new file mode')) {
      currentFile.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      currentFile.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      currentFile.status = 'renamed';
      currentFile.oldPath = line.slice('rename from '.length).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      currentFile.status = 'renamed';
      currentFile.newPath = line.slice('rename to '.length).trim();
      currentFile.language = detectLanguage(currentFile.newPath);
      continue;
    }
    if (line.startsWith('--- ')) {
      const oldRaw = line.slice(4).trim();
      if (oldRaw === '/dev/null') {
        currentFile.status = 'added';
      } else {
        currentFile.oldPath = oldRaw.replace(/^a\//, '');
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newRaw = line.slice(4).trim();
      if (newRaw === '/dev/null') {
        currentFile.status = 'deleted';
      } else {
        currentFile.newPath = newRaw.replace(/^b\//, '');
        currentFile.language = detectLanguage(currentFile.newPath);
      }
      continue;
    }

    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@ optional section
    if (line.startsWith('@@ ')) {
      const hunkMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
      );
      if (hunkMatch) {
        const oldStart = parseInt(hunkMatch[1], 10);
        const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = parseInt(hunkMatch[3], 10);
        const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
        const sectionHeading = hunkMatch[5]?.trim() || undefined;

        oldLineCounter = oldStart;
        newLineCounter = newStart;

        currentHunk = {
          header: line,
          oldStart,
          oldLines,
          newStart,
          newLines,
          sectionHeading,
          lines: [],
        };
        currentFile.hunks.push(currentHunk);
      }
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+')) {
        const diffLine: DiffLine = {
          type: 'add',
          content: line.slice(1),
          newLineNumber: newLineCounter++,
        };
        currentHunk.lines.push(diffLine);
        currentFile.additions++;
      } else if (line.startsWith('-')) {
        const diffLine: DiffLine = {
          type: 'del',
          content: line.slice(1),
          oldLineNumber: oldLineCounter++,
        };
        currentHunk.lines.push(diffLine);
        currentFile.deletions++;
      } else if (line.startsWith(' ')) {
        const diffLine: DiffLine = {
          type: 'context',
          content: line.slice(1),
          oldLineNumber: oldLineCounter++,
          newLineNumber: newLineCounter++,
        };
        currentHunk.lines.push(diffLine);
      } else if (line.startsWith('\\ No newline at end of file')) {
        // Ignore marker
      }
    }
  }

  flushFile();

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    files,
    totalAdditions,
    totalDeletions,
    totalFiles: files.length,
  };
}

/**
 * Formats a FileDiff with explicit new-file line numbers so LLMs can pinpoint
 * exact lines for GitHub/GitLab inline review comments and committable suggestions.
 */
export function formatAnnotatedFileDiff(file: FileDiff): string {
  const out: string[] = [];
  out.push(`### File: \`${file.newPath}\` (${file.status}, +${file.additions}/-${file.deletions}, ${file.language})`);
  if (file.symbolsChanged.length > 0) {
    out.push(`Symbols modified: ${file.symbolsChanged.map((s) => `\`${s}\``).join(', ')}`);
  }

  for (const hunk of file.hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        out.push(`L${String(line.newLineNumber).padEnd(4, ' ')} + | ${line.content}`);
      } else if (line.type === 'del') {
        out.push(`OLD${String(line.oldLineNumber).padEnd(2, ' ')} - | ${line.content}`);
      } else {
        out.push(`L${String(line.newLineNumber).padEnd(4, ' ')}   | ${line.content}`);
      }
    }
  }
  return out.join('\n');
}
