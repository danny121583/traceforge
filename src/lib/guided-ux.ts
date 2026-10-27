/**
 * Guided-UX helpers (Milestone: Guided UX & Interface Cleanup).
 *
 * Pure, UI-independent state rules for the 3-step virtual-laboratory flow:
 * step highlighting, premature-disclosure gating for rework guidance,
 * plain-language activity summaries, and the single AI operational-mode badge.
 * All simulation, MNA solving, agent, proxy, and budget-ledger logic lives
 * elsewhere and is untouched by this module.
 */
import type { DiagnosisScore, ProbeRecord } from './circuit-simulator';
import type { OperationalMode } from './meta-client';
import type { SampleBoard } from '../data/samples';

export type GuideStep = 1 | 2 | 3;

export type VerificationStatus = 'confirmed' | 'hypothesis';

/** True once an investigation has produced a diagnosis and/or an objective score. */
export function isInvestigationComplete(args: {
  diagnosis: unknown;
  score: DiagnosisScore | null;
}): boolean {
  return args.diagnosis != null || args.score != null;
}

/**
 * Active guided step: Step 1 before anything happens, Step 2 while the
 * investigation is running or bench activity exists, Step 3 once a
 * diagnosis/score completes the run.
 */
export function getActiveStep(args: {
  running: boolean;
  complete: boolean;
  hasActivity: boolean;
}): GuideStep {
  if (args.complete) return 3;
  if (args.running || args.hasActivity) return 2;
  return 1;
}

/**
 * Rework/repair instructions may only appear after an investigation
 * completes AND electrical measurements confirmed a specific fault.
 * Healthy boards (`no_fault` / nominal) and unverified hypotheses must
 * never receive physical rework instructions.
 */
export function shouldShowRework(args: {
  complete: boolean;
  verificationStatus: VerificationStatus | null;
}): boolean {
  return args.complete && args.verificationStatus === 'confirmed';
}

/** Plain-language reason shown when rework guidance is withheld. */
export function reworkWithheldReason(args: {
  complete: boolean;
  isHealthy: boolean;
  verificationStatus: VerificationStatus | null;
}): string {
  if (!args.complete) {
    return 'Run an AI investigation in Step 2 to view the diagnosed fault, supporting measurements, ground-truth verification, and repair guidance.';
  }
  if (args.isHealthy) {
    return 'This board is healthy — no fault was found, so no physical rework is needed.';
  }
  if (args.verificationStatus !== 'confirmed') {
    return 'Physical rework instructions are withheld until electrical measurements confirm a specific fault. The current conclusion is an unverified hypothesis.';
  }
  return '';
}

const KIND_VERB: Record<ProbeRecord['kind'], string> = {
  voltage: 'measured voltage at',
  resistance: 'measured continuity/resistance at',
  current: 'measured current at',
  lookup: 'checked the datasheet reference for',
  other: 'probed',
};

/** One plain-language timeline sentence per logged probe record. */
export function formatActivitySummary(probeLog: ProbeRecord[]): string[] {
  return probeLog.map((p, i) => {
    const verb = KIND_VERB[p.kind] ?? 'probed';
    const outcome = p.abnormal ? 'looked abnormal' : 'looked normal';
    const detail = p.detail ? ` — ${p.detail}` : '';
    return `Probe ${i + 1}: ${verb} ${p.target} — it ${outcome}${detail}.`;
  });
}

/**
 * Single truthful header badge for the AI operational mode.
 *
 * `RECORDED_LIVE_REPLAY` marks a zero-cost replay of a previously verified
 * live run (never a fresh live call, so never `LIVE_API`).
 */
export function aiModeBadge(
  sparkMode: OperationalMode | 'RECORDED_LIVE_REPLAY',
  options?: { proxyConfigured?: boolean; liveModeError?: string | null },
): {
  label: string;
  className: string;
} {
  if (options?.liveModeError) return { label: 'AI Service Unavailable', className: 'tf-chip unavailable' };
  if (sparkMode === 'RECORDED_LIVE_REPLAY') return { label: 'Recorded Investigation', className: 'tf-chip sim' };
  if (sparkMode === 'LIVE_API') return { label: 'Live AI', className: 'tf-chip live' };
  if (sparkMode === 'UNVERIFIED' && options?.proxyConfigured) return { label: 'Live AI (Ready)', className: 'tf-chip live' };
  if (sparkMode === 'UNVERIFIED') return { label: 'Live AI (Unverified)', className: 'tf-chip unverified' };
  if (sparkMode === 'UNAVAILABLE') return { label: 'AI Service Unavailable', className: 'tf-chip unavailable' };
  return { label: 'Virtual Lab', className: 'tf-chip sim' };
}

