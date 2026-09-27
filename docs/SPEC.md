# Vecta-what: build specification (Google AI Studio, full-stack TypeScript)

Vecta-what makes a small business's point-of-sale catalog usable by AI agents. A merchant installs the
Vecta-what **Clover** app in one click. The app snapshots their catalog, keeps it in sync (change data
capture), uses **Gemini** to *propose* the details Clover does not store (descriptions, dietary flags,
allergens, spice, pairings), lets the merchant *approve* them, indexes everything for **vector search with
pre-filters**, and publishes **discovery documents** so any general-purpose AI agent can find and use the
menu with nothing installed.

This is the source of truth. `FEATURE_MATRIX.md` lists every feature with acceptance criteria; the build is
validated against it. MUST = checked by the validator.

---

## 0. Platform: build only with what Google AI Studio provides

- **One full-stack app**, as AI Studio Build creates it: React + TypeScript client, Node.js + Express +
  TypeScript server. Business logic lives on the server; the client only renders and calls `/api/*`.
- **Stack (MUST):** Express + TypeScript server that `listen(process.env.PORT || 8080)`; React + TypeScript
  client. Server-only modules never import into the client bundle.
- **Gemini** through the auto-configured `GEMINI_API_KEY` (server-side only). **Never set `GOOGLE_API_KEY`**
  (it silently overrides `GEMINI_API_KEY`). SDK **`@google/genai` ≥ 2.3**, **Interactions API**
  (`client.interactions.create`) for enrichment, pairing and both agents:
  - model **`gemini-3.8-flash`**; `generation_config.thinking_level: "low"` for enrichment and pairing
    (`"minimal"` errors on 3.8); **do not send temperature / top_p / top_k** (deprecated for 3.8);
  - structured output via `response_format: {type:"text", mime_type:"application/json", schema}`, read
    `interaction.output_text`; keep schemas flat and small;
  - `max_output_tokens` **includes thinking tokens**; a response with status `"incomplete"` is a failure
    (retry smaller), never parsed as partial JSON;
  - `store: false` for enrichment and pairing (stateless, no 55-day retention); agents use `store: true` +
    `previous_interaction_id`, and resend `tools` / `system_instruction` / `generation_config` every turn.
- **Embeddings:** **`gemini-embedding-2`**, `outputDimensionality: 768` (auto-normalized). It takes **no
  `taskType`**: prefix documents `title: {name} | text: {search_text}` and queries
  `task: search result | query: {query}`. Batch with `ai.models.embedContent({model, contents:[{parts:…},
  {parts:…}], config:{outputDimensionality:768}})`, where **one Content per document** (several parts in one
  Content yields one merged embedding).
- **Firestore** via AI Studio's **Firebase integration**. It provisions a **named database whose id is the
  app id** (not `(default)`) and generates client-SDK files. The server MUST use **`firebase-admin`** with
  that `databaseId` (vector search is server-SDK-only). Keep the generated `firestore.rules` default-deny.
  The database starts on a **shared free quota (40k writes, 50k reads, 50k real-time updates per day across
  all AI Studio databases in the project; when exhausted everything pauses until tomorrow)**, so the
  design must be listener-driven, never polling (§5.2), and the operator clicks **Upgrade database**
  before real use.
- **Secrets panel** (read only via `process.env`): `CLOVER_APP_ID`, `CLOVER_APP_SECRET`,
  `CLOVER_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `CLOVER_ENV` (`sandbox`), `PUBLIC_BASE_URL` (the published
  `https://<name>.ai.studio` URL), `DEMO_MERCHANT_ID` (`PWXW6VQTEWJ11`).
- **Deploy** with AI Studio's Publish (Cloud Run in the linked project). Clover's OAuth redirect and webhooks
  can only reach the **published** URL, not the dev preview. Re-publishing may reset console settings, so
  `GET /healthz` reports missing env vars, database connectivity, worker status and scheduler-lease holder,
  and nothing assumes a single instance (§5.3).
- **Out of scope:** order placement, MCP server, non-Clover POS adapters, auth/RBAC (demo pages are open
  by request; see §9.6).

## 1. Product principles (non-negotiable)

1. **Facts from Clover are live immediately; Gemini output is a proposal until the merchant approves it.**
   Nothing Gemini generated may reach the vector index or any agent-facing API before approval.
2. **Merchant tags win.** Clover tags Vegan / Vegetarian / GF / Gluten free / 21+ override any Gemini value.
3. **Pairings are complementary, never similarity.** "What goes with X" comes from approved pairings.
4. **Nothing slow on a request path.** Install callback and webhooks do one small durable write and return.
5. **Idempotent and resumable.** Retries, redeliveries and crashes never duplicate work or data.
6. **Tenant isolation first.** Every vector query is filtered by merchant.

## 2. External systems that already exist (do not create)

