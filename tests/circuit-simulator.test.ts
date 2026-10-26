import { describe, expect, it } from 'vitest';
import {
  SIMULATOR_CAPABILITIES,
  CircuitSolverError,
  validateCircuit,
  solveLinearSystem,
  solveDcCircuit,
  measureNodeVoltage,
  measureBranchCurrent,
  measureEffectiveResistance,
  applyFaultToCircuit,
  getReferenceBoard,
  listReferenceBoards,
  REFERENCE_BOARD_IDS,
  getFaultScenario,
  createVirtualSession,
  assertGroundTruthIsolated,
  scoreDiagnosis,
  MAX_TOOL_CALLS,
  type Circuit,
  type HiddenFault,
} from '../src/lib/circuit-simulator';
import {
  MetaClient,
  TOOL_DEFINITIONS,
  VIRTUAL_LAB_TOOL_DEFINITIONS,
  ALL_TOOL_DEFINITIONS,
  defaultSimulatedToolResult,
} from '../src/lib/meta-client';
import { handleMetaProxyRequest, PROXY_KEY_MISSING_MESSAGE } from '../src/server/meta-proxy';

/* Hand-calculated reference circuits (independent analytical oracles). */

function seriesDivider(): Circuit {
  return {
    id: 'divider',
    nodes: ['GND', 'TOP', 'MID'],
    components: [
      { id: 'V1', type: 'voltage_source', positiveNode: 'TOP', negativeNode: 'GND', volts: 10 },
      { id: 'R1', type: 'resistor', nodeA: 'TOP', nodeB: 'MID', ohms: 1000 },
      { id: 'R2', type: 'resistor', nodeA: 'MID', nodeB: 'GND', ohms: 1000 },
    ],
  };
}

function wheatstone(unbalanced: boolean): Circuit {
  return {
    id: 'wheatstone',
    nodes: ['GND', 'TOP', 'L', 'R'],
    components: [
      { id: 'V1', type: 'voltage_source', positiveNode: 'TOP', negativeNode: 'GND', volts: 12 },
      { id: 'R1', type: 'resistor', nodeA: 'TOP', nodeB: 'L', ohms: 1000 },
      { id: 'R2', type: 'resistor', nodeA: 'L', nodeB: 'GND', ohms: 2000 },
      { id: 'R3', type: 'resistor', nodeA: 'TOP', nodeB: 'R', ohms: unbalanced ? 2000 : 1000 },
      { id: 'R4', type: 'resistor', nodeA: 'R', nodeB: 'GND', ohms: unbalanced ? 1000 : 2000 },
      { id: 'RB', type: 'resistor', nodeA: 'L', nodeB: 'R', ohms: 1000 },
    ],
  };
}

function multiLoop(): Circuit {
  return {
    id: 'multiloop',
    nodes: ['GND', 'N1', 'N2'],
    components: [
      { id: 'V1', type: 'voltage_source', positiveNode: 'N1', negativeNode: 'GND', volts: 10 },
      { id: 'R1', type: 'resistor', nodeA: 'N1', nodeB: 'N2', ohms: 2000 },
      { id: 'R2', type: 'resistor', nodeA: 'N2', nodeB: 'GND', ohms: 4000 },
      { id: 'I1', type: 'current_source', fromNode: 'N2', toNode: 'GND', amps: 0.001 },
    ],
  };
}

