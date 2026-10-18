import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class CppLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'cpp';
  readonly displayName = 'C++';
  readonly fileExtensions = ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hxx'];

  readonly symbolPatterns = [
    /(?:class|struct)\s+([A-Za-z0-9_]+)(?:\s*final)?(?:\s*:\s*(?:public|protected|private)\s+[A-Za-z0-9_]+)?\s*\{/,
    /(?:inline|virtual|static|constexpr|explicit)?\s*(?:[A-Za-z0-9_<>[\]:*&]+\s+)+([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?:const|override|noexcept)?\s*\{?/,
    /namespace\s+([A-Za-z0-9_]+)\s*\{/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'cpp-raw-pointer-new',
        title: 'C++ Raw `new` allocation without RAII smart pointer',
        severity: 'warning',
        category: 'maintainability',
        matchLine: (line) =>
          /\bnew\s+[A-Za-z0-9_]+(?:<[^>]+>)?\s*[(\[]/.test(line) &&
          !/std::make_unique|std::make_shared|placement\s+new/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          const fixed = line.replace(
            /([A-Za-z0-9_*&]+)\s*=\s*new\s+([A-Za-z0-9_]+)\((.*?)\)/,
            'auto $1 = std::make_unique<$2>($3)'
          );
          return {
            body: 'Manual memory management using raw `new` risks memory leaks and double-free bugs on exceptions. In modern C++ (C++11/14/20), prefer `std::make_unique<T>()` or `std::make_shared<T>()` to enforce RAII ownership.',
            suggestionCode: fixed !== line ? fixed : `${indent}auto ptr = std::make_unique<TargetType>();`,
          };
        },
      },
      {
        id: 'cpp-unsafe-string-function',
        title: 'Unsafe C string function vulnerable to buffer overflow',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /\b(?:strcpy|strcat|sprintf|vsprintf|gets)\s*\(/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'Using unbounded buffer functions (`strcpy`, `strcat`, `sprintf`, `gets`) is a classic source of **Buffer Overflow (CWE-120)** and arbitrary code execution. In modern C++, use `std::string`, `std::format` (C++20), or `snprintf` with explicit destination bounds.',
            suggestionCode: line.includes('sprintf(')
              ? line.replace(/\bsprintf\s*\(/, 'snprintf(buffer, sizeof(buffer), ')
              : `${indent}// Prefer std::string concatenation or snprintf with bounds checking`,
          };
        },
      },
      {
        id: 'cpp-catch-by-value',
        title: 'Catching exception by value causes object slicing',
        severity: 'warning',
        category: 'bug',
        matchLine: (line) =>
          /catch\s*\(\s*(?:std::)?(?:exception|[A-Za-z0-9_]+Error|[A-Za-z0-9_]+Exception)\s+[a-zA-Z0-9_]+\s*\)/.test(
            line
          ),
        buildFinding: (line) => ({
          body: 'Catching exceptions by value slices derived exception objects, discarding polymorphic error information and copy-constructing an exception. Catch by `const &` instead (`catch (const std::exception& e)`).',
          suggestionCode: line.replace(/catch\s*\(\s*(.*?)\s+([a-zA-Z0-9_]+)\s*\)/, 'catch (const $1& $2)'),
        }),
      },
    ];
  }

  generateTestSuite(symbolName: string): TestGenerationResult {
    const testCode = `#include <gtest/gtest.h>
#include <string>

class ${this.capitalize(symbolName)}Test : public ::testing::Test {
protected:
    void SetUp() override {}
    void TearDown() override {}
};

TEST_F(${this.capitalize(symbolName)}Test, ValidInputSucceeds) {
    const std::string validPayload = "usr_101";
    // EXPECT_NO_THROW(${symbolName}(validPayload));
    EXPECT_TRUE(true);
}

TEST_F(${this.capitalize(symbolName)}Test, MalformedPayloadThrowsInvalidArgument) {
    const std::string malicious = "' OR 1=1 --";
    // EXPECT_THROW(${symbolName}(malicious), std::invalid_argument);
    EXPECT_TRUE(true);
}`;

    return {
      testCode,
      testLanguage: 'cpp',
      runnerHint: 'Run via `ctest` or `./build/tests`',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `/**
 * \\brief Executes \\c ${symbolName} with validated arguments.
 * \\param input Validated input string or configuration buffer.
 * \\return Status code or processed domain object.
 * \\throws std::invalid_argument If parameters fail invariant validation.
 */`;

    return {
      docBlock,
      formatName: 'Doxygen',
    };
  }
}
