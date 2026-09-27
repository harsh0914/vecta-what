import {
  VectorIndex,
  VectorSearchQuery,
  VectorSearchResult,
} from '../../core/ports/vector-index.js';
import { CatalogDoc } from '../../core/types.js';

export class InMemoryVectorIndex implements VectorIndex {
  private items = new Map<string, CatalogDoc>();

  private key(merchantId: string, itemId: string): string {
    return `${merchantId}_${itemId}`;
  }

  get(merchantId: string, itemId: string): CatalogDoc | undefined {
    const doc = this.items.get(this.key(merchantId, itemId));
    return doc ? JSON.parse(JSON.stringify(doc)) : undefined;
  }

  async put(merchantId: string, itemId: string, doc: CatalogDoc): Promise<void> {
    this.items.set(this.key(merchantId, itemId), JSON.parse(JSON.stringify(doc)));
  }

  async patchStock(
    merchantId: string,
    itemId: string,
    inStock: boolean,
    stockQuantity?: number
  ): Promise<void> {
    const k = this.key(merchantId, itemId);
    const existing = this.items.get(k);
    if (existing) {
      existing.in_stock = inStock;
      if (stockQuantity !== undefined) {
        existing.stock_quantity = stockQuantity;
      }
    }
  }

  async delete(merchantId: string, itemId: string): Promise<void> {
    this.items.delete(this.key(merchantId, itemId));
  }

  async findNearest(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const candidates: Array<{ item: CatalogDoc; score: number }> = [];

    for (const doc of this.items.values()) {
      // 1. Tenant pre-filter MUST match merchantId
      if (doc.merchantId !== query.merchantId) {
        continue;
      }

      // 2. In stock filter
      if (query.inStockOnly && !doc.in_stock) {
        continue;
      }

      // 3. Post-filters
      if (query.vegetarian && !doc.vegetarian) {
        continue;
      }
      if (query.vegan && !doc.vegan) {
        continue;
      }
      if (query.glutenFree && !doc.gluten_free) {
        continue;
      }
      if (query.maxSpice !== undefined && (doc.spice_level === undefined || doc.spice_level > query.maxSpice)) {
        continue;
      }
      if (query.course && doc.course !== query.course) {
        continue;
      }
      if (query.maxPriceCents !== undefined && doc.price_cents > query.maxPriceCents) {
        continue;
      }
      if (query.excludeAllergens && query.excludeAllergens.length > 0) {
        const itemAllergens = doc.allergens || [];
        const hasExcluded = query.excludeAllergens.some((a) => itemAllergens.includes(a));
        if (hasExcluded) {
          continue;
        }
      }

      if (!doc.embedding) {
        continue;
      }

      // Compute dot product
      let dot = 0;
      for (let i = 0; i < query.queryVector.length; i++) {
        dot += query.queryVector[i] * (doc.embedding[i] ?? 0);
      }

      const itemCopy = JSON.parse(JSON.stringify(doc));
      delete itemCopy.search_text;
      delete itemCopy.embedding;

      candidates.push({
        item: itemCopy,
        score: dot,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, query.limit);
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    return this.findNearest(query);
  }
}
