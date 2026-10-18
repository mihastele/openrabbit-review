import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class GoLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'go';
  readonly displayName = 'Go';
  readonly fileExtensions = ['go'];

  readonly symbolPatterns = [
    /func\s+(?:\([^)]+\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
    /type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:struct|interface)/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'go-missing-defer-body-close',
        title: 'Missing `defer resp.Body.Close()` leaks TCP sockets and goroutines',
        severity: 'warning',
        category: 'bug',
        matchLine: (line, _file, contextLines) => {
          if (!/(?:http\.(?:Get|Post|Head)|client\.Do)\s*\(/.test(line)) return false;
          const joined = contextLines.join('\n');
          return !/Body\.Close/.test(joined);
        },
        buildFinding: (line) => {
          const indent = this.getIndent(line);
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
        matchLine: (line) =>
          /(?:db\.(?:Query|QueryRow|Exec|Select)|sqlx?)\b.*fmt\.Sprintf|fmt\.Sprintf\s*\(\s*["'](?:SELECT|INSERT|UPDATE|DELETE)\b.*%s/i.test(
            line
          ),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
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
        matchLine: (line) =>
          /^\s*_\s*=\s*(?:json\.Unmarshal|os\.Remove|http\.|io\.Copy|db\.)/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'Discarding errors with `_ =` silently masks I/O or decoding failures in Go. Check and handle `if err != nil` to avoid invalid program states.',
            suggestionCode: `${indent}if err := ${line.replace(/^\s*_\s*=\s*/, '')}; err != nil {\n${indent}    return err\n${indent}}`,
          };
        },
      },
    ];
  }

  generateTestSuite(symbolName: string, filePath: string): TestGenerationResult {
    const exportedName = this.capitalize(symbolName);
    const testCode = `package main

import (
	"context"
	"testing"
)

func Test${exportedName}(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{
			name:    "valid input payload",
			input:   "usr_101",
			wantErr: false,
		},
		{
			name:    "empty string boundary check",
			input:   "",
			wantErr: true,
		},
		{
			name:    "malicious injection check",
			input:   "' OR 1=1 --",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			err := ${exportedName}(ctx, tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("${exportedName}() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}`;

    return {
      testCode,
      testLanguage: 'go',
      runnerHint: `Run via \`go test -v ./${filePath.split('/').slice(0, -1).join('/') || '...'}\``,
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const exported = this.capitalize(symbolName);
    const docBlock = `// ${exported} executes domain logic for the specified payload.
// It returns a non-nil error if input validation or downstream I/O fails.`;

    return {
      docBlock,
      formatName: 'Go Doc Comment',
    };
  }
}
