import crypto from 'node:crypto';
import { globToRegex } from '../../config/config-loader.js';
import type {
  FileDiff,
  InlineFinding,
  ReviewCategory,
  ReviewSeverity,
} from '../../types/index.js';
import { LanguageRegistry, type LanguageRule } from '../languages/index.js';
import {
  type BuiltinRuleCatalogItem,
  type BuiltinRulesMode,
  type CustomRuleV1,
  type StaticAnalysisConfig,
  validateCustomRuleV1,
} from './custom-rule-schema.js';

const SEVERITY_RANKS: Record<ReviewSeverity, number> = {
  critical: 5,
  warning: 4,
  suggestion: 3,
  nitpick: 2,
  praise: 1,
};

/**
 * Universal cross-language security and reliability rules that apply
 * across all languages. Exported so it can be cataloged and configured.
 */
export const GLOBAL_SECURITY_RULES: LanguageRule[] = [
  {
    id: 'sec-hardcoded-secret',
    title: 'Hardcoded secret or API credential detected',
    severity: 'critical',
    category: 'security',
    matchLine: (line, file) =>
      !file.newPath.includes('.example') &&
      !file.newPath.includes('test') &&
      /(?:api[_-]?key|secret|password|private[_-]?key|jwt[_-]?secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-./+=]{12,}['"]/i.test(
        line
      ),
    buildFinding: (line) => {
      const replaced = line.replace(
        /(['"])[A-Za-z0-9_\-./+=]{12,}\1/,
        'process.env.SECRET_KEY ?? ""'
      );
      return {
        body: 'Hardcoding secrets or API tokens in source code risks credential leakage in git history and build artifacts (**CWE-798**). Load this value from an environment variable or secret manager and fail fast if it is missing.',
        suggestionCode: replaced,
      };
    },
  },
  {
    id: 'sec-eval-exec',
    title: 'Unsafe dynamic code execution (`eval` / `child_process.exec`)',
    severity: 'critical',
    category: 'security',
    matchLine: (line) =>
      /\beval\s*\(/.test(line) ||
      /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/.test(line),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Dynamic execution of unsanitized strings via `eval()` or shell-interpolated `exec()` allows arbitrary code or command injection (**CWE-78 / CWE-95**). Prefer structured execution with an explicit argument array or structured JSON deserialization.',
        suggestionCode: line.includes('eval(')
          ? line.replace(/\beval\s*\(/, 'JSON.parse(')
          : `${indent}// Prefer execFile(cmd, [arg1, arg2]) over shell string interpolation`,
      };
    },
  },
  {
    id: 'sec-sql-injection',
    title: 'Potential SQL Injection via string interpolation',
    severity: 'critical',
    category: 'security',
    matchLine: (line) =>
      /(?:SELECT|INSERT|UPDATE|DELETE)\b.*(?:\$\{|['"]\s*\+\s*[a-zA-Z0-9_$.]+)/i.test(
        line
      ),
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      const parameterized = line.replace(/`([^`]*)`/, (_m, inner: string) => {
        let idx = 1;
        const params: string[] = [];
        const sql = inner.replace(
          /'?\$\{([^}]+)\}'?/g,
          (_: string, expr: string) => {
            params.push(expr.trim());
            return `$${idx++}`;
          }
        );
        return params.length > 0
          ? `\`${sql}\`, [${params.join(', ')}]`
          : `\`${inner}\``;
      });

      return {
        body: 'Interpolating user-controlled values directly into a raw SQL query exposes the database to **SQL Injection (CWE-89)**. Use parameterized queries or prepared statements with bound placeholders (`$1`, `?`) instead.',
        suggestionCode:
          parameterized !== line
            ? parameterized
            : `${indent}// Use parameterized query placeholders ($1) instead of string interpolation`,
      };
    },
  },
  {
    id: 'bug-empty-catch',
    title: 'Empty or silent `catch` block swallows runtime exceptions',
    severity: 'warning',
    category: 'bug',
    matchLine: (line, _file, contextLines) => {
      if (!/\bcatch\b/.test(line)) return false;
      const joined = contextLines.join(' ');
      return /catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(joined);
    },
    buildFinding: (line) => {
      const indent = line.match(/^\s*/)?.[0] || '';
      return {
        body: 'Swallowing exceptions in an empty `catch` block hides unexpected failures and makes production debugging difficult. Log the error with context or rethrow a domain-specific error.',
        suggestionCode: `${indent}} catch (error) {\n${indent}  console.error('Operation failed:', error);\n${indent}  throw error;\n${indent}}`,
      };
    },
  },
];

