# Vecta-what

**Make any small business's point-of-sale catalog usable by AI agents: one click, no engineers.**

A restaurant installs the Vecta-what Clover app. We read its menu, keep it in sync, have Gemini *propose*
what Clover doesn't store (descriptions, dietary flags, allergens, spice, pairings), let the owner
*approve* it, index it for filtered vector search, and publish discovery documents (`llms.txt`, an agent
card) so any general-purpose assistant can find and use the live menu with nothing installed.

Built for the Berkeley × DeepMind hackathon with **Google AI Studio** (full-stack TypeScript, Gemini,
Firestore) on the Clover sandbox.

| Doc | What it is |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | Full build specification (source of truth) |
| [`docs/FEATURE_MATRIX.md`](docs/FEATURE_MATRIX.md) | Every feature with acceptance criteria; the validation checklist |
| [`docs/DEMO_DATA.md`](docs/DEMO_DATA.md) | Demo merchant menu and the deliberately stale restaurant page |
| [`docs/AI_STUDIO_PROMPT.md`](docs/AI_STUDIO_PROMPT.md) | How to drive AI Studio Build, phase by phase |
| [`AGENTS.md`](AGENTS.md) | Working rules for the coding agent (test-first) |

A reference implementation of the same design (Java / Spring Boot / Vertex AI Vector Search) was built and
run end to end first; this repository is the AI Studio rebuild.