/**
 * Technical execution-source string for the Technology drawer. Exact labels:
 * 'AI Service Unavailable' | 'Live Muse Spark 1.3' |
 * 'Recorded Live Investigation' | 'Static Reference Fixture' |
 * 'Deterministic Virtual Lab'.
 */
export function executionSourceLabel(
  mode: OperationalMode | 'RECORDED_LIVE_REPLAY',
  options?: { liveModeError?: string | null },
): string {
  if (options?.liveModeError || mode === 'UNAVAILABLE') return 'AI Service Unavailable';
  if (mode === 'LIVE_API') return 'Live Muse Spark 1.3';
  if (mode === 'RECORDED_LIVE_REPLAY') return 'Recorded Live Investigation';
  if (mode === 'STATIC_FIXTURE') return 'Static Reference Fixture';
  return 'Deterministic Virtual Lab';
}

/** Progressive investigation lifecycle (Phase 3): one visible stage at a time. */
export type InvestigationLifecycleState =
  | 'idle'
  | 'initializing'
  | 'probing'
  | 'updating_hypothesis'
  | 'completed'
  | 'error';

/** Human-readable status line for the current investigation lifecycle stage. */
export function formatLifecycleStatus(state: InvestigationLifecycleState, detail?: string): string {
  const base: Record<InvestigationLifecycleState, string> = {
    idle: 'Idle — ready to start investigation',
    initializing: 'Initializing — inspecting circuit layout and symptom…',
    probing: 'Probing — measuring test points on the virtual PCB…',
    updating_hypothesis: 'Updating Hypothesis — analyzing electrical measurements…',
    completed: 'Completed — diagnosis and ground-truth evaluation ready',
    error: 'Error — investigation stopped',
  };
  const label = base[state];
  return detail ? `${label} (${detail})` : label;
}

/**
 * The single primary workflow action. The main view renders ONE `.primary`
 * button while awaiting/running an investigation; after completion the only
 * primary action is "Try another fault" in the Step 3 results card, and all
 * manual bench controls use secondary styling inside Advanced Tools.
 */
export function primaryWorkflowAction(state: {
  running: boolean;
  complete: boolean;
}): { label: string; disabled: boolean } | null {
  if (state.complete) return null;
  if (state.running) return { label: 'Investigating Circuit…', disabled: true };
  return { label: 'Start AI Investigation', disabled: false };
}

/* ---------------------------------------------------------------------------
 * PCB measurement highlights (Workstream 1: animated AI measurements)
 * ------------------------------------------------------------------------- */

/** One measured test point on the PCB: computed readout + nominal/abnormal flag. */
export interface PcbMeasuredPoint {
  reading: string;
  abnormal: boolean;
  kind: string;
}

/** Dashed continuity vector drawn between two probe pads on the PCB. */
export interface PcbContinuityLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
  abnormal: boolean;
}

/** Full PCB highlight state derived from real `ProbeRecord` entries. */
export interface PcbHighlights {
  activePointIds: string[];
  measuredPoints: Record<string, PcbMeasuredPoint>;
  activeContinuityLine: PcbContinuityLine | null;
}

/** Split an `A↔B` continuity target into its two endpoints (`↔` or `<->`). */
function splitContinuityPair(target: string): [string, string] | null {
  const normalized = target.replace(/<->/g, '↔');
  const idx = normalized.indexOf('↔');
  if (idx === -1) return null;
  const a = normalized.slice(0, idx).trim();
  const b = normalized.slice(idx + 1).trim();
  if (!a || !b) return null;
  return [a, b];
}

/**
 * Resolve one raw probe token (pad id, test-point label, node alias, or
 * component-adjacent designator such as `U1-14`) to the matching
 * `board.probePoints` ids, expanding `probeAliases` in both directions plus
 * label matches (e.g. `TP_CC1` label ↔ `CC1` id, `C4-POS` ↔ `TP_5V`,
 * `U1-14` ↔ `TP_3V3`, `U1-15` ↔ `TP_NRST`).
 */
