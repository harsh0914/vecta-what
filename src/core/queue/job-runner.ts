import { Store } from '../ports/store.js';
import { Clock } from '../ports/clock.js';
import { JobHandle, JobQueue } from './job-queue.js';
import { JobKind, JobRecord } from '../types.js';

export type JobHandler = (payload: any, handle: JobHandle) => Promise<any>;

export interface JobRunnerOptions {
  queue: JobQueue;
  store: Store;
  clock: Clock;
  concurrency?: number;
  handlers?: Partial<Record<JobKind, JobHandler>>;
}

export class JobRunner {
  private queue: JobQueue;
  private store: Store;
  private clock: Clock;
  private concurrency: number;
  private handlers = new Map<JobKind, JobHandler>();

  private activeJobs = new Set<string>();
  private unsubscribeListener?: () => void;
  private maintenanceTimer?: any;
  private isRunning = false;
  private lastMaintenanceError: string | null = null;
  private lastListenerError: string | null = null;
  private maintenanceBackoffMs = 60 * 1000;

  constructor(options: JobRunnerOptions) {
    this.queue = options.queue;
    this.store = options.store;
    this.clock = options.clock;
    this.concurrency = options.concurrency ?? 4;

    if (options.handlers) {
      for (const [kind, handler] of Object.entries(options.handlers)) {
        if (handler) {
          this.handlers.set(kind as JobKind, handler);
        }
      }
    }
  }

  registerHandler(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  isListening(): boolean {
    return this.isRunning;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Real-time listener on QUEUED jobs
    this.unsubscribeListener = this.store.collection<JobRecord>('jobs')
      .where('status', '==', 'QUEUED')
      .onSnapshot(
        (snap) => {
          this.lastListenerError = null;
          for (const doc of snap.docs) {
            this.tryRunJob(doc.id).catch((err) => {
              console.error(`Error attempting to run job ${doc.id}:`, err);
            });
          }
        },
        (err) => {
          const msg = err.message || String(err);
          if (msg !== this.lastListenerError) {
            this.lastListenerError = msg;
            console.error('[job-listener] Error in jobs snapshot listener:', err);
          }
        }
      );

    // Initial scheduled maintenance sweep with exponential backoff
    this.scheduleNextMaintenance(this.maintenanceBackoffMs);
  }

  private scheduleNextMaintenance(delayMs: number): void {
    if (!this.isRunning) return;
    if (this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer);
    }
    this.maintenanceTimer = setTimeout(async () => {
      try {
        await this.runMaintenance();
        this.maintenanceBackoffMs = 60 * 1000;
        this.lastMaintenanceError = null;
        this.scheduleNextMaintenance(this.maintenanceBackoffMs);
      } catch (err: any) {
        const msg = err.message || String(err);
        if (msg !== this.lastMaintenanceError) {
          this.lastMaintenanceError = msg;
          console.error('[job-maintenance] Error in job runner maintenance sweep:', err);
        }
        // Exponential backoff capped at 5 minutes
        this.maintenanceBackoffMs = Math.min(this.maintenanceBackoffMs * 2, 5 * 60 * 1000);
        this.scheduleNextMaintenance(this.maintenanceBackoffMs);
      }
    }, delayMs);
  }

  async runMaintenance(): Promise<void> {
    if (!this.isRunning) return;

    const now = this.clock.now();

    // 1. Due RETRY jobs
    const retrySnap = await this.store.collection<JobRecord>('jobs')
      .where('status', '==', 'RETRY')
      .where('nextAttemptAt', '<=', now)
      .limit(10)
      .get();

    for (const doc of retrySnap.docs) {
      await this.tryRunJob(doc.id);
    }

    // 2. Expired RUNNING jobs
    const expiredSnap = await this.store.collection<JobRecord>('jobs')
      .where('status', '==', 'RUNNING')
      .where('leaseUntil', '<', now)
      .limit(10)
      .get();

    for (const doc of expiredSnap.docs) {
      await this.tryRunJob(doc.id);
    }
  }

  private async tryRunJob(jobId: string): Promise<void> {
    if (!this.isRunning) return;
    if (this.activeJobs.size >= this.concurrency) {
      return;
    }
    if (this.activeJobs.has(jobId)) {
      return;
    }

    const handle = await this.queue.claim(jobId);
    if (!handle) {
      return;
    }

    this.activeJobs.add(jobId);
    this.executeJob(handle).finally(() => {
      this.activeJobs.delete(jobId);
    });
  }

  private async executeJob(handle: JobHandle): Promise<void> {
    const handler = this.handlers.get(handle.job.kind);
    if (!handler) {
      console.warn(`No handler registered for job kind: ${handle.job.kind}`);
      await this.queue.fail(handle, new Error(`No handler for job kind ${handle.job.kind}`));
      return;
    }

    // Background heartbeat timer every 60s
    const heartbeatInterval = setInterval(async () => {
      if (!handle.isOwned()) {
        clearInterval(heartbeatInterval);
        return;
      }
      const renewed = await handle.heartbeat();
      if (!renewed) {
        clearInterval(heartbeatInterval);
      }
    }, 60 * 1000);

    try {
      const result = await handler(handle.job.payload, handle);
      if (handle.isOwned()) {
        await this.queue.complete(handle, result);
      }
    } catch (err: any) {
      if (handle.isOwned()) {
        await this.queue.fail(handle, err);
      }
    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.unsubscribeListener) {
      this.unsubscribeListener();
      this.unsubscribeListener = undefined;
    }
    if (this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
  }
}
