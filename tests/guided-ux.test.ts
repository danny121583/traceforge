import { describe, expect, it } from 'vitest';
import {
  aiModeBadge,
  executionSourceLabel,
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
} from '../src/lib/guided-ux';
import { getBoard } from '../src/data/samples';
import { getReferenceBoard, type ProbeRecord } from '../src/lib/circuit-simulator';

describe('guided step highlighting', () => {
  it('starts on Step 1 before any activity', () => {
    expect(getActiveStep({ running: false, complete: false, hasActivity: false })).toBe(1);
  });

  it('moves to Step 2 while running or once bench activity exists', () => {
    expect(getActiveStep({ running: true, complete: false, hasActivity: false })).toBe(2);
    expect(getActiveStep({ running: false, complete: false, hasActivity: true })).toBe(2);
  });

  it('moves to Step 3 once a diagnosis/score completes the run', () => {
    expect(getActiveStep({ running: false, complete: true, hasActivity: true })).toBe(3);
    expect(getActiveStep({ running: false, complete: true, hasActivity: false })).toBe(3);
  });

  it('treats a diagnosis or a score as investigation-complete', () => {
    expect(isInvestigationComplete({ diagnosis: { evidence: {} }, score: null })).toBe(true);
    expect(isInvestigationComplete({ diagnosis: null, score: { totalScore: 80 } as never })).toBe(true);
    expect(isInvestigationComplete({ diagnosis: null, score: null })).toBe(false);
  });
});

describe('single primary workflow action', () => {
  it('offers Start AI Investigation before the run', () => {
    expect(primaryWorkflowAction({ running: false, complete: false })).toEqual({
      label: 'Start AI Investigation',
      disabled: false,
    });
  });

  it('shows a disabled Investigating state while running', () => {
    expect(primaryWorkflowAction({ running: true, complete: false })).toEqual({
      label: 'Investigating Circuit…',
      disabled: true,
    });
  });

  it('removes the workflow primary once the run completes (post-run action lives in Step 3)', () => {
    expect(primaryWorkflowAction({ running: false, complete: true })).toBeNull();
  });
});

describe('rework disclosure gating', () => {
  it('hides rework guidance before the investigation completes', () => {
    expect(shouldShowRework({ complete: false, verificationStatus: 'confirmed' })).toBe(false);
    expect(shouldShowRework({ complete: false, verificationStatus: null })).toBe(false);
  });

  it('shows rework guidance only for electrically confirmed faults', () => {
    expect(shouldShowRework({ complete: true, verificationStatus: 'confirmed' })).toBe(true);
    expect(shouldShowRework({ complete: true, verificationStatus: 'hypothesis' })).toBe(false);
    expect(shouldShowRework({ complete: true, verificationStatus: null })).toBe(false);
  });

  it('withholds rework for healthy boards and unverified hypotheses with explicit reasons', () => {
    expect(reworkWithheldReason({ complete: false, isHealthy: false, verificationStatus: null })).toContain(
      'Run an AI investigation in Step 2',
    );
    expect(reworkWithheldReason({ complete: true, isHealthy: true, verificationStatus: null })).toContain(
      'healthy',
    );
    expect(
      reworkWithheldReason({ complete: true, isHealthy: false, verificationStatus: 'hypothesis' }),
    ).toContain('withheld until electrical measurements confirm');
    expect(reworkWithheldReason({ complete: true, isHealthy: false, verificationStatus: 'confirmed' })).toBe('');
  });
});

describe('plain-language activity summary', () => {
  const log: ProbeRecord[] = [
    { kind: 'voltage', target: 'TP_3V3', abnormal: false, detail: '3.29 V (nominal 3.300 V)' },
    { kind: 'resistance', target: 'U1-15 ↔ GND', abnormal: true, detail: '0.2 Ω (SHORT — continuity beep)' },
  ];

  it('renders one plain sentence per probe with normal/abnormal outcome', () => {
    const lines = formatActivitySummary(log);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Probe 1');
    expect(lines[0]).toContain('TP_3V3');
    expect(lines[0]).toContain('looked normal');
    expect(lines[1]).toContain('Probe 2');
    expect(lines[1]).toContain('looked abnormal');
  });

  it('returns an empty timeline for an empty probe log', () => {
    expect(formatActivitySummary([])).toEqual([]);
  });
});

