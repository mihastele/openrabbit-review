import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class GenericLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'generic';
  readonly displayName = 'Code';
  readonly fileExtensions = [];

  readonly symbolPatterns = [
    /(?:def|func|function|fn|class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
  ];

  getRules(): LanguageRule[] {
    return [];
  }

  generateTestSuite(symbolName: string, filePath: string): TestGenerationResult {
    const testCode = `// Generic unit test scaffold for ${symbolName} (${filePath})
// Verify expected output and error boundary conditions.
`;
    return {
      testCode,
      testLanguage: 'text',
      runnerHint: 'Run standard test runner for this project',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    return {
      docBlock: `// Documentation for ${symbolName}`,
      formatName: 'Generic Comment',
    };
  }
}
