import { describe, expect, it } from 'vitest';
import { SAMPLE_BOARDS, SIMULATED_CONTINUITY, getBoard } from '../src/data/samples';
import { verifyRailReading, checkContinuityReading, RAIL_SPECS } from '../src/lib/electrical';

describe('sample board data integrity', () => {
  it('ships all three required boards', () => {
    const ids = SAMPLE_BOARDS.map((b) => b.id).sort();
    expect(ids).toEqual(['esp32s3-sensor-node', 'f405-flight-controller', 'usbc-pd-trigger']);
  });

  it('gives every board symptoms, overlays, datasheet, and rework', () => {
    for (const board of SAMPLE_BOARDS) {
      expect(board.name.length).toBeGreaterThan(5);
      expect(board.faultSummary.length).toBeGreaterThan(20);
      expect(board.symptoms.length).toBeGreaterThanOrEqual(3);
      expect(board.components.length).toBeGreaterThanOrEqual(4);
      expect(board.probePoints.length).toBeGreaterThanOrEqual(3);
      expect(board.datasheet.length).toBeGreaterThanOrEqual(2);
      expect(board.expectedSteps.length).toBeGreaterThanOrEqual(3);
      expect(board.rework.steps.length).toBeGreaterThanOrEqual(3);
      expect(board.rework.safetyChecks.length).toBeGreaterThanOrEqual(1);
      expect(board.rework.ironTempC).toBeGreaterThanOrEqual(150);
      expect(board.rework.ironTempC).toBeLessThanOrEqual(450);
    }
  });

  it('keeps bboxes and masks inside 0–1000 board space', () => {
    for (const board of SAMPLE_BOARDS) {
      for (const c of board.components) {
        const { x, y, w, h } = c.bbox;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(1000);
        expect(y + h).toBeLessThanOrEqual(1000);
        expect(c.mask.length).toBeGreaterThanOrEqual(3);
        for (const [mx, my] of c.mask) {
          expect(mx).toBeGreaterThanOrEqual(0);
          expect(mx).toBeLessThanOrEqual(1000);
          expect(my).toBeGreaterThanOrEqual(0);
          expect(my).toBeLessThanOrEqual(1000);
        }
      }
      for (const p of board.probePoints) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1000);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('uses unique component refs and probe ids per board', () => {
    for (const board of SAMPLE_BOARDS) {
      expect(new Set(board.components.map((c) => c.ref)).size).toBe(board.components.length);
      expect(new Set(board.probePoints.map((p) => p.id)).size).toBe(board.probePoints.length);
    }
  });

  it('orders expected diagnostic steps starting at 1', () => {
    for (const board of SAMPLE_BOARDS) {
      const orders = board.expectedSteps.map((s) => s.order);
      expect(orders[0]).toBe(1);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    }
  });

  it('getBoard resolves known ids and misses unknown ones', () => {
    expect(getBoard('f405-flight-controller')?.faultType).toBe('solder_bridge');
    expect(getBoard('nope')).toBeUndefined();
  });
});

describe('board fault physics', () => {
  it('F405 bridge reads as a short and sags the rail check path', () => {
    const ohms = SIMULATED_CONTINUITY['U1-14|U1-15']!;
    expect(checkContinuityReading(ohms).continuous).toBe(true);
    const board = getBoard('f405-flight-controller')!;
    const nrst = board.probePoints.find((p) => p.id === 'U1-15')!;
    expect(nrst.expectedVolts!).toBeLessThan(0.7); // below NRST VIL -> held in reset
  });

  it('STM32 pinout extract names VDD and NRST on pins 14/15', () => {
    const u1 = getBoard('f405-flight-controller')!.components.find((c) => c.ref === 'U1')!;
    const pins = Object.fromEntries(u1.pins!.map((p) => [p.number, p.name]));
    expect(pins['14']).toBe('VDD');
    expect(pins['15']).toBe('NRST');
  });

  it('ESP32 5V sag fails the rail spec', () => {
    const board = getBoard('esp32s3-sensor-node')!;
    const tp = board.probePoints.find((p) => p.id === 'TP_5V')!;
    expect(verifyRailReading(RAIL_SPECS['5V']!, tp.expectedVolts!).withinSpec).toBe(false);
  });

  it('USB-C CC1 short reads as a short to ground', () => {
    const ohms = SIMULATED_CONTINUITY['CC1|GND']!;
    expect(checkContinuityReading(ohms).continuous).toBe(true);
    const board = getBoard('usbc-pd-trigger')!;
    const cc1 = board.probePoints.find((p) => p.id === 'CC1')!;
    expect(cc1.expectedVolts).toBe(0);
  });
});
