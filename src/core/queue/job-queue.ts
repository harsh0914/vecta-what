import crypto from 'crypto';
import { Store, Transaction } from '../ports/store.js';
import { Clock } from '../ports/clock.js';
import { JobKind, JobRecord, JobStatus } from '../types.js';

export function hashIdempotencyKey(key: string): string {
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new Error(`JobQueue: idempotencyKey is required and must be a non-empty string, received: ${key}`);
  }
  return crypto.createHash('sha256').update(key).digest('hex').substring(0, 32);
}

export interface EnqueueJobOptions {
  kind: JobKind;
  merchantId: string;
  payload: any;
  idempotencyKey: string;
  runId?: string;
  nextAttemptAt?: number;
}

export class JobHandle {
  private _isOwned = true;

  constructor(
    public readonly job: JobRecord,
    private readonly queue: JobQueue,
    private readonly clock: Clock
  ) {}

  isOwned(): boolean {
    return this._isOwned;
  }

  markLost(): void {
    this._isOwned = false;
  }

  checkpoint(): void {
    if (!this._isOwned) {
      throw new Error(`Job ${this.job.id} lease was lost; execution stopped at checkpoint`);
    }
  }

  async heartbeat(): Promise<boolean> {
    if (!this._isOwned) return false;
    const success = await this.queue.heartbeat(this);
    if (!success) {
      this._isOwned = false;
    }
    return success;
  }
}

