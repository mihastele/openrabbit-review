import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { discoverWorkspaceCustomRules } from '../core/custom-rules/rule-file-loader.js';
import { validateCustomRuleV1 } from '../core/custom-rules/custom-rule-schema.js';
import type { OpenRabbitConfig, PathInstruction } from '../types/index.js';

export const DEFAULT_OPENRABBIT_CONFIG: OpenRabbitConfig = {
  language: 'en-US',
  profile: 'chill',
  tone_instructions:
    'Be constructive, concise, and high-signal. Prioritize real bugs, security vulnerabilities, race conditions, and performance bottlenecks over stylistic nitpicks.',
  early_access: true,
  reviewer: 'hybrid',
  static_analysis: {
    enabled: true,
    builtinRules: {
      mode: 'all',
      enabledRuleIds: [],
      disabledRuleIds: [],
    },
    customRules: [],
    customRulesFiles: ['.openrabbit-rules.json', '.openrabbit-rules.yaml'],
  },
  reviews: {
    high_level_summary: true,
    poem: true,
    review_status: true,
    collapse_walkthrough: false,
    sequence_diagrams: true,
    auto_review: {
      enabled: true,
      drafts: false,
      base_branches: ['main', 'master', 'develop'],
    },
    path_filters: [
      '!dist/**',
      '!node_modules/**',
      '!*.lock',
      '!package-lock.json',
      '!pnpm-lock.yaml',
      '!**/*.min.js',
      '!**/*.snap',
    ],
    path_instructions: [
      {
        path: 'src/api/**',
        instructions:
          'Verify authentication checks, input validation, rate limiting, and SQL/command injection safety on all endpoints.',
      },
      {
        path: '**/*.tsx',
        instructions:
          'Check for React hook dependency array bugs, stale closures, memory leaks in useEffect, and accessibility attributes.',
      },
      {
        path: '**/*.py',
        instructions:
          'Enforce PEP 8 conventions, verify mutable default arguments, prevent SQL injection in f-strings, check subprocess shell=False, and ensure exception handling specificity.',
      },
      {
        path: '**/*.go',
        instructions:
          'Ensure all returned errors are handled, verify defer resp.Body.Close() on HTTP responses, prevent fmt.Sprintf SQL injection, and guard against goroutine leaks.',
      },
      {
        path: '**/*.rs',
        instructions:
          'Prevent unwrap() in production error paths (prefer ? or unwrap_or_default), document unsafe blocks with // SAFETY: comments, and audit clone() efficiency.',
      },
      {
        path: 'tests/**',
        instructions:
          'Ensure tests cover edge cases, error paths, and avoid brittle timing assumptions.',
      },
    ],
  },
  chat: {
    auto_reply: true,
  },
  llm: {
    provider: 'auto',
    temperature: 0.2,
  },
};

const CONFIG_FILENAMES = [
  '.openrabbit.yaml',
  '.openrabbit.yml',
  'openrabbit.yaml',
  '.coderabbit.yaml',
  '.coderabbit.yml',
];

export function loadConfig(workspaceDir: string = process.cwd()): {
  config: OpenRabbitConfig;
  configPath: string | null;
} {
  let loadedConfig = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
  let resolvedPath: string | null = null;

  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(workspaceDir, filename);
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        const parsed = YAML.parse(raw) || {};
        loadedConfig = mergeConfig(DEFAULT_OPENRABBIT_CONFIG, parsed);
        resolvedPath = candidate;
        break;
      } catch (err) {
        console.warn(`Warning: Failed to parse ${candidate}, using defaults.`, err);
      }
    }
  }

  // Also auto-discover any workspace custom rules (.openrabbit-rules.json, etc.)
  try {
    const discovered = discoverWorkspaceCustomRules(workspaceDir);
    if (discovered.rules.length > 0) {
      if (!loadedConfig.static_analysis) {
        loadedConfig.static_analysis = structuredClone(
          DEFAULT_OPENRABBIT_CONFIG.static_analysis!
        );
      }
      const existingIds = new Set(
        (loadedConfig.static_analysis.customRules || []).map((r: any) => r.id)
      );
      for (const rule of discovered.rules) {
        if (!existingIds.has(rule.id)) {
          loadedConfig.static_analysis.customRules!.push(rule);
          existingIds.add(rule.id);
        }
      }
    }
  } catch {
    // Ignore discovery errors in edge cases
  }

  return {
    config: loadedConfig,
    configPath: resolvedPath,
  };
}