function resolveTokenToPointIds(
  token: string,
  byId: Map<string, string>,
  byLabel: Map<string, string>,
  aliasGroups: Map<string, Set<string>>,
): string[] {
  const t = token.trim();
  if (!t) return [];
  const found = new Set<string>();
  const direct = byId.get(t);
  if (direct) found.add(direct);
  const viaLabel = byLabel.get(t);
  if (viaLabel) found.add(viaLabel);
  // Alias expansion in both directions: token may be an alias key whose
  // value is a probe id, an alias value whose key is a probe id, or a probe
  // id whose alias partner is also a probe id.
  const group = aliasGroups.get(t);
  if (group) {
    for (const member of group) {
      const pid = byId.get(member) ?? byLabel.get(member);
      if (pid) found.add(pid);
    }
  }
  // Note: `link()` stores the merged group under every member, so the
  // block above already covers probe ids whose alias partner is also a
  // probe id (e.g. `U1-15` -> `U1-15` & `TP_NRST`).
  return [...found];
}

/** Resolve a full probe target (single pad or `A↔B` pair) to probe point ids. */
function resolveTargetToPointIds(
  target: string,
  byId: Map<string, string>,
  byLabel: Map<string, string>,
  aliasGroups: Map<string, Set<string>>,
): string[] {
  const pair = splitContinuityPair(target);
  const tokens = pair ? [pair[0], pair[1]] : [target];
  const out = new Set<string>();
  for (const token of tokens) {
    for (const pid of resolveTokenToPointIds(token, byId, byLabel, aliasGroups)) out.add(pid);
  }
  return [...out];
}

/**
 * Map real diagnostic `ProbeRecord` entries (+ the currently executing
 * probe target) to PCB highlight state. Pure: no DOM, no simulation.
 *
 * - `activePointIds`: ids for the live `activeProbeTarget`, falling back to
 *   the most recent electrical measurement when no target is active.
 * - `measuredPoints`: one entry per probed test point with the computed
 *   readout (`detail`), abnormal flag, and record kind. Lookup/context
 *   records never produce highlights.
 * - `activeContinuityLine`: dashed vector for the active (or most recent)
 *   `check_continuity` pair whose endpoints both resolve to probe pads.
 * - Empty probe log + no active target -> zero highlights (never imply a
 *   measurement that was not made).
 */
