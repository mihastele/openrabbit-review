import type {
  DiffHunk,
  FileDiff,
  InlineFinding,
  ReviewCategory,
  ReviewSeverity,
} from '../../types/index.js';

export interface LanguageRule {
  id: string;
  title: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  matchLine: (line: string, file: FileDiff, contextLines: string[]) => boolean;
  buildFinding: (
    line: string,
    lineNumber: number,
    file: FileDiff,
    contextLines: string[]
  ) => {
    body: string;
    suggestionCode?: string;
  };
}

export interface TestGenerationResult {
  testCode: string;
  testLanguage: string;
  runnerHint: string;
}

export interface DocGenerationResult {
  docBlock: string;
  formatName: string;
}

export interface FixGenerationResult {
  fixedCode: string;
  rationale: string;
}

/**
 * Strategy pattern interface for programming language analysis,
 * rule evaluation, test generation, and documentation.
 */
export interface LanguageStrategy {
  /** Unique language identifier (e.g., 'csharp', 'python', 'cpp') */
  readonly id: string;

  /** Human-readable display name (e.g., 'C#', 'C++', 'Java') */
  readonly displayName: string;

  /** Supported file extensions without leading dot (e.g., ['cs']) */
  readonly fileExtensions: string[];

  /** Regex patterns used to extract modified symbols (functions, classes, structs) */
  readonly symbolPatterns: RegExp[];

  /** Returns language-specific static analysis & security rules */
  getRules(): LanguageRule[];

  /** Generates language-idiomatic unit test suite for a given symbol */
  generateTestSuite(
    symbolName: string,
    filePath: string,
    hunk?: DiffHunk
  ): TestGenerationResult;

  /** Generates language-idiomatic documentation comments (XML Doc, Javadoc, Doxygen, etc.) */
  generateDocumentation(
    symbolName: string,
    filePath: string,
    hunk?: DiffHunk
  ): DocGenerationResult;

  /** Generates language-idiomatic committable fix for a given finding or symbol */
  generateIdiomaticFix(
    symbolName: string,
    filePath: string,
    finding?: InlineFinding
  ): FixGenerationResult;
}
