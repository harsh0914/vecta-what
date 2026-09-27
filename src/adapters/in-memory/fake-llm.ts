import {
  AgentTurnRequest,
  AgentTurnResult,
  EnrichmentItemOutput,
  EnrichmentRequest,
  EnrichmentResult,
  Llm,
  PairingAnchorOutput,
  PairingPairOutput,
  PairingRequest,
  PairingResult,
} from '../../core/ports/llm.js';
import { ItemProfile } from '../../core/types.js';

export class FakeLlm implements Llm {
  public enrichCallCount = 0;
  public pairingCallCount = 0;
  public agentCallCount = 0;

  private shouldFailNextEnrich = false;
  private shouldFailIncomplete = false;
  private omitItemIds = new Set<string>();

  setFailNextEnrich(fail: boolean): void {
    this.shouldFailNextEnrich = fail;
  }

  setFailIncomplete(fail: boolean): void {
    this.shouldFailIncomplete = fail;
  }

  setOmitItemIds(ids: string[]): void {
    this.omitItemIds = new Set(ids);
  }

  async enrichItems(req: EnrichmentRequest): Promise<EnrichmentResult> {
    this.enrichCallCount++;

    if (this.shouldFailNextEnrich) {
      this.shouldFailNextEnrich = false;
      throw new Error('Fake LLM enrichment failure');
    }

    if (this.shouldFailIncomplete) {
      this.shouldFailIncomplete = false;
      const err: any = new Error('Interaction incomplete (max_output_tokens exceeded)');
      err.status = 'incomplete';
      throw err;
    }

    const items: EnrichmentItemOutput[] = [];
    for (const it of req.items) {
      if (this.omitItemIds.has(it.id)) {
        this.omitItemIds.delete(it.id);
        continue;
      }
      const nameLower = it.name.toLowerCase();
      const tags = (it.tags ?? []).map((t) => t.toLowerCase());

      const isVegan = tags.includes('vegan') || nameLower.includes('vegan') || nameLower.includes('tofu') || nameLower.includes('chana');
      const isVegetarian = isVegan || tags.includes('vegetarian') || nameLower.includes('paneer') || nameLower.includes('burrata') || nameLower.includes('cheese');
      const isGF = tags.includes('gf') || tags.includes('gluten free');
      const containsAlcohol = tags.includes('21+') || nameLower.includes('margarita') || nameLower.includes('ipa') || nameLower.includes('beer');

      let spiceLevel: 0 | 1 | 2 | 3 = 0;
      if (tags.includes('spicy') || nameLower.includes('vindaloo')) spiceLevel = 3;
      else if (nameLower.includes('tikka') || nameLower.includes('65')) spiceLevel = 2;
      else if (nameLower.includes('curry') || nameLower.includes('masala')) spiceLevel = 1;

      let course: any = 'main';
      const cat = (it.categories?.[0] ?? '').toLowerCase();
      if (cat.includes('small') || cat.includes('starter')) course = 'appetizer';
      else if (cat.includes('soup') || cat.includes('salad')) course = 'soup_salad';
      else if (cat.includes('bread') || cat.includes('side')) course = nameLower.includes('naan') || nameLower.includes('roti') ? 'bread' : 'side';
      else if (cat.includes('dessert')) course = 'dessert';
      else if (cat.includes('drink') || cat.includes('beverage')) course = 'drink';

      let cuisine = 'american';
      if (nameLower.includes('masala') || nameLower.includes('naan') || nameLower.includes('roti') || nameLower.includes('samosa') || nameLower.includes('raita') || nameLower.includes('lassi') || nameLower.includes('chai') || nameLower.includes('vindaloo') || nameLower.includes('paneer')) {
        cuisine = 'indian';
      } else if (nameLower.includes('pad thai') || nameLower.includes('tom kha')) {
        cuisine = 'thai';
      } else if (nameLower.includes('burrata') || nameLower.includes('risotto')) {
        cuisine = 'italian';
      }

      const allergens: any[] = [];
      if (!isVegan && (isVegetarian || nameLower.includes('cheese') || nameLower.includes('paneer') || nameLower.includes('burrata') || nameLower.includes('butter') || nameLower.includes('lassi') || nameLower.includes('raita'))) {
        allergens.push('dairy');
      }
      if (!isGF && (nameLower.includes('naan') || nameLower.includes('roti') || nameLower.includes('burger') || nameLower.includes('cake'))) {
        allergens.push('gluten');
      }

      const profile: ItemProfile = {
        description: `Authentic ${it.name}, freshly prepared with quality ingredients.`,
        cuisine,
        course,
        vegetarian: isVegetarian,
        vegan: isVegan,
        gluten_free: isGF,
        contains_alcohol: containsAlcohol,
        spice_level: spiceLevel,
        allergens,
        main_ingredients: [it.name.split(' ')[0], 'seasoning', 'herbs'],
        flavor_tags: ['savory', 'flavorful', 'house-specialty'],
        good_for: 'lunch or dinner',
        confidence: 0.95,
      };

      items.push({
        item_id: it.id,
        profile,
      });
    }

    return { items };
  }

