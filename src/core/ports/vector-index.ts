import { AllergenType, CatalogDoc, CourseType } from '../types.js';

export interface VectorSearchQuery {
  merchantId: string;
  queryVector: number[];
  limit: number;
  inStockOnly?: boolean;
  vegetarian?: boolean;
  vegan?: boolean;
  glutenFree?: boolean;
  maxSpice?: number;
  course?: CourseType;
  maxPriceCents?: number;
  excludeAllergens?: AllergenType[];
}

export interface VectorSearchResult {
  item: CatalogDoc;
  score: number;
}

export interface VectorIndex {
  put(merchantId: string, itemId: string, doc: CatalogDoc): Promise<void>;
  patchStock(
    merchantId: string,
    itemId: string,
    inStock: boolean,
    stockQuantity?: number
  ): Promise<void>;
  delete(merchantId: string, itemId: string): Promise<void>;
  findNearest(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
  search?(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
}
