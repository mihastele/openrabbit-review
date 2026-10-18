import type { LanguageStrategy } from './language-strategy.interface.js';
import { TypeScriptLanguageStrategy } from './typescript-strategy.js';
import { PythonLanguageStrategy } from './python-strategy.js';
import { GoLanguageStrategy } from './go-strategy.js';
import { RustLanguageStrategy } from './rust-strategy.js';
import { CSharpLanguageStrategy } from './csharp-strategy.js';
import { CppLanguageStrategy } from './cpp-strategy.js';
import { CLanguageStrategy } from './c-strategy.js';
import { JavaLanguageStrategy } from './java-strategy.js';
import { PhpLanguageStrategy } from './php-strategy.js';
import { RubyLanguageStrategy } from './ruby-strategy.js';
import { ShellLanguageStrategy } from './shell-strategy.js';
import { GenericLanguageStrategy } from './generic-strategy.js';

/**
 * Registry & Factory Pattern for managing language strategies.
 * Provides extensible lookup by file path, extension, or language identifier.
 */
export class LanguageRegistry {
  private static instance: LanguageRegistry;
  private strategies: Map<string, LanguageStrategy> = new Map();
  private extensionMap: Map<string, LanguageStrategy> = new Map();
  private genericStrategy: LanguageStrategy = new GenericLanguageStrategy();

  private constructor() {
    this.registerDefaults();
  }

  public static getInstance(): LanguageRegistry {
    if (!LanguageRegistry.instance) {
      LanguageRegistry.instance = new LanguageRegistry();
    }
    return LanguageRegistry.instance;
  }

  private registerDefaults(): void {
    const defaults: LanguageStrategy[] = [
      new TypeScriptLanguageStrategy(),
      new PythonLanguageStrategy(),
      new GoLanguageStrategy(),
      new RustLanguageStrategy(),
      new CSharpLanguageStrategy(),
      new CppLanguageStrategy(),
      new CLanguageStrategy(),
      new JavaLanguageStrategy(),
      new PhpLanguageStrategy(),
      new RubyLanguageStrategy(),
      new ShellLanguageStrategy(),
    ];

    for (const strategy of defaults) {
      this.registerStrategy(strategy);
    }
  }

  /**
   * Registers a new language strategy (Open-Closed Principle: open for extension).
   */
  public registerStrategy(strategy: LanguageStrategy): void {
    this.strategies.set(strategy.id.toLowerCase(), strategy);
    for (const ext of strategy.fileExtensions) {
      this.extensionMap.set(ext.toLowerCase(), strategy);
    }
  }

  /**
   * Resolves the appropriate language strategy for a given file path.
   */
  public getStrategyForFile(filePath: string): LanguageStrategy {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return this.extensionMap.get(ext) || this.genericStrategy;
  }

  /**
   * Resolves a strategy by its language id (e.g. 'csharp', 'python').
   */
  public getStrategyById(id: string): LanguageStrategy | undefined {
    return this.strategies.get(id.toLowerCase());
  }

  /**
   * Detects the human-readable language name for a file path.
   */
  public detectLanguageName(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    const specificMap: Record<string, string> = {
      ts: 'TypeScript',
      tsx: 'TypeScript (React)',
      js: 'JavaScript',
      jsx: 'JavaScript (React)',
      mjs: 'JavaScript',
      cjs: 'JavaScript',
      py: 'Python',
      go: 'Go',
      rs: 'Rust',
      cs: 'C#',
      cpp: 'C++',
      cc: 'C++',
      cxx: 'C++',
      c: 'C',
      h: 'C/C++ Header',
      java: 'Java',
      kt: 'Kotlin',
      php: 'PHP',
      rb: 'Ruby',
      sh: 'Shell',
      yaml: 'YAML',
      yml: 'YAML',
      json: 'JSON',
      md: 'Markdown',
      css: 'CSS',
      html: 'HTML',
      sql: 'SQL',
      xml: 'XML',
      toml: 'TOML',
    };
    if (specificMap[ext]) return specificMap[ext];

    const strategy = this.extensionMap.get(ext);
    if (strategy) return strategy.displayName;
    return 'Code';
  }

  /**
   * Aggregates all symbol extraction regex patterns across all registered strategies.
   */
  public getAllSymbolPatterns(): RegExp[] {
    const patterns: RegExp[] = [];
    for (const s of this.strategies.values()) {
      patterns.push(...s.symbolPatterns);
    }
    return patterns;
  }

  /**
   * Returns all registered strategies.
   */
  public getAllStrategies(): LanguageStrategy[] {
    return Array.from(this.strategies.values());
  }
}
