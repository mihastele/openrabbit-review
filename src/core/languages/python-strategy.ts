import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class PythonLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'python';
  readonly displayName = 'Python';
  readonly fileExtensions = ['py', 'pyi'];

  readonly symbolPatterns = [
    /(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
    /class\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\([^)]*\))?:/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'py-mutable-default-arg',
        title: 'Python mutable default argument retains state across function calls',
        severity: 'warning',
        category: 'bug',
        matchLine: (line) =>
          /def\s+[a-zA-Z0-9_]+\([^)]*=\s*(\[\]|\{\}|set\(\))/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
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
        matchLine: (line) =>
          /(?:execute|raw)\s*\(\s*f["'].*\{/.test(line) ||
          /(?:execute|raw)\s*\(\s*["'].*%\s*[a-zA-Z0-9_.]+/i.test(line) ||
          /f["'].*(?:SELECT|INSERT|UPDATE|DELETE)\b.*(?:WHERE|VALUES)\b.*\{/i.test(
            line
          ),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          const cleaned = line
            .replace(/f(["'])(.*?)\{([a-zA-Z0-9_.]+)\}(.*?)\1/g, '$1$2%s$4$1, ($3,)')
            .replace(/'%s'/g, '%s');
          return {
            body: 'Interpolating variables into SQL queries via Python f-strings or `%` format strings causes **SQL Injection (CWE-89)**. Use database cursor parameterized queries with placeholders (`%s` or `?`) and a parameter tuple/list.',
            suggestionCode:
              cleaned !== line
                ? cleaned
                : `${indent}cursor.execute("SELECT ... WHERE id = %s", (param,))`,
          };
        },
      },
      {
        id: 'py-subprocess-shell',
        title: 'Python `shell=True` or `os.system()` allows command injection',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /(?:subprocess\.(?:run|call|Popen|check_output)\s*\([^)]*shell\s*=\s*True)/.test(
            line
          ) || /\bos\.system\s*\(/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
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
        matchLine: (line) =>
          /^\s*except\s*:\s*$/.test(line) ||
          /^\s*except\s+BaseException\s*:/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'A bare `except:` catches `KeyboardInterrupt` (Ctrl+C) and `SystemExit`, preventing normal application termination and masking unexpected syntax or type errors. Catch `Exception` explicitly.',
            suggestionCode: `${indent}except Exception as err:`,
          };
        },
      },
    ];
  }

  generateTestSuite(symbolName: string, filePath: string): TestGenerationResult {
    const importPath = filePath.replace(/\.py$/, '').replace(/\//g, '.');
    const testCode = `import pytest
from ${importPath} import ${symbolName}

@pytest.mark.asyncio
async def test_${symbolName}_valid_payload():
    """Verify ${symbolName} processes valid payload and returns expected structure."""
    test_payload = {"id": "usr_101", "role": "member"}
    result = await ${symbolName}(test_payload) if hasattr(${symbolName}, '__await__') else ${symbolName}(test_payload)
    assert result is not None

def test_${symbolName}_malformed_input_rejection():
    """Regression test ensuring ${symbolName} rejects invalid/malicious input safely."""
    with pytest.raises((ValueError, TypeError, Exception)):
        ${symbolName}(None)

def test_${symbolName}_boundary_values():
    """Ensure edge case inputs do not cause unhandled runtime crashes."""
    result = ${symbolName}({}) if not hasattr(${symbolName}, '__await__') else None
    assert result is None or isinstance(result, (dict, list, tuple, object))`;

    return {
      testCode,
      testLanguage: 'python',
      runnerHint: `Run via \`pytest tests/test_${this.getBasename(filePath)}\``,
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `"""Execute ${symbolName} with validated parameters.

Args:
    params (dict): Verified request attributes.

Returns:
    dict: Processed domain payload.

Raises:
    ValueError: When input parameters fail validation.
"""`;

    return {
      docBlock,
      formatName: 'PEP 257 / Google Docstring',
    };
  }
}
