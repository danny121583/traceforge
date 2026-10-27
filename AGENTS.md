# AGENTS.md — Engineering Governance, Security & Verification Standards

**Project:** TraceForge — Autonomous Virtual & Hardware Circuit Diagnostic Workbench  
**Repository:** `https://github.com/danny121583/traceforge`  
**License:** MIT License (Open Source)  
**Status:** Active Engineering & Release Governance Contract

---

## 1. Code Quality & Architecture Standards

### Core Engineering Principles
- **Strict TypeScript:** Maintain strict type checking (`strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`) across application code (`src/`), Cloudflare Worker entrypoints (`worker/`), and automated test suites (`tests/`).
- **Deterministic Simulation Engine:** Keep electrical circuit solving local and deterministic via the Linear DC Modified Nodal Analysis (MNA) engine (`src/lib/circuit-simulator.ts`). Never substitute probabilistic model guesses for deterministic circuit math.
- **Model & Coding Attribution:** Application source code and automated tests are implemented with Muse Code (`muse-spark-1.3`), and live runtime reasoning uses Meta Muse Spark 1.3 (`muse-spark-1.3`). Never silently substitute another model or misrepresent simulated execution as live inference.
- **Focused Product Scope:**
  - **Retained Critical Path:**
    1. Interactive PCB visualization (`src/components/PcbCanvas.tsx`).
    2. Deterministic Linear DC MNA virtual circuit simulation (`src/lib/circuit-simulator.ts`).
    3. Reproducible hidden fault injection (`HiddenFault`).
    4. Virtual multimeter measurements (node voltage, branch current, unpowered continuity/resistance).
    5. Muse Spark 1.3 (`muse-spark-1.3`) multi-turn diagnostic reasoning and structured tool calling via server proxy.
    6. Evidence-backed fault hypotheses and datasheet specification comparison.
    7. Objective evaluation against withheld ground truth (`scoreDiagnosis`).
    8. Explicit operational mode transparency (`SIMULATED`, `STATIC_FIXTURE`, `RECORDED_LIVE_REPLAY`, `UNVERIFIED`, `UNAVAILABLE`, `LIVE_API`).
    9. RAG-first TraceForge Assistant (`src/components/TraceForgeAssistant.tsx`, `src/lib/rag-engine.ts`, `src/lib/assistant-server.ts`) and 25-tool MCP server (`src/maas/tools.ts`, `src/server/maas-mcp-server.ts`, `worker/index.ts`).
  - **Deferred Outside Critical Path:**
    - Live SAM 3.1 image segmentation API calls (static KiCad reference overlays remain explicitly labeled `STATIC_FIXTURE`).
    - Multi-hundred-page raw PDF ingestion in browser.
    - Nonlinear/transient SPICE coverage.
    - Physical bench hardware peripherals.

---

## 2. Testing & Verification Standards

Every feature, bug fix, or knowledge-base update requires independent verification across all of the following gates before merge or deployment:

1. **Automated Test Suite (`npx vitest run`):** All unit, integration, cryptographic, MCP protocol, Cloudflare Worker, and RAG QA benchmark tests must pass with zero failures.
2. **TypeScript Validation (`tsc -b` / `tsc --noEmit`):** Zero compiler or type errors.
3. **Production Build (`npm run build`):** Clean Vite production bundle build with zero broken imports or asset errors.
4. **Independent Mathematical & Physics Verification:** Verify MNA nodal matrix solutions, voltage divider ratios, branch currents, and continuity resistances against independent reference calculations.
5. **Error Handling Verification:** Validate behavior on singular matrices, floating nodes, invalid test points, expired/revoked OAuth tokens, malformed JSON-RPC payloads, and exhausted budget thresholds.
6. **Actual-vs-Simulated Capability Classification:** A passing unit test suite using mocks must never be presented as proof that an external AI model or remote endpoint is functioning live.
7. **Live Endpoint & Browser Verification:** Verify both the deployed frontend (`https://traceforge-ten.vercel.app`) and the deployed MCP/OAuth Worker (`https://traceforge-mcp-staging.apd1034.workers.dev`) across desktop (`1440x900`, `1920x1080`) and mobile (`390x844`, `430x932`) viewports in both Dark Mode and Light Mode.

---

## 3. Security, Credential Isolation & Cryptographic Standards