describe('series voltage divider (10V, 1k/1k)', () => {
  it('matches Vmid = 5.000V, I = 5.000mA, P_R1 = 25mW', () => {
    const s = solveDcCircuit(seriesDivider());
    expect(s.nodeVoltages['MID']).toBeCloseTo(5.0, 9);
    expect(s.nodeVoltages['TOP']).toBeCloseTo(10.0, 9);
    expect(s.nodeVoltages['GND']).toBe(0);
    expect(s.branchCurrents['R1']).toBeCloseTo(0.005, 9);
    expect(s.branchCurrents['R2']).toBeCloseTo(0.005, 9);
    expect(s.componentPowerWatts['R1']).toBeCloseTo(0.025, 9);
    expect(measureNodeVoltage(s, 'MID').volts).toBeCloseTo(5.0, 9);
    expect(measureBranchCurrent(s, 'R1').milliamps).toBeCloseTo(5.0, 9);
  });

  it('reports 1kΩ unplugged vs 500Ω source-shorted effective resistance', () => {
    const c = seriesDivider();
    const unplugged = measureEffectiveResistance(c, 'MID', 'GND');
    expect(unplugged.ohms).toBeCloseTo(1000, 6);
    expect(unplugged.continuous).toBe(false);
    const shorted = measureEffectiveResistance(c, 'MID', 'GND', undefined, { supplyMode: 'kill_sources' });
    expect(shorted.ohms).toBeCloseTo(500, 3);
  });
});

describe('Wheatstone bridge (12V)', () => {
  it('is balanced at 0.000V bridge delta with zero bridge current', () => {
    const s = solveDcCircuit(wheatstone(false));
    expect(s.nodeVoltages['L']).toBeCloseTo(8.0, 9);
    expect(s.nodeVoltages['R']).toBeCloseTo(8.0, 9);
    expect(s.nodeVoltages['L']! - s.nodeVoltages['R']!).toBeCloseTo(0.0, 9);
    expect(s.branchCurrents['RB']).toBeCloseTo(0.0, 9);
  });

  it('matches the exact Thevenin solution when unbalanced', () => {
    // Thevenin: Vth_L = 8V / 666.667Ω, Vth_R = 4V / 666.667Ω, RB = 1kΩ.
    const expectedBridgeAmps = (8 - 4) / (2000 / 3 + 1000 + 2000 / 3);
    const s = solveDcCircuit(wheatstone(true));
    expect(s.branchCurrents['RB']).toBeCloseTo(expectedBridgeAmps, 9);
    expect(s.nodeVoltages['L']! - s.nodeVoltages['R']!).toBeCloseTo(expectedBridgeAmps * 1000, 9);
    expect(measureNodeVoltage(s, 'L', 'R').volts).toBeCloseTo(expectedBridgeAmps * 1000, 9);
    // KCL residual at L: currents leaving through R1/R2/RB sum to ~0.
    const iR1 = (12 - s.nodeVoltages['L']!) / 1000;
    const iR2 = s.nodeVoltages['L']! / 2000;
    expect(iR1 - iR2 - s.branchCurrents['RB']!).toBeCloseTo(0, 9);
  });
});

describe('multi-loop KCL/KVL network (voltage + current source)', () => {
  it('matches the hand-derived nodal solution V(N2) = 16/3 V', () => {
    const s = solveDcCircuit(multiLoop());
    // (V2−10)/2k + V2/4k + 1mA = 0  ⇒  V2 = 16/3 V.
    expect(s.nodeVoltages['N2']).toBeCloseTo(16 / 3, 9);
    expect(s.branchCurrents['R1']).toBeCloseTo((10 - 16 / 3) / 2000, 9);
    expect(s.componentPowerWatts['R2']).toBeCloseTo((16 / 3) ** 2 / 4000, 9);
    // Source delivers power (absorbed P < 0 for the current source here).
    expect(s.componentPowerWatts['V1']).toBeLessThan(0);
  });
});

