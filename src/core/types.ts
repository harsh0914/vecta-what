/**
 * Domain types for Vecta-what
 */

export interface Merchant {
  id: string; // Clover mId
  status: 'CONNECTED' | 'DISCONNECTED';
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch seconds
  refreshExpiresAt: number; // epoch seconds
  refreshLeaseUntil?: number; // epoch seconds
  name?: string;
  context?: {
    city?: string;
    state?: string;
    country?: string;
  };
  menuOutline?: string[]; // max 300 entries "Name (Category)"
  pairingMenuHash?: string;
  connectedAt?: number; // epoch ms
  lastSyncedAt?: number; // epoch ms
  disconnectedReason?: string;
}

export type CourseType =
  | 'appetizer'
  | 'soup_salad'
  | 'main'
  | 'side'
  | 'bread'
  | 'dessert'
  | 'drink'
  | 'other';

export type AllergenType =
  | 'dairy'
  | 'egg'
  | 'gluten'
  | 'peanut'
  | 'tree_nut'
  | 'soy'
  | 'shellfish'
  | 'fish'
  | 'sesame';

export interface ItemProfile {
  description: string;
  cuisine: string;
  course: CourseType;
  vegetarian: boolean;
  vegan: boolean;
  gluten_free: boolean;
  contains_alcohol: boolean;
  spice_level: 0 | 1 | 2 | 3;
  allergens: AllergenType[];
  main_ingredients: string[];
  flavor_tags: string[];
  good_for: string;
  confidence: number;
}

export type PairingRole =
  | 'bread'
  | 'rice'
  | 'side'
  | 'drink'
  | 'dessert'
  | 'starter'
  | 'main';

export interface Pairing {
  item_id: string;
  name?: string;
  role: PairingRole;
  reason: string;
  approved?: boolean;
}

export type ItemStage = 'FETCHED' | 'ENRICHED' | 'INDEXED' | 'DELETED' | 'FAILED';
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'EDITED';

export interface ItemRecord {
  id: string; // `${mid}_${itemId}`
  merchantId: string;
  itemId: string;
  stage: ItemStage;
  name: string;
  sourceHash: string;
  stockSig: string;
  item: any; // Raw Clover item
  profile?: ItemProfile; // Gemini proposal
  reviewStatus: ReviewStatus;
  approvedProfile?: ItemProfile | null;
  pairingsProposal?: Pairing[];
  pairingsApproved?: Pairing[];
  pairingsStatus?: 'PENDING' | 'APPROVED';
  lastError?: string | null;
  lastSeenRun?: string;
  updatedAt: number;
  reviewedAt?: number;
}

export interface CatalogDoc {
  merchantId: string;
  item_id: string;
  name: string;
  categories: string[];
  price_cents: number;
  in_stock: boolean;
  stock_quantity?: number;
  verified: boolean; // true if approved profile is present
  search_text: string;
  embeddedTextHash?: string;
  embedding?: number[]; // 768 dims
  // Profile fields (present only when verified = true):
  description?: string;
  cuisine?: string;
  course?: CourseType;
  allergens?: AllergenType[];
  flavor_tags?: string[];
  spice_level?: number;
  vegetarian?: boolean;
  vegan?: boolean;
  gluten_free?: boolean;
  contains_alcohol?: boolean;
  enrichment_confidence?: number;
}

export type RunKind = 'snapshot' | 'full' | 'incremental';
export type RunStatus = 'RUNNING' | 'COMPLETE' | 'COMPLETE_WITH_FAILURES';

export interface RunRecord {
  id: string;
  merchantId: string;
  kind: RunKind;
  status: RunStatus;
  cursor: number;
  modifiedSince?: number;
  counts: {
    unchanged: number;
    stock: number;
    indexed: number;
    failed: number;
  };
  failedItemIds: string[];
  startedAt: number;
  finishedAt?: number;
}

export type JobKind = 'SNAPSHOT' | 'SYNC_ITEM' | 'PAIR_MENU';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'RETRY' | 'DONE' | 'DEAD';

export interface JobRecord {
  id: string; // sha256(idempotencyKey)[0:32]
  kind: JobKind;
  merchantId: string;
  payload: any;
  runId?: string;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  leaseUntil: number; // epoch ms
  nextAttemptAt: number; // epoch ms
  lastError?: string | null;
  result?: any;
  createdAt: number;
  updatedAt: number;
}

export type InboxType = 'installed' | 'clover_webhook';
export type InboxStatus = 'NEW' | 'DONE' | 'FAILED';

export interface InboxRecord {
  id: string;
  type: InboxType;
  merchantId: string;
  key: string;
  body: any;
  status: InboxStatus;
  attempts: number;
  createdAt: number;
}

export interface EventRecord {
  id: string;
  merchantId: string;
  kind: string;
  at: number;
  payload?: any;
}
