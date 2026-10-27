import { useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './components/Header';
import { PcbCanvas } from './components/PcbCanvas';
import { DiagnosticPanel } from './components/DiagnosticPanel';
import {
  AUTHORIZED_ADDITIONAL_BUDGET_USD,
  BUDGET_SAFETY_THRESHOLD_USD,
  LAST_VERIFIED_BALANCE_USD,
  LAST_VERIFIED_CONSUMED_USD,
  LAST_VERIFIED_TIMESTAMP,
  MetaClient,
  STARTING_PROMOTIONAL_BALANCE_USD,
  TARGET_RESERVE_USD,
  assembleDatasheetPayload,
  buildCostLedger,
  TOOL_DEFINITIONS,
  VIRTUAL_LAB_TOOL_DEFINITIONS,
} from './lib/meta-client';
import { classifyFromEvidence, runAgenticDiagnosis, type AgentStep } from './lib/diagnostic-agent';
import { verifyRailReading, checkContinuityReading, formatVolts, formatOhms, RAIL_SPECS } from './lib/electrical';
import {
  parseEvidenceTranscript,
  diagnosisVerificationStatus,
  type ClassifiedEvidence,
  type ProbeMeasurement,
} from './lib/diagnostic-parser';
import { SAMPLE_BOARDS, getBoard } from './data/samples';
import type { ClientMode, UsageTelemetry } from './lib/meta-client';
import {
  createVirtualSession,
  getReferenceBoard,
  applyFaultToCircuit,
  solveDcCircuit,
  measureNodeVoltage,
  measureEffectiveResistance,
  assertGroundTruthIsolated,
  scoreDiagnosis,
  MAX_TOOL_CALLS,
  type ProbeRecord,
  type DiagnosisScore,
  type FaultType,
} from './lib/circuit-simulator';
import {
  aiModeBadge,
  extractProbeTargetFromStepSummary,
  formatActivitySummary,
  formatLifecycleStatus,
  getActiveStep,
  isInvestigationComplete,
  mapProbeRecordsToPcbHighlights,
  plainSymptomForBoard,
  primaryWorkflowAction,
  reworkWithheldReason,
  shouldShowRework,
  type InvestigationLifecycleState,
} from './lib/guided-ux';

interface Diagnosis {
  evidence: ClassifiedEvidence;
  verification: { status: 'confirmed' | 'hypothesis'; reason: string };
}

interface StreamLine {
  cls: string;
  text: string;
}

/** Phase 2: shown when live mode stays selected but the proxy has no key. Mode is never reset. */
const LIVE_MODE_UNAVAILABLE_MESSAGE =
  'Live Meta API proxy is unavailable or META_API_KEY is not configured on the server. Live AI mode remains selected — configure META_API_KEY or switch back to Virtual Lab.';

const FAULT_TYPE_OPTIONS: FaultType[] = [
  'solder_bridge',
  'shorted_component',
  'open_circuit',
  'parameter_drift',
  'reverse_polarity_leakage',
];

function fmtUsd(n: number): string {
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}

/**
 * Promotional-credit & budget monitor banner (Milestone D). All figures come
 * from the shared ledger constants plus the live `UsageTelemetry` snapshot —
 * never hardcoded per-render guesses.
 */
export function BudgetMonitor({ telemetry }: { telemetry: UsageTelemetry }) {
  const ledger = buildCostLedger(telemetry);
  const tokenSource = telemetry.providerReportedUsage ? '(tokens: provider-reported)' : '(tokens: local estimate)';
  return (
    <div className="tf-card" style={{ margin: '12px 18px 0' }}>
      <h3>PROMOTIONAL CREDIT &amp; BUDGET MONITOR</h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 11 }}>
        <span className="tf-chip">Last observed balance: <strong>{fmtUsd(STARTING_PROMOTIONAL_BALANCE_USD)} (unverified snapshot)</strong></span>
        <span className="tf-chip">Verified balance: <strong>{fmtUsd(LAST_VERIFIED_BALANCE_USD)}</strong> (verified {LAST_VERIFIED_TIMESTAMP})</span>
        <span className="tf-chip">Verified consumed (Muse Code CLI + live API): <strong>{fmtUsd(LAST_VERIFIED_CONSUMED_USD)}</strong></span>
        <span className="tf-chip">Verified remaining of authorized budget: <strong>{fmtUsd(AUTHORIZED_ADDITIONAL_BUDGET_USD - LAST_VERIFIED_CONSUMED_USD)}</strong></span>
        <span className="tf-chip">Authorized budget: <strong>{fmtUsd(AUTHORIZED_ADDITIONAL_BUDGET_USD)}</strong></span>
        <span className="tf-chip">Target reserve: <strong>{fmtUsd(TARGET_RESERVE_USD)}</strong></span>
        <span className="tf-chip">Safety threshold: <strong>{fmtUsd(BUDGET_SAFETY_THRESHOLD_USD)}</strong></span>
        <span className={ledger.safetyThresholdBreached ? 'tf-chip unavailable' : 'tf-chip sim'}>
          Est. runtime API cost (unverified): <strong>{fmtUsd(telemetry.incurredCostUsd)}</strong>
        </span>
        <span className="tf-chip">
          Session tokens {tokenSource}: <strong>{telemetry.inputTokens} in / {telemetry.outputTokens} out</strong>
          {' '}· Est. live cost (unverified local rate estimate): <strong>{fmtUsd(telemetry.projectedLiveCostUsd)}</strong>
        </span>
        <span className="tf-chip">
          Requests: <strong>{telemetry.totalRequests}</strong>
          {' '}· Retried: <strong>{telemetry.retriedRequests}</strong>
          {' '}· Failed: <strong>{telemetry.failedRequests}</strong>
        </span>
        <span className="tf-chip">Est. remaining budget (unverified): <strong>{fmtUsd(ledger.remainingBudgetUsd)}</strong></span>
      </div>
    </div>
  );
}

function agentStepClass(step: AgentStep): string {
  if (step.kind === 'tool_call') return 'k-tool';
  if (step.kind === 'tool_result') return step.summary.includes('ERROR') ? 'k-rule-bad' : 'k-rule-ok';
  if (step.summary.includes('Submitting evidence-backed diagnosis')) return 'k-dx';
  return 'k-reasoning';
}