describe('strict input validation and singular matrices', () => {
  const good: Circuit = seriesDivider();

  it('rejects empty circuits and missing ground', () => {
    expect(() => validateCircuit({ nodes: [], components: [] })).toThrow(CircuitSolverError);
    expect(() => validateCircuit({ nodes: ['A'], components: [{ id: 'R', type: 'resistor', nodeA: 'A', nodeB: 'A', ohms: 10 }] })).toThrow(/ground/i);
  });

  it('accepts SPICE-style ground alias 0', () => {
    const c: Circuit = {
      nodes: ['0', 'A'],
      components: [
        { id: 'V', type: 'voltage_source', positiveNode: 'A', negativeNode: '0', volts: 3 },
        { id: 'R', type: 'resistor', nodeA: 'A', nodeB: '0', ohms: 100 },
      ],
    };
    expect(solveDcCircuit(c).nodeVoltages['GND']).toBe(0);
  });

  it('rejects duplicate ids, bad values, self-loops, and unknown nodes', () => {
    const dup: Circuit = { ...good, components: [...good.components, { ...good.components[0]! }] };
    expect(() => validateCircuit(dup)).toThrow(/duplicate/i);
    for (const ohms of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        validateCircuit({
          nodes: ['GND', 'A'],
          components: [{ id: 'R', type: 'resistor', nodeA: 'A', nodeB: 'GND', ohms }],
        }),
      ).toThrow(/ohms/);
    }
    expect(() =>
      validateCircuit({
        nodes: ['GND', 'A'],
        components: [{ id: 'V', type: 'voltage_source', positiveNode: 'A', negativeNode: 'GND', volts: Number.NaN }],
      }),
    ).toThrow(/volts/);
    expect(() =>
      validateCircuit({
        nodes: ['GND', 'A'],
        components: [{ id: 'R', type: 'resistor', nodeA: 'A', nodeB: 'A', ohms: 10 }],
      }),
    ).toThrow(/self-loop/);
    expect(() =>
      validateCircuit({
        nodes: ['GND', 'A'],
        components: [{ id: 'R', type: 'resistor', nodeA: 'A', nodeB: 'ZZZ', ohms: 10 }],
      }),
    ).toThrow(/undeclared/);
  });

  it('detects floating subcircuits with no DC path to ground', () => {
    // A lone current source cannot reference its island: A/B stay floating.
    expect(() =>
      solveDcCircuit({
        nodes: ['GND', 'A', 'B'],
        components: [
          { id: 'I', type: 'current_source', fromNode: 'GND', toNode: 'A', amps: 0.001 },
          { id: 'R', type: 'resistor', nodeA: 'A', nodeB: 'B', ohms: 100 },
        ],
      }),
    ).toThrow(/floating/i);
  });

  it('throws on parallel conflicting ideal voltage sources (singular MNA)', () => {
    expect(() =>
      solveDcCircuit({
        nodes: ['GND', 'X'],
        components: [
          { id: 'V1', type: 'voltage_source', positiveNode: 'X', negativeNode: 'GND', volts: 5 },
          { id: 'V2', type: 'voltage_source', positiveNode: 'X', negativeNode: 'GND', volts: 3 },
        ],
      }),
    ).toThrow(/singular/i);
    expect(solveLinearSystem([[1, 1], [1, 1]], [2, 2])).toBeNull();
  });

  it('measures open circuits as Infinity without crashing', () => {
    const r = measureEffectiveResistance(seriesDivider(), 'TOP', 'MID', undefined, {
      supplyMode: 'unpowered_unplugged',
    });
    // TOP island keeps R1 to MID: connected; MID↔TOP = R1 = 1k.
    expect(r.ohms).toBeCloseTo(1000, 6);
    const island: Circuit = {
      nodes: ['GND', 'A', 'B', 'C'],
      components: [
        { id: 'V', type: 'voltage_source', positiveNode: 'A', negativeNode: 'GND', volts: 5 },
        { id: 'R1', type: 'resistor', nodeA: 'A', nodeB: 'GND', ohms: 100 },
        { id: 'R2', type: 'resistor', nodeA: 'B', nodeB: 'C', ohms: 100 },
        { id: 'R3', type: 'resistor', nodeA: 'C', nodeB: 'GND', ohms: 100 },
      ],
    };
    // B-C share R2: connected (100Ω).
    expect(measureEffectiveResistance(island, 'B', 'C').ohms).toBeCloseTo(100, 6);
    // A node with no passive path to the other probe reads OL cleanly.
    const lonely: Circuit = {
      nodes: ['GND', 'A', 'B'],
      components: [
        { id: 'V', type: 'voltage_source', positiveNode: 'A', negativeNode: 'GND', volts: 5 },
        { id: 'R', type: 'resistor', nodeA: 'A', nodeB: 'GND', ohms: 100 },
      ],
    };
    const open = measureEffectiveResistance(lonely, 'A', 'B');
    expect(open.ohms).toBe(Number.POSITIVE_INFINITY);
    expect(open.continuous).toBe(false);
    expect(open.formatted).toMatch(/OL|open/i);
  });

  it('rejects unknown nodes/components and self probe pairs', () => {
    const s = solveDcCircuit(seriesDivider());
    expect(() => measureNodeVoltage(s, 'NOPE')).toThrow(CircuitSolverError);
    expect(() => measureBranchCurrent(s, 'NOPE')).toThrow(CircuitSolverError);
    expect(() => measureEffectiveResistance(seriesDivider(), 'MID', 'MID')).toThrow();
    expect(() => measureEffectiveResistance(seriesDivider(), 'MID', 'ZZZ')).toThrow(/unknown/i);
  });
});