- **Clover sandbox app** "Vecta-what", App ID `TTK5SFAD6N09A`, type REST Client / Web, permissions
  Read Inventory + Read Merchant, default OAuth response CODE. The operator points its **Site URL** at the
  deployed app, **Alternate Launch Path** `/oauth/callback`, **webhook URL** `/webhooks/clover`
  (subscriptions: App, Inventory) after the first publish.
- **Clover test merchant** `PWXW6VQTEWJ11` "Vecta Demo Bistro": 32 items, 6 categories, 3 modifier groups,
  dietary tags. See `DEMO_DATA.md`.

---

## 3. Clover integration

### 3.1 Hosts and headers
Sandbox: authorize `https://sandbox.dev.clover.com`, API `https://apisandbox.dev.clover.com`.
Production: `https://www.clover.com`, `https://api.clover.com`. Always `Authorization: Bearer <token>`
(never a query param) and `User-Agent: VectaWhat / 0.1 (…)`.

### 3.2 OAuth v2 install (server holds the secret; no PKCE)
1. Merchant clicks **Connect** in the App Market. Clover sends the **browser** to
   `GET /oauth/callback?merchant_id=…` (the Alternate Launch Path). It may carry a legacy v1 `code`, which
   is **not** usable.
2. `/oauth/callback` without **our valid `state`** → 302 to
   `{authorizeHost}/oauth/v2/authorize?client_id=…&redirect_uri={PUBLIC_BASE_URL}/oauth/callback&state=…`.
3. Merchant approves → Clover redirects to `/oauth/callback?code=…&state=…&merchant_id=…`.
4. Valid state → `POST {apiHost}/oauth/v2/token` JSON `{client_id, client_secret, code}` →
   `{access_token, access_token_expiration, refresh_token, refresh_token_expiration}` (epoch **seconds**).
   Write the grant to `merchants/{mid}` **synchronously**, then write the `installed` inbox event (§5),
   then render a **Connected** page with a button to the signed review link (§9.3).
- **State:** stateless `"{issuedAtSeconds}.{hmac}"`, HMAC-SHA256 keyed by `ADMIN_TOKEN`, valid 15 min.
- **Refresh:** `POST /oauth/v2/refresh` `{client_id, refresh_token}`. Refresh tokens are **single-use and
  rotate**. Refresh when the access token expires within 5 min, **single-flight** with a Firestore
  transaction that takes a 30 s `refreshLeaseUntil` lease only if the stored access token is still the one
  we read; losers wait 500 ms and re-read.
- **Recovery:** refresh 401 with header `X-Clover-Recovery-Available: true` →
  `POST /oauth/v2/recovery` `{client_id, client_secret, recovery_token: <refresh token we hold>}`.
- Other auth failure → merchant `DISCONNECTED`, job dead-lettered (fatal). Note Clover returns **401 for
  permission errors too**.

### 3.3 Inventory reads
- `GET /v3/merchants/{mId}?expand=address` → name, city, state = merchant context for prompts.
- `GET /v3/merchants/{mId}/items?expand=categories,tags,itemStock&limit=1000&offset=N[&filter=modifiedTime>=EPOCH_MS]`
  (**max 3 expansions** per call, so no modifierGroups). Page until a short page. Order is newest-first; offset
  paging over a live catalog can skip rows (§6.1 sweep handles it). Nested lists cap at 100 per item.
- `GET /v3/merchants/{mId}/items/{id}?expand=categories,tags,itemStock` (404 = deleted).
- Items have **no description field**. Signal: name, alternateName, price (cents), priceType, categories,
  tags, itemStock.quantity, available, hidden, autoManage, deleted, modifiedTime.

### 3.4 Stock rule (MUST)
`inStock = available !== false && hidden !== true && (autoManage !== true || quantity == null || quantity > 0)`.
Spreadsheet imports write quantity 0 on untracked items; treating 0 as sold out hides half the menu.

### 3.5 Rate limits and retries (Clover-documented)
Per token 16 req/s and **5 concurrent**; per app 50 req/s and **10 concurrent**. Enforce in-process
concurrency caps **4 per merchant, 8 app-wide**. On 429/5xx/network: wait ≥1 s, honour `retry-after`
seconds if present, else `1s·2^attempt + random(0–1s)`, up to 8 attempts; log which `X-RateLimit-*` header
fired. 401/403 → auth failure immediately.

### 3.6 Webhooks
`POST /webhooks/clover`:
- `{"verificationCode": "…"}` → log `[clover] WEBHOOK VERIFICATION CODE = …` and 200 (one-time URL check).
- Else require header `X-Clover-Auth` === `CLOVER_WEBHOOK_SECRET` (constant-time; unset secret → reject
  all) else 401.
- Body `{appId, merchants:{mId:[{objectId:"KEY:ID", type, ts}]}}`; one delivery may carry several
  merchants. Write **one inbox event** with the raw body and return 200 **within seconds** (Clover may stop
  sending otherwise and **never retries**).