export function parseYamlConfig(yamlContent: string): OpenRabbitConfig {
  const parsed = YAML.parse(yamlContent) || {};
  return mergeConfig(DEFAULT_OPENRABBIT_CONFIG, parsed);
}

export function serializeConfigToYaml(config: OpenRabbitConfig): string {
  const header = `# yaml-language-server: $schema=https://openrabbit.dev/schema/v1.json
# ============================================================================
# OpenRabbit Configuration (.openrabbit.yaml)
# Open-Source AI Pull Request Reviewer & Interactive PR Companion
# ============================================================================

`;
  return header + YAML.stringify(config, { indent: 2 });
}

export function mergeConfig(
  base: OpenRabbitConfig,
  override: Record<string, any>
): OpenRabbitConfig {
  const merged = structuredClone(base);

  if (typeof override.language === 'string') merged.language = override.language;
  if (
    override.profile === 'chill' ||
    override.profile === 'assertive' ||
    override.profile === 'security-focused'
  ) {
    merged.profile = override.profile;
  }
  if (typeof override.tone_instructions === 'string') {
    merged.tone_instructions = override.tone_instructions;
  }
  if (typeof override.early_access === 'boolean') {
    merged.early_access = override.early_access;
  }

  if (override.reviews && typeof override.reviews === 'object') {
    const r = override.reviews;
    if (typeof r.high_level_summary === 'boolean')
      merged.reviews.high_level_summary = r.high_level_summary;
    if (typeof r.poem === 'boolean') merged.reviews.poem = r.poem;
    if (typeof r.review_status === 'boolean')
      merged.reviews.review_status = r.review_status;
    if (typeof r.collapse_walkthrough === 'boolean')
      merged.reviews.collapse_walkthrough = r.collapse_walkthrough;
    if (typeof r.sequence_diagrams === 'boolean')
      merged.reviews.sequence_diagrams = r.sequence_diagrams;

    if (r.auto_review && typeof r.auto_review === 'object') {
      if (typeof r.auto_review.enabled === 'boolean')
        merged.reviews.auto_review.enabled = r.auto_review.enabled;
      if (typeof r.auto_review.drafts === 'boolean')
        merged.reviews.auto_review.drafts = r.auto_review.drafts;
      if (Array.isArray(r.auto_review.base_branches))
        merged.reviews.auto_review.base_branches = r.auto_review.base_branches;
    }

    if (Array.isArray(r.path_filters)) {
      merged.reviews.path_filters = r.path_filters;
    }
    if (Array.isArray(r.path_instructions)) {
      merged.reviews.path_instructions = r.path_instructions.filter(
        (item: any) => item && typeof item.path === 'string' && typeof item.instructions === 'string'
      );
    }
  }

  if (override.chat && typeof override.chat === 'object') {
    if (typeof override.chat.auto_reply === 'boolean') {
      merged.chat.auto_reply = override.chat.auto_reply;
    }
  }

  if (
    override.reviewer === 'hybrid' ||
    override.reviewer === 'custom' ||
    override.reviewer === 'static-only' ||
    override.reviewer === 'llm-only'
  ) {
    merged.reviewer = override.reviewer;
  }

  if (override.static_analysis && typeof override.static_analysis === 'object') {
    if (!merged.static_analysis) {
      merged.static_analysis = structuredClone(
        DEFAULT_OPENRABBIT_CONFIG.static_analysis!
      );
    }
    const sa = override.static_analysis;
    if (typeof sa.enabled === 'boolean') {
      merged.static_analysis.enabled = sa.enabled;
    }

    if (sa.builtinRules && typeof sa.builtinRules === 'object') {
      if (['all', 'subset', 'none'].includes(sa.builtinRules.mode)) {
        merged.static_analysis.builtinRules.mode = sa.builtinRules.mode;
      }
      if (Array.isArray(sa.builtinRules.enabledRuleIds)) {
        merged.static_analysis.builtinRules.enabledRuleIds =
          sa.builtinRules.enabledRuleIds;
      }
      if (Array.isArray(sa.builtinRules.disabledRuleIds)) {
        merged.static_analysis.builtinRules.disabledRuleIds =
          sa.builtinRules.disabledRuleIds;
      }
      if (sa.builtinRules.minSeverity) {
        merged.static_analysis.builtinRules.minSeverity =
          sa.builtinRules.minSeverity;
      }
      if (Array.isArray(sa.builtinRules.categories)) {
        merged.static_analysis.builtinRules.categories =
          sa.builtinRules.categories;
      }
    }

    if (Array.isArray(sa.customRules)) {
      merged.static_analysis.customRules = sa.customRules.filter(
        (r: any) => validateCustomRuleV1(r).valid
      );
    }
    if (Array.isArray(sa.customRulesFiles)) {
      merged.static_analysis.customRulesFiles = sa.customRulesFiles;
    }
  }

  if (Array.isArray(override.custom_rules) || Array.isArray(override.customRules)) {
    const list = Array.isArray(override.custom_rules)
      ? override.custom_rules
      : override.customRules;
    if (!merged.static_analysis) {
      merged.static_analysis = structuredClone(
        DEFAULT_OPENRABBIT_CONFIG.static_analysis!
      );
    }
    const validated = list.filter((r: any) => validateCustomRuleV1(r).valid);
    merged.static_analysis.customRules = [
      ...(merged.static_analysis.customRules || []),
      ...validated,
    ];
  }

  if (override.llm && typeof override.llm === 'object') {
    if (override.llm.provider) merged.llm.provider = override.llm.provider;
    if (override.llm.model !== undefined) merged.llm.model = override.llm.model;
    if (typeof override.llm.temperature === 'number') {
      merged.llm.temperature = override.llm.temperature;
    }
  }

  return merged;
}