describe('solver scope metadata', () => {
  it('documents a linear-DC MNA engine, not a full SPICE simulator', () => {
    expect(SIMULATOR_CAPABILITIES.solver).toMatch(/Modified Nodal Analysis/);
    expect(SIMULATOR_CAPABILITIES.limitations.join(' ')).toMatch(/Newton-Raphson/);
    expect(SIMULATOR_CAPABILITIES.limitations.join(' ')).toMatch(/AC sweep/);
  });
});

describe('reference virtual boards', () => {
  it('ships 3 boards with 9 fault scenarios across 5 fault classes', () => {
    expect(REFERENCE_BOARD_IDS.sort()).toEqual(['esp32s3-sensor-node', 'f405-flight-controller', 'usbc-pd-trigger']);
    expect(listReferenceBoards()).toHaveLength(3);
    const faults = listReferenceBoards().flatMap((b) => b.faults);
    expect(faults).toHaveLength(9);
    expect(new Set(faults.map((f) => f.faultType)).size).toBeGreaterThanOrEqual(3);
    for (const b of listReferenceBoards()) {
      expect(b.faults.length).toBeGreaterThanOrEqual(2);
      // Every nominal and faulted circuit must validate and solve.
      expect(() => solveDcCircuit(b.nominal)).not.toThrow();
      for (const f of b.faults) {
        expect(f.boardId).toBe(b.boardId);
        expect(() => solveDcCircuit(b.nominal, f)).not.toThrow();
        expect(getFaultScenario(b.boardId, f.faultId)).toBe(f);
      }
    }
  });

  it('f405 nominal matches the analytical divider (3.267V rail)', () => {
    const b = getReferenceBoard('f405-flight-controller')!;
    const s = solveDcCircuit(b.nominal);
    const rPar = 1 / (1 / 1000 + 1 / (40_000 + 4_700_000));
    const v14 = 3.3 * rPar / (10 + rPar);
    expect(s.nodeVoltages['U1-14']).toBeCloseTo(v14, 9);
    expect(s.nodeVoltages['U1-15']).toBeCloseTo(v14 * 4_700_000 / 4_740_000, 9);
  });

  it('f405 solder splash pulls NRST to ~33µV with a 0.4Ω beep to GND', () => {
    const b = getReferenceBoard('f405-flight-controller')!;
    const f = getFaultScenario('f405-flight-controller', 'f405-nrst-gnd-short')!;
    const s = solveDcCircuit(b.nominal, f);
    expect(s.nodeVoltages['U1-15']).toBeLessThan(1e-3);
    expect(s.nodeVoltages['U1-15']).toBeGreaterThanOrEqual(0);
    const cont = measureEffectiveResistance(b.nominal, 'U1-15', 'GND', f);
    expect(cont.continuous).toBe(true);
    expect(cont.ohms).toBeLessThan(0.5);
  });

  it('f405 open pull-up collapses NRST through leakage; drift sags the divider', () => {
    const b = getReferenceBoard('f405-flight-controller')!;
    const open = solveDcCircuit(b.nominal, getFaultScenario('f405-flight-controller', 'f405-pullup-open'));
    expect(open.nodeVoltages['U1-15']).toBeLessThan(0.05);
    expect(open.nodeVoltages['U1-15']).toBeGreaterThan(0.005);
    const drift = solveDcCircuit(b.nominal, getFaultScenario('f405-flight-controller', 'f405-pullup-drift'));
    const nominal = solveDcCircuit(b.nominal);
    expect(drift.nodeVoltages['U1-15']!).toBeLessThan(nominal.nodeVoltages['U1-15']! - 0.1);
  });

  it('esp32 reversed tantalum sags 5V to ~4.2V by nodal analysis', () => {
    const b = getReferenceBoard('esp32s3-sensor-node')!;
    const f = getFaultScenario('esp32s3-sensor-node', 'esp32-c4-rev-leak')!;
    const s = solveDcCircuit(b.nominal, f);
    const g = 1 / 0.5 + 1 / 56 + 1 / 30_000 + 1 / 2.75;
    expect(s.nodeVoltages['TP_5V']).toBeCloseTo(10 / g, 6);
    expect(s.nodeVoltages['TP_5V']).toBeGreaterThan(4.1);
    expect(s.nodeVoltages['TP_5V']).toBeLessThan(4.3);
    expect(s.nodeVoltages['U2-OUT']).toBeCloseTo((10 / g) * (20 / 30), 6);
  });

  it('esp32 blown fuse kills the rail; divider drift shifts only the sense node', () => {
    const b = getReferenceBoard('esp32s3-sensor-node')!;
    const blown = solveDcCircuit(b.nominal, getFaultScenario('esp32s3-sensor-node', 'esp32-f1-blown'));
    expect(blown.nodeVoltages['TP_5V']).toBeLessThan(1e-3);
    const drift = solveDcCircuit(b.nominal, getFaultScenario('esp32s3-sensor-node', 'esp32-div-drift'));
    const nominal = solveDcCircuit(b.nominal);
    expect(Math.abs(drift.nodeVoltages['TP_5V']! - nominal.nodeVoltages['TP_5V']!)).toBeLessThan(0.01);
    expect(drift.nodeVoltages['U2-OUT']).toBeCloseTo(drift.nodeVoltages['TP_5V']! / 2, 6);
  });

  it('usbc shorted TVS clamps CC1 while the CC2 control stays healthy', () => {
    const b = getReferenceBoard('usbc-pd-trigger')!;
    const s = solveDcCircuit(b.nominal, getFaultScenario('usbc-pd-trigger', 'usbc-d2-shorted'));
    expect(s.nodeVoltages['CC1']).toBeLessThan(1e-3);
    expect(s.nodeVoltages['CC2']).toBeCloseTo(0.417, 2);
    const cont = measureEffectiveResistance(b.nominal, 'CC1', 'GND', getFaultScenario('usbc-pd-trigger', 'usbc-d2-shorted'));
    expect(cont.continuous).toBe(true);
  });

  it('usbc open pull-up reads 0V but ~5.1kΩ (distinguishable from the short)', () => {
    const b = getReferenceBoard('usbc-pd-trigger')!;
    const f = getFaultScenario('usbc-pd-trigger', 'usbc-cc1-pu-open')!;
    const s = solveDcCircuit(b.nominal, f);
    expect(s.nodeVoltages['CC1']).toBeLessThan(1e-3);
    const cont = measureEffectiveResistance(b.nominal, 'CC1', 'GND', f);
    expect(cont.continuous).toBe(false);
    expect(cont.ohms).toBeCloseTo(1 / (1 / 5100 + 1 / 10_000_000), -2);
    const drift = solveDcCircuit(b.nominal, getFaultScenario('usbc-pd-trigger', 'usbc-rd-drift'));
    expect(drift.nodeVoltages['CC1']!).toBeGreaterThan(2.0);
  });
});

