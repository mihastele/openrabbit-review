import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OPENRABBIT_CONFIG } from '../config/config-loader.js';
import {
  getRepoMetadata,
  validateGitRepository,
} from '../core/git-utils.js';
import { runPullRequestReview } from '../core/review-engine.js';
import type { LocalRepoInfo, ReviewResult } from '../types/index.js';

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
    name: 'TypeScript: Batch Telemetry Dispatcher',
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
  {
    id: 'python-fastapi-sqli',
    name: 'Python: FastAPI Customer Query & Shell Exporter',
    prTitle: 'feat(api): customer query endpoint and CSV report exporter',
    repository: 'acme-corp/data-service',
    prNumber: 198,
    author: 'guido-py',
    description:
      'Python PR with mutable default arguments, f-string SQL injection, and subprocess shell=True vulnerability.',
    diff: `diff --git a/app/routers/customers.py b/app/routers/customers.py
new file mode 100644
index 0000000..7a8b9c1
--- /dev/null
+++ b/app/routers/customers.py
@@ -0,0 +1,28 @@
+import sqlite3
+import subprocess
+from typing import List, Dict, Any
+
+def get_customers(tenant_id: str, filters: dict = {}) -> List[Dict[str, Any]]:
+    conn = sqlite3.connect("app.db")
+    cursor = conn.cursor()
+    # Raw f-string SQL query
+    query = f"SELECT id, name, email FROM customers WHERE tenant_id = '{tenant_id}'"
+    cursor.execute(query)
+    rows = cursor.fetchall()
+    return [{"id": r[0], "name": r[1], "email": r[2]} for r in rows]
+
+def export_backup_report(output_path: str, table_name: str) -> None:
+    try:
+        cmd = f"sqlite3 app.db .dump {table_name} > {output_path}"
+        subprocess.run(cmd, shell=True, check=True)
+    except:
+        pass
`,
  },
  {
    id: 'go-microservice-leak',
    name: 'Go: Webhook Poller & Database Persister',
    prTitle: 'feat(webhook): ingest incoming webhook and persist payload',
    repository: 'acme-corp/event-streamer',
    prNumber: 224,
    author: 'rob-go',
    description:
      'Go PR with missing defer resp.Body.Close(), fmt.Sprintf SQL query, and ignored error handling.',
    diff: `diff --git a/pkg/crawler/fetcher.go b/pkg/crawler/fetcher.go
new file mode 100644
index 0000000..6b5c4d3
--- /dev/null
+++ b/pkg/crawler/fetcher.go
@@ -0,0 +1,29 @@
+package crawler
+
+import (
+	"database/sql"
+	"encoding/json"
+	"fmt"
+	"net/http"
+)
+
+func FetchAndStoreWebhook(db *sql.DB, targetURL string, eventType string) error {
+	resp, err := http.Get(targetURL)
+	if err != nil {
+		return err
+	}
+	// Missing defer resp.Body.Close()
+
+	var payload map[string]interface{}
+	_ = json.NewDecoder(resp.Body).Decode(&payload)
+
+	// Unsafe SQL format
+	query := fmt.Sprintf("INSERT INTO events (event_type, payload) VALUES ('%s', 'data')", eventType)
+	_, err = db.Exec(query)
+	return err
+}
`,
  },
  {
    id: 'rust-systems-unwrap',
    name: 'Rust: Config Loader & Token Cache',
    prTitle: 'feat(cache): reload cluster configuration and token cache',
    repository: 'acme-corp/edge-proxy',
    prNumber: 367,
    author: 'ferris-rs',
    description:
      'Rust PR with unchecked production .unwrap() calls on I/O operations.',
    diff: `diff --git a/src/config/reader.rs b/src/config/reader.rs
new file mode 100644
index 0000000..3e2d1c0
--- /dev/null
+++ b/src/config/reader.rs
@@ -0,0 +1,21 @@
+use std::fs::File;
+use std::io::Read;
+
+pub fn load_cluster_config(file_path: &str) -> String {
+    // Panic on unwrap in production
+    let mut file = File::open(file_path).unwrap();
+    let mut contents = String::new();
+    file.read_to_string(&mut contents).unwrap();
+    contents
+}
+
+pub fn parse_port(raw: &str) -> u16 {
+    raw.parse::<u16>().unwrap()
+}
`,
  },
  {
    id: 'csharp-aspnet-sqli',
    name: 'C#: Entity Framework Query & Async Void',
    prTitle: 'feat(orders): add customer order repository and cache synchronization',
    repository: 'acme-corp/orders-api',
    prNumber: 412,
    author: 'david-net',
    description:
      'C# PR with FromSqlRaw string interpolation injection and async void method.',
    diff: `diff --git a/src/Repositories/OrderRepository.cs b/src/Repositories/OrderRepository.cs
new file mode 100644
index 0000000..8a9b0c1
--- /dev/null
+++ b/src/Repositories/OrderRepository.cs
@@ -0,0 +1,24 @@
+using System;
+using System.Threading.Tasks;
+using Microsoft.EntityFrameworkCore;
+
+namespace Acme.Repositories;
+
+public class OrderRepository
+{
+    private readonly DbContext _context;
+
+    public async Task<Order> GetOrderAsync(string customerId)
+    {
+        // SQL Injection via string interpolation in FromSqlRaw
+        var query = $"SELECT * FROM Orders WHERE CustomerId = '{customerId}'";
+        return await _context.Orders.FromSqlRaw(query).FirstOrDefaultAsync();
+    }
+
+    public async void SyncOrderCache(string orderId)
+    {
+        // async void crash risk
+        await Task.Delay(100);
+    }
+}
`,
  },
  {
    id: 'cpp-engine-buffer',
    name: 'C++: Network Buffer Decoder & Session Manager',
    prTitle: 'feat(network): packet decoder and session buffer allocator',
    repository: 'acme-corp/engine-core',
    prNumber: 450,
    author: 'alex-cpp',
    description:
      'C++ PR with raw new allocations, unsafe sprintf string operations, and catch-by-value.',
    diff: `diff --git a/src/network/packet_decoder.cpp b/src/network/packet_decoder.cpp
new file mode 100644
index 0000000..9b0c1d2
--- /dev/null
+++ b/src/network/packet_decoder.cpp
@@ -0,0 +1,25 @@
+#include <cstdio>
+#include <stdexcept>
+#include <string>
+
+class PacketDecoder {
+public:
+    void decode_packet(const char* packet_id) {
+        char buffer[64];
+        // Unsafe sprintf buffer overflow
+        sprintf(buffer, "packet_%s_decoded", packet_id);
+
+        // Raw new without smart pointer
+        char* raw_session = new char[1024];
+
+        try {
+            process_buffer(buffer);
+        } catch (std::exception e) {
+            // Object slicing catch-by-value
+        }
+    }
+private:
+    void process_buffer(const char* buf) {}
+};
`,
  },
  {
    id: 'c-crypto-buffer',
    name: 'C: Token Parser & Dynamic Allocator',
    prTitle: 'feat(crypto): token parser and memory allocator',
    repository: 'acme-corp/crypto-native',
    prNumber: 489,
    author: 'dennis-c',
    description:
      'C PR with unsafe strcpy and unchecked malloc allocation.',
    diff: `diff --git a/src/token_parser.c b/src/token_parser.c
new file mode 100644
index 0000000..1d2e3f4
--- /dev/null
+++ b/src/token_parser.c
@@ -0,0 +1,20 @@
+#include <stdlib.h>
+#include <string.h>
+
+char* parse_auth_token(const char* raw_token) {
+    // Unchecked malloc allocation
+    char* token_buf = (char*)malloc(128);
+
+    // Unbounded strcpy
+    strcpy(token_buf, raw_token);
+
+    return token_buf;
+}
`,
  },
  {
    id: 'java-spring-sqli',
    name: 'Java: Billing Service & Raw JDBC Query',
    prTitle: 'feat(billing): invoice query and audit stream processing',
    repository: 'acme-corp/billing-service',
    prNumber: 504,
    author: 'james-java',
    description:
      'Java PR with raw JDBC SQL concatenation and unclosed FileInputStream.',
    diff: `diff --git a/src/main/java/com/acme/billing/InvoiceService.java b/src/main/java/com/acme/billing/InvoiceService.java
new file mode 100644
index 0000000..4b5c6d7
--- /dev/null
+++ b/src/main/java/com/acme/billing/InvoiceService.java
@@ -0,0 +1,24 @@
+package com.acme.billing;
+
+import java.io.FileInputStream;
+import java.sql.Connection;
+import java.sql.ResultSet;
+import java.sql.Statement;
+
+public class InvoiceService {
+    public void findInvoices(Connection conn, String accountId) throws Exception {
+        Statement stmt = conn.createStatement();
+        // SQL Injection via string concatenation
+        ResultSet rs = stmt.executeQuery("SELECT * FROM invoices WHERE account_id = '" + accountId + "'");
+    }
+
+    public void loadAuditLog(String path) throws Exception {
+        // Unclosed stream without try-with-resources
+        FileInputStream fis = new FileInputStream(path);
+        fis.read();
+    }
+}
+`,
  },
  {
    id: 'php-laravel-sqli',
    name: 'PHP: Product Search Controller & Shell Exporter',
    prTitle: 'feat(catalog): product search controller and shell exporter',
    repository: 'acme-corp/shop-backend',
    prNumber: 521,
    author: 'rasmus-php',
    description:
      'PHP PR with PDO query SQL injection, unescaped superglobal echo (XSS), and unescaped exec.',
    diff: `diff --git a/app/Controllers/ProductController.php b/app/Controllers/ProductController.php
new file mode 100644
index 0000000..2e3f4a5
--- /dev/null
+++ b/app/Controllers/ProductController.php
@@ -0,0 +1,24 @@
+<?php
+
+namespace App\\Controllers;
+
+class ProductController {
+    public function searchProducts($pdo, $category) {
+        // Direct string interpolation in PDO query
+        $stmt = $pdo->query("SELECT * FROM products WHERE category = '" . $category . "'");
+        return $stmt->fetchAll();
+    }
+
+    public function exportCatalog($outputName) {
+        // Unescaped command execution
+        exec("tar -czf " . $outputName . " /var/data/catalog");
+    }
+
+    public function renderHeader() {
+        // Direct superglobal echo (XSS)
+        echo "<h1>Search: " . $_GET['q'] . "</h1>";
+    }
+}
`,
  },
  {
    id: 'ruby-rails-sqli',
    name: 'Ruby: Account Lookup & Insecure YAML',
    prTitle: 'feat(accounts): tenant account query and YAML settings loader',
    repository: 'acme-corp/saas-platform',
    prNumber: 563,
    author: 'matz-rb',
    description:
      'Ruby PR with ActiveRecord SQL injection and insecure YAML.load.',
    diff: `diff --git a/app/models/account_finder.rb b/app/models/account_finder.rb
new file mode 100644
index 0000000..3f4a5b6
--- /dev/null
+++ b/app/models/account_finder.rb
@@ -0,0 +1,18 @@
+require 'yaml'
+
+class AccountFinder
+  def self.find_by_tenant(tenant_name)
+    # ActiveRecord SQL injection via interpolation
+    Account.where("tenant_name = '#{tenant_name}'")
+  end
+
+  def self.load_custom_config(raw_yaml)
+    # Insecure deserialization
+    YAML.load(raw_yaml)
+  end
+end
`,
  },
];

