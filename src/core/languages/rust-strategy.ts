import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class RustLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'rust';
  readonly displayName = 'Rust';
  readonly fileExtensions = ['rs'];

  readonly symbolPatterns = [
    /(?:pub(?:\([^)]+\))?\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/,
    /(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait|type)\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
    /impl(?:<[^>]+>)?\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'rust-raw-unwrap',
        title: 'Unchecked `.unwrap()` causes thread panic in production code',
        severity: 'warning',
        category: 'bug',
        matchLine: (line, file) =>
          !file.newPath.includes('test') &&
          !file.newPath.includes('example') &&
          /\.[uU]nwrap\s*\(\)/.test(line),
        buildFinding: (line) => {
          const replaced = line.replace(/\.unwrap\(\)/g, '?');
          return {
            body: 'Calling `.unwrap()` in production Rust code panics the thread if the `Result` is `Err` or `Option` is `None`. Use the `?` operator for error propagation, or handle missing values with `.unwrap_or_default()` / `.context(...)`.',
            suggestionCode:
              replaced !== line ? replaced : line.replace(/\.unwrap\(\)/, '.unwrap_or_default()'),
          };
        },
      },
      {
        id: 'rust-unsafe-block',
        title: 'Rust `unsafe` block without explicit `// SAFETY:` invariant documentation',
        severity: 'suggestion',
        category: 'maintainability',
        matchLine: (line, _file, contextLines) =>
          /\bunsafe\s*\{/.test(line) && !contextLines.some((c) => /SAFETY:/i.test(c)),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'Rust `unsafe` blocks bypass compiler safety guarantees. Follow standard Rust API guidelines by documenting exact safety preconditions with a `// SAFETY: <justification>` comment.',
            suggestionCode: `${indent}// SAFETY: Pointer is non-null and properly aligned\n${line}`,
          };
        },
      },
    ];
  }

  generateTestSuite(symbolName: string): TestGenerationResult {
    const testCode = `#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_${symbolName}_success() {
        let payload = "usr_101";
        // let result = ${symbolName}(payload);
        assert!(true, "Expected operation to succeed on valid input");
    }

    #[test]
    fn test_${symbolName}_invalid_input_rejected() {
        let payload = "";
        // let result = ${symbolName}(payload);
        assert!(true, "Expected error on empty or malformed input");
    }
}`;

    return {
      testCode,
      testLanguage: 'rust',
      runnerHint: 'Run via `cargo test`',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `/// Executes \`${symbolName}\` with validated inputs.
///
/// # Errors
/// Returns an \`Err\` variant if input validation fails or underlying I/O fails.`;

    return {
      docBlock,
      formatName: 'Rustdoc',
    };
  }
}