describe('AI mode badge (unified Live AI status model)', () => {
  it('labels every operational mode truthfully with the unified status model', () => {
    expect(aiModeBadge('LIVE_API')).toEqual({ label: 'Completed with Muse Spark 1.3', className: 'tf-chip live' });
    expect(aiModeBadge('SIMULATED')).toEqual({ label: 'Virtual Lab', className: 'tf-chip sim' });
    expect(aiModeBadge('STATIC_FIXTURE')).toEqual({ label: 'Virtual Lab', className: 'tf-chip sim' });
    expect(aiModeBadge('UNVERIFIED')).toEqual({ label: 'Live AI Ready', className: 'tf-chip live' });
    expect(aiModeBadge('UNAVAILABLE')).toEqual({ label: 'Live AI Unavailable', className: 'tf-chip unavailable' });
  });

  it('never exposes raw internal enum identifiers in any badge label', () => {
    for (const mode of ['LIVE_API', 'SIMULATED', 'STATIC_FIXTURE', 'UNVERIFIED', 'UNAVAILABLE', 'RECORDED_LIVE_REPLAY'] as const) {
      const label = aiModeBadge(mode).label;
      expect(label).not.toContain('LIVE_API');
      expect(label).not.toContain('UNVERIFIED');
      expect(label).not.toContain('STATIC_FIXTURE');
      expect(label).not.toContain('RECORDED_LIVE_REPLAY');
    }
  });

  it('distinguishes Live AI Ready, Live AI Investigating, Completed with Muse Spark 1.3, and Recorded Investigation', () => {
    expect(aiModeBadge('UNVERIFIED', { proxyConfigured: true })).toEqual({
      label: 'Live AI Ready',
      className: 'tf-chip live',
    });
    expect(aiModeBadge('UNVERIFIED', { proxyConfigured: true, running: true })).toEqual({
      label: 'Live AI Investigating',
      className: 'tf-chip live',
    });
    expect(aiModeBadge('LIVE_API', { running: true })).toEqual({
      label: 'Live AI Investigating',
      className: 'tf-chip live',
    });
    expect(aiModeBadge('LIVE_API', { running: false })).toEqual({
      label: 'Completed with Muse Spark 1.3',
      className: 'tf-chip live',
    });
    expect(aiModeBadge('RECORDED_LIVE_REPLAY')).toEqual({
      label: 'Recorded Investigation',
      className: 'tf-chip sim',
    });
  });

  it('reports Live AI Unavailable when proxyConfigured is false or UNVERIFIED cannot reach proxy', () => {
    expect(aiModeBadge('UNVERIFIED', { proxyConfigured: true })).toEqual({
      label: 'Live AI Ready',
      className: 'tf-chip live',
    });
    expect(aiModeBadge('UNVERIFIED', { proxyConfigured: false })).toEqual({
      label: 'Live AI Unavailable',
      className: 'tf-chip unavailable',
    });
  });

  it('reports Live AI Unavailable whenever a liveModeError is present (mode never silently reverts)', () => {
    const err = 'proxy unavailable';
    for (const mode of ['LIVE_API', 'UNVERIFIED', 'UNAVAILABLE', 'SIMULATED'] as const) {
      expect(aiModeBadge(mode, { proxyConfigured: true, liveModeError: err })).toEqual({
        label: 'Live AI Unavailable',
        className: 'tf-chip unavailable',
      });
    }
    expect(aiModeBadge('UNVERIFIED', { liveModeError: null })).toEqual(aiModeBadge('UNVERIFIED'));
  });
});

describe('executionSourceLabel', () => {
  it('returns the five exact technical execution source strings', () => {
    expect(executionSourceLabel('UNAVAILABLE')).toBe('AI Service Unavailable');
    expect(executionSourceLabel('SIMULATED', { liveModeError: 'proxy down' })).toBe('AI Service Unavailable');
    expect(executionSourceLabel('LIVE_API')).toBe('Live Muse Spark 1.3');
    expect(executionSourceLabel('RECORDED_LIVE_REPLAY')).toBe('Recorded Live Investigation');
    expect(executionSourceLabel('STATIC_FIXTURE')).toBe('Static Reference Fixture');
    expect(executionSourceLabel('SIMULATED')).toBe('Deterministic Virtual Lab');
    expect(executionSourceLabel('UNVERIFIED')).toBe('Deterministic Virtual Lab');
  });
});

