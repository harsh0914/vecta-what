# Feature matrix: what we want vs. what is built

The validator fills **Status** (✅ pass · ⚠️ partial · ❌ missing · 🔎 not yet checked) and **Evidence**
(test name, request/response, screenshot, or code reference). "How to verify" is what the validator runs.
Section numbers refer to `SPEC.md`.

## A. Install and Clover connection

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| A1 | Connect page | `/connect` shows value line + Connect button to Clover authorize with a valid signed state | open page; inspect link | 🔎 | |
| A2 | Launch-path handling | `/oauth/callback?merchant_id=X` without our state → 302 to `/oauth/v2/authorize` with a fresh state; a legacy `code` is ignored | curl | 🔎 | |
| A3 | Token exchange | valid state + code → POST `/oauth/v2/token` JSON; grant saved to `merchants/{mid}` before any response | code review + install | 🔎 | |
| A4 | Install → event | after the grant write, one `installed` inbox event with **no token**; Connected page links to signed review URL | Firestore + page | 🔎 | |
| A5 | Refresh single-flight | refresh when < 5 min left; transaction lease; rotating refresh token never spent twice | code review + test | 🔎 | |
| A6 | Token recovery | 401 + `X-Clover-Recovery-Available: true` → `/oauth/v2/recovery` | code review | 🔎 | |
| A7 | Auth failure | Clover 401/403 → merchant DISCONNECTED, job DEAD (no retries) | test | 🔎 | |
| A8 | Dev connect (sandbox only) | `POST /admin/dev-connect/:mid {token}` links via merchant token; refused when `CLOVER_ENV != sandbox` | curl | 🔎 | |

## B. Clover reads and limits

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| B1 | Paged item listing | `expand=categories,tags,itemStock` (≤3 expands), limit 1000, offset paging to short page | logs / code | 🔎 | |
| B2 | Incremental filter | `filter=modifiedTime>=ms` only on incremental runs | code | 🔎 | |
| B3 | Stock rule | quantity 0 without autoManage = in stock; `available=false` = out | test + Bistro: Tawa Roti in stock, KFC sandwich out | 🔎 | |
| B4 | Concurrency caps | ≤4 in-flight per merchant, ≤8 app-wide | code | 🔎 | |
| B5 | 429/5xx backoff | ≥1 s, honour `retry-after`, exponential + jitter, ≤8 attempts, logs `X-RateLimit-*` | code | 🔎 | |
| B6 | Headers | Bearer auth header only; `User-Agent: VectaWhat / …` | code | 🔎 | |

## C. Webhooks and inbox

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| C1 | Verification handshake | `{verificationCode}` logged and 200 | Clover dashboard "Send verification code" | 🔎 | |
| C2 | Auth | wrong/missing `X-Clover-Auth` → 401; unset secret rejects all | curl | 🔎 | |
| C3 | Fast ack | handler writes one inbox doc, responds < 1 s | curl timing | 🔎 | |
| C4 | Event mapping | I/IS/IA → SYNC_ITEM per object; IC/IG/IM → one full reconcile; others ignored | test + edit an item in Clover | 🔎 | |
| C5 | Idempotent redelivery | same delivery twice → no new jobs | test | 🔎 | |
| C6 | Inbox durability | consumer creates jobs + marks DONE in one transaction; failure retries with backoff, FAILED after 5, replayable | test + admin | 🔎 | |

## D. Job queue and workers

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| D1 | Idempotent enqueue | id = hash(key); duplicate is a no-op | test | 🔎 | |
| D2 | Atomic claim | concurrent claims never double-claim; same job delivered N times runs once | test | 🔎 | |
| D3 | Lease + clock heartbeat | lease 10 min; renewed every 60 s from a timer; lost ownership stops the job | test | 🔎 | |
| D4 | Expired lease reclaim | dead worker's job is claimed again; old owner's heartbeat fails | test | 🔎 | |
| D5 | Backoff + dead letter | 30 s·2^(n-1); DEAD after 5; fatal → DEAD immediately | test | 🔎 | |
| D6 | Replay | `/admin/replay-dead` requeues DEAD with attempts 0 | curl | 🔎 | |
| D7 | Yield | long job hands back between pages; attempt not consumed | test | 🔎 | |
| D8 | Schedules | hourly incremental, daily 10:00 UTC full, staggered per merchant, idempotent per bucket | code + wait | 🔎 | |

