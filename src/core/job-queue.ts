import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ReviewJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ReviewJob<TPayload = unknown, TResult = unknown> {
  id: string;
  key: string;
  status: ReviewJobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  nextAttemptAt?: string;
  completedAt?: string;
  error?: string;
  payload: TPayload;
  result?: TResult;
}

export interface ReviewJobQueueOptions<TPayload, TResult> {
  concurrency?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  persistPath?: string;
  processor: (job: ReviewJob<TPayload, TResult>) => Promise<TResult>;
}

export class JobQueuePersistenceError extends Error {}

const HISTORY_LIMIT = 200;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function isPending(status: ReviewJobStatus): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * Lightweight persistent async job queue with bounded concurrency,
 * key-based deduplication, and exponential-backoff retries.
 */
export class ReviewJobQueue<TPayload = unknown, TResult = unknown> {
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly persistPath?: string;
  private readonly processor: (job: ReviewJob<TPayload, TResult>) => Promise<TResult>;

  private jobs: ReviewJob<TPayload, TResult>[] = [];
  private activeCount = 0;
  private retryTimer?: NodeJS.Timeout;
  private idleResolvers: Array<() => void> = [];

  constructor(options: ReviewJobQueueOptions<TPayload, TResult>) {
    this.concurrency = Math.max(1, Math.ceil(options.concurrency ?? 2));
    this.maxAttempts = Math.max(1, Math.ceil(options.maxAttempts ?? 2));
    const delay = options.retryDelayMs ?? 250;
    this.retryDelayMs = Number.isFinite(delay) ? Math.max(0, delay) : 250;
    this.persistPath = options.persistPath;
    this.processor = options.processor;
    this.loadFromDisk();
    if (this.jobs.some((job) => isPending(job.status))) {
      queueMicrotask(() => this.drain());
    }
  }

  public enqueue(
    key: string,
    payload: TPayload
  ): { job: ReviewJob<TPayload, TResult>; deduplicated: boolean } {
    const existing = this.jobs.find(
      (j) => j.key === key && j.status !== 'failed'
    );
    if (existing) {
      return { job: existing, deduplicated: true };
    }

    const now = new Date().toISOString();
    const job: ReviewJob<TPayload, TResult> = {
      id: `job-${crypto.randomUUID()}`,
      key,
      status: 'queued',
      attempts: 0,
      maxAttempts: this.maxAttempts,
      createdAt: now,
      updatedAt: now,
      payload,
    };

    const jobs = [job, ...this.jobs];
    this.persistToDisk(jobs);
    this.jobs = jobs;
    this.drain();
    return { job, deduplicated: false };
  }

  public getJob(id: string): ReviewJob<TPayload, TResult> | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  public listJobs(limit: number = 50): ReviewJob<TPayload, TResult>[] {
    return this.jobs.slice(0, limit);
  }

  public waitForIdle(): Promise<void> {
    const hasPending = this.jobs.some((job) => isPending(job.status));
    if (!hasPending && this.activeCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private drain(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    while (this.activeCount < this.concurrency) {
      const now = Date.now();
      let next: ReviewJob<TPayload, TResult> | undefined;
      let earliestRetry = Infinity;
      // Pick the oldest job eligible to run.
      for (let i = this.jobs.length - 1; i >= 0; i--) {
        const job = this.jobs[i];
        if (job.status !== 'queued') continue;
        const readyAt = job.nextAttemptAt ? Date.parse(job.nextAttemptAt) : now;
        if (readyAt <= now) {
          next = job;
          break;
        }
        earliestRetry = Math.min(earliestRetry, readyAt);
      }
      if (!next) {
        if (Number.isFinite(earliestRetry)) {
          const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliestRetry - Date.now()));
          this.retryTimer = setTimeout(() => this.drain(), delay);
        }
        break;
      }
      void this.runJob(next);
    }
    this.checkIdle();
  }

  private async runJob(job: ReviewJob<TPayload, TResult>): Promise<void> {
    this.activeCount++;
    job.status = 'running';
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    job.startedAt ??= job.updatedAt;
    job.nextAttemptAt = undefined;
    this.saveProgress();

    try {
      job.result = await Promise.resolve().then(() => this.processor(job));
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.error = undefined;
    } catch (error) {
      const now = Date.now();
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date(now).toISOString();
      if (job.attempts < job.maxAttempts) {
        const delay = this.retryDelayMs === 0 ? 0
          : Math.min(MAX_TIMER_DELAY_MS, this.retryDelayMs * 2 ** (job.attempts - 1));
        job.status = 'queued';
        job.nextAttemptAt = new Date(now + delay).toISOString();
      } else {
        job.status = 'failed';
        job.completedAt = job.updatedAt;
      }
    } finally {
      this.pruneHistory();
      this.saveProgress();
      this.activeCount--;
      this.drain();
    }
  }

  private checkIdle(): void {
    const hasPending = this.jobs.some((job) => isPending(job.status));
    if (!hasPending && this.activeCount === 0 && this.idleResolvers.length > 0) {
      const resolvers = this.idleResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  private pruneHistory(): void {
    let finished = 0;
    this.jobs = this.jobs.filter((job) => isPending(job.status) || ++finished <= HISTORY_LIMIT);
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((job) =>
        !job || typeof job.id !== 'string' || typeof job.key !== 'string' ||
        !['queued', 'running', 'completed', 'failed'].includes(job.status) ||
        !Number.isInteger(job.attempts) || job.attempts < 0 ||
        !Number.isFinite(job.maxAttempts) || job.maxAttempts < 1 ||
        (job.nextAttemptAt !== undefined &&
          (typeof job.nextAttemptAt !== 'string' || !Number.isFinite(Date.parse(job.nextAttemptAt))))
      )) {
        throw new Error('Invalid saved job records.');
      }
      this.jobs = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new JobQueuePersistenceError('Could not load the webhook job queue.', { cause: error });
    }

    const now = new Date().toISOString();
    let recovered = false;
    for (const job of this.jobs) {
      if (!isPending(job.status)) continue;
      if (job.attempts >= job.maxAttempts) {
        job.status = 'failed';
        job.updatedAt = now;
        job.completedAt = now;
        job.nextAttemptAt = undefined;
        job.error = 'Review was interrupted after using its allowed attempts.';
        recovered = true;
      } else if (job.status === 'running') {
        job.status = 'queued';
        job.updatedAt = now;
        job.nextAttemptAt = undefined;
        recovered = true;
      }
    }
    const count = this.jobs.length;
    this.pruneHistory();
    if (recovered || this.jobs.length !== count) this.persistToDisk(this.jobs);
  }

  private saveProgress(): void {
    try {
      this.persistToDisk(this.jobs);
    } catch (error) {
      // A checkpoint failure must not cause a successful processor to be retried.
      console.error('[OpenRabbit] Failed to checkpoint webhook job progress:', error);
    }
  }

  private persistToDisk(jobs: ReviewJob<TPayload, TResult>[]): void {
    if (!this.persistPath) return;
    const tempPath = `${this.persistPath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const file = fs.openSync(tempPath, 'wx', 0o600);
      try {
        fs.writeFileSync(file, JSON.stringify(jobs, null, 2), 'utf8');
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      fs.renameSync(tempPath, this.persistPath);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Preserve the original storage error.
      }
      throw new JobQueuePersistenceError('Could not persist the webhook job queue.', { cause: error });
    }
  }
}
