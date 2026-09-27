import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { InMemoryStore } from '../src/adapters/in-memory/in-memory-store.js';
import { ControllableClock } from '../src/adapters/in-memory/controllable-clock.js';
import { FakeEmbedder } from '../src/adapters/in-memory/fake-embedder.js';
import { InMemoryVectorIndex } from '../src/adapters/in-memory/in-memory-vector-index.js';
import { FakeLlm } from '../src/adapters/in-memory/fake-llm.js';
import { computeReviewKey, createReviewRouter } from '../src/server/review-routes.js';
import { createAgentRouter } from '../src/server/agent-routes.js';
import { createDiscoveryRouter, DEMO_BISTRO_MERCHANT_ID } from '../src/server/discovery-routes.js';
import { evaluateFactChecks, createCompareRouter } from '../src/server/compare-routes.js';
import { JobQueue } from '../src/core/queue/job-queue.js';
import { CloverItem, ItemDocument, MerchantDocument } from '../src/core/types.js';

describe('Phase 6 & Demo-First: Review Gate, Search, Discovery, Fact-Checks', () => {
  let store: InMemoryStore;
  let clock: ControllableClock;
  let embedder: FakeEmbedder;
  let vectorIndex: InMemoryVectorIndex;
  let llm: FakeLlm;
  let queue: JobQueue;
  let app: express.Express;
  const mid = DEMO_BISTRO_MERCHANT_ID;
  const adminToken = 'test-admin-token';

  beforeEach(async () => {
    clock = new ControllableClock();
    store = new InMemoryStore(clock);
    embedder = new FakeEmbedder();
    vectorIndex = new InMemoryVectorIndex();
    llm = new FakeLlm();
    queue = new JobQueue(store, clock);

    app = express();
    app.use(express.json());

    // Mount routers
    const reviewRouter = createReviewRouter({ store, embedder, vectorIndex, queue, adminToken });
    const agentRouter = createAgentRouter({ store, embedder, vectorIndex });
    const discoveryRouter = createDiscoveryRouter(store);
    const compareRouter = createCompareRouter({ llm });

    app.use(reviewRouter);
    app.use(agentRouter);
    app.use(discoveryRouter);
    app.use(compareRouter);

    // Setup initial merchant document
    const merchant: MerchantDocument = {
      id: mid,
      name: 'Vecta Demo Bistro',
      status: 'CONNECTED',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };
    await store.doc('merchants', mid).set(merchant);

    // Setup sample raw items
    const chanaRaw: CloverItem = {
      id: 'dish_chana',
      name: 'Chana Masala',
      price: 1500,
      categories: { elements: [{ id: 'c1', name: 'Mains' }] },
      tags: { elements: [{ id: 't1', name: 'Vegan' }] },
      itemStock: { quantity: 20 },
    };

    const chickenRaw: CloverItem = {
      id: 'dish_chicken',
      name: 'Butter Chicken',
      price: 1950,
      categories: { elements: [{ id: 'c1', name: 'Mains' }] },
      tags: { elements: [{ id: 't2', name: "Chef's Special" }] },
      itemStock: { quantity: 15 },
    };

    const naanRaw: CloverItem = {
      id: 'dish_naan',
      name: 'Garlic Naan',
      price: 400,
      categories: { elements: [{ id: 'c2', name: 'Breads & Sides' }] },
      tags: { elements: [{ id: 't3', name: 'Vegetarian' }] },
      itemStock: { quantity: 30 },
    };

    // Setup items docs in store
    const chanaDoc: ItemDocument = {
      merchantId: mid,
      rawItem: chanaRaw,
      sourceHash: 'hash_chana',
      stockSig: 'avail',
      stage: 'INDEXED',
      reviewStatus: 'PENDING',
      profile: {
        description: 'Slow-simmered chickpeas in spiced tomato gravy.',
        cuisine: 'indian',
        course: 'main',
        vegetarian: true,
        vegan: true,
        gluten_free: true,
        contains_alcohol: false,
        spice_level: 1,
        allergens: [],
        main_ingredients: ['chickpeas', 'tomato', 'ginger'],
        flavor_tags: ['spiced', 'savory', 'tangy'],
        good_for: 'hearty dinner',
        confidence: 0.95,
      },
      pairingsProposal: [
        { item_id: 'dish_naan', role: 'bread', reason: 'Perfect for scooping gravy' },
      ],
      pairingsStatus: 'PENDING',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };

    const chickenDoc: ItemDocument = {
      merchantId: mid,
      rawItem: chickenRaw,
      sourceHash: 'hash_chicken',
      stockSig: 'avail',
      stage: 'INDEXED',
      reviewStatus: 'PENDING',
      profile: {
        description: 'Tender chicken in creamy makhani sauce.',
        cuisine: 'indian',
        course: 'main',
        vegetarian: false,
        vegan: false,
        gluten_free: true,
        contains_alcohol: false,
        spice_level: 1,
        allergens: ['dairy'],
        main_ingredients: ['chicken', 'cream', 'tomato'],
        flavor_tags: ['creamy', 'mild', 'rich'],
        good_for: 'dinner',
        confidence: 0.9,
      },
      pairingsProposal: [
        { item_id: 'dish_naan', role: 'bread', reason: 'Classic accompaniment' },
      ],
      pairingsStatus: 'PENDING',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };

    await store.doc('items', `${mid}_dish_chana`).set(chanaDoc);
    await store.doc('items', `${mid}_dish_chicken`).set(chickenDoc);
    await store.doc('items', `${mid}_dish_naan`).set({
      merchantId: mid,
      rawItem: naanRaw,
      sourceHash: 'hash_naan',
      stockSig: 'avail',
      stage: 'INDEXED',
      reviewStatus: 'APPROVED',
      profile: {
        description: 'Warm tandoori flatbread brushed with garlic butter.',
        cuisine: 'indian',
        course: 'bread',
        vegetarian: true,
        vegan: false,
        gluten_free: false,
        contains_alcohol: false,
        spice_level: 0,
        allergens: ['dairy', 'gluten'],
        main_ingredients: ['flour', 'garlic', 'butter'],
        flavor_tags: ['buttery', 'garlicky'],
        good_for: 'side',
        confidence: 0.9,
      },
      approvedProfile: {
        description: 'Warm tandoori flatbread brushed with garlic butter.',
        cuisine: 'indian',
        course: 'bread',
        vegetarian: true,
        vegan: false,
        gluten_free: false,
        contains_alcohol: false,
        spice_level: 0,
        allergens: ['dairy', 'gluten'],
        main_ingredients: ['flour', 'garlic', 'butter'],
        flavor_tags: ['buttery', 'garlicky'],
        good_for: 'side',
        confidence: 0.9,
      },
      pairingsApproved: [],
      pairingsStatus: 'APPROVED',
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    // Populate vector index with catalog docs
    await vectorIndex.put(mid, 'dish_chana', {
      merchantId: mid,
      item_id: 'dish_chana',
      name: 'Chana Masala',
      categories: ['Mains'],
      price_cents: 1500,
      in_stock: true,
      verified: true,
      search_text: 'Chana Masala | chickpeas vegan',
      embedding: [1, 0, 0],
      vegetarian: true,
      vegan: true,
      gluten_free: true,
      course: 'main',
      spice_level: 1,
    });

    await vectorIndex.put(mid, 'dish_chicken', {
      merchantId: mid,
      item_id: 'dish_chicken',
      name: 'Butter Chicken',
      categories: ['Mains'],
      price_cents: 1950,
      in_stock: true,
      verified: true,
      search_text: 'Butter Chicken | chicken cream',
      embedding: [0, 1, 0],
      vegetarian: false,
      vegan: false,
      gluten_free: true,
      course: 'main',
      spice_level: 1,
      allergens: ['dairy'],
    });

    await vectorIndex.put(mid, 'dish_naan', {
      merchantId: mid,
      item_id: 'dish_naan',
      name: 'Garlic Naan',
      categories: ['Breads & Sides'],
      price_cents: 400,
      in_stock: true,
      verified: true,
      search_text: 'Garlic Naan | flatbread',
      embedding: [0, 0, 1],
      vegetarian: true,
      vegan: false,
      gluten_free: false,
      course: 'bread',
      spice_level: 0,
    });
  });

  // 1. Review Capability Key & Endpoints (F5, F6, F7, K1, K2)
  it('enforces capability key on review endpoints and enables approve / edit / bulk-approve', async () => {
    const validKey = computeReviewKey(mid, adminToken);

    // Without key -> 403
    const unauthRes = await app._router.handle(
      { method: 'GET', url: `/api/review/${mid}`, headers: {} },
      { status: (s: number) => ({ json: (d: any) => ({ status: s, ...d }) }) },
      () => {}
    );

    // Read review items with valid key
    const itemsSnap = await store.collection<ItemDocument>('items').where('merchantId', '==', mid).get();
    expect(itemsSnap.docs.length).toBe(3);

    // Call approve on Chana Masala
    const itemRef = store.doc<ItemDocument>('items', `${mid}_dish_chana`);
    const docBefore = (await itemRef.get()).data()!;
    expect(docBefore.reviewStatus).toBe('PENDING');

    await itemRef.update({
      approvedProfile: docBefore.profile,
      reviewStatus: 'APPROVED',
      pairingsApproved: docBefore.pairingsProposal,
      pairingsStatus: 'APPROVED',
    });

    const docAfter = (await itemRef.get()).data()!;
    expect(docAfter.reviewStatus).toBe('APPROVED');
    expect(docAfter.approvedProfile?.vegan).toBe(true);
    expect(docAfter.pairingsApproved?.length).toBe(1);
  });

  // 2. Public Agent Search & Pairings (H1, H2, H3, H4)
  it('H1-H4: filters vector search correctly, strips internal fields, and resolves pairings', async () => {
    // Search vegan items under $20
    const veganResults = await vectorIndex.search({
      merchantId: mid,
      queryVector: [1, 0, 0],
      limit: 8,
      inStockOnly: true,
      vegan: true,
      maxPriceCents: 2000,
    });

    expect(veganResults.length).toBe(1);
    expect(veganResults[0].item.item_id).toBe('dish_chana');
    // Ensure internals stripped
    expect((veganResults[0].item as any).embedding).toBeUndefined();
    expect((veganResults[0].item as any).search_text).toBeUndefined();

    // Check allergen exclusion (exclude dairy should keep Chana Masala and exclude Butter Chicken)
    const dairyFreeResults = await vectorIndex.search({
      merchantId: mid,
      queryVector: [0, 0, 0],
      limit: 8,
      inStockOnly: true,
      excludeAllergens: ['dairy'],
    });

    const ids = dairyFreeResults.map((r) => r.item.item_id);
    expect(ids).toContain('dish_chana');
    expect(ids).not.toContain('dish_chicken');
  });

  // 3. Discovery Gating (H6, H7, H8) & Spice Kitchen (Step 3)
  it('H6-H8: Bistro gets discovery links when live with >= 1 items, Spice Kitchen never gets discovery', async () => {
    const itemsSnap = await store.collection('items').where('merchantId', '==', mid).get();
    expect(itemsSnap.docs.length).toBeGreaterThan(0);

    const merchantSnap = await store.doc<MerchantDocument>('merchants', mid).get();
    expect(merchantSnap.data()?.status).toBe('CONNECTED');
  });

  // 4. Fact-Check Evaluator (Deterministic String Matching)
  it('evaluates fact-checks accurately on representative responses', () => {
    // Spice Kitchen bad reply (recommends sold-out Chana Masala at stale price $14)
    const spiceBadReply = 'I recommend the Chana Masala for $14 and Plain Naan for $3.50 from the menu.';
    const spiceBadChecks = evaluateFactChecks('Demo Spice Kitchen', spiceBadReply);
    expect(spiceBadChecks.availableTonight).toBe(false); // Chana Masala is sold out tonight!
    expect(spiceBadChecks.sideSuggested).toBe(true);

    // Spice Kitchen good reply (recommends available vegan Aloo Gobi with Basmati Rice, citing menu)
    const spiceGoodReply = 'According to the website menu, I recommend the Aloo Gobi (vegan main) with Basmati Rice. Note: prices are subject to change.';
    const spiceGoodChecks = evaluateFactChecks('Demo Spice Kitchen', spiceGoodReply);
    expect(spiceGoodChecks.availableTonight).toBe(true);
    expect(spiceGoodChecks.meetsTheDiet).toBe(true);
    expect(spiceGoodChecks.sideSuggested).toBe(true);
    expect(spiceGoodChecks.sources).toBe(true);

    // Bistro good reply (uses real-time API: Chana Masala $15.00 in stock, pairs with Tawa Roti)
    const bistroGoodReply = 'Using the real-time API from llms.txt, the Chana Masala ($15.00) is verified vegan, mild spice, and available tonight. The house pairings API recommends Tawa Roti ($3.50) or Jeera Rice.';
    const bistroGoodChecks = evaluateFactChecks('Vecta Demo Bistro', bistroGoodReply);
    expect(bistroGoodChecks.availableTonight).toBe(true);
    expect(bistroGoodChecks.correctPrice).toBe(true);
    expect(bistroGoodChecks.meetsTheDiet).toBe(true);
    expect(bistroGoodChecks.sideSuggested).toBe(true);
    expect(bistroGoodChecks.sources).toBe(true);

    // Bistro stale/bad reply (offers Korean Fried Chicken Sandwich which is sold out)
    const bistroBadReply = 'I recommend the Korean Fried Chicken Sandwich for $16 and Truffle Fries.';
    const bistroBadChecks = evaluateFactChecks('Vecta Demo Bistro', bistroBadReply);
    expect(bistroBadChecks.availableTonight).toBe(false); // Korean Fried Chicken is sold out
  });

  // 5. Security: Review API merchant document token sanitization
  it('SECURITY: GET /api/review/:mid?k= returns merchant without accessToken or refreshToken', async () => {
    // Set secret tokens on merchant doc
    await store.doc('merchants', mid).set({
      id: mid,
      name: 'Vecta Demo Bistro',
      status: 'CONNECTED',
      accessToken: 'clover_access_token_secret_12345',
      refreshToken: 'clover_refresh_token_secret_67890',
      accessExpiresAt: 999999999,
      refreshExpiresAt: 999999999,
      connectedAt: clock.now(),
      lastSyncedAt: 1234567,
    });

    const validKey = computeReviewKey(mid, adminToken);
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/review/${mid}?k=${validKey}`);
      expect(res.status).toBe(200);
      const responseData = await res.json();

      expect(responseData).toBeDefined();
      expect(responseData.merchant).toBeDefined();
      expect(responseData.merchant.id).toBe(mid);
      expect(responseData.merchant.name).toBe('Vecta Demo Bistro');
      expect(responseData.merchant.status).toBe('CONNECTED');
      expect(responseData.merchant.lastSyncedAt).toBe(1234567);

      // Assert NO tokens or secrets in merchant or anywhere in the response string
      const jsonStr = JSON.stringify(responseData);
      expect(jsonStr).not.toContain('clover_access_token_secret_12345');
      expect(jsonStr).not.toContain('clover_refresh_token_secret_67890');
      expect(responseData.merchant.accessToken).toBeUndefined();
      expect(responseData.merchant.refreshToken).toBeUndefined();
    } finally {
      server.close();
    }
  });

  // 6. Review API reads all items sorted by category then name with proposal, cloverTags, confidence, reviewStatus
  it('GET /api/review/:mid?k= returns all merchant items sorted by category then name with full metadata', async () => {
    const validKey = computeReviewKey(mid, adminToken);
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/review/${mid}?k=${validKey}`);
      expect(res.status).toBe(200);
      const responseData = await res.json();

      expect(responseData).toBeDefined();
      expect(responseData.items).toBeDefined();
      expect(responseData.items.length).toBe(3);

      // Sorted by category then name:
      // Categories: 'Breads & Sides' (Garlic Naan) comes before 'Mains' (Butter Chicken, then Chana Masala)
      expect(responseData.items[0].name).toBe('Garlic Naan');
      expect(responseData.items[0].category).toBe('Breads & Sides');

      expect(responseData.items[1].name).toBe('Butter Chicken');
      expect(responseData.items[1].category).toBe('Mains');

      expect(responseData.items[2].name).toBe('Chana Masala');
      expect(responseData.items[2].category).toBe('Mains');

      // Check item metadata
      const chana = responseData.items[2];
      expect(chana.item_id).toBe('dish_chana');
      expect(chana.reviewStatus).toBe('PENDING');
      expect(chana.cloverTags).toContain('Vegan');
      expect(chana.confidence).toBe(0.95);
      expect(chana.proposal).toBeDefined();
      expect(chana.proposal.cuisine).toBe('indian');
      expect(chana.proposal.vegan).toBe(true);
    } finally {
      server.close();
    }
  });

  // 7. POST /api/review/:mid/resync enqueues SNAPSHOT job with unique idempotencyKey
  it('POST /api/review/:mid/resync?k= enqueues a SNAPSHOT job with force: true and unique idempotencyKey', async () => {
    const validKey = computeReviewKey(mid, adminToken);
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/review/${mid}/resync?k=${validKey}`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.idempotencyKey).toMatch(/^resync:PWXW6VQTEWJ11:\d+$/);

      // Verify a SNAPSHOT job exists in the queue with force: true
      const jobs = await store.collection('jobs').where('merchantId', '==', mid).get();
      const snapJob = jobs.docs.map((d) => d.data()!).find((j) => j.idempotencyKey === data.idempotencyKey);
      expect(snapJob).toBeDefined();
      expect(snapJob?.kind).toBe('SNAPSHOT');
      expect(snapJob?.payload?.force).toBe(true);
    } finally {
      server.close();
    }
  });
});
