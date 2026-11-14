import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_OPENRABBIT_CONFIG } from '../src/config/config-loader.js';
import { parseUnifiedDiff } from '../src/core/diff-parser.js';
import {
  buildHeuristicWalkthrough,
  runHeuristicInlineReview,
} from '../src/core/heuristic-analyzer.js';
import { formatWalkthroughMarkdown } from '../src/core/markdown-formatter.js';
import { evaluateCustomRules } from '../src/core/custom-rules/index.js';
import { STARTER_SAMPLE_CUSTOM_RULES_V1 } from '../src/core/custom-rules/custom-rule-schema.js';
import {
  boundPromptFileText,
  createLLMTelemetry,
  mergeAndSnapFindings,
  parseLLMReviewJson,
} from '../src/core/review-engine.js';
import {
  formatSkippedSummary,
  prepareInlineComments,
} from '../src/core/inline-comments.js';
import { runPullRequestReview } from '../src/core/review-engine.js';

const YAML_CI_DIFF = `diff --git a/.woodpecker/test.yaml b/.woodpecker/test.yaml
index b2fd400..12d4748 100644
--- a/.woodpecker/test.yaml
+++ b/.woodpecker/test.yaml
@@ -17,3 +17,8 @@ steps:
         set -eu
+  - name: notify
+    commands:
+      - |
+        echo "status: FAILED (ignored)"
`;

const MARKDOWN_DIFF = `diff --git a/API_specs.md b/API_specs.md
index 1111111..2222222 100644
--- a/API_specs.md
+++ b/API_specs.md
@@ -1,3 +1,5 @@
 # API
+Counts how many models are within one (cutoff) of the best.
 Existing docs.
`;

const PYTHON_DIFF = `diff --git a/app/services/vector_search.py b/app/services/vector_search.py
index 1111111..2222222 100644
--- a/app/services/vector_search.py
+++ b/app/services/vector_search.py
@@ -10,7 +10,11 @@ import math
 from .base import search
+def calculate_vector_spread(vectors):
+    """Scores a hit as (1 + cosine) / 2."""
+    total = len(vectors)
+    return max(1.0, min(2.0, float(total)))
`;

const CSS_DIFF = `diff --git a/styles.css b/styles.css
index 1111111..2222222 100644
--- a/styles.css
+++ b/styles.css
@@ -1,1 +1,4 @@
+body {
+  color: rgba(255, 255, 255, 0.9);
+  transform: scale(1.1);
+}
`;