export function App() {
  // Phase 2: persist the selected AI mode across reloads (never silently
  // revert it). Guarded for SSR/Node where `window` is undefined.
  const [mode, setMode] = useState<ClientMode>(() => {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage.getItem('tf_client_mode') === 'live') {
        return 'live';
      }
    } catch {
      // Storage unavailable (private mode/SSR): fall through to simulated.
    }
    return 'simulated';
  });
  // SAM 3.1 is deferred per AGENTS.md §8b: board overlays always run as a
  // STATIC_FIXTURE, so toggling 'Go live' for Muse Spark 1.3 reasoning must
  // never flip the segmentation badge to LIVE_API/UNVERIFIED.
  const client = useMemo(() => new MetaClient({ mode, segmentationMode: 'static_fixture' }), [mode]);
  // The telemetry VALUE is intentionally not rendered in the ordinary UI
  // (developer drawer removed; server-authorized `/api/maas/telemetry`
  // remains the diagnostic path). Ledger updates below keep every budget
  // and safety control live.
  const [, setTelemetry] = useState<UsageTelemetry>(() => client.getTelemetry());
  // A mode toggle builds a fresh client with a fresh ledger — re-sync.
  useEffect(() => {
    setTelemetry(client.getTelemetry());
  }, [client]);
  // Phase 2: live-proxy availability signal. Race-safe: a stale check never
  // overwrites a newer mode selection, and a missing/unreachable proxy NEVER
  // resets `mode` back to `simulated` — live stays selected with an alert.
  const [proxyConfigured, setProxyConfigured] = useState(false);
  const [liveModeError, setLiveModeError] = useState<string | null>(null);
  useEffect(() => {
    if (mode === 'simulated') {
      setLiveModeError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.proxyStatus();
        if (cancelled) return;
        if (res.configured) {
          client.setProxyConfigured(true);
          setProxyConfigured(true);
          setLiveModeError(null);
        } else {
          client.setProxyConfigured(false);
          setProxyConfigured(false);
          setLiveModeError(LIVE_MODE_UNAVAILABLE_MESSAGE);
        }
      } catch {
        if (cancelled) return;
        client.setProxyConfigured(false);
        setProxyConfigured(false);
        setLiveModeError(LIVE_MODE_UNAVAILABLE_MESSAGE);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, mode]);
  // Phase 3: progressive investigation lifecycle shown in Step 2.
  const [lifecycle, setLifecycle] = useState<InvestigationLifecycleState>('idle');
  const [lifecycleDetail, setLifecycleDetail] = useState<string>('');
  const [boardId, setBoardId] = useState(SAMPLE_BOARDS[0]!.id);
  const board = getBoard(boardId) ?? SAMPLE_BOARDS[0]!;
  const [faultSel, setFaultSel] = useState<string>('random');
  const [runId, setRunId] = useState(0);
  // Harness-side session: holds the faulted MNA circuit + withheld ground
  // truth. The agent/model only ever sees `session.getAgentView()`.
  const session = useMemo(
    () => createVirtualSession(boardId, faultSel),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, faultSel, runId],
  );
  const referenceBoard = getReferenceBoard(boardId);
  const truth = session.getGroundTruth();
  const [symptom, setSymptom] = useState(board.symptoms[0] ?? '');
  const [customDoc, setCustomDoc] = useState('');
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [running, setRunning] = useState(false);
  // Progressive demo pacing (Phase 3): browser users ALWAYS see the
  // step-by-step probing lifecycle by default; `?instant=1` opts into the
  // zero-delay instant path. Node/SSR (Vitest) stays instant so tests are fast.
  const [demoPacing, setDemoPacing] = useState<boolean>(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('instant') !== '1',
  );
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [probeA, setProbeA] = useState<string | null>(null);
  const [probeB, setProbeB] = useState<string | null>(null);
  const [probeArmed, setProbeArmed] = useState(true);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [probeLog, setProbeLog] = useState<ProbeRecord[]>([]);
  // Live pad(s) for the currently executing real measurement (tool_call /
  // tool_result step), driving the animated PCB highlights. Null when idle.
  const [activeProbeTarget, setActiveProbeTarget] = useState<string | null>(null);
  const [toolsUsed, setToolsUsed] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [submitRef, setSubmitRef] = useState('');
  const [submitFault, setSubmitFault] = useState<FaultType>('solder_bridge');
  const [score, setScore] = useState<DiagnosisScore | null>(null);
  const [agentVerdict, setAgentVerdict] = useState<{
    componentRef: string;
    faultType: string;
    verificationStatus: string;
    explanation: string;
    operationalMode: string;
  } | null>(null);

  const pointA = board.probePoints.find((p) => p.id === probeA) ?? null;
  const pointB = board.probePoints.find((p) => p.id === probeB) ?? null;

  function syncSessionState() {
    setProbeLog(session.getProbeLog());
    setToolsUsed(session.getToolCallsUsed());
  }

  function resetLabState() {
    setProbeA(null);
    setProbeB(null);
    setProbeLog([]);
    setActiveProbeTarget(null);
    setToolsUsed(0);
    setRevealed(false);
    setSubmitRef('');
    setScore(null);
    setDiagnosis(null);
    setAgentVerdict(null);
    setLifecycle('idle');
    setLifecycleDetail('');
  }

  /**
   * Phase 2: toggle between Simulated and Live AI mode, persist the choice
   * in `sessionStorage`, and prepare a fresh bench (Step 2) when the previous
   * run had completed or logged activity — without auto-starting an
   * investigation or spending credits. NEVER resets live back to simulated.
   */
  function handleToggleMode() {
    const hadActivity = diagnosis !== null || score !== null || probeLog.length > 0 || lines.length > 0;
    setMode((m) => {
      const next: ClientMode = m === 'live' ? 'simulated' : 'live';
      try {
        if (typeof window !== 'undefined') window.sessionStorage.setItem('tf_client_mode', next);
      } catch {
        // Storage unavailable: mode still toggles for this session.
      }
      return next;
    });
    if (hadActivity) {
      resetLabState();
      setLines([]);
      setRunId((n) => n + 1);
    }
  }

  function switchBoard(id: string) {
    const next = getBoard(id);
    if (!next) return;
    setBoardId(id);
    setFaultSel('random');
    setSymptom(next.symptoms[0] ?? '');
    setLines([]);
    setSelectedRef(null);
    resetLabState();
  }

  function switchFault(sel: string) {
    setFaultSel(sel);
    setLines([]);
    setSelectedRef(null);
    resetLabState();
  }

  /** Post-run / re-roll reset: re-roll a fresh hidden fault and clear all dependent state. */
  function tryAnotherFault() {
    setFaultSel('random');
    setRunId((n) => n + 1);
    setLines([]);
    setSelectedRef(null);
    resetLabState();
  }

  function handleProbePoint(id: string) {
    if (!probeArmed) return;
    if (probeA === null || (probeA !== null && probeB !== null)) {
      setProbeA(id);
      setProbeB(null);
    } else {
      setProbeB(id);
    }
  }

  // Harness-side display solve: identical MNA math to the session, used for
  // instant canvas meter readouts (not tool-counted, not scored evidence).
  const displayBench = useMemo(() => {
    if (!referenceBoard) return null;
    try {
      const faulted = truth ? applyFaultToCircuit(referenceBoard.nominal, truth) : referenceBoard.nominal;
      return { faulted, solution: solveDcCircuit(faulted) };
    } catch {
      return null;
    }
  }, [referenceBoard, truth]);

  function resolveNode(pad: string): string {
    return session.resolveProbeNode(pad);
  }

  const meterVoltsA =
    displayBench && probeA ? tryRead(() => measureNodeVoltage(displayBench.solution, resolveNode(probeA)).formatted) : null;

  const meterContinuity =
    displayBench && probeA && probeB
      ? tryRead(() => {
          const r = measureEffectiveResistance(
            displayBench.faulted,
            resolveNode(probeA),
            resolveNode(probeB),
            undefined,
            { supplyMode: 'unpowered_unplugged' },
          );
          return { text: r.continuous ? `BEEP — ${r.formatted} SHORT` : `${r.formatted} OPEN`, fault: r.continuous };
        })
      : null;

  function logVoltageProbe() {
    if (!probeA) return;
    setActiveProbeTarget(probeA);
    try {
      const rd = session.measureVoltage(probeA);
      pushLine('k-rule-ok', `▸ Virtual measurement: ${probeA} = ${rd.formatted} (powered, vs GND)`);
    } catch (err) {
      pushLine('k-rule-bad', `⏚ Probe blocked: ${err instanceof Error ? err.message : String(err)}`);
    }
    syncSessionState();
  }

  function logContinuityProbe() {
    if (!probeA || !probeB) return;
    setActiveProbeTarget(`${probeA}↔${probeB}`);
    try {
      const rd = session.measureContinuity(probeA, probeB);
      pushLine(
        rd.continuous ? 'k-rule-bad' : 'k-rule-ok',
        `▸ Virtual measurement: ${probeA} ↔ ${probeB} = ${rd.formatted} ${rd.continuous ? '(SHORT — continuity beep)' : '(open)'}`,
      );
    } catch (err) {
      pushLine('k-rule-bad', `⏚ Probe blocked: ${err instanceof Error ? err.message : String(err)}`);
    }
    syncSessionState();
  }

  /** Budgeted scripted probe sweep (≤ MAX_TOOL_CALLS): spec rails first, then continuity on the first abnormal node. */
  async function runVirtualSweep() {
    setRunning(true);
    try {
      const view = session.getAgentView();
      pushLine('k-reasoning', `▸ Virtual bench armed: ${view.boardName} · tool budget ${session.getToolCallsUsed()}/${view.maxToolCalls}.`);
      try {
        assertGroundTruthIsolated(
          { agentView: view, tools: VIRTUAL_LAB_TOOL_DEFINITIONS },
          session.getGroundTruth(),
        );
        pushLine('k-rule-ok', '✓ Ground-truth isolation check passed — model context carries no fault id, target ref, or faulted values.');
      } catch (err) {
        pushLine('k-rule-bad', `⏚ Isolation breach: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      for (const spec of view.nominalSpecs) {
        try {
          const rd = session.measureVoltage(spec.node);
          setActiveProbeTarget(spec.node);
          syncSessionState();
          const abnormal = Math.abs(rd.volts - spec.nominalVolts) > Math.abs(spec.nominalVolts) * spec.toleranceFrac + 1e-9;
          pushLine(
            abnormal ? 'k-rule-bad' : 'k-rule-ok',
            `▸ Virtual measurement: ${spec.node} = ${rd.formatted} (nominal ${spec.nominalVolts.toFixed(3)} V) — ${abnormal ? 'ABNORMAL' : 'nominal'}`,
          );
        } catch (err) {
          pushLine('k-rule-bad', `⏚ Sweep stopped: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
      const abnormal = session.getProbeLog().find((p) => p.abnormal);
      if (abnormal) {
        const others = view.nominalSpecs.map((s) => s.node).filter((n) => n !== abnormal.target);
        for (const other of [`GND`, ...others].slice(0, 2)) {
          try {
            const rd = session.measureContinuity(abnormal.target, other);
            setActiveProbeTarget(`${abnormal.target}↔${other}`);
            syncSessionState();
            pushLine(
              rd.continuous ? 'k-rule-bad' : 'k-rule-ok',
              `▸ Virtual measurement: ${abnormal.target} ↔ ${other} = ${rd.formatted}${rd.continuous ? ' (SHORT — continuity beep)' : ''}`,
            );
          } catch (err) {
            pushLine('k-rule-bad', `⏚ Sweep stopped: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }
      } else {
        pushLine('k-rule-ok', '▸ All probed rails nominal — no continuity follow-up indicated.');
      }
      pushLine('k-reasoning', '▸ Sweep evidence is logged below. Pick a suspect component + fault class, then Score diagnosis.');
    } finally {
      syncSessionState();
      setRunning(false);
    }
  }

  /**
   * One-click autonomous AI investigation (Milestone D/E): runs
   * `runAgenticDiagnosis` end-to-end on the current board/fault, streams
   * each turn into the diagnostic stream, unlocks the withheld ground
   * truth, and populates the objective scoreboard + classified evidence.
   */
  async function runAgentInvestigation() {
    // Fresh run: clear stale results first so a re-investigation never
    // flashes the previous diagnosis/score as instantly complete.
    if (session.getToolCallsUsed() > 0 || diagnosis !== null || score !== null) {
      setDiagnosis(null);
      setScore(null);
      setAgentVerdict(null);
      setRevealed(false);
      setProbeLog([]);
      setActiveProbeTarget(null);
    }
    if (client.mode === 'live' && proxyConfigured) {
      setLiveModeError(null);
    }
    setRunning(true);
    setLines([]);
    setLifecycle('initializing');
    setLifecycleDetail('Inspecting circuit topology and reported symptom…');
    try {
      const view = session.getAgentView();
      pushLine('k-reasoning', client.mode === 'live'
        ? `▸ Live AI investigation armed: ${view.boardName} · Live Muse Spark 1.3 · tool budget ${session.getToolCallsUsed()}/${view.maxToolCalls}.`
        : `▸ Virtual Investigation armed: ${view.boardName} · Virtual Lab · tool budget ${session.getToolCallsUsed()}/${view.maxToolCalls}.`);
      // Progressive lifecycle (Phase 3): simulated runs with demo pacing
      // buffer every step, then replay probes ONE BY ONE (initializing →
      // probing → updating_hypothesis → completed). Live / instant runs
      // stream each step immediately with zero delay.
      const slowPath = client.mode === 'simulated' && demoPacing;
      if (slowPath) {
        // Hold `initializing` visible in Step 2 before the first probe.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const buffered: AgentStep[] = [];
      const run = await runAgenticDiagnosis(session, client, {
        onStep: (step) => {
          if (slowPath) {
            buffered.push(step);
            return;
          }
          pushLine(agentStepClass(step), step.summary);
          if (step.kind === 'tool_call' || step.kind === 'tool_result') {
            const target = extractProbeTargetFromStepSummary(step.summary);
            if (target) setActiveProbeTarget(target);
            setLifecycle('probing');
            setLifecycleDetail(step.summary);
            syncSessionState();
          }
        },
      });
      if (slowPath) {
        // Snapshot the full evidence, then reveal it sequentially: the PCB
        // readout pill, continuity line, Activity Summary, and Measurement
        // History Timeline appear ONE BY ONE instead of all at once.
        const allProbes = session.getProbeLog();
        setProbeLog([]);
        let revealedProbes = 0;
        for (const step of buffered) {
          setLifecycle('probing');
          if (step.kind === 'tool_call') {
            const target = extractProbeTargetFromStepSummary(step.summary);
            setActiveProbeTarget(target);
            setLifecycleDetail(`Probing ${target ?? 'test point'}…`);
            pushLine(agentStepClass(step), step.summary);
            await new Promise((resolve) => setTimeout(resolve, 350));
          } else if (step.kind === 'tool_result') {
            revealedProbes += 1;
            const justMeasured = allProbes[revealedProbes - 1];
            setProbeLog(allProbes.slice(0, revealedProbes));
            setToolsUsed(revealedProbes);
            setLifecycleDetail(justMeasured?.detail ?? step.summary);
            pushLine(agentStepClass(step), step.summary);
            await new Promise((resolve) => setTimeout(resolve, 450));
          } else {
            pushLine(agentStepClass(step), step.summary);
            setLifecycleDetail(step.summary);
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        setLifecycle('updating_hypothesis');
        setLifecycleDetail('Confirming fault hypothesis against datasheet limits…');
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      syncSessionState();
      setTelemetry(client.getTelemetry());
      const gt = session.getGroundTruth();
      const modeText = run.operationalMode === 'LIVE_API' ? 'Live AI' : 'Virtual Lab';
      if (gt && run.score) {
        setScore(run.score);
        setRevealed(true);
        pushLine(
          run.score.totalScore >= 70 ? 'k-dx' : 'k-rule-bad',
          `■ Ground-Truth Evaluation (${modeText}): ${run.score.totalScore}/100 — ${run.score.summary}`,
        );
        pushLine(
          'k-cite',
          `■ Diagnosis Verdict: ${run.proposedDiagnosis.componentRef} · ${run.proposedDiagnosis.faultType} (${run.proposedDiagnosis.verificationStatus}) — ${run.proposedDiagnosis.explanation}`,
        );
      } else {
        pushLine('k-rule-ok', `▸ Nominal session: agent reports healthy — ${run.proposedDiagnosis.explanation}`);
      }
      setAgentVerdict({
        componentRef: run.proposedDiagnosis.componentRef,
        faultType: run.proposedDiagnosis.faultType,
        verificationStatus: run.proposedDiagnosis.verificationStatus,
        explanation: run.proposedDiagnosis.explanation,
        operationalMode: run.operationalMode,
      });
      const measurements: ProbeMeasurement[] = session.getProbeLog().map((p) => ({
        point: p.target,
        value: p.detail ?? p.kind,
        status: p.abnormal ? 'abnormal' : p.kind === 'voltage' || p.kind === 'resistance' ? 'nominal' : 'inconclusive',
      }));
      const evidence: ClassifiedEvidence = {
        observedEvidence: [view.symptom],
        probeMeasurements: measurements,
        datasheetSpecs: view.nominalSpecs.map((s) => ({
          section: `Nominal spec ${s.node}`,
          spec: `${s.nominalVolts.toFixed(3)} V ±${(s.toleranceFrac * 100).toFixed(0)}%`,
        })),
        hypotheses: [
          {
            claim: run.operationalMode === 'LIVE_API'
              ? `Live AI diagnosis (Muse Spark 1.3): ${run.proposedDiagnosis.componentRef} · ${run.proposedDiagnosis.faultType} — ${run.proposedDiagnosis.explanation}`
              : `Virtual Lab diagnosis: ${run.proposedDiagnosis.componentRef} · ${run.proposedDiagnosis.faultType} — ${run.proposedDiagnosis.explanation}`,
            likelihood: run.proposedDiagnosis.verificationStatus === 'confirmed' ? 'high' : 'medium',
            falsificationTest: 'A nominal MNA reading on every affected node falsifies this hypothesis.',
          },
        ],
        nextVerificationSteps: [
          `Turns used: ${run.turns}; probes logged: ${session.getProbeLog().length}.`,
          'Re-probe suspect nets on the virtual bench before rework.',
        ],
      };
      setDiagnosis({
        evidence,
        verification: diagnosisVerificationStatus({
          probeMeasurements: evidence.probeMeasurements,
          hypotheses: evidence.hypotheses,
        }),
      });
      setLifecycle('completed');
      setLifecycleDetail('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushLine('k-rule-bad', `⏚ Investigation failed: ${message}`);
      if (client.mode === 'live') {
        setLiveModeError(message);
      }
      setLifecycle('error');
      setLifecycleDetail(message);
      setTelemetry(client.getTelemetry());
    } finally {
      syncSessionState();
      setRunning(false);
    }
  }

  /**
   * Zero-cost replay of the verified 3-turn F405 live run
   * (Muse Spark 1.3): executes the REAL `measureVoltage` /
   * `measureContinuity` calls against the current session's deterministic
   * MNA bench, classifies from that electrical evidence alone, and scores
   * against the withheld ground truth. The verdict is labeled
   * `RECORDED_LIVE_REPLAY` (never `LIVE_API`) so the replay is 100%
   * transparent and costs $0.00.
   */
  async function replayVerifiedLiveRun() {
    setRunning(true);
    setLines([]);
    try {
      const view = session.getAgentView();
      const specs = view.nominalSpecs.map((s) => s.node);
      const railA = specs[0] ?? 'U1-14';
      const railB = specs[1] ?? 'U1-15';
      pushLine('k-reasoning', `▸ Replaying verified 3-turn F405 live run (Muse Spark 1.3) on ${view.boardName} — recorded steps, zero cost, real MNA measurements.`);
      const voltages: Array<{ node: string; volts: number; nominalVolts: number; toleranceFrac: number; abnormal: boolean }> = [];
      const continuities: Array<{ probeA: string; probeB: string; ohms: number | null; continuous: boolean }> = [];
      // Turn 1: rail voltages from the nominal spec table.
      for (const node of [railA, railB]) {
        const rd = session.measureVoltage(node);
        const spec = view.nominalSpecs.find((s) => s.node === node);
        const nominalVolts = spec?.nominalVolts ?? rd.volts;
        const toleranceFrac = spec?.toleranceFrac ?? 0.05;
        const abnormal = spec !== undefined
          && Math.abs(rd.volts - spec.nominalVolts) > Math.abs(spec.nominalVolts) * spec.toleranceFrac + 1e-9;
        voltages.push({ node, volts: rd.volts, nominalVolts, toleranceFrac, abnormal });
        setActiveProbeTarget(node);
        syncSessionState();
        pushLine(abnormal ? 'k-rule-bad' : 'k-rule-ok', `Turn 1: Tool Call: measure_node_voltage(node=${node}) -> ${rd.volts.toFixed(3)} V`);
        if (demoPacing) await new Promise((resolve) => setTimeout(resolve, 350));
      }
      // Turn 2: continuity of the first abnormal rail against GND.
      const suspect = voltages.find((v) => v.abnormal)?.node ?? railB;
      const rc = session.measureContinuity(suspect, 'GND');
      continuities.push({
        probeA: suspect,
        probeB: 'GND',
        ohms: Number.isFinite(rc.ohms) ? rc.ohms : null,
        continuous: rc.continuous,
      });
      setActiveProbeTarget(`${suspect}↔GND`);
      syncSessionState();
      pushLine(rc.continuous ? 'k-rule-bad' : 'k-rule-ok', `Turn 2: Tool Call: check_continuity(probe_a=${suspect}, probe_b=GND) -> ${rc.formatted}`);
      if (demoPacing) await new Promise((resolve) => setTimeout(resolve, 350));
      // Turn 3: evidence-backed verdict from the replayed measurements alone.
      const proposed = classifyFromEvidence(view, voltages, continuities);
      pushLine('k-reasoning', `Turn 3: Submitting evidence-backed diagnosis from the recorded live run...`);
      syncSessionState();
      setTelemetry(client.getTelemetry());
      const gt = session.getGroundTruth();
      const score = gt
        ? scoreDiagnosis(
          { componentRef: proposed.componentRef, faultType: proposed.faultType, verificationStatus: proposed.verificationStatus },
          gt,
          session.getProbeLog(),
        )
        : null;
      if (gt && score) {
        setScore(score);
        setRevealed(true);
        pushLine(
          score.totalScore >= 70 ? 'k-dx' : 'k-rule-bad',
          `■ Ground-Truth Evaluation (Recorded Investigation): ${score.totalScore}/100 — ${score.summary}`,
        );
        pushLine(
          'k-cite',
          `■ Diagnosis Verdict: ${proposed.componentRef} · ${proposed.faultType} (${proposed.verificationStatus}) — ${proposed.explanation}`,
        );
      } else {
        pushLine('k-rule-ok', `▸ Nominal session: recorded replay reports healthy — ${proposed.explanation}`);
      }
      setAgentVerdict({
        componentRef: proposed.componentRef,
        faultType: proposed.faultType,
        verificationStatus: proposed.verificationStatus,
        explanation: `${proposed.explanation} (zero-cost replay of the verified 3-turn F405 live run)`,
        operationalMode: 'RECORDED_LIVE_REPLAY',
      });
      const measurements: ProbeMeasurement[] = session.getProbeLog().map((p) => ({
        point: p.target,
        value: p.detail ?? p.kind,
        status: p.abnormal ? 'abnormal' : p.kind === 'voltage' || p.kind === 'resistance' ? 'nominal' : 'inconclusive',
      }));
      setDiagnosis({
        evidence: {
          observedEvidence: [view.symptom],
          probeMeasurements: measurements,
          datasheetSpecs: view.nominalSpecs.map((s) => ({
            section: `Nominal spec ${s.node}`,
            spec: `${s.nominalVolts.toFixed(3)} V ±${(s.toleranceFrac * 100).toFixed(0)}%`,
          })),
          hypotheses: [
            {
              claim: `Recorded Investigation: ${proposed.componentRef} · ${proposed.faultType} — ${proposed.explanation}`,
              likelihood: proposed.verificationStatus === 'confirmed' ? 'high' : 'medium',
              falsificationTest: 'A nominal MNA reading on every affected node falsifies this hypothesis.',
            },
          ],
          nextVerificationSteps: [
            `Recorded turns: 3; probes logged: ${session.getProbeLog().length}.`,
            'Re-probe suspect nets on the virtual bench before rework.',
          ],
        },
        verification: diagnosisVerificationStatus({
          probeMeasurements: measurements,
          hypotheses: [
            {
              claim: `Recorded Investigation: ${proposed.componentRef} · ${proposed.faultType}`,
              likelihood: proposed.verificationStatus === 'confirmed' ? 'high' : 'medium',
              falsificationTest: 'A nominal MNA reading on every affected node falsifies this hypothesis.',
            },
          ],
        }),
      });
    } catch (err) {
      pushLine('k-rule-bad', `⏚ Replay failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      syncSessionState();
      setRunning(false);
    }
  }

  // Zero-cost browser-QA auto-run: `?autorun=1` triggers one simulated
  // investigation on mount. Guarded to simulated mode so it never makes a
  // live API call; the ref keeps StrictMode double-effects to a single run.
  const autorunFired = useRef(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('autorun') === '1' && mode === 'simulated' && !autorunFired.current) {
      autorunFired.current = true;
      void runAgentInvestigation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Active-probing snapshot mode: `?demo_probing=1` runs 3 real deterministic
  // measurements on mount and freezes the UI mid-investigation in Step 2 with
  // active PCB pulse rings, readout callouts, the continuity vector, and 3
  // rows in the Measurement History Timeline. Runs once (StrictMode-safe).
  const demoProbingFired = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || new URLSearchParams(window.location.search).get('demo_probing') !== '1' || demoProbingFired.current) {
      return;
    }
    demoProbingFired.current = true;
    // Each slot attempts the canonical demo probe first; when the current
    // board has no such net (e.g. F405 has no VBUS_5V), a board-valid
    // nominal-spec fallback keeps the timeline at exactly 3 real rows.
    const fallbackRails = session.getAgentView().nominalSpecs.map((s) => s.node);
    const attempt = (label: string, primary: () => string, fallback: () => string): void => {
      // Measure OUTSIDE the state updater: updater functions must stay pure
      // (React may re-invoke them) or probes would double-count the budget.
      let text = '';
      try {
        text = primary();
      } catch {
        text = `${label} not on this board — ${fallback()}`;
      }
      setLines((prev) => [...prev, { cls: 'k-rule-ok', text }]);
    };
    attempt('VBUS_5V', () => {
      const rd = session.measureVoltage('VBUS_5V');
      return `▸ Virtual measurement: VBUS_5V = ${rd.formatted} (powered, vs GND)`;
    }, () => {
      const node = fallbackRails[0] ?? 'U1-14';
      const rd = session.measureVoltage(node);
      return `▸ Virtual measurement: ${node} = ${rd.formatted} (powered, vs GND)`;
    });
    attempt('V3V3', () => {
      const rd = session.measureVoltage('V3V3');
      return `▸ Virtual measurement: V3V3 = ${rd.formatted} (powered, vs GND)`;
    }, () => {
      const node = fallbackRails[1] ?? fallbackRails[0] ?? 'U1-15';
      const rd = session.measureVoltage(node);
      return `▸ Virtual measurement: ${node} = ${rd.formatted} (powered, vs GND)`;
    });
    attempt('NRST↔GND', () => {
      const rd = session.measureContinuity('NRST', 'GND');
      return `▸ Virtual measurement: NRST ↔ GND = ${rd.formatted}${rd.continuous ? ' (SHORT — continuity beep)' : ' (open)'}`;
    }, () => {
      const node = fallbackRails[1] ?? fallbackRails[0] ?? 'U1-15';
      const rd = session.measureContinuity(node, 'GND');
      return `▸ Virtual measurement: ${node} ↔ GND = ${rd.formatted}${rd.continuous ? ' (SHORT — continuity beep)' : ' (open)'}`;
    });
    syncSessionState();
    setActiveProbeTarget('NRST↔GND');
    setRunning(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submitDiagnosis() {
    const gt = session.getGroundTruth();
    if (!gt) {
      pushLine('k-rule-ok', '▸ Nominal session: nothing to score — inject a hidden fault to evaluate a diagnosis.');
      return;
    }
    const options = suspectOptions();
    const submission = {
      componentRef: submitRef || options[0]!,
      faultType: submitFault,
      verificationStatus: (probeLog.some((p) => p.abnormal) ? 'confirmed' : 'hypothesis') as 'confirmed' | 'hypothesis',
    };
    const result = scoreDiagnosis(submission, gt, session.getProbeLog());
    setScore(result);
    setRevealed(true);
    setAgentVerdict({
      componentRef: submission.componentRef,
      faultType: submission.faultType,
      verificationStatus: submission.verificationStatus,
      explanation: `Manual suspect scored ${result.totalScore}/100 — ${result.summary}`,
      operationalMode: client.status().sparkMode,
    });
    pushLine(
      result.totalScore >= 70 ? 'k-dx' : 'k-rule-bad',
      `■ Ground-Truth Evaluation: ${result.totalScore}/100 — ${result.summary}`,
    );
    const measurements: ProbeMeasurement[] = session.getProbeLog().map((p) => ({
      point: p.target,
      value: p.detail ?? p.kind,
      status: p.abnormal ? 'abnormal' : p.kind === 'voltage' || p.kind === 'resistance' ? 'nominal' : 'inconclusive',
    }));
    const evidence: ClassifiedEvidence = {
      observedEvidence: [...board.symptoms],
      probeMeasurements: measurements,
      datasheetSpecs: board.datasheet.map((d) => ({ section: d.title, spec: d.title })),
      hypotheses: [
        {
          claim: `Candidate fault hypothesis: ${submission.componentRef} · ${submission.faultType}.`,
          likelihood: result.evidenceConfirmed ? 'high' : 'medium',
          falsificationTest: 'A nominal MNA reading on every affected node falsifies this hypothesis.',
        },
      ],
      nextVerificationSteps: ['Re-probe suspect nets on the virtual bench before rework.'],
    };
    setDiagnosis({
      evidence,
      verification: diagnosisVerificationStatus({
        probeMeasurements: evidence.probeMeasurements,
        hypotheses: evidence.hypotheses,
      }),
    });
  }

  function suspectOptions(): string[] {
    const ids = new Set<string>();
    for (const c of session.getAgentView().nominalComponents) ids.add(c.id);
    for (const c of board.components) ids.add(c.ref);
    return [...ids];
  }

  function pushLine(cls: string, text: string) {
    setLines((prev) => [...prev, { cls, text }]);
  }

  async function runDiagnosis() {
    setRunning(true);
    setLines([]);
    const push = (cls: string, text: string) =>
      setLines((prev) => [...prev, { cls, text }]);

    const payload = assembleDatasheetPayload(board.datasheet);
    push('k-reasoning', `▸ Assembled ${payload.sectionsIncluded.length} datasheet sections (~${payload.estimatedTokens.toLocaleString()} tokens of 1M context).`);
    if (customDoc.trim()) {
      push('k-reasoning', `▸ Appended custom upload (${customDoc.length} chars) to context.`);
    }

    const messages = [
      { role: 'system' as const, content: 'You are TraceForge, a hardware diagnostic engine. Use tool calls and cite datasheet sections.' },
      {
        role: 'user' as const,
        content: `Board: ${board.name}\nSymptoms: ${symptom}\nDatasheet:\n${payload.text}${customDoc.trim() ? `\n[CUSTOM UPLOAD]\n${customDoc}` : ''}`,
      },
    ];

    try {
      const stream = client.streamChat({ messages, tools: TOOL_DEFINITIONS, responseFormat: 'text', effort: 'medium' });
      let buffer = '';
      for await (const delta of stream) {
        buffer += delta;
        const done = buffer;
        setLines((prev) => {
          const base = prev.filter((l) => !l.text.startsWith('__stream__'));
          return [...base, { cls: 'k-reasoning', text: `__stream__${done}` }];
        });
      }
      setLines((prev) => {
        const base = prev.filter((l) => !l.text.startsWith('__stream__'));
        const streamed = buffer.split('\n').map((t) => ({
          cls: t.startsWith('DIAGNOSIS') ? 'k-dx' : t.startsWith('CITATIONS') ? 'k-cite' : 'k-reasoning',
          text: t,
        }));
        return [...base, ...streamed];
      });

      // Local electrical rule checks (deterministic verification layer)
      push('k-reasoning', '▸ Running electrical rule checks…');
      const measurements: ProbeMeasurement[] = [];
      for (const p of board.probePoints) {
        if (p.expectedVolts === undefined) continue;
        const spec = RAIL_SPECS[p.net];
        if (!spec) continue;
        const r = verifyRailReading(spec, p.expectedVolts);
        push(
          r.withinSpec ? 'k-rule-ok' : 'k-rule-bad',
          `${r.withinSpec ? '✓' : '⏚'} RAIL ${r.railName}: measured ${formatVolts(r.measuredVolts)} vs nominal ${formatVolts(r.nominalVolts)} (${(r.deviationPct * 100).toFixed(1)}%) — ${r.severity.toUpperCase()}`,
        );
        measurements.push({
          point: p.id,
          value: `${formatVolts(r.measuredVolts)} vs nominal ${formatVolts(r.nominalVolts)}`,
          status: r.withinSpec ? 'nominal' : 'abnormal',
        });
      }
      for (const entry of board.expectedSteps.filter((s) => s.action === 'check_continuity')) {
        const m = entry.detail.match(/([\w-]+)\s*↔\s*([\w-]+)\s*reads\s*([\d.]+)\s*Ω/);
        if (m) {
          const r = checkContinuityReading(Number(m[3]));
          push(
            'k-rule-bad',
            `⏚ CONTINUITY ${m[1]} ↔ ${m[2]}: ${formatOhms(Number(m[3]))} — ${r.continuous ? 'SHORT (beep)' : 'OPEN'}`,
          );
          measurements.push({
            point: `${m[1]} ↔ ${m[2]}`,
            value: `${formatOhms(Number(m[3]))} — ${r.continuous ? 'SHORT (beep)' : 'OPEN'}`,
            status: r.continuous ? 'abnormal' : 'nominal',
          });
        }
      }
      for (const c of payload.sectionsIncluded) push('k-cite', `❚ CITATION [DATASHEET: ${c}]`);
      push('k-dx', `■ EXPECTED: ${board.faultSummary}`);

      // Classified evidence panel: transcript-derived buckets merged with
      // deterministic board data. The fault summary stays a hypothesis
      // until probe measurements decisively back it.
      const streamed = parseEvidenceTranscript(buffer);
      const evidence: ClassifiedEvidence = {
        observedEvidence: [...board.symptoms, ...streamed.observedEvidence],
        probeMeasurements: [...measurements, ...streamed.probeMeasurements],
        datasheetSpecs: [
          ...board.datasheet.map((d) => ({ section: d.title, spec: d.title })),
          ...streamed.datasheetSpecs,
        ],
        hypotheses: [
          {
            claim: board.faultSummary,
            likelihood: measurements.some((m) => m.status === 'abnormal') ? 'high' : 'medium',
            falsificationTest: 'Re-probe the listed points; a nominal reading on every point falsifies this fault.',
          },
          ...streamed.hypotheses,
        ],
        nextVerificationSteps: [
          ...streamed.nextVerificationSteps,
          'Re-probe suspect nets and compare against datasheet limits before rework.',
          'Inspect the suspect component under magnification to confirm the visual flag.',
        ],
      };
      setDiagnosis({
        evidence,
        verification: diagnosisVerificationStatus({
          probeMeasurements: evidence.probeMeasurements,
          hypotheses: evidence.hypotheses,
        }),
      });
    } catch (err) {
      push('k-rule-bad', `⏚ Diagnostic error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  function handleUpload(file: File) {
    const reader = new FileReader();
    reader.onload = () => setCustomDoc(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  const faultOptions = referenceBoard
    ? [{ value: 'nominal', label: 'Nominal / Healthy (no fault)' }, { value: 'random', label: 'Random Hidden Fault' }].concat(
        referenceBoard.faults.map((f) => ({ value: f.faultId, label: `${f.faultId} (${f.faultType})` })),
      )
    : [];

  // Guided 3-step flow state (pure rules live in src/lib/guided-ux.ts).
  const complete = isInvestigationComplete({ diagnosis, score });
  const hasActivity = lines.length > 0 || probeLog.length > 0;
  const activeStep = getActiveStep({ running, complete, hasActivity });
  const primaryAction = primaryWorkflowAction({ running, complete });
  const sparkStatus = client.status();
  const modeBadge = aiModeBadge(sparkStatus.sparkMode, { proxyConfigured, liveModeError, running });
  const lifecycleChipClass =
    lifecycle === 'completed' ? 'tf-chip live' : lifecycle === 'error' ? 'tf-chip unavailable' : 'tf-chip sim';
  // Zero-cost replay transparency: the recorded-live chip replaces the live
  // badge whenever the verdict came from the verified-run replay.
  const replayBadge = agentVerdict?.operationalMode === 'RECORDED_LIVE_REPLAY'
    ? aiModeBadge('RECORDED_LIVE_REPLAY')
    : null;
  const activeModeBadge = replayBadge ?? modeBadge;
  const activitySummary = formatActivitySummary(probeLog);
  // Real measurement → PCB highlight mapping (pulse ring, readout callouts,
  // continuity vector). Empty probe log + idle target yields zero highlights.
  const pcbHighlights = mapProbeRecordsToPcbHighlights(
    board,
    session.getAgentView().probeAliases ?? {},
    probeLog,
    activeProbeTarget,
  );
  const verificationStatus = diagnosis?.verification.status ?? null;
  const showRework = shouldShowRework({ complete, verificationStatus });
  const isHealthy = !truth;
  const reworkNote = reworkWithheldReason({ complete, isHealthy, verificationStatus });
  const scoreMatch = score ? score.componentMatch && score.faultTypeMatch : false;

  const GUIDE_STEPS = [
    { n: 1 as const, title: 'Choose Circuit', desc: 'Select a sample circuit with a secretly injected fault' },
    { n: 2 as const, title: 'Investigate', desc: 'Watch the AI probe test points and measure the circuit' },
    { n: 3 as const, title: 'Review Results', desc: 'Compare the AI diagnosis against the hidden fault' },
  ];

  return (
    <div className="tf-app">
      <Header client={client} onToggleMode={handleToggleMode} badge={activeModeBadge} />
      <ol className="tf-steps" aria-label="Guided diagnostic steps">
        {GUIDE_STEPS.map((s) => (
          <li
            key={s.n}
            className={s.n === activeStep ? 'current' : s.n < activeStep ? 'done' : 'todo'}
            aria-current={s.n === activeStep ? 'step' : undefined}
          >
            <span className="tf-step-num">{s.n}</span>
            <span className="tf-step-text">
              <strong>Step {s.n}: {s.title}</strong>
              <span>{s.desc}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="tf-main">
        <div className="tf-left">
          <section className="tf-card tf-step" aria-label="Step 1: Choose circuit">
            <h3>STEP 1 · CHOOSE CIRCUIT</h3>
            <div className="tf-board-cards">
              {SAMPLE_BOARDS.map((b) => (
                <button
                  key={b.id}
                  className={b.id === boardId ? 'tf-board-card selected' : 'tf-board-card'}
                  aria-pressed={b.id === boardId}
                  onClick={() => switchBoard(b.id)}
                  disabled={running}
                >
                  <strong>{b.name}</strong>
                  <span className="tf-board-symptom">{plainSymptomForBoard(b.id, b.symptoms[0] ?? '')}</span>
                  <span className="tf-chip">Example circuit · Virtual testing</span>
                </button>
              ))}
            </div>
            <label className="sr-only" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
              Select circuit:{' '}
              <select aria-label="Select circuit" className="sr-only" value={boardId} onChange={(e) => switchBoard(e.target.value)} disabled={running}>
                {SAMPLE_BOARDS.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <div className="tf-row tf-fault-row">
              <label className="tf-fault-label" htmlFor="tf-fault-select">
                <span>Fault scenario:</span>
                <select id="tf-fault-select" value={faultSel} onChange={(e) => switchFault(e.target.value)} disabled={running}>
                  {faultOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              {faultSel === 'random' && (
                <button className="tf-reroll-btn" onClick={tryAnotherFault} disabled={running}>
                  Re-roll random fault
                </button>
              )}
            </div>
            <p className="tf-note">
              TraceForge secretly introduces a hidden electrical fault into the virtual circuit.
              The AI must find it using measurements alone.
              Reported symptom: <strong>{symptom}</strong>
            </p>
            <details>
              <summary>How it works</summary>
              <p className="tf-note">
                TraceForge is a virtual electronics workbench. First, pick a practice circuit —
                we secretly add one hidden electrical fault to it. Next, the AI investigates:
                it looks at the board layout, picks test points, and uses a virtual multimeter
                to measure voltages and continuity. Finally, compare the AI diagnosis against
                the hidden fault to see whether it found the right cause.
              </p>
            </details>
          </section>
          <PcbCanvas
            board={board}
            selectedRef={selectedRef}
            probeA={probeA}
            probeB={probeB}
            probeArmed={probeArmed}
            segmentationMode={client.status().segmentationMode}
            activePointIds={pcbHighlights.activePointIds}
            measuredPoints={pcbHighlights.measuredPoints}
            activeContinuityLine={pcbHighlights.activeContinuityLine}
            onSelectComponent={setSelectedRef}
            onProbePoint={handleProbePoint}
          />
          <details className="tf-card tf-advanced-tools" open>
            <summary>Advanced Tools &amp; Manual Bench Controls</summary>
            <h4>Manual Multimeter Probing</h4>
            <div className="tf-meter-inner">
              <div>
                <button className={probeArmed ? 'active' : ''} onClick={() => setProbeArmed((v) => !v)}>
                  {probeArmed ? 'Probes: ARMED (click pads)' : 'Probes: OFF'}
                </button>{' '}
                <button onClick={() => { setProbeA(null); setProbeB(null); }}>Clear probes</button>
              </div>
              <div style={{ marginTop: 8 }}>
                A: {pointA ? `${pointA.label} = ${meterVoltsA ?? '—'}` : '—'} · B:{' '}
                {pointB ? `${pointB.label}` : '—'}
                <span style={{ color: 'var(--ink-dim)' }}> · Virtual Multimeter</span>
              </div>
              {meterContinuity && (
                <div className={`reading ${meterContinuity.fault ? 'fault' : ''}`} style={{ marginTop: 4 }}>
                  {meterContinuity.text}
                </div>
              )}
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={logVoltageProbe} disabled={!probeA || running}>Log voltage probe (A vs GND)</button>
                <button onClick={logContinuityProbe} disabled={!probeA || !probeB || running}>Log continuity (A↔B)</button>
              </div>
              <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)' }}>
                Logged probes count against the tool budget ({toolsUsed}/{MAX_TOOL_CALLS} used).
              </div>
            </div>
            <h4>Virtual Probe Sweep</h4>
            <div className="tf-row">
              <button onClick={runVirtualSweep} disabled={running}>
                {running ? 'Probing…' : 'Run virtual probe sweep'}
              </button>
            </div>
            <h4>Ground Truth (Manual Reveal)</h4>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
              {truth ? (
                revealed ? (
                  <span>Ground-truth evaluation result: <strong>{truth.faultId}</strong> · {truth.faultType} @ {truth.targetComponentRef} — {truth.description}</span>
                ) : (
                  <span>Withheld Ground Truth 🔒 — fault injected, identity hidden during probing.{' '}
                    <button onClick={() => setRevealed(true)}>Reveal</button>
                  </span>
                )
              ) : (
                <span>Nominal session — no fault injected (healthy board).</span>
              )}
            </div>
            <h4>Manual Suspect Scoring</h4>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                Suspect:{' '}
                <select value={submitRef} onChange={(e) => setSubmitRef(e.target.value)}>
                  <option value="">— pick —</option>
                  {suspectOptions().map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                Fault class:{' '}
                <select value={submitFault} onChange={(e) => setSubmitFault(e.target.value as FaultType)}>
                  {FAULT_TYPE_OPTIONS.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </label>
              <button onClick={submitDiagnosis} disabled={running || !truth}>Score diagnosis</button>
            </div>
            <h4>Custom Symptom &amp; Datasheet Upload</h4>
            <textarea value={symptom} onChange={(e) => setSymptom(e.target.value)} aria-label="Symptom input" />
            <div className="tf-row">
              <label style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                Upload custom doc:{' '}
                <input
                  type="file"
                  accept=".txt,.md"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
                />
              </label>
            </div>
            {customDoc && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--cyan)' }}>Custom doc loaded ({customDoc.length} chars).</div>}
            <h4>Legacy Datasheet Analysis</h4>
            <div className="tf-row">
              <button onClick={runDiagnosis} disabled={running}>
                {running ? 'Diagnosing…' : 'Run datasheet analysis'}
              </button>
              <button onClick={() => setLines([])} disabled={running}>Clear stream</button>
            </div>
          </details>
        </div>

        <div className="tf-right">
          <section className="tf-card tf-step" aria-label="Step 2: Investigate">
            <div className="tf-investigate-head">
              <h3>STEP 2 · INVESTIGATE</h3>
              <span className={activeModeBadge.className}>{activeModeBadge.label}</span>
            </div>
            {mode === 'live' && liveModeError && (
              <div className="tf-chip unavailable" role="alert" style={{ marginBottom: 8 }}>
                Live AI unavailable: {liveModeError}
              </div>
            )}
            {(running || hasActivity) && (
              <div className={lifecycleChipClass} role="status" style={{ marginBottom: 8 }}>
                {formatLifecycleStatus(lifecycle, lifecycleDetail)}
              </div>
            )}
            {(primaryAction || !running) && (
              <div className="tf-row tf-investigate-actions">
                {primaryAction && (
                  <button className="primary" onClick={runAgentInvestigation} disabled={primaryAction.disabled || running}>
                    {primaryAction.label}
                  </button>
                )}
                {!running && (
                  <button onClick={() => void replayVerifiedLiveRun()}>
                    Replay Recorded Investigation (Zero Cost)
                  </button>
                )}
              </div>
            )}
            {primaryAction && (
              <label className="tf-demo-pacing">
                <input
                  type="checkbox"
                  checked={demoPacing}
                  onChange={(e) => setDemoPacing(e.target.checked)}
                  disabled={running}
                />{' '}
                Animate Investigation
              </label>
            )}
            {!complete && !hasActivity && !running && (
              <ol className="tf-checklist">
                <li>AI inspects the circuit layout and reported symptom</li>
                <li>AI selects test points and virtual multimeter measures voltages &amp; continuity</li>
                <li>AI updates its hypothesis and identifies the likely fault</li>
              </ol>
            )}
            {(running || hasActivity) && (
              <details className="tf-activity-drawer" open={!complete}>
                <summary>
                  Investigation Activity &amp; Probe Log ({probeLog.length} {probeLog.length === 1 ? 'probe' : 'probes'})
                </summary>
                {activitySummary.length > 0 && (
                  <>
                    <h4>Activity Summary</h4>
                    <ul className="tf-ev-list">
                      {activitySummary.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </>
                )}
                <h4>Investigation Activity</h4>
                <div className="tf-stream">
                  {lines.length === 0 && <span className="k-reasoning">Probing the virtual bench — measurements will stream here.</span>}
                  {lines.filter((l) => l.text.trim()).map((l, i) => (
                    <div key={i} className={l.cls}>{l.text.replace('__stream__', '')}</div>
                  ))}
                </div>
                {probeLog.length > 0 && (
                  <>
                    <h4>Measurement History Timeline</h4>
                    <table className="tf-measure-table" aria-label="Measurement history timeline">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Test Point / Node</th>
                          <th>Type</th>
                          <th>Computed Value</th>
                          <th>Status</th>
                          <th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {probeLog.map((p, i) => {
                          const isElectrical = p.kind === 'voltage' || p.kind === 'resistance' || p.kind === 'current';
                          return (
                            <tr key={i}>
                              <td className="mute">{i + 1}</td>
                              <td>{p.target}</td>
                              <td className="mute">{p.kind}</td>
                              <td>{p.detail ?? '—'}</td>
                              <td className={p.abnormal ? 'bad' : 'ok'}>
                                {isElectrical ? (p.abnormal ? 'Abnormal' : 'Nominal') : '—'}
                              </td>
                              <td className="mute">{isElectrical ? 'Virtual measurement' : 'Context'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </>
                )}
              </details>
            )}
          </section>

          <section className="tf-card tf-step tf-results-card" aria-label="Step 3: Review results">
            <h3>STEP 3 · REVIEW RESULTS</h3>
            {!complete ? (
              <p className="tf-note">{reworkNote}</p>
            ) : (
              <>
                <h4>1. Diagnosis Summary</h4>
                {truth && agentVerdict ? (
                  <div className="tf-result-summary">
                    <div className="tf-result-verdict-line">
                      <strong>Identified Fault:</strong>{' '}
                      <span className="tf-result-target">{agentVerdict.componentRef} · {agentVerdict.faultType}</span>
                    </div>
                    <p className="tf-note">{agentVerdict.explanation}</p>
                  </div>
                ) : (
                  <p className="tf-note">No fault identified — the board was reported healthy.</p>
                )}

                <h4>2. Fault Classification &amp; Verification Status</h4>
                <div className="tf-result-badges">
                  <span className={(agentVerdict?.verificationStatus ?? verificationStatus) === 'confirmed' ? 'tf-chip live' : 'tf-chip unverified'}>
                    {(agentVerdict?.verificationStatus ?? verificationStatus) === 'confirmed'
                      ? 'Confirmed by Electrical Measurement'
                      : 'Unverified Hypothesis — Not Confirmed'}
                  </span>
                  <span className={activeModeBadge.className}>{activeModeBadge.label}</span>
                  <span className="tf-chip">
                    Probes used: <strong>{probeLog.length}/{MAX_TOOL_CALLS}</strong>
                  </span>
                </div>

                {probeLog.length > 0 && (
                  <>
                    <h4>3. Supporting Measurements</h4>
                    <ul className="tf-ev-list tf-supporting-measurements">
                      {probeLog.map((p, i) => {
                        const isElectrical = p.kind === 'voltage' || p.kind === 'resistance' || p.kind === 'current';
                        return (
                          <li key={i}>
                            <span className={p.abnormal ? 'tf-ev-chip warn' : 'tf-ev-chip ok'}>
                              {isElectrical ? (p.abnormal ? 'abnormal' : 'nominal') : p.kind}
                            </span>{' '}
                            <strong>{p.target}</strong> · {p.detail ?? p.kind}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                <h4>4. Ground-Truth Evaluation &amp; Score</h4>
                {truth ? (
                  revealed ? (
                    <div className="tf-gt-box">
                      <p style={{ margin: '0 0 6px' }}>
                        <span className={scoreMatch ? 'tf-chip live' : 'tf-chip unverified'}>
                          {scoreMatch ? 'Diagnosis Correct — Matched Hidden Fault' : 'Diagnosis Mismatch'}
                        </span>
                        {score && (
                          <span className="tf-chip" style={{ marginLeft: 6 }}>
                            Score: <strong>{score.totalScore}/100</strong>
                          </span>
                        )}
                      </p>
                      <p style={{ margin: '0 0 4px' }}>
                        Hidden fault was <strong>{truth.faultId}</strong> · {truth.faultType} @ <strong>{truth.targetComponentRef}</strong> — {truth.description}
                      </p>
                      {score && (
                        <p className="tf-note" style={{ margin: 0 }}>
                          Component {score.componentMatch ? 'MATCH' : 'MISS'} ·{' '}
                          fault-type {score.faultTypeMatch ? 'MATCH' : 'MISS'} · evidence{' '}
                          {score.evidenceConfirmed ? 'CONFIRMED' : 'NOT confirmed'} · probes {score.probeCount} ·{' '}
                          efficiency {score.efficiencyScore} · {score.summary}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="tf-note">Withheld Ground Truth 🔒 — fault injected, identity hidden during probing.</p>
                  )
                ) : (
                  <p className="tf-note">Nominal session — no fault was injected (healthy board).</p>
                )}

                {diagnosis && diagnosis.evidence.nextVerificationSteps.length > 0 && (
                  <>
                    <h4>5. Recommended Next Steps</h4>
                    <ol className="tf-ev-list">
                      {diagnosis.evidence.nextVerificationSteps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </>
                )}

                <div className="tf-row" style={{ marginTop: 10 }}>
                  <button className="primary" onClick={tryAnotherFault} disabled={running}>
                    Try another fault
                  </button>
                </div>
              </>
            )}
          </section>

          {complete && diagnosis && (
            <DiagnosticPanel boardName={board.name} evidence={diagnosis.evidence} verification={diagnosis.verification} />
          )}

          {showRework ? (
            <div className="tf-card tf-rework">
              <div className="tf-rework-head">
                <h3>REWORK GUIDANCE · {board.name.toUpperCase()}</h3>
                <span className="tf-chip live">Confirmed Fault — Rework Authorized</span>
              </div>
              <h4>Required Tools &amp; Station Settings</h4>
              <div className="temp">{board.rework.ironTempC} °C · {board.rework.tip}</div>
              {board.rework.replacementPart && (
                <p style={{ margin: '6px 0' }}>
                  <strong>Replacement Component:</strong> {board.rework.replacementPart}
                </p>
              )}
              <h4>Rework Procedure</h4>
              <ol>
                {board.rework.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              <h4>Safety &amp; Verification Checks</h4>
              <p><strong>Bench Safety:</strong> {board.rework.safetyChecks.join(' · ')}</p>
              <p className="tf-rework-qualification">
                Qualification note: Virtual multimeter readings confirm the fault in the simulated circuit model. For physical hardware, verify power-off rail discharge and confirm measurements on the physical bench before soldering.
              </p>
            </div>
          ) : (
            complete && (
              <div className="tf-card tf-rework">
                <h3>REWORK GUIDANCE · {board.name.toUpperCase()}</h3>
                <p className="tf-note">{reworkNote}</p>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function tryRead<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
