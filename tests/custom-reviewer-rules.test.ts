import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import {
  CUSTOM_RULE_SCHEMA_VERSION_V1,
  type CustomRuleV1,
  STARTER_SAMPLE_CUSTOM_RULES_V1,
  validateCustomRuleV1,
} from '../src/core/custom-rules/custom-rule-schema.js';
import {
  evaluateCustomRules,
  filterBuiltinRules,
  getAllBuiltinRulesCatalog,
  GLOBAL_SECURITY_RULES,
  testCustomRule,
} from '../src/core/custom-rules/custom-rule-engine.js';
import {
  discoverWorkspaceCustomRules,
  loadRulesFromFile,
  saveCustomRulesToFile,
} from '../src/core/custom-rules/rule-file-loader.js';
import { runPullRequestReview } from '../src/core/review-engine.js';
import { parseUnifiedDiff } from '../src/core/diff-parser.js';
import { createOpenRabbitServer } from '../src/server/app.js';
import { DEFAULT_OPENRABBIT_CONFIG } from '../src/config/config-loader.js';

describe('Custom Reviewer & Static Rules Suite (Schema v1)', () => {
  const tmpDir = path.join(process.cwd(), 'data', 'test-custom-rules-workspace');

  test('validates Schema v1 custom rule structure and rejects invalid definitions', () => {
    // Valid rule
    const validRule: CustomRuleV1 = {
      schemaVersion: 'v1',
      id: 'team-no-console-log',
      title: 'Disallow raw console.log',
      description: 'Use structured logger instead of console.log.',
      severity: 'suggestion',
      category: 'maintainability',
      languages: ['typescript', 'javascript'],
      rule: {
        type: 'regex',
        pattern: '\\bconsole\\.log\\(',
        flags: 'i',
        suggestionTemplate: 'logger.info(',
      },
      enabled: true,
    };
    const validCheck = validateCustomRuleV1(validRule);
    assert.equal(validCheck.valid, true);
    assert.equal(validCheck.errors.length, 0);

    // Invalid schemaVersion
    const invalidVersion = { ...validRule, schemaVersion: 'v2' };
    const verCheck = validateCustomRuleV1(invalidVersion);
    assert.equal(verCheck.valid, false);
    assert.match(verCheck.errors[0], /schemaVersion/);

    // Missing id and pattern
    const invalidEmpty = {
      schemaVersion: 'v1',
      title: 'Broken rule',
      severity: 'invalid-severity',
      category: 'security',
      languages: [],
      rule: { pattern: '' },
    };
    const emptyCheck = validateCustomRuleV1(invalidEmpty);
    assert.equal(emptyCheck.valid, false);
    assert.ok(emptyCheck.errors.length >= 3);

    // Invalid regex
    const brokenRegex: CustomRuleV1 = {
      ...validRule,
      id: 'bad-regex',
      rule: {
        pattern: '([a-z+', // unterminated group
      },
    };
    const regexCheck = validateCustomRuleV1(brokenRegex);
    assert.equal(regexCheck.valid, false);
    assert.match(regexCheck.errors[0], /Invalid regex pattern/);
  });

  test('extracts comprehensive built-in static analysis rules catalog', () => {
    const catalog = getAllBuiltinRulesCatalog();
    assert.ok(catalog.length >= 15, `Expected >= 15 built-in rules, got ${catalog.length}`);

    // Verify global security rules are present
    const hasSecretRule = catalog.some((r) => r.id === 'sec-hardcoded-secret');
    const hasSqliRule = catalog.some((r) => r.id === 'sec-sql-injection');
    const hasEvalRule = catalog.some((r) => r.id === 'sec-eval-exec');
    assert.equal(hasSecretRule, true);
    assert.equal(hasSqliRule, true);
    assert.equal(hasEvalRule, true);

    // Verify language-specific rules from strategies
    const hasTypeScriptRule = catalog.some((r) => r.languages.includes('typescript'));
    const hasPythonRule = catalog.some((r) => r.languages.includes('python'));
    const hasGoRule = catalog.some((r) => r.languages.includes('go'));
    const hasRustRule = catalog.some((r) => r.languages.includes('rust'));
    assert.equal(hasTypeScriptRule, true);
    assert.equal(hasPythonRule, true);
    assert.equal(hasGoRule, true);
    assert.equal(hasRustRule, true);
  });

  test('filters built-in rules by mode (all, subset, none) and severity', () => {
    const rules = [...GLOBAL_SECURITY_RULES];

    // Mode: all
    const allFiltered = filterBuiltinRules(rules, { mode: 'all' });
    assert.equal(allFiltered.length, rules.length);

    // Mode: subset (only sec-sql-injection)
    const subsetFiltered = filterBuiltinRules(rules, {
      mode: 'subset',
      enabledRuleIds: ['sec-sql-injection'],
    });
    assert.equal(subsetFiltered.length, 1);
    assert.equal(subsetFiltered[0].id, 'sec-sql-injection');

    // Mode: none
    const noneFiltered = filterBuiltinRules(rules, { mode: 'none' });
    assert.equal(noneFiltered.length, 0);

    // Exclusion list
    const excludedFiltered = filterBuiltinRules(rules, {
      mode: 'all',
      disabledRuleIds: ['sec-hardcoded-secret'],
    });
    assert.equal(
      excludedFiltered.some((r) => r.id === 'sec-hardcoded-secret'),
      false
    );

    // Filter by min severity
    const criticalOnly = filterBuiltinRules(rules, {
      mode: 'all',
      minSeverity: 'critical',
    });
    assert.ok(criticalOnly.every((r) => r.severity === 'critical'));
  });

  test('evaluates custom Schema v1 rules with regex, negative patterns, and autofix suggestions', () => {
    const sampleDiff = `diff --git a/src/api/auth.ts b/src/api/auth.ts
--- a/src/api/auth.ts
+++ b/src/api/auth.ts
@@ -10,3 +10,6 @@
+const tokenUrl = "http://auth.insecure.corp/v1/token";
+console.log("Generated token:", tokenUrl);
+// allowlist: http://schemas.xmlsoap.org
+const metaUrl = "http://schemas.xmlsoap.org/ws";
`;
    const parsed = parseUnifiedDiff(sampleDiff);

    const testRules: CustomRuleV1[] = [
      {
        schemaVersion: 'v1',
        id: 'sec-no-plaintext-http',
        title: 'Plaintext HTTP URL used in sensitive service call',
        description: 'Enforce HTTPS for all inter-service endpoints.',
        severity: 'critical',
        category: 'security',
        languages: ['typescript'],
        rule: {
          type: 'regex',
          pattern: '["\']http:\\/\\/(?!schemas)[a-zA-Z0-9_.-]+',
          flags: 'i',
          notPattern: 'schemas\\.xmlsoap',
          suggestionTemplate: '"https://',
        },
        enabled: true,
      },
      {
        schemaVersion: 'v1',
        id: 'team-no-console-log',
        title: 'Do not use console.log in API controllers',
        description: 'Use structured logger instead.',
        severity: 'warning',
        category: 'maintainability',
        languages: ['typescript'],
        rule: {
          type: 'regex',
          pattern: '\\bconsole\\.log\\(',
          suggestionTemplate: 'logger.info(',
        },
        enabled: true,
      },
    ];

    const findings = evaluateCustomRules(parsed.files, testRules, 'assertive');
    assert.equal(findings.length, 2);

    const httpFinding = findings.find((f) => f.ruleMatched === 'custom:sec-no-plaintext-http');
    assert.ok(httpFinding);
    assert.equal(httpFinding.severity, 'critical');
    assert.equal(httpFinding.category, 'security');
    assert.match(httpFinding.body, /Enforce HTTPS/);

    const consoleFinding = findings.find((f) => f.ruleMatched === 'custom:team-no-console-log');
    assert.ok(consoleFinding);
    assert.equal(consoleFinding.severity, 'warning');
    assert.match(consoleFinding.suggestionCode || '', /logger\.info\(/);
  });

  test('tests individual rules via testCustomRule against code snippets', () => {
    const rule: CustomRuleV1 = STARTER_SAMPLE_CUSTOM_RULES_V1[0]; // console.log rule
    const codeSnippet = `
function handleLogin() {
  console.log("User logged in with email", email);
  return true;
}
`;
    const result = testCustomRule(rule, codeSnippet, 'src/auth.ts');
    assert.equal(result.matched, true);
    assert.equal(result.matchesCount, 1);
    assert.equal(result.matches[0].lineNumber, 3);
    assert.match(result.matches[0].suggestionCode || '', /logger\.info\(/);
  });

  test('loads, discovers, and saves custom rules files (.openrabbit-rules.json & .openrabbit-rules.yaml)', () => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const testRulesPath = path.join(tmpDir, '.openrabbit-rules.json');
    const customRulesToSave: CustomRuleV1[] = [
      {
        schemaVersion: 'v1',
        id: 'custom-file-rule-1',
        title: 'File rule 1 title',
        description: 'File rule 1 explanation',
        severity: 'warning',
        category: 'bug',
        languages: ['*'],
        rule: {
          pattern: '\\bTODO_CRITICAL\\b',
        },
      },
    ];

    // Save JSON
    const saveRes = saveCustomRulesToFile(testRulesPath, customRulesToSave);
    assert.equal(saveRes.saved, true);
    assert.equal(saveRes.count, 1);

    // Load JSON
    const loadRes = loadRulesFromFile(testRulesPath);
    assert.equal(loadRes.errors.length, 0);
    assert.equal(loadRes.rules.length, 1);
    assert.equal(loadRes.rules[0].id, 'custom-file-rule-1');
    assert.equal(loadRes.rules[0].schemaVersion, 'v1');

    // Discover in directory
    const discovered = discoverWorkspaceCustomRules(tmpDir);
    assert.equal(discovered.rules.length, 1);
    assert.equal(discovered.rules[0].id, 'custom-file-rule-1');

    // Clean up test file
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('executes pull request review with reviewer: custom and custom static rules', async () => {
    const rawDiff = `diff --git a/src/services/billing.ts b/src/services/billing.ts
--- a/src/services/billing.ts
+++ b/src/services/billing.ts
@@ -1,5 +1,9 @@
 export async function processBilling(customerId: string) {
+  console.log("Processing customer:", customerId);
+  const rawSecret = "super_secret_jwt_key_123456789";
   return true;
 }
`;
    const customConfig = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    customConfig.reviewer = 'custom';
    customConfig.static_analysis = {
      enabled: true,
      builtinRules: {
        mode: 'subset',
        enabledRuleIds: ['sec-hardcoded-secret'], // only 1 built-in rule
      },
      customRules: [
        {
          schemaVersion: 'v1',
          id: 'team-billing-logger',
          title: 'Direct console logging in billing service is forbidden',
          description: 'Payment and billing logs must use masked PCI-compliant logger.',
          severity: 'critical',
          category: 'security',
          languages: ['typescript'],
          rule: {
            pattern: 'console\\.log\\(',
            suggestionTemplate: 'pciLogger.info(',
          },
          enabled: true,
        },
      ],
    };

    const review = await runPullRequestReview({
      rawDiff,
      prTitle: 'feat(billing): charge card endpoint',
      config: customConfig,
      source: 'cli',
    });

    assert.ok(review.id.startsWith('rev-'));
    assert.match(review.providerUsed, /custom/);

    // Should contain both the selected built-in rule and the custom rule
    const hasCustomFinding = review.findings.some(
      (f) => f.ruleMatched === 'custom:team-billing-logger'
    );
    const hasBuiltinSecretFinding = review.findings.some(
      (f) => f.ruleMatched === 'sec-hardcoded-secret'
    );

    assert.equal(hasCustomFinding, true);
    assert.equal(hasBuiltinSecretFinding, true);
  });

  test('serves REST API endpoints for custom rules management, testing, and configuration', async () => {
    const serverInstance = await createOpenRabbitServer({
      port: 0,
      workspaceDir: tmpDir,
      storageDir: path.join(tmpDir, 'data'),
    });

    try {
      const port = serverInstance.port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // 1. GET /api/rules
      const getRes = await fetch(`${baseUrl}/api/rules`);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.schemaVersion, 'v1');
      assert.ok(Array.isArray(getData.builtinCatalog));
      assert.ok(getData.builtinCatalog.length > 0);

      // 2. POST /api/rules (add custom rule)
      const newRule: CustomRuleV1 = {
        schemaVersion: 'v1',
        id: 'api-enforce-bearer',
        title: 'Authorization header must use Bearer scheme',
        description: 'Verify Authorization: Bearer <token> is required.',
        severity: 'warning',
        category: 'security',
        languages: ['typescript', 'javascript'],
        rule: {
          pattern: 'req\\.headers\\[["\']authorization["\']\\]',
          suggestionTemplate: 'getBearerToken(req)',
        },
        enabled: true,
      };

      const postRes = await fetch(`${baseUrl}/api/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newRule),
      });
      assert.equal(postRes.status, 200);
      const postData = await postRes.json();
      assert.equal(postData.saved, true);
      assert.equal(postData.rule.id, 'api-enforce-bearer');

      // 3. POST /api/rules/test (live test against snippet)
      const testRes = await fetch(`${baseUrl}/api/rules/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rule: newRule,
          code: 'const auth = req.headers["authorization"];',
        }),
      });
      assert.equal(testRes.status, 200);
      const testData = await testRes.json();
      assert.equal(testData.matched, true);
      assert.equal(testData.matchesCount, 1);
      assert.match(testData.matches[0].suggestionCode, /getBearerToken/);

      // 4. PUT /api/rules/config (update reviewer mode & subset)
      const putRes = await fetch(`${baseUrl}/api/rules/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewer: 'custom',
          staticAnalysis: {
            builtinRules: {
              mode: 'subset',
              enabledRuleIds: ['sec-sql-injection'],
            },
          },
        }),
      });
      assert.equal(putRes.status, 200);
      const putData = await putRes.json();
      assert.equal(putData.reviewer, 'custom');
      assert.equal(putData.staticAnalysis.builtinRules.mode, 'subset');

      // 5. DELETE /api/rules/:id
      const delRes = await fetch(`${baseUrl}/api/rules/api-enforce-bearer`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);
      const delData = await delRes.json();
      assert.equal(delData.removed, true);
      assert.equal(delData.id, 'api-enforce-bearer');
    } finally {
      await serverInstance.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
