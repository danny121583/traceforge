import { describe, expect, it } from 'vitest';
import {
  aiModeBadge,
  formatActivitySummary,
  getActiveStep,
  isInvestigationComplete,
  plainSymptomForBoard,
  primaryWorkflowAction,
  reworkWithheldReason,
  shouldShowRework,
} from '../src/lib/guided-ux';
import type { ProbeRecord } from '../src/lib/circuit-simulator';

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

describe('AI mode badge', () => {
  it('labels every operational mode truthfully with the matching chip class', () => {
    expect(aiModeBadge('LIVE_API')).toEqual({ label: 'AI Mode: Live API', className: 'tf-chip live' });
    expect(aiModeBadge('SIMULATED')).toEqual({ label: 'AI Mode: Simulated', className: 'tf-chip sim' });
    expect(aiModeBadge('STATIC_FIXTURE')).toEqual({ label: 'AI Mode: Simulated', className: 'tf-chip sim' });
    expect(aiModeBadge('UNVERIFIED')).toEqual({ label: 'AI Mode: Unverified', className: 'tf-chip unverified' });
    expect(aiModeBadge('UNAVAILABLE')).toEqual({ label: 'AI Mode: Unavailable', className: 'tf-chip unavailable' });
  });

  it('never exposes model branding in the header badge label', () => {
    for (const mode of ['LIVE_API', 'SIMULATED', 'STATIC_FIXTURE', 'UNVERIFIED', 'UNAVAILABLE'] as const) {
      expect(aiModeBadge(mode).label).not.toContain('Muse');
      expect(aiModeBadge(mode).label).not.toContain('Spark');
    }
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
