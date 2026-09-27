# Demo data: Vecta Demo Bistro (Clover sandbox merchant `PWXW6VQTEWJ11`)

Already loaded in Clover (spreadsheet import + tags via API). The app reads it; it never writes to Clover.

## Menu in Clover (source of truth)

| Item | Price | Category | Clover tags | Stock / availability |
|---|---|---|---|---|
| Samosa Chaat | 9.50 | Small Plates | Vegetarian | 40 |
| Chicken 65 | 12.50 | Small Plates | Spicy | 30 |
| Truffle Fries | 9.00 | Small Plates | Vegetarian | untracked |
| Crispy Calamari | 14.00 | Small Plates | | 20 |
| Burrata & Heirloom Tomato | 16.00 | Small Plates | Vegetarian, GF | 12 |
| Tom Kha Soup | 11.00 | Soups & Salads | GF | 25 |
| Kale Caesar | 13.00 | Soups & Salads | | untracked |
| Quinoa Power Bowl | 14.50 | Soups & Salads | Vegan, GF | 18 |
| Butter Chicken | 19.50 | Mains | Chef Special | 25 |
| Paneer Tikka Masala | 17.50 | Mains | Vegetarian | 20 |
| Chana Masala | 15.00 | Mains | Vegan | 30 |
| Lamb Vindaloo | 23.00 | Mains | Spicy | 10 |
| Smash Burger | 17.00 | Mains | | 35 |
| Impossible Burger | 18.00 | Mains | Vegan | 15 |
| Grilled Salmon, Lemon Herb | 26.00 | Mains | GF | 8 |
| Mushroom Risotto | 21.00 | Mains | Vegetarian, GF | 14 |
| Pad Thai Tofu | 16.50 | Mains | Vegan | 22 |
| Korean Fried Chicken Sandwich | 16.00 | Mains | Spicy | **available = false** (sold out) |
| Garlic Naan | 4.00 | Breads & Sides | Vegetarian | untracked |
| Tawa Roti | 3.50 | Breads & Sides | Vegan | untracked (quantity 0, autoManage off → in stock) |
| Jeera Rice | 5.00 | Breads & Sides | Vegan, GF | untracked |
| Cucumber Raita | 4.50 | Breads & Sides | Vegetarian, GF | untracked |
| Mac & Cheese | 8.00 | Breads & Sides | Vegetarian, Kids | untracked |
| Gulab Jamun | 7.00 | Desserts | Vegetarian | 30 |
| Molten Chocolate Cake | 11.00 | Desserts | Vegetarian | 12 |
| Mango Sorbet | 8.00 | Desserts | Vegan, GF | 20 |
| Mango Lassi | 6.00 | Drinks | Vegetarian | untracked |
| Masala Chai | 4.50 | Drinks | Vegetarian | untracked |
| Cold Brew | 5.50 | Drinks | Vegan | untracked |
| Spicy Margarita | 14.00 | Drinks | 21+ | untracked |
| Hazy IPA | 9.00 | Drinks | 21+ | untracked |
| Sparkling Yuzu Lemonade | 6.50 | Drinks | Vegan | untracked |

Modifier groups: **Spice level** (Mild, Medium, Hot) on Butter Chicken, Paneer Tikka Masala, Chana Masala,
Lamb Vindaloo · **Add protein** (Tofu +3, Chicken +4, Paneer +4) on Kale Caesar, Quinoa Power Bowl, Pad Thai
Tofu · **Burger add-ons** (Cheese +1.5, Avocado +2, Bacon +2.5) on both burgers.

## Expected demo outcomes (validator checks)
- Vegan, ≤ $15, in stock: Chana Masala, Quinoa Power Bowl (mains/bowls), Tawa Roti / Jeera Rice (sides).
- The sold-out Korean Fried Chicken Sandwich never appears in agent answers.
- After approval, "what goes with the tikka masala?" → Garlic Naan or Tawa Roti (+ Jeera Rice / Raita /
  Mango Lassi), never another curry.
- The general assistant **before** install can only scrape the stale site below (wrong burrata price,
  no roti/raita, may offer the sold-out sandwich, no dietary facts).

## The restaurant's website, deliberately stale (serve verbatim at `/sites/bistro`)

Keep the `<!--DISCOVERY-->` placeholder in `<head>`; it is replaced by discovery links only when live.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vecta Demo Bistro Â· Berkeley</title>
<!--DISCOVERY-->
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
<header><h1>Vecta Demo Bistro</h1><p>Indian-inspired kitchen &amp; global comfort food Â· 2299 Piedmont Ave, Berkeley</p></header>
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
<div class="dish"><span>Butter Chicken â˜… chef's special</span><span>19.50</span></div>
<div class="dish"><span>Paneer Tikka Masala</span><span>17.50</span></div>
<div class="dish"><span>Chana Masala</span><span>15</span></div>
<div class="dish"><span>Lamb Vindaloo ðŸŒ¶</span><span>23</span></div>
<div class="dish"><span>Smash Burger</span><span>17</span></div>
<div class="dish"><span>Impossible Burger</span><span>18</span></div>
<div class="dish"><span>Grilled Salmon, Lemon Herb</span><span>26</span></div>
<div class="dish"><span>Mushroom Risotto</span><span>21</span></div>
<div class="dish"><span>Pad Thai Tofu</span><span>16.50</span></div>
<div class="dish"><span>Korean Fried Chicken Sandwich ðŸŒ¶ NEW!</span><span>16</span></div>

<h2>Breads &amp; Sides</h2>
<div class="dish"><span>Garlic Naan</span><span>4</span></div>
<div class="dish"><span>Jeera Rice</span><span>5</span></div>
<div class="dish"><span>Mac &amp; Cheese</span><span>8</span></div>

<h2>Desserts</h2>
<div class="dish"><span>Gulab Jamun</span><span>7</span></div>
<div class="dish"><span>Molten Chocolate Cake</span><span>11</span></div>
<div class="dish"><span>Mango Sorbet</span><span>8</span></div>

<h2>Drinks</h2>
<p class="note">Mango Lassi Â· Masala Chai Â· Cold Brew Â· Sparkling Yuzu Lemonade Â· Spicy Margarita Â· Hazy IPA</p>

<p class="note">Please inform your server of any allergies. Gluten-free options available.</p>
</main>
<footer>Open Tueâ€“Sun 11:30â€“21:30 Â· (510) 555-0100</footer>
</body>
</html>

```