/**
 * Returns a complete catalog list of all built-in static analysis rules
 * across the universal global security rules and all registered language strategies.
 */
export function getAllBuiltinRulesCatalog(): BuiltinRuleCatalogItem[] {
  const catalog: BuiltinRuleCatalogItem[] = [];
  const seenIds = new Set<string>();

  // Global rules
  for (const rule of GLOBAL_SECURITY_RULES) {
    if (!seenIds.has(rule.id)) {
      seenIds.add(rule.id);
      catalog.push({
        id: rule.id,
        title: rule.title,
        category: rule.category,
        severity: rule.severity,
        languages: ['*'],
        description:
          rule.id === 'sec-hardcoded-secret'
            ? 'Detects hardcoded secrets, API tokens, and credentials in source code (CWE-798).'
            : rule.id === 'sec-eval-exec'
            ? 'Detects dangerous dynamic eval() and shell-interpolated exec() commands (CWE-78/CWE-95).'
            : rule.id === 'sec-sql-injection'
            ? 'Flags raw SQL query string interpolation vulnerable to SQL injection (CWE-89).'
            : 'Flags empty or silent catch blocks that swallow runtime exceptions.',
        isBuiltin: true,
      });
    }
  }

  // Language strategies
  const registry = LanguageRegistry.getInstance();
  for (const strategy of registry.getAllStrategies()) {
    const rules = strategy.getRules();
    for (const rule of rules) {
      if (!seenIds.has(rule.id)) {
        seenIds.add(rule.id);
        catalog.push({
          id: rule.id,
          title: rule.title,
          category: rule.category,
          severity: rule.severity,
          languages: [strategy.id],
          description: `${strategy.displayName} static analysis rule for ${rule.category} detection (${rule.title}).`,
          isBuiltin: true,
        });
      }
    }
  }

  return catalog;
}

/**
 * Filters a list of built-in rules according to StaticAnalysisConfig options:
 * - mode: 'all' | 'subset' | 'none'
 * - enabledRuleIds (when mode is 'subset')
 * - disabledRuleIds (to exclude specific rules)
 * - minSeverity / categories
 */
export function filterBuiltinRules(
  rules: LanguageRule[],
  builtinConfig?: {
    mode?: BuiltinRulesMode;
    enabledRuleIds?: string[];
    disabledRuleIds?: string[];
    minSeverity?: ReviewSeverity;
    categories?: ReviewCategory[];
  }
): LanguageRule[] {
  if (!builtinConfig) return rules;
  const mode = builtinConfig.mode || 'all';

  if (mode === 'none') {
    return [];
  }

  const enabledSet = builtinConfig.enabledRuleIds
    ? new Set(builtinConfig.enabledRuleIds)
    : null;
  const disabledSet = builtinConfig.disabledRuleIds
    ? new Set(builtinConfig.disabledRuleIds)
    : null;
  const minRank = builtinConfig.minSeverity
    ? SEVERITY_RANKS[builtinConfig.minSeverity]
    : 1;
  const categoriesSet =
    builtinConfig.categories && builtinConfig.categories.length > 0
      ? new Set(builtinConfig.categories)
      : null;

  return rules.filter((rule) => {
    // If subset mode, must be in enabledSet
    if (mode === 'subset') {
      if (!enabledSet || !enabledSet.has(rule.id)) {
        return false;
      }
    }

    // Exclude if explicitly disabled
    if (disabledSet && disabledSet.has(rule.id)) {
      return false;
    }

    // Filter by min severity
    if (SEVERITY_RANKS[rule.severity] < minRank) {
      return false;
    }

    // Filter by categories if specified
    if (categoriesSet && !categoriesSet.has(rule.category)) {
      return false;
    }

    return true;
  });
}