/**
 * Converts a glob pattern like `src/api/**` or `*.lock` into a RegExp.
 */
export function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let regexStr = '^';
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
          continue;
        } else {
          regexStr += '.*';
          i += 2;
          continue;
        }
      } else {
        regexStr += '[^/]*';
      }
    } else if (c === '?') {
      regexStr += '[^/]';
    } else if ('.+^$()|[]\\{}'.includes(c)) {
      regexStr += '\\' + c;
    } else {
      regexStr += c;
    }
    i++;
  }
  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

/**
 * Checks whether a file path should be included according to `reviews.path_filters`.
 * Supports positive globs (`src/**`) and negative exclusion globs (`!dist/**`).
 */
export function shouldReviewFile(filePath: string, pathFilters: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!pathFilters || pathFilters.length === 0) return true;

  const positiveFilters = pathFilters.filter((f) => !f.startsWith('!'));
  const negativeFilters = pathFilters
    .filter((f) => f.startsWith('!'))
    .map((f) => f.slice(1));

  // Check exclusions first
  for (const neg of negativeFilters) {
    if (globToRegex(neg).test(normalized) || globToRegex(`**/${neg}`).test(normalized)) {
      return false;
    }
  }

  // If positive filters exist, file must match at least one
  if (positiveFilters.length > 0) {
    return positiveFilters.some((pos) => globToRegex(pos).test(normalized));
  }

  return true;
}

/**
 * Returns all matching path_instructions for a given file path.
 */
export function getMatchingPathInstructions(
  filePath: string,
  instructions: PathInstruction[]
): PathInstruction[] {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return (instructions || []).filter((inst) =>
    globToRegex(inst.path).test(normalized)
  );
}
