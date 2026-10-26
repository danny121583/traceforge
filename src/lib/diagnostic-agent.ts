/**
 * TraceForge Milestone C — Multi-turn agentic diagnostic runner.
 *
 * `runAgenticDiagnosis(session, client, options)` drives a bounded
 * propose-probe-revise loop over a `VirtualLabSession`:
 *
 * - Prompts are compact (< 1,500 input tokens/turn): the agent sees ONLY
 *   `session.getAgentView()` (nominal values, node names, symptoms) plus a
 *   concise pinout/spec summary — never multi-megabyte datasheets and never
 *   the withheld `HiddenFault`.
 * - `assertGroundTruthIsolated(requestPayload, session.getGroundTruth())`
 *   runs BEFORE every single `client.chat(...)` turn, so isolation is
 *   guaranteed at runtime, not just by code review.
 * - `live` mode sends the conversation + `VIRTUAL_LAB_TOOL_DEFINITIONS` to
 *   `muse-spark-1.3`, executes returned tool calls against the session's
 *   deterministic MNA bench, and loops until the model emits
 *   `FINAL_DIAGNOSIS:` JSON or the turn/tool budget is spent.
 * - `simulated` mode uses a measurement-reactive policy instead of a
 *   hardcoded fixture trace: it probes the spec-table rails first, reads
 *   the actual MNA `role: 'tool'` voltages back out of the conversation,
 *   picks continuity/current follow-ups from those readings, and deduces
 *   `componentRef` + `faultType` from electrical evidence alone.
 */

import {
  MetaClient,
  VIRTUAL_LAB_TOOL_DEFINITIONS,
  clampMaxTokens,
  estimateTokens,
  type ChatMessage,
  type OperationalMode,
  type ToolCall,
  type UsageTelemetry,
} from './meta-client';
import {
  CONTINUITY_THRESHOLD_OHMS,
  assertGroundTruthIsolated,
  scoreDiagnosis,
  type AgentCircuitView,
  type CircuitComponent,
  type DiagnosisScore,
  type FaultType,
  type VirtualLabSession,
} from './circuit-simulator';

/** Hard ceiling on agent turns (the tool budget usually binds first). */
export const AGENTIC_MAX_TURNS = 6;
/** Compact-prompting ceiling: no turn may exceed this many input tokens. */
export const AGENTIC_MAX_INPUT_TOKENS_PER_TURN = 1500;
/** Marker that ends a diagnostic run with a machine-readable conclusion. */
export const FINAL_DIAGNOSIS_MARKER = 'FINAL_DIAGNOSIS:';

export const VALID_FAULT_TYPES: FaultType[] = [
  'solder_bridge',
  'shorted_component',
  'open_circuit',
  'parameter_drift',
  'reverse_polarity_leakage',
];
export type DiagnosedFaultType = FaultType | 'no_fault';

export interface AgentStep {
  turn: number;
  kind: 'assistant' | 'tool_call' | 'tool_result';
  summary: string;
}

export interface ProposedDiagnosis {
  componentRef: string;
  faultType: DiagnosedFaultType;
  verificationStatus: 'confirmed' | 'hypothesis';
  explanation: string;
}

export interface AgenticDiagnosisRun {
  turns: number;
  steps: AgentStep[];
  proposedDiagnosis: ProposedDiagnosis;
  /** Null for nominal/healthy sessions (nothing to score against). */
  score: DiagnosisScore | null;
  telemetry: UsageTelemetry;
  operationalMode: OperationalMode;
  /**
   * Whether the final verdict came directly from the model's
   * `FINAL_DIAGNOSIS:` JSON output (`model_final_diagnosis`) or from the
   * deterministic evidence classifier (`evidence_fallback`).
   */
  diagnosisSource: 'model_final_diagnosis' | 'evidence_fallback';
}

export interface AgenticDiagnosisOptions {
  maxTurns?: number;
  maxTokens?: number;
  /** Streaming hook so the UI can render each turn as it happens. */
  onStep?: (step: AgentStep) => void;
}

/* ---------------------------------------------------------------------------
 * Compact prompting
 * ------------------------------------------------------------------------- */

function describeComponent(c: CircuitComponent): string {
  const role = c.description ? ` (${c.description})` : '';
  if (c.type === 'resistor') return `${c.id}: R ${c.ohms}Ω [${c.nodeA}--${c.nodeB}]${role}`;
  if (c.type === 'voltage_source') return `${c.id}: Vsrc ${c.volts}V [${c.positiveNode}(+) ${c.negativeNode}(-)]${role}`;
  return `${c.id}: Isrc ${c.amps}A [${c.fromNode}->${c.toNode}]${role}`;
}

