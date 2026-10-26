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

/** Single truthful header badge for the AI operational mode. */
export function aiModeBadge(sparkMode: OperationalMode): {
  label: string;
  className: string;
} {
  if (sparkMode === 'LIVE_API') return { label: 'AI Mode: Live API', className: 'tf-chip live' };
  if (sparkMode === 'UNVERIFIED') return { label: 'AI Mode: Unverified', className: 'tf-chip unverified' };
  if (sparkMode === 'UNAVAILABLE') return { label: 'AI Mode: Unavailable', className: 'tf-chip unavailable' };
  return { label: 'AI Mode: Simulated', className: 'tf-chip sim' };
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
