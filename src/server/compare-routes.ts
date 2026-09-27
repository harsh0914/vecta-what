import { Router, Request, Response } from 'express';
import { Llm } from '../core/ports/llm.js';
import { BISTRO_GROUND_TRUTH, SPICE_KITCHEN_GROUND_TRUTH } from './discovery-routes.js';

export interface FactCheckResult {
  availableTonight: boolean;
  correctPrice: boolean;
  meetsTheDiet: boolean;
  sideSuggested: boolean;
  sources: boolean;
}

export function evaluateFactChecks(
  storeName: 'Demo Spice Kitchen' | 'Vecta Demo Bistro',
  reply: string,
  prompt?: string
): FactCheckResult {
  const replyLower = reply.toLowerCase();

  // 1. Available tonight: no recommended item sold out
  let availableTonight = true;
  if (storeName === 'Demo Spice Kitchen') {
    // Sold out: Chana Masala, Veggie Burger
    const recommendsChana = replyLower.includes('chana masala') && !replyLower.includes('chana masala is sold out') && !replyLower.includes('chana masala is out of stock');
    const recommendsVeggieBurger = replyLower.includes('veggie burger') && !replyLower.includes('veggie burger is sold out');
    if (recommendsChana || recommendsVeggieBurger) {
      availableTonight = false;
    }
  } else {
    // Bistro sold out: Korean Fried Chicken Sandwich
    if (replyLower.includes('korean fried chicken') && !replyLower.includes('sold out')) {
      availableTonight = false;
    }
  }

  // 2. Correct price: every quoted price matches truth
  let correctPrice = true;
  if (storeName === 'Demo Spice Kitchen') {
    // Stale site has Samosas 7 (truth is 8), Aloo Gobi 13 (truth is 15)
    // If reply quotes stale prices "$7" or "7 dollars" or "$13" or "13 dollars"
    if (replyLower.includes('$7') || replyLower.includes('7 dollars') || replyLower.includes('$13') || replyLower.includes('13 dollars')) {
      correctPrice = false;
    }
  } else {
    // Bistro stale site has Burrata 15 (truth 16)
    if (replyLower.includes('burrata') && (replyLower.includes('$15') || replyLower.includes('15 dollars'))) {
      correctPrice = false;
    }
  }

  // 3. Meets the diet (vegan asked in default prompt)
  let meetsTheDiet = false;
  if (storeName === 'Demo Spice Kitchen') {
    // If agent recommended Chana Masala (which is sold out), it fails availability.
    // If agent recommended Aloo Gobi or Baingan Bharta without dairy naan -> vegan
    const hasVeganMain = replyLower.includes('aloo gobi') || replyLower.includes('baingan bharta');
    // If agent recommends Palak Paneer, Chicken Tikka, Paneer Pakora, Goat Curry -> non-vegan
    const hasNonVeganMain = replyLower.includes('palak paneer') || replyLower.includes('chicken') || replyLower.includes('goat') || replyLower.includes('paneer pakora');
    if (hasVeganMain && !hasNonVeganMain) {
      meetsTheDiet = true;
    }
  } else {
    // Bistro: Chana Masala ($15), Quinoa Bowl ($14.50), Pad Thai Tofu ($16.50), Impossible Burger ($18)
    const hasVeganMain = replyLower.includes('chana masala') || replyLower.includes('quinoa') || replyLower.includes('pad thai') || replyLower.includes('impossible');
    const hasNonVeganMain = replyLower.includes('butter chicken') || replyLower.includes('paneer') || replyLower.includes('lamb') || replyLower.includes('salmon');
    if (hasVeganMain && !hasNonVeganMain) {
      meetsTheDiet = true;
    }
  }

  // 4. Side suggested (a real available side or drink)
  const sidesAndDrinks = [
    'naan', 'roti', 'rice', 'raita', 'fries', 'mac & cheese', 'mac and cheese',
    'lassi', 'chai', 'soda', 'lemonade', 'brew', 'kheer', 'sorbet', 'gulab jamun'
  ];
  const sideSuggested = sidesAndDrinks.some((side) => replyLower.includes(side));

  // 5. Sources: reply cites where facts came from
  const sourceKeywords = [
    'llms.txt', 'agent-card', 'agent card', 'api', 'http', 'menu', 'website',
    'fetched', 'source', 'page', 'site', 'published', 'catalog'
  ];
  const sources = sourceKeywords.some((kw) => replyLower.includes(kw));

  return {
    availableTonight,
    correctPrice,
    meetsTheDiet,
    sideSuggested,
    sources,
  };
}

