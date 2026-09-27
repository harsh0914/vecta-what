import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Store } from '../core/ports/store.js';
import { Embedder } from '../core/ports/embedder.js';
import { VectorIndex } from '../core/ports/vector-index.js';
import { JobQueue } from '../core/queue/job-queue.js';
import { ItemDocument, ItemRecord, MerchantDocument, Pairing } from '../core/types.js';
import { buildCatalogDoc } from '../core/pipeline/catalog-pipeline.js';

export function computeReviewKey(mid: string, adminToken?: string): string {
  const secret = adminToken || process.env.ADMIN_TOKEN || 'default-admin-token';
  return crypto.createHmac('sha256', secret).update(mid).digest('hex').slice(0, 24);
}

export function verifyReviewKey(mid: string, key?: string, adminToken?: string): boolean {
  if (!key) return false;
  const expected = computeReviewKey(mid, adminToken);
  if (key.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  } catch {
    return false;
  }
}

export interface ReviewRoutesOptions {
  store: Store;
  embedder: Embedder;
  vectorIndex: VectorIndex;
  queue?: JobQueue;
  adminToken?: string;
}

export function createReviewRouter(options: ReviewRoutesOptions): Router {
  const router = Router();
  const { store, embedder, vectorIndex, queue, adminToken } = options;

  // Middleware to verify capability key (?k= or ?key= or Header X-Review-Key)
  const requireReviewKey = (req: Request, res: Response, next: () => void) => {
    const mid = req.params.mid;
    const key = (req.query.k as string) || (req.query.key as string) || (req.headers['x-review-key'] as string);
    if (!verifyReviewKey(mid, key, adminToken)) {
      res.status(403).json({ error: 'Invalid or missing review key' });
      return;
    }
    next();
  };

  // GET /api/review/:mid
  router.get('/api/review/:mid', requireReviewKey, async (req: Request, res: Response) => {
    try {
      const mid = req.params.mid;
      const merchantSnap = await store.doc<MerchantDocument>('merchants', mid).get();
      const rawMerchant = merchantSnap.data();

      // SECURITY: Never return tokens or secrets to the client
      const merchant = {
        id: rawMerchant?.id || mid,
        name: rawMerchant?.name || 'Demo Bistro',
        status: rawMerchant?.status || 'CONNECTED',
        lastSyncedAt: rawMerchant?.lastSyncedAt,
      };

      // Query all items for this merchant (same scope as overview)
      const itemsSnap = await store.collection<ItemRecord>('items').where('merchantId', '==', mid).get();

      const rawItems = itemsSnap.docs
        .map((d) => d.data())
        .filter((d): d is ItemRecord => !!d && d.stage !== 'DELETED');

      // Build pairings map for item names
      const itemNameMap = new Map<string, string>();
      for (const it of rawItems) {
        const itemId = it.itemId || it.item?.id || (it as any).rawItem?.id;
        const name = it.name || it.item?.name || (it as any).rawItem?.name || itemId;
        if (itemId) itemNameMap.set(itemId, name);
      }

      // Format response items
      const items = rawItems.map((doc) => {
        const raw = doc.item || (doc as any).rawItem || {};
        const itemId = doc.itemId || raw.id || doc.id?.split('_')?.[1];
        const name = doc.name || raw.name || itemId;
        const categories = (raw.categories?.elements || raw.categories || []).map((c: any) => (typeof c === 'string' ? c : c.name)).filter(Boolean);
        const tags = (raw.tags?.elements || raw.tags || []).map((t: any) => (typeof t === 'string' ? t : t.name)).filter(Boolean);

        const proposedPairings = doc.pairingsProposal || [];
        const approvedPairingIds = new Set((doc.pairingsApproved || []).map((p) => p.item_id));

        const pairingsWithNames = proposedPairings.map((p) => ({
          item_id: p.item_id,
          role: p.role,
          reason: p.reason,
          name: itemNameMap.get(p.item_id) || p.item_id,
          approved: doc.pairingsStatus === 'APPROVED' ? approvedPairingIds.has(p.item_id) : true,
        }));

        const primaryCategory = categories[0] || 'Uncategorized';
        const confidence = doc.profile?.confidence ?? (doc.approvedProfile?.confidence ?? 1.0);

        return {
          item_id: itemId,
          name,
          price_cents: raw.price || 0,
          categories,
          tags,
          cloverTags: tags,
          category: primaryCategory,
          status: doc.reviewStatus || 'PENDING',
          reviewStatus: doc.reviewStatus || 'PENDING',
          proposal: doc.profile || null,
          approved: doc.approvedProfile || null,
          confidence,
          pairings: pairingsWithNames,
          pairings_status: doc.pairingsStatus || 'PENDING',
        };
      });

      // Sort by category then name
      items.sort((a, b) => {
        const catCompare = a.category.localeCompare(b.category);
        if (catCompare !== 0) return catCompare;
        return a.name.localeCompare(b.name);
      });

      res.json({
        merchant,
        items,
      });
    } catch (err: any) {
      console.error('[review-router] GET /api/review error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // POST /api/review/:mid/bulk-approve
  router.post('/api/review/:mid/bulk-approve', requireReviewKey, async (req: Request, res: Response) => {
    try {
      const mid = req.params.mid;
      const itemsSnap = await store.collection<ItemRecord>('items').where('merchantId', '==', mid).get();

      let approvedCount = 0;
      for (const d of itemsSnap.docs) {
        const itemDoc = d.data();
        const raw = itemDoc?.item || (itemDoc as any)?.rawItem;
        const itemId = itemDoc?.itemId || raw?.id;

        if (
          itemDoc &&
          raw &&
          itemDoc.stage === 'INDEXED' &&
          itemDoc.reviewStatus === 'PENDING' &&
          itemDoc.profile &&
          itemDoc.profile.confidence >= 0.8
        ) {
          const approvedProfile = itemDoc.profile;
          const pairingsApproved = itemDoc.pairingsProposal || [];

          // Rebuild catalog doc
          const catalogDoc = buildCatalogDoc(mid, raw, approvedProfile);
          const embeddings = await embedder.embed([`title: ${raw.name} | text: ${catalogDoc.search_text}`]);
          catalogDoc.embedding = embeddings[0];

          await store.doc<ItemDocument>('items', `${mid}_${itemId}`).update({
            approvedProfile,
            reviewStatus: 'APPROVED',
            pairingsApproved,
            pairingsStatus: 'APPROVED',
            updatedAt: Date.now(),
          });

          await store.doc('catalog', `${mid}_${itemId}`).set(catalogDoc);
          await vectorIndex.put(mid, itemId, catalogDoc);
          approvedCount++;
        }
      }

      console.log(`[metric] review_bulk_approve merchant=${mid} count=${approvedCount}`);
      res.json({ success: true, approvedCount });
    } catch (err: any) {
      console.error('[review-router] bulk-approve error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // POST /api/review/:mid/resync
  router.post('/api/review/:mid/resync', requireReviewKey, async (req: Request, res: Response) => {
    try {
      const mid = req.params.mid;
      const now = Date.now();
      const idempotencyKey = `resync:${mid}:${now}`;

      if (queue) {
        await queue.enqueue({
          kind: 'SNAPSHOT',
          merchantId: mid,
          idempotencyKey,
          payload: { kind: 'snapshot', merchantId: mid, force: true },
        });
      }

      console.log(`[metric] review_resync merchant=${mid} idempotencyKey=${idempotencyKey}`);
      res.json({ success: true, message: 'Resync SNAPSHOT job enqueued', idempotencyKey });
    } catch (err: any) {
      console.error('[review-router] POST /api/review/:mid/resync error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // POST /api/review/:mid/:itemId
  router.post('/api/review/:mid/:itemId', requireReviewKey, async (req: Request, res: Response) => {
    try {
      const mid = req.params.mid;
      const itemId = req.params.itemId;
      const { action, profile, pairing_ids } = req.body || {};

      if (!action || (action !== 'approve' && action !== 'edit')) {
        res.status(400).json({ error: 'Action must be approve or edit' });
        return;
      }

      const itemRef = store.doc<ItemRecord>('items', `${mid}_${itemId}`);
      const itemSnap = await itemRef.get();
      const existing = itemSnap.data();

      if (!existing || existing.stage !== 'INDEXED' || (!existing.profile && !existing.approvedProfile)) {
        res.status(404).json({ error: 'Item not eligible for review (must be INDEXED with profile)' });
        return;
      }

      const raw = existing.item || (existing as any).rawItem || { id: itemId, name: existing.name };
      let approvedProfile = existing.approvedProfile;
      let reviewStatus = existing.reviewStatus;

      if (action === 'approve') {
        approvedProfile = profile || existing.profile || existing.approvedProfile;
        reviewStatus = 'APPROVED';
      } else if (action === 'edit') {
        if (!profile) {
          res.status(400).json({ error: 'Profile edits required for edit action' });
          return;
        }
        // Merge edits over existing profile
        const base = existing.profile || existing.approvedProfile || {};
        approvedProfile = {
          ...base,
          ...profile,
        };
        // Validate required ItemProfile fields
        if (
          !approvedProfile.description ||
          !approvedProfile.cuisine ||
          !approvedProfile.course ||
          approvedProfile.spice_level === undefined ||
          approvedProfile.confidence === undefined
        ) {
          res.status(400).json({ error: 'Invalid profile schema: missing required fields' });
          return;
        }
        reviewStatus = 'EDITED';
      }

      // Filter pairings
      let pairingsApproved: Pairing[] = [];
      const proposed = existing.pairingsProposal || [];
      if (Array.isArray(pairing_ids)) {
        const idSet = new Set(pairing_ids);
        pairingsApproved = proposed.filter((p) => idSet.has(p.item_id));
      } else {
        pairingsApproved = proposed;
      }

      // Rebuild catalog doc
      const catalogDoc = buildCatalogDoc(mid, raw, approvedProfile);
      const embeddings = await embedder.embed([`title: ${raw.name} | text: ${catalogDoc.search_text}`]);
      catalogDoc.embedding = embeddings[0];

      await itemRef.update({
        approvedProfile,
        reviewStatus,
        pairingsApproved,
        pairingsStatus: 'APPROVED',
        updatedAt: Date.now(),
      });

      await store.doc('catalog', `${mid}_${itemId}`).set(catalogDoc);
      await vectorIndex.put(mid, itemId, catalogDoc);

      console.log(`[metric] review_${action} merchant=${mid} item=${itemId} status=${reviewStatus}`);
      res.json({ item_id: itemId, review_status: reviewStatus });
    } catch (err: any) {
      console.error('[review-router] POST review item error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  return router;
}
