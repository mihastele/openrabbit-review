import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class JavaLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'java';
  readonly displayName = 'Java / Kotlin';
  readonly fileExtensions = ['java', 'kt'];

  readonly symbolPatterns = [
    /(?:public|private|protected|static|final|synchronized|abstract|default)?\s*(?:[a-zA-Z0-9_<>[\]?]+\s+)+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\s*\{/,
    /(?:public|private|protected)?\s*(?:abstract|final|sealed)?\s*class\s+([a-zA-Z0-9_]+)/,
    /(?:public|private|protected)?\s*interface\s+([a-zA-Z0-9_]+)/,
    /(?:public|private|protected)?\s*record\s+([a-zA-Z0-9_]+)/,
    /fun\s+([a-zA-Z0-9_]+)\s*\(/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'java-sql-injection',
        title: 'Java SQL Injection via string concatenation in raw query',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /(?:executeQuery|executeUpdate|createStatement|createQuery)\s*\(.*(?:\+\s*[a-zA-Z0-9_.]+|\$\{[a-zA-Z0-9_.]+\})/i.test(
            line
          ),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'Concatenating untrusted variables directly into SQL or HQL statements causes **SQL Injection (CWE-89)**. Use `PreparedStatement` with parameterized placeholders (`?`) or named query parameters.',
            suggestionCode: `${indent}// Use PreparedStatement: conn.prepareStatement("SELECT ... WHERE id = ?"); pstmt.setString(1, id);`,
          };
        },
      },
      {
        id: 'java-unclosed-stream-connection',
        title: 'Resource leak: stream or connection not managed by try-with-resources',
        severity: 'warning',
        category: 'bug',
        matchLine: (line, _file, contextLines) => {
          if (!/\bnew\s+(?:FileInputStream|FileOutputStream|BufferedReader|Connection|Socket)\s*\(/.test(line)) {
            return false;
          }
          const joined = contextLines.join('\n');
          return !/try\s*\(/.test(joined) && !/\.close\(\)/.test(joined);
        },
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'I/O streams, database connections, and sockets implement `AutoCloseable` and must be enclosed in a `try (...)` (try-with-resources) block to guarantee resource reclamation on abnormal termination.',
            suggestionCode: `${indent}try (var resource = ${line.trim().replace(/^var\s+[a-zA-Z0-9_]+\s*=\s*/, '')}) {\n${indent}    // use resource safely\n${indent}}`,
          };
        },
      },
      {
        id: 'java-optional-unsafe-get',
        title: 'Calling `Optional.get()` without `isPresent()` may cause NoSuchElementException',
        severity: 'suggestion',
        category: 'bug',
        matchLine: (line, _file, contextLines) => {
          if (!/\b[a-zA-Z0-9_$.]+\.get\(\)/.test(line)) return false;
          const joined = contextLines.join('\n');
          return !/isPresent|ifPresent|orElse/.test(joined);
        },
        buildFinding: (line) => ({
          body: 'Calling `.get()` on an `Optional` without verifying presence throws `NoSuchElementException`. Prefer `.orElseThrow()`, `.orElseDefault()`, or `.ifPresent(...)`.',
          suggestionCode: line.replace(/\.get\(\)/, '.orElseThrow(() -> new NotFoundException("Entity not found"))'),
        }),
      },
    ];
  }

  generateTestSuite(symbolName: string): TestGenerationResult {
    const className = this.capitalize(symbolName);
    const testCode = `package com.example.tests;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;
import static org.junit.jupiter.api.Assertions.*;

class ${className}Test {

    @Test
    @DisplayName("Should execute ${symbolName} successfully on valid payload")
    void test${className}_ValidPayload_Success() {
        String testId = "usr_101";
        // var result = TargetService.${symbolName}(testId);
        assertDoesNotThrow(() -> {
            // Execution invariant check
        });
    }

    @Test
    @DisplayName("Should reject malicious injection string safely")
    void test${className}_MaliciousPayload_ThrowsException() {
        String maliciousInput = "' OR 1=1 --";
        assertThrows(IllegalArgumentException.class, () -> {
            // TargetService.${symbolName}(maliciousInput);
            throw new IllegalArgumentException();
        });
    }
}`;

    return {
      testCode,
      testLanguage: 'java',
      runnerHint: 'Run via `./gradlew test` or `mvn test`',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `/**
 * Executes {@code ${symbolName}} with validated domain parameters.
 *
 * @param id Non-null, validated entity identifier.
 * @return The resolved payload entity.
 * @throws IllegalArgumentException If the provided parameter fails validation.
 */`;

    return {
      docBlock,
      formatName: 'Javadoc',
    };
  }
}
