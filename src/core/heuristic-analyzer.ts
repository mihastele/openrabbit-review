import crypto from 'node:crypto';
import type {
  FileDiff,
  FileWalkthroughSummary,
  InlineFinding,
  OpenRabbitConfig,
  PRWalkthrough,
  ReviewCategory,
  ReviewSeverity,
} from '../types/index.js';
import { inferComponentName } from './diff-parser.js';

interface HeuristicRule {
  id: string;
  title: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  matchLine: (line: string, file: FileDiff, contextLines: string[]) => boolean;
  buildFinding: (
    line: string,
    lineNumber: number,
    file: FileDiff,
    contextLines: string[]
  ) => {
    body: string;
    suggestionCode?: string;
  };
}

const HEURISTIC_RULES: HeuristicRule[] = [
  {
    id: 'sec-sql-injection',
    title: 'Potential SQL Injection via string interpolation',
    severity: 'critical',
    category: 'security',
    matchLine: (line) =>
      /(?:SELECT|INSERT|UPDATE|DELETE)\b.*(?:\$\{|['"]\s*\+\s*[a-zA-Z0-9_$.]+)/i.test(
        line
      ),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      const parameterized = line.replace(/`([^`]*)`/, (_m, inner: string) => {
        let idx = 1;
        const params: string[] = [];
        const sql = inner.replace(
          /'?\$\{([^}]+)\}'?/g,
          (_: string, expr: string) => {
            params.push(expr.trim());
            return `$${idx++}`;
          }
        );
        return params.length > 0
          ? `\`${sql}\`, [${params.join(', ')}]`
          : `\`${inner}\``;
      });

      return {
        body: 'Interpolating user-controlled values directly into a raw SQL query exposes the database to **SQL Injection (CWE-89)**. Use parameterized queries or prepared statements with bound placeholders (`$1`, `?`) instead.',
        suggestionCode:
          parameterized !== line
            ? parameterized
            : `${indent}// Use parameterized query placeholders ($1) instead of string interpolation`,
      };
    },
  },
  {
    id: 'sec-hardcoded-secret',
    title: 'Hardcoded secret or API credential detected',
    severity: 'critical',
    category: 'security',
    matchLine: (line, file) =>
      !file.newPath.includes('.example') &&
      !file.newPath.includes('test') &&
      /(?:api[_-]?key|secret|password|private[_-]?key|jwt[_-]?secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-./+=]{12,}['"]/i.test(
        line
      ),
    buildFinding: (line) => {
      const replaced = line.replace(
        /(['"])[A-Za-z0-9_\-./+=]{12,}\1/,
        'process.env.SECRET_KEY ?? ""'
      );
      return {
        body: 'Hardcoding secrets or API tokens in source code risks credential leakage in git history and build artifacts (**CWE-798**). Load this value from an environment variable or secret manager and fail fast if it is missing.',
        suggestionCode: replaced,
      };
    },
  },
  {
    id: 'sec-eval-exec',
    title: 'Unsafe dynamic code execution (`eval` / `child_process.exec`)',
    severity: 'critical',
    category: 'security',
    matchLine: (line) =>
      /\beval\s*\(/.test(line) ||
      /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/.test(line),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Dynamic execution of unsanitized strings via `eval()` or shell-interpolated `exec()` allows arbitrary code or command injection (**CWE-78 / CWE-95**). Prefer `execFile` with an explicit argument array or `JSON.parse` for structured data.',
        suggestionCode: line.includes('eval(')
          ? line.replace(/\beval\s*\(/, 'JSON.parse(')
          : `${indent}// Prefer execFile(cmd, [arg1, arg2]) over shell string interpolation`,
      };
    },
  },
  {
    id: 'sec-xss-dangerously-set',
    title: 'Unsanitized HTML injection via `dangerouslySetInnerHTML` / `innerHTML`',
    severity: 'warning',
    category: 'security',
    matchLine: (line) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=\s*(?!['"`]\s*['"`])/.test(line),
    buildFinding: (line) => {
      return {
        body: 'Assigning raw strings to `innerHTML` or `dangerouslySetInnerHTML` without sanitization can lead to **Cross-Site Scripting (XSS)**. Sanitize the markup with `DOMPurify.sanitize()` or use `textContent` when rendering plain text.',
        suggestionCode: line.includes('.innerHTML')
          ? line.replace(/\.innerHTML\s*=/, '.textContent =')
          : undefined,
      };
    },
  },
  {
    id: 'bug-async-forEach',
    title: 'Unawaited `async` callback inside `.forEach()`',
    severity: 'warning',
    category: 'bug',
    matchLine: (line) => /\.forEach\s*\(\s*async\b/.test(line),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
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
    matchLine: (line, file) =>
      (file.language.includes('TypeScript') || file.language.includes('JavaScript')) &&
      /[^=!]==[^=]|[^!]!=[^=]/.test(line) &&
      !/==\s*null|!=\s*null/.test(line),
    buildFinding: (line) => ({
      body: 'Loose equality (`==` / `!=`) performs implicit type coercion in JavaScript/TypeScript, which can mask subtle bugs (e.g., `0 == ""` evaluating to `true`). Prefer strict equality (`===` / `!==`).',
      suggestionCode: line
        .replace(/([^=!])==([^=])/g, '$1===$2')
        .replace(/([^!])!=([^=])/g, '$1!==$2'),
    }),
  },
  {
    id: 'perf-await-in-loop',
    title: 'Sequential `await` inside loop may bottleneck throughput',
    severity: 'suggestion',
    category: 'performance',
    matchLine: (line, _file, contextLines) => {
      if (!/\bawait\s+[a-zA-Z0-9_$.]+\(/.test(line)) return false;
      const windowText = contextLines.join('\n');
      return /\bfor\s*\(|\bwhile\s*\(/.test(windowText);
    },
    buildFinding: (line) => ({
      body: 'Awaiting independent asynchronous operations sequentially inside a loop increases total latency linearly with the collection size ($O(N)$ round-trips). If order does not strictly matter, consider batching with `await Promise.all(...)` or `Promise.allSettled(...)`.',
      suggestionCode: line,
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
      const indent = line.match(/^\s*/)?.[0] || '';
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
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Debug statements or raw `console.log` calls in production code can leak sensitive payloads to stdout and clutter structured logs. Remove before merging or route through a structured logger.',
        suggestionCode: line.includes('debugger')
          ? `${indent}// debugger removed`
          : line.replace(/console\.log\(/, 'logger.debug('),
      };
    },
  },
  {
    id: 'bug-empty-catch',
    title: 'Empty or silent `catch` block swallows runtime exceptions',
    severity: 'warning',
    category: 'bug',
    matchLine: (line, _file, contextLines) => {
      if (!/\bcatch\b/.test(line)) return false;
      const joined = contextLines.join(' ');
      return /catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(joined);
    },
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Swallowing exceptions in an empty `catch` block hides unexpected failures and makes production debugging difficult. Log the error with context or rethrow a domain-specific error.',
        suggestionCode: `${indent}} catch (error) {\n${indent}  console.error('Operation failed:', error);\n${indent}  throw error;\n${indent}}`,
      };
    },
  },
  // =========================================================================
  // Python Rules
  // =========================================================================
  {
    id: 'py-mutable-default-arg',
    title: 'Python mutable default argument retains state across function calls',
    severity: 'warning',
    category: 'bug',
    matchLine: (line, file) =>
      file.language === 'Python' &&
      /def\s+[a-zA-Z0-9_]+\([^)]*=\s*(\[\]|\{\}|set\(\))/.test(line),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      const fixed = line.replace(/=\s*(\[\]|\{\}|set\(\))/g, '= None');
      return {
        body: 'Default argument values in Python are evaluated once when the function is defined. Using mutable defaults (`[]`, `{}`) causes state to be shared across all invocations (**Common Python Bug**). Use `None` as the default and assign a new instance inside the function body.',
        suggestionCode: `${fixed}\n${indent}    # inside body: if param is None: param = []`,
      };
    },
  },
  {
    id: 'py-sql-injection',
    title: 'Python SQL Injection via f-string or string formatting',
    severity: 'critical',
    category: 'security',
    matchLine: (line, file) =>
      file.language === 'Python' &&
      (/(?:execute|raw)\s*\(\s*f["'].*\{/.test(line) ||
        /(?:execute|raw)\s*\(\s*["'].*%\s*[a-zA-Z0-9_.]+/i.test(line) ||
        /f["'].*(?:SELECT|INSERT|UPDATE|DELETE)\b.*(?:WHERE|VALUES)\b.*\{/i.test(
          line
        )),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      const cleaned = line
        .replace(/f(["'])(.*?)\{([a-zA-Z0-9_.]+)\}(.*?)\1/g, '$1$2%s$4$1, ($3,)')
        .replace(/'%s'/g, '%s');
      return {
        body: 'Interpolating variables into SQL queries via Python f-strings or `%` format strings causes **SQL Injection (CWE-89)**. Use database cursor parameterized queries with placeholders (`%s` or `?`) and a parameter tuple/list.',
        suggestionCode: cleaned !== line ? cleaned : `${indent}cursor.execute("SELECT ... WHERE id = %s", (param,))`,
      };
    },
  },
  {
    id: 'py-subprocess-shell',
    title: 'Python `shell=True` or `os.system()` allows command injection',
    severity: 'critical',
    category: 'security',
    matchLine: (line, file) =>
      file.language === 'Python' &&
      (/(?:subprocess\.(?:run|call|Popen|check_output)\s*\([^)]*shell\s*=\s*True)/.test(
        line
      ) ||
        /\bos\.system\s*\(/.test(line)),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Invoking shell commands with `shell=True` or `os.system()` invites **Command Injection (CWE-78)** if arguments contain untrusted user input. Pass arguments as a list of strings (`["cmd", arg1, arg2]`) with `shell=False`.',
        suggestionCode: line.includes('shell=True')
          ? line.replace(/shell\s*=\s*True/, 'shell=False')
          : `${indent}subprocess.run(["command", arg1], check=True)`,
      };
    },
  },
  {
    id: 'py-bare-except',
    title: 'Bare `except:` catches SystemExit and KeyboardInterrupt',
    severity: 'warning',
    category: 'bug',
    matchLine: (line, file) =>
      file.language === 'Python' &&
      (/^\s*except\s*:\s*$/.test(line) || /^\s*except\s+BaseException\s*:/.test(line)),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'A bare `except:` catches `KeyboardInterrupt` (Ctrl+C) and `SystemExit`, preventing normal application termination and masking unexpected syntax or type errors. Catch `Exception` explicitly.',
        suggestionCode: `${indent}except Exception as err:`,
      };
    },
  },
  // =========================================================================
  // Go Rules
  // =========================================================================
  {
    id: 'go-missing-defer-body-close',
    title: 'Missing `defer resp.Body.Close()` leaks TCP sockets and goroutines',
    severity: 'warning',
    category: 'bug',
    matchLine: (line, file, contextLines) => {
      if (file.language !== 'Go') return false;
      if (!/(?:http\.(?:Get|Post|Head)|client\.Do)\s*\(/.test(line)) return false;
      const joined = contextLines.join('\n');
      return !/Body\.Close/.test(joined);
    },
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'In Go, HTTP response bodies must be closed to reuse network connections and avoid descriptor leaks. Add `defer resp.Body.Close()` immediately after checking `err != nil`.',
        suggestionCode: `${line}\n${indent}if err != nil {\n${indent}    return err\n${indent}}\n${indent}defer resp.Body.Close()`,
      };
    },
  },
  {
    id: 'go-sql-sprintf',
    title: 'Go SQL query formatted with `fmt.Sprintf` allows SQL injection',
    severity: 'critical',
    category: 'security',
    matchLine: (line, file) =>
      file.language === 'Go' &&
      /(?:db\.(?:Query|QueryRow|Exec|Select)|sqlx?)\b.*fmt\.Sprintf|fmt\.Sprintf\s*\(\s*["'](?:SELECT|INSERT|UPDATE|DELETE)\b.*%s/i.test(
        line
      ),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Formatting SQL queries using `fmt.Sprintf` exposes the database to **SQL Injection (CWE-89)**. Pass parameters into `db.QueryContext` or `db.Query` using placeholder tokens (`$1` in PostgreSQL, `?` in MySQL/SQLite).',
        suggestionCode: `${indent}// Use parameterized query: db.QueryContext(ctx, "SELECT ... WHERE id = $1", id)`,
      };
    },
  },
  {
    id: 'go-ignored-error',
    title: 'Unchecked or blank error assignment `_ = ...` ignores runtime failure',
    severity: 'suggestion',
    category: 'maintainability',
    matchLine: (line, file) =>
      file.language === 'Go' &&
      /^\s*_\s*=\s*(?:json\.Unmarshal|os\.Remove|http\.|io\.Copy|db\.)/.test(line),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Discarding errors with `_ =` silently masks I/O or decoding failures in Go. Check and handle `if err != nil` to avoid invalid program states.',
        suggestionCode: `${indent}if err := ${line.replace(/^\s*_\s*=\s*/, '')}; err != nil {\n${indent}    return err\n${indent}}`,
      };
    },
  },
  // =========================================================================
  // Rust Rules
  // =========================================================================
  {
    id: 'rust-raw-unwrap',
    title: 'Unchecked `.unwrap()` causes thread panic in production code',
    severity: 'warning',
    category: 'bug',
    matchLine: (line, file) =>
      file.language === 'Rust' &&
      !file.newPath.includes('test') &&
      /\.[uU]nwrap\s*\(\)/.test(line),
    buildFinding: (line) => {
      const replaced = line.replace(/\.unwrap\(\)/g, '?');
      return {
        body: 'Calling `.unwrap()` in production Rust code panics the thread if the `Result` is `Err` or `Option` is `None`. Use the `?` operator for error propagation, or handle missing values with `.unwrap_or_default()` / `.context(...)`.',
        suggestionCode: replaced !== line ? replaced : line.replace(/\.unwrap\(\)/, '.unwrap_or_default()'),
      };
    },
  },
  {
    id: 'rust-unsafe-block',
    title: 'Rust `unsafe` block without explicit `// SAFETY:` invariant documentation',
    severity: 'suggestion',
    category: 'maintainability',
    matchLine: (line, file, contextLines) =>
      file.language === 'Rust' &&
      /\bunsafe\s*\{/.test(line) &&
      !contextLines.some((c) => /SAFETY:/i.test(c)),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Rust `unsafe` blocks bypass compiler safety guarantees. Follow standard Rust API guidelines by documenting exact safety preconditions with a `// SAFETY: <justification>` comment.',
        suggestionCode: `${indent}// SAFETY: Pointer is non-null and properly aligned\n${line}`,
      };
    },
  },
  // =========================================================================
  // Java / Kotlin Rules
  // =========================================================================
  {
    id: 'java-sql-injection',
    title: 'Java / Kotlin SQL Injection via raw string concatenation',
    severity: 'critical',
    category: 'security',
    matchLine: (line, file) =>
      (file.language.includes('Java') || file.language.includes('Kotlin')) &&
      /(?:executeQuery|executeUpdate|createStatement|createQuery)\s*\(.*(?:\+\s*[a-zA-Z0-9_.]+|\$\{[a-zA-Z0-9_.]+\})/i.test(
        line
      ),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Concatenating variables into SQL or HQL queries causes **SQL Injection (CWE-89)**. Use `PreparedStatement` with parameterized placeholders (`?`) or named parameters (`:id`).',
        suggestionCode: `${indent}// Use PreparedStatement: conn.prepareStatement("SELECT ... WHERE id = ?"); pstmt.setString(1, id);`,
      };
    },
  },
  // =========================================================================
  // Shell / Bash Rules
  // =========================================================================
  {
    id: 'sh-missing-strict-mode',
    title: 'Shell script missing `set -euo pipefail` strict mode',
    severity: 'suggestion',
    category: 'maintainability',
    matchLine: (line, file, contextLines) =>
      file.language === 'Shell' &&
      line.startsWith('#!') &&
      !contextLines.some((c) => /set\s+-(?:euo\s+pipefail|e)/.test(c)),
    buildFinding: (line) => ({
      body: 'Shell scripts should specify `set -euo pipefail` to ensure the script exits immediately on errors, handles unset variables safely, and does not ignore pipeline step failures.',
      suggestionCode: `${line}\nset -euo pipefail`,
    }),
  },
];

/**
 * Generates high-signal inline findings using deterministic static analysis
 * and `.openrabbit.yaml` path instruction checks.
 */
export function runHeuristicInlineReview(
  files: FileDiff[],
  config: OpenRabbitConfig
): InlineFinding[] {
  const findings: InlineFinding[] = [];
  const seenKeys = new Set<string>();

  for (const file of files) {
    if (file.status === 'deleted') continue;

    for (const hunk of file.hunks) {
      const addedLinesWithIndex = hunk.lines
        .map((l, idx) => ({ line: l, idx }))
        .filter((item) => item.line.type === 'add' && item.line.newLineNumber);

      for (const { line, idx } of addedLinesWithIndex) {
        const lineNum = line.newLineNumber!;
        const contextSlice = hunk.lines
          .slice(Math.max(0, idx - 3), Math.min(hunk.lines.length, idx + 4))
          .map((l) => l.content);

        for (const rule of HEURISTIC_RULES) {
          // Filter nitpicks if profile is 'chill'
          if (config.profile === 'chill' && rule.severity === 'nitpick') {
            continue;
          }

          if (rule.matchLine(line.content, file, contextSlice)) {
            const dedupeKey = `${file.newPath}:${rule.id}:${Math.floor(lineNum / 5)}`;
            if (seenKeys.has(dedupeKey)) continue;
            seenKeys.add(dedupeKey);

            const details = rule.buildFinding(
              line.content,
              lineNum,
              file,
              contextSlice
            );

            findings.push({
              id: `finding-${crypto.randomUUID().slice(0, 8)}`,
              file: file.newPath,
              startLine: lineNum,
              endLine: lineNum,
              severity: rule.severity,
              category: rule.category,
              title: rule.title,
              body: details.body,
              suggestionCode: details.suggestionCode,
              originalCode: line.content,
              ruleMatched: rule.id,
            });
          }
        }
      }
    }
  }

  // If a PR has clean additions and no issues were flagged, add a constructive architectural observation or praise
  if (findings.length === 0 && files.length > 0) {
    const primaryFile = files.find((f) => f.hunks.length > 0) || files[0];
    const firstHunk = primaryFile.hunks[0];
    const firstAdd = firstHunk?.lines.find((l) => l.type === 'add');
    const targetLine = firstAdd?.newLineNumber || firstHunk?.newStart || 1;

    findings.push({
      id: `finding-${crypto.randomUUID().slice(0, 8)}`,
      file: primaryFile.newPath,
      startLine: targetLine,
      endLine: targetLine,
      severity: 'praise',
      category: 'architecture',
      title: 'Clean, well-structured implementation with no high-risk anti-patterns',
      body: `Reviewed **+${primaryFile.additions}/-${primaryFile.deletions}** lines in \`${primaryFile.newPath}\`${
        primaryFile.symbolsChanged.length > 0
          ? ` affecting ${primaryFile.symbolsChanged.map((s) => `\`${s}\``).join(', ')}`
          : ''
      }. No security vulnerabilities, unawaited promises, or unsafe type coercions were detected.`,
    });
  }

  return findings;
}

/**
 * Generates a complete CodeRabbit-style PR Walkthrough (Summary, Release Notes,
 * File Table, Mermaid Sequence Diagram, Poem, and Risk Score) from the parsed diff.
 */
export function buildHeuristicWalkthrough(
  prTitle: string,
  files: FileDiff[],
  findings: InlineFinding[],
  config: OpenRabbitConfig
): PRWalkthrough {
  const fileSummaries: FileWalkthroughSummary[] = files.map((file) => {
    const component = inferComponentName(file.newPath);
    const fileFindings = findings.filter((f) => f.file === file.newPath);
    const hasCritical = fileFindings.some((f) => f.severity === 'critical');
    const hasWarning = fileFindings.some((f) => f.severity === 'warning');
    const churn = file.additions + file.deletions;

    const impact: 'low' | 'medium' | 'high' =
      hasCritical || churn > 80 ? 'high' : hasWarning || churn > 25 ? 'medium' : 'low';

    let summary = '';
    if (file.status === 'added') {
      summary = `Introduces new ${file.language} module${
        file.symbolsChanged.length > 0
          ? ` defining ${file.symbolsChanged.map((s) => `\`${s}\``).join(', ')}`
          : ''
      } (+${file.additions} lines).`;
    } else if (file.status === 'deleted') {
      summary = `Removes legacy ${file.language} file (-${file.deletions} lines).`;
    } else if (file.symbolsChanged.length > 0) {
      summary = `Updates ${file.symbolsChanged.map((s) => `\`${s}\``).join(', ')} in ${component} (+${file.additions}/-${file.deletions}).`;
    } else {
      summary = `Refines ${component.toLowerCase()} logic and configuration (+${file.additions}/-${file.deletions} lines).`;
    }

    return {
      path: file.newPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      component,
      summary,
      impact,
    };
  });

  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const components = Array.from(new Set(fileSummaries.map((f) => f.component)));

  const criticalFindings = findings.filter((f) => f.severity === 'critical');
  const warningFindings = findings.filter((f) => f.severity === 'warning');

  const riskLevel: PRWalkthrough['riskLevel'] =
    criticalFindings.length > 0
      ? 'critical'
      : warningFindings.length >= 2
      ? 'high'
      : warningFindings.length === 1 || totalAdditions + totalDeletions > 150
      ? 'moderate'
      : 'low';

  const totalChurn = totalAdditions + totalDeletions;
  const effortScore: 1 | 2 | 3 | 4 | 5 =
    totalChurn > 400 || criticalFindings.length >= 2
      ? 5
      : totalChurn > 200 || criticalFindings.length === 1
      ? 4
      : totalChurn > 75 || warningFindings.length >= 1
      ? 3
      : totalChurn > 20
      ? 2
      : 1;

  const estimatedMinutes = Math.max(2, Math.min(45, Math.ceil(totalChurn / 18) + findings.length * 2));

  // Build Mermaid sequence diagram reflecting the actual components/files changed
  const mermaidDiagram = generateMermaidDiagramForDiff(files, fileSummaries);

  // Build rabbit poem
  const poem = config.reviews.poem
    ? generateRabbitPoem(files, criticalFindings.length, warningFindings.length)
    : '';

  const executiveSummary = `This pull request modifies **${files.length} file${
    files.length === 1 ? '' : 's'
  }** across **${components.join(', ') || 'the repository'}** (+${totalAdditions}/-${totalDeletions} lines). ${
    criticalFindings.length > 0
      ? `OpenRabbit identified **${criticalFindings.length} critical issue(s)** and **${warningFindings.length} warning(s)** that should be addressed prior to merge.`
      : warningFindings.length > 0
      ? `OpenRabbit surfaced **${warningFindings.length} actionable warning(s)** with committable code suggestions.`
      : `The changes are clean and well-scoped with no blocking defects found.`
  }`;

  const releaseNotes = [
    {
      category: files.some((f) => f.status === 'added') ? 'New Features & Modules' : 'Enhancements & Refactoring',
      items: fileSummaries.slice(0, 5).map((f) => `${f.component}: ${f.summary}`),
    },
  ];

  const securityConcerns = findings
    .filter((f) => f.category === 'security')
    .map((f) => `${f.file}:L${f.startLine} — ${f.title}`);

  return {
    title: prTitle || 'Pull Request Review',
    executiveSummary,
    releaseNotes,
    fileSummaries,
    mermaidDiagram,
    poem,
    effortScore,
    estimatedMinutes,
    riskLevel,
    securityConcerns,
  };
}

function sanitizeMermaidId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'Node';
}

function generateMermaidDiagramForDiff(
  files: FileDiff[],
  summaries: FileWalkthroughSummary[]
): string {
  if (files.length === 0) {
    return `sequenceDiagram\n  participant Dev as Developer\n  participant OR as OpenRabbit\n  Dev->>OR: Submit Pull Request\n  OR-->>Dev: Walkthrough & Inline Review`;
  }

  const lines: string[] = ['sequenceDiagram', '  autonumber', '  actor Caller as Caller / Client'];

  const topFiles = files.slice(0, 4);
  topFiles.forEach((f, idx) => {
    const shortName = f.newPath.split('/').pop() || f.newPath;
    const participantId = `M${idx}_${sanitizeMermaidId(shortName)}`;
    lines.push(`  participant ${participantId} as ${shortName}`);
  });

  for (let i = 0; i < topFiles.length; i++) {
    const f = topFiles[i];
    const shortName = f.newPath.split('/').pop() || f.newPath;
    const participantId = `M${i}_${sanitizeMermaidId(shortName)}`;
    const symbolLabel =
      f.symbolsChanged.length > 0
        ? `${f.symbolsChanged[0]}()`
        : `${summaries[i]?.status || 'update'} (+${f.additions}/-${f.deletions})`;

    if (i === 0) {
      lines.push(`  Caller->>+${participantId}: Invoke ${symbolLabel}`);
    } else {
      const prevShort = topFiles[i - 1].newPath.split('/').pop() || topFiles[i - 1].newPath;
      const prevId = `M${i - 1}_${sanitizeMermaidId(prevShort)}`;
      lines.push(`  ${prevId}->>+${participantId}: Call ${symbolLabel}`);
    }
  }

  for (let i = topFiles.length - 1; i >= 0; i--) {
    const f = topFiles[i];
    const shortName = f.newPath.split('/').pop() || f.newPath;
    const participantId = `M${i}_${sanitizeMermaidId(shortName)}`;
    if (i === 0) {
      lines.push(`  ${participantId}-->>-Caller: Return result`);
    } else {
      const prevShort = topFiles[i - 1].newPath.split('/').pop() || topFiles[i - 1].newPath;
      const prevId = `M${i - 1}_${sanitizeMermaidId(prevShort)}`;
      lines.push(`  ${participantId}-->>-${prevId}: Propagate state`);
    }
  }

  return lines.join('\n');
}

function generateRabbitPoem(
  files: FileDiff[],
  criticalCount: number,
  warningCount: number
): string {
  const firstFile = files[0]?.newPath.split('/').pop() || 'the codebase';
  if (criticalCount > 0) {
    return [
      `A twitch of the ear at \`${firstFile}\` in flight,`,
      `Green lines of ambition, bold changes in sight—`,
      `Yet traps in the burrow lurk under the clover,`,
      `Let's patch up the hazards before hopping over! 🐇🛡️`,
    ].join('\n');
  }
  if (warningCount > 0) {
    return [
      `Through hunks of \`${firstFile}\` the swift rabbit hops,`,
      `Inspecting each promise and loop before stops.`,
      `A few gentle tweaks make the burrow secure—`,
      `Commit the suggestions for code clean and pure! 🐇✨`,
    ].join('\n');
  }
  return [
    `Across \`${firstFile}\` the fresh patches gleam,`,
    `As crisp as a carrot beside a clear stream.`,
    `No tangles or snares in the logic we find—`,
    `Hop onward to merge with a confident mind! 🐇🥕`,
  ].join('\n');
}
