import { describe, expect, it } from 'vitest';
import {
  solveOhmsLaw,
  checkContinuityReading,
  verifyRailReading,
  formatOhms,
  formatVolts,
  RAIL_SPECS,
} from '../src/lib/electrical';

describe("Ohm's law solver", () => {
  it('solves V = I·R from current and resistance', () => {
    const r = solveOhmsLaw({ amps: 2, ohms: 6 });
    expect(r.volts).toBeCloseTo(12);
    expect(r.powerWatts).toBeCloseTo(24);
  });

  it('solves I = V/R and R = V/I', () => {
    expect(solveOhmsLaw({ volts: 5, ohms: 10 }).amps).toBeCloseTo(0.5);
    expect(solveOhmsLaw({ volts: 3.3, amps: 0.1 }).ohms).toBeCloseTo(33);
  });

  it('rejects under- and over-specified inputs', () => {
    expect(() => solveOhmsLaw({ volts: 5 })).toThrow();
    expect(() => solveOhmsLaw({ volts: 5, amps: 1, ohms: 5 })).toThrow();
    expect(() => solveOhmsLaw({})).toThrow();
  });
});

describe('continuity checks', () => {
  it('beeps below the 2 Ω DMM threshold', () => {
    expect(checkContinuityReading(0.4).continuous).toBe(true);
    expect(checkContinuityReading(0.2).continuous).toBe(true);
    expect(checkContinuityReading(2).continuous).toBe(true);
  });

  it('reads open above threshold', () => {
    expect(checkContinuityReading(2.1).continuous).toBe(false);
    expect(checkContinuityReading(12_000_000).continuous).toBe(false);
  });

  it('rejects negative or non-finite resistance', () => {
    expect(() => checkContinuityReading(-1)).toThrow();
    expect(() => checkContinuityReading(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('voltage rail validation', () => {
  it('passes a healthy 3V3 rail', () => {
    const r = verifyRailReading(RAIL_SPECS['3V3']!, 3.28);
    expect(r.withinSpec).toBe(true);
    expect(r.severity).toBe('ok');
  });

  it('flags the sagged F405 3V3 rail as marginal', () => {
    const r = verifyRailReading(RAIL_SPECS['3V3']!, 3.05);
    expect(r.withinSpec).toBe(false);
    expect(r.severity).toBe('marginal');
    expect(r.deviationVolts).toBeCloseTo(-0.25, 5);
  });

  it('flags the ESP32 5V brownout sag as a fault', () => {
    const r = verifyRailReading(RAIL_SPECS['5V']!, 4.2);
    expect(r.withinSpec).toBe(false);
    expect(r.severity).toBe('fault');
    expect(r.deviationPct).toBeCloseTo(-0.16, 5);
  });

  it('detects the dead CC1 line', () => {
    const cc2 = verifyRailReading({ name: 'CC2', nominalVolts: 0.8, tolerance: 0.25 }, 0.8);
    expect(cc2.withinSpec).toBe(true);
    const cc1 = verifyRailReading({ name: 'CC1', nominalVolts: 0.8, tolerance: 0.25 }, 0.0);
    expect(cc1.severity).toBe('fault');
  });

  it('rejects non-finite measurements', () => {
    expect(() => verifyRailReading(RAIL_SPECS['5V']!, Number.NaN)).toThrow();
  });
});

describe('formatters', () => {
  it('formats volts and ohms across scales', () => {
    expect(formatVolts(3.3)).toBe('3.30 V');
    expect(formatOhms(0.4)).toBe('0.4 Ω');
    expect(formatOhms(4700)).toBe('4.7 kΩ');
    expect(formatOhms(12_000_000)).toBe('12.0 MΩ');
  });
});
