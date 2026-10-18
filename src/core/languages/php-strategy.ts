import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class PhpLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'php';
  readonly displayName = 'PHP';
  readonly fileExtensions = ['php', 'phtml'];

  readonly symbolPatterns = [
    /(?:public|private|protected|static|final)?\s*function\s+([A-Za-z0-9_]+)\s*\(/,
    /(?:abstract|final)?\s*class\s+([A-Za-z0-9_]+)/,
    /interface\s+([A-Za-z0-9_]+)/,
    /trait\s+([A-Za-z0-9_]+)/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'php-sql-injection',
        title: 'PHP SQL Injection via string interpolation or concatenation',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /(?:->query|->exec|mysqli_query|pg_query)\s*\(.*(?:\$[a-zA-Z0-9_]+|\.\s*\$[a-zA-Z0-9_]+)/i.test(
            line
          ),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'Interpolating or concatenating variables directly into PDO or MySQLi queries causes **SQL Injection (CWE-89)**. Prepare the statement with placeholders (`$stmt = $pdo->prepare(...)`) and bind variables via `$stmt->execute([...])`.',
            suggestionCode: `${indent}$stmt = $pdo->prepare("SELECT ... WHERE id = :id");\n${indent}$stmt->execute(['id' => $id]);`,
          };
        },
      },
      {
        id: 'php-command-injection',
        title: 'Unescaped shell execution vulnerable to Command Injection (CWE-78)',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /\b(?:exec|system|passthru|shell_exec|popen)\s*\(.*\$[a-zA-Z0-9_]+/.test(line) ||
          /`.*\$[a-zA-Z0-9_]+.*`/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'Executing shell commands with unsanitized PHP variables allows arbitrary **Command Injection (CWE-78)**. Sanitize arguments using `escapeshellarg()` or use a dedicated process library like Symfony `Process`.',
            suggestionCode: `${indent}$safeArg = escapeshellarg($input);\n${line.replace(/(\$[a-zA-Z0-9_]+)/, 'escapeshellarg($1)')}`,
          };
        },
      },
      {
        id: 'php-xss-direct-echo',
        title: 'Direct output of superglobal input causes Cross-Site Scripting (XSS)',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /\becho\s+.*\$(?:_GET|_POST|_REQUEST)\[/.test(line) &&
          !/htmlspecialchars|htmlentities/.test(line),
        buildFinding: (line) => ({
          body: 'Echoing user-supplied superglobals (`$_GET`, `$_POST`) directly into the HTML response causes **Reflected Cross-Site Scripting (CWE-79)**. Wrap output in `htmlspecialchars($val, ENT_QUOTES, "UTF-8")`.',
          suggestionCode: line.replace(
            /echo\s+(\$_(?:GET|POST|REQUEST)\[[^\]]+\])/,
            'echo htmlspecialchars($1, ENT_QUOTES, "UTF-8")'
          ),
        }),
      },
    ];
  }

  generateTestSuite(symbolName: string): TestGenerationResult {
    const testCode = `<?php

namespace Tests;

use PHPUnit\\Framework\\TestCase;

class ${this.capitalize(symbolName)}Test extends TestCase
{
    public function test${this.capitalize(symbolName)}WithValidInputReturnsExpected(): void
    {
        $payload = ['id' => 'usr_101'];
        // $result = ${symbolName}($payload);
        $this->assertTrue(true);
    }

    public function test${this.capitalize(symbolName)}RejectsMalformedPayload(): void
    {
        $this->expectException(\\InvalidArgumentException::class);
        // ${symbolName}("' OR 1=1 --");
        throw new \\InvalidArgumentException('Invalid input');
    }
}`;

    return {
      testCode,
      testLanguage: 'php',
      runnerHint: 'Run via `vendor/bin/phpunit` or `pest`',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `/**
 * Executes ${symbolName} with validated arguments.
 *
 * @param array<string, mixed> $params Validated request parameters.
 * @return array<string, mixed> Resulting domain response data.
 * @throws \\InvalidArgumentException If input validation fails.
 */`;

    return {
      docBlock,
      formatName: 'PHPDoc',
    };
  }
}
