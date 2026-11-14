import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_OPENRABBIT_CONFIG, parseYamlConfig } from '../src/config/config-loader.js';
import { parseUnifiedDiff } from '../src/core/diff-parser.js';
import { formatSarifReport } from '../src/core/sarif-formatter.js';
import {
  gitleaksAdapter,
  parseGitleaksOutput,
  parseSemgrepOutput,
  parseTrivyOutput,
  redactSecret,
  runSecurityScanners,
  semgrepAdapter,
  trivyAdapter,
  type ExecFileFn,
} from '../src/core/security-scanners/index.js';
import type { ReviewResult } from '../src/types/index.js';

const SAMPLE_DIFF = `diff --git a/src/db.ts b/src/db.ts
index 1111111..2222222 100644
--- a/src/db.ts
+++ b/src/db.ts
@@ -1,3 +1,5 @@
 export function queryUser(id: string) {
+  const sql = "SELECT * FROM users WHERE id = " + id;
+  const apiKey = "sk_live_supersecretvalue123456";
   return sql;
 }
diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,2 +1,3 @@
 {
+  "name": "demo"
 }
`;

describe('FOSS Security Scanners Suite', () => {
  it('parses Semgrep JSON output with severity, CWE, and autofix', () => {
    const raw = JSON.stringify({
      results: [
        {
          check_id: 'javascript.lang.security.audit.sqli',
          path: 'src/db.ts',
          start: { line: 2 },
          end: { line: 2 },
          extra: {
            message: 'Untrusted input concatenated into SQL query.',
            severity: 'ERROR',
            fix: 'db.query("SELECT * FROM users WHERE id = $1", [id])',
            metadata: { cwe: ['CWE-89'] },
          },
        },
        {
          check_id: 'javascript.lang.best-practice.info-rule',
          path: 'src/db.ts',
          start: { line: 3 },
          end: { line: 3 },
          extra: {
            message: 'Informational check.',
            severity: 'INFO',
          },
        },
      ],
    });

    const findings = parseSemgrepOutput(raw, '/repo');
    assert.equal(findings.length, 2);
    assert.equal(findings[0].severity, 'critical');
    assert.equal(findings[0].ruleMatched, 'semgrep/javascript.lang.security.audit.sqli');
    assert.match(findings[0].title, /CWE-89/);
    assert.equal(findings[0].suggestionCode, 'db.query("SELECT * FROM users WHERE id = $1", [id])');
    assert.equal(findings[1].severity, 'suggestion');
  });

  it('parses Trivy JSON output for both SCA vulnerabilities and IaC misconfigurations', () => {
    const raw = JSON.stringify({
      Results: [
        {
          Target: 'package-lock.json',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-2024-99999',
              PkgName: 'lodash',
              InstalledVersion: '4.17.20',
              FixedVersion: '4.17.21',
              Severity: 'HIGH',
              Title: 'Prototype Pollution in lodash',
              PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2024-99999',
            },
          ],
        },
        {
          Target: 'Dockerfile',
          Misconfigurations: [
            {
              ID: 'DS002',
              Title: 'Image user should not be root',
              Message: 'Specify at least 1 USER command in Dockerfile',
              Resolution: 'Add USER nonroot',
              Severity: 'MEDIUM',
              CauseMetadata: { StartLine: 12, EndLine: 12 },
            },
          ],
        },
      ],
    });

    const findings = parseTrivyOutput(raw, '/repo');
    assert.equal(findings.length, 2);
    assert.equal(findings[0].severity, 'critical');
    assert.equal(findings[0].ruleMatched, 'trivy/CVE-2024-99999');
    assert.match(findings[0].body, /4\.17\.21/);
    assert.equal(findings[1].severity, 'warning');
    assert.equal(findings[1].file, 'Dockerfile');
    assert.equal(findings[1].startLine, 12);
    assert.equal(findings[1].ruleMatched, 'trivy/DS002');
  });

  it('parses Gitleaks JSON output and redacts secret values', () => {
    const secret = 'sk_live_supersecretvalue123456';
    const raw = JSON.stringify([
      {
        RuleID: 'stripe-access-token',
        Description: 'Stripe Live Secret Key',
        File: 'src/db.ts',
        StartLine: 3,
        EndLine: 3,
        Secret: secret,
      },
    ]);

    const findings = parseGitleaksOutput(raw, '/repo');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'critical');
    assert.equal(findings[0].ruleMatched, 'gitleaks/stripe-access-token');
    assert.ok(!findings[0].body.includes(secret), 'Raw secret must not appear in finding body');
    assert.ok(findings[0].body.includes(redactSecret(secret)));
  });

  it('orchestrates available scanners, skips missing binaries, and scopes to diff lines', async () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    const mockExecFile: ExecFileFn = async (file, args) => {
      if (file === 'trivy') {
        throw Object.assign(new Error('spawn trivy ENOENT'), { code: 'ENOENT' });
      }
      if (file === 'semgrep' && args[0] === '--version') {
        return { stdout: '1.90.0', stderr: '' };
      }
      if (file === 'gitleaks' && args[0] === 'version') {
        return { stdout: '8.20.0', stderr: '' };
      }
      if (file === 'semgrep' && args[0] === 'scan') {
        return {
          stdout: JSON.stringify({
            results: [
              {
                check_id: 'ts.sqli',
                path: 'src/db.ts',
                start: { line: 2 },
                end: { line: 2 },
                extra: { message: 'SQLi on added line', severity: 'ERROR' },
              },
              {
                check_id: 'ts.unchanged-line',
                path: 'src/db.ts',
                start: { line: 99 },
                end: { line: 99 },
                extra: { message: 'Unchanged line finding', severity: 'WARNING' },
              },
            ],
          }),
          stderr: '',
        };
      }
      if (file === 'gitleaks' && args[0] === 'detect') {
        const err: any = new Error('leaks found');
        err.code = 1;
        err.stdout = JSON.stringify([
          {
            RuleID: 'generic-api-key',
            Description: 'Hardcoded API Key',
            File: 'src/db.ts',
            StartLine: 3,
            EndLine: 3,
            Secret: 'sk_live_supersecretvalue123456',
          },
        ]);
        throw err;
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    };

    const result = await runSecurityScanners({
      repoPath: '/repo',
      files: parsed.files,
      config: DEFAULT_OPENRABBIT_CONFIG,
      execFile: mockExecFile,
      adapters: [semgrepAdapter, trivyAdapter, gitleaksAdapter],
    });

    assert.deepEqual(result.scannersRun.sort(), ['gitleaks', 'semgrep']);
    assert.deepEqual(result.scannersSkipped, ['trivy']);
    assert.equal(result.errors.length, 0);
    // Line 99 finding should be filtered out because diff_only is true
    assert.equal(result.findings.length, 2);
    assert.deepEqual(
      result.findings.map((f) => f.ruleMatched).sort(),
      ['gitleaks/generic-api-key', 'semgrep/ts.sqli']
    );

    // Verify SARIF output includes external scanner ruleIds cleanly
    const mockReview: ReviewResult = {
      id: 'rev-test',
      createdAt: new Date().toISOString(),
      source: 'cli',
      repository: 'acme/repo',
      prTitle: 'Test',
      providerUsed: 'heuristic',
      modelUsed: 'openrabbit-ast-v1',
      durationMs: 10,
      stats: {
        filesReviewed: 2,
        additions: 3,
        deletions: 0,
        findingsCount: result.findings.length,
        criticalCount: 2,
        warningCount: 0,
        suggestionCount: 0,
        nitpickCount: 0,
        praiseCount: 0,
      },
      walkthrough: {
        title: 'Test',
        executiveSummary: 'Summary',
        releaseNotes: [],
        fileSummaries: [],
        mermaidDiagram: '',
        poem: '',
        effortScore: 1,
        estimatedMinutes: 1,
        riskLevel: 'critical',
        securityConcerns: [],
      },
      findings: result.findings,
      markdownWalkthrough: '',
    };
    const sarif = formatSarifReport(mockReview);
    const sarifRuleIds = sarif.runs[0].tool.driver.rules.map((r) => r.id).sort();
    assert.deepEqual(sarifRuleIds, ['gitleaks/generic-api-key', 'semgrep/ts.sqli']);
  });

  it('respects YAML security_scanners configuration', async () => {
    const cfg = parseYamlConfig(`
security_scanners:
  enabled: false
  semgrep: false
  timeout_ms: 15000
`);
    assert.equal(cfg.security_scanners?.enabled, false);
    assert.equal(cfg.security_scanners?.semgrep, false);
    assert.equal(cfg.security_scanners?.timeout_ms, 15000);

    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    const res = await runSecurityScanners({
      repoPath: '/repo',
      files: parsed.files,
      config: cfg,
    });
    assert.equal(res.findings.length, 0);
    assert.equal(res.scannersRun.length, 0);
    assert.deepEqual(res.scannersSkipped, ['semgrep', 'trivy', 'gitleaks']);
  });
});
