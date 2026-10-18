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
 * Extracts function, class, method, or hook names from hunk headers and diff lines.
 */
export function extractChangedSymbols(hunks: DiffHunk[]): string[] {
  const symbols = new Set<string>();
  const patterns = LanguageRegistry.getInstance().getAllSymbolPatterns();

  for (const hunk of hunks) {
    if (hunk.sectionHeading) {
      for (const regex of patterns) {
        const m = hunk.sectionHeading.match(regex);
        if (m && m[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
          symbols.add(m[1]);
        }
      }
    }
    for (const line of hunk.lines) {
      for (const regex of patterns) {
        const m = line.content.match(regex);
        if (m && m[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
          symbols.add(m[1]);
        }
      }
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
      currentFile.symbolsChanged = extractChangedSymbols(currentFile.hunks);
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
