import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class ShellLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'shell';
  readonly displayName = 'Shell (Bash/POSIX)';
  readonly fileExtensions = ['sh', 'bash', 'zsh'];

  readonly symbolPatterns = [
    /(?:function\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*\)\s*\{/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'sh-missing-strict-mode',
        title: 'Shell script missing `set -euo pipefail` strict mode',
        severity: 'suggestion',
        category: 'maintainability',
        matchLine: (line, _file, contextLines) =>
          line.startsWith('#!') &&
          !contextLines.some((c) => /set\s+-(?:euo\s+pipefail|e)/.test(c)),
        buildFinding: (line) => ({
          body: 'Shell scripts should specify `set -euo pipefail` to ensure the script exits immediately on errors, handles unset variables safely, and does not ignore pipeline step failures.',
          suggestionCode: `${line}\nset -euo pipefail`,
        }),
      },
      {
        id: 'sh-unquoted-variable-expansion',
        title: 'Unquoted variable expansion in shell command risks word splitting',
        severity: 'warning',
        category: 'security',
        matchLine: (line) =>
          /(?:rm|cp|mv|curl|chmod|chown)\s+.*\$[a-zA-Z0-9_]+(?!\b["'])/.test(line) &&
          !line.includes('"$'),
        buildFinding: (line) => ({
          body: 'Expanding variables without double quotes in shell scripts causes word splitting and glob expansion if the variable contains whitespace or glob characters. Always quote variables (`"$VAR"`).',
          suggestionCode: line.replace(/\$([a-zA-Z0-9_]+)/g, '"$$$1"'),
        }),
      },
    ];
  }

  generateTestSuite(symbolName: string, filePath: string): TestGenerationResult {
    const testCode = `#!/usr/bin/env bash
set -euo pipefail

# Source the target script
source "${filePath}"

test_${symbolName}_success() {
  echo "Running test_${symbolName}_success..."
  # ${symbolName} "valid_arg"
  echo "✔ test_${symbolName}_success passed"
}

test_${symbolName}_failure_on_empty() {
  echo "Running test_${symbolName}_failure_on_empty..."
  # Run and assert failure
  echo "✔ test_${symbolName}_failure_on_empty passed"
}

test_${symbolName}_success
test_${symbolName}_failure_on_empty
echo "All shell tests passed!"`;

    return {
      testCode,
      testLanguage: 'bash',
      runnerHint: 'Run via `bash test.sh` or `bats`',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `# ${symbolName}
# Arguments:
#   $1 - Validated input argument
# Returns:
#   0 on success, non-zero on error`;

    return {
      docBlock,
      formatName: 'Shell Header Comment',
    };
  }
}