export function mapProbeRecordsToPcbHighlights(
  board: SampleBoard,
  probeAliases: Record<string, string>,
  probeLog: ProbeRecord[],
  activeProbeTarget: string | null | undefined,
): PcbHighlights {
  const empty: PcbHighlights = { activePointIds: [], measuredPoints: {}, activeContinuityLine: null };
  const byId = new Map<string, string>();
  const byLabel = new Map<string, string>();
  for (const p of board.probePoints) {
    byId.set(p.id, p.id);
    if (p.label && !byLabel.has(p.label)) byLabel.set(p.label, p.id);
  }
  const aliasGroups = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!aliasGroups.has(a)) aliasGroups.set(a, new Set([a]));
    if (!aliasGroups.has(b)) aliasGroups.set(b, new Set([b]));
    const merged = new Set([...(aliasGroups.get(a) as Set<string>), ...(aliasGroups.get(b) as Set<string>)]);
    for (const m of merged) aliasGroups.set(m, merged);
  };
  for (const [k, v] of Object.entries(probeAliases ?? {})) {
    if (k && v) link(k, v);
  }

  const isElectrical = (p: ProbeRecord) => p.kind === 'voltage' || p.kind === 'resistance' || p.kind === 'current';
  const electrical = probeLog.filter(isElectrical);
  if (electrical.length === 0 && !activeProbeTarget?.trim()) return empty;

  const measuredPoints: Record<string, PcbMeasuredPoint> = {};
  let lastContinuity: { a: string; b: string; record: ProbeRecord } | null = null;
  for (const record of electrical) {
    const reading = record.detail ?? '';
    const pair = record.kind === 'resistance' ? splitContinuityPair(record.target) : null;
    if (pair) {
      const [a, b] = pair;
      const idsA = resolveTokenToPointIds(a, byId, byLabel, aliasGroups);
      const idsB = resolveTokenToPointIds(b, byId, byLabel, aliasGroups);
      for (const pid of [...idsA, ...idsB]) {
        measuredPoints[pid] = { reading, abnormal: record.abnormal, kind: record.kind };
      }
      if (idsA.length > 0 && idsB.length > 0) lastContinuity = { a: idsA[0] as string, b: idsB[0] as string, record };
    } else {
      for (const pid of resolveTargetToPointIds(record.target, byId, byLabel, aliasGroups)) {
        measuredPoints[pid] = { reading, abnormal: record.abnormal, kind: record.kind };
      }
    }
  }

  const coordOf = (pid: string) => board.probePoints.find((p) => p.id === pid) ?? null;
  const lineFor = (idA: string, idB: string, record: ProbeRecord): PcbContinuityLine | null => {
    const pa = coordOf(idA);
    const pb = coordOf(idB);
    if (!pa || !pb) return null;
    const target = record.target.includes('↔') || record.target.includes('<->')
      ? record.target
      : `${idA}↔${idB}`;
    return {
      x1: pa.x,
      y1: pa.y,
      x2: pb.x,
      y2: pb.y,
      label: record.detail ? `${target} · ${record.detail}` : target,
      abnormal: record.abnormal,
    };
  };

  let activePointIds: string[] = [];
  let activeContinuityLine: PcbContinuityLine | null = null;
  const active = activeProbeTarget?.trim();
  if (active) {
    activePointIds = resolveTargetToPointIds(active, byId, byLabel, aliasGroups);
    const pair = splitContinuityPair(active);
    if (pair) {
      const idsA = resolveTokenToPointIds(pair[0], byId, byLabel, aliasGroups);
      const idsB = resolveTokenToPointIds(pair[1], byId, byLabel, aliasGroups);
      if (idsA.length > 0 && idsB.length > 0) {
        // Prefer the recorded reading for this pair when one exists so the
        // live vector carries the computed resistance; otherwise draw the
        // pending vector without an abnormal flag.
        const match = [...electrical].reverse().find((r) => {
          const rp = r.kind === 'resistance' ? splitContinuityPair(r.target) : null;
          if (!rp) return false;
          const ra = new Set(resolveTokenToPointIds(rp[0], byId, byLabel, aliasGroups));
          const rb = new Set(resolveTokenToPointIds(rp[1], byId, byLabel, aliasGroups));
          const both = (x: Set<string>, y: string) => x.has(y);
          return (
            (both(ra, idsA[0] as string) && both(rb, idsB[0] as string)) ||
            (both(ra, idsB[0] as string) && both(rb, idsA[0] as string))
          );
        });
        const seed: ProbeRecord = match ?? { kind: 'resistance', target: active, abnormal: false };
        const line = lineFor(idsA[0] as string, idsB[0] as string, seed);
        if (line) activeContinuityLine = line;
      }
    }
  }
  if (activePointIds.length === 0) {
    // Fall back to the most recent electrical measurement location.
    for (let i = electrical.length - 1; i >= 0; i -= 1) {
      const ids = resolveTargetToPointIds(
        (electrical[i] as ProbeRecord).target,
        byId,
        byLabel,
        aliasGroups,
      );
      if (ids.length > 0) {
        activePointIds = ids;
        break;
      }
    }
  }
  if (!activeContinuityLine && lastContinuity) {
    const line = lineFor(lastContinuity.a, lastContinuity.b, lastContinuity.record);
    if (line) activeContinuityLine = line;
  }
  return { activePointIds, measuredPoints, activeContinuityLine };
}

/**
 * Extract the live probe target from one `AgentStep` summary so `App` can
 * highlight the pad(s) while the tool call executes. Understands the
 * `Tool Call: name(arg=value, …)` lines emitted for `tool_call` /
 * `tool_result` steps (`measure_node_voltage` → node, `check_continuity` →
 * `probe_a↔probe_b`, `measure_branch_current` → component id,
 * `verify_rail_voltage` → node or rail name). Returns `null` for reasoning,
 * lookup, rework, and diagnosis lines that touch no pad.
 */
export function extractProbeTargetFromStepSummary(summary: string): string | null {
  const mA = summary.match(/probe_a\s*=\s*([^,)]+)/i);
  const mB = summary.match(/probe_b\s*=\s*([^,)]+)/i);
  if (mA && mB) {
    const a = mA[1]?.trim();
    const b = mB[1]?.trim();
    if (a && b) return `${a}↔${b}`;
  }
  const mNode = summary.match(/(?:^|[\s(,])node\s*=\s*([^,)\s]+)/i);
  if (mNode?.[1]) return mNode[1].trim();
  const mComp = summary.match(/component_id\s*=\s*([^,)\s]+)/i);
  if (mComp?.[1]) return mComp[1].trim();
  return null;
}

/** Plain-English one-line symptom shown on each circuit selection card. */
export function plainSymptomForBoard(boardId: string, fallback: string): string {
  const KNOWN: Record<string, string> = {
    'f405-flight-controller':
      'Drone brain will not connect over USB and stays stuck in reset.',
    'esp32s3-sensor-node':
      'Sensor node keeps rebooting and one part gets painfully hot.',
    'usbc-pd-trigger':
      'USB-C charger never switches up to 20 V output.',
  };
  return KNOWN[boardId] ?? fallback;
}