describe('virtual sessions and ground-truth isolation', () => {
  const truth = getFaultScenario('esp32s3-sensor-node', 'esp32-c4-rev-leak')!;

  it('creates nominal, named, and random sessions with hidden faults', () => {
    expect(createVirtualSession('esp32s3-sensor-node', 'nominal').getGroundTruth()).toBeNull();
    const named = createVirtualSession('esp32s3-sensor-node', 'esp32-c4-rev-leak');
    expect(named.getGroundTruth()?.faultId).toBe('esp32-c4-rev-leak');
    const random = createVirtualSession('esp32s3-sensor-node', 'random');
    expect(random.getGroundTruth()?.boardId).toBe('esp32s3-sensor-node');
    expect(() => createVirtualSession('nope', 'nominal')).toThrow(CircuitSolverError);
    expect(() => createVirtualSession('esp32s3-sensor-node', 'nope')).toThrow(CircuitSolverError);
  });

  it('never exposes faulted values or ids in the agent view', () => {
    const session = createVirtualSession('esp32s3-sensor-node', 'esp32-c4-rev-leak');
    const view = session.getAgentView();
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('esp32-c4-rev-leak');
    expect(serialized).not.toContain('2.75');
    expect(serialized).not.toContain('targetComponentRef');
    expect(serialized).not.toContain('faultSummary');
    expect(() => assertGroundTruthIsolated(view, session.getGroundTruth())).not.toThrow();
    expect(() =>
      assertGroundTruthIsolated({ agentView: view, tools: VIRTUAL_LAB_TOOL_DEFINITIONS }, session.getGroundTruth()),
    ).not.toThrow();
  });

  it('assertGroundTruthIsolated throws on leaked keys or fault-id values', () => {
    const payload = { hiddenFault: truth, notes: 'oops' };
    expect(() => assertGroundTruthIsolated(payload, truth)).toThrow(/hiddenFault/);
    expect(() => assertGroundTruthIsolated({ faultId: truth.faultId }, truth)).toThrow(/fault/i);
    expect(() => assertGroundTruthIsolated({ deep: [{ targetComponentRef: 'C4' }] }, truth)).toThrow(/targetComponentRef/);
    expect(() => assertGroundTruthIsolated({ note: `see ${truth.faultId} details` }, truth)).toThrow(/fault-id/);
    expect(() => assertGroundTruthIsolated({ benign: true }, null)).not.toThrow();
  });

  it('session probing logs evidence and enforces the tool budget', () => {
    const session = createVirtualSession('usbc-pd-trigger', 'usbc-d2-shorted', { maxToolCalls: 3 });
    expect(session.maxToolCalls).toBe(3);
    const v = session.measureVoltage('CC1');
    expect(v.volts).toBeLessThan(1e-3);
    session.measureContinuity('CC1', 'GND');
    session.measureVoltage('CC2');
    expect(session.getToolCallsUsed()).toBe(3);
    expect(() => session.measureVoltage('CC1')).toThrow(/budget/);
    const log = session.getProbeLog();
    expect(log.filter((p) => p.abnormal).length).toBeGreaterThanOrEqual(1);
    expect(MAX_TOOL_CALLS).toBe(8);
  });

  it('applyFaultToCircuit is pure and rejects bad modifications', () => {
    const b = getReferenceBoard('f405-flight-controller')!;
    const before = JSON.stringify(b.nominal);
    applyFaultToCircuit(b.nominal, b.faults[0]!);
    expect(JSON.stringify(b.nominal)).toBe(before);
    const bad: HiddenFault = { ...b.faults[0]!, modification: { kind: 'override_resistance', componentId: 'MISSING', ohms: 1 } };
    expect(() => applyFaultToCircuit(b.nominal, bad)).toThrow(CircuitSolverError);
  });
});

