# TraceForge Changelog

Milestones reconstructed from Git history. No release dates or version
numbers are claimed here — entries are ordered oldest-first as they
landed on the project branches.

## Phase 1 — Workbench foundation & stabilization

- Initial Vite + React + TypeScript workbench with the Meta Model API
  client layer (`muse-spark-1.3` / `sam-3.1`), electrical helpers, and a
  structured-output parser.
- Documented the hardware-free evaluation strategy: no physical bench is
  required to exercise the full diagnostic loop.
- Phase 1 stabilization: diagnostic integrity rules, SAM transparency
  modes, and the first green unit suite.

## Phase 1.5 — Linear DC MNA virtual lab & live multi-turn tool calling

- Deterministic Linear DC MNA circuit solver with reproducible hidden
  fault injection (`HiddenFault`) and a withheld-fault scoring harness
  (`scoreDiagnosis`).
- Server-side proxy boundary: `META_API_KEY` is read only on the Node
  server side; the browser bundle never sees it.
- Milestones B–E: multi-turn agentic diagnostic loop with a token/cost
  ledger, promotional-credit budget tracking, and verified live
  `muse-spark-1.3` multi-turn tool calling through the local proxy.

## Guided 3-step UX & progressive probing

- Guided 3-step workbench flow — Step 1 choose circuit, Step 2
  investigate with progressive PCB probing, Step 3 review diagnosis
  against ground truth.
- Live AI measurement highlights on the PCB, a test-point status strip,
  a measurement-history timeline, and recorded-investigation replay
  (`RECORDED_LIVE_REPLAY`, always labeled, never `LIVE_API`).

## 18-tool MaaS/MCP server & Cloudflare Worker OAuth 2.1 PKCE

- Independent 18-tool MaaS/MCP service (`traceforge.*`) with
  authentication, per-scope authorization, sliding-window rate limiting,
  hierarchical kill switch, sanitized audit log, and SHA-256 verification
  receipts.
- Cloudflare Worker staging package (`traceforge-mcp-staging`) serving
  MCP JSON-RPC, MaaS REST, OAuth 2.1 PKCE (S256), and RFC 9728 / RFC 8414
  discovery metadata.
- Cross-isolate stateless scenario/investigation hydration, session
  expiry, billing checkpoint constants, and per-colocation Edge Cache
  persistence.

## 3D TraceForge icon & Virtual Lab terminology

- Custom 3D TraceForge PCB-trace icon (header badge, favicon,
  touch icon) and Virtual Lab terminology across the workbench so
  simulated execution is never presented as live inference.

## Session hardening, explicit spend control & Vercel Hobby deployment

- AES-256-GCM + HMAC-SHA-256 authenticated session tokens
  (`scn_…` / `inv_…`) replacing XOR/FNV-1a; per-client OAuth actor
  binding (`actor_oauth_<clientId>`); HMAC-SHA-256 stateless Worker
  signing with secret rotation; cross-isolate auth-code replay
  protection via Edge Cache.
- Explicit live-AI spending control: omitted `mode` always defaults to
  simulated (`$0.00`); only explicit `mode: "live"` triggers paid
  `muse-spark-1.3` inference; read-only tools never invoke paid calls;
  `$95.00` safety stop enforced against verified + runtime spend.
- Production browser backend on the Cloudflare Worker
  (`/api/meta/status`, `/api/meta/chat`, `/api/meta/segment`) with
  Vercel Hobby (`$0/month`) frontend rewrites (`vercel.json`) deployed at
  `https://traceforge-ten.vercel.app`.
- Verified billing checkpoint: `$122.78` balance / `$24.48` consumed as
  of `2026-10-26T20:08:24-05:00`.

## MCP session consistency, UI polish & release verification

- Cross-isolate session consistency (`src/lib/circuit-simulator.ts`,
  `src/maas/tools.ts`): `VirtualLabSession.restoreProbeLog` restores
  committed probes on cold isolates; budget is charged only AFTER a
  measurement succeeds (failed probes never consume budget); every
  scenario read merges the canonical `PersistedScenarioState` from
  Edge Cache (versioned probe-log union, canonical investigation,
  immutable `evaluated`/`scorecard`) and every mutation
  (`measurements.*`, `investigations.start`, `evaluation.score`)
  awaits Edge Cache persistence (`Cache-Control: max-age=1800`).
- Deterministic per-scenario investigation identity: canonical
  `inv_…` tokens use a fixed sequence plus a SHA-256-derived IV per
  `(scenarioId, ownerActorId)`, so `status`/`history`/`result`/
  `score`/`report` agree on one `investigationId` warm and cold;
  scenario tokens keep random IVs. Per-actor Edge Cache index keeps
  `scenarios.list` consistent across isolates with strict
  actor isolation.
