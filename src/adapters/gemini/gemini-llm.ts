import { GoogleGenAI, Type } from '@google/genai';
import {
  AgentTurnRequest,
  AgentTurnResult,
  EnrichmentItemOutput,
  EnrichmentRequest,
  EnrichmentResult,
  Llm,
  PairingAnchorOutput,
  PairingRequest,
  PairingResult,
} from '../../core/ports/llm.js';
import { ItemProfile, PairingRole } from '../../core/types.js';
import { getVertexGenAIClient, getTextModelName } from './gemini-client.js';

export class GeminiLlm implements Llm {
  private ai: GoogleGenAI;
  private model: string;

  constructor(apiKeyOrClient?: any, model = 'gemini-2.5-flash') {
    this.ai = getVertexGenAIClient();
    this.model = getTextModelName(model);
  }

  async enrichItems(req: EnrichmentRequest): Promise<EnrichmentResult> {
    const itemProfileSchema = {
      type: Type.OBJECT,
      properties: {
        description: { type: Type.STRING, description: '1-2 appetizing sentences, no invented claims' },
        cuisine: { type: Type.STRING, description: 'lowercase cuisine e.g. indian, italian, american' },
        course: {
          type: Type.STRING,
          enum: ['appetizer', 'soup_salad', 'main', 'side', 'bread', 'dessert', 'drink', 'other'],
        },
        vegetarian: { type: Type.BOOLEAN },
        vegan: { type: Type.BOOLEAN },
        gluten_free: { type: Type.BOOLEAN },
        contains_alcohol: { type: Type.BOOLEAN },
        spice_level: { type: Type.INTEGER, description: '0 to 3' },
        allergens: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
            enum: ['dairy', 'egg', 'gluten', 'peanut', 'tree_nut', 'soy', 'shellfish', 'fish', 'sesame'],
          },
        },
        main_ingredients: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '3-6 ingredients',
        },
        flavor_tags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '3-6 flavor tags',
        },
        good_for: { type: Type.STRING },
        confidence: { type: Type.NUMBER, description: '0 to 1 confidence about diet/allergen fields' },
      },
      required: [
        'description',
        'cuisine',
        'course',
        'vegetarian',
        'vegan',
        'gluten_free',
        'contains_alcohol',
        'spice_level',
        'allergens',
        'main_ingredients',
        'flavor_tags',
        'good_for',
        'confidence',
      ],
    };

    const enrichmentResponseSchema = {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              item_id: { type: Type.STRING },
              profile: itemProfileSchema,
            },
            required: ['item_id', 'profile'],
          },
        },
      },
      required: ['items'],
    };

    const systemInstruction = `You are a culinary expert normalizing sparse restaurant POS catalog records.
Infer cuisine, course, diet flags, allergens, and ingredients from item name, categories, tags, and restaurant context.
Rules:
- Merchant tags are ground truth. If a tag says vegan/gf/vegetarian, honor it.
- Be conservative on vegan and gluten_free: if uncertain, set false and lower confidence.
- description: 1-2 appetizing sentences, no invented facts.
- cuisine: lowercase string.
- allergens: only from closed list {dairy, egg, gluten, peanut, tree_nut, soy, shellfish, fish, sesame}.
- course: only from closed list {appetizer, soup_salad, main, side, bread, dessert, drink, other}.
- spice_level: 0 (none), 1 (mild), 2 (medium), 3 (hot).
- confidence: 0.0 to 1.0 representing certainty on diet and allergens.
- Output JSON matching schema with exactly one entry per item with item_id preserved.`;

    const inputData = {
      merchant: req.merchantContext,
      menuOutline: req.menuOutline?.slice(0, 300),
      itemsToEnrich: req.items,
    };

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [{ text: JSON.stringify(inputData) }],
        },
      ],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: enrichmentResponseSchema,
        thinkingConfig: {
          thinkingLevel: 'low' as any,
        },
        maxOutputTokens: 32768,
      },
    });

    const jsonText = response.text?.trim() || '';
    if (!jsonText) {
      throw new Error('Gemini generateContent returned empty response for enrichment');
    }

    const parsed = JSON.parse(jsonText);
    return {
      items: parsed.items || [],
    };
  }

  async generatePairings(req: PairingRequest): Promise<PairingResult> {
    const pairingResponseSchema = {
      type: Type.OBJECT,
      properties: {
        anchors: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              anchor_id: { type: Type.STRING },
              pairs: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    item_id: { type: Type.STRING },
                    role: {
                      type: Type.STRING,
                      enum: ['bread', 'rice', 'side', 'drink', 'dessert', 'starter', 'main'],
                    },
                    reason: { type: Type.STRING },
                  },
                  required: ['item_id', 'role', 'reason'],
                },
              },
            },
            required: ['anchor_id', 'pairs'],
          },
        },
      },
      required: ['anchors'],
    };

    const systemInstruction = `You are a restaurant head-server recommending pairings.
Rules:
- Recommend up to 4 items from the provided menu that a guest would genuinely order WITH the anchor item.
- Start from what it is classically served with; prefer its own cuisine.
- Cross-cuisine is allowed ONLY when it plays that classic role here (e.g. garlic naan standing in for crusty bread with burrata), and the reason MUST explicitly say so.
- Never pair across cuisines merely because two items share a course.
- Complement, never duplicate (saucy pairs with bread/rice, spicy pairs with cooling yogurt/drink/raita/lassi).
- Fewer good pairings beat forced ones; returning empty pairs is completely fine.
- role must be one of: bread, rice, side, drink, dessert, starter, main.
- Return JSON matching schema.`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: JSON.stringify({
                menu: req.menu,
                anchors: req.anchors,
              }),
            },
          ],
        },
      ],
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: pairingResponseSchema,
        thinkingConfig: {
          thinkingLevel: 'low' as any,
        },
        maxOutputTokens: 32768,
      },
    });

    const jsonText = response.text?.trim() || '';
    if (!jsonText) {
      throw new Error('Gemini pairing generateContent returned empty response');
    }

    const parsed = JSON.parse(jsonText);
    return {
      anchors: parsed.anchors || [],
    };
  }

  async executeAgentTurn(req: AgentTurnRequest): Promise<AgentTurnResult> {
    const toolsConfig =
      req.tools && req.tools.length > 0
        ? [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            },
          ]
        : undefined;

    const contents: any[] = req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content,
    }));

    const toolCallsMade: Array<{ name: string; args: any; result: any }> = [];
    let finalText = '';

    for (let round = 0; round < 6; round++) {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: req.systemInstruction,
          tools: toolsConfig as any,
        },
      });

      const functionCalls = response.functionCalls || [];
      const text = response.text || '';
      const candidate = response.candidates?.[0];
      const modelContent = candidate?.content;

      if (modelContent) {
        contents.push(modelContent);
      } else if (text) {
        contents.push({ role: 'model', parts: [{ text }] });
      }

      if (functionCalls.length > 0 && req.executeTool) {
        const functionResponseParts: any[] = [];
        for (const fc of functionCalls) {
          const result = await req.executeTool(fc.name, fc.args);
          toolCallsMade.push({
            name: fc.name,
            args: fc.args,
            result,
          });
          functionResponseParts.push({
            functionResponse: {
              name: fc.name,
              response: typeof result === 'object' && result !== null ? result : { output: result },
            },
          });
        }
        contents.push({
          role: 'user',
          parts: functionResponseParts,
        });
      } else {
        finalText =
          text ||
          modelContent?.parts
            ?.map((p: any) => p.text)
            .filter(Boolean)
            .join('\n') ||
          '';
        break;
      }
    }

    return {
      reply: finalText,
      toolCallsMade,
      sessionId: req.sessionId,
    };
  }
}