/**
 * Checks whether a custom rule applies to a given file.
 */
export function doesRuleApplyToFile(rule: CustomRuleV1, file: FileDiff): boolean {
  if (rule.enabled === false) return false;

  const normalizedPath = file.newPath.replace(/\\/g, '/');
  const ext = normalizedPath.split('.').pop()?.toLowerCase() || '';

  // Check pathFilter if specified
  if (rule.rule.pathFilter) {
    const filter = rule.rule.pathFilter.trim();
    if (filter.startsWith('!')) {
      const negativeGlob = filter.slice(1);
      if (globToRegex(negativeGlob).test(normalizedPath)) {
        return false;
      }
    } else {
      if (!globToRegex(filter).test(normalizedPath)) {
        return false;
      }
    }
  }

  // Check fileExtensions if explicitly specified
  if (rule.fileExtensions && rule.fileExtensions.length > 0) {
    const normalizedExts = rule.fileExtensions.map((e) =>
      e.startsWith('.') ? e.slice(1).toLowerCase() : e.toLowerCase()
    );
    if (!normalizedExts.includes(ext)) {
      return false;
    }
    return true;
  }

  // Cross-language wildcard
  if (
    rule.languages.includes('*') ||
    rule.languages.includes('all') ||
    rule.languages.includes('any')
  ) {
    return true;
  }

  // Check language strategy mapping
  const registry = LanguageRegistry.getInstance();
  const fileStrategy = registry.getStrategyForFile(file.newPath);

  const matchedLang = rule.languages.some((lang) => {
    const l = lang.toLowerCase();
    if (l === fileStrategy.id.toLowerCase()) return true;
    if (fileStrategy.fileExtensions.some((e) => e.toLowerCase() === l)) return true;
    if (file.language.toLowerCase().includes(l)) return true;
    return false;
  });

  return matchedLang;
}

/**
 * Computes a committable suggestion from a matched line and rule definition.
 */
export function computeSuggestion(
  line: string,
  rule: CustomRuleV1,
  regex: RegExp
): string | undefined {
  const template = rule.rule.suggestionTemplate;
  if (!template) return undefined;

  const indent = line.match(/^\s*/)?.[0] || '';

  // If template contains capture group references ($1, etc.) or replaces match
  try {
    if (regex.test(line)) {
      const replaced = line.replace(regex, template);
      return replaced;
    }
  } catch {
    // Fallback below
  }

  if (template.includes('\n')) {
    return template
      .split('\n')
      .map((l) => `${indent}${l}`)
      .join('\n');
  }

  return `${indent}${template}`;
}

/**
 * Evaluates custom Schema v1 rules against a list of FileDiffs and returns findings.
 */
