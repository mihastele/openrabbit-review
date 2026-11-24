/**
 * Shared validation for committable suggestion blocks.
 *
 * A suggestion that reaches a ` ```suggestion ` fence replaces the commented
 * lines when applied, so a truncated or unbalanced replacement reads as
 * gibberish and breaks the user's code. Every suggestion source (custom
 * rules, heuristic rules, LLM findings) must pass through
 * `sanitizeSuggestionCode` before it is stored on a finding.
 */

function countChar(text: string, char: string): number {
  let count = 0;
  for (const c of text) {
    if (c === char) count++;
  }
  return count;
}

function netBalance(text: string, open: string, close: string): number {
  let balance = 0;
  for (const c of text) {
    if (c === open) balance++;
    else if (c === close) balance--;
  }
  return balance;
}

function sharesSubsequence(a: string, b: string, length: number): boolean {
  if (a.length < length || b.length < length) return true;
  for (let i = 0; i + length <= a.length; i++) {
    if (b.includes(a.slice(i, i + length))) return true;
  }
  return false;
}

/**
 * Returns true when `candidate` is safe to render as a committable
 * suggestion replacing `originalLine`.
 */
export function isValidSuggestionCode(
  candidate: string,
  originalLine?: string
): boolean {
  if (!candidate || candidate.trim().length === 0) return false;
  if (candidate.includes('```')) return false;
  if (candidate.split('\n').length > 60) return false;

  const trimmed = candidate.trim();
  if (trimmed.length < 2) return false;

  if (
    originalLine &&
    !candidate.includes('\n') &&
    !originalLine.includes('\n')
  ) {
    // A single-line replacement of a balanced line must stay balanced.
    for (const quote of ['"', "'", '`']) {
      if (
        countChar(originalLine, quote) % 2 === 0 &&
        countChar(candidate, quote) % 2 === 1
      ) {
        return false;
      }
    }
    const pairs: [string, string][] = [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ];
    for (const [open, close] of pairs) {
      if (
        netBalance(originalLine, open, close) === 0 &&
        netBalance(candidate, open, close) !== 0
      ) {
        return false;
      }
    }
    // A single-line replacement must retain recognizable content from the
    // original line; otherwise it is a bare template fragment.
    if (originalLine.trim().length >= 8 && candidate.trim().length >= 4) {
      if (!sharesSubsequence(candidate, originalLine, 4)) return false;
    }
  }

  return true;
}

/**
 * Returns `candidate` when it is a valid committable suggestion,
 * otherwise `undefined` so callers render prose guidance without a
 * broken suggestion block.
 */
export function sanitizeSuggestionCode(
  candidate: string | undefined,
  originalLine?: string
): string | undefined {
  if (candidate === undefined) return undefined;
  return isValidSuggestionCode(candidate, originalLine) ? candidate : undefined;
}