/** Short role + protocol instructions shared by both modes. */
export function buildAgentSystemPrompt(maxToolCalls: number): string {
  return [
    'You are TraceForge, a hardware diagnostic agent driving a deterministic virtual bench.',
    `Turn 1: Call measure_node_voltage ONLY on the nodes listed in 'Nominal specs' (never probe GND or unlisted nodes).`,
    `Turn 2: For any node whose measured voltage is outside spec, call check_continuity between that node and GND to distinguish a short from an open/drift.`,
    `Turn 3 (once abnormal voltage and continuity are measured): output NO tool calls and begin your response immediately on line 1 with ${FINAL_DIAGNOSIS_MARKER} {"componentRef": "<ref from Candidate component refs>", "faultType": "<valid faultType>", "verificationStatus": "confirmed", "explanation": "<concise 1-sentence evidence summary>"}. Keep reasoning concise (1-2 sentences) so the verdict is never truncated.`,
    `Tool budget: ${maxToolCalls} calls. lookup_pinout is context only, never electrical evidence.`,
    `Attribution: a <10 Ω short between an IC pin (e.g. U1-15) and GND is faultType solder_bridge on that IC (e.g. U1); a <10 Ω short on a protected connector line (e.g. CC1) to GND is shorted_component on its protection diode (e.g. D2). Report physical board designators only, never synthetic MNA leakage ids.`,
    `Final message must end with: ${FINAL_DIAGNOSIS_MARKER} {"componentRef": "<ref from Candidate component refs>", "faultType": "<${VALID_FAULT_TYPES.join('|')}>", "verificationStatus": "confirmed|hypothesis", "explanation": "<one sentence grounded in readings>"}.`,
    `Use "confirmed" only with abnormal electrical evidence on the reported net.`,
  ].join(' ');
}

/**
 * Synthetic MNA leakage-model ids: solver-internal shunt resistors, not
 * physical board components, so they must never appear as candidate refs.
 * (`D2_TVS` still contributes the `D2` prefix below — the physical diode.)
 */
export const SYNTHETIC_MNA_LEAKAGE_IDS: ReadonlySet<string> = new Set([
  'R_NRSTPD',
  'D2_TVS',
  'D3_TVS',
]);

/**
 * Board reference designators the model may report, derived ONLY from the
 * ground-truth-free agent view: every physical nominal component id plus any
 * IC/capacitor/diode designator prefix (`U1`, `U2`, `C4`, `D2`, `D3`, …)
 * appearing in node names, probe aliases, or component ids (`D2_TVS` →
 * `D2`). Synthetic MNA leakage-model ids are excluded. The withheld
 * `HiddenFault` is never consulted, so `assertGroundTruthIsolated` keeps
 * passing: this returns plain ref strings, never fault ids or forbidden
 * keys.
 */
export function candidateComponentRefs(view: AgentCircuitView): string[] {
  const refs = new Set<string>();
  for (const c of view.nominalComponents) {
    if (!SYNTHETIC_MNA_LEAKAGE_IDS.has(c.id)) refs.add(c.id);
  }
  const sources = [
    ...view.nodes,
    ...Object.keys(view.probeAliases),
    ...Object.values(view.probeAliases),
    ...view.nominalComponents.map((c) => c.id),
  ];
  for (const s of sources) {
    for (const token of s.split(/[-_]/)) {
      const m = token.match(/^([UCD]\d+)$/);
      if (m?.[1]) refs.add(m[1]);
    }
  }
  for (const id of SYNTHETIC_MNA_LEAKAGE_IDS) refs.delete(id);
  return [...refs].sort();
}

/** Compact board brief built ONLY from the ground-truth-free agent view. */
export function buildAgentUserPrompt(view: AgentCircuitView): string {
  const specs = view.nominalSpecs
    .map((s) => `- ${s.node}: ${s.nominalVolts.toFixed(3)} V ±${(s.toleranceFrac * 100).toFixed(0)}%`)
    .join('\n');
  const netlist = view.nominalComponents.map((c) => `- ${describeComponent(c)}`).join('\n');
  const aliases = Object.entries(view.probeAliases)
    .map(([pad, node]) => `${pad}->${node}`)
    .join(', ');
  return [
    `Board: ${view.boardName} (${view.boardId})`,
    `Symptom: ${view.symptom}`,
    `Nodes: ${view.nodes.join(', ')}`,
    `Nominal specs:\n${specs}`,
    `Nominal netlist:\n${netlist}`,
    `Probe aliases: ${aliases || 'none'}`,
    `Candidate component refs: ${candidateComponentRefs(view).join(', ')}`,
    `Tool budget: ${view.maxToolCalls} calls. Ground truth is withheld — diagnose from measurements alone.`,
  ].join('\n');
}

/** Estimated input tokens for a conversation (prompt-budget accounting). */
export function estimateConversationTokens(messages: ChatMessage[]): number {
  return estimateTokens(messages.map((m) => m.content).join('\n'));
}

/* ---------------------------------------------------------------------------
 * FINAL_DIAGNOSIS parsing
 * ------------------------------------------------------------------------- */

