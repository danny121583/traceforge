import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Header';
import { PcbCanvas } from './components/PcbCanvas';
import { DiagnosticPanel } from './components/DiagnosticPanel';
import {
  AUTHORIZED_ADDITIONAL_BUDGET_USD,
  BUDGET_SAFETY_THRESHOLD_USD,
  MetaClient,
  STARTING_PROMOTIONAL_BALANCE_USD,
  TARGET_RESERVE_USD,
  assembleDatasheetPayload,
  buildCostLedger,
  TOOL_DEFINITIONS,
  VIRTUAL_LAB_TOOL_DEFINITIONS,
} from './lib/meta-client';
import { runAgenticDiagnosis, type AgentStep } from './lib/diagnostic-agent';
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

interface Diagnosis {
  evidence: ClassifiedEvidence;
  verification: { status: 'confirmed' | 'hypothesis'; reason: string };
}

interface StreamLine {
  cls: string;
  text: string;
}

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
  const [mode, setMode] = useState<ClientMode>('simulated');
  // SAM 3.1 is deferred per AGENTS.md §8b: board overlays always run as a
  // STATIC_FIXTURE, so toggling 'Go live' for Muse Spark 1.3 reasoning must
  // never flip the segmentation badge to LIVE_API/UNVERIFIED.
  const client = useMemo(() => new MetaClient({ mode, segmentationMode: 'static_fixture' }), [mode]);
  const [telemetry, setTelemetry] = useState<UsageTelemetry>(() => client.getTelemetry());
  // A mode toggle builds a fresh client with a fresh ledger — re-sync.
  useEffect(() => {
    setTelemetry(client.getTelemetry());
  }, [client]);
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
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [probeA, setProbeA] = useState<string | null>(null);
  const [probeB, setProbeB] = useState<string | null>(null);
  const [probeArmed, setProbeArmed] = useState(true);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [probeLog, setProbeLog] = useState<ProbeRecord[]>([]);
  const [toolsUsed, setToolsUsed] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [submitRef, setSubmitRef] = useState('');
  const [submitFault, setSubmitFault] = useState<FaultType>('solder_bridge');
  const [score, setScore] = useState<DiagnosisScore | null>(null);

  const selected = board.components.find((c) => c.ref === selectedRef) ?? null;
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
    setToolsUsed(0);
    setRevealed(false);
    setSubmitRef('');
    setScore(null);
    setDiagnosis(null);
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
    try {
      const rd = session.measureVoltage(probeA);
      pushLine('k-rule-ok', `▸ [Simulated measurement (MNA)] ${probeA} = ${rd.formatted} (powered, vs GND)`);
    } catch (err) {
      pushLine('k-rule-bad', `⏚ Probe blocked: ${err instanceof Error ? err.message : String(err)}`);
    }
    syncSessionState();
  }

  function logContinuityProbe() {
    if (!probeA || !probeB) return;
    try {
      const rd = session.measureContinuity(probeA, probeB);
      pushLine(
        rd.continuous ? 'k-rule-bad' : 'k-rule-ok',
        `▸ [Simulated measurement (MNA)] ${probeA} ↔ ${probeB} = ${rd.formatted} ${rd.continuous ? '(SHORT — continuity beep)' : '(open)'}`,
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
          const abnormal = Math.abs(rd.volts - spec.nominalVolts) > Math.abs(spec.nominalVolts) * spec.toleranceFrac + 1e-9;
          pushLine(
            abnormal ? 'k-rule-bad' : 'k-rule-ok',
            `▸ [Simulated measurement (MNA)] ${spec.node} = ${rd.formatted} (nominal ${spec.nominalVolts.toFixed(3)} V) — ${abnormal ? 'ABNORMAL' : 'nominal'}`,
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
            pushLine(
              rd.continuous ? 'k-rule-bad' : 'k-rule-ok',
              `▸ [Simulated measurement (MNA)] ${abnormal.target} ↔ ${other} = ${rd.formatted}${rd.continuous ? ' (SHORT — continuity beep)' : ''}`,
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
    setRunning(true);
    setLines([]);
    try {
      const view = session.getAgentView();
      pushLine('k-reasoning', `▸ Autonomous investigation armed: ${view.boardName} · Muse Spark 1.3 (${client.mode}) · tool budget ${session.getToolCallsUsed()}/${view.maxToolCalls}.`);
      const run = await runAgenticDiagnosis(session, client, {
        onStep: (step) => pushLine(agentStepClass(step), step.summary),
      });
      syncSessionState();
      setTelemetry(client.getTelemetry());
      const gt = session.getGroundTruth();
      if (gt && run.score) {
        setScore(run.score);
        setRevealed(true);
        pushLine(
          run.score.totalScore >= 70 ? 'k-dx' : 'k-rule-bad',
          `■ AGENTIC GROUND-TRUTH EVALUATION [${run.operationalMode}]: ${run.score.totalScore}/100 — ${run.score.summary}`,
        );
        pushLine(
          'k-cite',
          `■ AGENT VERDICT: ${run.proposedDiagnosis.componentRef} · ${run.proposedDiagnosis.faultType} (${run.proposedDiagnosis.verificationStatus}) — ${run.proposedDiagnosis.explanation}`,
        );
      } else {
        pushLine('k-rule-ok', `▸ Nominal session: agent reports healthy — ${run.proposedDiagnosis.explanation}`);
      }
      const measurements: ProbeMeasurement[] = session.getProbeLog().map((p) => ({
        point: p.target,
        value: `[Simulated measurement (MNA)] ${p.detail ?? p.kind}`,
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
            claim: `Agentic diagnosis (Muse Spark 1.3, ${run.operationalMode}): ${run.proposedDiagnosis.componentRef} · ${run.proposedDiagnosis.faultType} — ${run.proposedDiagnosis.explanation}`,
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
    } catch (err) {
      pushLine('k-rule-bad', `⏚ Investigation failed: ${err instanceof Error ? err.message : String(err)}`);
      setTelemetry(client.getTelemetry());
    } finally {
      syncSessionState();
      setRunning(false);
    }
  }

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
    pushLine(
      result.totalScore >= 70 ? 'k-dx' : 'k-rule-bad',
      `■ GROUND-TRUTH EVALUATION: ${result.totalScore}/100 — ${result.summary}`,
    );
    const measurements: ProbeMeasurement[] = session.getProbeLog().map((p) => ({
      point: p.target,
      value: `[Simulated measurement (MNA)] ${p.detail ?? p.kind}`,
      status: p.abnormal ? 'abnormal' : p.kind === 'voltage' || p.kind === 'resistance' ? 'nominal' : 'inconclusive',
    }));
    const evidence: ClassifiedEvidence = {
      observedEvidence: [...board.symptoms],
      probeMeasurements: measurements,
      datasheetSpecs: board.datasheet.map((d) => ({ section: d.title, spec: d.title })),
      hypotheses: [
        {
          claim: `Model-generated hypothesis: ${submission.componentRef} · ${submission.faultType}.`,
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

  return (
    <div className="tf-app">
      <Header client={client} onToggleMode={() => setMode((m) => (m === 'live' ? 'simulated' : 'live'))} telemetry={telemetry} />
      <BudgetMonitor telemetry={telemetry} />
      <div className="tf-main">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          <PcbCanvas
            board={board}
            selectedRef={selectedRef}
            probeA={probeA}
            probeB={probeB}
            probeArmed={probeArmed}
            segmentationMode={client.status().segmentationMode}
            onSelectComponent={setSelectedRef}
            onProbePoint={handleProbePoint}
          />
          <div className="tf-pane">
            <div className="tf-comp-info">
              {selected ? (
                <>
                  <h4>{selected.ref} · {selected.partNumber} ({selected.kind})</h4>
                  {selected.pins && (
                    <table>
                      <tbody>
                        {selected.pins.map((p) => (
                          <tr key={p.number}>
                            <td>Pin {p.number} · {p.name}</td>
                            <td>{p.function}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {selected.notes && <div style={{ marginTop: 6 }}>{selected.notes}</div>}
                </>
              ) : (
                <span style={{ color: 'var(--ink-dim)' }}>Click a component overlay to inspect part number + pinout.</span>
              )}
            </div>
            <div className="tf-meter">
              <div>
                <button className={probeArmed ? 'active' : ''} onClick={() => setProbeArmed((v) => !v)}>
                  {probeArmed ? 'Probes: ARMED (click pads)' : 'Probes: OFF'}
                </button>{' '}
                <button onClick={() => { setProbeA(null); setProbeB(null); }}>Clear probes</button>
              </div>
              <div style={{ marginTop: 8 }}>
                A: {pointA ? `${pointA.label} = ${meterVoltsA ?? '—'}` : '—'} · B:{' '}
                {pointB ? `${pointB.label}` : '—'}
                <span style={{ color: 'var(--ink-dim)' }}> · Simulated measurements (MNA)</span>
              </div>
              {meterContinuity && (
                <div className={`reading ${meterContinuity.fault ? 'fault' : ''}`} style={{ marginTop: 4 }}>
                  {meterContinuity.text}
                </div>
              )}
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button onClick={logVoltageProbe} disabled={!probeA || running}>Log voltage probe (A vs GND)</button>
                <button onClick={logContinuityProbe} disabled={!probeA || !probeB || running}>Log continuity (A↔B)</button>
              </div>
              <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)' }}>
                Logged probes count against the tool budget ({toolsUsed}/{MAX_TOOL_CALLS} used).
              </div>
            </div>
          </div>
        </div>

        <div className="tf-right">
          <div className="tf-card">
            <h3>VIRTUAL CIRCUIT LAB (MNA SOLVER) · HARDWARE-FREE</h3>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
              Hidden fault scenario:{' '}
              <select value={faultSel} onChange={(e) => switchFault(e.target.value)} disabled={running}>
                {faultOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            {faultSel === 'random' && (
              <div style={{ marginTop: 6 }}>
                <button onClick={() => { setRunId((n) => n + 1); resetLabState(); }} disabled={running}>
                  Re-roll random fault
                </button>
              </div>
            )}
            <div className="tf-row" style={{ marginTop: 8 }}>
              <button className="primary" onClick={runVirtualSweep} disabled={running}>
                {running ? 'Probing…' : 'Run virtual probe sweep'}
              </button>
            </div>
            <div className="tf-row" style={{ marginTop: 8 }}>
              <button className="primary" onClick={runAgentInvestigation} disabled={running}>
                {running ? 'Investigating…' : 'Run Autonomous AI Investigation (Muse Spark 1.3)'}
              </button>
            </div>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', marginTop: 8 }}>
              Board overlays run as STATIC_FIXTURE (KiCad reference geometry) — live SAM 3.1 calls are deferred,
              so 100% of the live runtime budget is reserved for Muse Spark 1.3 circuit reasoning.
            </p>
            <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12 }}>
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
            {probeLog.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <h4 style={{ margin: '4px 0' }}>PROBE LOG · Simulated measurements (MNA)</h4>
                <ul className="tf-ev-list">
                  {probeLog.map((p, i) => (
                    <li key={i}>
                      <span className={p.abnormal ? 'tf-ev-chip warn' : 'tf-ev-chip ok'}>
                        {p.abnormal ? 'abnormal' : p.kind}
                      </span>{' '}
                      <strong>{p.target}</strong> · {p.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
              <button className="primary" onClick={submitDiagnosis} disabled={running || !truth}>Score diagnosis</button>
            </div>
            {score && (
              <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12 }}>
                <strong>Objective score: {score.totalScore}/100</strong>
                <div>component {score.componentMatch ? 'MATCH' : 'MISS'} · fault-type {score.faultTypeMatch ? 'MATCH' : 'MISS'} · evidence {score.evidenceConfirmed ? 'CONFIRMED' : 'NOT confirmed'}</div>
                <div>probes {score.probeCount} · efficiency {score.efficiencyScore} · {score.summary}</div>
              </div>
            )}
          </div>

          <div className="tf-card">
            <h3>SYMPTOM INPUT · DATASHEET SELECTOR</h3>
            <select value={boardId} onChange={(e) => switchBoard(e.target.value)}>
              {SAMPLE_BOARDS.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <div style={{ height: 8 }} />
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
            <div className="tf-row">
              <button className="primary" onClick={runDiagnosis} disabled={running}>
                {running ? 'Diagnosing…' : 'Run diagnosis'}
              </button>
              <button onClick={() => setLines([])} disabled={running}>Clear stream</button>
            </div>
          </div>

          <div className="tf-card">
            <h3>LIVE DIAGNOSTIC STREAM · MUSE SPARK 1.3</h3>
            <div className="tf-stream">
              {lines.length === 0 && <span className="k-reasoning">Awaiting run — symptom + datasheet context will stream here.</span>}
              {lines.filter((l) => l.text.trim()).map((l, i) => (
                <div key={i} className={l.cls}>{l.text.replace('__stream__', '')}</div>
              ))}
            </div>
          </div>

          {diagnosis && (
            <DiagnosticPanel boardName={board.name} evidence={diagnosis.evidence} verification={diagnosis.verification} />
          )}

          <div className="tf-card tf-rework">
            <h3>REWORK GUIDANCE CARD</h3>
            <div className="temp">{board.rework.ironTempC} °C · {board.rework.tip}</div>
            <ol>
              {board.rework.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {board.rework.replacementPart && <p><strong>Replacement:</strong> {board.rework.replacementPart}</p>}
            <p><strong>Safety:</strong> {board.rework.safetyChecks.join(' · ')}</p>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)' }}>
              Actual measurements · Datasheet specifications · Model-generated hypotheses · Verified faults · Recommended tests · Ground-truth evaluation results are kept distinct in the panels above.
            </p>
          </div>
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
