# TraceForge — Autonomous Virtual Circuit Diagnostic Laboratory

<img src="public/traceforge-icon-3d.png" alt="TraceForge 3D Icon" width="72" />

## A. Product Identity

TraceForge is a **hardware-free virtual circuit diagnostic laboratory**:
an interactive workbench where engineers practice real diagnostic
reasoning — probing rails, interpreting measurements against datasheet
specs, forming evidence-backed fault hypotheses — on three reference
boards simulated by a deterministic Linear DC engine. No bench, no
parts, no risk: every fault is reproducible, every measurement is
explained, and every diagnosis is scored objectively against withheld
ground truth.

**Engineering problem solved.** Hardware debugging skill is expensive to
build: real faults are irreproducible, probing live boards risks damage,
and datasheet reasoning is rarely practiced end-to-end. TraceForge
closes that gap with a virtual bench (deterministic MNA solver, hidden
fault injection, virtual multimeter), a real AI diagnostician option
(live Muse Spark 1.3 multi-turn tool calling through a server-side
proxy), and an objective scorer — so each session produces a measured
diagnosis score, not a vague impression.

**Core capabilities.**

- Interactive PCB visualization with progressive probe playback and
  live-AI measurement highlights (`src/components/PcbCanvas.tsx`).
- Deterministic Linear DC MNA virtual bench with node voltage, branch
  current, and unpowered continuity/resistance (`src/lib/circuit-simulator.ts`).
- Reproducible hidden fault injection across 3 boards × 3 faults, with
  ground truth strictly withheld until scoring.
- Guided 3-step UX (choose → investigate → review) plus recorded
  investigation replay at zero cost.
- Real Muse Spark 1.3 (`muse-spark-1.3`) multi-turn diagnostic reasoning
  with structured tool calls — always behind an explicit, paid opt-in.
- 18-tool MaaS/MCP server, Cloudflare Worker staging backend with
  OAuth 2.1 PKCE, and AES-256-GCM authenticated session tokens.
- Explicit AI transparency badges on every result: `SIMULATED`,
  `STATIC_FIXTURE`, `RECORDED_LIVE_REPLAY`, `UNVERIFIED`,
  `UNAVAILABLE`, `LIVE_API`.

## B. Visual Overview

Screenshots live in `docs/assets/` (see
[the capture guide](docs/assets/CAPTURE_GUIDE.md)):

![Main laboratory interface and circuit selection](docs/assets/workbench-desktop-step1.png)
*Main laboratory interface & circuit selection (Step 1).*

![Active progressive PCB probing and virtual measurements](docs/assets/workbench-active-probing.png)
*Active progressive PCB probing & virtual measurements (Step 2).*

![Completed diagnosis with ground-truth evaluation and rework guidance](docs/assets/workbench-completed-diagnosis.png)
*Completed diagnosis, ground-truth evaluation & rework guidance (Step 3).*

![Mobile responsive layout](docs/assets/workbench-mobile.png)
*Mobile responsive layout.*

## C. How TraceForge Works

The complete 10-step diagnostic workflow:

1. **Select a circuit (Step 1).** Pick one of the three reference
   boards; each card shows its symptom and a virtual-testing badge.
2. **Hidden fault injection.** The virtual lab injects one reproducible
   `HiddenFault` (or a nominal healthy session). Fault identity, target
   component, and faulted values are sealed inside the session.
3. **Probe the MNA bench (Step 2).** Measure node voltages, branch
   currents, and unpowered continuity/resistance through probe aliases
   (e.g. `TP_NRST`). Each probe consumes budget (`MAX_TOOL_CALLS = 8`).
4. **Compare against datasheet specs.** Every voltage reading is checked
   against its nominal spec and tolerance; abnormal readings are
   flagged, never asserted as root cause.
5. **Muse Spark 1.3 reasons.** In Virtual Lab mode the deterministic
   agent runs locally (`$0.00`); with an explicit `mode: "live"` opt-in,
   the real `muse-spark-1.3` model drives up to 8 bounded tool calls
   through the server proxy.
6. **Hypotheses form.** Candidate causes cite pinout lookups, rail
   checks, and continuity evidence — model-generated hypotheses stay
   visually distinct from verified faults.
