/** Electrical constraint verification helpers (Ohm's law, rails, continuity). */

export interface OhmsLawInput {
  volts?: number;
  amps?: number;
  ohms?: number;
}

export interface OhmsLawResult {
  volts: number;
  amps: number;
  ohms: number;
  powerWatts: number;
}

/**
 * Solve Ohm's law (V = I·R) given exactly two of the three quantities.
 * Throws when the input does not pin down a unique solution.
 */
export function solveOhmsLaw(input: OhmsLawInput): OhmsLawResult {
  const { volts: v, amps: i, ohms: r } = input;
  const known = [v, i, r].filter((x) => typeof x === 'number').length;
  if (known !== 2) throw new Error('solveOhmsLaw requires exactly two of volts, amps, ohms.');
  let volts = v ?? 0;
  let amps = i ?? 0;
  let ohms = r ?? 0;
  if (v === undefined) volts = i! * r!;
  else if (i === undefined) amps = r === 0 ? Number.POSITIVE_INFINITY : v / r!;
  else ohms = i === 0 ? Number.POSITIVE_INFINITY : v / i!;
  const powerWatts = volts * amps;
  return { volts, amps, ohms, powerWatts };
}

export interface ContinuityResult {
  continuous: boolean;
  resistanceOhms: number;
  thresholdOhms: number;
}

/** A path under `thresholdOhms` (default 2 Ω for a DMM beep) counts as continuous. */
export function checkContinuityReading(resistanceOhms: number, thresholdOhms = 2): ContinuityResult {
  if (!Number.isFinite(resistanceOhms) || resistanceOhms < 0) {
    throw new Error('resistanceOhms must be a finite value >= 0.');
  }
  return { continuous: resistanceOhms <= thresholdOhms, resistanceOhms, thresholdOhms };
}

export interface RailSpec {
  name: string;
  nominalVolts: number;
  /** Fractional tolerance, e.g. 0.05 for ±5%. */
  tolerance?: number;
}

export interface RailCheckResult {
  railName: string;
  nominalVolts: number;
  measuredVolts: number;
  deviationVolts: number;
  deviationPct: number;
  withinSpec: boolean;
  severity: 'ok' | 'marginal' | 'fault';
}

/**
 * Validate a measured rail against its nominal spec. Readings inside
 * tolerance are `ok`, within 2× tolerance `marginal`, beyond that `fault`.
 */
export function verifyRailReading(spec: RailSpec, measuredVolts: number): RailCheckResult {
  if (!Number.isFinite(measuredVolts)) throw new Error('measuredVolts must be finite.');
  const tolerance = spec.tolerance ?? 0.05;
  const deviationVolts = measuredVolts - spec.nominalVolts;
  const deviationPct =
    spec.nominalVolts === 0 ? (measuredVolts === 0 ? 0 : Number.POSITIVE_INFINITY) : deviationVolts / spec.nominalVolts;
  const abs = Math.abs(deviationPct);
  const withinSpec = abs <= tolerance;
  const severity = withinSpec ? 'ok' : abs <= tolerance * 2 ? 'marginal' : 'fault';
  return {
    railName: spec.name,
    nominalVolts: spec.nominalVolts,
    measuredVolts,
    deviationVolts,
    deviationPct,
    withinSpec,
    severity,
  };
}

/** Common rail specs used across the sample boards. */
export const RAIL_SPECS: Record<string, RailSpec> = {
  '3V3': { name: '3V3', nominalVolts: 3.3, tolerance: 0.05 },
  '5V': { name: '5V', nominalVolts: 5.0, tolerance: 0.05 },
  VBAT: { name: 'VBAT', nominalVolts: 16.8, tolerance: 0.1 },
  CC1: { name: 'CC1', nominalVolts: 0, tolerance: 0 },
};

export function formatVolts(v: number): string {
  return `${v.toFixed(2)} V`;
}

export function formatOhms(r: number): string {
  if (r >= 1_000_000) return `${(r / 1_000_000).toFixed(1)} MΩ`;
  if (r >= 1000) return `${(r / 1000).toFixed(1)} kΩ`;
  return `${r.toFixed(1)} Ω`;
}
