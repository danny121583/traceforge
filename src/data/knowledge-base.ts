/**
 * TraceForge versioned knowledge base (RAG-first assistant grounding).
 *
 * `KB_VERSION` pins the exact knowledge snapshot the assistant answers
 * from; every `/api/assistant/chat` response echoes it as `kbVersion` so
 * clients can tell which snapshot grounded an answer. When knowledge
 * changes, bump `KB_VERSION` AND update the RAG regression tests in
 * `tests/assistant-rag.test.ts` alongside the code change.
 *
 * All 18 entries are static, reviewed documentation — answering from them
 * runs locally at zero cost and never invokes live model inference.
 */

export const KB_VERSION = '2026.10.27-v4';

export interface KnowledgeBaseEntry {
  /** Stable entry id (used in RAG source citations). */
  id: string;
  /** Human-readable title shown in source pills. */
  title: string;
  /** Topic aliases used for classification. */
  topics: string[];
  /** High-signal keywords used for retrieval. */
  keywords: string[];
  /** Grounded documentation text (one or more paragraphs). */
  content: string;
}

export const SUGGESTED_QUESTIONS: string[] = [
  'How does TraceForge work?',
  'Help me troubleshoot a circuit.',
  'What does NRST mean?',
  'Explain my diagnosis.',
  'How do virtual measurements work?',
  "What's the difference between Virtual Lab and Live AI?",
];

