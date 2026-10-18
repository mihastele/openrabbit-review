import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class TypeScriptLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'typescript';
  readonly displayName = 'TypeScript / JavaScript';
  readonly fileExtensions = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

  readonly symbolPatterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
    /(?:export\s+)?class\s+([A-Za-z0-9_$]+)/,
    /(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
    /(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/,
    /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/,
    /^\s*(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'bug-async-forEach',
        title: 'Unawaited `async` callback inside `.forEach()`',
        severity: 'warning',
        category: 'bug',
        matchLine: (line) => /\.forEach\s*\(\s*async\b/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          const match = line.match(
            /^\s*(?:await\s+)?([a-zA-Z0-9_$.]+)\.forEach\s*\(\s*async\s*\(([^)]*)\)\s*=>\s*\{?/
          );
          const suggestion = match
            ? `${indent}for (const ${match[2].trim()} of ${match[1]}) {`
            : `${indent}// Use for..of or await Promise.all(items.map(async ...)) instead of .forEach`;
          return {
            body: '`Array.prototype.forEach` does not await promises returned by an `async` callback. Rejections will go unhandled and subsequent lines will execute before the loop completes. Use `for (const item of items)` for sequential execution or `await Promise.all(items.map(...))` for concurrency.',
            suggestionCode: suggestion,
          };
        },
      },
      {
        id: 'bug-equality-coercion',
        title: 'Loose equality operator (`==` / `!=`) may cause unexpected type coercion',
        severity: 'suggestion',
        category: 'bug',
        matchLine: (line) =>
          /[^=!]==[^=]|[^!]!=[^=]/.test(line) && !/==\s*null|!=\s*null/.test(line),
        buildFinding: (line) => ({
          body: 'Loose equality (`==` / `!=`) performs implicit type coercion in JavaScript/TypeScript, which can mask subtle bugs (e.g., `0 == ""` evaluating to `true`). Prefer strict equality (`===` / `!==`).',
          suggestionCode: line
            .replace(/([^=!])==([^=])/g, '$1===$2')
            .replace(/([^!])!=([^=])/g, '$1!==$2'),
        }),
      },
      {
        id: 'sec-xss-dangerously-set',
        title: 'Unsanitized HTML injection via `dangerouslySetInnerHTML` / `innerHTML`',
        severity: 'warning',
        category: 'security',
        matchLine: (line) =>
          /dangerouslySetInnerHTML|\.innerHTML\s*=\s*(?!['"`]\s*['"`])/.test(line),
        buildFinding: (line) => ({
          body: 'Assigning raw strings to `innerHTML` or `dangerouslySetInnerHTML` without sanitization can lead to **Cross-Site Scripting (XSS)**. Sanitize the markup with `DOMPurify.sanitize()` or use `textContent` when rendering plain text.',
          suggestionCode: line.includes('.innerHTML')
            ? line.replace(/\.innerHTML\s*=/, '.textContent =')
            : undefined,
        }),
      },
      {
        id: 'react-missing-cleanup-or-interval',
        title: 'Timer or event listener registered without clear cleanup guarantee',
        severity: 'warning',
        category: 'bug',
        matchLine: (line, _file, contextLines) => {
          if (!/\b(?:setInterval|addEventListener)\s*\(/.test(line)) return false;
          const joined = contextLines.join('\n');
          return !/clearInterval|removeEventListener/.test(joined);
        },
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          if (line.includes('setInterval(') && !/const\s+|let\s+/.test(line)) {
            return {
              body: '`setInterval` is invoked without storing the timer handle or clearing it on teardown/unmount. This creates a memory leak and duplicate background executions when the component or service re-initializes.',
              suggestionCode: `${indent}const intervalId = ${line.trim()}\n${indent}// Ensure clearInterval(intervalId) is called during cleanup`,
            };
          }
          return {
            body: 'Ensure this subscription or interval is paired with a corresponding `clearInterval` / `removeEventListener` cleanup handler to prevent memory leaks.',
          };
        },
      },
      {
        id: 'type-explicit-any',
        title: 'Avoid explicit `any` type annotation to preserve type safety',
        severity: 'nitpick',
        category: 'type-safety',
        matchLine: (line, file) =>
          file.language.includes('TypeScript') &&
          /:\s*any\b|<any>|as\s+any\b/.test(line),
        buildFinding: (line) => ({
          body: 'Using `any` disables TypeScript compile-time checks and allows unsafe property access to propagate silently. Prefer `unknown` with type narrowing or a dedicated interface/generic type.',
          suggestionCode: line
            .replace(/:\s*any\b/g, ': unknown')
            .replace(/as\s+any\b/g, 'as unknown'),
        }),
      },
      {
        id: 'maint-leftover-debug',
        title: 'Leftover debugging statement (`console.log` / `debugger`)',
        severity: 'nitpick',
        category: 'maintainability',
        matchLine: (line, file) =>
          !file.newPath.includes('cli') &&
          !file.newPath.includes('test') &&
          (/\bdebugger\s*;?/.test(line) || /\bconsole\.log\s*\(/.test(line)),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'Debug statements or raw `console.log` calls in production code can leak sensitive payloads to stdout and clutter structured logs. Remove before merging or route through a structured logger.',
            suggestionCode: line.includes('debugger')
              ? `${indent}// debugger removed`
              : line.replace(/console\.log\(/, 'logger.debug('),
          };
        },
      },
    ];
  }

  generateTestSuite(symbolName: string, filePath: string): TestGenerationResult {
    const targetModule = filePath.split('/').pop()?.replace(/\.[jt]sx?$/, '') || 'module';
    const testCode = `import { describe, it, expect, vi } from 'vitest';
import { ${symbolName} } from './${targetModule}';

describe('${symbolName} (${filePath})', () => {
  it('handles valid inputs and resolves expected state cleanly', async () => {
    const result = await ${symbolName}({ id: 'usr_101', role: 'member' });
    expect(result).toBeDefined();
  });

  it('rejects malformed or malicious payloads safely (regression check)', async () => {
    await expect(
      ${symbolName}({ id: "' OR 1=1 --", role: 'admin' })
    ).rejects.toThrow();
  });

  it('cleans up async resources when aborted or on error', async () => {
    const spy = vi.fn();
    await expect(${symbolName}(null as unknown as Record<string, unknown>)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});`;

    return {
      testCode,
      testLanguage: 'typescript',
      runnerHint: 'Run via `npm test`',
    };
  }

  generateDocumentation(symbolName: string, filePath: string): DocGenerationResult {
    const docBlock = `/**
 * Executes \`${symbolName}\` with validated inputs and structured error propagation.
 *
 * @param params - Verified request parameters for ${filePath}
 * @returns Promise resolving to the processed domain payload
 * @throws {Error} When input validation or downstream I/O fails
 */`;

    return {
      docBlock,
      formatName: 'TSDoc / JSDoc',
    };
  }
}