export class JobQueue {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock
  ) {}

  async enqueue(options: EnqueueJobOptions): Promise<JobRecord> {
    if (!options) {
      throw new Error('JobQueue.enqueue: options object is required');
    }
    const key = options.idempotencyKey ?? (options as any).dedupKey;
    if (!key || typeof key !== 'string' || !key.trim()) {
      throw new Error(`JobQueue.enqueue: idempotencyKey is required and must be a non-empty string, received: ${options?.idempotencyKey}`);
    }
    const kind = options.kind ?? (options as any).type;
    if (!kind) {
      throw new Error(`JobQueue.enqueue: kind is required, received: ${options?.kind}`);
    }
    if (!options.merchantId) {
      throw new Error(`JobQueue.enqueue: merchantId is required, received: ${options?.merchantId}`);
    }

    const jobId = hashIdempotencyKey(key);
    const docRef = this.store.doc<JobRecord>('jobs', jobId);

    return this.store.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (snap.exists && snap.data()) {
        return snap.data()!;
      }

      const now = this.clock.now();
      const job: JobRecord = {
        id: jobId,
        kind,
        merchantId: options.merchantId,
        payload: options.payload !== undefined ? options.payload : null,
        idempotencyKey: key,
        status: 'QUEUED',
        attempts: 0,
        leaseUntil: 0,
        nextAttemptAt: options.nextAttemptAt ?? now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      if (options.runId !== undefined) {
        job.runId = options.runId;
      }

      tx.set(docRef, job);
      return job;
    });
  }

  async claim(jobId: string): Promise<JobHandle | null> {
    const docRef = this.store.doc<JobRecord>('jobs', jobId);
    const now = this.clock.now();

    try {
      return await this.store.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists || !snap.data()) {
          return null;
        }

        const job = snap.data()!;

        // Runnable if:
        // (QUEUED or RETRY, and nextAttemptAt <= now) OR
        // (RUNNING and leaseUntil < now)
        const isQueuedOrRetry = (job.status === 'QUEUED' || job.status === 'RETRY') && job.nextAttemptAt <= now;
        const isExpiredRunning = job.status === 'RUNNING' && job.leaseUntil < now;

        if (!isQueuedOrRetry && !isExpiredRunning) {
          return null;
        }

        const newAttempts = job.attempts + 1;
        const updatedJob: JobRecord = {
          ...job,
          status: 'RUNNING',
          attempts: newAttempts,
          leaseUntil: now + 10 * 60 * 1000, // 10 min lease
          updatedAt: now,
        };

        tx.update(docRef, updatedJob);
        return new JobHandle(updatedJob, this, this.clock);
      });
    } catch (err: any) {
      if (err.message && /transaction conflict|concurrent modification/i.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  async heartbeat(handle: JobHandle): Promise<boolean> {
    const docRef = this.store.doc<JobRecord>('jobs', handle.job.id);
    const now = this.clock.now();

    try {
      return await this.store.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists || !snap.data()) {
          return false;
        }

        const current = snap.data()!;
        // Conditional on ownership: (id, RUNNING, attempts)
        if (current.status !== 'RUNNING' || current.attempts !== handle.job.attempts) {
          return false;
        }

        tx.update(docRef, {
          leaseUntil: now + 10 * 60 * 1000,
          updatedAt: now,
        });
        return true;
      });
    } catch {
      return false;
    }
  }

  async complete(handle: JobHandle, result?: any): Promise<boolean> {
    const docRef = this.store.doc<JobRecord>('jobs', handle.job.id);
    const now = this.clock.now();

    return this.store.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists || !snap.data()) {
        return false;
      }

      const current = snap.data()!;
      if (current.status !== 'RUNNING' || current.attempts !== handle.job.attempts) {
        return false;
      }

      tx.update(docRef, {
        status: 'DONE',
        result: result ?? null,
        updatedAt: now,
      });
      return true;
    });
  }

  async yield(handle: JobHandle, payloadPatch?: any): Promise<boolean> {
    const docRef = this.store.doc<JobRecord>('jobs', handle.job.id);
    const now = this.clock.now();

    return this.store.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists || !snap.data()) {
        return false;
      }

      const current = snap.data()!;
      if (current.status !== 'RUNNING' || current.attempts !== handle.job.attempts) {
        return false;
      }

      const updatedPayload = payloadPatch
        ? { ...current.payload, ...payloadPatch }
        : current.payload;

      tx.update(docRef, {
        status: 'QUEUED',
        attempts: Math.max(0, current.attempts - 1), // attempt returned
        nextAttemptAt: now, // runnable now
        payload: updatedPayload,
        updatedAt: now,
      });
      return true;
    });
  }

  async fail(handle: JobHandle, error: any): Promise<boolean> {
    const docRef = this.store.doc<JobRecord>('jobs', handle.job.id);
    const now = this.clock.now();

    return this.store.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists || !snap.data()) {
        return false;
      }

      const current = snap.data()!;
      if (current.status !== 'RUNNING' || current.attempts !== handle.job.attempts) {
        return false;
      }

      const isFatal = error?.fatal === true || current.attempts >= 5;

      if (isFatal) {
        console.log(`[metric] job_dead ${current.id} ${current.kind} ${current.merchantId}`);
        tx.update(docRef, {
          status: 'DEAD',
          lastError: error?.message || String(error),
          updatedAt: now,
        });
      } else {
        const backoffMs = 30 * 1000 * Math.pow(2, current.attempts - 1);
        tx.update(docRef, {
          status: 'RETRY',
          nextAttemptAt: now + backoffMs,
          lastError: error?.message || String(error),
          updatedAt: now,
        });
      }

      return true;
    });
  }

  async replayDead(merchantId?: string): Promise<number> {
    const snap = await this.store.collection<JobRecord>('jobs')
      .where('status', '==', 'DEAD')
      .get();

    const now = this.clock.now();
    let replayed = 0;

    for (const doc of snap.docs) {
      const job = doc.data();
      if (!job) continue;
      if (merchantId && job.merchantId !== merchantId) continue;

      await this.store.runTransaction(async (tx) => {
        const currentSnap = await tx.get(this.store.doc('jobs', doc.id));
        if (currentSnap.exists && currentSnap.data()?.status === 'DEAD') {
          tx.update(this.store.doc('jobs', doc.id), {
            status: 'QUEUED',
            attempts: 0,
            nextAttemptAt: now,
            lastError: null,
            updatedAt: now,
          });
          replayed++;
        }
      });
    }

    return replayed;
  }
}
