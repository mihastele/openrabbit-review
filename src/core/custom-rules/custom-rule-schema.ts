import type { ReviewCategory, ReviewSeverity } from '../../types/index.js';

/**
 * Current version of the OpenRabbit custom rule schema.
 * Designed to be versioned (v1) and extensible for future schema revisions (v2, v3).
 */
export const CUSTOM_RULE_SCHEMA_VERSION_V1 = 'v1' as const;
export type CustomRuleSchemaVersion = typeof CUSTOM_RULE_SCHEMA_VERSION_V1;

/**
 * Rule execution and match type.
 * 'regex': regex pattern matching on added/changed lines or context
 * 'ast': structural pattern or symbol match
 * 'contains': simple substring match
 */
export type CustomRuleMatchType = 'regex' | 'ast' | 'contains';

/**
 * Core definition of a rule matching criteria in Schema v1.
 */
export interface CustomRuleMatchDefinitionV1 {
  /** Match strategy type (default: 'regex') */
  type?: CustomRuleMatchType;

  /** Primary regex pattern or substring to match against code lines */
  pattern: string;

  /** Regex flags (e.g. 'i' for case-insensitive, default 'i') */
  flags?: string;

  /** Whether to evaluate regex across multiline context slices */
  multiline?: boolean;

  /**
   * Negative regex pattern. If this pattern matches the line or context,
   * the rule will NOT trigger (useful for avoiding false positives / allowlisting).
   */
  notPattern?: string;

  /**
   * Optional glob pattern restricting which file paths this rule evaluates against
   * (e.g. 'src/**', '!**\/*.test.ts').
   */
  pathFilter?: string;

  /**
   * Committable code suggestion template.
   * Can reference capture groups ($1, $2, etc.) or provide replacement code.
   */
  suggestionTemplate?: string;
}

/**
 * Complete metadata and schema definition for an OpenRabbit Custom Static Rule (Schema v1).
 */
export interface CustomRuleV1 {
  /** Schema version identifier. Must be 'v1' */
  schemaVersion: CustomRuleSchemaVersion;

  /** Unique rule identifier (e.g. 'team-no-console-log', 'sec-jwt-expiration') */
  id: string;

  /** Human-readable headline / rule title */
  title: string;

  /**
   * Detailed explanation of the issue, security/reliability risk,
   * OWASP/CWE references, and recommended remediation.
   */
  description: string;

  /** Severity / importance level of the rule */
  severity: ReviewSeverity;

  /** Category classification */
  category: ReviewCategory;

  /**
   * Target programming language(s) or '*' / 'all' for cross-language rules.
   * E.g. ['typescript', 'javascript'], ['python'], ['go'], ['csharp'], ['*']
   */
  languages: string[];

  /**
   * Optional explicit file extensions without dot (e.g. ['ts', 'tsx', 'py']).
   * If omitted, resolved automatically from the specified languages.
   */
  fileExtensions?: string[];

  /**
   * Optional glob path filter (e.g. '!**\/*.test.*', 'src\/controllers/**').
   */
  pathFilter?: string;

  /** The rule match criteria, pattern, and suggestion template */
  rule: CustomRuleMatchDefinitionV1;

  /** Whether the rule is actively evaluated during review (default: true) */
  enabled?: boolean;

  /** Optional categorization tags (e.g. ['security', 'compliance', 'style']) */
  tags?: string[];

  /** Optional author or owning team */
  author?: string;

  /** Optional link to internal documentation, wiki, or coding standards */
  docsUrl?: string;

  /**
   * Arbitrary metadata dictionary reserved for future extensions (v1+)
   * without breaking backwards compatibility.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Encapsulates a bundle or file of custom rules conforming to Schema v1.
 */
export interface CustomRuleSetV1 {
  schemaVersion: CustomRuleSchemaVersion;
  name?: string;
  description?: string;
  updatedAt?: string;
  rules: CustomRuleV1[];
  metadata?: Record<string, unknown>;
}

/**
 * Selection mode for built-in static analysis rules:
 * - 'all': evaluate all built-in rules (default)
 * - 'subset': evaluate only a user-selected subset of built-in rules
 * - 'none': suppress all built-in rules (custom rules only)
 */
export type BuiltinRulesMode = 'all' | 'subset' | 'none';

/**
 * Reviewer execution mode:
 * - 'hybrid': Run active LLM + static review (default)
 * - 'custom': Highly configurable custom reviewer (LLM + custom static rules + selected built-in subset)
 * - 'static-only': Run only static analysis (custom rules + selected built-in subset) without external LLM
 * - 'llm-only': Run only LLM review without static rules
 */
export type ReviewerExecutionMode =
  | 'hybrid'
  | 'custom'
  | 'static-only'
  | 'llm-only';

/**
 * Configuration options for the static review engine.
 */
export interface StaticAnalysisConfig {
  /** Whether static analysis is enabled */
  enabled: boolean;

  /** Built-in rules subset and exclusion configuration */
  builtinRules: {
    mode: BuiltinRulesMode;
    /** Rule IDs explicitly enabled when mode is 'subset' */
    enabledRuleIds?: string[];
    /** Rule IDs explicitly disabled even when mode is 'all' */
    disabledRuleIds?: string[];
    /** Minimum severity threshold to report */
    minSeverity?: ReviewSeverity;
    /** Specific categories to filter by */
    categories?: ReviewCategory[];
  };