7. **Ground-truth reveal (Step 3).** `traceforge.evaluation.score`
   discloses the withheld fault to the owning actor only, then locks the
   scenario against further probing.
8. **Objective scoring (`scoreDiagnosis`).** Component match, fault-type
   match, evidence confirmation, and probe efficiency combine into a
   0–100 score with a written summary.
9. **Rework guidance.** Confirmed faults unlock step-by-step rework
   instructions; unconfirmed hypotheses withhold them honestly.
10. **Verification receipts.** Every mutating tool call returns a
    SHA-256 verification receipt binding the capability, outcome, and
    correlation id for audit.

## D. Supported Reference Circuits

All three boards are simulated by the Linear DC MNA solver
(`src/lib/circuit-simulator.ts`) and documented in
`src/data/samples.ts`.

### 1. FPV Drone Flight Controller (`f405-flight-controller`)

STM32F405RGT6 flight controller. Nodes: `GND`, `LDO_OUT`, `U1-14`,
`U1-15`. Probe aliases: `TP_3V3 → U1-14`, `TP_NRST → U1-15`. Nominal
specs: `U1-14 = 3.267 V`, `U1-15 = 3.240 V` (±5%).

| Fault id | Target | What it models |
|---|---|---|
| `f405-nrst-gnd-short` | NRST net | Solder bridge/short pulling NRST to ground |
| `f405-pullup-open` | Pull-up | Open NRST pull-up resistor |
| `f405-pullup-drift` | Pull-up | Pull-up resistance drifted out of spec |

### 2. ESP32-S3 IoT Sensor Node (`esp32s3-sensor-node`)

ESP32-S3-WROOM-1 sensor node. Nodes: `GND`, `VUSB`, `TP_5V`,
`U2-OUT`. Probe alias: `C4-POS → TP_5V`. Nominal specs:
`TP_5V = 4.956 V`, `U2-OUT = 3.304 V` (±5%).

| Fault id | Target | What it models |
|---|---|---|
| `esp32-c4-rev-leak` | C4 | Reversed-leaky bulk capacitor dragging the rail |
| `esp32-f1-blown` | F1 | Blown input fuse starving the 5 V rail |
| `esp32-div-drift` | Divider | Sense-divider drift corrupting the 3V3 sense |

### 3. USB-C Power Delivery Trigger (`usbc-pd-trigger`)

CH224K PD trigger. Nodes: `GND`, `V5`, `CC1`, `CC2`. Probe aliases:
`TP_CC1 → CC1`, `TP_CC2 → CC2`. Nominal specs: `CC1 = 0.417 V`,
`CC2 = 0.417 V` (±10%, healthy CC2 is the built-in control channel).

| Fault id | Target | What it models |
|---|---|---|
| `usbc-d2-shorted` | D2 | TVS diode D2 failed short (EOS), clamping CC1 to ground |
| `usbc-cc1-pu-open` | R_PU1 | Open CC1 pull-up; Rd holds CC1 at 0 V |
| `usbc-rd-drift` | R_RD1 | CC1 Rd drifted high (5.1 kΩ → 47 kΩ) |

## E. Technical Architecture

- **Frontend:** Vite + React + TypeScript workbench (`src/App.tsx`,
  `src/components/`).
- **Virtual bench:** Linear DC MNA solver
  (`src/lib/circuit-simulator.ts`).
- **Diagnostic agent:** bounded multi-turn loop
  (`src/lib/diagnostic-agent.ts`, `MAX_TOOL_CALLS = 8`).
- **Meta client:** live/simulated Muse Spark 1.3 + SAM transparency
  (`src/lib/meta-client.ts`).
- **Local proxy:** same-origin server proxy attaching `META_API_KEY`
  (`src/server/meta-proxy.ts`).
- **MaaS service:** 18-tool MCP service (`src/maas/tools.ts`) with
  security layer (`src/maas/security.ts`), protocol
  (`src/maas/protocol.ts`), and verification receipts
  (`src/maas/verification.ts`).
- **Cloudflare Worker:** staging backend with OAuth 2.1 PKCE,
  AES-256-GCM tokens, and Edge Cache persistence
  (`worker/index.ts`, `wrangler.toml`).