### Authentication & Credential Isolation
- **Strict Server Boundary:** `META_API_KEY` must exist only on trusted server/Worker secret storage (`traceforge-mcp-staging` on Cloudflare Workers or local server proxy environment). It must never be exposed in `VITE_*` variables, browser bundles, client-visible responses, logs, screenshots, or Git commits.
- **Separate Authentication Contexts:** Developer CLI credentials and runtime `META_API_KEY` secrets are strictly isolated and must never be extracted, printed, or reused across contexts.
- **Default Non-Billable Execution:** When `mode` is omitted on MCP diagnostic tools or `allowLiveInference` is omitted/false on assistant requests, execution defaults strictly to deterministic local simulation or RAG retrieval (`$0.00` live API spend).

### Session & Token Cryptography
- **Authenticated Encryption (`encryptSignedToken` / `decryptSignedToken`):**
  - Scenario (`scn_…`) and investigation (`inv_…`) stateless tokens use AES-256-GCM with fresh 96-bit random IVs (`crypto.getRandomValues`, NIST SP 800-38D, explicit 128-bit authentication tag, token prefix bound as Additional Authenticated Data) combined with outer Encrypt-then-MAC full 256-bit HMAC-SHA-256 verification.
  - Subkeys for AES-256-GCM and HMAC-SHA-256 are derived via standard Web Crypto HKDF-SHA-256 with distinct domain-separation info labels (`traceforge-aead-hkdf-v3` and `traceforge-hmac-hkdf-v3`).
- **OAuth 2.1 + PKCE & Refresh Rotation:**
  - Remote MCP connections enforce OAuth 2.1 Authorization Code + PKCE (`S256`), short-lived access tokens (3600s), single-use rotating refresh tokens (`grant_type=refresh_token`), revocation (`POST /oauth/revoke`), and persistent Dynamic Client Registration (`POST /oauth/register`) backed by `TraceForgeStateDO` and Edge Cache.
  - Never issue non-expiring bearer tokens.

---

## 4. Documentation & Public Repository Standards

1. **`README.md` Accuracy:** `README.md` is the authoritative public technical overview of the application and must be verified against current source code before every push or merge.
2. **Capabilities & Roadmap Honesty:** Clearly distinguish implemented features, simulated/fixture modes, and planned roadmap items. Never describe a deterministic diagnostic solver as live model inference, and never describe static PCB artwork as live SAM segmentation.
3. **Changelog Maintenance:** Accompany meaningful architectural, feature, security, and UX updates with accurate entries in `CHANGELOG.md`.
4. **Public Documentation Hygiene:** Do not expose private credentials, bearer tokens, personal local filesystem paths, or internal billing telemetry on the public website or in general user-facing documentation.

---

## 5. Version Control & GitHub Release Policy

- **Official Repository:** `https://github.com/danny121583/traceforge` (Owner: `danny121583`).
- **Repository Visibility & License:** `PUBLIC` repository licensed under the Open Source **MIT License** (`LICENSE`).
- **Branching & Hygiene:**
  - Maintain `main` as the verified release branch and keep active feature branches synchronized only after full test, build, and live deployment verification.
  - Stage files explicitly; never commit build artifacts (`dist/`, `tsconfig.tsbuildinfo`), `node_modules/`, `.wrangler/`, or `.env*` secret files.
  - Never use personal access tokens embedded in Git remote URLs, and never force-push (`git push --force`) or rewrite published history without explicit owner approval.
- **Pre-Push Verification Checklist:**
  1. Confirm GitHub account and repository owner (`danny121583/traceforge`).
  2. Confirm `git status` and `git diff` contain only intended changes.
  3. Confirm zero secrets or private local paths exist in tracked files.
  4. Confirm `npx vitest run` and `npm run build` pass cleanly.

---

## 6. Deployment Safety & Hosting Standards

- **Frontend Hosting (Vercel):**
  - Deployed to `https://traceforge-ten.vercel.app` using zero-cost static/rewrite hosting (`vercel.json`).
  - No paid plans, no paid add-ons, no billable storage upgrades, and no frontend secret environment variables.
- **Backend & MCP Hosting (Cloudflare Workers):**
  - Deployed to `https://traceforge-mcp-staging.apd1034.workers.dev` (`traceforge-mcp-staging`, `wrangler.toml`) using the free SQLite-backed Durable Object (`TraceForgeStateDO`) and Edge Cache for cross-isolate consistency.
