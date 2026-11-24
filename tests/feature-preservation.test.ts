import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_OPENRABBIT_CONFIG,
  parseYamlConfig,
} from '../src/config/config-loader.js';
import { handlePRChat } from '../src/core/chat-engine.js';
import { runPullRequestReview } from '../src/core/review-engine.js';
import {
  exceedsFailureThreshold,
  formatSarifReport,
} from '../src/core/sarif-formatter.js';
import { SAMPLE_DIFF_TEMPLATES } from '../src/storage/review-store.js';

function heuristicConfig() {
  const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
  config.llm.provider = 'heuristic';
  config.reviewer = 'hybrid';
  return config;
}

describe('CodeRabbit-style feature preservation contract', () => {
  it('keeps the complete PR walkthrough contract', async () => {
    const template = SAMPLE_DIFF_TEMPLATES[0];
    const review = await runPullRequestReview({
      rawDiff: template.diff,
      prTitle: template.prTitle,
      repository: template.repository,
      prNumber: template.prNumber,
      author: template.author,
      source: 'playground',
      config: heuristicConfig(),
    });

    assert.ok(review.walkthrough.executiveSummary.length > 0);
    assert.ok(review.walkthrough.fileSummaries.length > 0);
    assert.match(review.walkthrough.mermaidDiagram, /sequenceDiagram/);
    assert.ok(review.walkthrough.effortScore >= 1);
    assert.ok(review.walkthrough.effortScore <= 5);
    assert.ok(review.walkthrough.riskLevel.length > 0);
    assert.ok(review.walkthrough.poem.length > 0);
    assert.ok(review.markdownWalkthrough.includes('openrabbit-walkthrough'));
    assert.ok(
      review.findings.some((finding) => Boolean(finding.suggestionCode))
    );
  });

  it('keeps interactive @openrabbit commands available', async () => {
    const template = SAMPLE_DIFF_TEMPLATES[0];
    for (const command of ['explain', 'test', 'fix', 'docstring'] as const) {
      const response = await handlePRChat(
        {
          query: `@openrabbit ${command}`,
          diff: template.diff,
          prTitle: template.prTitle,
        },
        heuristicConfig()
      );
      assert.equal(response.commandDetected, command);
      assert.ok(response.replyMarkdown.length > 0);
    }
  });

  it('keeps security profile, SARIF export, and severity gates available', async () => {
    const template = SAMPLE_DIFF_TEMPLATES[0];
    const config = heuristicConfig();
    config.profile = 'security-focused';
    const review = await runPullRequestReview({
      rawDiff: template.diff,
      prTitle: template.prTitle,
      repository: template.repository,
      source: 'playground',
      config,
    });

    assert.ok(review.findings.length > 0);
    assert.ok(
      review.findings.every((finding) => finding.category === 'security')
    );
    assert.equal(formatSarifReport(review).version, '2.1.0');
    assert.equal(exceedsFailureThreshold(review.findings, 'warning'), true);
    assert.equal(exceedsFailureThreshold([], 'critical'), false);
  });

  it('keeps CodeRabbit-compatible configuration available', () => {
    const config = parseYamlConfig(`
profile: assertive
reviews:
  path_filters:
    - "!vendor/**"
  path_instructions:
    - path: "src/api/**"
      instructions: "Check authorization."
chat:
  auto_reply: false
`);

    assert.equal(config.profile, 'assertive');
    assert.deepEqual(config.reviews.path_filters, ['!vendor/**']);
    assert.equal(config.reviews.path_instructions[0].path, 'src/api/**');
    assert.equal(config.chat.auto_reply, false);
  });
});