- Keys: `I` item, `IS` item stock, `IA` item availability (split from `I` in 2026, live in sandbox) → one
  `SYNC_ITEM` job per object; `IC`, `IG`, `IM` → one `full` reconcile; others ignored; `A` logged.

## 4. Firestore data model

Top-level collections (merchant id stored on every doc):

| Collection | Doc id | Fields |
|---|---|---|
| `merchants` | mid | status CONNECTED/DISCONNECTED, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, refreshLeaseUntil, name, context, menuOutline (≤300), pairingMenuHash, connectedAt, lastSyncedAt, disconnectedReason |
| `items` | `{mid}_{itemId}` | merchantId, itemId, stage FETCHED/ENRICHED/INDEXED/DELETED/FAILED, name, sourceHash, stockSig, item (raw Clover), profile (proposal), reviewStatus PENDING/APPROVED/EDITED, approvedProfile, pairingsProposal[], pairingsApproved[], pairingsStatus, lastError, lastSeenRun, updatedAt, reviewedAt |
| `catalog` | `{mid}_{itemId}` | **the searchable index** (§7): public fields + `embedding` (vector, 768) |
| `runs` | runId | merchantId, kind snapshot/full/incremental, status RUNNING/COMPLETE/COMPLETE_WITH_FAILURES, cursor, modifiedSince, counts{}, failedItemIds[], startedAt, finishedAt |
| `jobs` | sha256(idempotencyKey)[0:32] | kind SNAPSHOT/SYNC_ITEM/PAIR_MENU, merchantId, payload, runId, idempotencyKey, status QUEUED/RUNNING/RETRY/DONE/DEAD, attempts, leaseUntil, nextAttemptAt, lastError, result, createdAt, updatedAt |
| `inbox` | auto | type installed/clover_webhook, merchantId, key, body, status NEW/DONE/FAILED, attempts, createdAt |
| `events` | auto | merchantId, kind, at, … (append-only audit) |

Tokens stored in plaintext are a demo shortcut (production: envelope encryption). Firestore security rules:
deny all client access; only the server (Admin SDK) reads and writes.

## 5. Ingestion: durable inbox then jobs

### 5.1 Inbox (replaces a message bus; same semantics)
- Producers (`/oauth/callback`, `/webhooks/clover`) write **one** `inbox` doc and return. The install
  event carries only the merchant id, never tokens.
- **Inbox consumer** (in-process, real-time listener on `inbox where status == NEW`, plus a 60 s sweep):
  for each event, **in a transaction**, create the resulting jobs (idempotent, §5.2) and mark the event
  DONE. Failure → attempts+1, stays NEW with backoff; after 5 attempts → FAILED (dead letter, visible on
  admin, replayable).
  - `installed` → `startSnapshot(mid, "snapshot", key = "install:{mid}:{last12(accessToken)}")`.
  - `clover_webhook` → map updates to jobs per §3.6.

### 5.2 Job queue (Firestore is the source of truth)
- **Enqueue** = `create()` a doc whose id is derived from the idempotency key; ALREADY_EXISTS → no-op.
  Keys: webhook `wh:{family}:{mid}:{objectId}:{ts}`; retry `retry:{mid}:{itemId}:{runId}`; reconcile
  `reconcile:{kind}:{mid}:{bucket}`; pairing `pair:{mid}:{runId}`; manual `manual:{mid}:{iso}`.
- **Claim by id in a transaction:** runnable = (QUEUED or RETRY, and nextAttemptAt ≤ now) or (RUNNING and
  leaseUntil < now) → set RUNNING, `leaseUntil = now + 10 min`, `attempts + 1`. **Ownership** =
  (id, RUNNING, attempts); complete / yield / fail / heartbeat are all conditional transactions on it.
- **Heartbeat on a clock:** renew the lease every 60 s while the job runs (setInterval), independent of
  step length; a failed renewal sets `owned = false` and the job stops at its next checkpoint. (Renewing
  only between steps let a slow Gemini call outlive the lease and a second worker ran the same page.)
- **Fail:** attempts ≥ 5 or fatal → DEAD (log `[metric] job_dead …`); else RETRY with
  `nextAttemptAt = now + 30 s·2^(attempts-1)`.
- **Yield:** status QUEUED, attempts − 1, runnable now (used between pages when the time budget is spent).
- **Worker, listener-driven (MUST, quota):** a real-time listener on `jobs where status == "QUEUED"`
  wakes the worker; it claims and runs up to 4 jobs concurrently. **No per-second polling** (it would
  exhaust the daily read quota by itself). A 60 s timer handles what listeners can't see: RETRY jobs whose
  `nextAttemptAt` passed and RUNNING jobs whose lease expired (one small indexed query each).
- **Replay dead:** DEAD → QUEUED, attempts 0.

