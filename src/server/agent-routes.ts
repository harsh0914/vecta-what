import { Router, Request, Response } from 'express';
import { Store } from '../core/ports/store.js';
import { Embedder } from '../core/ports/embedder.js';
import { VectorIndex, VectorSearchQuery } from '../core/ports/vector-index.js';
import { ItemDocument, CatalogDoc, CourseType, AllergenType } from '../core/types.js';

export interface AgentRoutesOptions {
  store: Store;
  embedder: Embedder;
  vectorIndex: VectorIndex;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export function createAgentRouter(options: AgentRoutesOptions): Router {
  const router = Router();
  const { store, embedder, vectorIndex } = options;

  // Rate limiting token buckets: client IP -> TokenBucket
  const ipBuckets = new Map<string, TokenBucket>();
  // Daily budget: merchantId -> count
  const merchantDailyUsage = new Map<string, { count: number; day: string }>();
  // 2-minute query response cache: cacheKey -> { time: number, response: any }
  const queryCache = new Map<string, { time: number; data: any }>();

  // Guard middleware
  const abuseGuard = (req: Request, res: Response, next: () => void) => {
    // CORS open
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }

    const mid = req.params.mid;
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '127.0.0.1';
    const now = Date.now();

    // 1. Token bucket per client (burst 20, 30/min -> refill 0.5 tokens/sec)
    let bucket = ipBuckets.get(clientIp);
    if (!bucket) {
      bucket = { tokens: 20, lastRefill: now };
      ipBuckets.set(clientIp, bucket);
    } else {
      const elapsedSec = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(20, bucket.tokens + elapsedSec * 0.5);
      bucket.lastRefill = now;
    }

    if (bucket.tokens < 1) {
      res.status(429).json({ error: 'Client rate limit exceeded (burst 20, 30/min)' });
      return;
    }
    bucket.tokens -= 1;

    // 2. Per-merchant daily budget (5000 requests / day)
    const today = new Date().toISOString().slice(0, 10);
    let merchantUsage = merchantDailyUsage.get(mid);
    if (!merchantUsage || merchantUsage.day !== today) {
      merchantUsage = { count: 0, day: today };
      merchantDailyUsage.set(mid, merchantUsage);
    }
    merchantUsage.count++;
    if (merchantUsage.count > 5000) {
      res.status(429).json({ error: 'Merchant daily query quota exceeded' });
      return;
    }

    next();
  };

