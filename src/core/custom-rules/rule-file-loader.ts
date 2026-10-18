import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  CUSTOM_RULE_SCHEMA_VERSION_V1,
  type CustomRuleSetV1,
  type CustomRuleV1,
  STARTER_SAMPLE_CUSTOM_RULES_V1,
  validateCustomRuleV1,
} from './custom-rule-schema.js';

export const DEFAULT_RULES_FILENAMES = [
  '.openrabbit-rules.json',
  '.openrabbit-rules.yaml',
  '.openrabbit-rules.yml',
  'openrabbit.rules.json',
  'openrabbit.rules.yaml',
];

/**
 * Loads and validates custom rules from a specified file path.
 * Supports both JSON and YAML formats.
 */
export function loadRulesFromFile(filePath: string): {
  rules: CustomRuleV1[];
  errors: string[];
  version: string;
} {
  const errors: string[] = [];
  const rules: CustomRuleV1[] = [];

  if (!fs.existsSync(filePath)) {
    return { rules, errors: [`Rules file not found: ${filePath}`], version: 'unknown' };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed: any;
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      parsed = YAML.parse(raw);
    } else {
      parsed = JSON.parse(raw);
    }

    const version = parsed?.schemaVersion || 'v1';

    let ruleList: any[] = [];
    if (Array.isArray(parsed)) {
      ruleList = parsed;
    } else if (parsed && Array.isArray(parsed.rules)) {
      ruleList = parsed.rules;
    } else {
      errors.push(`Expected JSON array or object with a 'rules' array in ${filePath}.`);
      return { rules, errors, version };
    }

    for (let i = 0; i < ruleList.length; i++) {
      const item = ruleList[i];
      // Normalize schemaVersion if missing in array items but present at root
      if (!item.schemaVersion && parsed?.schemaVersion) {
        item.schemaVersion = parsed.schemaVersion;
      }
      if (!item.schemaVersion) {
        item.schemaVersion = CUSTOM_RULE_SCHEMA_VERSION_V1;
      }

      const val = validateCustomRuleV1(item);
      if (val.valid) {
        rules.push(item as CustomRuleV1);
      } else {
        errors.push(
          `Rule #${i + 1} (${item.id || 'unnamed'}) validation error: ${val.errors.join(', ')}`
        );
      }
    }

    return { rules, errors, version };
  } catch (err) {
    errors.push(`Failed to parse ${filePath}: ${(err as Error).message}`);
    return { rules, errors, version: 'error' };
  }
}

/**
 * Searches for default rule files in a workspace directory and returns all valid custom rules.
 */
export function discoverWorkspaceCustomRules(workspaceDir: string = process.cwd()): {
  rules: CustomRuleV1[];
  loadedFiles: string[];
  errors: string[];
} {
  const rulesMap = new Map<string, CustomRuleV1>();
  const loadedFiles: string[] = [];
  const allErrors: string[] = [];

  for (const filename of DEFAULT_RULES_FILENAMES) {
    const candidate = path.join(workspaceDir, filename);
    if (fs.existsSync(candidate)) {
      const { rules, errors } = loadRulesFromFile(candidate);
      loadedFiles.push(candidate);
      if (errors.length > 0) allErrors.push(...errors);
      for (const r of rules) {
        rulesMap.set(r.id, r);
      }
    }
  }

  return {
    rules: Array.from(rulesMap.values()),
    loadedFiles,
    errors: allErrors,
  };
}

/**
 * Persists custom rules to a JSON or YAML file adhering to Schema v1.
 */
export function saveCustomRulesToFile(
  filePath: string,
  rules: CustomRuleV1[],
  options: { name?: string; description?: string } = {}
): { saved: boolean; count: number; error?: string } {
  try {
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const payload: CustomRuleSetV1 = {
      schemaVersion: CUSTOM_RULE_SCHEMA_VERSION_V1,
      name: options.name || 'OpenRabbit Custom Rules',
      description:
        options.description ||
        'Custom static analysis rules and architectural policies for code review.',
      updatedAt: new Date().toISOString(),
      rules,
    };

    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      const header = `# yaml-language-server: $schema=https://openrabbit.dev/schema/rules/v1.json\n# OpenRabbit Custom Static Analysis Rules (Schema v1)\n\n`;
      fs.writeFileSync(filePath, header + YAML.stringify(payload, { indent: 2 }), 'utf8');
    } else {
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    }

    return { saved: true, count: rules.length };
  } catch (err) {
    return { saved: false, count: 0, error: (err as Error).message };
  }
}