- **Deployment:** Vercel Hobby frontend with edge rewrites to the
  Worker (`vercel.json`).

```mermaid
flowchart LR
    UI[Vite + React workbench] -->|virtual probes| MNA[Linear DC MNA solver]
    UI -->|explicit live opt-in| Proxy[Server proxy<br/>META_API_KEY server-side]
    Proxy -->|muse-spark-1.3| Meta[(Meta Model API)]
    MCP[MCP clients] -->|OAuth 2.1 PKCE| Worker[Cloudflare Worker]
    Worker --> MaaS[18-tool MaaS service]
    MaaS --> MNA
    MaaS -->|mode live| Meta
    Browser[Vercel frontend] -->|/api/* rewrites| Worker
```

## F. AI Execution Modes

| Mode | Badge | Meaning |
|---|---|---|
| Virtual Lab | `SIMULATED` / `Deterministic Virtual Lab` | Deterministic MNA bench + local agent. Default, `$0.00`. |
| Live AI | `LIVE_API` / `Live Muse Spark 1.3` | Real `muse-spark-1.3` inference via the server proxy. Only after a verified real response; only via explicit opt-in. |
| Recorded Investigation | `RECORDED_LIVE_REPLAY` / `Recorded Live Investigation` | Zero-cost replay of a recorded live session. Never labeled live. |
| Static Reference Fixture | `STATIC_FIXTURE` | Predefined KiCad-derived geometry/overlays. Live SAM 3.1 segmentation is explicitly **deferred** (see §M). |
| Unverified / Unavailable | `UNVERIFIED` / `UNAVAILABLE` | Live path exists but no real response confirmed yet / no key or proxy configured. |

Explicit spend control: an omitted `mode` in
`traceforge.investigations.start` **always** runs simulated, even with a
live client attached. Read-only tools never invoke paid inference.

## G. Installation & Local Development

```sh
npm install
npm run dev      # workbench, default http://localhost:5173
npm test         # full Vitest suite (simulated fixture mode, no keys needed)
npm run build    # TypeScript check + production bundle
npm run preview  # serve the production bundle
```

**Server-only key setup (never in the browser bundle).** Copy
`.env.example` to `.env` and set `META_API_KEY` there (or export it in
the server environment). The Vite middleware and the Cloudflare Worker
attach it server-side; no `VITE_*` variable ever carries it.

**Zero-cost testing.** Without a key, everything runs deterministically:
the MNA bench, the simulated agent, recorded replays, the full test
suite, and the production build — all at `$0.00`.

## H. MCP Integration

Staging endpoint: `https://traceforge-mcp-staging.apd1034.workers.dev/mcp`
(MCP 2025-06-18 JSON-RPC). Public tools need no token; all other tools
need a `Bearer` token with the listed scope. Only
`traceforge.investigations.start` with explicit `mode: "live"` can
consume paid inference credits — every other tool is non-billable.

| Tool | Purpose | Key args | Auth scope |
|---|---|---|---|
| `traceforge.capabilities.list` | List all 18 tools + schemas | — | public |
| `traceforge.system.status` | Health, solver, kill switch, sessions | — | public |
| `traceforge.models.status` | Spark/SAM modes, never calls paid inference | — | public |
| `traceforge.budget.status` | Budget baseline, ledger, safety stop | — | public |
| `traceforge.circuits.list` | 3 boards, symptoms, test points | — | public |
| `traceforge.circuits.get` | Ground-truth-free board view + probe points | `boardId` | public |
| `traceforge.scenarios.list` | Selectors + caller's own sessions | `boardId?` | `scenarios:read` |
| `traceforge.scenarios.create` | Isolated session + receipt (mutates) | `boardId`, `faultSelector?` | `scenarios:write` |
| `traceforge.measurements.voltage` | DC volts at node (mutates budget) | `scenarioId`, `node`, `refNode?` | `measurements:execute` |
| `traceforge.measurements.current` | DC amps via component (mutates budget) | `scenarioId`, `componentId` | `measurements:execute` |
| `traceforge.measurements.continuity` | Unpowered Ω between probes (mutates budget) | `scenarioId`, `probeA`, `probeB` | `measurements:execute` |
| `traceforge.measurements.history` | Probe log + PCB highlights | `scenarioId` | `measurements:read` |
| `traceforge.investigations.start` | Agentic diagnosis (mutates; **only paid path**) | `scenarioId?`, `boardId?`, `mode?` | `investigations:execute` |
| `traceforge.investigations.status` | Status, mode, turns, probes | `investigationId?`, `scenarioId?` | `investigations:read` |
| `traceforge.investigations.history` | Steps, probe log, highlights | `investigationId?`, `scenarioId?` | `investigations:read` |
| `traceforge.investigations.result` | Diagnosis + evidence, truth withheld | `investigationId?`, `scenarioId?` | `investigations:read` |
| `traceforge.evaluation.score` | Score vs hidden fault, discloses truth (mutates: locks) | `scenarioId`, `submission?` | `evaluation:score` |
| `traceforge.evaluation.report` | Full post-evaluation audit report | `scenarioId` | `evaluation:score` |