  // GET /agents/:mid/search
  router.get('/agents/:mid/search', abuseGuard, async (req: Request, res: Response) => {
    try {
      const mid = req.params.mid;
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

      if (q.length > 200) {
        res.status(400).json({ error: 'Query q must be between 1 and 200 characters' });
        return;
      }

      // Check 2-minute cache
      const cacheKey = `search:${mid}:${req.url}`;
      const cached = queryCache.get(cacheKey);
      if (cached && Date.now() - cached.time < 120_000) {
        res.json(cached.data);
        return;
      }

      // Query vector
      let queryVector: number[] = [];
      if (q) {
        const queryEmbeddings = await embedder.embed([`task: search result | query: ${q}`]);
        queryVector = queryEmbeddings[0] || [];
      } else {
        queryVector = new Array(768).fill(0);
      }

      // Parse query filters
      const maxPrice = req.query.max_price ? parseFloat(req.query.max_price as string) : undefined;
      const maxPriceCents = maxPrice !== undefined && !isNaN(maxPrice) ? Math.round(maxPrice * 100) : undefined;
      const vegetarian = req.query.vegetarian === 'true';
      const vegan = req.query.vegan === 'true';
      const glutenFree = req.query.gluten_free === 'true';
      const maxSpice = req.query.max_spice ? parseInt(req.query.max_spice as string, 10) : undefined;
      const course = req.query.course as CourseType | undefined;
      const excludeAllergens = typeof req.query.exclude_allergens === 'string'
        ? (req.query.exclude_allergens.split(',').map((s) => s.trim().toLowerCase()) as AllergenType[])
        : undefined;

      const searchQuery: VectorSearchQuery = {
        merchantId: mid,
        queryVector,
        limit: 8,
        inStockOnly: true,
        vegetarian: vegetarian || undefined,
        vegan: vegan || undefined,
        glutenFree: glutenFree || undefined,
        maxSpice: maxSpice !== undefined && !isNaN(maxSpice) ? maxSpice : undefined,
        course: course || undefined,
        maxPriceCents,
        excludeAllergens,
      };

      const results = await vectorIndex.search(searchQuery);

      let hasUnverified = false;
      const publicItems = results.slice(0, 8).map(({ item }) => {
        if (!item.verified) {
          hasUnverified = true;
        }
        const formattedPrice = `$${((item.price_cents || 0) / 100).toFixed(2)}`;

        return {
          item_id: item.item_id,
          name: item.name,
          description: item.description,
          price: formattedPrice,
          categories: item.categories || [],
          cuisine: item.cuisine,
          course: item.course,
          vegetarian: item.vegetarian ?? false,
          vegan: item.vegan ?? false,
          gluten_free: item.gluten_free ?? false,
          contains_alcohol: item.contains_alcohol ?? false,
          spice_level: item.spice_level,
          allergens: item.allergens || [],
          flavor_tags: item.flavor_tags || [],
          in_stock: item.in_stock,
          verified: item.verified,
        };
      });

      const responsePayload: any = {
        count: publicItems.length,
        items: publicItems,
      };

      if (hasUnverified) {
        responsePayload.note = 'Some items have verified=false: unreviewed menu details; confirm with staff.';
      }

      // Cache response for 2 minutes
      queryCache.set(cacheKey, { time: Date.now(), data: responsePayload });

      res.json(responsePayload);
    } catch (err: any) {
      console.error('[agent-router] search error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // GET /agents/:mid/pairings?dish=
  router.get('/agents/:mid/pairings', abuseGuard, async (req: Request, res: Response) => {
    try {
      const mid = req.params.mid;
      const dish = typeof req.query.dish === 'string' ? req.query.dish.trim() : '';

      if (!dish) {
        res.status(400).json({ error: 'Query param dish is required' });
        return;
      }

      const cacheKey = `pairings:${mid}:${dish.toLowerCase()}`;
      const cached = queryCache.get(cacheKey);
      if (cached && Date.now() - cached.time < 120_000) {
        res.json(cached.data);
        return;
      }

      // Find top-1 matching dish for this merchant
      const itemsSnap = await store.collection<ItemDocument>('items').where('merchantId', '==', mid).get();
      const allItems = itemsSnap.docs.map((d) => d.data()).filter(Boolean);

      const dishLower = dish.toLowerCase();
      let bestItem: ItemDocument | undefined = allItems.find(
        (it) => it.rawItem.name.toLowerCase() === dishLower
      );

      if (!bestItem) {
        bestItem = allItems.find((it) => it.rawItem.name.toLowerCase().includes(dishLower));
      }

      if (!bestItem) {
        res.json({
          found: false,
          dish,
          pairings: [],
          has_approved_pairings: false,
        });
        return;
      }

      const hasApprovedPairings = (bestItem.pairingsApproved || []).length > 0;
      const approvedPairings = bestItem.pairingsApproved || [];

      // Map pairings to in-stock items with price
      const catalogSnap = await store.collection<CatalogDoc>('catalog').where('merchantId', '==', mid).get();
      const catalogMap = new Map<string, CatalogDoc>();
      for (const d of catalogSnap.docs) {
        const cat = d.data();
        if (cat) {
          catalogMap.set(cat.item_id, cat);
        }
      }

      const publicPairings = approvedPairings
        .map((p) => {
          const cat = catalogMap.get(p.item_id);
          const inStock = cat ? cat.in_stock : true;
          const priceCents = cat ? cat.price_cents : 0;
          return {
            name: cat ? cat.name : p.item_id,
            role: p.role,
            reason: p.reason,
            price: `$${(priceCents / 100).toFixed(2)}`,
            in_stock: inStock,
          };
        })
        .filter((p) => p.in_stock); // In-stock only (SPEC §9.1)

      const responsePayload = {
        found: true,
        dish: bestItem.rawItem.name,
        pairings: publicPairings,
        has_approved_pairings: hasApprovedPairings,
      };

      queryCache.set(cacheKey, { time: Date.now(), data: responsePayload });
      res.json(responsePayload);
    } catch (err: any) {
      console.error('[agent-router] pairings error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  return router;
}
