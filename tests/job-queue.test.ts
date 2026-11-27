import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { JobQueuePersistenceError, ReviewJobQueue, type ReviewJob } from '../src/core/job-queue.js';
import { createOpenRabbitServer } from '../src/server/app.js';
import { ReviewStore, SAMPLE_DIFF_TEMPLATES } from '../src/storage/review-store.js';

function jobStore(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-jobs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'jobs.json');
}

describe('Async Job Queue & Incremental PR Re-Reviews Suite', () => {
  it('deduplicates queued/running jobs by key and retries transient failures', async () => {
    let attempts = 0;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-jq-'));
    const persistPath = path.join(tmpDir, 'jobs.json');

    try {
      const queue = new ReviewJobQueue<{ pr: number }, string>({
        concurrency: 1,
        maxAttempts: 2,
        retryDelayMs: 20,
        persistPath,
        processor: async (job) => {
          attempts++;
          if (attempts === 1) {
            throw new Error('Transient network error');
          }
          await new Promise((r) => setTimeout(r, 15));
          return `ok-pr-${job.payload.pr}`;
        },
      });

      const first = queue.enqueue('repo:pr:1:sha1', { pr: 1 });
      const dup = queue.enqueue('repo:pr:1:sha1', { pr: 1 });
      assert.equal(first.deduplicated, false);
      assert.equal(dup.deduplicated, true);
      assert.equal(dup.job.id, first.job.id);

      await queue.waitForIdle();
      const finished = queue.getJob(first.job.id)!;
      assert.equal(finished.status, 'completed');
      assert.equal(finished.attempts, 2);
      assert.equal(finished.result, 'ok-pr-1');
      assert.ok(fs.existsSync(persistPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deduplicates a completed delivery with the same key', async () => {
    let runs = 0;
    const queue = new ReviewJobQueue<Record<string, never>, string>({
      concurrency: 1,
      processor: async () => {
        runs += 1;
        return 'done';
      },
    });

    const first = queue.enqueue('github:delivery-1', {});
    await queue.waitForIdle();
    const duplicate = queue.enqueue('github:delivery-1', {});

    assert.equal(runs, 1);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.job.id, first.job.id);
    assert.equal(duplicate.job.status, 'completed');
  });

  it('allows a different delivery key to run independently', async () => {
    let runs = 0;
    const queue = new ReviewJobQueue<Record<string, never>, number>({
      concurrency: 1,
      processor: async () => ++runs,
    });

    queue.enqueue('github:delivery-a', {});
    queue.enqueue('github:delivery-b', {});
    await queue.waitForIdle();

    assert.equal(runs, 2);
    assert.equal(queue.listJobs().length, 2);
  });

  it('waits for exponential backoff while allowing independent deliveries', async (t) => {
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
    const persistPath = jobStore(t);
    const attempts: number[] = [];
    const queue = new ReviewJobQueue({
      concurrency: 1,
      maxAttempts: 3,
      retryDelayMs: 20,
      persistPath,
      processor: async (job) => {
        if (job.key === 'retry') {
          attempts.push(Date.now() - start);
          if (job.attempts < 3) throw new Error('Temporary failure');
        }
        return 'done';
      },
    });

    const { job } = queue.enqueue('retry', {});
    await setImmediate();
    assert.deepEqual(attempts, [0]);
    assert.equal(job.status, 'queued');
    const [saved] = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    assert.equal(saved.nextAttemptAt, new Date(start + 20).toISOString());

    const { job: other } = queue.enqueue('independent', {});
    await setImmediate();
    assert.equal(other.status, 'completed');
    t.mock.timers.tick(19);
    await setImmediate();
    assert.deepEqual(attempts, [0]);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.deepEqual(attempts, [0, 20]);
    t.mock.timers.tick(39);
    await setImmediate();
    assert.deepEqual(attempts, [0, 20]);
    t.mock.timers.tick(1);
    await queue.waitForIdle();
    assert.deepEqual(attempts, [0, 20, 60]);
    assert.equal(job.status, 'completed');
    assert.equal(job.nextAttemptAt, undefined);
  });

  it('resumes saved work on startup while preserving retry schedules and attempt limits', async (t) => {
    const start = new Date('2026-01-01T00:00:00Z').getTime();
    const timestamp = new Date(start).toISOString();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
    const persistPath = jobStore(t);
    const createJob = (id: string, status: ReviewJob['status'], attempts: number): ReviewJob => ({
      id, key: id, status, attempts, maxAttempts: 2,
      createdAt: timestamp, updatedAt: timestamp, payload: {},
    });
    fs.writeFileSync(persistPath, JSON.stringify([
      createJob('exhausted', 'running', 2),
      { ...createJob('scheduled', 'queued', 1), nextAttemptAt: new Date(start + 50).toISOString() },
      createJob('interrupted', 'running', 1),
      createJob('queued', 'queued', 0),
    ]));

    const processed: string[] = [];
    const queue = new ReviewJobQueue({
      concurrency: 1,
      persistPath,
      processor: async (job) => { processed.push(job.id); },
    });
    await setImmediate();
    assert.deepEqual(processed, ['queued', 'interrupted']);
    assert.equal(queue.getJob('interrupted')?.attempts, 2);
    assert.equal(queue.getJob('exhausted')?.status, 'failed');
    assert.match(queue.getJob('exhausted')?.error ?? '', /interrupted/);
    assert.equal(queue.getJob('scheduled')?.status, 'queued');

    t.mock.timers.tick(49);
    await setImmediate();
    assert.equal(queue.getJob('scheduled')?.attempts, 1);
    t.mock.timers.tick(1);
    await queue.waitForIdle();
    assert.deepEqual(processed, ['queued', 'interrupted', 'scheduled']);
    assert.equal(queue.getJob('scheduled')?.attempts, 2);
    assert.equal(queue.getJob('scheduled')?.status, 'completed');
  });

  it('keeps a backlog larger than 200 and prunes only finished history', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const processed: number[] = [];
    const queue = new ReviewJobQueue<number>({
      concurrency: 1,
      processor: async (job) => {
        await gate;
        processed.push(job.payload);
      },
    });
    const payloads = Array.from({ length: 205 }, (_, index) => index);
    const jobs = payloads.map((payload) => queue.enqueue(String(payload), payload).job);
    assert.equal(queue.listJobs(300).length, 205);
    assert.equal(queue.getJob(jobs[0].id)?.status, 'running');
    assert.equal(queue.getJob(jobs[1].id)?.status, 'queued');
    release();
    await queue.waitForIdle();
    assert.deepEqual(processed, payloads);
    assert.equal(queue.listJobs(300).length, 200);
    assert.equal(queue.getJob(jobs[204].id)?.status, 'completed');
  });

  it('reports unreadable queue contents and preserves the file', (t) => {
    const persistPath = jobStore(t);
    fs.writeFileSync(persistPath, '[{');
    assert.throws(() => new ReviewJobQueue({
      persistPath,
      processor: async () => {},
    }), JobQueuePersistenceError);
    assert.equal(fs.readFileSync(persistPath, 'utf8'), '[{');
  });

  it('tracks PR review state and resolves incremental commit-range diffs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-inc-'));
    const repoDir = path.join(tmpDir, 'repo');
    const storageDir = path.join(tmpDir, 'data');
    fs.mkdirSync(repoDir, { recursive: true });

    try {
      execFileSync('git', ['init'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: repoDir });

      fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export const a = 1;\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'feat: initial'], { cwd: repoDir });
      const sha1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

      fs.writeFileSync(path.join(repoDir, 'b.ts'), 'export const b = 2;\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'feat: second commit'], { cwd: repoDir });
      const sha2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

      const store = new ReviewStore(storageDir);
      await store.init();

      const noneYet = await store.resolveIncrementalDiff(repoDir, 'acme/repo', 42, sha1);
      assert.equal(noneYet.incremental, false);
      assert.equal((noneYet as any).reason, 'no_prior_review');

      await store.upsertPRReviewState({
        repository: 'acme/repo',
        prNumber: 42,
        lastReviewedSha: sha1,
        lastReviewId: 'rev-1',
      });

      const sameSha = await store.resolveIncrementalDiff(repoDir, 'acme/repo', 42, sha1);
      assert.equal(sameSha.incremental, false);
      assert.equal((sameSha as any).reason, 'already_reviewed_sha');

      const inc = await store.resolveIncrementalDiff(repoDir, 'acme/repo', 42, sha2);
      assert.equal(inc.incremental, true);
      if (inc.incremental) {
        assert.equal(inc.baseSha, sha1);
        assert.equal(inc.headSha, sha2);
        assert.equal(inc.commitCount, 1);
        assert.ok(inc.diff.includes('b.ts'));
        assert.ok(!inc.diff.includes('a.ts'));
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('acknowledges async webhooks only after saving and allows redelivery on storage failure', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-srv-jq-'));
    const serverInstance = await createOpenRabbitServer({
      port: 0,
      storageDir: tmpDir,
    });

    try {
      const baseUrl = `http://localhost:${serverInstance.port}`;
      const submitWebhook = () => fetch(`${baseUrl}/api/webhooks/github?async=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Delivery': 'storage-recovery-test',
          'X-GitHub-Event': 'pull_request',
        },
        body: JSON.stringify({
          action: 'synchronize',
          number: 88,
          repository: { full_name: 'acme/async-repo' },
          pull_request: {
            number: 88,
            title: 'feat: async webhook test',
            head: { sha: 'deadbeef1234' },
          },
          simulated_diff: SAMPLE_DIFF_TEMPLATES[0].diff,
        }),
      });

      const persistPath = path.join(tmpDir, 'jobs.json');
      fs.mkdirSync(persistPath);
      const unavailable = await submitWebhook();
      assert.equal(unavailable.status, 503);
      assert.match((await unavailable.json()).error, /Redeliver/);
      assert.deepEqual(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.tmp')), []);
      fs.rmdirSync(persistPath);

      const res = await submitWebhook();
      assert.equal(res.status, 202);
      const accepted = (await res.json()) as { accepted: boolean; jobId: string; deduplicated: boolean };
      assert.equal(accepted.accepted, true);
      assert.equal(accepted.deduplicated, false);
      const [saved] = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      assert.equal(saved.id, accepted.jobId);

      // Poll until job completes
      let jobData: any;
      for (let i = 0; i < 40; i++) {
        const poll = await fetch(`${baseUrl}/api/jobs/${accepted.jobId}`).then((r) => r.json()) as { job: any };
        jobData = poll.job;
        if (jobData.status === 'completed' || jobData.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.equal(jobData.status, 'completed');
      assert.equal(jobData.result.handled, true);
      assert.ok(jobData.result.reviewResult.findings.length > 0);

      const listRes = await fetch(`${baseUrl}/api/jobs`).then((r) => r.json()) as { jobs: any[] };
      assert.ok(listRes.jobs.some((j) => j.id === accepted.jobId));
    } finally {
      await serverInstance.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