### 5.3 Schedules (in-process, lease-elected leader)
One instance at a time holds `locks/scheduler` (Firestore transaction, 2-min lease, renewed every 60 s);
only the holder runs schedules. Hourly at :00 → `incremental` reconcile per CONNECTED merchant (bucket
`yyyyMMddHH`); daily 10:00 UTC (off-peak per Clover) → `full` (bucket `yyyyMMdd`). **Stagger** by
`hash(mid) mod 45 min` / `mod 2 h` (enqueue with future `nextAttemptAt`). Idempotent per bucket anyway.
Per-merchant Gemini budget (calls/hour) so one tenant cannot exhaust the project's shared rate limit.

## 6. Catalog pipeline

### 6.1 Snapshot = ONE job, any catalog size
Create/resume `runs/{runId}` (skip if not RUNNING). Get merchant context. Loop pages from `run.cursor`:
1. If `owned` is false → stop (lease lost). If this delivery's 8-minute budget is spent → **yield**
   (cursor is committed).
2. Refresh the token if needed; fetch page (`modifiedSince` for incremental).
3. First page of a non-incremental run → save `menuOutline` (≤300 "Name (Category)").
4. Chunks of **10**, **4 in parallel** (§6.2).
5. Commit: `cursor = offset + page.length`, increment counts, append failed ids (one write).
6. Short page → stop.

Then, **non-incremental only: verified mark-and-sweep.** Items whose `lastSeenRun != runId` and stage
≠ DELETED are deletion *candidates*; re-fetch each by id: gone/deleted → remove (delete `catalog` doc,
stage DELETED); still there → re-sync and mark seen. Then enqueue `SYNC_ITEM` retries for failed ids,
close the run (COMPLETE / COMPLETE_WITH_FAILURES), set `merchant.lastSyncedAt = run.startedAt`, log
`run_finished`, enqueue `PAIR_MENU`.

### 6.2 Chunk
Read the chunk's `items` docs in one `getAll`. For each item compute `sourceHash`; those needing
enrichment (`!(sourceHash === ck.sourceHash && ck.profile)`) go into **one batched Gemini call** (§8.1);
if it throws, fall back to per-item calls. Apply §6.3 per item; an item error counts as failed and never
fails the chunk (except auth failure, which aborts the run). Skip `deleted` items. Mark all non-deleted
ids `lastSeenRun = runId` (batched write).

### 6.3 Per-item apply (idempotent)
- INDEXED and same sourceHash: same `stockSig` → "unchanged"; else **patch** `in_stock`/`stock_quantity`
  on the `catalog` doc (no re-embedding) → "stock".
- Needs enrichment → `stage ENRICHED, profile = proposal, reviewStatus PENDING, approvedProfile = null`
  (**a changed item loses its approval**).
- Write the catalog doc from Clover facts + approved profile (or none) (§7.2) → `stage INDEXED, stockSig,
  item, lastError null` → "indexed". Errors → `stage FAILED, lastError`, rethrow.
- `sourceHash = sha256(JSON{v: PROMPT_VERSION, model, name, alternateName, price, categories, tags})`
  (no stock). `stockSig = "available|hidden|autoManage|quantity"`.

### 6.4 SYNC_ITEM
Re-fetch the item from Clover (latest wins); missing/deleted → remove; else §6.3.

### 6.5 Incremental
`modifiedSince = lastSyncedAt − 10 min`, fixed at run start. No baseline, or older than **85 days**
(Clover silently truncates time filters at 90 days) → skip. Never sweeps deletes. Stock changes may not
bump modifiedTime, so IS/IA webhooks and the daily full run cover them.

### 6.6 Pairing (PAIR_MENU)
Skip if > 500 live items. Menu lines from INDEXED items: `{id, name, categories, tags, price}` **plus the
item's profile** (approved or proposal) `cuisine, course, spice_level, description`.
`hash = sha256({menu, v: PAIRING_VERSION})`; unchanged → skip. For each chunk of 15 anchors, call Gemini
(§8.2). Validate: id exists in the menu, not the anchor, role in the enum, ≤ 4. A changed proposal →
`pairingsProposal, pairingsStatus PENDING` (previous approved pairings stay live until re-reviewed). Save
hash. Bumping `PAIRING_VERSION` re-proposes pairings without re-enriching items.

### 6.7 Review
`review(mid, itemId, action approve|edit, edits?, pairingIds?)`, requires INDEXED + profile.
approve → `approvedProfile = profile, APPROVED`; edit → merge edits over the profile, validate against the
`ItemProfile` schema, `EDITED`. `pairingsApproved` = proposed pairings filtered by `pairingIds` (absent =
keep all); `pairingsStatus APPROVED`. **Rewrite the catalog doc** with the approved profile (now live, new
embedding). Log `review_{action}`.

## 7. Vector search (Firestore)

