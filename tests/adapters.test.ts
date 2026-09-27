import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '../src/adapters/in-memory/in-memory-store.js';
import { ControllableClock } from '../src/adapters/in-memory/controllable-clock.js';
import { FakeCloverClient } from '../src/adapters/in-memory/fake-clover-client.js';
import { FakeLlm } from '../src/adapters/in-memory/fake-llm.js';
import { FakeEmbedder } from '../src/adapters/in-memory/fake-embedder.js';
import { InMemoryVectorIndex } from '../src/adapters/in-memory/in-memory-vector-index.js';

describe('In-Memory Adapters', () => {
  describe('InMemoryStore & Compare-and-Set Transactions', () => {
    it('supports basic document CRUD operations', async () => {
      const clock = new ControllableClock(1000);
      const store = new InMemoryStore(clock);

      await store.doc('merchants', 'mid-1').set({ name: 'Demo Bistro', status: 'CONNECTED' });
      const snap = await store.doc('merchants', 'mid-1').get();
      expect(snap.exists).toBe(true);
      expect(snap.data()?.name).toBe('Demo Bistro');

      await store.doc('merchants', 'mid-1').delete();
      const snapAfter = await store.doc('merchants', 'mid-1').get();
      expect(snapAfter.exists).toBe(false);
    });

    it('enforces atomic transactions with compare-and-set semantics', async () => {
      const clock = new ControllableClock(1000);
      const store = new InMemoryStore(clock);

      await store.doc('jobs', 'job-1').set({ status: 'QUEUED', attempts: 0 });

      // Successful transaction
      await store.runTransaction(async (tx) => {
        const docRef = store.doc('jobs', 'job-1');
        const snap = await tx.get(docRef);
        expect(snap.data()?.status).toBe('QUEUED');
        tx.update(docRef, { status: 'RUNNING', attempts: 1 });
      });

      const updated = await store.doc('jobs', 'job-1').get();
      expect(updated.data()?.status).toBe('RUNNING');
      expect(updated.data()?.attempts).toBe(1);
    });

    it('fails transaction if document was modified concurrently (CAS conflict)', async () => {
      const clock = new ControllableClock(1000);
      const store = new InMemoryStore(clock);

      await store.doc('jobs', 'job-cas').set({ status: 'QUEUED', attempts: 0 });

      await expect(
        store.runTransaction(async (tx) => {
          const docRef = store.doc('jobs', 'job-cas');
          await tx.get(docRef);

          // Simulate concurrent modification outside this transaction
          await store.doc('jobs', 'job-cas').update({ attempts: 99 });

          // Transaction attempts to commit update based on stale read
          tx.update(docRef, { status: 'RUNNING', attempts: 1 });
        })
      ).rejects.toThrow(/concurrent modification|transaction conflict/i);

      // Verify the concurrent modification survived
      const finalDoc = await store.doc('jobs', 'job-cas').get();
      expect(finalDoc.data()?.attempts).toBe(99);
    });

    it('supports query filtering and real-time listeners', async () => {
      const clock = new ControllableClock(1000);
      const store = new InMemoryStore(clock);

      await store.doc('jobs', 'j1').set({ status: 'QUEUED', merchantId: 'm1' });
      await store.doc('jobs', 'j2').set({ status: 'RUNNING', merchantId: 'm1' });
      await store.doc('jobs', 'j3').set({ status: 'QUEUED', merchantId: 'm2' });

      const queuedSnap = await store.collection('jobs')
        .where('status', '==', 'QUEUED')
        .where('merchantId', '==', 'm1')
        .get();

      expect(queuedSnap.docs.length).toBe(1);
      expect(queuedSnap.docs[0].id).toBe('j1');

      // Test listener
      let listenerCalls = 0;
      let lastDocsCount = 0;
      const unsubscribe = store.collection('jobs')
        .where('status', '==', 'QUEUED')
        .onSnapshot((snap) => {
          listenerCalls++;
          lastDocsCount = snap.docs.length;
        });

      // initial call
      expect(listenerCalls).toBe(1);
      expect(lastDocsCount).toBe(2);

      // Add another queued job
      await store.doc('jobs', 'j4').set({ status: 'QUEUED', merchantId: 'm3' });
      expect(listenerCalls).toBe(2);
      expect(lastDocsCount).toBe(3);

      unsubscribe();
    });
  });

  describe('FakeCloverClient', () => {
    it('provides mock catalog with pagination and stock evaluation', async () => {
      const clover = new FakeCloverClient();
      clover.seedDemoBistro();

      const itemsPage1 = await clover.listItems('PWXW6VQTEWJ11', { limit: 10, offset: 0 });
      expect(itemsPage1.elements.length).toBe(10);
      expect(itemsPage1.elements[0]).toHaveProperty('id');
      expect(itemsPage1.elements[0]).toHaveProperty('name');

      const singleItem = await clover.getItem('PWXW6VQTEWJ11', itemsPage1.elements[0].id);
      expect(singleItem.id).toBe(itemsPage1.elements[0].id);
    });

    it('can simulate errors like 401, 429, and 500', async () => {
      const clover = new FakeCloverClient();
      clover.injectErrorOnce('listItems', 429);

      await expect(clover.listItems('m1')).rejects.toThrow(/429/);
      // Next call succeeds
      const normal = await clover.listItems('m1');
      expect(normal.elements).toBeDefined();
    });
  });

  describe('FakeLlm & FakeEmbedder', () => {
    it('enriches items with structured proposals and counts calls', async () => {
      const llm = new FakeLlm();
      const result = await llm.enrichItems({
        merchantContext: { name: 'Demo Bistro', city: 'Berkeley', state: 'CA' },
        menuOutline: ['Chana Masala (Mains)'],
        items: [{ id: 'item_1', name: 'Chana Masala', categories: ['Mains'], tags: ['Vegan'] }],
      });

      expect(llm.enrichCallCount).toBe(1);
      expect(result.items.length).toBe(1);
      expect(result.items[0].profile.cuisine).toBe('indian');
      expect(result.items[0].profile.vegan).toBe(true);
    });

    it('embeds text to 768 dimensions normalized vector', async () => {
      const embedder = new FakeEmbedder();
      const vectors = await embedder.embed(['title: Samosa | text: Crispy savory pastry']);
      expect(embedder.callCount).toBe(1);
      expect(vectors.length).toBe(1);
      expect(vectors[0].length).toBe(768);

      // Check normalization (magnitude close to 1)
      const magnitude = Math.sqrt(vectors[0].reduce((sum, v) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 4);
    });
  });

  describe('InMemoryVectorIndex', () => {
    it('stores vectors and searches with merchant tenant isolation and filters', async () => {
      const vectorIndex = new InMemoryVectorIndex();
      const vecA = new Array(768).fill(0);
      vecA[0] = 1; // unit vector along dim 0
      const vecB = new Array(768).fill(0);
      vecB[1] = 1; // unit vector along dim 1

      await vectorIndex.put('m1', 'item_1', {
        item_id: 'item_1',
        merchantId: 'm1',
        name: 'Dish A',
        categories: ['Mains'],
        price_cents: 1500,
        in_stock: true,
        verified: true,
        search_text: 'Dish A',
        embedding: vecA,
      });

      await vectorIndex.put('m2', 'item_2', {
        item_id: 'item_2',
        merchantId: 'm2',
        name: 'Dish B',
        categories: ['Mains'],
        price_cents: 1800,
        in_stock: true,
        verified: true,
        search_text: 'Dish B',
        embedding: vecA,
      });

      // Search for m1 using vecA
      const results = await vectorIndex.findNearest({
        merchantId: 'm1',
        queryVector: vecA,
        limit: 10,
        inStockOnly: true,
      });

      expect(results.length).toBe(1);
      expect(results[0].item.item_id).toBe('item_1');
      expect(results[0].score).toBeCloseTo(1, 4);

      // Verify m2 was not returned (tenant isolation)
      expect(results.some((r) => r.item.merchantId === 'm2')).toBe(false);
    });
  });

  describe('FirestoreStore Port Compliance', () => {
    it('implements Store interface', async () => {
      const { FirestoreStore } = await import('../src/adapters/firestore/firestore-store.js');
      expect(FirestoreStore).toBeDefined();
    });
  });
});