export const KNOWLEDGE_BASE_ENTRIES: KnowledgeBaseEntry[] = [
  {
    id: 'getting-started',
    title: 'TraceForge Documentation — Getting Started',
    topics: ['getting started', 'introduction', 'how traceforge works', 'overview', 'workflow', 'capabilities', 'features', 'what can i do', 'help'],
    keywords: ['traceforge', 'workbench', 'virtual', 'laboratory', 'getting', 'started', 'workflow', 'step', 'diagnostic', 'hardware-free', 'capabilities', 'features', 'options', 'else', 'help', 'theme', 'light', 'dark'],
    content: [
      'TraceForge is a hardware-free virtual circuit diagnostic laboratory: an interactive workbench where you practice real diagnostic reasoning on three reference boards simulated by a deterministic Linear DC engine. No bench, no parts, no risk: every fault is reproducible, every measurement is explained, and every diagnosis is scored objectively against withheld ground truth.',
      'The complete workflow has three guided steps. Step 1, Choose Circuit: pick one of the three reference boards (FPV Drone Flight Controller F405, ESP32-S3 IoT Sensor Node, or USB-C Power Delivery Trigger); TraceForge secretly injects one hidden electrical fault into the virtual circuit. Step 2, Investigate: run an autonomous AI investigation or probe manually — the virtual multimeter measures node voltages, branch currents, and unpowered continuity, each probe consuming the 8-probe budget. Step 3, Review Results: compare the AI diagnosis against the hidden fault with an objective 0–100 score, then follow rework guidance for confirmed faults.',
      'Everything runs free by default in Virtual Lab mode (deterministic simulation). Live Muse Spark 1.3 inference (Live AI) is a strictly explicit, paid opt-in. A zero-cost recorded-investigation replay is available for demonstration without spending anything, and the workbench header includes a Light/Dark theme toggle with persistent theme preference.',
    ].join('\n\n'),
  },
  {
    id: 'selecting-circuits',
    title: 'TraceForge Documentation — Selecting Circuits',
    topics: ['selecting circuits', 'boards', 'reference boards', 'choose circuit'],
    keywords: ['circuit', 'board', 'select', 'f405', 'flight', 'esp32', 'sensor', 'usbc', 'pd', 'trigger', 'reference', 'choose'],
    content: [
      'TraceForge ships three reference circuits, selectable as cards in Step 1. Each card shows the board name and its reported symptom; all probing uses the board test points.',
      '1) FPV Drone Flight Controller (f405-flight-controller, STM32F405RGT6): symptom is no USB enumeration with the NRST test pad near 0 V instead of the 3.3 V pull-up. Probe aliases: TP_3V3 maps to U1-14, TP_NRST maps to U1-15. Nominal specs: U1-14 = 3.267 V, U1-15 = 3.240 V (±5%).',
      '2) ESP32-S3 IoT Sensor Node (esp32s3-sensor-node): symptom is boot-loops with brownout resets, a sagging 5 V rail, and a hot C4 capacitor. Probe alias: C4-POS maps to TP_5V. Nominal specs: TP_5V = 4.956 V, U2-OUT = 3.304 V (±5%).',
      '3) USB-C Power Delivery Trigger (usbc-pd-trigger, CH224K PD sink): symptom is no PD negotiation with CC1 stuck at 0 V while CC2 shows a healthy pull-up voltage. Probe aliases: TP_CC1 maps to CC1, TP_CC2 maps to CC2. Nominal specs: CC1 = 0.417 V, CC2 = 0.417 V (±10%); the healthy CC2 channel is the built-in control for CC1 faults.',
      'Use the Fault scenario dropdown to pick Nominal / Healthy (no fault), Random Hidden Fault, or a specific fault id for practice. Re-roll random fault resets all dependent state and injects a fresh hidden fault.',
    ].join('\n\n'),
  },
  {
    id: 'hidden-fault-scenarios',
    title: 'TraceForge Documentation — Hidden Fault Scenarios',
    topics: ['hidden fault', 'fault scenarios', 'fault injection', 'fault types'],
    keywords: ['hidden', 'fault', 'scenario', 'injection', 'solder', 'bridge', 'short', 'open', 'drift', 'reverse', 'polarity', 'leakage', 'f405', 'esp32', 'usbc'],
    content: [
      'Each reference board models three reproducible hidden faults (3 boards × 3 faults). Fault identity, target component, and faulted values are sealed inside the virtual-lab session and strictly withheld from the AI until scoring — the model only ever sees nominal component values and symptoms.',
      'F405 faults: f405-nrst-gnd-short (solder_bridge on U1: solder splash shorting the NRST net to ground), f405-pullup-open (open_circuit on R_PULLUP: cracked pull-up resistor, leakage drags NRST low), f405-pullup-drift (parameter_drift on R_PULLUP: 40 kΩ drifted to 470 kΩ, NRST divider sags).',
      'ESP32-S3 faults: esp32-c4-rev-leak (reverse_polarity_leakage on C4: reversed tantalum capacitor leaking DC current and dragging the 5 V rail down), esp32-f1-blown (open_circuit on F1: blown input fuse, rail side floats near 0 V through the load), esp32-div-drift (parameter_drift on R_DIV2: sense divider lower resistor drifted low, corrupting the 3V3 sense).',
      'USB-C PD faults: usbc-d2-shorted (shorted_component on D2: TVS diode failed short from electrical overstress, clamping CC1 to ground), usbc-cc1-pu-open (open_circuit on R_PU1: open CC1 pull-up, Rd holds CC1 at 0 V — distinguish from a short by continuity), usbc-rd-drift (parameter_drift on R_RD1: CC1 Rd drifted high from 5.1 kΩ to 47 kΩ, CC1 floats above the valid range).',
    ].join('\n\n'),
  },
  {
    id: 'starting-investigations',
    title: 'TraceForge Documentation — Investigation Lifecycle',
    topics: ['starting investigations', 'investigation', 'lifecycle', 'investigate', 'agentic diagnosis'],
    keywords: ['investigation', 'start', 'lifecycle', 'agent', 'diagnose', 'probing', 'hypothesis', 'turns', 'simulate'],
    content: [
      'An investigation is an autonomous AI diagnostic run against your scenario bench. Start one from Step 2 (Investigate): the agent inspects the circuit layout and reported symptom, selects test points, takes virtual-multimeter measurements one by one (Initializing → Probing → Updating hypothesis → Completed), then submits an evidence-backed diagnosis with a component reference, fault class, and verification status (confirmed or hypothesis).',
      'Investigations default to Virtual Lab mode (free): an omitted mode always runs the deterministic Virtual Lab agent, even when a live client is attached. Only an explicit live opt-in triggers paid Muse Spark 1.3 inference. Each investigation consumes the shared 8-probe budget; the 9th probe is rejected with a budget-exhausted error.',
      'Track progress in the Investigation Activity panel (step stream), the Activity Summary, and the Measurement History Timeline table. After scoring (evaluation.score), the scenario locks against further probing — plan all measurements before you score.',
      'Sessions expire after 30 minutes of wall-clock time; expired sessions reject further calls until you create a fresh scenario.',
    ].join('\n\n'),
  },
  {
    id: 'voltage-measurements',
    title: 'Measurement Guide — Node Voltage',
    topics: ['voltage measurements', 'node voltage', 'multimeter', 'virtual measurements', 'rails'],
    keywords: ['voltage', 'volts', 'node', 'rail', 'measure', 'multimeter', 'powered', 'nominal', 'tolerance', 'abnormal', 'spec'],
    content: [
      'Virtual voltage measurements read the powered DC potential of a circuit node relative to GND (or an optional reference node) using the deterministic MNA solver — the exact math a real DMM would approximate on the bench. Probe by pad or node id (for example TP_NRST, U1-14, CC1); aliases like TP_NRST resolve to their circuit node automatically.',
      'Every voltage reading is compared against its nominal datasheet spec and tolerance; abnormal readings are flagged, never asserted as root cause. Examples: F405 U1-14 nominal 3.267 V and U1-15 nominal 3.240 V (±5%); a crushed NRST near 0 V is decisively abnormal. ESP32-S3 TP_5V nominal 4.956 V (±5%); 4.2 V is a −16% sag, outside tolerance. USB-C CC1/CC2 nominal 0.417 V (±10%); CC1 at 0 V against a healthy CC2 isolates the fault to the CC1 line.',
      'Voltage probes consume one unit of the 8-probe tool budget and are logged with formatted values (for example 0.020 V). Unknown nodes are rejected without consuming budget; always measure first and hypothesize second.',
    ].join('\n\n'),
  },
  {
    id: 'current-measurements',
    title: 'Measurement Guide — Branch Current',
    topics: ['current measurements', 'branch current', 'ammeter'],
    keywords: ['current', 'amps', 'milliamps', 'branch', 'component', 'ammeter', 'load', 'draw', 'excess'],
    content: [
      'Virtual current measurements read the DC branch current through a component id (for example R_LOAD, R_PULLUP, F1, R_PU1) using the deterministic MNA solver. Positive current flows from the component nodeA to nodeB by convention.',
      'Use current to confirm excessive-draw hypotheses: a reversed tantalum capacitor on the 5 V rail draws hundreds of milliamps of leakage (ESP32-S3 idles near 90 mA through R_LOAD when healthy, far more when C4 leaks); a shorted TVS diode sinks the CC pull-up current to ground. Compare against the healthy-board expectation before concluding.',
      'Current probes consume one unit of the 8-probe tool budget. Unknown component ids are rejected without consuming budget.',
    ].join('\n\n'),
  },
  {
    id: 'continuity-resistance',
    title: 'Measurement Guide — Continuity & Resistance',
    topics: ['continuity', 'resistance', 'ohmmeter', 'unpowered', 'short'],
    keywords: ['continuity', 'resistance', 'ohms', 'beep', 'short', 'unpowered', 'ohmmeter', 'open', 'dmm'],
    content: [
      'Virtual continuity measurements read the unpowered resistance between two probes (for example U1-14 ↔ U1-15, CC1 ↔ GND) with the supplies unplugged in the model — matching real DMM practice of power-off ohmmeter tests. Below 2.0 Ω the meter beeps SHORT; above it reads OPEN with the ohm value.',
      'Continuity is the decisive short-circuit test. A solder bridge between adjacent LQFP pins reads a fraction of an ohm (F405 U1-14 ↔ U1-15 at 0.4 Ω is a direct pin-to-pin short). A blown TVS diode reads ~0.2 Ω from CC1 to GND (dead short). A healthy pull-up network reads kilohms to megohms (open).',
      'Rules: the two probes must resolve to different nodes — self-continuity (same node both sides) is rejected. Continuity probes consume one unit of the 8-probe budget. Confirm every suspected short with power removed before concluding, and never confuse an open pull-up (0 V via Rd, but high resistance to GND) with a true short (0 V with near-zero ohms).',
    ].join('\n\n'),
  },
  {
    id: 'diagnostic-evidence',
    title: 'Investigation Results Guide — Evidence & Hypotheses',
    topics: ['diagnostic evidence', 'evidence', 'hypotheses', 'diagnosis', 'explaining diagnosis'],
    keywords: ['evidence', 'hypothesis', 'diagnosis', 'explain', 'abnormal', 'nominal', 'confirmed', 'verify', 'classification'],
    content: [
      'A TraceForge diagnosis has four parts: the proposed component reference (for example U1, C4, D2), the fault class (solder_bridge, shorted_component, open_circuit, parameter_drift, reverse_polarity_leakage), the verification status (confirmed or hypothesis), and a written explanation citing the measurements.',
      'Evidence is classified from probe records alone: abnormal voltages list every node measured decisively outside its nominal spec; shorted continuities list every probe pair that beeped SHORT; probe count records the investigation cost. A diagnosis is confirmed only when electrical measurements decisively back it — for example NRST at 0.02 V against a 3.24 V nominal plus 0.4 Ω between U1-14 and U1-15 confirms a solder bridge. Without decisive measurements it stays an unverified hypothesis, and rework guidance is honestly withheld.',
      'Model-generated hypotheses are always visually distinct from verified faults: hypotheses cite pinout lookups, rail checks, and continuity evidence, while verified faults carry the ground-truth evaluation score. A photograph alone never confirms an electrical fault — only meter evidence does.',
    ].join('\n\n'),
  },
  {
    id: 'scoring-verification',
    title: 'Investigation Results Guide — Scoring & Verification',
    topics: ['scoring', 'verification', 'score', 'evaluation', 'points', 'grade'],
    keywords: ['score', 'scoring', 'points', '100', 'evaluation', 'verify', 'component', 'match', 'efficiency', 'probes', 'grade', 'result'],
    content: [
      'Evaluation (evaluation.score) grades your diagnosis against the withheld hidden fault on a 0–100 scale: component match (did you name the right component?), fault-type match (did you name the right fault class?), evidence confirmation (did decisive abnormal measurements back it?), and probe efficiency (fewer probes score higher). The summary sentence explains the total; the breakdown lists componentMatch, faultTypeMatch, evidenceConfirmed, probeCount, and efficiencyScore.',
      'If your score seems lower than expected (for example 94/100 instead of 100), check the breakdown: a near-perfect score with one miss usually means the component was right but the fault class was slightly off (for instance open_circuit versus parameter_drift on the same resistor), or the evidence was thin (a correct guess with no abnormal measurement confirming it), or extra probes reduced the efficiency component. The score summary names exactly which part missed.',
      'Scoring requires at least one probe plus a proposed diagnosis; it discloses the hidden fault to the owning actor only, then locks the scenario against further probing. Scores are immutable: re-scoring or requesting the report returns the identical scorecard on every isolate. You can also submit an explicit componentRef/faultType/verificationStatus triple for manual scoring.',
    ].join('\n\n'),
  },
  {
    id: 'advanced-manual-controls',
    title: 'TraceForge Documentation — Advanced Bench Controls',
    topics: ['advanced controls', 'manual controls', 'bench controls', 'probe sweep', 'datasheet analysis'],
    keywords: ['advanced', 'manual', 'sweep', 'multimeter', 'probing', 'armed', 'datasheet', 'upload', 'suspect', 'legacy'],
    content: [
      'Beyond one-click investigations, the Advanced Tools & Manual Bench Controls panel offers full manual control. Manual Multimeter Probing: arm the probes, click PCB pads to set probe A/B, read the live meter (voltage A vs GND, continuity A↔B), then log each probe — logged probes count against the 8-probe tool budget.',
      'Virtual Probe Sweep runs a budgeted scripted sweep: spec rails first, then continuity on the first abnormal node. Ground Truth (Manual Reveal) shows the withheld fault only after you choose to reveal it. Manual Suspect Scoring lets you pick a suspect component plus fault class and score it directly against ground truth.',
      'Custom Symptom & Datasheet Upload appends your own symptom text or .txt/.md notes to the diagnostic context. Legacy Datasheet Analysis assembles the board datasheet sections into the model context window and streams a legacy diagnosis with citations.',
    ].join('\n\n'),
  },
  {
    id: 'common-errors',
    title: 'Measurement Troubleshooting — Common Errors',
    topics: ['common errors', 'errors', 'troubleshooting errors', 'error messages'],
    keywords: ['error', 'unknown', 'invalid', 'budget', 'exhausted', 'expired', 'locked', 'evaluated', 'reject', 'blocked', 'auth'],
    content: [
      'Unknown measurement node or component: the bench rejects probe ids it cannot resolve (for example NOPE-999 or R_NOPE). Check the board probe points and aliases (TP_NRST, TP_3V3, C4-POS, TP_CC1) and retry — failed probes never consume budget.',
      'Self-continuity rejected: the two continuity probes resolved to the same electrical node (for example U1-15 and TP_NRST, which are aliased). Pick two genuinely different nets.',
      'Probe budget exhausted: you have used all 8 probes of the 8-probe budget; the 9th probe is rejected. Start a fresh scenario or score the evidence you have.',
      'Scenario already evaluated: after evaluation.score discloses ground truth, the scenario locks and all further probing is rejected by design — re-probe before you score, not after.',
      'Session expired: scenarios expire after 30 minutes; create a fresh scenario. Authentication errors (missing token, wrong scope, revoked token, or another actor tenant) mean the call needs the right Bearer token and scope.',
      'Live AI unavailable: live mode needs a server-side META_API_KEY plus budget headroom; without them the workbench stays in Virtual Lab and reports the proxy state honestly instead of fabricating results.',
    ].join('\n\n'),
  },
  {
    id: 'pcb-interaction-zoom',
    title: 'TraceForge Documentation — Interactive PCB Canvas',
    topics: ['pcb', 'canvas', 'interaction', 'zoom', 'pan', 'probe points'],
    keywords: ['pcb', 'canvas', 'zoom', 'pan', 'click', 'pads', 'probe', 'layout', 'reset', 'drag', 'overlay'],
    content: [
      'The Interactive Circuit Layout renders each board as a zoomable, pannable SVG schematic-style canvas with clickable component overlays and test-point pads. Zoom + / Zoom − step the magnification (1× to 4×), Reset restores the full-board view, and dragging pans while zoomed in.',
      'Click a component overlay to inspect its part number and pinout; click test-point pads to arm manual probes (A then B). During investigations, live pulse rings mark the actively probed pad, readout callouts show measured values, and continuity vectors draw the A↔B path. The test-point strip below the canvas shows one clickable chip per probe pad with its latest nominal/abnormal state.',
      'Overlays are static KiCad-derived Circuit Reference Layout geometry, not live segmentation: they show where parts sit, never what is faulty. Electrical conclusions always come from meter readings, never from the picture.',
    ].join('\n\n'),
  },
  {
    id: 'muse-spark-integration',
    title: 'TraceForge Documentation — Virtual Lab vs. Live AI',
    topics: ['virtual lab', 'live ai', 'muse spark', 'modes', 'difference'],
    keywords: ['virtual', 'lab', 'live', 'ai', 'muse', 'spark', 'simulated', 'mode', 'difference', 'cost', 'badge'],
    content: [
      'Virtual Lab (badge Virtual Lab) is the default: a deterministic local agent probes the MNA solver with bounded tool calls (max 8) at zero cost. Nothing leaves your machine, nothing is billed, and results are fully reproducible. Use it for practice, demos, and the full test suite.',
      'Live AI (Muse Spark 1.3, badge Completed with Muse Spark 1.3) runs the real muse-spark-1.3 model through a server-side proxy that holds META_API_KEY — the key never enters the browser bundle. It requires an explicit opt-in (mode live), a token with the live_inference scope, a configured server key, and budget headroom under the safety threshold. Read-only status tools never trigger paid calls, and omitted modes always default to Virtual Lab.',
      'Two more badges complete the picture: Recorded Investigation (Demo Playback) replays a verified live run at zero cost and is never labeled live; Live AI Unavailable means the proxy or key is not configured, in which case the workbench stays in Virtual Lab and says so honestly. Virtual Lab output is never presented as live inference.',
    ].join('\n\n'),
  },
  {
    id: 'recorded-investigations',
    title: 'TraceForge Documentation — Demo Playback',
    topics: ['recorded investigations', 'demo playback', 'replay', 'demo'],
    keywords: ['recorded', 'replay', 'demo', 'playback', 'zero', 'cost', 'autorun', 'pacing', 'verified'],
    content: [
      'Replay Recorded Investigation replays a verified 3-turn F405 live run at zero cost: real MNA measurements execute against your current session bench, the verdict is classified from that electrical evidence alone, and the result is labeled Demo Playback — never Live AI — so the replay is 100% transparent and free.',
      'Presentation controls: Animate Investigation paces each probe visibly; ?instant=1 opts into the zero-delay path; ?autorun=1 triggers one simulated investigation on page load for hands-free QA; ?demo_probing=1 runs three real deterministic measurements on mount and freezes the UI mid-investigation with active highlights and timeline rows.',
      'Use replay for demos, screenshots, and first-run orientation; use live mode only when you explicitly want to spend budget on real model reasoning.',
    ].join('\n\n'),
  },
  {
    id: 'mcp-integration',
    title: 'TraceForge Documentation — MCP & OAuth 2.1 Integration',
    topics: ['mcp', 'oauth', 'integration', 'api', 'pkce', 'refresh token', 'reconnect', 'renewal'],
    keywords: ['mcp', 'oauth', 'pkce', 'token', 'scope', 'bearer', 'json-rpc', 'api', 'tools', 'register', 'authorize', 'refresh', 'reconnect', 'expire', 'renewal'],
    content: [
      'The staging backend (traceforge-mcp-staging) serves the 25-tool MCP surface over MCP 2025-06-18 streamable-HTTP JSON-RPC at /mcp, plus MCP REST (/api/maas/*) and browser backend routes (/api/meta/*). Public tools (capabilities, status, models, budget, circuits) need no token (this includes kb.search and chat.status); the 7 assistant and knowledge base tools are traceforge.kb.search (public versioned knowledge search at zero cost), traceforge.chat.status (public assistant status and the shared live-chat allowance ledger), traceforge.chat.start (open a session-grounded conversation), traceforge.chat.ask (RAG-first answers plus the built-in 20-question QA benchmark via runStandard20QuestionQa), traceforge.chat.history, traceforge.chat.clear, and traceforge.chat.feedback; conversation tools accept traceforge:discovery:read, and traceforge:assistant:chat is also granted to agent and owner tokens. Every other tool needs a Bearer token carrying its listed scope.',
      'OAuth 2.1 + PKCE S256 works for ChatGPT, Muse / Meta AI, and generic MCP clients via RFC 7591 dynamic registration (client_name optional): POST /oauth/register, then GET /oauth/authorize with a code_challenge, then POST /oauth/token with the code_verifier (grant_type authorization_code, refresh via grant_type refresh_token, revoke via POST /oauth/revoke). Access tokens are short-lived (60 minutes) and renew automatically via rotating 30-day refresh tokens persisted in TraceForgeStateDO durable storage, eliminating routine manual reconnections across Worker deployments. Each issued token binds to its own actor_oauth_<clientId> actor with only its granted scopes, and scenarios plus assistant conversations stay strictly per-actor. Discovery metadata lives at /.well-known/oauth-protected-resource (with resource_documentation pointing at GET /docs/mcp, which documents all 25 tools) and /.well-known/oauth-authorization-server.',
      'Session tokens (scn_… scenario ids, inv_… investigation ids) are self-contained AES-256-GCM authenticated tokens: any worker isolate holding the session secret can hydrate them, and committed probes, investigations, scorecards, conversations, and feedback synchronize through Edge Cache plus the TraceForgeStateDO Durable Object coordinator. Typical flows: scenarios.create, measurements.voltage/current/continuity, investigations.start, evaluation.score, evaluation.report — and chat.start, chat.ask (optionally grounded in an owned scenarioId with HiddenFault strictly withheld), chat.history, chat.feedback, chat.clear, kb.search, chat.status.',
    ].join('\n\n'),
  },
  {
    id: 'limitations',
    title: 'TraceForge Documentation — Capabilities & Limitations',
    topics: ['limitations', 'capabilities', 'scope', 'deferred'],
    keywords: ['limitation', 'linear', 'dc', 'spice', 'nonlinear', 'transient', 'hardware', 'sam', 'deferred', 'scope'],
    content: [
      'TraceForge simulates Linear DC resistive networks with independent DC sources: resistors, opens/shorts, and parameter drift. It does not model nonlinear SPICE diode/transistor curves, AC/transient behavior (no C dV/dt or L dI/dt), frequency sweeps, noise, or temperature effects.',
      'There is no physical hardware attachment: all measurements are virtual and nothing drives a bench instrument. Live SAM 3.1 image segmentation is deferred by design — overlays are static KiCad fixture geometry (Circuit Reference Layout). Large multi-hundred-page PDF ingestion, full nonlinear/transient SPICE coverage, and multi-user cloud accounts are deferred.',
      'Edge Cache synchronization is per-colocation and best-effort; on workers.dev subdomains the TraceForgeStateDO SQLite Durable Object provides the strongly consistent global state. Budgets are promotional-credit estimates with a built-in safety stop, not provider billing statements.',
    ].join('\n\n'),
  },
  {
    id: 'basic-electronics',
    title: 'Circuit Reference — NRST, Power Rails, USB-C PD & I2C',
    topics: ['electronics', 'nrst', 'power rails', 'usb-c', 'i2c', 'background'],
    keywords: ['nrst', 'reset', 'pull-up', 'pullup', 'rail', 'ldo', '3v3', '5v', 'usb-c', 'pd', 'cc', 'i2c', 'sda', 'scl', 'electronics'],
    content: [
      'NRST means the active-low reset pin of an MCU (for example STM32 pin 15). It rests at the supply rail through an internal pull-up resistor (~40 kΩ to VDD on STM32F405) and forces a full device reset when driven below about 0.7 V for tens of microseconds. A healthy NRST reads ~3.3 V; NRST near 0 V with a cold MCU means the pin is held down — suspect a solder bridge to ground or VDD, or an open pull-up letting leakage drag it low. Confirm with power-off continuity between the pin and its neighbors.',
      'Power rails: the 3.3 V logic rail (often from an LDO regulator) and the 5 V USB input rail each carry a nominal voltage with tolerance (±5% typical for logic rails). A rail sagging under load (for example 5 V at 4.2 V, or 3V3 at 3.05 V) indicates excess current draw — look for the hot component and measure branch currents to find the leakage path.',
      'USB-C Power Delivery: a sink advertises 5.1 kΩ pull-downs (Rd) on CC1/CC2 while the source pulls up, placing ~0.4–1.2 V on the connected CC line; below ~0.2 V the controller stays detached and negotiates nothing (no 20 V offer). A CC line at 0 V with high resistance to ground indicates an open pull-up; at 0 V with near-zero ohms it indicates a shorted protection (TVS) device.',
      'I2C background: a two-wire open-drain bus (SDA data, SCL clock) with external pull-up resistors; devices acknowledge with a low 9th bit. Missing acknowledgments usually mean wrong address, unpowered target, or stuck-low lines — check pull-ups and scan the address space. (TraceForge boards model rails and protection networks, not I2C peripherals; use this only as background electronics knowledge.)',
    ].join('\n\n'),
  },
  {
    id: 'troubleshooting-examples',
    title: 'Circuit Reference — F405, USB-C PD & RP2040 Troubleshooting',
    topics: ['troubleshooting', 'examples', 'f405', 'usb-c', 'rp2040', 'sensor hub', 'walkthrough'],
    keywords: ['troubleshoot', 'f405', 'stm32', 'usb-c', 'pd', '20v', 'trigger', 'rp2040', 'sensor', 'hub', 'esp32', 'brownout', 'walkthrough', 'example', 'stuck'],
    content: [
      'F405 NRST walkthrough (no USB device, NRST near 0 V): 1) Measure TP_NRST voltage — near 0 V against the 3.240 V nominal confirms a hard fault, not noise. 2) Measure U1-14 (3V3): if it also sags, current is being stolen somewhere. 3) Power off, check continuity U1-14 ↔ U1-15: ~0.4 Ω means a solder bridge between pins 14–15 holding the MCU in reset; kilohms-plus with NRST still low means the pull-up itself is open or drifted. 4) Submit U1 / solder_bridge (confirmed) and reflow the bridge.',
      'USB-C PD 20 V trigger walkthrough (charger stuck at 5 V, never offers 20 V): 1) Measure CC1 and CC2 voltages — asymmetry (CC1 0 V, CC2 ~0.4–1.2 V) isolates the fault to the CC1 line. 2) Power off, check CC1 ↔ GND continuity: ~0.2 Ω means the TVS diode D2 failed short (typical EOS mode) — remove D2 and the line recovers; high resistance at 0 V instead means the CC1 pull-up is open. 3) After rework, verify PD negotiation steps through 5/9/15/20 V with a load.',
      'Sensor-hub walkthrough (boot-loops, brownout resets, sagging rail): 1) Measure the input rail (ESP32-S3 TP_5V nominal 4.956 V) — a sag to ~4.2 V with a hot capacitor points at reverse-polarity leakage; check current draw against the ~90 mA healthy idle. 2) Check the sense divider output (U2-OUT nominal 3.304 V) and the input fuse path for an open. 3) Replace the reversed part with correct polarity and re-power through a current-limited supply. The same rail-sag → current-draw → divider → fuse order applies to RP2040-class sensor hubs generally; in TraceForge, practice it on the ESP32-S3 IoT Sensor Node, which is the implemented sensor-hub reference board.',
    ].join('\n\n'),
  },
];