## E. Snapshot, CDC and reconcile

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| E1 | One job per snapshot | any catalog size; page stream; chunks of 10, 4 parallel | code + run doc | 🔎 | |
| E2 | Cursor resume | crash/lease loss mid-run resumes at committed cursor; finished pages not refetched | test | 🔎 | |
| E3 | Hash skip | rerun of unchanged catalog = 0 Gemini calls | test + counts `unchanged` | 🔎 | |
| E4 | Stock patch | stock-only change patches index without re-embedding or Gemini | test + change stock in Clover | 🔎 | |
| E5 | Failure isolation | a bad item → FAILED, counted, retried alone; run COMPLETE_WITH_FAILURES; not swept | test | 🔎 | |
| E6 | Batch degrade | batch Gemini failure → per-item calls | test | 🔎 | |
| E7 | Verified sweep | not-seen items re-fetched before delete; paging-skipped row survives; deleted row removed | test | 🔎 | |
| E8 | Incremental window | `lastSyncedAt − 10 min`, fixed at start; skip if none or > 85 days; never deletes | test | 🔎 | |
| E9 | Run bookkeeping | counts, failedItemIds, lastSyncedAt = run start, `run_finished` event, PAIR_MENU enqueued | Firestore | 🔎 | |

## F. Gemini proposals and review gate

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| F1 | Batched structured enrichment | ≤10 items/call; JSON schema; thinking LOW; max output 32768; model gemini-3.8-flash | code + timing (< 60 s/batch) | 🔎 | |
| F2 | ItemProfile schema | all fields; closed enums for course and allergens; spice 0–3; confidence 0–1 | code + sample doc | 🔎 | |
| F3 | Menu context | whole-menu sample (≤300) and merchant context in prompt | code | 🔎 | |
| F4 | Proposals not served | before approval the index holds only Clover facts + tag facts; `verified=false` | API response | 🔎 | |
| F5 | Tags win | Clover Vegan/GF/21+ override Gemini, approved or not | test + API | 🔎 | |
| F6 | Changed item loses approval | source change → PENDING, approvedProfile cleared | test | 🔎 | |
| F7 | Approve / edit | approve → APPROVED; edit validated → EDITED; catalog doc rewritten, verified=true | UI + API | 🔎 | |
| F8 | Pairing proposals | per menu after snapshot; profile cuisine in prompt; valid ids only, ≤4, role enum; version bump re-pairs without re-enriching | Firestore + UI | 🔎 | |
| F9 | Pairing quality | curries → naan / roti / rice / raita / lassi; no random cross-cuisine; cross-cuisine only when it plays the classic role and says so | read proposals | 🔎 | |
| F10 | Pairing review | merchant keeps/drops individual pairings; approved pairings served | UI + /pairings | 🔎 | |

## G. Vector search

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| G1 | Catalog docs + embeddings | 768-d gemini-embedding-001, RETRIEVAL_DOCUMENT; re-embed only when search_text changes | Firestore | 🔎 | |
| G2 | Vector index | composite index merchantId + in_stock + embedding (COSINE); command documented | gcloud / README | 🔎 | |
| G3 | Tenant pre-filter | every findNearest has `merchantId ==` | code + test | 🔎 | |
| G4 | Filters | price, vegetarian, vegan, gluten_free, spice, course, allergen exclusion correct | API queries | 🔎 | |
| G5 | Relevance | "hearty dinner" vegan ≤ $15 returns Chana Masala / Quinoa Bowl-class results, not drinks first | API | 🔎 | |

