import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OPENRABBIT_CONFIG } from '../config/config-loader.js';
import { runPullRequestReview } from '../core/review-engine.js';
import type { ReviewResult } from '../types/index.js';

export interface SampleDiffTemplate {
  id: string;
  name: string;
  prTitle: string;
  repository: string;
  prNumber: number;
  author: string;
  description: string;
  diff: string;
}

export const SAMPLE_DIFF_TEMPLATES: SampleDiffTemplate[] = [
  {
    id: 'auth-jwt-sqli',
    name: 'Auth Service: JWT Refresh & User Lookup',
    prTitle: 'feat(auth): add token rotation and admin user lookup endpoint',
    repository: 'acme-corp/identity-service',
    prNumber: 142,
    author: 'alex-dev',
    description:
      'Introduces JWT refresh rotation and user lookup query (contains SQLi, hardcoded fallback secret, and async forEach bug).',
    diff: `diff --git a/src/api/auth-controller.ts b/src/api/auth-controller.ts
index 4a19b2c..9f81d04 100644
--- a/src/api/auth-controller.ts
+++ b/src/api/auth-controller.ts
@@ -12,10 +12,28 @@ import { db } from '../db/client.js';
 import { signJwt, verifyJwt } from '../utils/crypto.js';
 
+const FALLBACK_JWT_SECRET = "dummy_secret_1234";
+
 export async function lookupUserByEmail(req: Request, res: Response) {
   const email = req.query.email as string;
-  const user = await db.query('SELECT id, email, role FROM users WHERE email = $1', [email]);
+  const user = await db.query(\`SELECT id, email, role, password_hash FROM users WHERE email = '\${email}'\`);
   return res.json({ data: user.rows[0] });
 }
 
+export async function revokeUserSessions(sessionIds: string[], reason: any) {
+  sessionIds.forEach(async (sid) => {
+    await db.query('DELETE FROM active_sessions WHERE session_id = $1', [sid]);
+  });
+  if (reason == "compromised") {
+    console.log("Revoked compromised sessions:", sessionIds);
+  }
+  return { revoked: sessionIds.length };
+}
`,
  },
  {
    id: 'react-billing-hook',
    name: 'Frontend: Billing Status Polling Hook',
    prTitle: 'feat(billing): real-time invoice status polling and receipt preview',
    repository: 'acme-corp/web-dashboard',
    prNumber: 289,
    author: 'sarah-ui',
    description:
      'Adds a React custom hook for invoice polling and HTML receipt rendering (contains timer leak & XSS risk).',
    diff: `diff --git a/src/components/InvoiceStatusBanner.tsx b/src/components/InvoiceStatusBanner.tsx
index 1122334..5566778 100644
--- a/src/components/InvoiceStatusBanner.tsx
+++ b/src/components/InvoiceStatusBanner.tsx
@@ -1,8 +1,26 @@
 import React, { useEffect, useState } from 'react';
 
-export function InvoiceStatusBanner({ invoiceId }: { invoiceId: string }) {
+export function InvoiceStatusBanner({ invoiceId, rawReceiptHtml }: { invoiceId: string; rawReceiptHtml: any }) {
   const [status, setStatus] = useState<string>('pending');
 
+  useEffect(() => {
+    setInterval(async () => {
+      try {
+        const res = await fetch(\`/api/invoices/\${invoiceId}\`);
+        const data = await res.json();
+        setStatus(data.status);
+      } catch (e) {}
+    }, 3000);
+  }, [invoiceId]);
+
   return (
-    <div className="banner">Status: {status}</div>
+    <div className="banner">
+      <span>Status: {status}</span>
+      <div dangerouslySetInnerHTML={{ __html: rawReceiptHtml }} />
+    </div>
   );
 }
`,
  },
  {
    id: 'clean-stream-worker',
    name: 'Core Engine: Batch Telemetry Dispatcher',
    prTitle: 'perf(telemetry): bounded concurrent batch flushing with backpressure',
    repository: 'acme-corp/telemetry-engine',
    prNumber: 315,
    author: 'ElenaR',
    description:
      'A clean, well-typed TypeScript implementation demonstrating OpenRabbit walkthrough diagrams and architectural praise.',
    diff: `diff --git a/src/worker/batch-dispatcher.ts b/src/worker/batch-dispatcher.ts
index 89a1b2c..c4d5e6f 100644
--- a/src/worker/batch-dispatcher.ts
+++ b/src/worker/batch-dispatcher.ts
@@ -4,9 +4,22 @@ export interface TelemetryEvent {
   timestamp: number;
 }
 
-export async function flushEvents(events: TelemetryEvent[]): Promise<number> {
-  return events.length;
+export async function flushEventsBatch(
+  events: readonly TelemetryEvent[],
+  batchSize: number = 50
+): Promise<{ flushed: number; batches: number }> {
+  if (events.length === 0) {
+    return { flushed: 0, batches: 0 };
+  }
+
+  let batches = 0;
+  for (let i = 0; i < events.length; i += batchSize) {
+    const chunk = events.slice(i, i + batchSize);
+    await Promise.all(chunk.map((ev) => Promise.resolve(ev.timestamp)));
+    batches += 1;
+  }
+
+  return { flushed: events.length, batches };
 }
`,
  },
];

