# Instructions for the coding agent (Google AI Studio Build)

You are building **Vecta-what** from `docs/SPEC.md`. That file is the source of truth; `docs/FEATURE_MATRIX.md`
is how your work is graded; `docs/DEMO_DATA.md` holds the demo menu and the stale restaurant page.

Rules:
1. **Test first.** For every feature: write the failing Vitest test named after its matrix id, run it, see
   it fail, implement, run `npm test` until everything is green. Never finish a phase with a failing or
   skipped test. Business logic depends on the ports in SPEC §14; tests use the in-memory adapters.
2. **Build in the phase order of SPEC §15.** At the end of each phase, list the matrix ids you believe
   pass, and anything you could not do.
3. **Never** weaken a MUST in the spec to make a test pass. If something in the spec is impossible in this
   environment, stop and say so instead of improvising.
4. Server-side only: Gemini calls, Clover calls, Firestore (firebase-admin with the app's named database),
   secrets. The client only calls `/api/*`, `/agents/*` and the SSE stream.
5. Use exactly: `@google/genai` ≥ 2.3 Interactions API, model `gemini-3.8-flash` (thinking `low` for batch
   work, no temperature), `gemini-embedding-2` at 768 dims with the documented prefixes. Never set
   `GOOGLE_API_KEY`.
6. Secrets only from `process.env`: `CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `CLOVER_WEBHOOK_SECRET`,
   `ADMIN_TOKEN`, `CLOVER_ENV`, `PUBLIC_BASE_URL`, `DEMO_MERCHANT_ID`. Never log them; never write them to
   Firestore except the merchant's OAuth grant.
7. **No polling loops against Firestore** (shared free quota: 50k reads/day). Use listeners plus the 60 s
   maintenance query described in SPEC §5.2.
8. Keep Gemini output as a **proposal** until merchant approval (SPEC §1). This is the product.