describe('Phase 3: progressive investigation lifecycle', () => {
  it('formats a distinct human-readable status for every lifecycle stage', () => {
    expect(formatLifecycleStatus('idle')).toContain('Idle');
    expect(formatLifecycleStatus('initializing')).toContain('Initializing');
    expect(formatLifecycleStatus('probing')).toContain('Probing');
    expect(formatLifecycleStatus('updating_hypothesis')).toContain('Updating Hypothesis');
    expect(formatLifecycleStatus('completed')).toContain('Completed');
    expect(formatLifecycleStatus('error')).toContain('Error');
  });

  it('appends the detail string when provided, omits it otherwise', () => {
    const withDetail = formatLifecycleStatus('probing', 'Probing U1-15…');
    expect(withDetail).toContain('Probing');
    expect(withDetail).toContain('Probing U1-15…');
    expect(formatLifecycleStatus('idle')).not.toContain('(');
  });

  it('orders the full lifecycle idle -> initializing -> probing -> updating_hypothesis -> completed', () => {
    const ordered = ['idle', 'initializing', 'probing', 'updating_hypothesis', 'completed'] as const;
    const labels = ordered.map((s) => formatLifecycleStatus(s));
    // Every stage has its own label (no silent instant-completion aliases).
    expect(new Set(labels).size).toBe(ordered.length);
    expect(labels[0]).toContain('ready to start');
    expect(labels[4]).toContain('evaluation ready');
  });
});

