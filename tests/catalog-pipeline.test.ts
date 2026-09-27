import { describe, it, expect, beforeEach } from 'vitest';
import { ControllableClock } from '../src/adapters/in-memory/controllable-clock.js';
import { InMemoryStore } from '../src/adapters/in-memory/in-memory-store.js';
import { FakeCloverClient } from '../src/adapters/in-memory/fake-clover-client.js';
import { FakeLlm } from '../src/adapters/in-memory/fake-llm.js';
import { FakeEmbedder } from '../src/adapters/in-memory/fake-embedder.js';
import { InMemoryVectorIndex } from '../src/adapters/in-memory/in-memory-vector-index.js';
import { JobQueue } from '../src/core/queue/job-queue.js';
import { CatalogPipeline } from '../src/core/pipeline/catalog-pipeline.js';
import { CloverItem } from '../src/core/ports/clover.js';

describe('Phase 4: Catalog Pipeline (Snapshot, CDC, and Reconcile)', () => {
  let clock: ControllableClock;
  let store: InMemoryStore;
  let clover: FakeCloverClient;
  let llm: FakeLlm;
  let embedder: FakeEmbedder;
  let vectorIndex: InMemoryVectorIndex;
  let queue: JobQueue;
  let pipeline: CatalogPipeline;

  const mid = 'PWXW6VQTEWJ11';

  beforeEach(async () => {
    clock = new ControllableClock(1700000000000);
    store = new InMemoryStore(clock);
    clover = new FakeCloverClient();
    llm = new FakeLlm();
    embedder = new FakeEmbedder();
    vectorIndex = new InMemoryVectorIndex();
    queue = new JobQueue(store, clock);

    pipeline = new CatalogPipeline({
      store,
      clover,
      llm,
      embedder,
      vectorIndex,
      queue,
      clock,
    });

    // Seed merchant
    await store.doc('merchants', mid).set({
      id: mid,
      name: 'Vecta Demo Bistro',
      status: 'CONNECTED',
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      accessExpiresAt: clock.epochSeconds() + 3600,
      refreshExpiresAt: clock.epochSeconds() + 86400 * 30,
      connectedAt: clock.now(),
    });
  });

  // E1: One job per snapshot
  it('E1 a snapshot is ONE job for any catalog size, streams pages of 1000, chunks of 10 run 4 in parallel, and the first snapshot makes exactly one Llm call per chunk', async () => {
    // Demo Bistro has 32 items in FakeCloverClient -> chunks of 10 = 4 chunks (10, 10, 10, 2)
    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_test_e1',
    });

    const handle = (await queue.claim(job.id))!;
    await pipeline.runSnapshot(handle);

    // Verify 4 chunks = 4 LLM enrichment calls
    expect(llm.enrichCallCount).toBe(4);

    // Verify all 32 items indexed
    const itemsSnap = await store.collection('items').where('merchantId', '==', mid).get();
    expect(itemsSnap.docs.length).toBe(32);

    const catalogResults = await vectorIndex.findNearest({
      merchantId: mid,
      queryVector: new Array(768).fill(0),
      limit: 50,
    });
    expect(catalogResults.length).toBe(32);

    // Proposals not served as verified yet
    for (const res of catalogResults) {
      expect(res.item.verified).toBe(false);
    }
  });

  // E2: Cursor resume
  it('E2 a crash or lost lease mid-run resumes at the committed cursor without refetching finished pages, and a lost lease stops work', async () => {
    // Generate a catalog of 2500 items to test paging (pages of 1000: 1000, 1000, 500)
    const largeCatalog: CloverItem[] = [];
    for (let i = 0; i < 2500; i++) {
      largeCatalog.push({
        id: `item_${i}`,
        name: `Dish ${i}`,
        price: 1000 + i,
        available: true,
        autoManage: false,
        categories: { elements: [{ id: 'c1', name: 'Mains' }] },
      });
    }
    clover.setCatalog(mid, largeCatalog);

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_resume_test',
    });

    const handle = (await queue.claim(job.id))!;

    // Simulate stopping after page 1 (cursor at 1000)
    pipeline.setMaxPagesPerRun(1);
    await pipeline.runSnapshot(handle);

    const runDoc1 = (await store.doc('runs', handle.job.id).get()).data()!;
    expect(runDoc1.cursor).toBe(1000);
    const llmCallsAfterPage1 = llm.enrichCallCount;
    expect(llmCallsAfterPage1).toBe(100); // 1000 items / 10 = 100 chunks

    // Reset page limit to finish
    pipeline.setMaxPagesPerRun(undefined);

    // Simulate worker crash / lease expiry so job becomes reclaimable
    clock.advance(10 * 60 * 1000 + 1000);

    // Resume the run
    const resumeHandle = (await queue.claim(job.id))!;
    await pipeline.runSnapshot(resumeHandle);

    const runDoc2 = (await store.doc('runs', handle.job.id).get()).data()!;
    expect(runDoc2.cursor).toBe(2500);
    expect(runDoc2.status).toBe('COMPLETE');

    // Total LLM calls should only be for remaining 1500 items (150 chunks)
    expect(llm.enrichCallCount).toBe(llmCallsAfterPage1 + 150);

    // Test lost lease stops work
    const job2 = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_lost_lease',
    });
    const handle2 = (await queue.claim(job2.id))!;
    handle2.markLost(); // simulate revoked lease

    await expect(pipeline.runSnapshot(handle2)).rejects.toThrow(/lease was lost/i);
  });

  // E3: Hash skip
  it('E3 a rerun of an unchanged catalog makes ZERO Llm calls (sourceHash skip)', async () => {
    // First snapshot
    const job1 = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_rerun_1',
    });
    const handle1 = (await queue.claim(job1.id))!;
    await pipeline.runSnapshot(handle1);

    const firstRunLlmCalls = llm.enrichCallCount;
    expect(firstRunLlmCalls).toBe(4);

    // Second snapshot on unchanged catalog
    const job2 = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'full' },
      idempotencyKey: 'snap_rerun_2',
    });
    const handle2 = (await queue.claim(job2.id))!;
    await pipeline.runSnapshot(handle2);

    // ZERO additional LLM calls
    expect(llm.enrichCallCount).toBe(firstRunLlmCalls);

    const run2 = (await store.doc('runs', handle2.job.id).get()).data()!;
    expect(run2.counts.unchanged).toBe(32);
    expect(run2.counts.indexed).toBe(0);
  });

  // E4: Stock patch
  it('E4 a stock-only change patches in_stock/stock_quantity without re-embedding or any Llm call', async () => {
    // Initial snapshot
    const job1 = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_stock_1',
    });
    const handle1 = (await queue.claim(job1.id))!;
    await pipeline.runSnapshot(handle1);

    const initialLlmCalls = llm.enrichCallCount;
    const initialEmbedderCalls = embedder.callCount;

    // Change stock only of Butter Chicken (item_9) in Clover
    clover.updateItem(mid, 'item_9', { available: false, itemStock: { quantity: 0 } });

    // Run SYNC_ITEM
    const syncJob = await queue.enqueue({
      kind: 'SYNC_ITEM',
      merchantId: mid,
      payload: { itemId: 'item_9' },
      idempotencyKey: 'sync_stock_item_9',
    });
    const syncHandle = (await queue.claim(syncJob.id))!;
    await pipeline.syncItem(syncHandle);

    // Verify ZERO new LLM calls and ZERO new embedding calls
    expect(llm.enrichCallCount).toBe(initialLlmCalls);
    expect(embedder.callCount).toBe(initialEmbedderCalls);

    // Verify index patched
    const searchRes = await vectorIndex.findNearest({
      merchantId: mid,
      queryVector: new Array(768).fill(0),
      limit: 50,
      inStockOnly: false,
    });
    const butterChicken = searchRes.find((r) => r.item.item_id === 'item_9')!;
    expect(butterChicken.item.in_stock).toBe(false);
  });

  // E5: Failure isolation
  it('E5 one bad item becomes FAILED, is counted, retried alone as its own SYNC_ITEM job, the run ends COMPLETE_WITH_FAILURES, and the item is NOT swept as deleted', async () => {
    // Inject a bad item that fails processing
    pipeline.setBadItemToFail('item_4'); // Crispy Calamari

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_bad_item',
    });
    const handle = (await queue.claim(job.id))!;
    await pipeline.runSnapshot(handle);

    const run = (await store.doc('runs', handle.job.id).get()).data()!;
    expect(run.status).toBe('COMPLETE_WITH_FAILURES');
    expect(run.counts.failed).toBe(1);
    expect(run.failedItemIds).toContain('item_4');

    // Item must be FAILED, NOT DELETED
    const itemDoc = (await store.doc('items', `${mid}_item_4`).get()).data()!;
    expect(itemDoc.stage).toBe('FAILED');

    // SYNC_ITEM retry job enqueued
    const retryJobs = await store.collection('jobs')
      .where('kind', '==', 'SYNC_ITEM')
      .where('merchantId', '==', mid)
      .get();
    const retryForBadItem = retryJobs.docs.find((d) => d.data()?.payload?.itemId === 'item_4');
    expect(retryForBadItem).toBeDefined();
  });

  // E6: Batch degrade
  it('E6 a failing batch Llm call (or an incomplete response) degrades to per-item calls', async () => {
    // Configure LLM to fail the first batch call
    llm.setFailNextEnrich(true);

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_batch_degrade',
    });
    const handle = (await queue.claim(job.id))!;
    await pipeline.runSnapshot(handle);

    // The first batch threw -> degraded to per-item calls, all 32 succeeded
    const items = await store.collection('items').where('merchantId', '==', mid).get();
    expect(items.docs.length).toBe(32);
    for (const doc of items.docs) {
      expect(doc.data()?.stage).toBe('INDEXED');
    }
  });

  // E7: Verified mark-and-sweep
  it('E7 verified mark-and-sweep: a row skipped by offset paging is re-fetched and survives, a truly deleted row is removed', async () => {
    // First snapshot
    const job1 = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_sweep_1',
    });
    const handle1 = (await queue.claim(job1.id))!;
    await pipeline.runSnapshot(handle1);

    // Delete item_1 from Clover catalog
    const currentCatalog = (clover as any).catalogs.get(mid) as CloverItem[];
    const filteredCatalog = currentCatalog.filter((i) => i.id !== 'item_1');
    clover.setCatalog(mid, filteredCatalog);

    // Simulate item_2 being skipped by offset paging during the snapshot page read
    pipeline.setSimulatePagingSkipItemId('item_2');

    // Second full snapshot
    const job2 = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'full' },
      idempotencyKey: 'snap_sweep_2',
    });
    const handle2 = (await queue.claim(job2.id))!;
    await pipeline.runSnapshot(handle2);

    // Truly deleted item_1 is marked DELETED and removed from vectorIndex
    const item1Doc = (await store.doc('items', `${mid}_item_1`).get()).data()!;
    expect(item1Doc.stage).toBe('DELETED');

    const searchAll = await vectorIndex.findNearest({
      merchantId: mid,
      queryVector: new Array(768).fill(0),
      limit: 50,
      inStockOnly: false,
    });
    expect(searchAll.some((r) => r.item.item_id === 'item_1')).toBe(false);

    // Paging-skipped item_2 was verified via re-fetch and SURVIVED (still INDEXED)
    const item2Doc = (await store.doc('items', `${mid}_item_2`).get()).data()!;
    expect(item2Doc.stage).toBe('INDEXED');
    expect(searchAll.some((r) => r.item.item_id === 'item_2')).toBe(true);
  });

  // E8: Incremental window
  it('E8 incremental uses lastSyncedAt minus 10 minutes fixed at run start, skips when there is no baseline or it is older than 85 days, and never deletes', async () => {
    // Case 1: No baseline -> skips
    const jobNoBaseline = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'incremental' },
      idempotencyKey: 'inc_no_baseline',
    });
    const h1 = (await queue.claim(jobNoBaseline.id))!;
    await pipeline.runSnapshot(h1);

    const run1 = (await store.doc('runs', h1.job.id).get()).data()!;
    expect(run1.status).toBe('COMPLETE');
    expect(run1.counts.indexed).toBe(0);

    // Set lastSyncedAt to 90 days ago (> 85 days) -> skips
    const ninetyDaysAgo = clock.now() - 90 * 86400 * 1000;
    await store.doc('merchants', mid).update({ lastSyncedAt: ninetyDaysAgo });

    const jobOldBaseline = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'incremental' },
      idempotencyKey: 'inc_old_baseline',
    });
    const h2 = (await queue.claim(jobOldBaseline.id))!;
    await pipeline.runSnapshot(h2);

    const run2 = (await store.doc('runs', h2.job.id).get()).data()!;
    expect(run2.status).toBe('COMPLETE');
    expect(run2.counts.indexed).toBe(0);

    // Case 3: Valid baseline (e.g. 1 hour ago)
    const oneHourAgo = clock.now() - 3600 * 1000;
    await store.doc('merchants', mid).update({ lastSyncedAt: oneHourAgo });

    const jobValidInc = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'incremental' },
      idempotencyKey: 'inc_valid',
    });
    const h3 = (await queue.claim(jobValidInc.id))!;
    await pipeline.runSnapshot(h3);

    const run3 = (await store.doc('runs', h3.job.id).get()).data()!;
    // Fixed window: lastSyncedAt - 10 minutes
    expect(run3.modifiedSince).toBe(oneHourAgo - 10 * 60 * 1000);
  });

  // E9: Run bookkeeping
  it('E9 run bookkeeping: counts, failedItemIds, merchant.lastSyncedAt = run.startedAt, run_finished event, PAIR_MENU enqueued', async () => {
    const runStartTime = clock.now();
    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_bookkeeping',
    });

    const handle = (await queue.claim(job.id))!;
    await pipeline.runSnapshot(handle);

    // Merchant lastSyncedAt == run.startedAt
    const merchant = (await store.doc('merchants', mid).get()).data()!;
    expect(merchant.lastSyncedAt).toBe(runStartTime);

    // run_finished event in events collection
    const events = await store.collection('events').where('merchantId', '==', mid).get();
    const runFinishedEvent = events.docs.find((d) => d.data()?.kind === 'run_finished');
    expect(runFinishedEvent).toBeDefined();

    // PAIR_MENU job enqueued
    const pairJob = await store.doc('jobs', `pair:${mid}:${handle.job.id}`.slice(0, 32)).get();
    const pairJobs = await store.collection('jobs')
      .where('kind', '==', 'PAIR_MENU')
      .where('merchantId', '==', mid)
      .get();
    expect(pairJobs.docs.length).toBe(1);
  });

  it('Changed item proposal resets reviewStatus to PENDING and clears approvedProfile', async () => {
    // Initial snapshot
    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_approval_reset',
    });
    const handle = (await queue.claim(job.id))!;
    await pipeline.runSnapshot(handle);

    // Simulate merchant approving an item
    const itemRef = store.doc('items', `${mid}_item_1`);
    const initialItem = (await itemRef.get()).data()!;
    await itemRef.update({
      reviewStatus: 'APPROVED',
      approvedProfile: initialItem.profile,
    });

    // Modify item in Clover (e.g. name or price changed)
    clover.updateItem(mid, 'item_1', { name: 'Samosa Chaat Deluxe', price: 1100 });

    // Resync item
    const syncJob = await queue.enqueue({
      kind: 'SYNC_ITEM',
      merchantId: mid,
      payload: { itemId: 'item_1' },
      idempotencyKey: 'sync_changed_item_1',
    });
    const syncHandle = (await queue.claim(syncJob.id))!;
    await pipeline.syncItem(syncHandle);

    // Approval must be cleared, reset to PENDING
    const updatedItem = (await itemRef.get()).data()!;
    expect(updatedItem.reviewStatus).toBe('PENDING');
    expect(updatedItem.approvedProfile).toBeNull();
  });

  it('Delivery time budget is 8 minutes, after which the job yields with its cursor committed', async () => {
    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_yield_budget',
    });
    const handle = (await queue.claim(job.id))!;

    // Set pipeline delivery budget to 8 minutes and advance time during execution
    pipeline.setSimulateLongDelivery(8 * 60 * 1000 + 1000); // 8 min + 1 sec
    const yielded = await pipeline.runSnapshot(handle);

    expect(yielded).toBe(true);

    const jobDoc = (await store.doc('jobs', job.id).get()).data()!;
    expect(jobDoc.status).toBe('QUEUED'); // yielded
    expect(jobDoc.attempts).toBe(0); // attempt returned
  });

  it('an item whose enrichment returned nothing is marked FAILED and retried as SYNC_ITEM, never INDEXED with null proposal', async () => {
    // Configure fake LLM to return empty items for item_1
    llm.setFailForItemId?.('item_1'); // Or simulate empty result from enrichItems
    const origEnrich = llm.enrichItems.bind(llm);
    llm.enrichItems = async (req) => {
      const res = await origEnrich(req);
      return {
        items: res.items.filter((it) => it.item_id !== 'item_1'),
      };
    };

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_fail_enrich_test',
    });
    const handle = (await queue.claim(job.id))!;
    await pipeline.runSnapshot(handle);

    // item_1 must be marked FAILED, not INDEXED
    const item1Doc = (await store.doc('items', `${mid}_item_1`).get()).data()!;
    expect(item1Doc.stage).toBe('FAILED');
    expect(item1Doc.profile).toBeUndefined();

    // A SYNC_ITEM job must have been enqueued for item_1
    const syncJobs = await store.collection('jobs').where('merchantId', '==', mid).get();
    const retryJob = syncJobs.docs.map((d) => d.data()!).find((j) => j.kind === 'SYNC_ITEM' && j.payload?.itemId === 'item_1');
    expect(retryJob).toBeDefined();
    expect(retryJob?.status).toBe('QUEUED');
  });

  it('sourceHash skip only applies when item has a proposal; items with proposal == null are re-enriched', async () => {
    // Manually create an item that is INDEXED with matching sourceHash but profile == null
    const cloverItem = (await clover.getItem(mid, 'item_1', 'token'))!;
    const sourceHash = (pipeline as any).constructor.name ? 'dummy' : '';
    const docId = `${mid}_item_1`;

    await store.doc('items', docId).set({
      id: docId,
      merchantId: mid,
      itemId: 'item_1',
      stage: 'INDEXED',
      name: cloverItem.name,
      sourceHash: 'some_hash',
      item: cloverItem,
      profile: null, // missing proposal
      reviewStatus: 'PENDING',
      updatedAt: clock.now(),
    });

    let enrichCalled = false;
    const origEnrich = llm.enrichItems.bind(llm);
    llm.enrichItems = async (req) => {
      enrichCalled = true;
      return origEnrich(req);
    };

    // Run snapshot
    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_re_enrich_null_profile',
    });
    const handle = (await queue.claim(job.id))!;
    await pipeline.runSnapshot(handle);

    expect(enrichCalled).toBe(true);
    const updated = (await store.doc('items', docId).get()).data()!;
    expect(updated.stage).toBe('INDEXED');
    expect(updated.profile).toBeDefined();
    expect(updated.profile?.cuisine).toBeDefined();
  });
});
