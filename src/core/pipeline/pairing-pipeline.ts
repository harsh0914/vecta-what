import crypto from 'crypto';
import { Store } from '../ports/store.js';
import { Clock } from '../ports/clock.js';
import { Llm, PairingAnchorInput, PairingPairOutput } from '../ports/llm.js';
import { JobHandle } from '../queue/job-queue.js';
import { ItemRecord, Merchant, PairingRole } from '../types.js';

export const PAIRING_VERSION = 1;

export const VALID_ROLES = new Set<PairingRole>([
  'bread',
  'rice',
  'side',
  'drink',
  'dessert',
  'starter',
  'main',
]);

export interface PairingPipelineOptions {
  store: Store;
  llm: Llm;
  clock: Clock;
}

export class PairingPipeline {
  private store: Store;
  private llm: Llm;
  private clock: Clock;
  private pairingVersion = PAIRING_VERSION;

  constructor(options: PairingPipelineOptions) {
    this.store = options.store;
    this.llm = options.llm;
    this.clock = options.clock;
  }

  setPairingVersion(v: number): void {
    this.pairingVersion = v;
  }

  async runPairing(handle: JobHandle): Promise<void> {
    const merchantId = handle.job.merchantId;
    const merchantRef = this.store.doc<Merchant>('merchants', merchantId);
    const merchantSnap = await merchantRef.get();
    const merchant = merchantSnap.data();

    // Query all INDEXED items for merchant
    const itemsSnap = await this.store.collection<ItemRecord>('items')
      .where('merchantId', '==', merchantId)
      .where('stage', '==', 'INDEXED')
      .get();

    const items = itemsSnap.docs
      .map((d) => d.data())
      .filter((it): it is ItemRecord => !!it && it.stage === 'INDEXED');

    // Skip if > 500 live items (SPEC §6.6)
    if (items.length > 500) {
      return;
    }

    if (items.length === 0) {
      return;
    }

    // Build menu representation for prompt
    const menu: PairingAnchorInput[] = items.map((it) => {
      const activeProfile = it.approvedProfile || it.profile;
      return {
        id: it.itemId,
        name: it.name,
        categories: (it.item?.categories?.elements || []).map((c: any) => c.name),
        tags: (it.item?.tags?.elements || []).map((t: any) => t.name),
        price: it.item?.price,
        cuisine: activeProfile?.cuisine,
        course: activeProfile?.course,
        spice_level: activeProfile?.spice_level,
        description: activeProfile?.description,
      };
    });

    const menuIds = new Set(menu.map((m) => m.id));

    // Hash check: skip if unchanged
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ menu, v: this.pairingVersion }))
      .digest('hex');

    if (merchant?.pairingsHash === hash) {
      return;
    }

    // Chunk anchors into slices of 15
    const chunkSize = 15;
    const anchorChunks: PairingAnchorInput[][] = [];
    for (let i = 0; i < menu.length; i += chunkSize) {
      anchorChunks.push(menu.slice(i, i + chunkSize));
    }

    for (const chunk of anchorChunks) {
      handle.checkpoint();

      const result = await this.llm.generatePairings({
        menu,
        anchors: chunk,
      });

      for (const anchorResult of result.anchors) {
        // Validate returned pairs
        const validPairs: PairingPairOutput[] = [];
        for (const pair of anchorResult.pairs) {
          // Rule: valid item_id, not self, valid role, max 4
          if (!menuIds.has(pair.item_id)) continue;
          if (pair.item_id === anchorResult.anchor_id) continue;
          if (!VALID_ROLES.has(pair.role)) continue;
          validPairs.push({
            item_id: pair.item_id,
            role: pair.role,
            reason: pair.reason,
          });
          if (validPairs.length >= 4) break;
        }

        const docId = `${merchantId}_${anchorResult.anchor_id}`;
        const itemRef = this.store.doc<ItemRecord>('items', docId);

        // Update item with proposal (keep approved pairings live until re-reviewed)
        await itemRef.update({
          pairingsProposal: validPairs,
          pairingsStatus: 'PENDING',
          updatedAt: this.clock.now(),
        });
      }
    }

    // Save hash on merchant doc
    await merchantRef.update({
      pairingsHash: hash,
    });
  }
}
