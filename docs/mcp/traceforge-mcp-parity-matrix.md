# TraceForge Website vs. MCP Feature-Parity Matrix & Custom PCB Upload Roadmap

Authoritative audit of every user-facing TraceForge feature against the
MCP operations that expose it. Status vocabulary (exact, five values):

- `Available through website and MCP`
- `Website-only`
- `MCP-only`
- `Not yet implemented`
- `Requires additional infrastructure or authorization`

The MCP surface is 25 tools (`TRACEFORGE_MAAS_TOOL_DESCRIPTORS` in
`src/maas/tools.ts`, `WORKER_TOOL_COUNT = 25` in `worker/index.ts`):
18 circuit-diagnostic tools plus 7 assistant & knowledge base tools
(`traceforge.kb.search`, `traceforge.chat.status`,
`traceforge.chat.start`, `traceforge.chat.ask`,
`traceforge.chat.history`, `traceforge.chat.clear`,
`traceforge.chat.feedback`). Both surfaces share the same engines: the
deterministic Linear DC MNA solver, the RAG-first assistant
(`src/lib/assistant-server.ts`, `src/lib/rag-engine.ts`), and the
`$95.00` project safety stop.

## Capability audit

### 1. Reference board selection & inspection

Status: `Available through website and MCP`

Step 1 cards and the PCB canvas on the website;
`traceforge.circuits.list`, `traceforge.circuits.get`, and
`resources/read` (`traceforge:///boards/<boardId>`) on MCP. Payloads
carry nominal specs and probe-point coordinates only — never withheld
fault answers.

### 2. Fault scenario listing & isolated session creation

Status: `Available through website and MCP`

Fault dropdown and Re-roll on the website;
`traceforge.scenarios.list` and `traceforge.scenarios.create` on MCP.
Sessions are actor-isolated self-contained AES-256-GCM tokens
(`scn_…`), synchronized across isolates through Edge Cache plus the
`TraceForgeStateDO` Durable Object coordinator.

### 3. Virtual multimeter measurements (DC voltage, branch current, unpowered continuity/resistance, history)

Status: `Available through website and MCP`

Manual multimeter and probe sweep on the website;
`traceforge.measurements.voltage`, `traceforge.measurements.current`,
`traceforge.measurements.continuity`, and
`traceforge.measurements.history` on MCP. Every probe consumes the
shared 8-probe budget (`MAX_TOOL_CALLS = 8`).

### 4. Autonomous diagnostic investigations (Virtual Lab `$0.00` & explicit Live AI `muse-spark-1.3`)

Status: `Available through website and MCP`

Step 2 Investigate on the website; `traceforge.investigations.start`,
`traceforge.investigations.status`,
`traceforge.investigations.history`, and
`traceforge.investigations.result` on MCP. Omitted modes always run
deterministic Virtual Lab simulation (`$0.00`); only explicit live
opt-in with scope, key, and budget headroom runs paid
`muse-spark-1.3` inference, labeled `LIVE_API`.

### 5. Ground-truth evaluation & 0–100 diagnostic scoring

Status: `Available through website and MCP`

Step 3 Review Results and manual suspect scoring on the website;
`traceforge.evaluation.score` on MCP. Scoring discloses the withheld
`HiddenFault` to the owning actor only, then locks the scenario
against further probing. Scorecards are immutable across isolates.

### 6. Post-evaluation audit report & rework guidance

Status: `Available through website and MCP`

Step 3 six-part result card on the website;
`traceforge.evaluation.report` on MCP. Rework guidance is authorized
only for evidence-confirmed faults and honestly withheld otherwise.

### 7. Component pinout, nominal spec & test-point inspection

Status: `Available through website and MCP`

Clickable SVG component overlays and the test-point strip on the
website; `traceforge.circuits.get` component, probe-point, and nominal
spec payloads on MCP.

### 8. TraceForge AI Assistant (multi-turn conversation, session grounding, feedback, usage status)

Status: `Available through website and MCP`

Floating `TraceForgeAssistant` widget plus `/api/assistant/*` on the
website; `traceforge.chat.start`, `traceforge.chat.ask`,
`traceforge.chat.history`, `traceforge.chat.clear`,
`traceforge.chat.feedback`, and `traceforge.chat.status` on MCP. Both
surfaces run the same RAG-first engine: deterministic local retrieval
over the versioned knowledge base (`KB_VERSION`) at `$0.00` first,
session grounding in a sanitized context (`HiddenFault` strictly
withheld), and at most one paid `muse-spark-1.3` call only when live
inference is explicitly authorized and budget headroom exists
(`$2.00` shared chat allowance, `traceforge:live_inference:execute`
scope). Conversations are actor-isolated on both surfaces.

### 9. Direct knowledge base search & 20-question deterministic QA benchmark

Status: `Available through website and MCP` (search);
`MCP-only` (scripted 20-question batch benchmark)

RAG search powers website chat directly; `traceforge.kb.search`
exposes the same BM25 + synonym retrieval over MCP at `$0.00` with
ranked sources, coverage level, and `kbVersion`. The deterministic
20-question QA benchmark (`STANDARD_20_QA_BENCHMARK`, all 18 knowledge
topics plus session troubleshooting and one prompt-injection refusal
probe) runs via `traceforge.chat.ask` with
`runStandard20QuestionQa: true` — knowledge-only, `$0.00`, zero live
calls — and is exposed as a batch operation on MCP only.

### 10. Interactive SVG PCB pan/zoom & zero-cost recorded replay animation

Status: `Website-only`

Visual canvas manipulation (zoom, pan, clickable pads) and animated
step playback live in `PcbCanvas.tsx` / `App.tsx`. MCP returns the
underlying coordinate highlights instead (`pcbHighlight` /
`pcbHighlights` in measurement and history payloads), so agents get
positions without a renderer.

### 11. Uploaded custom PCB / schematic / KiCad / Gerber / photo ingestion & live SAM 3.1 segmentation

Status: `Not yet implemented` (arbitrary upload parsing, netlist
extraction, live SAM 3.1 segmentation); `Requires additional
infrastructure or authorization` (production rollout of the same)

The website Advanced Tools panel supports appending custom `.txt` /
`.md` symptom and datasheet notes locally, but arbitrary
user-uploaded PCB image/CAD parsing, netlist extraction, and live
SAM 3.1 segmentation are not implemented in the critical demo path.
Exact missing dependencies: (a) a server-side
KiCad/Gerber/IPC-2581/schematic netlist parser mapping physical pads
to an MNA netlist, (b) a verified `sam-3.1` vision segmentation
upstream endpoint plus coordinate-to-netlist registration, (c)
sandboxed object storage with upload validation, and (d) scoped
authorization and abuse limits for untrusted uploads. Safe
implementation roadmap without building an unrestricted upload
subsystem now: stage 1 — accept a declared netlist JSON sidecar
alongside uploads and simulate only declared nets; stage 2 — add a
read-only KiCad footprint/pad parser that emits coordinates but no
electrical semantics; stage 3 — verify the `sam-3.1` endpoint on
reference artwork and register mask coordinates to declared pads;
stage 4 — gate uploads behind storage quotas, validation, and the
existing budget safety stop before any production rollout.