describe('objective diagnosis scoring', () => {
  const truth = getFaultScenario('f405-flight-controller', 'f405-nrst-gnd-short')!;
  const goodLog = [
    { kind: 'voltage' as const, target: 'U1-15', abnormal: true, detail: '0.000 V vs nominal 3.240 V' },
    { kind: 'resistance' as const, target: 'U1-15↔GND', abnormal: true, detail: '0.400 Ω' },
  ];

  it('rewards accurate, measurement-backed diagnosis with 100', () => {
    const s = scoreDiagnosis({ componentRef: 'U1', faultType: 'solder_bridge', verificationStatus: 'confirmed' }, truth, goodLog);
    expect(s.componentMatch).toBe(true);
    expect(s.faultTypeMatch).toBe(true);
    expect(s.evidenceConfirmed).toBe(true);
    expect(s.probeCount).toBe(2);
    expect(s.efficiencyScore).toBe(100);
    expect(s.totalScore).toBe(100);
  });

  it('caps unverified guessing at 45 even when component and type match', () => {
    const s = scoreDiagnosis({ componentRef: 'U1', faultType: 'solder_bridge', verificationStatus: 'hypothesis' }, truth, []);
    expect(s.evidenceConfirmed).toBe(false);
    expect(s.totalScore).toBeLessThanOrEqual(45);
  });

  it('penalizes wrong components and rewards compatible fault classes', () => {
    const wrong = scoreDiagnosis({ componentRef: 'C7', faultType: 'solder_bridge', verificationStatus: 'confirmed' }, truth, goodLog);
    expect(wrong.componentMatch).toBe(false);
    expect(wrong.totalScore).toBeLessThan(100);
    const compat = scoreDiagnosis(
      { componentRef: 'U1', faultType: 'shorted_component', verificationStatus: 'confirmed' },
      truth,
      goodLog,
    );
    expect(compat.faultTypeMatch).toBe(true);
    const driftTruth = getFaultScenario('f405-flight-controller', 'f405-pullup-drift')!;
    const strict = scoreDiagnosis(
      { componentRef: 'R_PULLUP', faultType: 'open_circuit', verificationStatus: 'confirmed' },
      driftTruth,
      [{ kind: 'voltage', target: 'U1-15', abnormal: true }],
    );
    expect(strict.faultTypeMatch).toBe(false);
  });

describe('AI transparency modes (OperationalMode)', () => {
  it('keeps the legacy 4-tool schema set untouched and adds MNA tools separately', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      'check_continuity',
      'generate_rework_guidance',
      'lookup_pinout',
      'verify_rail_voltage',
    ]);
    const names = VIRTUAL_LAB_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain('measure_node_voltage');
    expect(names).toContain('measure_branch_current');
    expect(names).toContain('check_continuity');
    expect(ALL_TOOL_DEFINITIONS.map((t) => t.name)).toContain('measure_node_voltage');
    const nodeTool = VIRTUAL_LAB_TOOL_DEFINITIONS.find((t) => t.name === 'measure_node_voltage')!;
    expect(nodeTool.parameters.required).toEqual(['node']);
    expect(
      defaultSimulatedToolResult('measure_node_voltage', { node: 'U1-15' }) as { node: unknown },
    ).toMatchObject({ node: 'U1-15' });
  });

  it('reports SIMULATED / STATIC_FIXTURE in mock mode', () => {
    const client = new MetaClient({ mode: 'simulated' });
    expect(client.status()).toMatchObject({ sparkMode: 'SIMULATED', samMode: 'STATIC_FIXTURE' });
  });

  it('reports UNVERIFIED in live mode and LIVE_API only after a verified response', async () => {
    const client = new MetaClient({
      mode: 'live',
      apiKey: 'test-key',
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }) }),
    });
    expect(client.status()).toMatchObject({ sparkMode: 'UNVERIFIED', liveVerified: false });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(client.status()).toMatchObject({ sparkMode: 'LIVE_API', samMode: 'LIVE_API', liveVerified: true });
  });

  it('reports UNAVAILABLE in live mode with no key and no proxy', () => {
    const client = new MetaClient({ mode: 'live', proxyBaseUrl: undefined });
    expect(client.status()).toMatchObject({ sparkMode: 'UNAVAILABLE', samMode: 'UNAVAILABLE' });
  });

  it('never sends an Authorization header from browser live mode (proxy route)', async () => {
    const g = globalThis as Record<string, unknown>;
    const hadWindow = g['window'];
    g['window'] = {};
    try {
      const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
      const client = new MetaClient({
        mode: 'live',
        fetchFn: async (url, init) => {
          calls.push({ url, headers: init.headers, body: init.body ?? '' });
          return { ok: true, status: 200, json: async () => ({ content: 'proxied', toolCalls: [] }) };
        },
      });
      expect(client.usesProxyRoute()).toBe(true);
      const res = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(res.content).toBe('proxied');
      expect(calls[0]!.url).toBe('/api/meta/chat');
      expect(calls[0]!.headers['Authorization']).toBeUndefined();
      expect(calls[0]!.body).not.toContain('META_API_KEY');
      expect(client.status().sparkMode).toBe('LIVE_API');
    } finally {
      if (hadWindow === undefined) delete g['window'];
      else g['window'] = hadWindow;
    }
  });

  it('browser proxy surfaces the 503 zero-cost message when the key is missing', async () => {
    const g = globalThis as Record<string, unknown>;
    const hadWindow = g['window'];
    g['window'] = {};
    try {
      const client = new MetaClient({
        mode: 'live',
        fetchFn: async () => ({ ok: false, status: 503, json: async () => ({ error: PROXY_KEY_MISSING_MESSAGE }) }),
      });
      await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
        /not configured on the local server proxy/,
      );
      expect(client.status().sparkMode).toBe('UNVERIFIED');
    } finally {
      if (hadWindow === undefined) delete g['window'];
      else g['window'] = hadWindow;
    }
  });
});