  /** In-memory or config-embedded custom rules (Schema v1) */
  customRules: CustomRuleV1[];

  /** Optional file paths to external custom rule sets (.json or .yaml) */
  customRulesFiles?: string[];
}

/**
 * Information item describing a built-in rule in the catalog.
 */
export interface BuiltinRuleCatalogItem {
  id: string;
  title: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  languages: string[];
  description: string;
  isBuiltin: true;
}

/**
 * Validates whether an unknown object conforms to CustomRuleV1 schema.
 */
export function validateCustomRuleV1(rule: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!rule || typeof rule !== 'object') {
    return { valid: false, errors: ['Rule must be a non-null object.'] };
  }

  const r = rule as Partial<CustomRuleV1>;

  if (r.schemaVersion !== 'v1') {
    errors.push(`Invalid or missing schemaVersion: expected 'v1', got '${r.schemaVersion}'.`);
  }

  if (!r.id || typeof r.id !== 'string' || !/^[a-zA-Z0-9_\-.:]{2,80}$/.test(r.id)) {
    errors.push('Rule id is required and must be alphanumeric with dashes, underscores, or colons (2-80 chars).');
  }

  if (!r.title || typeof r.title !== 'string' || r.title.trim().length === 0) {
    errors.push('Rule title is required and cannot be empty.');
  }

  const validSeverities: ReviewSeverity[] = [
    'critical',
    'warning',
    'suggestion',
    'nitpick',
    'praise',
  ];
  if (!r.severity || !validSeverities.includes(r.severity)) {
    errors.push(`Invalid severity: must be one of ${validSeverities.join(', ')}.`);
  }

  const validCategories: ReviewCategory[] = [
    'security',
    'bug',
    'performance',
    'maintainability',
    'type-safety',
    'logic',
    'architecture',
    'testing',
  ];
  if (!r.category || !validCategories.includes(r.category)) {
    errors.push(`Invalid category: must be one of ${validCategories.join(', ')}.`);
  }

  if (!Array.isArray(r.languages) || r.languages.length === 0) {
    errors.push("languages must be a non-empty array of target languages or ['*'].");
  }

  if (!r.rule || typeof r.rule !== 'object') {
    errors.push('rule match definition object is required.');
  } else {
    if (!r.rule.pattern || typeof r.rule.pattern !== 'string' || r.rule.pattern.trim().length === 0) {
      errors.push('rule.pattern is required and cannot be empty.');
    } else {
      try {
        new RegExp(r.rule.pattern, r.rule.flags || 'i');
      } catch (e) {
        errors.push(`Invalid regex pattern '${r.rule.pattern}': ${(e as Error).message}`);
      }
    }

    if (r.rule.notPattern) {
      try {
        new RegExp(r.rule.notPattern, r.rule.flags || 'i');
      } catch (e) {
        errors.push(`Invalid notPattern regex '${r.rule.notPattern}': ${(e as Error).message}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Starter sample custom rules to help users get up and running quickly.
 */
export const STARTER_SAMPLE_CUSTOM_RULES_V1: CustomRuleV1[] = [
  {
    schemaVersion: 'v1',
    id: 'team-no-console-log',
    title: 'Avoid raw console.log in production codebase',
    description:
      'Direct console.log statements pollute standard output and can leak sensitive payload data. Use the structured logger (e.g. logger.info or logger.debug) instead.',
    severity: 'suggestion',
    category: 'maintainability',
    languages: ['typescript', 'javascript'],
    fileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs'],
    pathFilter: '!**/*.test.*',
    rule: {
      type: 'regex',
      pattern: '\\bconsole\\.(?:log|debug|info)\\s*\\(',
      flags: 'i',
      suggestionTemplate: 'logger.info(',
    },
    enabled: true,
    tags: ['style', 'logging'],
    author: 'DevOps / Architecture Team',
  },
  {
    schemaVersion: 'v1',
    id: 'sec-no-insecure-http',
    title: 'Insecure plaintext HTTP URL in service communication',
    description:
      'Transmitting data over unencrypted HTTP exposes credentials and traffic to man-in-the-middle (MITM) interception. Enforce HTTPS for remote endpoints.',
    severity: 'warning',
    category: 'security',
    languages: ['*'],
    rule: {
      type: 'regex',
      pattern: "['\"]http:\\/\\/(?!localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)[a-zA-Z0-9_.-]+",
      flags: 'i',
      notPattern: 'http:\\/\\/schemas\\.|http:\\/\\/www\\.w3\\.org',
      suggestionTemplate: 'https://',
    },
    enabled: true,
    tags: ['security', 'network', 'encryption'],
  },
  {
    schemaVersion: 'v1',
    id: 'perf-no-sync-fs',
    title: 'Blocking synchronous filesystem call in async execution path',
    description:
      'Synchronous filesystem methods (readFileSync, writeFileSync) block Node.js event loop threads, hurting server throughput and scalability. Prefer fs.promises or asynchronous counterparts.',
    severity: 'warning',
    category: 'performance',
    languages: ['typescript', 'javascript'],
    fileExtensions: ['ts', 'tsx', 'js', 'mjs'],
    pathFilter: '!**/*.test.*',
    rule: {
      type: 'regex',
      pattern: '\\bfs\\.(?:readFileSync|writeFileSync|existsSync)\\s*\\(',
      flags: 'i',
      suggestionTemplate: 'await fs.promises.readFile(',
    },
    enabled: true,
    tags: ['performance', 'node'],
  },
];