export interface CompareRoutesOptions {
  llm: Llm;
  ownBaseUrl?: string;
}

export function createCompareRouter(options: CompareRoutesOptions): Router {
  const router = Router();
  const { llm } = options;

  // SSRF guard helper
  function validateUrl(targetUrl: string, hostHeader?: string): { ok: boolean; parsed?: URL; error?: string } {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Only http and https protocols allowed' };
      }
      const allowedHosts = new Set(['localhost', '127.0.0.1']);
      if (hostHeader) {
        allowedHosts.add(hostHeader.split(':')[0]);
      }
      if (process.env.PUBLIC_BASE_URL) {
        try {
          allowedHosts.add(new URL(process.env.PUBLIC_BASE_URL).hostname);
        } catch {}
      }

      if (!allowedHosts.has(parsed.hostname)) {
        return { ok: false, error: `SSRF guard: host ${parsed.hostname} is not allowed (own host only)` };
      }

      return { ok: true, parsed };
    } catch (err: any) {
      return { ok: false, error: `Invalid URL: ${err.message}` };
    }
  }

  async function executeFetchUrl(url: string, hostHeader?: string) {
    const check = validateUrl(url, hostHeader);
    if (!check.ok || !check.parsed) {
      return { status: 403, error: check.error || 'Blocked by SSRF guard' };
    }

    try {
      const res = await fetch(url);
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();

      const headLinks: Array<{ rel?: string; href?: string; type?: string; name?: string; content?: string }> = [];

      if (contentType.includes('text/html')) {
        // Extract head links and meta tags
        const headMatch = text.match(/<head[\s\S]*?<\/head>/i);
        if (headMatch) {
          const headContent = headMatch[0];
          // Links
          const linkRegex = /<link\s+([^>]+)>/gi;
          let m: RegExpExecArray | null;
          while ((m = linkRegex.exec(headContent)) !== null) {
            const attrs = m[1];
            if (!attrs.includes('stylesheet')) {
              const rel = attrs.match(/rel=["']([^"']+)["']/i)?.[1];
              const href = attrs.match(/href=["']([^"']+)["']/i)?.[1];
              const type = attrs.match(/type=["']([^"']+)["']/i)?.[1];
              headLinks.push({ rel, href, type });
            }
          }
          // Meta tags
          const metaRegex = /<meta\s+([^>]+)>/gi;
          while ((m = metaRegex.exec(headContent)) !== null) {
            const attrs = m[1];
            if (attrs.includes('ai-agent')) {
              const name = attrs.match(/name=["']([^"']+)["']/i)?.[1];
              const content = attrs.match(/content=["']([^"']+)["']/i)?.[1];
              headLinks.push({ name, content });
            }
          }
        }

        // Strip HTML
        const stripped = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 12000);

        return {
          status: res.status,
          content_type: contentType,
          head_links: headLinks,
          text: stripped,
        };
      }

      return {
        status: res.status,
        content_type: contentType,
        head_links: [],
        text: text.slice(0, 12000),
      };
    } catch (fetchErr: any) {
      return { status: 500, error: fetchErr.message || 'Fetch failed' };
    }
  }

  // POST /api/assistant (SPEC §11.2)
  router.post('/api/assistant', async (req: Request, res: Response) => {
    try {
      const message = req.body?.message;
      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'Message string required' });
        return;
      }

      const hostHeader = req.get('host');
      const fetchedUrls: string[] = [];

      const systemInstruction = `You are a general AI assistant with access to a browser tool (fetch_url).
You know nothing about Vecta or any proprietary APIs ahead of time.
Instructions:
1. Open the requested URL using fetch_url.
2. If the page or its <head> links point to resources published for AI agents (agent-card.json, llms.txt, or an API), read and prefer them over scraping HTML.
3. Be concrete, cite where each fact came from, and explicitly say when you are guessing or when data is unverified.
4. Only call fetch_url on URLs provided or found on the site.`;

      const result = await llm.executeAgentTurn({
        systemInstruction,
        messages: [{ role: 'user', content: message }],
        tools: [
          {
            type: 'function',
            name: 'fetch_url',
            description: 'Fetch content from a URL on the host. Returns status, content_type, head_links, and text.',
            parameters: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'The URL to fetch' },
              },
              required: ['url'],
            },
          },
        ],
        executeTool: async (name, args) => {
          if (name === 'fetch_url') {
            fetchedUrls.push(args.url);
            return await executeFetchUrl(args.url, hostHeader);
          }
          throw new Error(`Unknown tool: ${name}`);
        },
      });

      res.json({
        reply: result.reply,
        fetched: fetchedUrls,
      });
    } catch (err: any) {
      console.error('[assistant-router] /api/assistant error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // POST /api/compare { prompt }
  router.post('/api/compare', async (req: Request, res: Response) => {
    try {
      const promptTemplate = req.body?.prompt || "I'm vegan, spend under $20, and don't like very spicy food. Using {site}, pick me a main course that's actually available tonight, and tell me what to order with it.";
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      const runStore = async (storeName: 'Demo Spice Kitchen' | 'Vecta Demo Bistro', sitePath: string) => {
        const start = Date.now();
        const siteUrl = `${baseUrl}${sitePath}`;
        const userPrompt = promptTemplate.replace('{site}', siteUrl);
        const fetchedUrls: string[] = [];

        try {
          const systemInstruction = `You are a general AI assistant with a browser (fetch_url).
You know nothing about internal systems. Open the site using fetch_url.
If the site or its <head> links point to resources published for AI agents (such as llms.txt, agent-card.json, or an API), read and prefer them over scraping.
Be concrete, cite where each fact came from, and state when guessing.`;

          const result = await llm.executeAgentTurn({
            systemInstruction,
            messages: [{ role: 'user', content: userPrompt }],
            tools: [
              {
                type: 'function',
                name: 'fetch_url',
                description: 'Fetch URL content',
                parameters: {
                  type: 'object',
                  properties: { url: { type: 'string' } },
                  required: ['url'],
                },
              },
            ],
            executeTool: async (name, args) => {
              if (name === 'fetch_url') {
                fetchedUrls.push(args.url);
                return await executeFetchUrl(args.url, req.get('host'));
              }
              throw new Error(`Unknown tool: ${name}`);
            },
          });

          const seconds = ((Date.now() - start) / 1000).toFixed(1);
          const checks = evaluateFactChecks(storeName, result.reply, userPrompt);

          return {
            store: storeName,
            reply: result.reply,
            seconds: parseFloat(seconds),
            fetched: fetchedUrls,
            checks,
          };
        } catch (err: any) {
          console.error(`[compare-router] runStore error for ${storeName}:`, err);
          const seconds = ((Date.now() - start) / 1000).toFixed(1);
          const reply = `Error querying ${storeName}: ${err.message || String(err)}`;
          const checks = evaluateFactChecks(storeName, reply, userPrompt);
          return {
            store: storeName,
            reply,
            seconds: parseFloat(seconds),
            fetched: fetchedUrls,
            checks,
          };
        }
      };

      // Run both in parallel
      const [spiceRes, bistroRes] = await Promise.all([
        runStore('Demo Spice Kitchen', '/sites/spice'),
        runStore('Vecta Demo Bistro', '/sites/bistro'),
      ]);

      res.json([spiceRes, bistroRes]);
    } catch (err: any) {
      console.error('[compare-router] compare error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  return router;
}
