import { Store } from '../ports/store.js';
import { Clock } from '../ports/clock.js';
import { JobQueue } from './job-queue.js';
import { InboxRecord } from '../types.js';

export type CustomInboxHandler = (event: InboxRecord) => Promise<void>;

export class InboxConsumer {
  private unsubscribeListener?: () => void;
  private sweepTimer?: any;
  private isRunning = false;
  private customHandlers = new Map<string, CustomInboxHandler>();
  private lastSweepError: string | null = null;
  private lastListenerError: string | null = null;
  private sweepBackoffMs = 60 * 1000;

  constructor(
    private readonly store: Store,
    private readonly queue: JobQueue,
    private readonly clock: Clock
  ) {}

  setCustomHandler(type: string, handler: CustomInboxHandler): void {
    this.customHandlers.set(type, handler);
  }

  async processInboxEvent(inboxId: string): Promise<void> {
    const docRef = this.store.doc<InboxRecord>('inbox', inboxId);

    const snap = await docRef.get();
    if (!snap.exists || !snap.data()) {
      return;
    }

    const event = snap.data()!;
    if (event.status !== 'NEW') {
      return;
    }

    try {
      // In a transaction: process event, create jobs, and mark DONE
      await this.store.runTransaction(async (tx) => {
        const txSnap = await tx.get(docRef);
        if (!txSnap.exists || txSnap.data()?.status !== 'NEW') {
          return;
        }

        const currentEvent = txSnap.data()!;

        const custom = this.customHandlers.get(currentEvent.type);
        if (custom) {
          await custom(currentEvent);
        } else {
          await this.defaultHandleEvent(currentEvent);
        }

        tx.update(docRef, {
          status: 'DONE',
        });
      });
    } catch (err: any) {
      const attempts = (event.attempts || 0) + 1;
      const isDead = attempts >= 5;

      await docRef.update({
        attempts,
        status: isDead ? 'FAILED' : 'NEW',
      });
    }
  }

  private async defaultHandleEvent(event: InboxRecord): Promise<void> {
    if (event.type === 'installed') {
      const mid = event.merchantId;
      const installedAt = event.body?.installedAt || event.createdAt || this.clock.now();
      const idempotencyKey = event.key?.startsWith('snapshot:')
        ? event.key
        : `snapshot:${mid}:${installedAt}`;
      await this.queue.enqueue({
        kind: 'SNAPSHOT',
        merchantId: mid,
        payload: { kind: 'snapshot', merchantId: mid, installedAt },
        idempotencyKey,
      });
    } else if (event.type === 'clover_webhook') {
      const body = event.body || {};
      const merchants = body.merchants || {};

      for (const [mid, updates] of Object.entries<any[]>(merchants)) {
        for (const update of updates) {
          const objectId = update.objectId || '';
          const parts = objectId.split(':');
          const family = parts[0];
          const rawId = parts[1] || objectId;
          const ts = update.ts || this.clock.now();

          if (family === 'I' || family === 'IS' || family === 'IA') {
            await this.queue.enqueue({
              kind: 'SYNC_ITEM',
              merchantId: mid,
              payload: { itemId: rawId, family },
              idempotencyKey: `wh:${family}:${mid}:${objectId}:${ts}`,
            });
          } else if (family === 'IC' || family === 'IG' || family === 'IM') {
            await this.queue.enqueue({
              kind: 'SNAPSHOT',
              merchantId: mid,
              payload: { kind: 'full', merchantId: mid },
              idempotencyKey: `wh:reconcile:${family}:${mid}:${ts}`,
            });
          }
        }
      }
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Real-time listener on inbox where status == 'NEW'
    this.unsubscribeListener = this.store.collection<InboxRecord>('inbox')
      .where('status', '==', 'NEW')
      .onSnapshot(
        (snap) => {
          this.lastListenerError = null;
          for (const doc of snap.docs) {
            this.processInboxEvent(doc.id).catch((err) => {
              console.error(`Error processing inbox event ${doc.id}:`, err);
            });
          }
        },
        (err) => {
          const msg = err.message || String(err);
          if (msg !== this.lastListenerError) {
            this.lastListenerError = msg;
            console.error('[inbox-listener] Error in inbox snapshot listener:', err);
          }
        }
      );

    // Initial scheduled sweep with exponential backoff
    this.scheduleNextSweep(this.sweepBackoffMs);
  }

  private scheduleNextSweep(delayMs: number): void {
    if (!this.isRunning) return;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
    }
    this.sweepTimer = setTimeout(async () => {
      try {
        await this.sweep();
        this.sweepBackoffMs = 60 * 1000;
        this.lastSweepError = null;
        this.scheduleNextSweep(this.sweepBackoffMs);
      } catch (err: any) {
        const msg = err.message || String(err);
        if (msg !== this.lastSweepError) {
          this.lastSweepError = msg;
          console.error('[inbox-sweep] Error in inbox sweep:', err);
        }
        // Exponential backoff capped at 5 minutes
        this.sweepBackoffMs = Math.min(this.sweepBackoffMs * 2, 5 * 60 * 1000);
        this.scheduleNextSweep(this.sweepBackoffMs);
      }
    }, delayMs);
  }

  async sweep(): Promise<void> {
    const snap = await this.store.collection<InboxRecord>('inbox')
      .where('status', '==', 'NEW')
      .get();

    for (const doc of snap.docs) {
      await this.processInboxEvent(doc.id);
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.unsubscribeListener) {
      this.unsubscribeListener();
      this.unsubscribeListener = undefined;
    }
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