describe('Gibberish regression corpus (Phase 0)', () => {
  it('does not extract shell/YAML uppercase tokens as code symbols', () => {
    const parsed = parseUnifiedDiff(YAML_CI_DIFF);
    assert.equal(parsed.totalFiles, 1);
    const symbols = parsed.files[0].symbolsChanged;
    assert.ok(
      !symbols.includes('FAILED'),
      `YAML diff must not yield FAILED as symbol, got: ${JSON.stringify(symbols)}`
    );
  });

  it('does not summarize YAML changes as invoking shell tokens', () => {
    const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    config.llm.provider = 'heuristic';
    const parsed = parseUnifiedDiff(YAML_CI_DIFF);
    const findings = runHeuristicInlineReview(parsed.files, config);
    const walkthrough = buildHeuristicWalkthrough(
      'CI: notify step',
      parsed.files,
      findings,
      config
    );
    const summary = walkthrough.fileSummaries[0].summary;
    assert.ok(
      !summary.includes('FAILED'),
      `YAML summary must not mention FAILED as a symbol, got: ${summary}`
    );
    assert.ok(
      !walkthrough.mermaidDiagram.includes('FAILED()'),
      `Mermaid diagram must not Invoke FAILED(), got:\n${walkthrough.mermaidDiagram}`
    );
  });

  it('does not extract prose words from Markdown as code symbols', () => {
    const parsed = parseUnifiedDiff(MARKDOWN_DIFF);
    const symbols = parsed.files[0].symbolsChanged;
    assert.deepEqual(
      symbols,
      [],
      `Markdown prose must yield no code symbols, got: ${JSON.stringify(symbols)}`
    );
  });

  it('does not extract CSS function names as code symbols', () => {
    const parsed = parseUnifiedDiff(CSS_DIFF);
    const symbols = parsed.files[0].symbolsChanged;
    assert.deepEqual(
      symbols,
      [],
      `CSS must yield no code symbols, got: ${JSON.stringify(symbols)}`
    );
  });

  it('extracts only real definitions from Python, not builtin calls', () => {
    const parsed = parseUnifiedDiff(PYTHON_DIFF);
    const symbols = parsed.files[0].symbolsChanged;
    assert.ok(
      symbols.includes('calculate_vector_spread'),
      `Expected real def, got: ${JSON.stringify(symbols)}`
    );
    for (const builtin of ['as', 'max', 'min', 'float', 'len']) {
      assert.ok(
        !symbols.includes(builtin),
        `Python builtins/prose must not be symbols, got: ${JSON.stringify(symbols)}`
      );
    }
  });

  it('does not emit broken fragment suggestions from custom rule templates', () => {
    const rule: any = {
      schemaVersion: 'v1',
      id: 'sec-no-insecure-http',
      title: 'Insecure plaintext HTTP URL',
      description: 'Use HTTPS.',
      severity: 'warning',
      category: 'security',
      languages: ['*'],
      rule: {
        type: 'regex',
        pattern: '[\'"]http:\\/\\/(?!localhost)[a-zA-Z0-9_.-]+',
        flags: 'i',
        suggestionTemplate: 'https://',
      },
      enabled: true,
    };
    const diff = `diff --git a/src/api/client.ts b/src/api/client.ts
index 1111111..2222222 100644
--- a/src/api/client.ts
+++ b/src/api/client.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const endpoint = "http://example.com/api";
`;
    const parsed = parseUnifiedDiff(diff);
    const findings = evaluateCustomRules(parsed.files, [rule], 'assertive');
    assert.equal(findings.length, 1);
    const suggestion = findings[0].suggestionCode;
    assert.ok(
      suggestion === undefined ||
        (suggestion.includes('"https://example.com/api"') &&
          (suggestion.match(/"/g) || []).length % 2 === 0),
      `Suggestion must be a complete quoted replacement or omitted, got: ${JSON.stringify(suggestion)}`
    );
  });

  it('escapes markdown table pipes in walkthrough summaries', () => {
    const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    const walkthrough: any = {
      title: 't',
      executiveSummary: 'summary',
      releaseNotes: [],
      fileSummaries: [
        {
          path: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          component: 'Src',
          summary: 'Handles a | b choice',
          impact: 'low',
        },
      ],
      mermaidDiagram: '',
      poem: '',
      effortScore: 1,
      estimatedMinutes: 2,
      riskLevel: 'low',
      securityConcerns: [],
    };
    const md = formatWalkthroughMarkdown(walkthrough, [], config);
    const row = md.split('\n').find((l) => l.includes('`a.ts`')) || '';
    const pipeCount = (row.match(/(?<!\\)\|/g) || []).length;
    assert.equal(
      pipeCount,
      6,
      `Table row pipes inside summary text must be escaped, got: ${row}`
    );
  });

  it('produces a complete https replacement from the fixed starter http rule', () => {
    const rule = STARTER_SAMPLE_CUSTOM_RULES_V1.find(
      (r) => r.id === 'sec-no-insecure-http'
    )!;
    assert.ok(rule);
    const diff = `diff --git a/src/api/client.ts b/src/api/client.ts
index 1111111..2222222 100644
--- a/src/api/client.ts
+++ b/src/api/client.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const endpoint = "http://example.com/api";
`;
    const parsed = parseUnifiedDiff(diff);
    const findings = evaluateCustomRules(parsed.files, [rule], 'assertive');
    assert.equal(findings.length, 1);
    assert.equal(
      findings[0].suggestionCode,
      'const endpoint = "https://example.com/api";'
    );
  });

  it('emits per-function async replacements from the split fs rules', () => {
    const read = STARTER_SAMPLE_CUSTOM_RULES_V1.find(
      (r) => r.id === 'perf-no-sync-fs-read'
    )!;
    const write = STARTER_SAMPLE_CUSTOM_RULES_V1.find(
      (r) => r.id === 'perf-no-sync-fs-write'
    )!;
    const exists = STARTER_SAMPLE_CUSTOM_RULES_V1.find(
      (r) => r.id === 'perf-no-sync-fs-exists'
    )!;
    assert.ok(read && write && exists);
    const diff = `diff --git a/src/store.ts b/src/store.ts
index 1111111..2222222 100644
--- a/src/store.ts
+++ b/src/store.ts
@@ -1,3 +1,3 @@
-const a = 1;
+const raw = fs.readFileSync(configPath, "utf8");
+fs.writeFileSync(outPath, raw);
+const present = fs.existsSync(outPath);
`;
    const parsed = parseUnifiedDiff(diff);
    const findings = evaluateCustomRules(
      parsed.files,
      [read, write, exists],
      'assertive'
    );
    assert.equal(findings.length, 3);
    const byRule = new Map(findings.map((f) => [f.ruleMatched, f]));
    assert.equal(
      byRule.get('custom:perf-no-sync-fs-read')!.suggestionCode,
      'const raw = await fs.promises.readFile(configPath, "utf8");'
    );
    assert.equal(
      byRule.get('custom:perf-no-sync-fs-write')!.suggestionCode,
      'await fs.promises.writeFile(outPath, raw);'
    );
    assert.equal(
      byRule.get('custom:perf-no-sync-fs-exists')!.suggestionCode,
      undefined
    );
  });

  it('never renders suggestion fences that break on backticks', () => {
    const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    const parsed = parseUnifiedDiff(PYTHON_DIFF);
    const findings = runHeuristicInlineReview(parsed.files, config);
    for (const f of findings) {
      if (f.suggestionCode) {
        assert.ok(
          !f.suggestionCode.includes('```'),
          `Suggestion code must not contain fence-breaking backticks: ${JSON.stringify(f.suggestionCode)}`
        );
      }
    }
  });
});

describe('LLM output hardening (Phase 3)', () => {
  const TS_DIFF = `diff --git a/src/api/user.ts b/src/api/user.ts
index 1111111..2222222 100644
--- a/src/api/user.ts
+++ b/src/api/user.ts
@@ -10,6 +10,9 @@ export async function getUser(id: string) {
   const row = await db.query("SELECT * FROM users WHERE id = $1", [id]);
+  const name = row.name;
+  if (name == "admin") {
+    return grantAll();
+  }
   return row;
 }
`;

  it('parses fenced JSON with trailing prose and validates finding shapes', () => {
    const telemetry = createLLMTelemetry();
    const content = `Here is my review:
\`\`\`json
{
  "executiveSummary": "Adds an admin check.",
  "effortScore": 2,
  "estimatedMinutes": 5,
  "riskLevel": "moderate",
  "findings": [
    {"file": "src/api/user.ts", "startLine": 13, "endLine": 13, "severity": "warning", "category": "bug", "title": "Loose equality", "body": "Use strict equality.", "suggestionCode": "if (name === \\"admin\\") {"},
    {"file": "", "startLine": 0, "title": "", "body": ""},
    {"file": "src/api/user.ts", "startLine": "13", "severity": "bogus", "category": "nope", "title": "Coerced", "body": "Enums default safely."}
  ]
}
\`\`\`
Hope this helps!`;
    const result = parseLLMReviewJson(content, telemetry);
    assert.equal(result.walkthrough.executiveSummary, 'Adds an admin check.');
    assert.equal(result.walkthrough.riskLevel, 'moderate');
    assert.equal(result.findings.length, 2);
    assert.equal(result.findings[0].suggestionCode, 'if (name === "admin") {');
    assert.equal(result.findings[1].severity, 'suggestion');
    assert.equal(result.findings[1].category, 'bug');
    assert.equal(result.findings[1].startLine, 13);
    assert.equal(telemetry.parseOk, true);
    assert.equal(telemetry.findingsReceived, 3);
    assert.equal(telemetry.findingsDropped, 1);
    assert.equal(telemetry.dropReasons['invalid-shape'], 1);
  });

  it('throws on garbage output so the caller falls back cleanly', () => {
    assert.throws(() => parseLLMReviewJson('Sure thing! Let me think...'), /JSON/);
    assert.throws(
      () => parseLLMReviewJson('{"executiveSummary": "truncated...'),
      /JSON|No JSON object/
    );
  });

  it('drops LLM findings on unknown files instead of misplacing them', () => {
    const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    config.profile = 'assertive';
    const parsed = parseUnifiedDiff(TS_DIFF);
    const telemetry = createLLMTelemetry();
    const merged = mergeAndSnapFindings(
      [],
      [
        {
          id: 'llm-1',
          file: 'src/totally-different.ts',
          startLine: 12,
          endLine: 12,
          severity: 'warning',
          category: 'bug',
          title: 'Wrong file',
          body: 'This names a file that is not in the diff.',
        } as any,
      ],
      parsed.files,
      config,
      telemetry
    );
    assert.equal(merged.length, 0);
    assert.equal(telemetry.dropReasons['unknown-file'], 1);
  });

  it('snaps near-miss lines but drops far-away hallucinations', () => {
    const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    config.profile = 'assertive';
    const parsed = parseUnifiedDiff(TS_DIFF);
    const telemetry = createLLMTelemetry();
    const merged = mergeAndSnapFindings(
      [],
      [
        {
          id: 'llm-near',
          file: 'src/api/user.ts',
          startLine: 18,
          endLine: 18,
          severity: 'warning',
          category: 'bug',
          title: 'Near miss',
          body: 'Two lines past the hunk.',
        } as any,
        {
          id: 'llm-far',
          file: 'src/api/user.ts',
          startLine: 500,
          endLine: 500,
          severity: 'warning',
          category: 'bug',
          title: 'Hallucinated line',
          body: 'Nowhere near the diff.',
        } as any,
      ],
      parsed.files,
      config,
      telemetry
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'llm-near');
    assert.equal(merged[0].startLine, 16);
    assert.equal(telemetry.dropReasons['line-out-of-range'], 1);
  });

  it('preserves finding spans instead of stretching ranges across the file', () => {
    const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    config.profile = 'assertive';
    const parsed = parseUnifiedDiff(TS_DIFF);
    const merged = mergeAndSnapFindings(
      [],
      [
        {
          id: 'llm-span',
          file: 'src/api/user.ts',
          startLine: 12,
          endLine: 14,
          severity: 'suggestion',
          category: 'maintainability',
          title: 'Span',
          body: 'Two-line span.',
        } as any,
      ],
      parsed.files,
      config
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].startLine, 12);
    assert.equal(merged[0].endLine, 14);
  });

  it('sanitizes LLM suggestion fragments against the real diff line', () => {
    const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    config.profile = 'assertive';
    const parsed = parseUnifiedDiff(TS_DIFF);
    const merged = mergeAndSnapFindings(
      [],
      [
        {
          id: 'llm-frag',
          file: 'src/api/user.ts',
          startLine: 13,
          endLine: 13,
          severity: 'warning',
          category: 'bug',
          title: 'Fragment suggestion',
          body: 'Suggestion is a bare fragment.',
          suggestionCode: 'https://',
        } as any,
      ],
      parsed.files,
      config
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].suggestionCode, undefined);
  });

  it('bounds prompt file text with an explicit truncation marker', () => {
    const telemetry = createLLMTelemetry();
    const long = 'x'.repeat(20000);
    const bounded = boundPromptFileText(long, telemetry);
    assert.ok(bounded.length < long.length + 100);
    assert.match(bounded, /truncated 8000 chars/);
    assert.equal(telemetry.truncatedFiles, 1);
    assert.equal(boundPromptFileText('short', telemetry), 'short');
  });
});

describe('Posting correctness (Phase 4)', () => {
  const DIFF = `diff --git a/src/api/user.ts b/src/api/user.ts
index 1111111..2222222 100644
--- a/src/api/user.ts
+++ b/src/api/user.ts
@@ -10,4 +10,6 @@ export async function getUser(id: string) {
   const row = await db.query("SELECT * FROM users WHERE id = $1", [id]);
+  const name = row.name;
+  if (name == "admin") {
   return row;
 }
`;

  const finding = (overrides: Record<string, unknown> = {}) => ({
    id: 'finding-1',
    file: 'src/api/user.ts',
    startLine: 12,
    endLine: 12,
    severity: 'warning',
    category: 'bug',
    title: 'Loose equality',
    body: 'Use strict equality.',
    ...overrides,
  });

  it('skips unknown files and off-diff lines instead of posting them', () => {
    const prepared = prepareInlineComments(
      [
        finding() as any,
        finding({ id: 'finding-2', file: 'src/ghost.ts' }) as any,
        finding({ id: 'finding-3', startLine: 999, endLine: 999 }) as any,
      ],
      DIFF
    );
    assert.equal(prepared.comments.length, 1);
    assert.equal(prepared.comments[0].id, 'finding-1');
    assert.deepEqual(
      prepared.skipped.map((s) => s.reason).sort(),
      ['line-not-in-diff', 'unknown-file']
    );
  });

  it('collapses exact duplicates and clamps out-of-range end lines', () => {
    const prepared = prepareInlineComments(
      [
        finding() as any,
        finding({ id: 'finding-dup' }) as any,
        finding({ id: 'finding-span', endLine: 999 }) as any,
      ],
      DIFF
    );
    assert.equal(prepared.comments.length, 2);
    assert.equal(prepared.skipped.length, 1);
    assert.equal(prepared.skipped[0].reason, 'duplicate');
    const span = prepared.comments.find((c) => c.id === 'finding-span')!;
    assert.equal(span.startLine, 12);
    assert.equal(span.endLine, 12);
  });

  it('honors the comment cap and summarizes skips for the review body', () => {
    const prepared = prepareInlineComments(
      [
        finding({ id: 'a', startLine: 11 }) as any,
        finding({ id: 'b', startLine: 12 }) as any,
        finding({ id: 'c', startLine: 13 }) as any,
      ],
      DIFF,
      { maxComments: 2 }
    );
    assert.equal(prepared.comments.length, 2);
    assert.equal(prepared.skipped.length, 1);
    assert.equal(prepared.skipped[0].reason, 'comment-cap');
    assert.equal(formatSkippedSummary(prepared.skipped), ' (1 skipped: 1 comment-cap)');
    assert.equal(formatSkippedSummary([]), '');
  });

  it('still dedupes when no diff is available', () => {
    const prepared = prepareInlineComments([
      finding() as any,
      finding({ id: 'finding-dup' }) as any,
    ]);
    assert.equal(prepared.comments.length, 1);
    assert.equal(prepared.skipped[0].reason, 'duplicate');
  });
});

describe('Golden review output (Phase 5)', () => {
  const GOLDEN_DIFFS: { name: string; diff: string }[] = [
    {
      name: 'yaml-only',
      diff: `diff --git a/.woodpecker/test.yaml b/.woodpecker/test.yaml
index b2fd400..12d4748 100644
--- a/.woodpecker/test.yaml
+++ b/.woodpecker/test.yaml
@@ -17,3 +17,8 @@ steps:
         set -eu
+  - name: notify
+    commands:
+      - |
+        echo "status: FAILED (ignored)"
`,
    },
    {
      name: 'markdown-only',
      diff: `diff --git a/API_specs.md b/API_specs.md
index 1111111..2222222 100644
--- a/API_specs.md
+++ b/API_specs.md
@@ -1,3 +1,5 @@
 # API
+Counts how many models are within one (cutoff) of the best.
 Existing docs.
`,
    },
    {
      name: 'python-builtins',
      diff: `diff --git a/app/services/vector_search.py b/app/services/vector_search.py
index 1111111..2222222 100644
--- a/app/services/vector_search.py
+++ b/app/services/vector_search.py
@@ -10,7 +10,11 @@ import math
 from .base import search
+def calculate_vector_spread(vectors):
+    """Scores a hit as (1 + cosine) / 2."""
+    total = len(vectors)
+    return max(1.0, min(2.0, float(total)))
`,
    },
  ];

  const BANNED_SUBSTRINGS = [
    'Invoke FAILED()',
    'Updates `FAILED`',
    'Updates `one`',
    'Updates `as`',
    'Updates `max`',
    'Updates `len`',
    'Updates `float`',
    'logger.info(',
    'https://`',
    'undefined',
  ];

  for (const golden of GOLDEN_DIFFS) {
    it(`renders no banned gibberish substrings for ${golden.name}`, async () => {
      const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
      config.profile = 'assertive';
      config.llm.provider = 'heuristic';
      const result = await runPullRequestReview({
        rawDiff: golden.diff,
        prTitle: `Golden: ${golden.name}`,
        repository: 'acme-corp/golden',
        config,
      });
      const haystack = [
        result.markdownWalkthrough,
        result.walkthrough.executiveSummary,
        result.walkthrough.mermaidDiagram,
        ...result.walkthrough.fileSummaries.map((s) => s.summary),
        ...result.findings.flatMap((f) => [
          f.title,
          f.body,
          f.suggestionCode || '',
        ]),
      ].join('\n');
      for (const banned of BANNED_SUBSTRINGS) {
        assert.ok(
          !haystack.includes(banned),
          `Golden ${golden.name} output must not contain ${JSON.stringify(banned)}`
        );
      }
      assert.ok(result.markdownWalkthrough.length > 100);
    });
  }
});