  async generatePairings(req: PairingRequest): Promise<PairingResult> {
    this.pairingCallCount++;
    const anchors: PairingAnchorOutput[] = req.anchors.map((anchor) => {
      const anchorName = anchor.name.toLowerCase();
      const pairs: PairingPairOutput[] = [];

      // Look for complementary items in menu
      for (const m of req.menu) {
        if (m.id === anchor.id) continue;
        const mName = m.name.toLowerCase();

        // Indian curries pair with Naan, Roti, Rice, Raita
        if (anchorName.includes('masala') || anchorName.includes('butter chicken') || anchorName.includes('vindaloo')) {
          if (mName.includes('garlic naan')) {
            pairs.push({ item_id: m.id, role: 'bread', reason: 'Warm garlic naan is classic for soaking up rich curry sauces.' });
          } else if (mName.includes('jeera rice')) {
            pairs.push({ item_id: m.id, role: 'rice', reason: 'Aromatic cumin rice provides the perfect neutral base for the spiced sauce.' });
          } else if (mName.includes('cucumber raita')) {
            pairs.push({ item_id: m.id, role: 'side', reason: 'Cooling yogurt raita tempers the spice.' });
          } else if (mName.includes('mango lassi')) {
            pairs.push({ item_id: m.id, role: 'drink', reason: 'Sweet mango lassi balances bold spices.' });
          }
        }
      }

      return {
        anchor_id: anchor.id,
        pairs: pairs.slice(0, 4),
      };
    });

    return { anchors };
  }

  async executeAgentTurn(req: AgentTurnRequest): Promise<AgentTurnResult> {
    this.agentCallCount++;
    const lastMsg = req.messages[req.messages.length - 1];
    const text = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content);

    const toolCallsMade: Array<{ name: string; args: any; result: any }> = [];

    // Simulate tool use if search_menu or fetch_url tools exist
    if (req.tools && req.executeTool) {
      if (text.toLowerCase().includes('vegan') || text.toLowerCase().includes('recommend') || text.toLowerCase().includes('dinner')) {
        const searchTool = req.tools.find((t) => t.name === 'search_menu');
        if (searchTool) {
          const args = { query: 'dinner', vegan: text.toLowerCase().includes('vegan') };
          const result = await req.executeTool('search_menu', args);
          toolCallsMade.push({ name: 'search_menu', args, result });
          return {
            reply: `Here are our recommended vegan options: ${JSON.stringify(result)}`,
            toolCallsMade,
            sessionId: req.sessionId ?? 'session_1',
          };
        }
      }

      if (text.toLowerCase().includes('http') || text.toLowerCase().includes('site')) {
        const fetchTool = req.tools.find((t) => t.name === 'fetch_url');
        if (fetchTool) {
          const urlMatch = text.match(/https?:\/\/[^\s]+/);
          const url = urlMatch ? urlMatch[0] : 'https://example.com';
          const result = await req.executeTool('fetch_url', { url });
          toolCallsMade.push({ name: 'fetch_url', args: { url }, result });
          return {
            reply: `I fetched ${url} and found the menu information.`,
            toolCallsMade,
            sessionId: req.sessionId ?? 'session_1',
          };
        }
      }
    }

    return {
      reply: `I am your assistant. How can I help you today?`,
      toolCallsMade,
      sessionId: req.sessionId ?? 'session_1',
    };
  }
}