- Ordinary UI no longer renders the Technology, Telemetry & Budget
  drawer, token counters, or cost math (`src/App.tsx` keeps the
  `BudgetMonitor` export and every ledger/safety control live); Step 2
  carries one compact mode badge (`Virtual Lab` / `Live AI` /
  `Recorded Investigation`); Step 3 shows a plain Investigation
  Summary. Technical diagnostics require server authorization:
  `GET /api/maas/telemetry` (`Bearer` + `traceforge:audit:read`,
  `401`/`403` otherwise) returning system, model, and budget status.
- Layout polish (`src/App.tsx`, `src/index.css`): equal-height
  circuit cards with pinned bottom badges and zero-shift selection,
  one-line fault-scenario control bar, unified Step 2 action bar with
  subtle demo-pacing control; PCB visualization size and behavior
  unchanged.
- Regression coverage: 6 multi-isolate consistency tests
  (`tests/maas-mcp.test.ts` area 22, shared mock `caches.default`
  across independent service instances) and 3 telemetry
  authorization tests (`tests/cloudflare-worker.test.ts`).

## `*.workers.dev` strong consistency via `TraceForgeStateDO` & mobile overflow fix

- Free-tier SQLite Durable Object coordinator `TraceForgeStateDO`
  (`worker/index.ts`, `TRACEFORGE_STATE_DO` binding + `v1`
  `new_sqlite_classes` migration in `wrangler.toml`): the default
  Worker entrypoint routes every request through the canonical
  `traceforge-canonical-v1` singleton (falling back to the shared
  in-process worker with no binding, preserving unit-test
  compatibility), whose transactional storage backs
  `PersistedScenarioState` on `*.workers.dev` at `$0.00/month`.
- Durable-first reads/writes: `edgeCacheGet`/`edgeCachePut`
  (`src/maas/tools.ts`) and the OAuth one-time-code consumption
  helpers (`isCodeConsumedInEdgeCache` /
  `markCodeConsumedInEdgeCache`, `worker/index.ts`) check the global
  durable storage hook before `caches.default` (a no-op on
  `*.workers.dev`); `resolveInvestigation` hydrates + syncs the owning
  scenario via `requireOwnedScenario` on `investigationId` hits so cold
  isolates always see warm scenario state.
- Regression coverage: `TraceForgeStateDO` + `export default.fetch`
  persistence test (`tests/cloudflare-worker.test.ts`) proving probe
  counts (`1 → 2 → 3`), ordered history, one stable investigation id,
  and byte-identical scorecards across reconstructed DO instances
  sharing one storage Map (simulated redeploy/isolate eviction).
- Mobile `390px` overflow fix (`src/index.css`): `overflow-x: hidden`
  + `max-width: 100%` on `body`/`.tf-app`, wrapping fault label, fluid
  fault-select width (full-width below `960px`), tighter mobile header
  padding.

## Final UX layout, unified Live AI status, OAuth 2.1 refresh tokens & AES-GCM SIV hardening

- **Fault scenario controls (`src/App.tsx`, `src/index.css`):** exact
  `36px` height and top/bottom edge parity between the `Fault scenario:`
  dropdown and `Re-roll random fault` button on desktop (`flex-wrap: nowrap`),
  with full-width stacked controls on mobile (`<= 960px`) and complete
  dependent-state reset on re-roll.
- **Integrated PCB component inspection & left-column Advanced Tools
  (`src/components/PcbCanvas.tsx`, `src/App.tsx`, `src/index.css`):**
  moved component inspection directly inside the PCB card below the
  test-point strip with keyboard-accessible SVG overlays, and moved
  `Advanced Tools & Manual Bench Controls` to the left column directly
  below the PCB (`open` by default) to balance the two-column layout.
- **Completed investigation layout & 6-part result hierarchy
  (`src/App.tsx`, `src/components/DiagnosticPanel.tsx`, `src/index.css`):**
  auto-collapses `Investigation Activity & Probe Log` once an
  investigation completes so `Step 3 · Review Results` sits immediately
  near the top of the right column in a 6-part hierarchy (Diagnosis
  Summary, Fault Classification & Verification Status, Supporting
  Measurements, Ground-Truth Evaluation & Score, Recommended Next
  Steps, and Rework Guidance).
- **Simplified terminology & unified Live AI status model
  (`src/lib/guided-ux.ts`, `src/components/Header.tsx`,
  `src/components/PcbCanvas.tsx`, `src/components/DiagnosticPanel.tsx`,
  `src/App.tsx`):** replaced developer enum strings (`LIVE_API`,
  `[Virtual Measurements]`, `Static Fixture (KiCad)`,
  `Video Demo Pacing (animate each probe)`) with clean user-facing
  labels (`Circuit Reference Layout`, `Animate Investigation`,
  `Virtual measurement`) and a single unified AI status model across
  Header, Step 2, and Step 3 (`Virtual Lab`, `Recorded Investigation`,
  `Live AI Ready`, `Live AI Investigating`,
  `Completed with Muse Spark 1.3`, `Live AI Unavailable`).
