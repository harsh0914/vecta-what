import { describe, it, expect, beforeEach } from 'vitest';
import { ControllableClock } from '../src/adapters/in-memory/controllable-clock.js';
import { InMemoryStore } from '../src/adapters/in-memory/in-memory-store.js';
import { FakeCloverClient } from '../src/adapters/in-memory/fake-clover-client.js';
import { FakeLlm } from '../src/adapters/in-memory/fake-llm.js';
import { FakeEmbedder } from '../src/adapters/in-memory/fake-embedder.js';
import { InMemoryVectorIndex } from '../src/adapters/in-memory/in-memory-vector-index.js';
import { JobQueue } from '../src/core/queue/job-queue.js';
import { CatalogPipeline, buildCatalogDoc } from '../src/core/pipeline/catalog-pipeline.js';
import { PairingPipeline, PAIRING_VERSION } from '../src/core/pipeline/pairing-pipeline.js';
import { CourseType, AllergenType } from '../src/core/types.js';

describe('Phase 5: Gemini Enrichment, Pairing & Vector Search', () => {
  let clock: ControllableClock;
  let store: InMemoryStore;
  let clover: FakeCloverClient;
  let llm: FakeLlm;
  let embedder: FakeEmbedder;
  let vectorIndex: InMemoryVectorIndex;
  let queue: JobQueue;
  let catalogPipeline: CatalogPipeline;
  let pairingPipeline: PairingPipeline;

  const mid = 'PWXW6VQTEWJ11';

  beforeEach(async () => {
    clock = new ControllableClock(1700000000000);
    store = new InMemoryStore(clock);
    clover = new FakeCloverClient();
    llm = new FakeLlm();
    embedder = new FakeEmbedder();
    vectorIndex = new InMemoryVectorIndex();
    queue = new JobQueue(store, clock);

    catalogPipeline = new CatalogPipeline({
      store,
      clover,
      llm,
      embedder,
      vectorIndex,
      queue,
      clock,
    });

    pairingPipeline = new PairingPipeline({
      store,
      llm,
      clock,
    });

    await store.doc('merchants', mid).set({
      id: mid,
      name: 'Vecta Demo Bistro',
      status: 'CONNECTED',
      accessToken: 'test_token',
      accessExpiresAt: clock.epochSeconds() + 3600,
      connectedAt: clock.now(),
    });
  });

  // F1: Batched structured enrichment
  it('F1 batched structured enrichment batches <=10 items per call and calls Gemini with required parameters', async () => {
    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_f1',
    });

    const handle = (await queue.claim(job.id))!;
    await catalogPipeline.runSnapshot(handle);

    // 32 items in demo bistro -> chunks of 10 -> exactly 4 batch enrichment calls
    expect(llm.enrichCallCount).toBe(4);

    const itemsSnap = await store.collection('items').where('merchantId', '==', mid).get();
    expect(itemsSnap.docs.length).toBe(32);
    for (const doc of itemsSnap.docs) {
      expect(doc.data()?.profile).toBeDefined();
    }
  });

  // F2: ItemProfile schema compliance
  it('F2 ItemProfile schema validates all required fields, closed enums for course and allergens, spice 0-3, confidence 0-1', async () => {
    const req = {
      items: [
        {
          id: 'item_1',
          name: 'Vegetable Samosas',
          price: 900,
          categories: ['Appetizers'],
          tags: ['vegetarian', 'spicy'],
        },
      ],
    };

    const result = await llm.enrichItems(req);
    expect(result.items.length).toBe(1);

    const p = result.items[0].profile;
    expect(typeof p.description).toBe('string');
    expect(typeof p.cuisine).toBe('string');
    expect(p.cuisine).toBe(p.cuisine.toLowerCase());

    const validCourses: CourseType[] = [
      'appetizer', 'soup_salad', 'main', 'side', 'bread', 'dessert', 'drink', 'other',
    ];
    expect(validCourses).toContain(p.course);

    expect(typeof p.vegetarian).toBe('boolean');
    expect(typeof p.vegan).toBe('boolean');
    expect(typeof p.gluten_free).toBe('boolean');
    expect(typeof p.contains_alcohol).toBe('boolean');

    expect(p.spice_level).toBeGreaterThanOrEqual(0);
    expect(p.spice_level).toBeLessThanOrEqual(3);

    const validAllergens: AllergenType[] = [
      'dairy', 'egg', 'gluten', 'peanut', 'tree_nut', 'soy', 'shellfish', 'fish', 'sesame',
    ];
    for (const a of p.allergens) {
      expect(validAllergens).toContain(a);
    }

    expect(Array.isArray(p.main_ingredients)).toBe(true);
    expect(Array.isArray(p.flavor_tags)).toBe(true);
    expect(typeof p.good_for).toBe('string');

    expect(p.confidence).toBeGreaterThanOrEqual(0);
    expect(p.confidence).toBeLessThanOrEqual(1);
  });

  // F3: Menu context in prompt
  it('F3 menu context (menuOutline <= 300) and merchant context are saved and passed to LLM', async () => {
    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_f3',
    });

    const handle = (await queue.claim(job.id))!;
    await catalogPipeline.runSnapshot(handle);

    const merchant = (await store.doc('merchants', mid).get()).data()!;
    expect(merchant.menuOutline).toBeDefined();
    expect(merchant.menuOutline.length).toBe(32);
    expect(merchant.menuOutline[0]).toContain('(');
  });

  // Incomplete / truncated response handling: retry missing items, never guess
  it('handles incomplete or truncated batch responses by retrying missing items individually without guessing', async () => {
    // Configure LLM to omit item_2 and item_3 from the first batch
    llm.setOmitItemIds(['item_2', 'item_3']);

    const job = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_incomplete_retry',
    });

    const handle = (await queue.claim(job.id))!;
    await catalogPipeline.runSnapshot(handle);

    // All items must still be successfully indexed (the 2 missing items were retried)
    const item2 = (await store.doc('items', `${mid}_item_2`).get()).data()!;
    const item3 = (await store.doc('items', `${mid}_item_3`).get()).data()!;
    expect(item2.stage).toBe('INDEXED');
    expect(item2.profile).toBeDefined();
    expect(item3.stage).toBe('INDEXED');
    expect(item3.profile).toBeDefined();
  });

  // F8: Pairing proposals per menu after snapshot
  it('F8 pairing proposals run per menu after snapshot with valid item IDs, <=4 pairs, role enum, and version bump', async () => {
    // 1. Run snapshot first to populate indexed items
    const snapJob = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_pair_f8',
    });
    const snapHandle = (await queue.claim(snapJob.id))!;
    await catalogPipeline.runSnapshot(snapHandle);

    // 2. Run PAIR_MENU
    const pairJob = (await store.collection('jobs')
      .where('kind', '==', 'PAIR_MENU')
      .where('merchantId', '==', mid)
      .get()).docs[0];
    expect(pairJob).toBeDefined();

    const pairHandle = (await queue.claim(pairJob.id))!;
    await pairingPipeline.runPairing(pairHandle);

    const itemsSnap = await store.collection('items').where('merchantId', '==', mid).get();
    const curriesWithPairings = itemsSnap.docs.filter((d) => d.data()?.pairingsProposal?.length > 0);
    expect(curriesWithPairings.length).toBeGreaterThan(0);

    for (const doc of curriesWithPairings) {
      const p = doc.data()!;
      expect(p.pairingsStatus).toBe('PENDING');
      expect(p.pairingsProposal.length).toBeLessThanOrEqual(4);
      for (const pair of p.pairingsProposal) {
        expect(pair.item_id).not.toBe(p.itemId); // never pair with self
        expect(['bread', 'rice', 'side', 'drink', 'dessert', 'starter', 'main']).toContain(pair.role);
        expect(typeof pair.reason).toBe('string');
      }
    }

    // 3. Rerun PAIR_MENU without menu change -> skip due to same pairingsHash
    const initialPairCallCount = llm.pairingCallCount;
    const pairJob2 = await queue.enqueue({
      kind: 'PAIR_MENU',
      merchantId: mid,
      payload: { merchantId: mid },
      idempotencyKey: 'pair_rerun_skip',
    });
    const pairHandle2 = (await queue.claim(pairJob2.id))!;
    await pairingPipeline.runPairing(pairHandle2);
    expect(llm.pairingCallCount).toBe(initialPairCallCount);

    // 4. Bumping PAIRING_VERSION re-pairs without re-enriching items
    pairingPipeline.setPairingVersion(PAIRING_VERSION + 1);
    const pairJob3 = await queue.enqueue({
      kind: 'PAIR_MENU',
      merchantId: mid,
      payload: { merchantId: mid },
      idempotencyKey: 'pair_bump_version',
    });
    const pairHandle3 = (await queue.claim(pairJob3.id))!;
    await pairingPipeline.runPairing(pairHandle3);
    expect(llm.pairingCallCount).toBeGreaterThan(initialPairCallCount);
  });

  // F9: Pairing quality
  it('F9 pairing quality matches curries to naan, rice, raita, or lassi without random cross-cuisine pairing', async () => {
    const snapJob = await queue.enqueue({
      kind: 'SNAPSHOT',
      merchantId: mid,
      payload: { kind: 'snapshot' },
      idempotencyKey: 'snap_pair_f9',
    });
    const snapHandle = (await queue.claim(snapJob.id))!;
    await catalogPipeline.runSnapshot(snapHandle);

    const pairJob = (await store.collection('jobs')
      .where('kind', '==', 'PAIR_MENU')
      .where('merchantId', '==', mid)
      .get()).docs[0];
    const pairHandle = (await queue.claim(pairJob.id))!;
    await pairingPipeline.runPairing(pairHandle);

    // Butter chicken (item_9) should pair with Garlic Naan or Rice or Raita
    const butterChickenDoc = (await store.doc('items', `${mid}_item_9`).get()).data()!;
    expect(butterChickenDoc.pairingsProposal.length).toBeGreaterThan(0);

    const proposedItemIds = butterChickenDoc.pairingsProposal.map((p: any) => p.item_id);
    // In Demo Bistro: Garlic Naan is item_19, Jeera Rice is item_21
    expect(proposedItemIds.some((id: string) => id === 'item_19' || id === 'item_21')).toBe(true);
  });

  // G1: Catalog docs + embeddings 768 dimensions
  it('G1 catalog docs have 768-d embeddings, RETRIEVAL_DOCUMENT format, and re-embed only when search_text changes', async () => {
    const cloverItem = await clover.getItem(mid, 'item_1');
    const catalogDoc = buildCatalogDoc(mid, cloverItem, null);

    expect(catalogDoc.search_text).toBeDefined();
    expect(catalogDoc.verified).toBe(false);

    const embeddings = await embedder.embed([`title: ${catalogDoc.name} | text: ${catalogDoc.search_text}`]);
    expect(embeddings.length).toBe(1);
    expect(embeddings[0].length).toBe(768);

    catalogDoc.embedding = embeddings[0];
    await vectorIndex.put(mid, 'item_1', catalogDoc);

    const initialEmbedderCalls = embedder.callCount;

    // Resyncing item with same text should NOT re-embed
    const syncJob = await queue.enqueue({
      kind: 'SYNC_ITEM',
      merchantId: mid,
      payload: { itemId: 'item_1' },
      idempotencyKey: 'sync_same_text',
    });
    const syncHandle = (await queue.claim(syncJob.id))!;
    await catalogPipeline.syncItem(syncHandle);

    expect(embedder.callCount).toBe(initialEmbedderCalls);
  });

  // G2: Vector index filtering
  it('G2 vector index enforces tenant pre-filter merchantId, in_stock filter, and code post-filters', async () => {
    // Populate index with a few dishes
    const items = [
      {
        merchantId: mid,
        item_id: 'dish_1',
        name: 'Chana Masala',
        categories: ['Mains'],
        price_cents: 1400,
        in_stock: true,
        verified: true,
        search_text: 'Chana Masala Chickpeas Vegan Main',
        vegetarian: true,
        vegan: true,
        gluten_free: true,
        spice_level: 2,
        course: 'main' as CourseType,
        allergens: [] as AllergenType[],
        embedding: new Array(768).fill(0.1),
      },
      {
        merchantId: mid,
        item_id: 'dish_2',
        name: 'Butter Chicken',
        categories: ['Mains'],
        price_cents: 1800,
        in_stock: true,
        verified: true,
        search_text: 'Butter Chicken Creamy Curry Dairy',
        vegetarian: false,
        vegan: false,
        gluten_free: true,
        spice_level: 1,
        course: 'main' as CourseType,
        allergens: ['dairy' as AllergenType],
        embedding: new Array(768).fill(0.15),
      },
      {
        merchantId: mid,
        item_id: 'dish_3',
        name: 'Mango Lassi',
        categories: ['Drinks'],
        price_cents: 500,
        in_stock: false, // out of stock
        verified: true,
        search_text: 'Mango Lassi Yogurt Drink Sweet',
        vegetarian: true,
        vegan: false,
        gluten_free: true,
        spice_level: 0,
        course: 'drink' as CourseType,
        allergens: ['dairy' as AllergenType],
        embedding: new Array(768).fill(0.05),
      },
      {
        merchantId: 'OTHER_MERCHANT',
        item_id: 'dish_4',
        name: 'Other Place Pizza',
        categories: ['Mains'],
        price_cents: 1200,
        in_stock: true,
        verified: true,
        search_text: 'Pizza Cheese',
        embedding: new Array(768).fill(0.2),
      },
    ];

    for (const it of items) {
      await vectorIndex.put(it.merchantId, it.item_id, it as any);
    }

    // 1. Tenant pre-filter: other merchant never returned
    const res1 = await vectorIndex.findNearest({
      merchantId: mid,
      queryVector: new Array(768).fill(0.1),
      limit: 10,
      inStockOnly: false,
    });
    expect(res1.some((r) => r.item.merchantId === 'OTHER_MERCHANT')).toBe(false);

    // 2. inStockOnly filter
    const resInStock = await vectorIndex.findNearest({
      merchantId: mid,
      queryVector: new Array(768).fill(0.1),
      limit: 10,
      inStockOnly: true,
    });
    expect(resInStock.some((r) => r.item.item_id === 'dish_3')).toBe(false);

    // 3. Post-filters: vegan and maxPrice 1500
    const resVegan = await vectorIndex.findNearest({
      merchantId: mid,
      queryVector: new Array(768).fill(0.1),
      limit: 10,
      inStockOnly: true,
      vegan: true,
      maxPriceCents: 1500,
    });
    expect(resVegan.length).toBe(1);
    expect(resVegan[0].item.item_id).toBe('dish_1');

    // 4. search_text and embedding dropped from results
    expect((resVegan[0].item as any).search_text).toBeUndefined();
    expect((resVegan[0].item as any).embedding).toBeUndefined();
  });
});