export class ReviewStore {
  private filePath: string;
  private reviews: ReviewResult[] = [];
  private initialized = false;

  constructor(storageDir: string = path.join(process.cwd(), 'data')) {
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    this.filePath = path.join(storageDir, 'reviews.json');
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.reviews = parsed;
          return;
        }
      } catch {
        // Re-seed if corrupted
      }
    }

    // Seed with initial sample reviews so the dashboard is immediately rich
    const seeded: ReviewResult[] = [];
    const heuristicConfig = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
    heuristicConfig.llm.provider = 'heuristic';
    heuristicConfig.profile = 'assertive';

    for (let i = 0; i < SAMPLE_DIFF_TEMPLATES.length; i++) {
      const tpl = SAMPLE_DIFF_TEMPLATES[i];
      const rev = await runPullRequestReview({
        rawDiff: tpl.diff,
        prTitle: tpl.prTitle,
        repository: tpl.repository,
        prNumber: tpl.prNumber,
        author: tpl.author,
        source: i === 0 ? 'github' : i === 1 ? 'gitlab' : 'cli',
        config: heuristicConfig,
      });
      seeded.push(rev);
    }

    this.reviews = seeded;
    this.persist();
  }

  public async listReviews(): Promise<ReviewResult[]> {
    await this.init();
    return this.reviews;
  }

  public async getReviewById(id: string): Promise<ReviewResult | undefined> {
    await this.init();
    return this.reviews.find((r) => r.id === id);
  }

  public async addReview(review: ReviewResult): Promise<ReviewResult> {
    await this.init();
    this.reviews.unshift(review);
    if (this.reviews.length > 100) {
      this.reviews = this.reviews.slice(0, 100);
    }
    this.persist();
    return review;
  }

  public async getAnalyticsSummary() {
    await this.init();
    const totalReviews = this.reviews.length;
    const totalFiles = this.reviews.reduce(
      (s, r) => s + r.stats.filesReviewed,
      0
    );
    const totalFindings = this.reviews.reduce(
      (s, r) => s + r.stats.findingsCount,
      0
    );
    const criticalCaught = this.reviews.reduce(
      (s, r) => s + r.stats.criticalCount,
      0
    );
    const warningsCaught = this.reviews.reduce(
      (s, r) => s + r.stats.warningCount,
      0
    );
    const suggestionsMade = this.reviews.reduce(
      (s, r) => s + r.stats.suggestionCount,
      0
    );
    const avgDurationMs =
      totalReviews > 0
        ? Math.round(
            this.reviews.reduce((s, r) => s + r.durationMs, 0) / totalReviews
          )
        : 0;

    const categoryBreakdown: Record<string, number> = {};
    for (const r of this.reviews) {
      for (const f of r.findings) {
        categoryBreakdown[f.category] = (categoryBreakdown[f.category] || 0) + 1;
      }
    }

    return {
      totalReviews,
      totalFiles,
      totalFindings,
      criticalCaught,
      warningsCaught,
      suggestionsMade,
      avgDurationMs,
      estimatedHoursSaved: +(totalReviews * 0.45 + totalFindings * 0.15).toFixed(1),
      categoryBreakdown,
    };
  }

  private persist(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.reviews, null, 2),
        'utf8'
      );
    } catch (err) {
      console.warn('[OpenRabbit] Failed to persist reviews:', err);
    }
  }
}