- **OAuth 2.1 refresh-token rotation & revocation (`worker/index.ts`):**
  added `grant_type=refresh_token` and `POST /oauth/revoke` with
  one-time refresh-token rotation, replay rejection, client binding,
  scope preservation/narrowing, and durable persistence in
  `TraceForgeStateDO` so ChatGPT MCP connections survive 1-hour access
  token expiration without manual re-authentication.
- **AES-256-GCM Synthetic IV (SIV) nonce safety (`src/maas/tools.ts`):**
  bound any deterministic IV seed to the exact serialized plaintext via
  `SHA-256("traceforge-aead-siv-v3::" + secret + "::" + prefix + "::" + seedHex + "::" + plaintext)`
  so distinct plaintexts can never share a 96-bit AES-GCM IV under the
  same key while identical `(scenarioId, ownerActorId)` payloads remain
  deterministic across cold isolates.
- **Superseded by the cryptographic token remediation + TraceForge
  Assistant milestone below:** deterministic IVs removed entirely in
  favor of fresh random IVs per token with full 256-bit HMAC tags.

## Cryptographic token remediation, billing checkpoint & TraceForge Assistant

- **Cryptographic token remediation (`src/maas/tools.ts`,
  `tests/maas-mcp.test.ts`, `tests/cloudflare-worker.test.ts`):**
  removed `deterministicIvForInvestigation` and the `ivOverride`
  parameter; every `encryptSignedToken` call mints a fresh 96-bit
  random IV (`crypto.getRandomValues`, NIST SP 800-38D, explicit
  `tagLength: 128`, prefix bound as Additional Data). AES-256-GCM and
  HMAC-SHA-256 keys derive via standard Web Crypto HKDF-SHA-256 with
  distinct info labels (`traceforge-aead-hkdf-v3`,
  `traceforge-hmac-hkdf-v3`). Outer Encrypt-then-MAC upgraded to the
  full 64-hex-char HMAC tag, verified in constant time before
  decryption. Canonical `investigationId` values are reused from
  stored state (persisted via `TraceForgeStateDO` / Edge Cache) so
  cold isolates sharing storage converge on one id.
- **Legacy `BudgetMonitor` removal:** deleted the banner export from
  `src/App.tsx` (with unused helpers/imports) and the
  `.tf-tech-drawer` rules from `src/index.css`; technical diagnostics
  stay behind server-authorized access only.
- **Billing checkpoint:** `LAST_VERIFIED_BALANCE_USD = 113.63`,
  `LAST_VERIFIED_CONSUMED_USD = 33.63`,
  `LAST_VERIFIED_TIMESTAMP = '2026-10-27T00:40:47-05:00'`.
- **`vercel.json`:** added the `/api/assistant/:path*` rewrite to the
  staging Worker plus `Cache-Control: no-cache, no-store,
  must-revalidate` for `/` and `/index.html`.
- **Versioned knowledge base & RAG-first engine
  (`src/data/knowledge-base.ts` @ `KB_VERSION = '2026.10.27-v2'`,
  `docs/knowledge/traceforge-knowledge-base.md`,
  `src/lib/rag-engine.ts`):** 18 topics, deterministic inverted-index
  + synonym + BM25 retrieval with `high`/`medium`/`low` coverage,
  prompt-injection refusal, greeting handling, session-grounded
  answers with pre-evaluation ground-truth isolation, and truthful
  knowledge-only fallbacks at `$0.00`.
- **Assistant budget & endpoints (`src/maas/tools.ts`,
  `src/lib/assistant-server.ts`, `worker/index.ts`,
  `src/server/maas-mcp-server.ts`):** `$2.00` shared chat allowance
  (`ASSISTANT_LIVE_ALLOWANCE_USD`), ≤10 calls/session, ≤2
  concurrent, 1000-char input / 8-message history caps, 350-token
  output cap; usage tracked in the shared runtime ledger (persisted
  via `persistEdgeRuntimeSnapshot`, surfaced in
  `traceforge.budget.status`); `GET|POST /api/assistant/session`
  issues HMAC-signed `tf_chat_…` tickets and
  `POST /api/assistant/chat` answers knowledge-first with at most 1
  fully-authorized live call, else graceful knowledge fallback (never
  a retry, never a 500).
- **Floating TraceForge Assistant UI
  (`src/components/TraceForgeAssistant.tsx`, `src/index.css`,
  `src/App.tsx`):** launcher + card panel with the 6 suggested
  questions, source pills, Clear/Close/Escape controls, auto-scroll,
  duplicate-send prevention, and stale-response protection.
- **Regression coverage (`tests/assistant-rag.test.ts`, 47 tests):**
  KB topics + version, suggested questions at `$0.00`, greetings,
  session grounding with ground-truth isolation, prompt-injection
  refusal, full server gating matrix, and the authorized single-call
  live path with ledger recording.