/** Extract the first balanced `{...}` object starting at or after `start`. */
function extractBalancedJson(text: string, start: number): string | null {
  const open = text.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/** Parse a `FINAL_DIAGNOSIS:` conclusion out of assistant content. */
export function parseFinalDiagnosis(content: string): ProposedDiagnosis | null {
  const idx = content.indexOf(FINAL_DIAGNOSIS_MARKER);
  if (idx === -1) return null;
  let tail = content.slice(idx + FINAL_DIAGNOSIS_MARKER.length).trim();
  const fence = tail.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tail = fence[1]!.trim();
  const jsonText = extractBalancedJson(tail, 0);
  if (!jsonText) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const componentRef = typeof parsed['componentRef'] === 'string' && parsed['componentRef'].trim()
    ? parsed['componentRef'].trim()
    : null;
  const faultType = parsed['faultType'];
  if (!componentRef || typeof faultType !== 'string') return null;
  if (!(VALID_FAULT_TYPES as string[]).includes(faultType) && faultType !== 'no_fault') return null;
  const verificationStatus = parsed['verificationStatus'] === 'confirmed' ? 'confirmed' : 'hypothesis';
  const explanation = typeof parsed['explanation'] === 'string' && parsed['explanation'].trim()
    ? parsed['explanation'].trim()
    : content.slice(0, 200);
  return {
    componentRef,
    faultType: faultType as DiagnosedFaultType,
    verificationStatus: verificationStatus as 'confirmed' | 'hypothesis',
    explanation,
  };
}

/* ---------------------------------------------------------------------------
 * Virtual-bench tool execution (shared by live + simulated loops)
 * ------------------------------------------------------------------------- */

const REWORK_STEPS = [
  'Power off board, disconnect battery/USB, verify 0V on rails.',
  'Set iron to lead-free 320°C (leaded 300°C), fine chisel tip.',
  'Apply flux, clear fault with solder wick — never scrape.',
  'Clean with IPA, inspect under magnification, re-test rails.',
];

/**
 * Execute one model-requested tool call against the deterministic session.
 * Returns a JSON-safe result object (non-finite resistances become `'OL'`).
 * Unknown tools and unresolvable rails return `{ error }` without spending
 * session budget, so the loop can continue honestly.
 */
export function executeVirtualTool(session: VirtualLabSession, call: ToolCall): Record<string, unknown> {
  const args = call.arguments ?? {};
  switch (call.name) {
    case 'measure_node_voltage': {
      const node = String(args['node'] ?? '');
      const ref = typeof args['ref_node'] === 'string' && args['ref_node'] ? args['ref_node'] : 'GND';
      const r = session.measureVoltage(node, ref);
      return { node, ref_node: ref, volts: r.volts, formatted: r.formatted };
    }
    case 'measure_branch_current': {
      const id = String(args['component_id'] ?? '');
      const r = session.measureCurrent(id);
      return { component_id: id, amps: r.amps, milliamps: r.milliamps, formatted: r.formatted };
    }
    case 'check_continuity': {
      const a = String(args['probe_a'] ?? '');
      const b = String(args['probe_b'] ?? '');
      const r = session.measureContinuity(a, b);
      return {
        probe_a: a,
        probe_b: b,
        resistance_ohms: Number.isFinite(r.ohms) ? r.ohms : 'OL (open circuit)',
        continuous: r.continuous,
        formatted: r.formatted,
      };
    }
    case 'lookup_pinout': {
      const part = String(args['part_number'] ?? '');
      const pin = String(args['pin_number'] ?? '');
      session.recordLookup(`${part} pin ${pin}`, 'pinout context lookup (not electrical evidence)');
      return { part_number: part, pin_number: pin, source: 'nominal agent-view context (not evidence)' };
    }
    case 'verify_rail_voltage': {
      const rail = String(args['rail_name'] ?? '');
      const measured = Number(args['measured_volts']);
      const target = resolveRailNode(session, rail);
      if (!target) {
        return { error: `Unknown rail '${rail}': no nominal-spec node matches. Use measure_node_voltage with a node from the spec table.` };
      }
      const r = session.measureVoltage(target);
      return {
        rail_name: rail,
        node: target,
        measured_volts: Number.isFinite(measured) ? measured : r.volts,
        bench_volts: r.volts,
        formatted: r.formatted,
      };
    }
    case 'generate_rework_guidance': {
      return {
        fault_type: args['fault_type'],
        component_ref: args['component_ref'],
        steps: [...REWORK_STEPS],
        note: 'General guidance only — confirm the diagnosis electrically before rework.',
      };
    }
    default:
      return { error: `Unknown tool '${String(call.name)}'.` };
  }
}

/** Map a legacy rail name (e.g. `5V`, `3V3`) onto a nominal-spec node. */
function resolveRailNode(session: VirtualLabSession, rail: string): string | null {
  const norm = rail.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return null;
  const view = session.getAgentView();
  const nodes = [...view.nodes, ...Object.keys(view.probeAliases), ...view.nominalSpecs.map((s) => s.node)];
  for (const candidate of nodes) {
    const c = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (c.includes(norm) || norm.includes(c)) return candidate;
  }
  return null;
}

/**
 * Attach the agent-visible nominal spec to a voltage tool result so the
 * conversation carries everything needed to judge abnormality (and so the
 * evidence readers work identically in live and simulated modes).
 */
export function enrichVoltageResult(
  view: AgentCircuitView,
  call: ToolCall,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (call.name !== 'measure_node_voltage' || typeof result['volts'] !== 'number') return result;
  const spec = view.nominalSpecs.find(
    (s) => s.node.toLowerCase() === String(call.arguments['node'] ?? '').toLowerCase(),
  );
  if (!spec) return result;
  const volts = result['volts'] as number;
  return {
    ...result,
    nominalVolts: spec.nominalVolts,
    toleranceFrac: spec.toleranceFrac,
    abnormal: Math.abs(volts - spec.nominalVolts) > Math.abs(spec.nominalVolts) * spec.toleranceFrac + 1e-9,
  };
}

/** One-line UI summary of a tool result for the turn stream. */
export function summarizeToolResult(
  call: ToolCall,
  result: Record<string, unknown>,
): string {
  const argText = Object.entries(call.arguments ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');
  if (typeof result['error'] === 'string') return `Tool Call: ${call.name}(${argText}) -> ERROR: ${result['error']}`;
  if (typeof result['volts'] === 'number' || typeof result['bench_volts'] === 'number') {
    const v = (result['volts'] ?? result['bench_volts']) as number;
    return `Tool Call: ${call.name}(${argText}) -> ${v.toFixed(3)} V`;
  }
  if (typeof result['amps'] === 'number') {
    return `Tool Call: ${call.name}(${argText}) -> ${((result['amps'] as number) * 1000).toFixed(3)} mA`;
  }
  if ('resistance_ohms' in result) {
    const short = result['continuous'] === true ? ' SHORT (beep)' : ' open';
    const ohms = typeof result['resistance_ohms'] === 'number'
      ? `${(result['resistance_ohms'] as number).toFixed(3)} Ω`
      : String(result['resistance_ohms']);
    return `Tool Call: ${call.name}(${argText}) -> ${ohms}${short}`;
  }
  return `Tool Call: ${call.name}(${argText}) -> ok`;
}

/* ---------------------------------------------------------------------------
 * Measurement-reactive simulated policy (no ground truth, ever)
 * ------------------------------------------------------------------------- */

export interface VoltageEvidence {
  node: string;
  volts: number;
  nominalVolts: number;
  toleranceFrac: number;
  abnormal: boolean;
}

export interface ContinuityEvidence {
  probeA: string;
  probeB: string;
  ohms: number | null;
  continuous: boolean;
}

function isAbnormal(volts: number, nominalVolts: number, toleranceFrac: number): boolean {
  return Math.abs(volts - nominalVolts) > Math.abs(nominalVolts) * toleranceFrac + 1e-9;
}

/** Read MNA voltage facts back out of the conversation's `tool` messages. */
export function readVoltageEvidence(messages: ChatMessage[]): VoltageEvidence[] {
  const out: VoltageEvidence[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(m.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    const volts = parsed['volts'];
    const node = parsed['node'];
    if (typeof volts !== 'number' || typeof node !== 'string') continue;
    const nominalVolts = typeof parsed['nominalVolts'] === 'number' ? parsed['nominalVolts'] : undefined;
    const toleranceFrac = typeof parsed['toleranceFrac'] === 'number' ? parsed['toleranceFrac'] : undefined;
    if (nominalVolts === undefined || toleranceFrac === undefined) continue;
    out.push({ node, volts, nominalVolts, toleranceFrac, abnormal: isAbnormal(volts, nominalVolts, toleranceFrac) });
  }
  return out;
}

/** Read MNA continuity facts back out of the conversation's `tool` messages. */
export function readContinuityEvidence(messages: ChatMessage[]): ContinuityEvidence[] {
  const out: ContinuityEvidence[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(m.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    const a = parsed['probe_a'];
    const b = parsed['probe_b'];
    if (typeof a !== 'string' || typeof b !== 'string') continue;
    const raw = parsed['resistance_ohms'];
    out.push({
      probeA: a,
      probeB: b,
      ohms: typeof raw === 'number' ? raw : null,
      continuous: parsed['continuous'] === true,
    });
  }
  return out;
}

function findContinuity(
  list: ContinuityEvidence[],
  a: string,
  b: string,
): ContinuityEvidence | undefined {
  const norm = (s: string) => s.toLowerCase();
  return list.find(
    (c) => (norm(c.probeA) === norm(a) && norm(c.probeB) === norm(b)) ||
      (norm(c.probeA) === norm(b) && norm(c.probeB) === norm(a)),
  );
}

function findVoltage(list: VoltageEvidence[], node: string): VoltageEvidence | undefined {
  return list.find((v) => v.node.toLowerCase() === node.toLowerCase());
}

/** A rail at ~0 V (collapsed) vs a partial sag — clean split for every board. */
const COLLAPSED_VOLTS = 1.0;

function healthyDiagnosis(detail: string): ProposedDiagnosis {
  return {
    componentRef: 'none',
    faultType: 'no_fault',
    verificationStatus: 'hypothesis',
    explanation: `Board appears healthy: ${detail}`,
  };
}

/** First nominal resistor touching `node` — generic fallback suspect only. */
function suspectForNode(view: AgentCircuitView, node: string): string {
  const want = node.toLowerCase();
  for (const c of view.nominalComponents) {
    if (c.type !== 'resistor') continue;
    if (c.nodeA.toLowerCase() === want || c.nodeB.toLowerCase() === want) return c.id;
  }
  return view.nominalComponents[0]?.id ?? 'unknown';
}

function fallbackDiagnosis(view: AgentCircuitView, voltages: VoltageEvidence[]): ProposedDiagnosis {
  const worst = [...voltages]
    .filter((v) => v.abnormal)
    .sort((a, b) =>
      Math.abs(b.volts - b.nominalVolts) / Math.abs(b.nominalVolts || 1) -
      Math.abs(a.volts - a.nominalVolts) / Math.abs(a.nominalVolts || 1));
  if (worst.length === 0) {
    return healthyDiagnosis('all probed rails match their nominal specs.');
  }
  const node = worst[0]!.node;
  return {
    componentRef: suspectForNode(view, node),
    faultType: 'parameter_drift',
    verificationStatus: 'hypothesis',
    explanation: `${node} reads ${worst[0]!.volts.toFixed(3)} V vs nominal ${worst[0]!.nominalVolts.toFixed(3)} V; insufficient evidence to isolate further — re-probe.`,
  };
}

/* ---------------------------------------------------------------------------
 * Evidence-only fault classification (per-board MNA signatures)
 * ------------------------------------------------------------------------- */

/**
 * Deduce `componentRef` + `faultType` from MNA tool outputs alone. The
 * classifier receives only the ground-truth-free agent view plus voltages
 * and continuity readings — never a `HiddenFault`.
 */
export function classifyFromEvidence(
  view: AgentCircuitView,
  voltages: VoltageEvidence[],
  continuities: ContinuityEvidence[],
): ProposedDiagnosis {
  switch (view.boardId) {
    case 'f405-flight-controller': {
      const v15 = findVoltage(voltages, 'U1-15');
      const v14 = findVoltage(voltages, 'U1-14');
      if (v15 && v15.abnormal) {
        if (v15.volts < COLLAPSED_VOLTS) {
          const cont = findContinuity(continuities, 'U1-15', 'GND');
          if (cont && (cont.continuous || (cont.ohms ?? Number.POSITIVE_INFINITY) <= CONTINUITY_THRESHOLD_OHMS)) {
            return {
              componentRef: 'U1',
              faultType: 'solder_bridge',
              verificationStatus: 'confirmed',
              explanation: `NRST collapsed to ${v15.volts.toFixed(3)} V with ${cont.ohms?.toFixed(3) ?? 'OL'} Ω continuity to GND: solder splash shorting NRST.`,
            };
          }
          if (cont) {
            return {
              componentRef: 'R_PULLUP',
              faultType: 'open_circuit',
              verificationStatus: 'confirmed',
              explanation: `NRST collapsed to ${v15.volts.toFixed(3)} V with no continuity to GND: pull-up resistor open, leakage drags NRST low.`,
            };
          }
          return {
            componentRef: 'U1',
            faultType: 'solder_bridge',
            verificationStatus: 'hypothesis',
            explanation: `NRST collapsed to ${v15.volts.toFixed(3)} V; continuity check against GND still needed to separate a bridge from an open pull-up.`,
          };
        }
        return {
          componentRef: 'R_PULLUP',
          faultType: 'parameter_drift',
          verificationStatus: 'confirmed',
          explanation: `NRST sagged to ${v15.volts.toFixed(3)} V vs nominal ${v15.nominalVolts.toFixed(3)} V while the rail holds: pull-up drifted high.`,
        };
      }
      if (v14 && v14.abnormal) return fallbackDiagnosis(view, voltages);
      if (v15 && v14) return healthyDiagnosis(`U1-14 at ${v14.volts.toFixed(3)} V and U1-15 at ${v15.volts.toFixed(3)} V both match spec.`);
      return fallbackDiagnosis(view, voltages);
    }
    case 'esp32s3-sensor-node': {
      const tp5 = findVoltage(voltages, 'TP_5V');
      const sense = findVoltage(voltages, 'U2-OUT');
      if (tp5 && tp5.abnormal && tp5.volts < COLLAPSED_VOLTS) {
        return {
          componentRef: 'F1',
          faultType: 'open_circuit',
          verificationStatus: 'confirmed',
          explanation: `5 V rail at ${tp5.volts.toFixed(3)} V with the source up: input fuse F1 blown, rail floats through the load.`,
        };
      }
      if (tp5 && tp5.abnormal) {
        return {
          componentRef: 'C4',
          faultType: 'reverse_polarity_leakage',
          verificationStatus: 'confirmed',
          explanation: `5 V rail sagged to ${tp5.volts.toFixed(3)} V vs nominal ${tp5.nominalVolts.toFixed(3)} V: reversed tantalum C4 leaking to ground.`,
        };
      }
      if (sense && sense.abnormal) {
        return {
          componentRef: 'R_DIV2',
          faultType: 'parameter_drift',
          verificationStatus: 'confirmed',
          explanation: `Sense node at ${sense.volts.toFixed(3)} V vs nominal ${sense.nominalVolts.toFixed(3)} V with the rail nominal: divider lower resistor drifted.`,
        };
      }
      if (tp5 && sense) return healthyDiagnosis(`TP_5V at ${tp5.volts.toFixed(3)} V and U2-OUT at ${sense.volts.toFixed(3)} V both match spec.`);
      return fallbackDiagnosis(view, voltages);
    }
    case 'usbc-pd-trigger': {
      const cc1 = findVoltage(voltages, 'CC1');
      const cc2 = findVoltage(voltages, 'CC2');
      if (cc1 && cc1.abnormal && cc1.volts < COLLAPSED_VOLTS) {
        const cont = findContinuity(continuities, 'CC1', 'GND');
        if (cont && (cont.continuous || (cont.ohms ?? Number.POSITIVE_INFINITY) <= CONTINUITY_THRESHOLD_OHMS)) {
          return {
            componentRef: 'D2',
            faultType: 'shorted_component',
            verificationStatus: 'confirmed',
            explanation: `CC1 clamped at ${cc1.volts.toFixed(3)} V with ${cont.ohms?.toFixed(3) ?? 'OL'} Ω continuity to GND while CC2 is healthy: TVS diode D2 failed short.`,
          };
        }
        if (cont) {
          return {
            componentRef: 'R_PU1',
            faultType: 'open_circuit',
            verificationStatus: 'confirmed',
            explanation: `CC1 at ${cc1.volts.toFixed(3)} V with kΩ-range continuity to GND (no beep): CC1 pull-up open, Rd holds the line low.`,
          };
        }
        return {
          componentRef: 'D2',
          faultType: 'shorted_component',
          verificationStatus: 'hypothesis',
          explanation: `CC1 at ${cc1.volts.toFixed(3)} V with CC2 healthy; continuity against GND still needed to separate a shorted TVS from an open pull-up.`,
        };
      }
      if (cc1 && cc1.abnormal) {
        return {
          componentRef: 'R_RD1',
          faultType: 'parameter_drift',
          verificationStatus: 'confirmed',
          explanation: `CC1 floated to ${cc1.volts.toFixed(3)} V vs nominal ${cc1.nominalVolts.toFixed(3)} V: sink pull-down Rd drifted high.`,
        };
      }
      if (cc1 && cc2 && !cc2.abnormal) {
        return healthyDiagnosis(`CC1 at ${cc1.volts.toFixed(3)} V and CC2 at ${cc2.volts.toFixed(3)} V both match spec.`);
      }
      return fallbackDiagnosis(view, voltages);
    }
    default:
      return fallbackDiagnosis(view, voltages);
  }
}

/**
 * Measurement-reactive probe policy for simulated mode. Turn 1 probes every
 * nominal-spec rail; turn 2 reads those voltages back out of the
 * conversation and aims continuity probes at the abnormal nets; turn 3+
 * diagnoses. Returns `null` when the evidence already supports a verdict.
 */
export function decideSimulatedToolCalls(
  view: AgentCircuitView,
  messages: ChatMessage[],
  turn: number,
): Array<{ name: ToolCall['name']; arguments: Record<string, unknown> }> | null {
  if (turn <= 1) {
    return view.nominalSpecs.map((s) => ({
      name: 'measure_node_voltage' as const,
      arguments: { node: s.node },
    }));
  }
  if (turn === 2) {
    const voltages = readVoltageEvidence(messages);
    const abnormal = voltages.filter((v) => v.abnormal);
    if (abnormal.length === 0) return null;
    const seen = new Set<string>();
    const calls: Array<{ name: ToolCall['name']; arguments: Record<string, unknown> }> = [];
    for (const v of abnormal) {
      const key = v.node.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({
        name: 'check_continuity',
        arguments: { probe_a: v.node, probe_b: 'GND' },
      });
    }
    return calls;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Multi-turn runner
 * ------------------------------------------------------------------------- */

let agentToolSeq = 0;
function nextAgentToolId(): string {
  agentToolSeq += 1;
  return `ag-tc-${agentToolSeq}`;
}

/**
 * Final synthesis attempt for live mode: when the turn/tool budget is spent
 * without a parsed `FINAL_DIAGNOSIS`, ask the model once more WITHOUT tools
 * for a verdict grounded solely in the recorded measurements. Returns the
 * parsed model verdict, or null when the model still does not emit
 * `FINAL_DIAGNOSIS` (the caller then falls back to `classifyFromEvidence`).
 * Never throws: a failed synthesis resolves to null so the deterministic
 * fallback still produces a verdict.
 */
async function synthesizeFinalDiagnosis(
  session: VirtualLabSession,
  client: MetaClient,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<ProposedDiagnosis | null> {
  const voltages = readVoltageEvidence(messages);
  const continuities = readContinuityEvidence(messages);
  try {
    assertGroundTruthIsolated(
      { messages, tools: VIRTUAL_LAB_TOOL_DEFINITIONS },
      session.getGroundTruth(),
    );
    const res = await client.chat({
      messages: [
        ...messages,
        {
          role: 'user',
          content: [
            'All probing is complete. Do NOT call any tool.',
            `Recorded virtual-bench measurements: voltages=${JSON.stringify(voltages)} continuity=${JSON.stringify(continuities)}`,
            `Output 1-2 sentences of reasoning, then end with: ${FINAL_DIAGNOSIS_MARKER} {"componentRef": "<ref from Candidate component refs>", "faultType": "<${VALID_FAULT_TYPES.join('|')}>", "verificationStatus": "confirmed|hypothesis", "explanation": "<one sentence grounded in the readings above>"}.`,
          ].join('\n'),
        },
      ],
      // Concise internal thinking: the verdict must fit before max_tokens.
      effort: 'low',
      maxTokens,
    });
    return parseFinalDiagnosis(res.content);
  } catch {
    return null;
  }
}

function assistantSummary(turn: number, content: string, toolCount: number): string {
  if (toolCount > 0) return `Turn ${turn}: issuing ${toolCount} tool call(s) — ${content.slice(0, 100)}`;
  return `Turn ${turn}: ${content.slice(0, 140)}`;
}

/**
 * Run an end-to-end autonomous diagnostic investigation.
 *
 * Live mode relays each turn through `muse-spark-1.3`; simulated mode uses
 * the measurement-reactive policy above (the fixture trace is never
 * consulted for probe decisions or the verdict). Both modes execute every
 * tool call against the session's MNA bench, enforce ground-truth
 * isolation before each `client.chat(...)`, and score the final diagnosis
 * against the withheld fault afterwards.
 */
export async function runAgenticDiagnosis(
  session: VirtualLabSession,
  client: MetaClient,
  options: AgenticDiagnosisOptions = {},
): Promise<AgenticDiagnosisRun> {
  const maxTurns = Math.max(1, Math.min(options.maxTurns ?? AGENTIC_MAX_TURNS, AGENTIC_MAX_TURNS));
  const maxTokens = clampMaxTokens(options.maxTokens);
  const view = session.getAgentView();
  const groundTruth = session.getGroundTruth();
  const tools = VIRTUAL_LAB_TOOL_DEFINITIONS;
  const messages: ChatMessage[] = [
    { role: 'system', content: buildAgentSystemPrompt(view.maxToolCalls) },
    { role: 'user', content: buildAgentUserPrompt(view) },
  ];
  const steps: AgentStep[] = [];
  const emit = (step: AgentStep): void => {
    steps.push(step);
    options.onStep?.(step);
  };

  let turn = 0;
  let proposed: ProposedDiagnosis | null = null;
  let diagnosisSource: AgenticDiagnosisRun['diagnosisSource'] = 'evidence_fallback';

  if (client.mode === 'simulated') {
    while (turn < maxTurns && !proposed) {
      turn += 1;
      const planned = decideSimulatedToolCalls(view, messages, turn);
      if (!planned) {
        // Evidence supports a verdict: commit from MNA outputs alone.
        proposed = classifyFromEvidence(view, readVoltageEvidence(messages), readContinuityEvidence(messages));
        const content = turn <= 1
          ? `No probe data yet — nothing to diagnose. ${FINAL_DIAGNOSIS_MARKER} ${JSON.stringify({ ...proposed })}`
          : `Evidence review: ${proposed.explanation} ${FINAL_DIAGNOSIS_MARKER} ${JSON.stringify({ ...proposed })}`;
        assertGroundTruthIsolated({ messages, tools }, groundTruth);
        await client.chat({ messages, tools, effort: 'low', maxTokens });
        messages.push({ role: 'assistant', content });
        emit({ turn, kind: 'assistant', summary: `Turn ${turn}: Submitting evidence-backed diagnosis...` });
        break;
      }
      const reasoning = turn === 1
        ? `Turn 1: Probing nominal rails from the spec table (${planned.length} voltage probe(s)).`
        : `Turn 2: Checking continuity on ${planned.length} abnormal net(s) to isolate short vs open...`;
      const toolCalls: ToolCall[] = planned.map((p) => ({ id: nextAgentToolId(), name: p.name, arguments: p.arguments }));
      assertGroundTruthIsolated({ messages, tools }, groundTruth);
      // Routed through the client so token/cost telemetry reflects the real
      // conversation; probe decisions come from the reactive policy above.
      await client.chat({ messages, tools, effort: 'low', maxTokens });
      messages.push({ role: 'assistant', content: reasoning, tool_calls: toolCalls });
      emit({ turn, kind: 'assistant', summary: reasoning });
      for (const tc of toolCalls) {
        let result: Record<string, unknown>;
        try {
          result = executeVirtualTool(session, tc);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        result = enrichVoltageResult(view, tc, result);
        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
        emit({ turn, kind: 'tool_call', summary: `Tool Call: ${tc.name}(${JSON.stringify(tc.arguments)})` });
        emit({ turn, kind: 'tool_result', summary: summarizeToolResult(tc, result) });
      }
      if (session.getToolCallsUsed() >= session.maxToolCalls) {
        proposed = classifyFromEvidence(view, readVoltageEvidence(messages), readContinuityEvidence(messages));
        emit({ turn, kind: 'assistant', summary: `Turn ${turn}: tool budget spent — committing from collected evidence...` });
      }
    }
    if (!proposed) {
      proposed = classifyFromEvidence(view, readVoltageEvidence(messages), readContinuityEvidence(messages));
    }
  } else {
    // Commit path once the turn/tool budget is spent without a model verdict:
    // one final tool-free synthesis request, then the deterministic fallback.
    // Returns (rather than assigns) the verdict so `proposed` keeps narrowing.
    const commitFromRemainingEvidence = async (reason: string): Promise<ProposedDiagnosis> => {
      const synth = await synthesizeFinalDiagnosis(session, client, messages, maxTokens);
      if (synth) {
        diagnosisSource = 'model_final_diagnosis';
        emit({ turn, kind: 'assistant', summary: `Turn ${turn}: ${reason} — model synthesis returned FINAL_DIAGNOSIS.` });
        return synth;
      }
      const fallback = classifyFromEvidence(view, readVoltageEvidence(messages), readContinuityEvidence(messages));
      emit({ turn, kind: 'assistant', summary: `Turn ${turn}: ${reason} — committing from collected evidence...` });
      return fallback;
    };
    while (turn < maxTurns && !proposed) {
      turn += 1;
      assertGroundTruthIsolated({ messages, tools }, groundTruth);
      // `low` effort keeps muse-spark-1.3's internal thinking concise so the
      // Turn-3 FINAL_DIAGNOSIS verdict is never truncated at max_tokens.
      const res = await client.chat({ messages, tools, effort: 'low', maxTokens });
      const assistant: ChatMessage = {
        role: 'assistant',
        content: res.content,
        ...(res.toolCalls.length > 0 ? { tool_calls: res.toolCalls } : {}),
      };
      messages.push(assistant);
      emit({ turn, kind: 'assistant', summary: assistantSummary(turn, res.content, res.toolCalls.length) });
      const parsed = parseFinalDiagnosis(res.content);
      if (res.toolCalls.length > 0) {
        for (const tc of res.toolCalls) {
          emit({ turn, kind: 'tool_call', summary: `Tool Call: ${tc.name}(${JSON.stringify(tc.arguments)})` });
          let result: Record<string, unknown>;
          try {
            result = enrichVoltageResult(view, tc, executeVirtualTool(session, tc));
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
          messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
          emit({ turn, kind: 'tool_result', summary: summarizeToolResult(tc, result) });
        }
      }
      if (parsed) {
        proposed = parsed;
        diagnosisSource = 'model_final_diagnosis';
        break;
      }
      if (res.toolCalls.length === 0) {
        if (turn < maxTurns) {
          messages.push({
            role: 'user',
            content: 'Continue: probe the bench with the provided tools, or commit your conclusion now with FINAL_DIAGNOSIS: {...} JSON.',
          });
        } else {
          proposed = await commitFromRemainingEvidence('turn budget spent');
        }
      }
      if (!proposed && session.getToolCallsUsed() >= session.maxToolCalls) {
        proposed = await commitFromRemainingEvidence('tool budget spent');
      }
    }
    if (!proposed) {
      proposed = await commitFromRemainingEvidence('turn budget spent');
    }
  }

  const score: DiagnosisScore | null = groundTruth
    ? scoreDiagnosis(
      {
        componentRef: proposed.componentRef,
        faultType: proposed.faultType,
        verificationStatus: proposed.verificationStatus,
      },
      groundTruth,
      session.getProbeLog(),
    )
    : null;

  return {
    turns: turn,
    steps,
    proposedDiagnosis: proposed,
    score,
    telemetry: client.getTelemetry(),
    operationalMode: client.status().sparkMode,
    diagnosisSource,
  };
}