export class ReviewStore {
  private filePath: string;
  private reposFilePath: string;
  private reviews: ReviewResult[] = [];
  private repositories: LocalRepoInfo[] = [];
  private initialized = false;

  constructor(storageDir: string = path.join(process.cwd(), 'data')) {
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
    this.filePath = path.join(storageDir, 'reviews.json');
    this.reposFilePath = path.join(storageDir, 'repositories.json');
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Load repositories
    if (fs.existsSync(this.reposFilePath)) {
      try {
        const raw = fs.readFileSync(this.reposFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.repositories = parsed;
        }
      } catch {
        this.repositories = [];
      }
    }

    // Auto-discover workspace repo if repositories list is empty
    if (this.repositories.length === 0) {
      const cwdVal = validateGitRepository(process.cwd());
      if (cwdVal.valid && cwdVal.topLevel) {
        try {
          const meta = getRepoMetadata(cwdVal.topLevel);
          this.repositories.push(meta);
          this.persistRepositories();
        } catch {
          // Ignore
        }
      }
    }

    // Refresh live repo status
    for (let i = 0; i < this.repositories.length; i++) {
      const r = this.repositories[i];
      if (fs.existsSync(r.path)) {
        try {
          const updated = getRepoMetadata(r.path, r.name);
          this.repositories[i] = { ...updated, addedAt: r.addedAt, id: r.id };
        } catch {
          // Keep cached info if git command fails temporarily
        }
      }
    }

    // Load reviews
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

  // =========================================================================
  // Repository Management
  // =========================================================================

  public async listRepositories(): Promise<LocalRepoInfo[]> {
    await this.init();
    return this.repositories;
  }

  public async getRepository(idOrPath: string): Promise<LocalRepoInfo | undefined> {
    await this.init();
    const resolvedPath = path.resolve(idOrPath).replace(/\\/g, '/').toLowerCase();
    return this.repositories.find(
      (r) =>
        r.id === idOrPath ||
        r.path.replace(/\\/g, '/').toLowerCase() === resolvedPath ||
        r.name.toLowerCase() === idOrPath.toLowerCase()
    );
  }

  public async addRepository(repoPath: string, name?: string): Promise<LocalRepoInfo> {
    await this.init();
    const validation = validateGitRepository(repoPath);
    if (!validation.valid || !validation.topLevel) {
      throw new Error(validation.error || `Invalid git repository path: ${repoPath}`);
    }

    const resolved = validation.topLevel;
    const existing = await this.getRepository(resolved);
    if (existing) {
      // Update metadata & name
      const refreshed = getRepoMetadata(resolved, name || existing.name);
      const updated: LocalRepoInfo = {
        ...refreshed,
        id: existing.id,
        addedAt: existing.addedAt,
      };
      const idx = this.repositories.findIndex((r) => r.id === existing.id);
      this.repositories[idx] = updated;
      this.persistRepositories();
      return updated;
    }

    const meta = getRepoMetadata(resolved, name);
    this.repositories.unshift(meta);
    this.persistRepositories();
    return meta;
  }

  public async removeRepository(idOrPath: string): Promise<boolean> {
    await this.init();
    const target = await this.getRepository(idOrPath);
    if (!target) return false;

    this.repositories = this.repositories.filter((r) => r.id !== target.id);
    this.persistRepositories();
    return true;
  }

  public async refreshRepository(idOrPath: string): Promise<LocalRepoInfo | undefined> {
    await this.init();
    const target = await this.getRepository(idOrPath);
    if (!target) return undefined;

    const refreshed = getRepoMetadata(target.path, target.name);
    const updated: LocalRepoInfo = {
      ...refreshed,
      id: target.id,
      addedAt: target.addedAt,
    };
    const idx = this.repositories.findIndex((r) => r.id === target.id);
    this.repositories[idx] = updated;
    this.persistRepositories();
    return updated;
  }

  private persistRepositories(): void {
    try {
      fs.writeFileSync(
        this.reposFilePath,
        JSON.stringify(this.repositories, null, 2),
        'utf8'
      );
    } catch (err) {
      console.warn('[OpenRabbit] Failed to persist repositories:', err);
    }
  }

  // =========================================================================
  // Reviews Management
  // =========================================================================

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