### 7.1 Index
Collection `catalog`, vector field `embedding`, **768 dimensions** (Firestore max 2048), **flat** index,
distance **DOT_PRODUCT** (vectors are normalized by gemini-embedding-2). Composite vector indexes (one per
pre-filter combination actually used), created by the operator against the app's named database:
```
gcloud firestore indexes composite create --database=<APP_DATABASE_ID> --collection-group=catalog --query-scope=COLLECTION \
  --field-config=order=ASCENDING,field-path=merchantId --field-config=order=ASCENDING,field-path=in_stock \
  --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'
gcloud firestore indexes composite create --database=<APP_DATABASE_ID> --collection-group=catalog --query-scope=COLLECTION \
  --field-config=order=ASCENDING,field-path=merchantId \
  --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'
```
Vector queries run only in server code (firebase-admin) and cannot be real-time listeners.

### 7.2 Catalog doc (`buildCatalogDoc`)
Always: `merchantId, item_id, name, categories, price_cents, in_stock, verified (= approved profile
present), search_text = name | alternateName | categories | tags`. **Only if approved:** `description,
cuisine, course, allergens, flavor_tags, spice_level, vegetarian, vegan, gluten_free, contains_alcohol,
enrichment_confidence`, and a rich `search_text` (name | description | cuisine | course | categories |
ingredients | flavors | good for | diet words). **Then overlay merchant tag facts** (vegan → vegan +
vegetarian; vegetarian; gf / gluten free → gluten_free; 21+ → contains_alcohol). `stock_quantity` if
tracked. `embedding = embed("title: {name} | text: {search_text}")`, recomputed only when search_text
changes (store `embeddedTextHash`).

### 7.3 Search
`embed("task: search result | query: {q}")` → `findNearest({vectorField:"embedding", queryVector, limit:
50, distanceMeasure:"DOT_PRODUCT", distanceResultField:"score"})` on `catalog` **where merchantId == mid
[and in_stock == true]** → **post-filter** in code: price ≤ max, vegetarian / vegan / gluten_free, spice ≤
max, course ==, exclude allergens → take topK. Drop `search_text` and `embedding` from results.

## 8. Gemini

### 8.1 Enrichment, batched (≤10 items per call)
Interactions API, `store:false`, structured JSON output (`response_format` with schema),
**`thinking_level: "low"`**, **`max_output_tokens: 32768`**, no sampling parameters. Status `incomplete`
→ treat as a batch failure (fall back to per-item). (At default thinking, 25 items took ~6 min and the
JSON was truncated mid-array; regression check.) The prompt: normalize a sparse POS record; infer from name, category, tags **and the menu sample**
(cuisine / house style); merchant tags are ground truth; be conservative on vegan/GF and lower confidence;
allergens from the closed list; course from the closed list; one entry per item with `item_id` copied
exactly. Output `{items:[{item_id, profile}]}`; missing items count as failed.

`ItemProfile` (all required): `description` (1–2 appetizing sentences, no invented claims), `cuisine`
(lowercase), `course` ∈ {appetizer, soup_salad, main, side, bread, dessert, drink, other}, `vegetarian`,
`vegan`, `gluten_free`, `contains_alcohol`, `spice_level` 0–3, `allergens` ⊆ {dairy, egg, gluten, peanut,
tree_nut, soy, shellfish, fish, sesame}, `main_ingredients` (3–6), `flavor_tags` (3–6), `good_for`,
`confidence` 0–1 (about diet/allergen fields).

### 8.2 Pairing prompt rules
Head-server persona; up to 4 items a guest would genuinely order **with** the anchor. Start from what it
is classically served with; prefer its own cuisine. A cross-cuisine item is fine **when it plays that
classic role** here (garlic naan standing in for the crusty bread burrata is served with), and then the
reason says so. Never pair across cuisines just because two items share a course. Complement, never
duplicate; saucy → bread/rice; hot → cooling; fewer good pairings beat forced ones; empty is fine. Output
`{anchors:[{anchor_id, pairs:[{item_id, role ∈ {bread, rice, side, drink, dessert, starter, main},
reason}]}]}`.

## 9. HTTP API (Express)

### 9.1 Public agent API (no auth, GET only, so any "fetch URL" tool works)
- `GET /agents/:mid/search?q=&max_price=&vegetarian=&vegan=&gluten_free=&max_spice=&course=&exclude_allergens=a,b`
  → `{count, items, note}`; in-stock only; ≤ 8; **public fields only**: item_id, name, description,
  price "$x.xx", categories, cuisine, course, vegetarian, vegan, gluten_free, contains_alcohol,
  spice_level, allergens, flavor_tags, in_stock, verified. Never stock counts, costs or internals. `note`
  explains `verified=false`.
- `GET /agents/:mid/pairings?dish=` → top-1 match (any stock) → `{found, dish, pairings:[{name, role,
  reason, price, in_stock}] (in-stock only), has_approved_pairings}`.
