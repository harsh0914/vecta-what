# Prompts for Google AI Studio Build

Import this repository first: Build mode → **+** → **Import from GitHub** → `harsh0914/vecta-what`.
Then add the secrets in **Settings → Secrets**: `CLOVER_APP_ID`, `CLOVER_APP_SECRET`,
`CLOVER_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `CLOVER_ENV=sandbox`, `DEMO_MERCHANT_ID=PWXW6VQTEWJ11`,
`PUBLIC_BASE_URL` (set after the first Publish). Ask for the Firebase database when phase 2 needs it.

Send one prompt per phase. After each, the validator grades the result against
`docs/FEATURE_MATRIX.md` and replies with fixes; paste those back before moving on.

---

## Kick-off (send first)

> Read `AGENTS.md`, `docs/SPEC.md`, `docs/FEATURE_MATRIX.md` and `docs/DEMO_DATA.md` in full. We will build
> Vecta-what test-first, in the phase order of SPEC §15, one phase per message. Before writing code, reply
> with: (1) your understanding of the product in five bullet points, (2) the ports and adapters you will
> create (SPEC §14), (3) anything in the spec you think is impossible or ambiguous in this environment.
> Do not start phase 1 until I say go.

## Phase prompts (send one at a time, after the previous one is green and validated)

1. > Phase 1 of SPEC §15 (skeleton). Express + React + TypeScript, `listen(process.env.PORT || 8080)`,
   > `/healthz` self-check, Vitest, all ports with in-memory adapters and a controllable Clock. Tests first.
   > Finish with `npm test` output and the matrix ids you believe pass.
2. > Phase 2 (queue and inbox). Add the Firebase database now; server uses firebase-admin with the app's
   > named database. Implement SPEC §5.1–§5.2 test-first against the in-memory Store, then the Firestore
   > adapter. Listener-driven worker, no polling. Report `npm test` and matrix ids C6, D1–D7.
3. > Phase 3 (Clover). SPEC §3 and §9.3–§9.4 test-first with a fake Clover client, then the real client.
   > Report matrix A1–A8, B1–B6, C1–C5.
4. > Phase 4 (pipeline). SPEC §6.1–§6.5 test-first with fake Llm/Embedder/VectorIndex. Report E1–E9.
5. > Phase 5 (Gemini + vector). SPEC §7.1–§7.2 and §8 adapters: Interactions API enrichment (batched,
   > schema, thinking low, incomplete handling), pairing, gemini-embedding-2 embeddings, Firestore
   > findNearest adapter; print the gcloud index commands for my database id. Report F1–F3, F8–F9, G1–G2.
6. > Phase 6 (review gate, search, public API). SPEC §6.6–§6.7, §7.3, §9.1–§9.2. Report F4–F7, F10,
   > G3–G5, H1–H4.
7. > Phase 7 (discovery + agents). SPEC §11, §12, §12.1. Both stale sites verbatim from DEMO_DATA.md,
   > `/api/compare` with the deterministic fact-check. Report H5–H9, I1–I6.
8. > Phase 8 (UIs + live progress). SPEC §10 and §9.5 SSE from Firestore listeners, Clover-like styling,
   > responsive to 375 px. Report J1–J9, K1–K3.
9. > Phase 9 (schedules + ops). SPEC §5.3, metric logs, README runbook (Cloud Run flags, Clover URLs,
   > index commands, database upgrade). Report D8, L1–L5. Then Publish.

## After Publish (operator)
Set `PUBLIC_BASE_URL`; Cloud Run: CPU always allocated, min 1, max 1, timeout 900 s (re-check after every
Publish); click **Upgrade database**; create vector indexes; point the Clover app (Site URL, launch path
`/oauth/callback`, webhook `/webhooks/clover`) at the published URL and verify the webhook; install on the
Bistro.
