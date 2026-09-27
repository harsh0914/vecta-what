import crypto from 'crypto';
import { Store } from '../ports/store.js';
import { Clock } from '../ports/clock.js';
import { CloverClient, CloverItem } from '../ports/clover.js';
import { Llm, EnrichmentItemInput } from '../ports/llm.js';
import { Embedder } from '../ports/embedder.js';
import { VectorIndex } from '../ports/vector-index.js';
import { JobHandle, JobQueue } from '../queue/job-queue.js';
import {
  CatalogDoc,
  EventRecord,
  ItemProfile,
  ItemRecord,
  Merchant,
  RunRecord,
} from '../types.js';
import { evaluateStock, getValidAccessToken } from '../clover/clover-service.js';

const PROMPT_VERSION = 1;
const MODEL_NAME = 'gemini-3.8-flash';

export function computeSourceHash(item: Partial<CloverItem>): string {
  const catNames = (item.categories?.elements || [])
    .map((c) => c.name)
    .sort();
  const tagNames = (item.tags?.elements || [])
    .map((t) => t.name)
    .sort();

  const payload = {
    v: PROMPT_VERSION,
    model: MODEL_NAME,
    name: item.name || '',
    alternateName: item.alternateName || '',
    price: item.price || 0,
    categories: catNames,
    tags: tagNames,
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function computeStockSig(item: Partial<CloverItem>): string {
  return `${item.available ?? true}|${item.hidden ?? false}|${item.autoManage ?? false}|${item.itemStock?.quantity ?? 'null'}`;
}

export function buildCatalogDoc(
  merchantId: string,
  item: CloverItem,
  approvedProfile?: ItemProfile | null,
  embedding?: number[]
): CatalogDoc {
  const inStock = evaluateStock(item);
  const categories = (item.categories?.elements || []).map((c) => c.name);
  const tagNames = (item.tags?.elements || []).map((t) => t.name.toLowerCase());

  const hasApprovedProfile = !!approvedProfile;

  // Search text derivation
  let searchText: string;
  if (hasApprovedProfile && approvedProfile) {
    const parts = [
      item.name,
      approvedProfile.description,
      approvedProfile.cuisine,
      approvedProfile.course,
      categories.join(' '),
      approvedProfile.main_ingredients.join(' '),
      approvedProfile.flavor_tags.join(' '),
      approvedProfile.good_for,
    ];
    if (approvedProfile.vegetarian) parts.push('vegetarian');
    if (approvedProfile.vegan) parts.push('vegan');
    if (approvedProfile.gluten_free) parts.push('gluten-free');
    searchText = parts.filter(Boolean).join(' | ');
  } else {
    const rawTagNames = (item.tags?.elements || []).map((t) => t.name);
    searchText = [
      item.name,
      item.alternateName || '',
      categories.join(' '),
      rawTagNames.join(' '),
    ].filter(Boolean).join(' | ');
  }

  // Tag Overlay: Clover tags always win (SPEC §1.2, §7.2)
  let vegetarian = approvedProfile?.vegetarian ?? false;
  let vegan = approvedProfile?.vegan ?? false;
  let glutenFree = approvedProfile?.gluten_free ?? false;
  let containsAlcohol = approvedProfile?.contains_alcohol ?? false;

  if (tagNames.some((t) => t === 'vegan')) {
    vegan = true;
    vegetarian = true;
  }
  if (tagNames.some((t) => t === 'vegetarian')) {
    vegetarian = true;
  }
  if (tagNames.some((t) => t === 'gf' || t === 'gluten free' || t === 'gluten-free')) {
    glutenFree = true;
  }
  if (tagNames.some((t) => t === '21+' || t.includes('alcohol'))) {
    containsAlcohol = true;
  }

  const catalogDoc: CatalogDoc = {
    merchantId,
    item_id: item.id,
    name: item.name,
    categories,
    price_cents: item.price || 0,
    in_stock: inStock,
    stock_quantity: item.itemStock?.quantity,
    verified: hasApprovedProfile,
    search_text: searchText,
    embedding,
  };

  if (hasApprovedProfile && approvedProfile) {
    catalogDoc.description = approvedProfile.description;
    catalogDoc.cuisine = approvedProfile.cuisine;
    catalogDoc.course = approvedProfile.course;
    catalogDoc.allergens = approvedProfile.allergens;
    catalogDoc.flavor_tags = approvedProfile.flavor_tags;
    catalogDoc.spice_level = approvedProfile.spice_level;
    catalogDoc.vegetarian = vegetarian;
    catalogDoc.vegan = vegan;
    catalogDoc.gluten_free = glutenFree;
    catalogDoc.contains_alcohol = containsAlcohol;
    catalogDoc.enrichment_confidence = approvedProfile.confidence;
  }

  return catalogDoc;
}

export interface CatalogPipelineOptions {
  store: Store;
  clover: CloverClient;
  llm: Llm;
  embedder: Embedder;
  vectorIndex: VectorIndex;
  queue: JobQueue;
  clock: Clock;
}

export class CatalogPipeline {
  private store: Store;
  private clover: CloverClient;
  private llm: Llm;
  private embedder: Embedder;
  private vectorIndex: VectorIndex;
  private queue: JobQueue;
  private clock: Clock;

  // Test hooks
  private maxPagesPerRun?: number;
  private badItemToFail?: string;
  private simulatePagingSkipItemId?: string;
  private simulateLongDeliveryMs?: number;

  constructor(options: CatalogPipelineOptions) {
    this.store = options.store;
    this.clover = options.clover;
    this.llm = options.llm;
    this.embedder = options.embedder;
    this.vectorIndex = options.vectorIndex;
    this.queue = options.queue;
    this.clock = options.clock;
  }

  setMaxPagesPerRun(max?: number) {
    this.maxPagesPerRun = max;
  }

  setBadItemToFail(itemId?: string) {
    this.badItemToFail = itemId;
  }

  setSimulatePagingSkipItemId(itemId?: string) {
    this.simulatePagingSkipItemId = itemId;
  }

  setSimulateLongDelivery(ms?: number) {
    this.simulateLongDeliveryMs = ms;
  }

  async runSnapshot(handle: JobHandle): Promise<boolean> {
    const merchantId = handle.job.merchantId;
    const kind = (handle.job.payload?.kind || 'snapshot') as 'snapshot' | 'full' | 'incremental';
    const runId = handle.job.payload?.runId || handle.job.id;
    const runDocRef = this.store.doc<RunRecord>('runs', runId);

    const merchantRef = this.store.doc<Merchant>('merchants', merchantId);
    const merchantSnap = await merchantRef.get();
    const merchant = merchantSnap.data();

    // Check incremental eligibility (E8)
    if (kind === 'incremental') {
      const lastSyncedAt = merchant?.lastSyncedAt;
      const now = this.clock.now();
      // Skip if no baseline or older than 85 days
      if (!lastSyncedAt || now - lastSyncedAt > 85 * 86400 * 1000) {
        await runDocRef.set({
          id: runId,
          merchantId,
          kind,
          status: 'COMPLETE',
          cursor: 0,
          counts: { unchanged: 0, stock: 0, indexed: 0, failed: 0 },
          failedItemIds: [],
          startedAt: now,
          finishedAt: now,
        });
        return false;
      }
    }

    // Get or initialize run
    let runSnap = await runDocRef.get();
    let run: RunRecord;

    if (!runSnap.exists || !runSnap.data()) {
      const now = this.clock.now();
      const modifiedSince = kind === 'incremental' && merchant?.lastSyncedAt
        ? merchant.lastSyncedAt - 10 * 60 * 1000 // fixed at start
        : undefined;

      run = {
        id: runId,
        merchantId,
        kind,
        status: 'RUNNING',
        cursor: handle.job.payload?.cursor || 0,
        modifiedSince,
        counts: { unchanged: 0, stock: 0, indexed: 0, failed: 0 },
        failedItemIds: [],
        startedAt: now,
      };
      await runDocRef.set(run);
    } else {
      run = runSnap.data()!;
      if (run.status !== 'RUNNING') {
        return false;
      }
    }

    const executionStart = this.clock.now();
    let pagesProcessed = 0;

    // Get merchant context
    const token = await getValidAccessToken({
      store: this.store,
      clover: this.clover,
      merchantId,
      clock: this.clock,
    });
    const merchantContext = await this.clover.getMerchant(merchantId, token);

    // Page loop from run.cursor
    while (true) {
      handle.checkpoint();

      // Check delivery time budget: 8 minutes (480,000 ms)
      const elapsed = (this.clock.now() - executionStart) + (this.simulateLongDeliveryMs || 0);
      if (elapsed >= 8 * 60 * 1000) {
        await runDocRef.update({ cursor: run.cursor });
        await this.queue.yield(handle, { cursor: run.cursor, runId });
        return true; // Yielded
      }

      const currentToken = await getValidAccessToken({
        store: this.store,
        clover: this.clover,
        merchantId,
        clock: this.clock,
      });

      const pageLimit = 1000;
      const pageResult = await this.clover.listItems(
        merchantId,
        {
          limit: pageLimit,
          offset: run.cursor,
          modifiedSince: run.modifiedSince,
        },
        currentToken
      );

      let elements = pageResult.elements || [];

      // Hook: simulate offset paging skip
      if (this.simulatePagingSkipItemId) {
        elements = elements.filter((i) => i.id !== this.simulatePagingSkipItemId);
      }

      // First page of non-incremental run: save menuOutline (<= 300)
      if (run.cursor === 0 && kind !== 'incremental' && elements.length > 0) {
        const outline = elements.slice(0, 300).map((it) => {
          const cat = it.categories?.elements?.[0]?.name || 'Uncategorized';
          return `${it.name} (${cat})`;
        });
        await merchantRef.update({
          menuOutline: outline,
        });
      }

      if (elements.length > 0) {
        // Process chunks of 10, up to 4 parallel
        const chunkSize = 10;
        const chunks: CloverItem[][] = [];
        for (let i = 0; i < elements.length; i += chunkSize) {
          chunks.push(elements.slice(i, i + chunkSize));
        }

        // Process in parallel batches of 4 chunks
        for (let i = 0; i < chunks.length; i += 4) {
          const chunkBatch = chunks.slice(i, i + 4);
          await Promise.all(
            chunkBatch.map((chunk) =>
              this.processChunk(merchantId, chunk, runId, merchantContext, merchant?.menuOutline)
            )
          ).then((batchOutcomes) => {
            for (const oc of batchOutcomes) {
              run.counts.unchanged += oc.unchanged;
              run.counts.stock += oc.stock;
              run.counts.indexed += oc.indexed;
              run.counts.failed += oc.failed;
              if (oc.failedIds.length > 0) {
                run.failedItemIds.push(...oc.failedIds);
              }
            }
          });
        }
      }

      run.cursor += elements.length;
      pagesProcessed++;

      // Commit page progress
      await runDocRef.update({
        cursor: run.cursor,
        counts: run.counts,
        failedItemIds: run.failedItemIds,
      });

      // Stop condition: short page
      if (elements.length < pageLimit) {
        break;
      }

      if (this.maxPagesPerRun !== undefined && pagesProcessed >= this.maxPagesPerRun) {
        return false;
      }
    }

    // Non-incremental only: VERIFIED MARK-AND-SWEEP (SPEC §6.1, E7)
    if (kind !== 'incremental') {
      await this.runVerifiedMarkAndSweep(merchantId, runId);
    }

    // Retry failed items alone via SYNC_ITEM jobs (E5)
    for (const failedId of run.failedItemIds) {
      await this.queue.enqueue({
        kind: 'SYNC_ITEM',
        merchantId,
        payload: { itemId: failedId },
        idempotencyKey: `retry:${merchantId}:${failedId}:${runId}`,
      });
    }

    // Close run
    const finalStatus = run.failedItemIds.length > 0 ? 'COMPLETE_WITH_FAILURES' : 'COMPLETE';
    const finishedAt = this.clock.now();

    await runDocRef.update({
      status: finalStatus,
      finishedAt,
    });

    // Update merchant lastSyncedAt
    await merchantRef.update({
      lastSyncedAt: run.startedAt,
    });

    // Audit event
    await this.store.doc('events', `run_finished_${runId}`).set({
      id: `run_finished_${runId}`,
      merchantId,
      kind: 'run_finished',
      at: finishedAt,
      payload: {
        runId,
        status: finalStatus,
        counts: run.counts,
      },
    });

    // Enqueue PAIR_MENU job
    await this.queue.enqueue({
      kind: 'PAIR_MENU',
      merchantId,
      payload: { merchantId, runId },
      idempotencyKey: `pair:${merchantId}:${runId}`,
    });

    return false;
  }

  private async processChunk(
    merchantId: string,
    chunk: CloverItem[],
    runId: string,
    merchantContext: any,
    menuOutline?: string[]
  ): Promise<{ unchanged: number; stock: number; indexed: number; failed: number; failedIds: string[] }> {
    const outcome = { unchanged: 0, stock: 0, indexed: 0, failed: 0, failedIds: [] as string[] };

    // Read chunk's existing items in one getAll
    const itemRefs = chunk.map((c) => this.store.doc<ItemRecord>('items', `${merchantId}_${c.id}`));
    const existingSnaps = await this.store.getAll(...itemRefs);
    const existingMap = new Map<string, ItemRecord>();
    for (const snap of existingSnaps) {
      if (snap.exists && snap.data()) {
        existingMap.set(snap.id, snap.data()!);
      }
    }

    // Identify items needing enrichment
    const needsEnrichment: CloverItem[] = [];
    for (const it of chunk) {
      if (it.deleted) continue;
      const docId = `${merchantId}_${it.id}`;
      const existing = existingMap.get(docId);
      const sourceHash = computeSourceHash(it);

      const hasValidProfile = existing && existing.stage === 'INDEXED' && existing.sourceHash === sourceHash && (existing.profile || existing.approvedProfile);
      if (!hasValidProfile) {
        needsEnrichment.push(it);
      }
    }

    // Call Gemini for items needing enrichment
    const proposals = new Map<string, ItemProfile>();
    if (needsEnrichment.length > 0) {
      const enrichmentInputs: EnrichmentItemInput[] = needsEnrichment.map((it) => ({
        id: it.id,
        name: it.name,
        alternateName: it.alternateName,
        price: it.price,
        categories: (it.categories?.elements || []).map((c) => c.name),
        tags: (it.tags?.elements || []).map((t) => t.name),
      }));

      try {
        // Attempt batched call
        const enrichResult = await this.llm.enrichItems({
          merchantContext: merchantContext
            ? {
                name: merchantContext.name,
                city: merchantContext.address?.city,
                state: merchantContext.address?.state,
              }
            : undefined,
          menuOutline,
          items: enrichmentInputs,
        });

        for (const out of enrichResult.items) {
          proposals.set(out.item_id, out.profile);
        }

        // Retry any missing items individually (SPEC §6)
        const missing = enrichmentInputs.filter((inp) => !proposals.has(inp.id));
        for (const input of missing) {
          try {
            const singleResult = await this.llm.enrichItems({
              merchantContext: merchantContext
                ? {
                    name: merchantContext.name,
                    city: merchantContext.address?.city,
                    state: merchantContext.address?.state,
                  }
                : undefined,
              menuOutline,
              items: [input],
            });
            if (singleResult.items.length > 0) {
              proposals.set(input.id, singleResult.items[0].profile);
            }
          } catch (singleErr) {
            console.warn(`Retry enrichment failed for ${input.id}:`, singleErr);
          }
        }
      } catch (batchErr) {
        // Degrade to per-item calls (E6)
        for (const input of enrichmentInputs) {
          try {
            const singleResult = await this.llm.enrichItems({
              merchantContext: merchantContext
                ? {
                    name: merchantContext.name,
                    city: merchantContext.address?.city,
                    state: merchantContext.address?.state,
                  }
                : undefined,
              menuOutline,
              items: [input],
            });
            if (singleResult.items.length > 0) {
              proposals.set(input.id, singleResult.items[0].profile);
            }
          } catch (singleErr) {
            console.warn(`Per-item enrichment failed for ${input.id}:`, singleErr);
          }
        }
      }
    }

    // Apply per item
    for (const it of chunk) {
      if (it.deleted) continue;

      if (this.badItemToFail === it.id) {
        outcome.failed++;
        outcome.failedIds.push(it.id);
        const docId = `${merchantId}_${it.id}`;
        await this.store.doc('items', docId).set(
          {
            id: docId,
            merchantId,
            itemId: it.id,
            stage: 'FAILED',
            name: it.name,
            lastError: 'Simulated bad item error',
            lastSeenRun: runId,
            updatedAt: this.clock.now(),
          },
          { merge: true }
        );
        continue;
      }

      try {
        const itemOutcome = await this.applyItem(
          merchantId,
          it,
          existingMap.get(`${merchantId}_${it.id}`),
          proposals.get(it.id),
          runId
        );

        if (itemOutcome === 'unchanged') outcome.unchanged++;
        else if (itemOutcome === 'stock') outcome.stock++;
        else if (itemOutcome === 'indexed') outcome.indexed++;
      } catch (err: any) {
        outcome.failed++;
        outcome.failedIds.push(it.id);
        const docId = `${merchantId}_${it.id}`;
        await this.store.doc('items', docId).set(
          {
            id: docId,
            merchantId,
            itemId: it.id,
            stage: 'FAILED',
            name: it.name,
            lastError: err.message || String(err),
            lastSeenRun: runId,
            updatedAt: this.clock.now(),
          },
          { merge: true }
        );
      }
    }

    return outcome;
  }

  private async applyItem(
    merchantId: string,
    item: CloverItem,
    existing: ItemRecord | undefined,
    proposal: ItemProfile | undefined,
    runId?: string
  ): Promise<'unchanged' | 'stock' | 'indexed'> {
    const docId = `${merchantId}_${item.id}`;
    const sourceHash = computeSourceHash(item);
    const stockSig = computeStockSig(item);
    const now = this.clock.now();

    // 1. INDEXED and same sourceHash (only if it has an existing proposal or approved profile)
    const hasValidProposal = existing && existing.stage === 'INDEXED' && existing.sourceHash === sourceHash && (existing.profile || existing.approvedProfile);
    if (hasValidProposal && existing) {
      if (existing.stockSig === stockSig) {
        // Unchanged
        await this.store.doc('items', docId).update({
          lastSeenRun: runId || existing.lastSeenRun,
          updatedAt: now,
        });
        return 'unchanged';
      } else {
        // Stock-only change -> patch in_stock/stock_quantity on catalog doc without re-embedding
        const inStock = evaluateStock(item);
        const stockQty = item.itemStock?.quantity;
        await this.vectorIndex.patchStock(merchantId, item.id, inStock, stockQty);

        await this.store.doc('catalog', docId).update({
          in_stock: inStock,
          stock_quantity: stockQty,
        });

        await this.store.doc('items', docId).update({
          stockSig,
          item,
          lastSeenRun: runId || existing.lastSeenRun,
          updatedAt: now,
        });
        return 'stock';
      }
    }

    // 2. Needs enrichment or source changed
    const newProfile = proposal || (existing && existing.sourceHash === sourceHash ? existing.profile : undefined);
    // A changed source item loses its approval! (SPEC §6.3, F6)
    const approvedProfile = existing && existing.sourceHash === sourceHash ? existing.approvedProfile : null;

    // Requirement (1): an item whose enrichment returned nothing must be stage FAILED, never INDEXED with a null proposal
    if (!newProfile && !approvedProfile) {
      throw new Error(`Enrichment produced no proposal for item ${item.id} (${item.name})`);
    }

    const reviewStatus = approvedProfile && existing ? existing.reviewStatus : 'PENDING';

    // Embed catalog doc: re-embed only when search_text changes (SPEC §7)
    const catalogDoc = buildCatalogDoc(merchantId, item, approvedProfile);
    const existingCatalogSnap = await this.store.doc<CatalogDoc>('catalog', docId).get();
    const existingCatalog = existingCatalogSnap.data() || (this.vectorIndex as any).get?.(merchantId, item.id);

    if (existingCatalog?.search_text === catalogDoc.search_text && existingCatalog.embedding) {
      catalogDoc.embedding = existingCatalog.embedding;
    } else {
      const embeddings = await this.embedder.embed([`title: ${item.name} | text: ${catalogDoc.search_text}`]);
      catalogDoc.embedding = embeddings[0];
    }

    // Put into vector index
    await this.vectorIndex.put(merchantId, item.id, catalogDoc);
    await this.store.doc('catalog', docId).set(catalogDoc);

    const itemRecord: ItemRecord = {
      id: docId,
      merchantId,
      itemId: item.id,
      stage: 'INDEXED',
      name: item.name,
      sourceHash,
      stockSig,
      item,
      profile: newProfile,
      reviewStatus,
      approvedProfile,
      lastError: null,
      lastSeenRun: runId || existing?.lastSeenRun,
      updatedAt: now,
    };

    await this.store.doc('items', docId).set(itemRecord);
    return 'indexed';
  }

  async syncItem(handle: JobHandle): Promise<void> {
    const merchantId = handle.job.merchantId;
    const itemId = handle.job.payload.itemId;
    const token = await getValidAccessToken({
      store: this.store,
      clover: this.clover,
      merchantId,
      clock: this.clock,
    });

    let cloverItem: CloverItem;
    try {
      cloverItem = await this.clover.getItem(merchantId, itemId, token);
    } catch (err: any) {
      if (err.status === 404) {
        // Deleted
        await this.deleteItem(merchantId, itemId);
        return;
      }
      throw err;
    }

    if (cloverItem.deleted) {
      await this.deleteItem(merchantId, itemId);
      return;
    }

    const docId = `${merchantId}_${itemId}`;
    const snap = await this.store.doc<ItemRecord>('items', docId).get();
    const existing = snap.data();
    const sourceHash = computeSourceHash(cloverItem);

    let proposal: ItemProfile | undefined = undefined;
    const hasValidProfile = existing && existing.stage === 'INDEXED' && existing.sourceHash === sourceHash && (existing.profile || existing.approvedProfile);
    if (!hasValidProfile) {
      const enrichmentInputs = [
        {
          id: cloverItem.id,
          name: cloverItem.name,
          alternateName: cloverItem.alternateName,
          price: cloverItem.price,
          categories: (cloverItem.categories?.elements || []).map((c) => c.name),
          tags: (cloverItem.tags?.elements || []).map((t) => t.name),
        },
      ];
      try {
        const merchantContext = await this.clover.getMerchant(merchantId, token);
        const res = await this.llm.enrichItems({
          merchantContext: merchantContext
            ? { name: merchantContext.name, city: merchantContext.address?.city, state: merchantContext.address?.state }
            : undefined,
          items: enrichmentInputs,
        });
        if (res.items.length > 0) {
          proposal = res.items[0].profile;
        }
      } catch (err) {
        console.warn(`Enrichment in syncItem failed for ${itemId}:`, err);
      }
    }

    // Apply item
    await this.applyItem(merchantId, cloverItem, existing, proposal);
  }

  private async deleteItem(merchantId: string, itemId: string): Promise<void> {
    const docId = `${merchantId}_${itemId}`;
    await this.vectorIndex.delete(merchantId, itemId);
    await this.store.doc('catalog', docId).delete();
    await this.store.doc('items', docId).set(
      {
        id: docId,
        merchantId,
        itemId,
        stage: 'DELETED',
        updatedAt: this.clock.now(),
      },
      { merge: true }
    );
  }

  private async runVerifiedMarkAndSweep(merchantId: string, runId: string): Promise<void> {
    const itemsSnap = await this.store.collection<ItemRecord>('items')
      .where('merchantId', '==', merchantId)
      .get();

    const token = await getValidAccessToken({
      store: this.store,
      clover: this.clover,
      merchantId,
      clock: this.clock,
    });

    for (const doc of itemsSnap.docs) {
      const item = doc.data();
      if (!item) continue;
      if (item.stage === 'DELETED') continue;

      if (item.lastSeenRun !== runId) {
        // Candidate for deletion: re-fetch from Clover
        try {
          const fresh = await this.clover.getItem(merchantId, item.itemId, token);
          if (fresh.deleted) {
            await this.deleteItem(merchantId, item.itemId);
          } else {
            // Still exists! Re-sync and mark seen (E7)
            await this.applyItem(merchantId, fresh, item, undefined, runId);
          }
        } catch (err: any) {
          if (err.status === 404) {
            await this.deleteItem(merchantId, item.itemId);
          }
        }
      }
    }
  }
}