## H. Public agent API and discovery

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| H1 | `/agents/:mid/search` | GET, no auth, ≤8, in-stock, public fields only, `note` | curl | 🔎 | |
| H2 | No internal leakage | never stock_quantity, confidence, embedding, search_text, tokens | curl | 🔎 | |
| H3 | `/agents/:mid/pairings` | resolves dish, returns approved in-stock pairings with reasons | curl | 🔎 | |
| H4 | Abuse guard | q length, token bucket 20/30 per min → 429, merchant daily budget, 2-min cache | curl loop | 🔎 | |
| H5 | Stale restaurant site | `/sites/bistro` matches DEMO_DATA (stale on purpose) | open | 🔎 | |
| H6 | Discovery gated on install | before connect: no head links; llms.txt and agent-card 404 | curl | 🔎 | |
| H7 | llms.txt | instructions + all filters + 3 example URLs + notes | curl | 🔎 | |
| H8 | agent-card.json | A2A-style fields, skills with GET templates, usage policy | curl | 🔎 | |

## I. Agents

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| I1 | Concierge tools | search_menu with all filters; get_pairings | code + chat | 🔎 | |
| I2 | Concierge behaviour | never invents; 2–4 picks with price; pairing questions use pairings, not similar dishes; caveats for verified=false | chat: "what goes with the tikka masala?" | 🔎 | |
| I3 | General assistant isolation | only fetch_url; knows nothing about Vecta; SSRF guard (own host only) | code + try external URL | 🔎 | |
| I4 | Discovery behaviour | reads head links / llms.txt / card when present and prefers them; returns fetched URLs | /demo after install | 🔎 | |
| I5 | Before/after difference | before: scrapes stale page (may offer sold-out / wrong price / no pairing); after: correct vegan main + house pairing | /demo twice | 🔎 | |

## J. UIs

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| J1 | Clover-like style | colours, cards, radii per §10; responsive at 375 px | visual | 🔎 | |
| J2 | Review intro + legend | copy per §10.1; dismiss remembered | visual | 🔎 | |
| J3 | Review rows | source badges both sides, editable fields, pairings checkboxes, confidence, status, buttons | visual | 🔎 | |
| J4 | Approve logic | approve vs edit + changed fields + pairing_ids | network tab | 🔎 | |
| J5 | Bulk approve | high-confidence (≥0.8) pending only | visual + data | 🔎 | |
| J6 | Live review | SSE adds rows as batches land; never clobbers an edit; poll fallback | watch during snapshot | 🔎 | |
| J7 | Admin page | cards, tiles, runs table, live line + feed, links | visual during snapshot | 🔎 | |
| J8 | Demo page | prompt, run cards with reply, time, fetched URLs | visual | 🔎 | |
| J9 | Chat page | concierge chat with 4 hint chips | visual | 🔎 | |

## K. Live progress (SSE)

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| K1 | Stream | `text/event-stream`; hello/run/item events; keepalive 20 s; closes ≤ 14 min | curl -N | 🔎 | |
| K2 | Source of truth | fed by Firestore listeners (works across instances), not in-memory | code | 🔎 | |
| K3 | Payload hygiene | item events never include the raw item or tokens | curl -N | 🔎 | |

## L. Operations and non-functional

| ID | Feature | Acceptance criteria | How to verify | Status | Evidence |
|---|---|---|---|---|---|
| L1 | Secrets | only from the Secrets panel/env; never logged; never in inbox/jobs | grep + logs | 🔎 | |
| L2 | Firestore rules | client access denied; server-only | rules file | 🔎 | |
| L3 | Metric logs | `[metric] clover_429`, `[metric] job_dead` | code | 🔎 | |
| L4 | Test suite | all §14 cases present and passing | run tests | 🔎 | |
| L5 | Ops runbook | README documents Cloud Run flags, Clover URLs, vector index command | README | 🔎 | |
