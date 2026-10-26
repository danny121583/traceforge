import { useMemo, useState } from 'react';
import { Header } from './components/Header';
import { PcbCanvas } from './components/PcbCanvas';
import { DiagnosticPanel } from './components/DiagnosticPanel';
import { MetaClient, assembleDatasheetPayload, TOOL_DEFINITIONS } from './lib/meta-client';
import { verifyRailReading, checkContinuityReading, formatVolts, formatOhms, RAIL_SPECS } from './lib/electrical';
import {
  parseEvidenceTranscript,
  diagnosisVerificationStatus,
  type ClassifiedEvidence,
  type ProbeMeasurement,
} from './lib/diagnostic-parser';
import { SIMULATED_CONTINUITY, SAMPLE_BOARDS, getBoard } from './data/samples';
import type { ClientMode } from './lib/meta-client';

interface Diagnosis {
  evidence: ClassifiedEvidence;
  verification: { status: 'confirmed' | 'hypothesis'; reason: string };
}

interface StreamLine {
  cls: string;
  text: string;
}

function continuityBetween(a: string, b: string): number {
  const key = [a, b].sort().join('|');
  return SIMULATED_CONTINUITY[key] ?? 12_000_000;
}

export function App() {
  const [mode, setMode] = useState<ClientMode>('simulated');
  const client = useMemo(() => new MetaClient({ mode }), [mode]);
  const [boardId, setBoardId] = useState(SAMPLE_BOARDS[0]!.id);
  const board = getBoard(boardId) ?? SAMPLE_BOARDS[0]!;
  const [symptom, setSymptom] = useState(board.symptoms[0] ?? '');
  const [customDoc, setCustomDoc] = useState('');
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [probeA, setProbeA] = useState<string | null>(null);
  const [probeB, setProbeB] = useState<string | null>(null);
  const [probeArmed, setProbeArmed] = useState(true);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);

  const selected = board.components.find((c) => c.ref === selectedRef) ?? null;
  const pointA = board.probePoints.find((p) => p.id === probeA) ?? null;
  const pointB = board.probePoints.find((p) => p.id === probeB) ?? null;

  function switchBoard(id: string) {
    const next = getBoard(id);
    if (!next) return;
    setBoardId(id);
    setSymptom(next.symptoms[0] ?? '');
    setLines([]);
    setSelectedRef(null);
    setProbeA(null);
    setProbeB(null);
    setDiagnosis(null);
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

  const meterOhms = pointA && pointB ? continuityBetween(pointA.id, pointB.id) : null;
  const meterCont = meterOhms !== null ? checkContinuityReading(meterOhms) : null;

  return (
    <div className="tf-app">
      <Header client={client} onToggleMode={() => setMode((m) => (m === 'live' ? 'simulated' : 'live'))} />
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
                A: {pointA ? `${pointA.label} = ${formatVolts(pointA.expectedVolts ?? 0)}` : '—'} · B:{' '}
                {pointB ? `${pointB.label} = ${formatVolts(pointB.expectedVolts ?? 0)}` : '—'}
              </div>
              {meterOhms !== null && meterCont && (
                <div className={`reading ${meterCont.continuous ? 'fault' : ''}`} style={{ marginTop: 4 }}>
                  {meterCont.continuous ? `BEEP — ${formatOhms(meterOhms)} SHORT` : `${formatOhms(meterOhms)} OPEN`}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="tf-right">
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
          </div>
        </div>
      </div>
    </div>
  );
}