End-to-end JSON-RPC example (bearer abbreviated):

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
 "params": {"name": "traceforge.scenarios.create",
  "arguments": {"boardId": "f405-flight-controller", "faultSelector": "random"}}}
{"jsonrpc": "2.0", "id": 2, "method": "tools/call",
 "params": {"name": "traceforge.measurements.voltage",
  "arguments": {"scenarioId": "scn_…", "node": "TP_NRST"}}}
{"jsonrpc": "2.0", "id": 3, "method": "tools/call",
 "params": {"name": "traceforge.investigations.start",
  "arguments": {"scenarioId": "scn_…"}}}
{"jsonrpc": "2.0", "id": 4, "method": "tools/call",
 "params": {"name": "traceforge.evaluation.score",
  "arguments": {"scenarioId": "scn_…"}}}
```

OAuth clients use RFC 7591 dynamic registration plus PKCE S256
(`POST /oauth/register` → `GET /oauth/authorize` →
`POST /oauth/token`); each issued token is bound to its own
`actor_oauth_<clientId>` actor with only its granted scopes.

## I. Cloudflare Worker & Vercel Hobby ($0) Deployment

- **Staging Worker** (`traceforge-mcp-staging`, `worker/index.ts`):
  serves MCP, MaaS REST (`/api/maas/*`), browser backend
  (`/api/meta/status`, `/api/meta/chat`, `/api/meta/segment`), health,
  and OAuth discovery. Provision the key once with
  `wrangler secret put META_API_KEY` (optionally
  `TRACEFORGE_SESSION_SECRET` to key session tokens independently);
  the key never leaves the server.
- **Vercel Hobby frontend ($0/month, personal non-commercial
  hackathon demo):** Deployed at
  [`https://traceforge-ten.vercel.app`](https://traceforge-ten.vercel.app)
  (preview [`https://traceforge-hsgcoutoy-aigraphixs-projects.vercel.app`](https://traceforge-hsgcoutoy-aigraphixs-projects.vercel.app)).
  `vercel.json` rewrites `/api/meta/*`,
  `/api/maas/*`, `/mcp`, and `/health` to the staging Worker origin —
  no paid plans, trials, add-ons, domains, or usage billing.
- **Rollback:** redeploy the previous good build in Vercel, or
  `wrangler rollback` / redeploy the prior Worker version; both
  surfaces are stateless apart from Edge Cache (best-effort, same
  colocation — not a substitute for Durable Objects).
- **Cross-request sessions:** `scn_…` / `inv_…` ids are
  self-contained AES-256-GCM tokens, so any isolate holding the
  session secret can hydrate them; completed investigations and
  scorecards are additionally cached at the edge per colocation.

## J. Security

- **Server-side key isolation:** `META_API_KEY` is attached only by
  the local proxy and the Worker; browser bundles, responses, logs,
  and audit summaries never carry it (scrubbed + audited by tests).
- **OAuth 2.1 S256 PKCE** with per-client actor binding
  (`actor_oauth_<clientId>`) and granted-scope enforcement — no
  shared operator mapping.
- **AES-256-GCM + HMAC-SHA-256 tokens:** random 96-bit IV per token,
  prefix bound as Additional Data, constant-time tag checks, and
  `rotateSessionSecret` / `rotateSigningSecret` rotation.
- **Tool scopes & tenant isolation:** every non-public capability
  requires its scope; scenarios/investigations are strictly
  per-actor (`MAAS_CROSS_TENANT_ACCESS_DENIED`).
- **Sliding-window rate limiting** (120 req/min default, per actor)
  and **hierarchical kill switch** (global > write-freeze > per-tool
  > per-token revocation with `MAAS_CREDENTIALS_REVOKED`).
- **Ground-truth isolation:** `assertGroundTruthIsolated` scans every
  pre-evaluation payload; truth reaches the owning actor only via
  `evaluation.score`.
- **Budget safety stop:** live inference halts at `$95.00` of
  verified + runtime spend (see §K and `AGENTS.md` §8).

## K. Test Strategy

Run `npm test` (Vitest, simulated fixture mode — no keys, `$0.00`)
and `npm run build` (`tsc -b` + `vite build`, must report zero
errors). Coverage by area:

- **Unit:** electrical math, parser, samples, guided UX, stabilization.
- **MNA numerical verification:** solver matrices, all-3-board fault
  matrix end-to-end (website-vs-MCP voltage/current agreement).
- **MCP protocol & security:** schemas, auth, tenant isolation,
  rate limits, kill switch, AES-GCM token attacks (IV uniqueness,
  bit-flip, truncation, wrong-key, rotation), OAuth per-client
  isolation, scope enforcement, revocation.
- **Spending control:** omitted-mode defaults to simulated, explicit
  live invokes the client, read-only status never calls inference,
  `$95.00` dual-measure safety stop, shared runtime ledger.
- **Cloudflare Worker:** health/CORS, discovery metadata, PKCE
  exchange, replay protection, `/api/meta/*` routing (503 without
  key, 429 on safety stop), zero-Node-import guard.

What mocked tests do **not** establish: a green suite with stubbed
`fetch` proves protocol, math, isolation, and spend-guard behavior —
never that the external Meta Model API is reachable or billed. Only a
verified `LIVE_API` response (badge + `liveVerified: true` from a real
call) establishes live execution.

## L. Technical Limitations

- **Linear DC MNA only:** resistors, ideal sources, opens/shorts, and
  parameter drift. No nonlinear SPICE Newton-Raphson diode/transistor
  curves, no AC/transient (`C dV/dt`, `L dI/dt`).
- **No physical hardware attachment:** all measurements are virtual;
  nothing here drives a bench instrument.
- **SAM 3.1 live segmentation deferred:** overlays are
  `STATIC_FIXTURE` KiCad geometry by design (see §F, §M).
- **Edge Cache is per-colocation and best-effort:** cold isolates in
  other colos rehydrate from self-contained tokens; Durable Objects
  would be needed for strongly consistent global state.

## M. Project Status & Roadmap

**Implemented:** virtual bench + hidden faults for all 3 boards;
guided 3-step UX with progressive probing and recorded replay; live
Muse Spark 1.3 multi-turn tool calling (explicit opt-in); 18-tool
MaaS/MCP server; Cloudflare Worker with OAuth 2.1 PKCE, AES-256-GCM
tokens, and browser backend routes; Vercel Hobby deployment wiring;
budget ledger with `$95.00` safety stop; full simulated test suite.

**Deferred (not deleted where working):** live SAM 3.1 segmentation
(`STATIC_FIXTURE` overlays); multi-hundred-page PDF/datasheet
ingestion; full nonlinear/transient SPICE coverage; physical hardware
attachment; multi-user accounts, cloud databases, secondary AI models.

## N. Development & Contribution Governance

All work follows [`AGENTS.md`](AGENTS.md): Antigravity coordinates
(planning, review, QA, budget tracking) and never edits implementation
code; Muse Code is the exclusive implementation agent. Key standing
rules: `README.md` + `CHANGELOG.md` must be updated with every
functional change; simulated output is never presented as live
inference; `META_API_KEY` never enters browser bundles or commits;
TraceForge stays isolated from all other projects. The official
private repository is `danny121583/traceforge` (branch workflow,
no force-push, verify identity before remote operations).

## O. License & Usage

Proprietary — All Rights Reserved. No open-source `LICENSE` file is
granted with this repository; no license to copy, modify, or
redistribute is implied.

## P. Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for milestones reconstructed from
Git history.