describe('server proxy key boundary', () => {
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      end(b: string) {
        this.body = b;
      },
    };
  }

  it('reports UNCONFIGURED status without a key and never echoes it', async () => {
    const res = fakeRes();
    const handled = await handleMetaProxyRequest({ method: 'GET', url: '/api/meta/status' }, res, {
      getApiKey: () => undefined,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ configured: false, mode: 'UNAVAILABLE' });
    expect(res.body).not.toContain('META_API_KEY');
  });

  it('answers 503 with the zero-cost message when the key is missing', async () => {
    const res = fakeRes();
    await handleMetaProxyRequest({ method: 'POST', url: '/api/meta/chat', body: { messages: [] } }, res, {
      getApiKey: () => undefined,
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: PROXY_KEY_MISSING_MESSAGE });
  });

  it('forwards chat with a server-side Bearer [REDACTED] and strips the key from responses', async () => {
    const secret = 'sk-live-abc123';
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const res = fakeRes();
    await handleMetaProxyRequest(
      { method: 'POST', url: '/api/meta/chat', body: { model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'hi' }] } },
      res,
      {
        getApiKey: () => secret,
        fetchFn: async (url, init) => {
          seen.push({ url, headers: init.headers });
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'live!', tool_calls: [] } }] }) };
        },
      },
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ content: 'live!', toolCalls: [] });
    expect(res.body).not.toContain(secret);
    expect(seen[0]!.headers['Authorization']).toBe(`Bearer ${secret}`);
  });

  it('ignores non-proxy paths so other middleware runs', async () => {
    const res = fakeRes();
    const handled = await handleMetaProxyRequest({ method: 'GET', url: '/other/path' }, res, {
      getApiKey: () => undefined,
    });
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});

describe('objective diagnosis scoring (efficiency)', () => {
  const truth = getFaultScenario('f405-flight-controller', 'f405-nrst-gnd-short')!;
  const goodLog = [
    { kind: 'voltage' as const, target: 'U1-15', abnormal: true, detail: '0.000 V vs nominal 3.240 V' },
    { kind: 'resistance' as const, target: 'U1-15↔GND', abnormal: true, detail: '0.400 Ω' },
  ];

  it('discounts redundant probing via the efficiency score', () => {
    const bloated = [...goodLog, ...goodLog, ...goodLog, ...goodLog, ...goodLog];
    const s = scoreDiagnosis({ componentRef: 'U1', faultType: 'solder_bridge', verificationStatus: 'confirmed' }, truth, bloated);
    expect(s.efficiencyScore).toBeLessThan(100);
    expect(s.totalScore).toBeLessThan(100);
  });
}); // closes describe('objective diagnosis scoring (efficiency)')
}); // closes describe('objective diagnosis scoring')