- **Guard:** q 1–200 chars; per-client token bucket (burst 20, 30/min, client = first X-Forwarded-For
  hop); per-merchant daily budget 5000 → 429; 2-min cache of identical queries; CORS open.

### 9.2 Merchant (capability link, no login)
Key = first 24 hex of HMAC-SHA256(ADMIN_TOKEN, mid), `?k=`.
- `GET /api/review/:mid?k=` → `{merchant, items:[{item_id, name, price_cents, categories, tags, status,
  proposal, approved, pairings:[{item_id, role, reason, name, approved}], pairings_status}]}`,
  pending-first then name; INDEXED items with a profile only.
- `POST /api/review/:mid/:itemId?k=` `{action, profile?, pairing_ids?}` → `{item_id, review_status}`;
  400 on invalid.

### 9.3 Install and webhooks
`GET /connect`, `GET /oauth/callback`, `POST /webhooks/clover` (§3).

### 9.4 Admin (header `X-Admin-Token`)
`POST /admin/snapshot/:mid`, `POST /admin/replay-dead?merchantId=`, `POST /admin/replay-inbox`,
`GET /admin/status/:mid`, `POST /admin/dev-connect/:mid {token}` (**sandbox only**: link a merchant with a
merchant API token, then write the `installed` event).

### 9.5 Demo-only public (no auth by request; production puts these behind operator auth)
- `GET /api/overview` → per merchant: status, times, disconnected reason, item counts by stage, review
  counts by status, itemsWithPairings, job counts by status, inbox counts, 5 recent runs, reviewUrl.
- `GET /api/merchants/:mid/progress` → **SSE**, fed by **Firestore real-time listeners** on `runs` and
  `items` (where merchantId == mid). Events: `hello`, `run {runId, kind, status, cursor, counts}`, `item
  {itemId, name, stage, reviewStatus, hasProposal, hasPairings}` (never the raw item). Keepalive comment
  every 20 s; close after 14 min (the browser reconnects; on reconnect send current state).
- `POST /api/chat {sessionId?, message}` → concierge `{sessionId, reply}`.
- `POST /api/assistant {message}` → general assistant `{reply, fetched:[urls]}`.

### 9.6 Discovery for the demo restaurant (§12)
`GET /sites/bistro`, `/sites/bistro/llms.txt`, `/sites/bistro/.well-known/agent-card.json`.

## 10. Frontend (React + TS, Clover-like look)

Style: system font; white cards on `#f7f7f5`; border `#e4e4df`; accent green `#1a7f37`; amber `#b35c00`
for pending; 12 px radii; responsive to 375 px. Routes:

### 10.1 `/review/:mid?k=`: human in the loop
- **Intro panel** (dismissible; remembered in localStorage, wrapped in try/catch): assistants only answer
  well if the menu says more than name + price; Clover stores no descriptions, ingredients or dietary
  details, so Gemini drafted them. "**Nothing Gemini wrote is shown to anyone until you approve it.**
  Approving never changes your Clover menu."
- **Legend:** `FROM CLOVER · LIVE NOW` (name, price, categories, your tags, availability; already visible,
  synced automatically, edit in Clover) · `SUGGESTED BY GEMINI · NEEDS YOUR OK` (description, cuisine,
  course, dietary flags, spice, allergens, pairings; edit, then approve) · `APPROVED · LIVE` (publishes that
  row; your Clover tags always win).
