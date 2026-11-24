import type { FileDiff, InlineFinding } from '../types/index.js';
import { parseUnifiedDiff } from './diff-parser.js';

/** Default cap for inline comments in a single posted review. */
export const DEFAULT_MAX_INLINE_COMMENTS = 50;

export interface SkippedInlineComment {
  finding: InlineFinding;
  reason: string;
}

export interface PreparedInlineReview {
  /** Validated, deduplicated findings in stable (file, line) order. */
  comments: InlineFinding[];
  skipped: SkippedInlineComment[];
}

export interface PrepareInlineCommentsOptions {
  maxComments?: number;
}

/**
 * Validates findings against the reviewed diff before posting.
 *
 * Providers reject line-level comments that do not reference the diff, and
 * duplicate deliveries read as gibberish — so unknown files, off-diff
 * lines, and exact duplicates are skipped (with reasons) instead of posted.
 * When `rawDiff` is unavailable the diff checks are skipped but dedupe,
 * clamping, and the cap still apply.
 */
export function prepareInlineComments(
  findings: InlineFinding[],
  rawDiff?: string,
  options?: PrepareInlineCommentsOptions
): PreparedInlineReview {
  const maxComments =
    options?.maxComments ?? DEFAULT_MAX_INLINE_COMMENTS;
  const comments: InlineFinding[] = [];
  const skipped: SkippedInlineComment[] = [];
  const seen = new Set<string>();

  let diffFiles: FileDiff[] = [];
  if (rawDiff) {
    try {
      diffFiles = parseUnifiedDiff(rawDiff).files;
    } catch {
      diffFiles = [];
    }
  }
  const diffLinesByFile = new Map<string, Set<number>>();
  for (const file of diffFiles) {
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLineNumber !== undefined) lines.add(line.newLineNumber);
      }
    }
    diffLinesByFile.set(file.newPath, lines);
  }

  const ordered = [...findings].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.title.localeCompare(b.title)
  );

  for (const finding of ordered) {
    const key = `${finding.file}:${finding.startLine}:${finding.endLine}:${finding.ruleMatched || ''}:${finding.title}`;
    if (seen.has(key)) {
      skipped.push({ finding, reason: 'duplicate' });
      continue;
    }
    seen.add(key);

    if (diffLinesByFile.size > 0) {
      const validLines = diffLinesByFile.get(finding.file);
      if (!validLines) {
        skipped.push({ finding, reason: 'unknown-file' });
        continue;
      }
      if (!validLines.has(finding.startLine)) {
        skipped.push({ finding, reason: 'line-not-in-diff' });
        continue;
      }
    }

    let endLine = finding.endLine;
    if (typeof endLine !== 'number' || endLine < finding.startLine) {
      endLine = finding.startLine;
    }
    const validLines = diffLinesByFile.get(finding.file);
    if (validLines && validLines.size > 0 && !validLines.has(endLine)) {
      endLine = finding.startLine;
    }

    if (comments.length >= maxComments) {
      skipped.push({ finding, reason: 'comment-cap' });
      continue;
    }

    comments.push(endLine === finding.endLine ? finding : { ...finding, endLine });
  }

  return { comments, skipped };
}

/**
 * Summarizes skipped comments for the posted review body so drops are
 * visible instead of silent.
 */
export function formatSkippedSummary(skipped: SkippedInlineComment[]): string {
  if (skipped.length === 0) return '';
  const byReason = new Map<string, number>();
  for (const s of skipped) {
    byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
  }
  const parts = Array.from(byReason.entries()).map(
    ([reason, count]) => `${count} ${reason}`
  );
  return ` (${skipped.length} skipped: ${parts.join(', ')})`;
}
