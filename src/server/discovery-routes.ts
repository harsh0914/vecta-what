import { Router, Request, Response } from 'express';
import { Store } from '../core/ports/store.js';
import { MerchantDocument, ItemDocument } from '../core/types.js';

export const DEMO_BISTRO_MERCHANT_ID = process.env.DEMO_MERCHANT_ID || 'PWXW6VQTEWJ11';

// Ground truth for Demo Spice Kitchen (Oakland)
export interface MenuItemTruth {
  name: string;
  price: number;
  available: boolean;
  vegan: boolean;
  vegetarian: boolean;
  gluten_free: boolean;
  spice_level?: number;
  notes?: string;
}

export const SPICE_KITCHEN_GROUND_TRUTH: Record<string, MenuItemTruth> = {
  'Vegetable Samosas': { name: 'Vegetable Samosas', price: 8.00, available: true, vegan: true, vegetarian: true, gluten_free: false },
  'Paneer Pakora': { name: 'Paneer Pakora', price: 10.00, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Lentil Soup': { name: 'Lentil Soup', price: 9.00, available: true, vegan: true, vegetarian: true, gluten_free: true },
  'Chana Masala': { name: 'Chana Masala', price: 14.00, available: false, vegan: true, vegetarian: true, gluten_free: true, notes: 'SOLD OUT' },
  'Aloo Gobi': { name: 'Aloo Gobi', price: 15.00, available: true, vegan: true, vegetarian: true, gluten_free: true },
  'Baingan Bharta': { name: 'Baingan Bharta', price: 16.00, available: true, vegan: true, vegetarian: true, gluten_free: true },
  'Palak Paneer': { name: 'Palak Paneer', price: 17.00, available: true, vegan: false, vegetarian: true, gluten_free: true },
  'Chicken Tikka Masala': { name: 'Chicken Tikka Masala', price: 19.00, available: true, vegan: false, vegetarian: false, gluten_free: true },
  'Goat Curry': { name: 'Goat Curry', price: 24.00, available: true, vegan: false, vegetarian: false, gluten_free: true, spice_level: 3, notes: 'very spicy' },
  'Veggie Burger': { name: 'Veggie Burger', price: 16.00, available: false, vegan: false, vegetarian: true, gluten_free: false, notes: 'SOLD OUT (egg, dairy)' },
  'Tandoori Salmon': { name: 'Tandoori Salmon', price: 25.00, available: true, vegan: false, vegetarian: false, gluten_free: true },
  'Plain Naan': { name: 'Plain Naan', price: 3.50, available: true, vegan: false, vegetarian: true, gluten_free: false, notes: 'dairy' },
  'Basmati Rice': { name: 'Basmati Rice', price: 4.50, available: true, vegan: true, vegetarian: true, gluten_free: true },
  'Kheer': { name: 'Kheer', price: 7.00, available: true, vegan: false, vegetarian: true, gluten_free: true },
  'Mango Lassi': { name: 'Mango Lassi', price: 6.00, available: true, vegan: false, vegetarian: true, gluten_free: true },
  'Sweet Lime Soda': { name: 'Sweet Lime Soda', price: 5.00, available: true, vegan: true, vegetarian: true, gluten_free: true },
};

// Ground truth for Demo Bistro (Berkeley) - matches Clover
export const BISTRO_GROUND_TRUTH: Record<string, MenuItemTruth> = {
  'Samosa Chaat': { name: 'Samosa Chaat', price: 9.50, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Chicken 65': { name: 'Chicken 65', price: 12.50, available: true, vegan: false, vegetarian: false, gluten_free: false },
  'Truffle Fries': { name: 'Truffle Fries', price: 9.00, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Crispy Calamari': { name: 'Crispy Calamari', price: 14.00, available: true, vegan: false, vegetarian: false, gluten_free: false },
  'Burrata & Heirloom Tomato': { name: 'Burrata & Heirloom Tomato', price: 16.00, available: true, vegan: false, vegetarian: true, gluten_free: true },
  'Tom Kha Soup': { name: 'Tom Kha Soup', price: 11.00, available: true, vegan: false, vegetarian: false, gluten_free: true },
  'Kale Caesar': { name: 'Kale Caesar', price: 13.00, available: true, vegan: false, vegetarian: false, gluten_free: false },
  'Quinoa Power Bowl': { name: 'Quinoa Power Bowl', price: 14.50, available: true, vegan: true, vegetarian: true, gluten_free: true },
  'Butter Chicken': { name: 'Butter Chicken', price: 19.50, available: true, vegan: false, vegetarian: false, gluten_free: false },
  'Paneer Tikka Masala': { name: 'Paneer Tikka Masala', price: 17.50, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Chana Masala': { name: 'Chana Masala', price: 15.00, available: true, vegan: true, vegetarian: true, gluten_free: false },
  'Lamb Vindaloo': { name: 'Lamb Vindaloo', price: 23.00, available: true, vegan: false, vegetarian: false, gluten_free: false, spice_level: 3 },
  'Smash Burger': { name: 'Smash Burger', price: 17.00, available: true, vegan: false, vegetarian: false, gluten_free: false },
  'Impossible Burger': { name: 'Impossible Burger', price: 18.00, available: true, vegan: true, vegetarian: true, gluten_free: false },
  'Grilled Salmon, Lemon Herb': { name: 'Grilled Salmon, Lemon Herb', price: 26.00, available: true, vegan: false, vegetarian: false, gluten_free: true },
  'Mushroom Risotto': { name: 'Mushroom Risotto', price: 21.00, available: true, vegan: false, vegetarian: true, gluten_free: true },
  'Pad Thai Tofu': { name: 'Pad Thai Tofu', price: 16.50, available: true, vegan: true, vegetarian: true, gluten_free: false },
  'Korean Fried Chicken Sandwich': { name: 'Korean Fried Chicken Sandwich', price: 16.00, available: false, vegan: false, vegetarian: false, gluten_free: false, notes: 'SOLD OUT' },
  'Garlic Naan': { name: 'Garlic Naan', price: 4.00, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Tawa Roti': { name: 'Tawa Roti', price: 3.50, available: true, vegan: true, vegetarian: true, gluten_free: false },
  'Jeera Rice': { name: 'Jeera Rice', price: 5.00, available: true, vegan: true, vegetarian: true, gluten_free: true },
  'Cucumber Raita': { name: 'Cucumber Raita', price: 4.50, available: true, vegan: false, vegetarian: true, gluten_free: true },
  'Mac & Cheese': { name: 'Mac & Cheese', price: 8.00, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Gulab Jamun': { name: 'Gulab Jamun', price: 7.00, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Molten Chocolate Cake': { name: 'Molten Chocolate Cake', price: 11.00, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Mango Sorbet': { name: 'Mango Sorbet', price: 8.00, available: true, vegan: true, vegetarian: true, gluten_free: true },
  'Mango Lassi': { name: 'Mango Lassi', price: 6.00, available: true, vegan: false, vegetarian: true, gluten_free: true },
  'Masala Chai': { name: 'Masala Chai', price: 4.50, available: true, vegan: false, vegetarian: true, gluten_free: false },
  'Cold Brew': { name: 'Cold Brew', price: 5.50, available: true, vegan: true, vegetarian: true, gluten_free: true },
  'Spicy Margarita': { name: 'Spicy Margarita', price: 14.00, available: true, vegan: false, vegetarian: false, gluten_free: true },
  'Hazy IPA': { name: 'Hazy IPA', price: 9.00, available: true, vegan: false, vegetarian: false, gluten_free: false },
  'Sparkling Yuzu Lemonade': { name: 'Sparkling Yuzu Lemonade', price: 6.50, available: true, vegan: true, vegetarian: true, gluten_free: true },
};

export function createDiscoveryRouter(store: Store): Router {
  const router = Router();

  async function isBistroLive(): Promise<boolean> {
    try {
      const merchantSnap = await store.doc<MerchantDocument>('merchants', DEMO_BISTRO_MERCHANT_ID).get();
      const merchant = merchantSnap.data();
      if (!merchant || merchant.status !== 'CONNECTED') {
        return false;
      }
      const itemsSnap = await store.collection<ItemDocument>('items').where('merchantId', '==', DEMO_BISTRO_MERCHANT_ID).get();
      return itemsSnap.docs.length >= 1;
    } catch {
      return false;
    }
  }

  // GET /sites/bistro
  router.get('/sites/bistro', async (req: Request, res: Response) => {
    const live = await isBistroLive();
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    let discoveryTags = '';
    if (live) {
      discoveryTags = `
<link rel="alternate" type="application/json" title="Agent card" href="${baseUrl}/.well-known/agent-card.json">
<link rel="alternate" type="text/plain" title="Instructions for AI agents" href="${baseUrl}/llms.txt">
<meta name="ai-agent-instructions" content="${baseUrl}/llms.txt">
      `.trim();
    }

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vecta Demo Bistro · Berkeley</title>
${discoveryTags}
<style>
  body { margin:0; font:17px/1.6 Georgia, serif; color:#2b2118; background:#fbf6ef; }
  header { background:#2b2118; color:#fbf6ef; padding:40px 20px; text-align:center; }
  header h1 { margin:0; font-size:40px; letter-spacing:1px; }
  header p { margin:6px 0 0; font-style:italic; opacity:.85; }
  main { max-width:760px; margin:0 auto; padding:24px 20px 60px; }
  h2 { border-bottom:1px solid #d9c9b3; padding-bottom:4px; margin-top:36px; }
  .dish { display:flex; justify-content:space-between; gap:16px; margin:8px 0; }
  .dish span:last-child { white-space:nowrap; }
  .note { color:#6b5a48; font-size:15px; }
  footer { text-align:center; color:#6b5a48; font-size:14px; padding:24px; }
</style>
</head>
<body>
<header><h1>Vecta Demo Bistro</h1><p>Indian-inspired kitchen &amp; global comfort food · 2299 Piedmont Ave, Berkeley</p></header>
<main>
<p>Welcome! Our chefs bring together the spice markets of Delhi and the diners of California. Many dishes can be
made vegetarian or vegan, just ask your server. Menu and prices subject to change; please call ahead for large parties.</p>

<h2>Small Plates</h2>
<div class="dish"><span>Samosa Chaat</span><span>9.50</span></div>
<div class="dish"><span>Chicken 65</span><span>12.50</span></div>
<div class="dish"><span>Truffle Fries</span><span>9</span></div>
<div class="dish"><span>Crispy Calamari</span><span>14</span></div>
<div class="dish"><span>Burrata &amp; Heirloom Tomato</span><span>15</span></div>

<h2>Soups &amp; Salads</h2>
<div class="dish"><span>Tom Kha Soup</span><span>11</span></div>
<div class="dish"><span>Kale Caesar</span><span>13</span></div>
<div class="dish"><span>Quinoa Power Bowl</span><span>14.50</span></div>

<h2>Mains</h2>
<div class="dish"><span>Butter Chicken ★ chef's special</span><span>19.50</span></div>
<div class="dish"><span>Paneer Tikka Masala</span><span>17.50</span></div>
<div class="dish"><span>Chana Masala</span><span>15</span></div>
<div class="dish"><span>Lamb Vindaloo 🌶</span><span>23</span></div>
<div class="dish"><span>Smash Burger</span><span>17</span></div>
<div class="dish"><span>Impossible Burger</span><span>18</span></div>
<div class="dish"><span>Grilled Salmon, Lemon Herb</span><span>26</span></div>
<div class="dish"><span>Mushroom Risotto</span><span>21</span></div>
<div class="dish"><span>Pad Thai Tofu</span><span>16.50</span></div>
<div class="dish"><span>Korean Fried Chicken Sandwich 🌶 NEW!</span><span>16</span></div>

<h2>Breads &amp; Sides</h2>
<div class="dish"><span>Garlic Naan</span><span>4</span></div>
<div class="dish"><span>Jeera Rice</span><span>5</span></div>
<div class="dish"><span>Mac &amp; Cheese</span><span>8</span></div>

<h2>Desserts</h2>
<div class="dish"><span>Gulab Jamun</span><span>7</span></div>
<div class="dish"><span>Molten Chocolate Cake</span><span>11</span></div>
<div class="dish"><span>Mango Sorbet</span><span>8</span></div>

<h2>Drinks</h2>
<p class="note">Mango Lassi · Masala Chai · Cold Brew · Sparkling Yuzu Lemonade · Spicy Margarita · Hazy IPA</p>

<p class="note">Please inform your server of any allergies. Gluten-free options available.</p>
</main>
<footer>Open Tue–Sun 11:30–21:30 · (510) 555-0100</footer>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // GET /sites/spice (Demo Spice Kitchen - Oakland, never on Vecta, never gets discovery links)
  router.get('/sites/spice', (_req: Request, res: Response) => {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo Spice Kitchen · Oakland</title>
<style>
  body { margin:0; font:17px/1.6 Georgia, serif; color:#1c261e; background:#f4f7f2; }
  header { background:#1f3a2b; color:#f4f7f2; padding:40px 20px; text-align:center; }
  header h1 { margin:0; font-size:40px; letter-spacing:1px; }
  header p { margin:6px 0 0; font-style:italic; opacity:.85; }
  main { max-width:760px; margin:0 auto; padding:24px 20px 60px; }
  h2 { border-bottom:1px solid #c7d4c2; padding-bottom:4px; margin-top:36px; color:#1f3a2b; }
  .dish { display:flex; justify-content:space-between; gap:16px; margin:8px 0; }
  .dish span:last-child { white-space:nowrap; }
  .note { color:#4a5e4b; font-size:15px; }
  footer { text-align:center; color:#4a5e4b; font-size:14px; padding:24px; }
</style>
</head>
<body>
<header>
  <h1>Demo Spice Kitchen · Oakland</h1>
  <p>Home-style North Indian cooking · 4100 Telegraph Ave, Oakland</p>
</header>
<main>
<p>Family recipes, slow-cooked every day. Plenty of vegetarian choices. Ask about today's specials!</p>

<h2>Starters</h2>
<div class="dish"><span>Vegetable Samosas</span><span>7</span></div>
<div class="dish"><span>Paneer Pakora</span><span>10</span></div>
<div class="dish"><span>Lentil Soup</span><span>9</span></div>

<h2>Curries</h2>
<div class="dish"><span>Chana Masala ★ house favourite</span><span>14</span></div>
<div class="dish"><span>Aloo Gobi</span><span>13</span></div>
<div class="dish"><span>Baingan Bharta</span><span>16</span></div>
<div class="dish"><span>Palak Paneer</span><span>17</span></div>
<div class="dish"><span>Chicken Tikka Masala</span><span>19</span></div>
<div class="dish"><span>Goat Curry 🌶🌶</span><span>24</span></div>

<h2>Grill &amp; Burgers</h2>
<div class="dish"><span>Veggie Burger NEW!</span><span>16</span></div>
<div class="dish"><span>Tandoori Salmon</span><span>25</span></div>

<h2>Sides &amp; Sweets</h2>
<div class="dish"><span>Plain Naan</span><span>3.50</span></div>
<div class="dish"><span>Basmati Rice</span><span>4.50</span></div>
<div class="dish"><span>Kheer</span><span>7</span></div>

<h2>Drinks</h2>
<p class="note">Mango Lassi · Sweet Lime Soda · Chai</p>

<p class="note">Vegetarian options marked by your server. Please ask about allergens.</p>
</main>
<footer>Open daily 12:00–22:00 · (510) 555-0199</footer>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // Helper for llms.txt content
  const handleLlmsTxt = async (req: Request, res: Response) => {
    const live = await isBistroLive();
    if (!live) {
      res.status(404).send('Not Found: Merchant not connected or catalog empty');
      return;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const mid = DEMO_BISTRO_MERCHANT_ID;

    const body = `# Vecta Demo Bistro - AI Agent Instructions

Restaurant: Vecta Demo Bistro
Address: 2299 Piedmont Ave, Berkeley, CA
Cuisine: Indian-inspired kitchen & global comfort food

## Public Agent API
Plain HTTPS GET requests returning JSON. No API key needed.

### Search Menu
Endpoint: ${baseUrl}/agents/${mid}/search
Supported filters:
- q: search keywords (e.g. "vegan curry", "quinoa bowl")
- max_price: maximum price in dollars (e.g. 15.00)
- vegetarian: true/false
- vegan: true/false
- gluten_free: true/false
- max_spice: 0 (none), 1 (mild), 2 (medium), 3 (hot)
- course: appetizer, soup_salad, main, side, bread, dessert, drink, other
- exclude_allergens: comma-separated list (dairy, egg, gluten, peanut, tree_nut, soy, shellfish, fish, sesame)

### Example Search Queries
1. Vegan dishes under $15:
   ${baseUrl}/agents/${mid}/search?vegan=true&max_price=15
2. Gluten-free main courses:
   ${baseUrl}/agents/${mid}/search?course=main&gluten_free=true
3. Mild curries:
   ${baseUrl}/agents/${mid}/search?q=curry&max_spice=1

### Dish Pairings
Endpoint: ${baseUrl}/agents/${mid}/pairings?dish={dishName}
Example:
   ${baseUrl}/agents/${mid}/pairings?dish=Paneer+Tikka+Masala

## Notes for Agents
- If items return verified=false, details are provisional; advise confirming with waitstaff.
- Stock changes in real-time. Only in-stock items are returned by the search API.
- Fair use: Rate limited to 30 requests per minute.
- A2A Agent Card: ${baseUrl}/.well-known/agent-card.json
`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(body);
  };

  // Helper for agent-card.json content
  const handleAgentCard = async (req: Request, res: Response) => {
    const live = await isBistroLive();
    if (!live) {
      res.status(404).json({ error: 'Not Found: Merchant not connected or catalog empty' });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const mid = DEMO_BISTRO_MERCHANT_ID;

    const card = {
      name: 'Vecta Demo Bistro Agent Service',
      description: 'Real-time menu, dietary facts, live inventory, and pairings for Vecta Demo Bistro',
      url: `${baseUrl}/agents/${mid}`,
      version: '1.0.0',
      provider: {
        name: 'Vecta-what',
      },
      preferredTransport: 'HTTP+JSON',
      defaultModes: ['read_only'],
      capabilities: {
        streaming: false,
      },
      documentationUrl: `${baseUrl}/llms.txt`,
      skills: [
        {
          name: 'search_menu',
          description: 'Search available in-stock menu items with dietary, price, course, and allergen filters',
          getTemplate: `${baseUrl}/agents/${mid}/search{?q,max_price,vegetarian,vegan,gluten_free,max_spice,course,exclude_allergens}`,
          example: `${baseUrl}/agents/${mid}/search?vegan=true&max_price=20`,
        },
        {
          name: 'get_pairings',
          description: 'Get verified chef and head-server pairings for a specific menu dish',
          getTemplate: `${baseUrl}/agents/${mid}/pairings{?dish}`,
          example: `${baseUrl}/agents/${mid}/pairings?dish=Paneer+Tikka+Masala`,
        },
      ],
      'x-usage-policy': {
        auth: 'none for read access',
        rateLimit: '30 requests per minute',
        maxResults: 8,
        bulkExport: 'not offered',
      },
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(card);
  };

  // Discovery routes on both root and /sites/bistro
  router.get('/llms.txt', handleLlmsTxt);
  router.get('/sites/bistro/llms.txt', handleLlmsTxt);
  router.get('/.well-known/agent-card.json', handleAgentCard);
  router.get('/sites/bistro/.well-known/agent-card.json', handleAgentCard);

  // Spice Kitchen discovery routes always 404 (as per prompt instructions)
  router.get('/sites/spice/llms.txt', (_req, res) => res.status(404).send('Not Found'));
  router.get('/sites/spice/.well-known/agent-card.json', (_req, res) => res.status(404).send('Not Found'));

  return router;
}