- **Post-Deployment Verification:**
  - After every deployment, independently verify HTTPS responses, OAuth discovery (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`), MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`), assistant endpoints (`/api/assistant/session`, `/api/assistant/chat`), and responsive UI rendering.

---

## 7. Budget Controls & Promotional Credit Policy

Operational budget accounting is enforced programmatically in `src/maas/tools.ts` and surfaced through the MCP tool `traceforge.budget.status` and the authorized server endpoint `GET /api/maas/telemetry` (`traceforge:audit:read`).

- **Dated Promotional-Credit Ledger Checkpoint (Verified `2026-10-27T00:40:47-05:00`):**
  - **Starting Promotional Balance (Recorded `2026-10-26T15:56:48-05:00`):** `$147.26`
  - **Last Verified Promotional Balance (`2026-10-27T00:40:47-05:00`):** `$113.63` (`$33.63` cumulative consumed across Muse Code CLI and live runtime API; `$66.37` remaining of the `$100.00` maximum authorized project budget)
  - **Maximum Authorized Project Consumption:** `$100.00`
  - **Mandatory Ending Promotional Reserve Floor:** `$47.26` or more
  - **Internal Safety Stop Threshold:** `$95.00` cumulative consumption (`HARD_SAFETY_STOP_USD = 95.00` — automatically halts discretionary live API calls to preserve a `$5.00` safety buffer above the `$47.26` reserve floor)
  - **TraceForge Assistant Live Allowance:** `$2.00` sub-cap (`ASSISTANT_LIVE_ALLOWANCE_USD = 2.00`, `<= 10` live calls per session, `<= 2` concurrent live requests) counted within the shared runtime ledger
  - **Out-of-Pocket Spending Limit:** `$0.00` (strictly prohibited — never charge a payment card, enable paid subscriptions, or purchase additional credits)
- **Future Checkpoint Rule:** Any update to promotional-credit ledger constants in `src/maas/tools.ts` must record an explicit ISO-8601 timestamp (`LAST_VERIFIED_AT`) and synchronize `AGENTS.md` and `tests/maas-mcp.test.ts` in the same commit.

---

## 8. AI Transparency, Diagnostic Integrity & RAG-First Assistant Policy

### Operational Mode Transparency
Every AI or diagnostic operation must maintain an explicit operational mode in code state and responses:
- `LIVE_API` — Verified live execution through `muse-spark-1.3`.
- `SIMULATED` — Deterministic local virtual lab execution.
- `STATIC_FIXTURE` — Predefined KiCad reference geometry or static fixture data.
- `RECORDED_LIVE_REPLAY` — Replayed trace from a previously captured live investigation.
- `UNVERIFIED` / `UNAVAILABLE` — Live service unconfigured or unreachable.

### Diagnostic Integrity & Ground-Truth Isolation
1. Keep physical measurements, simulated MNA measurements, datasheet specifications, model hypotheses, verified faults, recommended tests, and post-diagnosis ground-truth evaluation strictly distinct.
2. **Ground-Truth Isolation Rule:** Withheld fault definitions (`HiddenFault`, injected fault parameters, faulted component IDs) must never be included in Muse Spark prompts, tool schemas, assistant context, or visible circuit descriptors prior to formal diagnosis submission (`scoreDiagnosis`).

### TraceForge Assistant (RAG-First, Knowledge-Versioned, Budget-Gated)
- **RAG-First Routing:** Every assistant request runs deterministic local retrieval (`src/lib/rag-engine.ts`) against the versioned knowledge base (`src/data/knowledge-base.ts`, `docs/knowledge/traceforge-knowledge-base.md`, pinned by `KB_VERSION`) first. Knowledge answers, conversational follow-ups, and policy refusals complete locally with zero live model calls (`liveInvoked: false`).
- **Knowledge Versioning:** Any change to knowledge base content must bump `KB_VERSION` and update `tests/assistant-rag.test.ts` in the same change set.
- **Explicit Live-Call Gate:** At most one live `muse-spark-1.3` completion (`max_tokens: 350`) may run per user message, and only when `allowLiveInference === true`, a valid session ticket or `traceforge:live_inference:execute` token is presented, a server-side `META_API_KEY` is configured, and the shared budget ledger grants a reservation. Otherwise, the assistant returns a deterministic knowledge response without retrying or failing with HTTP 500.