export function evaluateCustomRules(
  files: FileDiff[],
  customRules: CustomRuleV1[],
  profile: string = 'chill'
): InlineFinding[] {
  const findings: InlineFinding[] = [];
  const seenKeys = new Set<string>();

  for (const rule of customRules) {
    if (rule.enabled === false) continue;
    if (profile === 'chill' && rule.severity === 'nitpick') continue;

    let regex: RegExp;
    try {
      regex = new RegExp(rule.rule.pattern, rule.rule.flags || 'i');
    } catch {
      continue;
    }

    let notRegex: RegExp | null = null;
    if (rule.rule.notPattern) {
      try {
        notRegex = new RegExp(rule.rule.notPattern, rule.rule.flags || 'i');
      } catch {
        notRegex = null;
      }
    }

    for (const file of files) {
      if (file.status === 'deleted') continue;
      if (!doesRuleApplyToFile(rule, file)) continue;

      for (const hunk of file.hunks) {
        const addedLines = hunk.lines
          .map((l, idx) => ({ line: l, idx }))
          .filter((item) => item.line.type === 'add' && item.line.newLineNumber);

        for (const { line, idx } of addedLines) {
          const lineNum = line.newLineNumber!;
          const lineContent = line.content;

          // Check negative pattern
          if (notRegex && notRegex.test(lineContent)) {
            continue;
          }

          let matched = false;
          if (rule.rule.multiline) {
            const contextSlice = hunk.lines
              .slice(Math.max(0, idx - 2), Math.min(hunk.lines.length, idx + 3))
              .map((l) => l.content)
              .join('\n');
            matched = regex.test(contextSlice);
            if (matched && notRegex && notRegex.test(contextSlice)) {
              matched = false;
            }
          } else {
            matched = regex.test(lineContent);
          }

          if (matched) {
            const dedupeKey = `${file.newPath}:${rule.id}:${lineNum}`;
            if (seenKeys.has(dedupeKey)) continue;
            seenKeys.add(dedupeKey);

            const suggestionCode = computeSuggestion(lineContent, rule, regex);

            findings.push({
              id: `custom-${rule.id}-${crypto.randomUUID().slice(0, 6)}`,
              file: file.newPath,
              startLine: lineNum,
              endLine: lineNum,
              severity: rule.severity,
              category: rule.category,
              title: rule.title,
              body: `${rule.description}${
                rule.docsUrl ? `\n\n[Rule Documentation](${rule.docsUrl})` : ''
              }`,
              suggestionCode,
              originalCode: lineContent,
              ruleMatched: `custom:${rule.id}`,
            });
          }
        }
      }
    }
  }

  return findings;
}

/**
 * Tests one or more rules against raw code lines or a unified diff snippet.
 * Extremely useful for the interactive GUI rule tester and CLI rule test!
 */
export function testCustomRule(
  rule: CustomRuleV1,
  inputCode: string,
  filePath: string = 'sample.ts'
): {
  matched: boolean;
  matchesCount: number;
  matches: {
    lineNumber: number;
    lineContent: string;
    suggestionCode?: string;
  }[];
  finding?: InlineFinding;
} {
  const val = validateCustomRuleV1(rule);
  if (!val.valid) {
    throw new Error(`Rule validation failed: ${val.errors.join('; ')}`);
  }

  const lines = inputCode.split(/\r?\n/);
  let regex: RegExp;
  try {
    regex = new RegExp(rule.rule.pattern, rule.rule.flags || 'i');
  } catch (err) {
    throw new Error(`Invalid regex: ${(err as Error).message}`);
  }

  let notRegex: RegExp | null = null;
  if (rule.rule.notPattern) {
    try {
      notRegex = new RegExp(rule.rule.notPattern, rule.rule.flags || 'i');
    } catch {
      notRegex = null;
    }
  }

  const matches: {
    lineNumber: number;
    lineContent: string;
    suggestionCode?: string;
  }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip diff '+' if snippet is raw diff line
    const cleanLine = line.startsWith('+') ? line.slice(1) : line;

    if (notRegex && notRegex.test(cleanLine)) {
      continue;
    }

    if (regex.test(cleanLine)) {
      const suggestion = computeSuggestion(cleanLine, rule, regex);
      matches.push({
        lineNumber: i + 1,
        lineContent: cleanLine,
        suggestionCode: suggestion,
      });
    }
  }

  const matched = matches.length > 0;
  let finding: InlineFinding | undefined = undefined;

  if (matched) {
    const firstMatch = matches[0];
    finding = {
      id: `test-${rule.id}`,
      file: filePath,
      startLine: firstMatch.lineNumber,
      endLine: firstMatch.lineNumber,
      severity: rule.severity,
      category: rule.category,
      title: rule.title,
      body: rule.description,
      suggestionCode: firstMatch.suggestionCode,
      originalCode: firstMatch.lineContent,
      ruleMatched: `custom:${rule.id}`,
    };
  }

  return {
    matched,
    matchesCount: matches.length,
    matches,
    finding,
  };
}
