import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { handlePRChat } from '../src/core/chat-engine.js';
import { enrichDiffContext } from '../src/core/context-enricher.js';
import { parseUnifiedDiff } from '../src/core/diff-parser.js';
import { loadRepoMemory } from '../src/core/repo-memory.js';
import { runPullRequestReview } from '../src/core/review-engine.js';
import { DEFAULT_OPENRABBIT_CONFIG } from '../src/config/config-loader.js';

describe('Cross-File Context & Repository Memory Suite', () => {
  it('resolves relative imports for cross-file context while blocking path traversal', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-ctx-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'utils', 'auth.ts'),
        'export function verifyTenant(id: string): boolean {\n  return id.length > 0;\n}\n',
        'utf8'
      );

      const rawDiff = `diff --git a/src/handler.ts b/src/handler.ts
index 1111111..2222222 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,2 +1,4 @@
+import { verifyTenant } from './utils/auth.js';
+import { secret } from '../../../etc/passwd';
 export function handle(id: string) {
+  return verifyTenant(id);
 }
`;
      const parsed = parseUnifiedDiff(rawDiff);
      const enriched = enrichDiffContext(tmpDir, parsed.files, { maxBytes: 4000 });

      assert.equal(enriched.snippets.length, 1);
      assert.equal(enriched.snippets[0].file, 'src/utils/auth.ts');
      assert.equal(enriched.snippets[0].reason, 'imported-module');
      assert.match(enriched.formattedPromptContext, /verifyTenant/);
      assert.ok(!enriched.formattedPromptContext.includes('etc/passwd'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists @openrabbit ignore and remember commands and suppresses ignored rules in reviews', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-mem-'));
    try {
      const diffWithConsoleOrSql = `diff --git a/src/query.ts b/src/query.ts
index 1111111..2222222 100644
--- a/src/query.ts
+++ b/src/query.ts
@@ -1,2 +1,4 @@
 export async function findUser(db: any, email: string) {
+  const res = await db.query(\`SELECT * FROM users WHERE email = '\${email}'\`);
+  return res;
 }
`;
      const baseline = await runPullRequestReview({
        rawDiff: diffWithConsoleOrSql,
        repoPath: tmpDir,
        config: { ...DEFAULT_OPENRABBIT_CONFIG, reviewer: 'static-only' },
      });
      assert.ok(baseline.findings.length > 0, 'Expected baseline static finding');
      const ruleToIgnore = baseline.findings[0].ruleMatched || baseline.findings[0].id;

      const ignoreReply = await handlePRChat({
        query: `@openrabbit ignore ${ruleToIgnore}`,
        repoPath: tmpDir,
      });
      assert.equal(ignoreReply.commandDetected, 'ignore');
      assert.match(ignoreReply.replyMarkdown, /Rule Suppressed/);

      const rememberReply = await handlePRChat({
        query: '@openrabbit remember Always enforce parameterized SQL queries',
        repoPath: tmpDir,
      });
      assert.equal(rememberReply.commandDetected, 'remember');
      assert.match(rememberReply.replyMarkdown, /Guideline Remembered/);

      const mem = loadRepoMemory(path.join(tmpDir, '.openrabbit-memory.json'));
      assert.deepEqual(mem.ignoredRules, [ruleToIgnore]);
      assert.deepEqual(mem.instructions, ['Always enforce parameterized SQL queries']);

      const afterIgnore = await runPullRequestReview({
        rawDiff: diffWithConsoleOrSql,
        repoPath: tmpDir,
        config: { ...DEFAULT_OPENRABBIT_CONFIG, reviewer: 'static-only' },
      });
      assert.ok(
        !afterIgnore.findings.some((f) => (f.ruleMatched || f.id) === ruleToIgnore),
        'Ignored rule should be suppressed in subsequent reviews'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
