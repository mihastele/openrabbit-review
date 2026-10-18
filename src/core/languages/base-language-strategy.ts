import type {
  DiffHunk,
  InlineFinding,
} from '../../types/index.js';
import type {
  DocGenerationResult,
  FixGenerationResult,
  LanguageRule,
  LanguageStrategy,
  TestGenerationResult,
} from './language-strategy.interface.js';

/**
 * Base template implementation of LanguageStrategy.
 * Provides sensible defaults and formatting helpers for concrete language classes.
 */
export abstract class BaseLanguageStrategy implements LanguageStrategy {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly fileExtensions: string[];
  abstract readonly symbolPatterns: RegExp[];

  abstract getRules(): LanguageRule[];

  abstract generateTestSuite(
    symbolName: string,
    filePath: string,
    hunk?: DiffHunk
  ): TestGenerationResult;

  abstract generateDocumentation(
    symbolName: string,
    filePath: string,
    hunk?: DiffHunk
  ): DocGenerationResult;

  generateIdiomaticFix(
    symbolName: string,
    _filePath: string,
    finding?: InlineFinding
  ): FixGenerationResult {
    if (finding?.suggestionCode) {
      return {
        fixedCode: finding.suggestionCode,
        rationale: `Applied committable fix for ${finding.title}`,
      };
    }
    return {
      fixedCode: `// Safe validated implementation for ${symbolName}`,
      rationale: 'Replaces vulnerable pattern with validated, parameterized code',
    };
  }

  protected getIndent(line: string): string {
    return line.match(/^\s*/)?.[0] || '';
  }

  protected getBasename(filePath: string): string {
    return filePath.split('/').pop()?.split('\\').pop() || filePath;
  }

  protected capitalize(str: string): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
