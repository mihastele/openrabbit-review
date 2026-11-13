import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DEFAULT_OPENRABBIT_CONFIG } from '../src/config/config-loader.js';
import { runPullRequestReview } from '../src/core/review-engine.js';
import { exceedsFailureThreshold, formatSarifReport } from '../src/core/sarif-formatter.js';
import type { InlineFinding, ReviewSeverity } from '../src/types/index.js';
import { createOpenRabbitServer } from '../src/server/app.js';

const finding: InlineFinding = {
  id: 'random-id', file: 'src\\a file#1.ts', startLine: 3, endLine: 5,
  severity: 'warning', category: 'bug', title: 'Problem', body: 'Details',
  ruleMatched: 'test-rule',
};

async function emptyReview() {
  const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
  config.llm.provider = 'heuristic';
  return runPullRequestReview({ rawDiff: '', config });
}

describe('SARIF export and CI review', () => {
  it('serves downloadable reports and threshold evaluations for saved reviews', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-reports-'));
    const server = await createOpenRabbitServer({ port: 0, workspaceDir: directory, storageDir: directory });
    try {
      const review = await emptyReview();
      review.findings = [{ ...finding, severity: 'warning' }];
      await server.store.addReview(review);
      const base = `http://localhost:${server.port}/api/reviews/${review.id}`;
      const sarif = await fetch(`${base}/export?format=sarif`);
      assert.equal(sarif.status, 200);
      assert.match(sarif.headers.get('content-type')!, /application\/sarif\+json/);
      assert.match(sarif.headers.get('content-disposition')!, /attachment; filename="openrabbit-.*\.sarif"/);
      assert.deepEqual(await sarif.json(), formatSarifReport(review));
      const json = await fetch(`${base}/export?format=json`);
      assert.deepEqual(await json.json(), JSON.parse(JSON.stringify(review)));
      const markdown = await fetch(`${base}/export?format=markdown`);
      assert.equal(await markdown.text(), review.markdownWalkthrough + '\n');
      for (const [threshold, status] of [['none', 'advisory'], ['warning', 'failed'], ['critical', 'passed']]) {
        const response = await fetch(`${base}/gate?threshold=${threshold}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { threshold, status });
      }
      // Reports stay available when the review fails; requests do not mutate it.
      assert.equal((await fetch(`${base}/export`)).status, 200);
      assert.deepEqual((await fetch(base).then((r) => r.json())).review, JSON.parse(JSON.stringify(review)));
      assert.equal((await fetch(`${base}/export?format=invalid`)).status, 400);
      assert.equal((await fetch(`${base}/gate?threshold=praise`)).status, 400);
      assert.equal((await fetch(`${base}/unknown`)).status, 404);
      assert.equal((await fetch(`http://localhost:${server.port}/api/reviews/missing/export`)).status, 404);
      review.findings = [];
      await server.store.addReview(review);
      assert.equal((await fetch(`${base}/gate?threshold=nitpick`).then((r) => r.json())).status, 'passed');
    } finally {
      await server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it('exports rule references, encoded paths, severity, and valid regions', async () => {
    const review = await emptyReview();
    review.findings = [finding, { ...finding, id: 'another', severity: 'critical' },
      { ...finding, severity: 'suggestion', ruleMatched: undefined },
      { ...finding, severity: 'praise' }];
    const report = formatSarifReport(review);
    assert.equal(report.version, '2.1.0');
    const run = report.runs[0];
    assert.equal(run.tool.driver.name, 'OpenRabbit');
    assert.deepEqual(run.tool.driver.rules, [{ id: 'test-rule' }, { id: 'openrabbit/bug' }]);
    assert.equal(run.results.length, 3);
    assert.deepEqual(run.results.map((r) => r.level), ['warning', 'error', 'note']);
    assert.deepEqual(run.results.map((r) => r.ruleIndex), [0, 0, 1]);
    assert.deepEqual(run.results[0].locations[0].physicalLocation, {
      artifactLocation: { uri: 'src/a%20file%231.ts' }, region: { startLine: 3, endLine: 5 },
    });
    // Random review/finding identifiers must not change rule identity.
    review.findings[0] = { ...finding, id: 'different-id' };
    assert.deepEqual(formatSarifReport(review), report);
  });

  it('handles empty reports and invalid line ranges without invalid SARIF regions', async () => {
    const review = await emptyReview();
    assert.deepEqual(formatSarifReport(review).runs[0].results, []);
    review.findings = [{ ...finding, startLine: 0 }, { ...finding, endLine: 1 }];
    const results = formatSarifReport(review).runs[0].results;
    assert.equal(results[0].locations[0].physicalLocation.region, undefined);
    assert.deepEqual(results[1].locations[0].physicalLocation.region, { startLine: 3, endLine: 3 });
  });

  it('fails only at or above the selected severity, never for praise or an empty review', () => {
    const severities: ReviewSeverity[] = ['praise', 'nitpick', 'suggestion', 'warning', 'critical'];
    for (let i = 1; i < severities.length; i++) {
      const threshold = severities[i] as 'nitpick' | 'suggestion' | 'warning' | 'critical';
      assert.equal(exceedsFailureThreshold([], threshold), false);
      for (let j = 0; j < severities.length; j++) {
        assert.equal(exceedsFailureThreshold([{ ...finding, severity: severities[j] }], threshold), j >= i);
      }
    }
    assert.equal(exceedsFailureThreshold([{ ...finding, severity: 'critical' }], 'none'), false);
  });

  it('emits parseable CLI reports, writes failed reviews, and validates flags', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-ci-'));
    const cli = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
    const invoke = (...args: string[]) => spawnSync(process.execPath,
      ['--import', import.meta.resolve('tsx'), cli, 'review', '--provider', 'heuristic', ...args],
      { cwd: directory, encoding: 'utf8', timeout: 30000 });
    try {
      const demo = invoke('--demo', 'auth-jwt-sqli', '--format', 'sarif');
      assert.equal(demo.status, 0, demo.stderr);
      assert.ok(JSON.parse(demo.stdout).runs[0].results.length > 0);
      const failed = invoke('--demo', 'auth-jwt-sqli', '--format', 'sarif',
        '--fail-on', 'critical', '--output', 'review.sarif');
      assert.equal(failed.status, 1, failed.stderr);
      assert.equal(failed.stdout, '');
      assert.ok(JSON.parse(fs.readFileSync(path.join(directory, 'review.sarif'), 'utf8')).runs[0].results.length > 0);
      fs.writeFileSync(path.join(directory, 'empty.diff'), '');
      const empty = invoke('--file', 'empty.diff', '--format', 'sarif', '--fail-on', 'nitpick');
      assert.equal(empty.status, 0, empty.stderr);
      assert.deepEqual(JSON.parse(empty.stdout).runs[0].results, []);
      const json = invoke('--file', 'empty.diff', '--format', 'json', '--output', 'review.json');
      assert.equal(json.status, 0, json.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'review.json'), 'utf8')).findings, []);
      const markdown = invoke('--file', 'empty.diff', '--format', 'markdown');
      assert.equal(markdown.status, 0, markdown.stderr);
      assert.match(markdown.stdout, /openrabbit-walkthrough/);
      const initialized = spawnSync('git', ['init', directory], { encoding: 'utf8' });
      assert.equal(initialized.status, 0, initialized.stderr);
      const clean = invoke('--staged', '--format', 'sarif', '--fail-on', 'critical');
      assert.equal(clean.status, 0, clean.stderr);
      assert.deepEqual(JSON.parse(clean.stdout).runs[0].results, []);
      const missingBase = invoke('--base', 'missing-branch', '--format', 'sarif');
      assert.equal(missingBase.status, 1);
      assert.equal(missingBase.stdout, '');
      assert.match(missingBase.stderr, /Error/);
      fs.writeFileSync(path.join(directory, 'clean.ts'), 'export const value = 1;\n');
      assert.equal(spawnSync('git', ['add', 'clean.ts'], { cwd: directory }).status, 0);
      assert.equal(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial'], { cwd: directory }).status, 0);
      const workingTree = invoke('--format', 'json');
      assert.equal(workingTree.status, 0, workingTree.stderr);
      assert.equal(JSON.parse(workingTree.stdout).stats.filesReviewed, 0);
      fs.writeFileSync(path.join(directory, 'clean.ts'), 'const tls = { rejectUnauthorized: false };\n');
      const scan = invoke('--security-scan', '--format', 'sarif', '--fail-on', 'critical');
      assert.equal(scan.status, 1, scan.stderr);
      assert.ok(JSON.parse(scan.stdout).runs[0].results.some((r: { ruleId: string }) => r.ruleId === 'sec-tls-verification-disabled'));
      assert.equal(invoke('--security-scan', '--demo').status, 1);
      for (const args of [['--fail-on', 'praise'], ['--fail-on'], ['--format', 'invalid'], ['--output']]) {
        const invalid = invoke(...args);
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, /Invalid --|--output requires/);
        assert.equal(invalid.stdout, '');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