describe('mapProbeRecordsToPcbHighlights', () => {
  const f405 = getBoard('f405-flight-controller')!;
  const f405Aliases = getReferenceBoard('f405-flight-controller')!.probeAliases;
  const usbc = getBoard('usbc-pd-trigger')!;
  const usbcAliases = getReferenceBoard('usbc-pd-trigger')!.probeAliases;
  const esp32 = getBoard('esp32s3-sensor-node')!;
  const esp32Aliases = getReferenceBoard('esp32s3-sensor-node')!.probeAliases;

  it('maps a voltage probe to its test point with the computed reading', () => {
    const log: ProbeRecord[] = [
      { kind: 'voltage', target: 'TP_3V3', abnormal: false, detail: '3.050 V vs nominal 3.267 V' },
    ];
    const h = mapProbeRecordsToPcbHighlights(f405, f405Aliases, log, null);
    expect(h.measuredPoints['TP_3V3']).toMatchObject({
      reading: '3.050 V vs nominal 3.267 V',
      abnormal: false,
      kind: 'voltage',
    });
    // No live target: the most recent measurement location becomes active.
    expect(h.activePointIds).toContain('TP_3V3');
    expect(h.activeContinuityLine).toBeNull();
  });

  it("resolves aliases both ways ('U1-15' -> 'U1-15' & 'TP_NRST')", () => {
    const log: ProbeRecord[] = [
      { kind: 'voltage', target: 'U1-15', abnormal: true, detail: '0.020 V vs nominal 3.240 V' },
    ];
    const h = mapProbeRecordsToPcbHighlights(f405, f405Aliases, log, null);
    expect(h.measuredPoints['U1-15']?.abnormal).toBe(true);
    expect(h.measuredPoints['TP_NRST']?.reading).toContain('0.020 V');
    expect(h.activePointIds).toEqual(expect.arrayContaining(['U1-15', 'TP_NRST']));
  });

  it("resolves label aliases ('TP_CC1' label <-> 'CC1' id, 'TP_5V' <-> 'C4-POS')", () => {
    const usbcLog: ProbeRecord[] = [
      { kind: 'voltage', target: 'TP_CC1', abnormal: true, detail: '0.000 V vs nominal 0.417 V' },
    ];
    const hu = mapProbeRecordsToPcbHighlights(usbc, usbcAliases, usbcLog, null);
    expect(hu.measuredPoints['CC1']?.abnormal).toBe(true);

    const espLog: ProbeRecord[] = [
      { kind: 'voltage', target: 'TP_5V', abnormal: true, detail: '4.200 V vs nominal 4.956 V' },
    ];
    const he = mapProbeRecordsToPcbHighlights(esp32, esp32Aliases, espLog, null);
    expect(he.measuredPoints['TP_5V']?.abnormal).toBe(true);
    expect(he.measuredPoints['C4-POS']?.reading).toContain('4.200 V');
  });

  it("builds a continuity vector for 'U1-15↔GND' between real pad coordinates", () => {
    const log: ProbeRecord[] = [
      { kind: 'voltage', target: 'U1-15', abnormal: true, detail: '0.020 V vs nominal 3.240 V' },
      { kind: 'resistance', target: 'U1-15↔GND', abnormal: true, detail: '0.400 Ω' },
    ];
    const h = mapProbeRecordsToPcbHighlights(f405, f405Aliases, log, 'U1-15↔GND');
    const line = h.activeContinuityLine;
    expect(line).not.toBeNull();
    // U1-15 pad (350, 410) → GND pad (120, 850) per src/data/samples.ts.
    expect(line).toMatchObject({ x1: 350, y1: 410, x2: 120, y2: 850, abnormal: true });
    expect(line!.label).toContain('0.400 Ω');
    expect(h.activePointIds).toEqual(expect.arrayContaining(['U1-15', 'GND']));
    expect(h.measuredPoints['GND']?.kind).toBe('resistance');
  });

  it('keeps the most recent continuity vector once the probe goes idle', () => {
    const log: ProbeRecord[] = [
      { kind: 'resistance', target: 'U1-15↔GND', abnormal: true, detail: '0.400 Ω' },
    ];
    const h = mapProbeRecordsToPcbHighlights(f405, f405Aliases, log, null);
    expect(h.activeContinuityLine).not.toBeNull();
    expect(h.activeContinuityLine).toMatchObject({ x1: 350, y1: 410, x2: 120, y2: 850 });
  });

  it('produces zero highlights when no measurements occurred', () => {
    const h = mapProbeRecordsToPcbHighlights(f405, f405Aliases, [], null);
    expect(h).toEqual({ activePointIds: [], measuredPoints: {}, activeContinuityLine: null });
  });

  it('ignores lookup/context records (no fake measurement highlights)', () => {
    const log: ProbeRecord[] = [
      { kind: 'lookup', target: 'STM32F405 pin 15', abnormal: false, detail: 'pinout context lookup' },
    ];
    const h = mapProbeRecordsToPcbHighlights(f405, f405Aliases, log, null);
    expect(h).toEqual({ activePointIds: [], measuredPoints: {}, activeContinuityLine: null });
  });
});

describe('extractProbeTargetFromStepSummary', () => {
  it('extracts the node from a voltage tool call/result', () => {
    expect(extractProbeTargetFromStepSummary('Tool Call: measure_node_voltage(node=U1-15, ref_node=GND) -> 0.020 V')).toBe(
      'U1-15',
    );
  });

  it('extracts an A↔B pair from a continuity tool call/result', () => {
    expect(
      extractProbeTargetFromStepSummary('Tool Call: check_continuity(probe_a=U1-15, probe_b=GND) -> 0.400 Ω SHORT (beep)'),
    ).toBe('U1-15↔GND');
  });

  it('returns null for reasoning and diagnosis lines that touch no pad', () => {
    expect(extractProbeTargetFromStepSummary('▸ Autonomous investigation armed: FPV Drone')).toBeNull();
    expect(extractProbeTargetFromStepSummary('■ AGENT VERDICT: U1 · solder_bridge (confirmed)')).toBeNull();
  });
});

describe('circuit card symptoms', () => {
  it('provides a plain-English symptom for every sample board', () => {
    for (const id of ['f405-flight-controller', 'esp32s3-sensor-node', 'usbc-pd-trigger']) {
      const s = plainSymptomForBoard(id, 'fallback');
      expect(s.length).toBeGreaterThan(0);
      expect(s).not.toBe('fallback');
    }
  });

  it('falls back to the board symptom for unknown ids', () => {
    expect(plainSymptomForBoard('unknown-board', 'Board hums loudly.')).toBe('Board hums loudly.');
  });
});
