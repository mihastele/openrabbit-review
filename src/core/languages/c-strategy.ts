import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class CLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'c';
  readonly displayName = 'C';
  readonly fileExtensions = ['c', 'h'];

  readonly symbolPatterns = [
    /(?:static|extern|inline)?\s*(?:struct\s+[A-Za-z0-9_]+\s*\*?|[a-zA-Z0-9_]+\s*\*+)\s*([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{?/,
    /(?:static|extern|inline)?\s*(?:void|int|char|long|size_t|uint[0-9]+_t|bool)\s*\*?\s*([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{?/,
    /typedef\s+struct\s+([A-Za-z0-9_]+)?\s*\{/,
    /struct\s+([A-Za-z0-9_]+)\s*\{/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'c-unsafe-buffer-function',
        title: 'C unsafe unbounded buffer function (CWE-120)',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /\b(?:strcpy|strcat|sprintf|vsprintf|gets)\s*\(/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          let fixed = line;
          if (line.includes('strcpy(')) {
            fixed = line.replace(/strcpy\s*\(\s*([^,]+),\s*([^)]+)\)/, 'strncpy($1, $2, sizeof($1) - 1)');
          } else if (line.includes('sprintf(')) {
            fixed = line.replace(/sprintf\s*\(\s*([^,]+),\s*/, 'snprintf($1, sizeof($1), ');
          }
          return {
            body: 'Unbounded string functions like `strcpy` and `sprintf` do not verify buffer capacities and lead directly to **Buffer Overflow (CWE-120)** vulnerabilities. Use `strncpy` with explicit length bounds or `snprintf(dest, sizeof(dest), ...)` with null-termination guarantees.',
            suggestionCode: fixed !== line ? fixed : `${indent}// Use snprintf or strncpy with explicit destination bounds`,
          };
        },
      },
      {
        id: 'c-unchecked-malloc-allocation',
        title: 'Unchecked `malloc` / `calloc` result may cause NULL pointer dereference',
        severity: 'warning',
        category: 'bug',
        matchLine: (line, _file, contextLines) => {
          if (!/\b(?:malloc|calloc|realloc)\s*\(/.test(line)) return false;
          const joined = contextLines.join('\n');
          return !/==\s*NULL|!=\s*NULL|!\s*[a-zA-Z0-9_]+/.test(joined);
        },
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          const varMatch = line.match(/(?:[a-zA-Z0-9_*]+\s+)?([a-zA-Z0-9_]+)\s*=\s*(?:\([^)]*\)\s*)?(?:malloc|calloc)/);
          const varName = varMatch ? varMatch[1] : 'ptr';
          return {
            body: 'Dynamic memory allocation with `malloc()` or `calloc()` can fail under memory pressure and return `NULL`. Dereferencing an unchecked pointer causes a segmentation fault (**CWE-476**). Check for `NULL` immediately after allocation.',
            suggestionCode: `${line}\n${indent}if (${varName} == NULL) {\n${indent}    return -1; // Allocation failed\n${indent}}`,
          };
        },
      },
    ];
  }

  generateTestSuite(symbolName: string): TestGenerationResult {
    const testCode = `#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include "${symbolName}.h"

void test_${symbolName}_valid_input(void) {
    int status = ${symbolName}("usr_101");
    assert(status == 0);
    printf("✔ test_${symbolName}_valid_input passed\\n");
}

void test_${symbolName}_null_payload_rejection(void) {
    int status = ${symbolName}(NULL);
    assert(status != 0); // Expected rejection on NULL pointer
    printf("✔ test_${symbolName}_null_payload_rejection passed\\n");
}

int main(void) {
    test_${symbolName}_valid_input();
    test_${symbolName}_null_payload_rejection();
    printf("All C tests passed successfully!\\n");
    return 0;
}`;

    return {
      testCode,
      testLanguage: 'c',
      runnerHint: 'Compile and run via `gcc -Wall -Wextra tests.c && ./a.out`',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `/**
 * @brief Executes ${symbolName} with bounds-checked parameters.
 * @param buffer Non-null input string buffer.
 * @param buffer_len Maximum capacity of buffer in bytes.
 * @return 0 on success, negative error code on failure.
 */`;

    return {
      docBlock,
      formatName: 'Doxygen',
    };
  }
}
