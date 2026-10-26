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

/**
 * Parse a multimeter voltage input into volts.
 *
 * Accepts raw numbers (volts), numeric strings, and suffixed forms:
 * `3.3V`, `3300mV`, `500uV` (also `µV`/`μV`), with optional
 * whitespace and sign — negative rails like `-12V` are valid.
 * Throws a descriptive Error on malformed input.
 */
export function parseVoltage(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`Invalid voltage: ${String(input)}`);
    return input;
  }
  const text = input.trim();
  if (!text) throw new Error('Invalid voltage: empty input.');
  const m = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(µV|μV|uV|mV|V|v)?$/);
  if (!m) throw new Error(`Invalid voltage: "${input}"`);
  const magnitude = Number(m[1]);
  if (!Number.isFinite(magnitude)) throw new Error(`Invalid voltage: "${input}"`);
  const unit = (m[2] ?? 'V').toLowerCase();
  if (unit === 'v') return magnitude;
  if (unit === 'mv') return magnitude / 1000;
  if (unit === 'uv' || unit === 'µv' || unit === 'μv') return magnitude / 1_000_000;
  throw new Error(`Invalid voltage: "${input}"`);
}

const OPEN_CIRCUIT_TOKENS = new Set(['inf', '+inf', '-inf', 'infinity', 'ol', 'o.l', 'open', '---', '------']);

function normalizeOhmUnit(raw: string): string {
  return raw
    .replace(/Ω/g, 'ohm')
    .replace(/ω/g, 'ohm')
    .trim()
    .toLowerCase();
}

/**
 * Parse a multimeter resistance input into ohms.
 *
 * Accepts raw numbers (ohms), numeric strings, and suffixed forms:
 * `Ω`/`ohm`, `kΩ`/`k`, `MΩ`/`M`, `mΩ`, plus open-circuit indicators
 * (`inf`, `OL`, `open`, `---`) which map to `Infinity`.
 * Throws on malformed input (`"abc"`) and on negative resistance,
 * which is physically meaningless for a passive reading.
 */
export function parseResistance(input: string | number): number {
  if (typeof input === 'number') {
    if (Number.isNaN(input)) throw new Error(`Invalid resistance: ${String(input)}`);
    if (input === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid resistance: ${String(input)}`);
    }
    return input;
  }
  const text = input.trim();
  if (!text) throw new Error('Invalid resistance: empty input.');
  if (OPEN_CIRCUIT_TOKENS.has(text.toLowerCase())) return Number.POSITIVE_INFINITY;
  const m = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(.+)?$/);
  if (!m) throw new Error(`Invalid resistance: "${input}"`);
  const magnitude = Number(m[1]);
  if (!Number.isFinite(magnitude)) throw new Error(`Invalid resistance: "${input}"`);
  if (magnitude < 0) throw new Error(`Invalid resistance (negative): "${input}"`);
  const unitRaw = (m[2] ?? '').trim();
  if (!unitRaw) return magnitude;
  // Mega (`M`) vs milli (`m`) differ by case only — dispatch on the raw
  // unit before lowercasing.
  if (/^(Ω|ω|ohm|ohms|r)$/.test(unitRaw)) return magnitude;
  if (/^(kΩ|KΩ|kohm|Kohm|kOhm|KOHM|kohms|Kohms|k|K)$/.test(unitRaw)) return magnitude * 1000;
  if (/^(MΩ|Mohm|MOhm|MOHM|Mohms|M)$/.test(unitRaw)) return magnitude * 1_000_000;
  if (/^(mΩ|mohm|mOhm|milliohm|milliohms|mohm)$/.test(unitRaw)) return magnitude / 1000;
  const unit = normalizeOhmUnit(unitRaw);
  if (unit === 'kohm' || unit === 'kohms' || unit === 'k') return magnitude * 1000;
  if (unit === 'mohms' || unit === 'm') return magnitude * 1_000_000;
  throw new Error(`Invalid resistance: "${input}"`);
}

/**
 * Validate a pair of probe-point ids selected on the canvas.
 * Throws when either end is missing/blank, unknown, or both ends
 * are the same point (a self-measurement proves nothing).
 */
export function validateProbePair(a: string | null | undefined, b: string | null | undefined, knownIds?: readonly string[]): void {
  if (!a || !a.trim()) throw new Error('Probe point A is missing: select a first pad.');
  if (!b || !b.trim()) throw new Error('Probe point B is missing: select a second pad.');
  if (a.trim() === b.trim()) throw new Error(`Invalid probe pair: both probes are on "${a.trim()}".`);
  if (knownIds) {
    if (!knownIds.includes(a.trim())) throw new Error(`Unknown probe point: "${a}".`);
    if (!knownIds.includes(b.trim())) throw new Error(`Unknown probe point: "${b}".`);
  }
}

export function formatVolts(v: number): string {
  return `${v.toFixed(2)} V`;
}

export function formatOhms(r: number): string {
  if (r >= 1_000_000) return `${(r / 1_000_000).toFixed(1)} MΩ`;
  if (r >= 1000) return `${(r / 1000).toFixed(1)} kΩ`;
  return `${r.toFixed(1)} Ω`;
}
