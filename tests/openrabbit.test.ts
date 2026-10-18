import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_OPENRABBIT_CONFIG,
  getMatchingPathInstructions,
  parseYamlConfig,
  shouldReviewFile,
} from '../src/config/config-loader.js';
import { detectChatCommand, handlePRChat } from '../src/core/chat-engine.js';
import { parseUnifiedDiff } from '../src/core/diff-parser.js';
import { WALKTHROUGH_COMMENT_MARKER } from '../src/core/markdown-formatter.js';
import { runPullRequestReview } from '../src/core/review-engine.js';
import { verifyGitHubWebhookSignature } from '../src/integrations/github.js';
import { createOpenRabbitServer } from '../src/server/app.js';
import { SAMPLE_DIFF_TEMPLATES } from '../src/storage/review-store.js';

describe('OpenRabbit Core Suite', () => {
  it('parses unified git diffs, line numbers, and changed symbols accurately', () => {
    const sample = SAMPLE_DIFF_TEMPLATES[0].diff;
    const parsed = parseUnifiedDiff(sample);

    assert.equal(parsed.totalFiles, 1);
    const file = parsed.files[0];
    assert.equal(file.newPath, 'src/api/auth-controller.ts');
    assert.equal(file.language, 'TypeScript');
    assert.ok(file.additions > 0);
    assert.ok(file.symbolsChanged.includes('lookupUserByEmail'));
    assert.ok(file.symbolsChanged.includes('revokeUserSessions'));
  });

  it('filters paths and matches .openrabbit.yaml path_instructions via globs', () => {
    const filters = ['!dist/**', '!*.lock', 'src/**'];
    assert.equal(shouldReviewFile('src/api/user.ts', filters), true);
    assert.equal(shouldReviewFile('dist/bundle.js', filters), false);
    assert.equal(shouldReviewFile('yarn.lock', filters), false);

    const instructions = [
      { path: 'src/api/**', instructions: 'Check SQLi' },
      { path: '**/*.tsx', instructions: 'Check hooks' },
    ];
    const matched = getMatchingPathInstructions('src/api/auth.ts', instructions);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].instructions, 'Check SQLi');
  });

  it('generates PR walkthrough, Mermaid diagram, poem, and committable suggestions', async () => {
    const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    config.profile = 'assertive';
    config.llm.provider = 'heuristic';

    const result = await runPullRequestReview({
      rawDiff: SAMPLE_DIFF_TEMPLATES[0].diff,
      prTitle: SAMPLE_DIFF_TEMPLATES[0].prTitle,
      repository: SAMPLE_DIFF_TEMPLATES[0].repository,
      prNumber: 142,
      config,
    });

    assert.ok(result.markdownWalkthrough.includes(WALKTHROUGH_COMMENT_MARKER));
    assert.ok(result.walkthrough.mermaidDiagram.includes('sequenceDiagram'));
    assert.ok(result.walkthrough.poem.length > 10);
    assert.equal(result.walkthrough.riskLevel, 'critical');
    assert.ok(result.stats.criticalCount >= 2);

    // Ensure SQL injection and hardcoded secret findings include committable suggestions
    const sqliFinding = result.findings.find(
      (f) => f.ruleMatched === 'sec-sql-injection'
    );
    assert.ok(sqliFinding, 'Expected SQL injection finding');
    assert.ok(
      sqliFinding.suggestionCode && sqliFinding.suggestionCode.includes('$1'),
      'Expected parameterized SQL suggestion block'
    );
  });

  it('suppresses nitpicks when profile is set to chill', async () => {
    const chillConfig = parseYamlConfig('profile: chill\nllm:\n  provider: heuristic');
    const assertiveConfig = parseYamlConfig(
      'profile: assertive\nllm:\n  provider: heuristic'
    );

    const chillReview = await runPullRequestReview({
      rawDiff: SAMPLE_DIFF_TEMPLATES[0].diff,
      config: chillConfig,
    });
    const assertiveReview = await runPullRequestReview({
      rawDiff: SAMPLE_DIFF_TEMPLATES[0].diff,
      config: assertiveConfig,
    });

    assert.equal(chillReview.stats.nitpickCount, 0);
    assert.ok(assertiveReview.stats.nitpickCount >= 1);
  });

  it('handles @openrabbit interactive PR chat commands (test, explain, fix, resolve)', async () => {
    assert.equal(
      detectChatCommand('@openrabbit generate unit tests for this'),
      'test'
    );
    assert.equal(detectChatCommand('@openrabbit explain how this works'), 'explain');
    assert.equal(detectChatCommand('@openrabbit fix this bug'), 'fix');

    const testReply = await handlePRChat({
      query: '@openrabbit generate unit tests',
      diff: SAMPLE_DIFF_TEMPLATES[0].diff,
      file: 'src/api/auth-controller.ts',
    });
    assert.equal(testReply.commandDetected, 'test');
    assert.ok(testReply.replyMarkdown.includes('describe('));
    assert.ok(testReply.replyMarkdown.includes('lookupUserByEmail'));
  });

  it('verifies GitHub HMAC-SHA256 webhook signatures', () => {
    const body = '{"action":"opened"}';
    const secret = 'my_webhook_secret';
    // Invalid signature should return false
    assert.equal(
      verifyGitHubWebhookSignature(body, 'sha256=deadbeef', secret),
      false
    );
    // Empty secret allows local testing
    assert.equal(verifyGitHubWebhookSignature(body, undefined, undefined), true);
  });

  it('serves REST API and processes simulated GitHub & GitLab webhooks', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-test-'));
    const serverInstance = await createOpenRabbitServer({
      port: 0,
      workspaceDir: process.cwd(),
      storageDir: tmpDir,
    });

    try {
      const baseUrl = `http://localhost:${serverInstance.port}`;

      const statusRes = await fetch(`${baseUrl}/api/status`).then((r) => r.json());
      assert.equal(statusRes.version, '1.0.0');
      assert.ok(Array.isArray(statusRes.providers));

      const ghWebhookRes = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
        },
        body: JSON.stringify({
          action: 'opened',
          number: 77,
          repository: { full_name: 'test/repo' },
          pull_request: {
            number: 77,
            title: 'feat: test webhook PR',
          },
          simulated_diff: SAMPLE_DIFF_TEMPLATES[0].diff,
        }),
      }).then((r) => r.json());

      assert.equal(ghWebhookRes.handled, true);
      assert.ok(ghWebhookRes.reviewResult.findings.length > 0);
    } finally {
      await serverInstance.close();
    }
  });
});
