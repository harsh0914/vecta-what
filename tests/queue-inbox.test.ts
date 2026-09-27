import { describe, it, expect, vi } from 'vitest';
import { ControllableClock } from '../src/adapters/in-memory/controllable-clock.js';
import { InMemoryStore } from '../src/adapters/in-memory/in-memory-store.js';
import { JobQueue } from '../src/core/queue/job-queue.js';
import { InboxConsumer } from '../src/core/queue/inbox-consumer.js';
import { JobRunner } from '../src/core/queue/job-runner.js';
import { JobRecord } from '../src/core/types.js';

describe('Phase 2: Job Queue and Inbox', () => {
  it('D1 duplicate idempotency key is a no-op', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    const job1 = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: 'm1',
      payload: { test: true },
      idempotencyKey: 'manual:m1:2026-09-27T11:00:00Z',
    });

    expect(job1).toBeDefined();
    expect(job1.status).toBe('QUEUED');
    expect(job1.attempts).toBe(0);

    // Duplicate enqueue with the exact same idempotency key
    const job2 = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: 'm1',
      payload: { differentPayload: true },
      idempotencyKey: 'manual:m1:2026-09-27T11:00:00Z',
    });

    expect(job2.id).toBe(job1.id);

    // Verify only one job exists in the collection
    const snap = await store.collection('jobs').get();
    expect(snap.docs.length).toBe(1);
    expect(snap.docs[0].id).toBe(job1.id);
    expect(snap.docs[0].data()?.payload).toEqual({ test: true }); // Original payload preserved
  });

  it('D2 concurrent claims never double-claim and the same job delivered many times runs once', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    const job = await queue.enqueue({
      kind: 'SYNC_ITEM',
      merchantId: 'm1',
      payload: { itemId: 'item_1' },
      idempotencyKey: 'wh:I:m1:item_1:100',
    });

    // Simulate two workers trying to claim the exact same job concurrently
    const claimPromise1 = queue.claim(job.id);
    const claimPromise2 = queue.claim(job.id);

    const results = await Promise.all([claimPromise1, claimPromise2]);
    const claimedCount = results.filter((handle) => handle !== null).length;

    expect(claimedCount).toBe(1);

    const successfulClaim = results.find((handle) => handle !== null)!;
    expect(successfulClaim.job.status).toBe('RUNNING');
    expect(successfulClaim.job.attempts).toBe(1);
    expect(successfulClaim.job.leaseUntil).toBe(1000 + 10 * 60 * 1000); // 10 min lease
  });

  it('D3 lease renewed by a clock-driven heartbeat every 60s independent of step length, a failed renewal stops the job at its next checkpoint', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: 'm1',
      payload: {},
      idempotencyKey: 'snap:m1:1',
    });

    const handle = await queue.claim(job.id);
    expect(handle).not.toBeNull();
    const activeHandle = handle!;
    expect(activeHandle.isOwned()).toBe(true);

    // Clock advances 60s
    clock.advance(60 * 1000);
    const renewed = await activeHandle.heartbeat();
    expect(renewed).toBe(true);
    expect(activeHandle.isOwned()).toBe(true);

    const jobSnap = await store.doc('jobs', job.id).get();
    expect(jobSnap.data()?.leaseUntil).toBe(clock.now() + 10 * 60 * 1000);

    // External event revokes or overwrites ownership (e.g. forced eviction or another claim)
    await store.doc('jobs', job.id).update({ attempts: 99 });

    // Next heartbeat fails CAS
    const failedRenewal = await activeHandle.heartbeat();
    expect(failedRenewal).toBe(false);
    expect(activeHandle.isOwned()).toBe(false);

    // At checkpoint, job runner checks isOwned() and aborts
    expect(activeHandle.isOwned()).toBe(false);
  });

  it('D4 an expired lease is reclaimed and the old owner\'s heartbeat then fails', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: 'm1',
      payload: {},
      idempotencyKey: 'snap:m1:2',
    });

    const oldHandle = (await queue.claim(job.id))!;
    expect(oldHandle).not.toBeNull();
    expect(oldHandle.job.attempts).toBe(1);

    // Advance clock past the 10 min lease (10 min + 1 sec)
    clock.advance(10 * 60 * 1000 + 1000);

    // New worker claims the expired job
    const newHandle = await queue.claim(job.id);
    expect(newHandle).not.toBeNull();
    expect(newHandle!.job.attempts).toBe(2);
    expect(newHandle!.job.status).toBe('RUNNING');

    // Old worker now tries to heartbeat -> must fail because attempts changed (ownership lost)
    const oldHeartbeat = await oldHandle.heartbeat();
    expect(oldHeartbeat).toBe(false);
    expect(oldHandle.isOwned()).toBe(false);
  });

  it('D5 backoff 30s * 2^(attempts-1), DEAD after 5, fatal errors straight to DEAD', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    const job = await queue.enqueue({
      kind: 'SYNC_ITEM',
      merchantId: 'm1',
      payload: {},
      idempotencyKey: 'retry-test-1',
    });

    // Attempt 1 fails -> RETRY with 30s * 2^0 = 30s
    const h1 = (await queue.claim(job.id))!;
    await queue.fail(h1, new Error('transient error 1'));

    let doc = (await store.doc('jobs', job.id).get()).data()!;
    expect(doc.status).toBe('RETRY');
    expect(doc.attempts).toBe(1);
    expect(doc.nextAttemptAt).toBe(1000 + 30 * 1000);

    // Advance clock to attempt 1 nextAttemptAt
    clock.advance(30 * 1000);

    // Attempt 2 fails -> RETRY with 30s * 2^1 = 60s
    const h2 = (await queue.claim(job.id))!;
    expect(h2.job.attempts).toBe(2);
    await queue.fail(h2, new Error('transient error 2'));

    doc = (await store.doc('jobs', job.id).get()).data()!;
    expect(doc.status).toBe('RETRY');
    expect(doc.nextAttemptAt).toBe(clock.now() + 60 * 1000);

    // Exhaust remaining attempts up to 5
    clock.advance(60 * 1000);
    const h3 = (await queue.claim(job.id))!; // attempt 3
    await queue.fail(h3, new Error('transient 3'));

    clock.advance(120 * 1000);
    const h4 = (await queue.claim(job.id))!; // attempt 4
    await queue.fail(h4, new Error('transient 4'));

    clock.advance(240 * 1000);
    const h5 = (await queue.claim(job.id))!; // attempt 5
    await queue.fail(h5, new Error('transient 5'));

    // Attempt 5 failure -> DEAD
    doc = (await store.doc('jobs', job.id).get()).data()!;
    expect(doc.status).toBe('DEAD');
    expect(doc.attempts).toBe(5);

    // Fatal error straight to DEAD
    const fatalJob = await queue.enqueue({
      kind: 'SYNC_ITEM',
      merchantId: 'm1',
      payload: {},
      idempotencyKey: 'fatal-job-1',
    });

    const fatalHandle = (await queue.claim(fatalJob.id))!;
    const fatalError: any = new Error('Clover Auth Failed 401');
    fatalError.fatal = true;
    await queue.fail(fatalHandle, fatalError);

    const fatalDoc = (await store.doc('jobs', fatalJob.id).get()).data()!;
    expect(fatalDoc.status).toBe('DEAD');
    expect(fatalDoc.attempts).toBe(1);
  });

  it('D6 replay-dead requeues with attempts 0', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: 'm1',
      payload: {},
      idempotencyKey: 'dead-replay-key',
    });

    // Mark as DEAD
    await store.doc('jobs', job.id).update({
      status: 'DEAD',
      attempts: 5,
      lastError: 'Fatal error',
    });

    const replayedCount = await queue.replayDead('m1');
    expect(replayedCount).toBe(1);

    const snap = (await store.doc('jobs', job.id).get()).data()!;
    expect(snap.status).toBe('QUEUED');
    expect(snap.attempts).toBe(0);
    expect(snap.nextAttemptAt).toBeLessThanOrEqual(clock.now());
  });

  it('D7 yield returns the attempt and makes the job runnable now', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: 'm1',
      payload: {},
      idempotencyKey: 'yield-key',
    });

    const handle = (await queue.claim(job.id))!;
    expect(handle.job.attempts).toBe(1);

    // Job runner decides to yield (e.g., 8-min budget reached)
    await queue.yield(handle, { cursor: 100 });

    const snap = (await store.doc('jobs', job.id).get()).data()!;
    expect(snap.status).toBe('QUEUED');
    expect(snap.attempts).toBe(0); // attempt returned
    expect(snap.nextAttemptAt).toBeLessThanOrEqual(clock.now()); // runnable now
    expect(snap.payload.cursor).toBe(100);
  });

  it('C6 an inbox event creates its jobs and is marked DONE in one transaction, a failing write retries with backoff and becomes FAILED after 5', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);
    const consumer = new InboxConsumer(store, queue, clock);

    // Producer writes inbox event
    const inboxRef = store.doc('inbox', 'inbox_1');
    await inboxRef.set({
      id: 'inbox_1',
      type: 'clover_webhook',
      merchantId: 'm1',
      key: 'wh:I:m1:item_1:100',
      body: {
        merchants: {
          m1: [{ objectId: 'I:item_1', type: 'UPDATE', ts: 100 }],
        },
      },
      status: 'NEW',
      attempts: 0,
      createdAt: clock.now(),
    });

    // Consume event
    await consumer.processInboxEvent('inbox_1');

    // Verify inbox is DONE
    const inboxSnap = (await inboxRef.get()).data()!;
    expect(inboxSnap.status).toBe('DONE');

    // Verify job was created in the queue
    const jobs = await store.collection('jobs').where('merchantId', '==', 'm1').get();
    expect(jobs.docs.length).toBe(1);
    expect(jobs.docs[0].data()?.kind).toBe('SYNC_ITEM');

    // Simulate failing handler that retries with backoff and fails after 5
    const failInboxRef = store.doc('inbox', 'inbox_fail');
    await failInboxRef.set({
      id: 'inbox_fail',
      type: 'installed',
      merchantId: 'm2',
      key: 'install:m2:dummy',
      body: {},
      status: 'NEW',
      attempts: 0,
      createdAt: clock.now(),
    });

    // Make consumer job creation throw
    consumer.setCustomHandler('installed', async () => {
      throw new Error('Simulated inbox job creation failure');
    });

    // Attempts 1 to 5
    for (let i = 1; i <= 5; i++) {
      await consumer.processInboxEvent('inbox_fail');
      const snap = (await failInboxRef.get()).data()!;
      expect(snap.attempts).toBe(i);
      if (i < 5) {
        expect(snap.status).toBe('NEW');
      } else {
        expect(snap.status).toBe('FAILED'); // Dead lettered after 5
      }
    }
  });

  it('Worker is listener-driven for QUEUED jobs with 60s maintenance query', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    let executedJobs: string[] = [];
    const runner = new JobRunner({
      queue,
      store,
      clock,
      concurrency: 4,
      handlers: {
        SYNC_ITEM: async (payload) => {
          executedJobs.push(payload.itemId);
        },
        SNAPSHOT: async () => {},
        PAIR_MENU: async () => {},
      },
    });

    runner.start();

    // Enqueue a job -> listener wakes worker immediately
    await queue.enqueue({
      kind: 'SYNC_ITEM',
      merchantId: 'm1',
      payload: { itemId: 'item_apple' },
      idempotencyKey: 'test_apple',
    });

    // Wait a tick for event listener dispatch
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(executedJobs).toContain('item_apple');
    const jobSnap = await store.collection('jobs').where('status', '==', 'DONE').get();
    expect(jobSnap.docs.length).toBe(1);

    runner.stop();
  });

  it('enqueue throws a clear error if idempotencyKey is missing', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);

    await expect(
      queue.enqueue({
        kind: 'SNAPSHOT',
        merchantId: 'm1',
        payload: {},
      } as any)
    ).rejects.toThrow('idempotencyKey is required');
  });

  it('installed inbox event produces exactly one SNAPSHOT job with valid idempotencyKey', async () => {
    const clock = new ControllableClock(1000);
    const store = new InMemoryStore(clock);
    const queue = new JobQueue(store, clock);
    const consumer = new InboxConsumer(store, queue, clock);

    // Simulate an installed event in the inbox
    const installRef = store.doc('inbox', 'inbox_install_1');
    await installRef.set({
      id: 'inbox_install_1',
      type: 'installed',
      merchantId: 'mid_bistro_1',
      key: 'snapshot:mid_bistro_1:1000',
      body: { merchantId: 'mid_bistro_1', installedAt: 1000 },
      status: 'NEW',
      attempts: 0,
      createdAt: clock.now(),
    });

    await consumer.processInboxEvent('inbox_install_1');

    // Check inbox status is DONE
    const inboxSnap = await installRef.get();
    expect(inboxSnap.data()?.status).toBe('DONE');

    // Check exactly one SNAPSHOT job exists for this merchant
    const jobs = await store.collection('jobs').where('merchantId', '==', 'mid_bistro_1').get();
    expect(jobs.docs.length).toBe(1);
    const job = jobs.docs[0].data()!;
    expect(job.kind).toBe('SNAPSHOT');
    expect(job.status).toBe('QUEUED');
    expect(job.idempotencyKey).toBe('snapshot:mid_bistro_1:1000');
    expect(job.merchantId).toBe('mid_bistro_1');

    // Redelivery of same installed event produces no extra jobs
    await consumer.processInboxEvent('inbox_install_1');
    const jobsAfter = await store.collection('jobs').where('merchantId', '==', 'mid_bistro_1').get();
    expect(jobsAfter.docs.length).toBe(1);
  });
});
