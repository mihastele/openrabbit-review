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
  private idleResolvers: Array<() => void> = [];

  constructor(options: ReviewJobQueueOptions<TPayload, TResult>) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    this.persistPath = options.persistPath;
    this.processor = options.processor;
    this.loadFromDisk();
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
      id: `job-${crypto.randomUUID().slice(0, 8)}`,
      key,
      status: 'queued',
      attempts: 0,
      maxAttempts: this.maxAttempts,
      createdAt: now,
      updatedAt: now,
      payload,
    };

    this.jobs.unshift(job);
    if (this.jobs.length > 200) {
      this.jobs = this.jobs.slice(0, 200);
    }
    this.persistToDisk();
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
    const hasPending = this.jobs.some(
      (j) => j.status === 'queued' || j.status === 'running'
    );
    if (!hasPending && this.activeCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private drain(): void {
    while (this.activeCount < this.concurrency) {
      // Oldest queued job first (since jobs are unshifted)
      const next = [...this.jobs].reverse().find((j) => j.status === 'queued');
      if (!next) break;
      this.runJob(next);
    }
    this.checkIdle();
  }

  private runJob(job: ReviewJob<TPayload, TResult>): void {
    this.activeCount++;
    job.status = 'running';
    job.attempts += 1;
    job.startedAt = job.startedAt || new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    this.persistToDisk();

    this.processor(job)
      .then((result) => {
        job.status = 'completed';
        job.result = result;
        job.completedAt = new Date().toISOString();
        job.updatedAt = job.completedAt;
        job.error = undefined;
        this.persistToDisk();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        job.error = message;
        job.updatedAt = new Date().toISOString();
        if (job.attempts < job.maxAttempts) {
          job.status = 'queued';
          this.persistToDisk();
          const delay = this.retryDelayMs * Math.pow(2, job.attempts - 1);
          setTimeout(() => this.drain(), delay);
          return;
        }
        job.status = 'failed';
        job.completedAt = job.updatedAt;
        this.persistToDisk();
      })
      .finally(() => {
        this.activeCount--;
        this.drain();
      });
  }

  private checkIdle(): void {
    const hasPending = this.jobs.some(
      (j) => j.status === 'queued' || j.status === 'running'
    );
    if (!hasPending && this.activeCount === 0 && this.idleResolvers.length > 0) {
      const resolvers = this.idleResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.jobs = parsed.map((j: ReviewJob<TPayload, TResult>) =>
          j.status === 'running' ? { ...j, status: 'queued' } : j
        );
      }
    } catch {
      // Ignore corrupt job store on startup
    }
  }

  private persistToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(this.jobs, null, 2), 'utf8');
    } catch {
      // Non-fatal persistence error
    }
  }
}