- **Row:** left: `FROM CLOVER · LIVE` badge, name, price, categories, tag chips (tooltip "Your tag in
  Clover: always wins over Gemini"), hint when no tags. Right: badge `SUGGESTED BY GEMINI · NOT LIVE UNTIL
  YOU APPROVE` or `APPROVED · LIVE FOR ASSISTANTS`; editable description, cuisine, course, spice 0–3,
  allergens, checkboxes vegetarian/vegan/gluten-free/alcohol; pairings as checkboxes (name, role chip,
  reason) under "what an assistant will suggest ordering alongside this dish. Only items from your menu;
  untick any you disagree with." Side: status (Proposal / Live / Live (your edits)), Gemini confidence %
  (amber < 70 % plus "check the diet and allergen fields"), Approve / Save changes button.
- No edits → `approve`; edits → `edit` + changed fields; always send the checked `pairing_ids`. Header:
  "N pending · M live" and **Approve all high-confidence** (≥ 0.8, pending only).
- **Live:** SSE; on `item` with `hasProposal`, refetch after 800 ms and re-render **only if the row count
  changed** (never clobber an edit in progress). Empty state "Reading your menu from Clover…". Fallback
  poll 5 s.

### 10.2 `/admin`
Per merchant: name, status pill, id, connected/last sync, disconnected reason; tiles: catalog by stage,
proposals by review status, pairings proposed, job queue by status, inbox by status; runs table (id,
kind, status, cursor, outcomes, retried-alone count, started, finished); **live line + activity feed**
from SSE (`run` → "kind id: STATUS · cursor N · counts"; `item` → "time · name: enriched by Gemini /
indexed / approved by merchant / pairings proposed", last 6), green dot when connected; debounced refresh
1.5 s after events; safety refresh 60 s. Links: Review, Restaurant website, Agent demo.

### 10.3 `/demo`: the pitch
Title "Can a general AI assistant use this restaurant?" Prefilled prompt: *"I'm vegan, spend under $20,
and don't like very spicy food. Using {site}, pick me a main course that's actually available tonight, and
tell me what to order with it."* Each run is a card: reply, seconds taken, and **"What it fetched"** (URLs
the agent chose). Run it before and after install.

### 10.4 `/chat`: menu concierge
Chat with hint chips: "What goes well with the tikka masala?", "Something vegan under $15 that isn't
spicy", "I'm allergic to dairy. What mains can I have?", "A refreshing drink without alcohol".

### 10.5 `/connect`
One-line value statement; **Connect Clover** button → `/connect` server flow.

## 11. Agents (Gemini function calling on the server, Interactions API, our own tool loop)

Tools are `{type:"function", name, description, parameters}`. Loop: create interaction → for each
`steps[].type === "function_call"` run our function → reply with `{type:"function_result", name, call_id,
result:[{type:"text", text: JSON}]}` and `previous_interaction_id` → until a final text. Cap at 6 tool
rounds. Do **not** use the managed Antigravity agent for these (preview, no structured output, costly).

### 11.1 Menu concierge (knows Vecta)
Tools `search_menu(query, max_price_dollars?, vegetarian?, vegan?, gluten_free?, max_spice_level?,
course?, exclude_allergens?[], include_out_of_stock?)` and `get_pairings(dish)`, same logic as §9.1 for
`DEMO_MERCHANT_ID`. Instruction: always search before recommending; never invent items/prices; constraints
→ filters; for verified=false state only listed facts and suggest confirming with staff; 2–4 picks with a
reason and price; if empty relax the least important constraint and say so; "what goes with X" →
`get_pairings`, never similar dishes; no approved pairings → search bread/side/drink and call them
suggestions. Session memory per `sessionId`.

### 11.2 General assistant (does NOT know Vecta): the control
Only tool `fetch_url(url)` → `{status, content_type, head_links[] (<link> and <meta name="ai-agent…"> from
<head>, stylesheets excluded), text (HTML stripped, ≤12k chars)}`. (Gemini's built-in URL Context tool is
**not** a substitute: it does not expose `<head>` link tags and cannot reach non-public preview URLs.) **SSRF guard: only the app's own
host.** Instruction: general assistant with a browser; open the site; if the page or its head links point
to resources published for AI agents (agent card, llms.txt, API), read and prefer them over scraping; be
concrete, cite where each fact came from, say when guessing. Fresh session per request; return fetched
URLs.

## 12. Discovery: how agents find the menu with nothing installed

`/sites/bistro` is the restaurant's plain HTML site, **deliberately stale**: Burrata $15 (Clover $16); no
Tawa Roti or Cucumber Raita; the sold-out Korean Fried Chicken Sandwich still "NEW"; drinks as a prose
line; no dietary info. Copy it from `DEMO_DATA.md`. A `<!--DISCOVERY-->` placeholder in `<head>` is
replaced **only when the merchant is CONNECTED and has ≥ 1 item** with:
```
<link rel="alternate" type="application/json" title="Agent card" href="{base}/.well-known/agent-card.json">
<link rel="alternate" type="text/plain" title="Instructions for AI agents" href="{base}/llms.txt">
<meta name="ai-agent-instructions" content="{base}/llms.txt">
```
Before that, both documents return **404**. When live (cache 5 min):
- `llms.txt`: restaurant summary; "plain HTTPS GET, no key needed, returns JSON"; the search URL with every
  filter documented; the pairings URL; 3 example URLs; notes on `verified=false`, fair use and the card.
- `agent-card.json` (A2A-style): name, description, `url` = API base, version, provider,
  `preferredTransport: HTTP+JSON`, default modes, `capabilities {streaming:false}`, `documentationUrl`,
  skills `search_menu` / `get_pairings` each with a GET template and an example, `x-usage-policy {auth:
  none for read access, rateLimit, maxResults: 8, bulkExport: not offered}`.

## 13. Operations (operator does these; the app must not assume otherwise)
- After the first Publish, on the Cloud Run service AI Studio created: `--no-cpu-throttling`,
  `--min-instances 1`, `--max-instances 1` (in-process workers, schedules and Clover's app-wide
  concurrency limit), timeout 900 s.
- Point the Clover app's Site URL, Alternate Launch Path and webhook at the deployed URL; verify the
  webhook (the code appears in logs); store the shown auth code as secret `CLOVER_WEBHOOK_SECRET`.
- Create the Firestore vector index (§7.1).
- Logs: structured; metric lines `[metric] clover_429 …`, `[metric] job_dead …`. Secrets never logged.


## 14. Engineering method: test-driven, ports and adapters (MUST)

**Architecture for testability.** All business logic depends on interfaces, never on SDKs directly:
`Store` (merchants, items, catalog, runs, jobs, inbox, events, locks; incl. transactions), `CloverClient`,
`Llm` (enrich, pair, agent turn), `Embedder`, `VectorIndex` (put, patchStock, delete, search), `Clock`.
Production adapters: firebase-admin, fetch-to-Clover, @google/genai Interactions, Firestore findNearest.
**Test adapters: in-memory `Store` (with a real transaction/compare-and-set implementation), fake Clover
(mutable catalog, can inject 401/429/5xx and paging skips), fake Llm/Embedder (deterministic, call
counting, injectable failures and `incomplete`), in-memory VectorIndex, controllable Clock.** This lets the
whole pipeline be tested inside AI Studio with no emulator and no network.

**TDD loop, every feature:** (1) write the failing test(s) named after the FEATURE_MATRIX id
(`E3 rerun of unchanged catalog costs zero Gemini calls`), (2) run and see it fail, (3) implement the
minimum, (4) run all tests green, (5) refactor. Use **Vitest**; `npm test` runs everything; tests live next
to the code (`*.test.ts`). Never mark a phase done with a failing or skipped test. No feature without a test
unless the matrix says "visual".

**Required test cases** (each maps to matrix ids): duplicate idempotency key (D1); concurrent claims never
double-claim, same job delivered N times runs once (D2); lease heartbeat on a clock and lost ownership stops
work (D3); expired lease reclaimed and old owner's heartbeat fails (D4); backoff → DEAD → replay (D5, D6);
yield returns the attempt (D7); inbox event → jobs → DONE, failing write retries then FAILED (C6);
webhook redelivery incl. IS is a no-op, key mapping (C4, C5); first snapshot = one Llm call per chunk and
proposals not served (E1, F4); rerun = zero Llm calls (E3); stock-only change patches without re-embedding
(E4); bad item retried alone and not swept (E5); batch failure / `incomplete` degrades to per-item (E6, F1);
paging-skipped row survives, deleted row removed (E7); crash resumes at cursor and lost lease stops (E2);
incremental without baseline or > 85 days does nothing, never deletes (E8); changed item loses approval
(F6); approve/edit puts profile live and verified (F7); tags override Gemini (F5); pairing validation drops
invented ids / self / bad roles (F8); every search filters by merchant, filters and allergen post-filter
correct (G3, G4); public API exposes only public fields and enforces the guard (H1–H4); discovery 404 before
install and live after (H6–H8); stock rule incl. quantity 0 without autoManage (B3); OAuth state validation
and launch-path redirect (A2); webhook auth (C2); SSRF guard in fetch_url (I3).

## 15. Build order (phases; each ends with all tests green and the listed matrix ids passing)

1. **Skeleton:** Express + React + TS, `/healthz` self-check, Vitest, ports and in-memory adapters, Clock. (L1)
2. **Queue and inbox:** idempotent enqueue, transactional claim, clock heartbeat, backoff/DEAD/replay,
   yield, listener-driven worker, inbox consumer. (C6, D1–D7)
3. **Clover client:** OAuth state, launch-path redirect, token exchange/refresh single-flight/recovery,
   paging, filters, stock rule, concurrency caps, 429 recipe; `/connect`, `/oauth/callback`, webhook with
   auth and inbox write; dev-connect. (A1–A8, B1–B6, C1–C5)
4. **Pipeline:** snapshot job (pages, chunks, cursor, budget/yield), per-item apply, SYNC_ITEM, verified
   sweep, incremental, run bookkeeping; with fake Llm. (E1–E9)
5. **Gemini:** Interactions adapters for enrichment (batched, schema, low thinking, incomplete handling) and
   pairing; embeddings adapter; Firestore vector index adapter and the documented indexes. (F1–F3, F8–F9, G1–G2)
6. **Review gate and search:** buildCatalogDoc, tag overlay, review API, public agent API + guard,
   pairings endpoint. (F4–F7, F10, G3–G5, H1–H4)
7. **Discovery and agents:** stale site, llms.txt, agent card, concierge and general assistant with
   fetch_url + SSRF guard. (H5–H8, I1–I5)
8. **UIs and live progress:** review, admin, demo, chat, connect; SSE from Firestore listeners. (J1–J9, K1–K3)
9. **Schedules and ops:** scheduler lease, hourly/daily staggered reconciles, per-merchant Gemini budget,
   metric logs, README runbook. (D8, L2–L5)