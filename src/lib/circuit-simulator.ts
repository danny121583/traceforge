/**
 * TraceForge Phase 1.5 — Deterministic Linear DC Modified Nodal Analysis (MNA)
 * Circuit Engine & Hardware-Free Virtual Circuit Laboratory.
 *
 * # Scope
 * This engine is a **Linear DC Modified Nodal Analysis (MNA) solver** for
 * passive resistive networks with independent DC sources:
 * - Resistors (`R`): linear Ohmic branches.
 * - Independent DC voltage sources (`V`): ideal, zero series impedance.
 * - Independent DC current sources (`I`): ideal, infinite parallel impedance.
 *
 * Linearized DC fault models ARE supported, because each reduces to a
 * resistive perturbation of the network:
 * - Shorted diode  → low-value fault resistance `R_short` shunting the branch.
 * - Reverse-polarized leaking tantalum capacitor → DC leakage resistance
 *   `R_leak` from the rail to ground (capacitors are DC opens; leakage is resistive).
 * - Solder bridge → low-value `R_bridge` between the bridged nodes.
 * - Open trace / open component → `R_open = 1e9 Ω` (branch kept so the MNA
 *   matrix stays non-singular; a removed branch on a dangling node would be
 *   a genuinely floating node, which is rejected as unsolvable).
 * - Parameter drift → altered resistance `R_drift`.
 *
 * # Explicit limitations (NOT a full SPICE simulator)
 * - No nonlinear devices: no Newton-Raphson iteration, no exponential
 *   diode/transistor I-V curves. Semiconductors appear only through the
 *   linearized fault resistances above.
 * - No time-domain behavior: no `C dV/dt` / `L dI/dt` integration, no
 *   transient or switching analysis. All capacitors/inductors are treated
 *   at DC steady state (C = open, L = short must be modeled by the caller
 *   as explicit resistors).
 * - No frequency-domain AC sweep, no noise analysis, no temperature effects.
 * - Ideal independent sources only (no dependent sources, no current limits,
 *   no regulator dropout/foldback — an LDO is modeled as an ideal source
 *   plus an explicit series source resistance when sag matters).
 *
 * # Sign conventions
 * - `nodeVoltages[node]` is the DC potential of `node` relative to ground.
 * - Resistor branch current is `(V(nodeA) - V(nodeB)) / R`: positive means
 *   conventional current flows from `nodeA` to `nodeB`.
 * - Voltage-source branch current is the MNA current variable: positive means
 *   conventional current flows from `positiveNode` to `negativeNode`
 *   *through the source* (i.e. the source absorbs `V * I` watts when positive).
 * - Current-source branch current is exactly `amps`, flowing `fromNode → toNode`.
 * - Resistor power is `I²·R` (always ≥ 0, dissipated). Source power is
 *   `V·I` absorbed (negative ⇒ the source delivers power).
 *
 * # Ground-truth isolation
 * A `VirtualLabSession` exposes only an `AgentCircuitView` (nominal values,
 * node names, symptoms) to the diagnostic agent. The `HiddenFault` (fault id,
 * target ref, faulted values) never enters that view; `assertGroundTruthIsolated`
 * verifies this before any payload is sent to Muse Spark 1.3.
 */

import { validateProbePair } from './electrical';

export const SIMULATOR_CAPABILITIES = {
  solver: 'Linear DC Modified Nodal Analysis (MNA)',
  supports: ['resistor (R)', 'independent DC voltage source (V)', 'independent DC current source (I)'],
  faultModels: [
    'shorted_component as R_short',
    'reverse_polarity_leakage as R_leak to GND',
    'solder_bridge as R_bridge between nodes',
    'open_circuit as R_open = 1e9 Ω',
    'parameter_drift as altered R_drift',
  ],
  limitations: [
    'No nonlinear Newton-Raphson diode/transistor I-V curves.',
    'No time-domain C dV/dt or L dI/dt integration.',
    'No frequency-domain AC sweep.',
    'Ideal independent sources only (no dependent sources, no current limits).',
  ],
} as const;

/** Thrown for every invalid circuit, singular matrix, or isolation breach. */
export class CircuitSolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitSolverError';
  }
}

/** Minimum absolute pivot accepted during elimination (below ⇒ singular). */
export const SINGULAR_PIVOT_TOLERANCE = 1e-12;
/** Resistance substituted for an open-circuited component (keeps MNA solvable). */
export const R_OPEN_OHMS = 1e9;
/** Resistance used to model an ideal shorted voltage source ("kill sources"). */
export const R_SHORTED_SOURCE_OHMS = 1e-6;
/** Continuity beep threshold for the virtual ohmmeter (matches DMM practice). */
export const CONTINUITY_THRESHOLD_OHMS = 2.0;

export interface ResistorComponent {
  id: string;
  type: 'resistor';
  nodeA: string;
  nodeB: string;
  ohms: number;
  description?: string;
}

export interface VoltageSourceComponent {
  id: string;
  type: 'voltage_source';
  positiveNode: string;
  negativeNode: string;
  volts: number;
  description?: string;
}

export interface CurrentSourceComponent {
  id: string;
  type: 'current_source';
  fromNode: string;
  toNode: string;
  amps: number;
  description?: string;
}

export type CircuitComponent = ResistorComponent | VoltageSourceComponent | CurrentSourceComponent;

export interface Circuit {
  id?: string;
  name?: string;
  /** All node identifiers referenced by components, including ground. */
  nodes: string[];
  components: CircuitComponent[];
}

export interface DcSolution {
  /** Node potentials vs ground, including `GND: 0`. */
  nodeVoltages: Record<string, number>;
  /** Branch current per component id (amps; see sign conventions above). */
  branchCurrents: Record<string, number>;
  /** Absorbed/dissipated power per component id (watts). */
  componentPowerWatts: Record<string, number>;
}

/** Canonical ground node. `'0'` (SPICE convention) is accepted as an alias. */
export const GROUND_NODE = 'GND';

function canonicalNode(node: string): string {
  return node === '0' ? GROUND_NODE : node;
}

/** Terminals of a component as (nodeA, nodeB) pairs for generic handling. */
function componentTerminals(c: CircuitComponent): [string, string] {
  if (c.type === 'resistor') return [c.nodeA, c.nodeB];
  if (c.type === 'voltage_source') return [c.positiveNode, c.negativeNode];
  return [c.fromNode, c.toNode];
}

export interface ValidatedCircuit {
  ground: string;
  /** Non-ground node list in matrix order. */
  orderedNodes: string[];
  nodeSet: Set<string>;
}

/**
 * Strictly validate a circuit definition. Rejects empty circuits, a missing
 * ground reference, duplicate ids, non-finite / non-positive resistances,
 * non-finite source values, self-loops, undeclared nodes, and floating
 * subcircuits with no DC conductive path (through resistors or voltage
 * sources — ideal current sources are open circuits for this check) back
 * to the ground reference.
 */
export function validateCircuit(circuit: Circuit): ValidatedCircuit {
  if (!circuit || !Array.isArray(circuit.nodes) || circuit.nodes.length === 0) {
    throw new CircuitSolverError('Invalid circuit: `nodes` must be a non-empty array.');
  }
  if (!Array.isArray(circuit.components) || circuit.components.length === 0) {
    throw new CircuitSolverError('Invalid circuit: `components` must be a non-empty array.');
  }
  const declared = new Set(circuit.nodes.map((n) => canonicalNode(String(n))));
  const hasGnd = circuit.nodes.some((n) => n === GROUND_NODE || n === '0');
  if (!hasGnd) {
    throw new CircuitSolverError(
      `Invalid circuit: an explicit reference ground node ('${GROUND_NODE}' or '0') is required.`,
    );
  }
  checkComponentValues(circuit.components, declared);

  // Floating-node detection: union-find over DC-conductive branches
  // (resistors + voltage sources). Current sources are DC opens.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let cur = x;
    while (parent.get(cur) !== r) {
      const nxt = parent.get(cur) as string;
      parent.set(cur, r);
      cur = nxt;
    }
    return r;
  };
  for (const n of declared) parent.set(n, n);
  for (const c of circuit.components) {
    if (c.type === 'current_source') continue;
    const [rawA, rawB] = componentTerminals(c);
    const a = canonicalNode(rawA);
    const b = canonicalNode(rawB);
    parent.set(find(a), find(b));
  }
  const groundRoot = find(GROUND_NODE);
  const floating = [...declared].filter((n) => n !== GROUND_NODE && find(n) !== groundRoot);
  if (floating.length > 0) {
    throw new CircuitSolverError(
      `Invalid circuit: floating node(s) [${floating.join(', ')}] have no DC conductive path to '${GROUND_NODE}'. ` +
        'Add a resistive path, a voltage-source reference, or remove the disconnected subcircuit.',
    );
  }
  return {
    ground: GROUND_NODE,
    orderedNodes: [...declared].filter((n) => n !== GROUND_NODE),
    nodeSet: declared,
  };
}

/**
 * Solve a dense linear system `A·x = z` by Gaussian elimination with partial
 * pivoting. Returns `null` when a pivot magnitude falls below
 * `SINGULAR_PIVOT_TOLERANCE` (singular matrix: floating node or conflicting
 * ideal-voltage loop).
 */
export function solveLinearSystem(a: number[][], z: number[]): number[] | null {
  const n = z.length;
  const m = a.map((row) => [...row]);
  const b = [...z];
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < SINGULAR_PIVOT_TOLERANCE) return null;
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
      const tb = b[col]!;
      b[col] = b[pivot]!;
      b[pivot] = tb;
    }
    const inv = 1 / m[col]![col]!;
    for (let r = col + 1; r < n; r += 1) {
      const factor = m[r]![col]! * inv;
      if (factor === 0) continue;
      for (let k = col; k < n; k += 1) m[r]![k]! -= factor * m[col]![k]!;
      b[r]! -= factor * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = b[r]!;
    for (let k = r + 1; k < n; k += 1) sum -= m[r]![k]! * x[k]!;
    const diag = m[r]![r]!;
    if (Math.abs(diag) < SINGULAR_PIVOT_TOLERANCE) return null;
    x[r] = sum / diag;
  }
  return x;
}

interface MnaBuild {
  orderedNodes: string[];
  voltageSources: VoltageSourceComponent[];
  a: number[][];
  z: number[];
}

/** Assemble the standard (N+M)×(N+M) MNA system `A·x = z`. */
function buildMnaSystem(components: CircuitComponent[], orderedNodes: string[]): MnaBuild {
  const n = orderedNodes.length;
  const index = new Map(orderedNodes.map((node, i) => [node, i]));
  const voltageSources = components.filter(
    (c): c is VoltageSourceComponent => c.type === 'voltage_source',
  );
  const m = voltageSources.length;
  const size = n + m;
  const a: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const z = new Array<number>(size).fill(0);

  for (const c of components) {
    if (c.type === 'resistor') {
      const g = 1 / c.ohms;
      const i = index.get(canonicalNode(c.nodeA));
      const j = index.get(canonicalNode(c.nodeB));
      if (i !== undefined) a[i]![i]! += g;
      if (j !== undefined) a[j]![j]! += g;
      if (i !== undefined && j !== undefined) {
        a[i]![j]! -= g;
        a[j]![i]! -= g;
      }
    } else if (c.type === 'current_source') {
      // `amps` flows fromNode → toNode: leaves `from`, enters `to`.
      const from = index.get(canonicalNode(c.fromNode));
      const to = index.get(canonicalNode(c.toNode));
      if (from !== undefined) z[from]! -= c.amps;
      if (to !== undefined) z[to]! += c.amps;
    }
  }
  voltageSources.forEach((vs, k) => {
    const p = index.get(canonicalNode(vs.positiveNode));
    const neg = index.get(canonicalNode(vs.negativeNode));
    if (p !== undefined) {
      a[p]![n + k]! += 1;
      a[n + k]![p]! += 1;
    }
    if (neg !== undefined) {
      a[neg]![n + k]! -= 1;
      a[n + k]![neg]! -= 1;
    }
    z[n + k] = vs.volts;
  });
  return { orderedNodes, voltageSources, a, z };
}

/**
 * Internal MNA solve against an arbitrary reference node (used by the
 * unpowered ohmmeter, where the probe tip becomes the 0 V reference).
 * Unlike `solveDcCircuit`, no ground-connectivity is required — an island
 * floating from `GND` is perfectly measurable differentially. Returns `null`
 * on invalid input (handled by the caller) or a singular system.
 */
function solveWithReference(circuit: Circuit, reference: string): DcSolution | null {
  if (!circuit || !Array.isArray(circuit.nodes) || !Array.isArray(circuit.components)) return null;
  const ref = canonicalNode(reference);
  const declared = new Set(circuit.nodes.map((n) => canonicalNode(String(n))));
  if (!declared.has(ref)) return null;
  try {
    checkComponentValues(circuit.components, declared);
  } catch {
    return null;
  }
  const orderedNodes = [...declared].filter((n) => n !== ref);
  const { a, z, voltageSources } = buildMnaSystem(circuit.components, orderedNodes);
  const x = solveLinearSystem(a, z);
  if (!x) return null;
  const nodeVoltages: Record<string, number> = { [ref]: 0 };
  orderedNodes.forEach((node, i) => {
    nodeVoltages[node] = x[i]!;
  });
  const branchCurrents: Record<string, number> = {};
  const componentPowerWatts: Record<string, number> = {};
  voltageSources.forEach((vs, k) => {
    const current = x[orderedNodes.length + k]!;
    branchCurrents[vs.id] = current;
    componentPowerWatts[vs.id] = vs.volts * current;
  });
  const vOf = (n: string): number => {
    const c = canonicalNode(n);
    return c === ref ? 0 : (nodeVoltages[c] ?? 0);
  };
  for (const c of circuit.components) {
    if (c.type === 'resistor') {
      const amps = (vOf(c.nodeA) - vOf(c.nodeB)) / c.ohms;
      branchCurrents[c.id] = amps;
      componentPowerWatts[c.id] = amps * amps * c.ohms;
    } else if (c.type === 'current_source') {
      branchCurrents[c.id] = c.amps;
      componentPowerWatts[c.id] = (vOf(c.fromNode) - vOf(c.toNode)) * c.amps;
    }
  }
  return { nodeVoltages, branchCurrents, componentPowerWatts };
}

/** Shared per-component value checks (ids, terminals, finite values, loops). */
function checkComponentValues(components: CircuitComponent[], declared: Set<string>): void {
  const seen = new Set<string>();
  for (const c of components) {
    if (!c || typeof c.id !== 'string' || !c.id) {
      throw new CircuitSolverError('Invalid circuit: every component needs a non-empty string `id`.');
    }
    if (seen.has(c.id)) throw new CircuitSolverError(`Invalid circuit: duplicate component id '${c.id}'.`);
    seen.add(c.id);
    const [rawA, rawB] = componentTerminals(c);
    const a = canonicalNode(rawA);
    const b = canonicalNode(rawB);
    if (!declared.has(a)) throw new CircuitSolverError(`Invalid circuit: component '${c.id}' references undeclared node '${rawA}'.`);
    if (!declared.has(b)) throw new CircuitSolverError(`Invalid circuit: component '${c.id}' references undeclared node '${rawB}'.`);
    if (a === b) throw new CircuitSolverError(`Invalid circuit: component '${c.id}' is a self-loop on '${rawA}'.`);
    if (c.type === 'resistor') {
      if (!Number.isFinite(c.ohms) || !(c.ohms > 0)) {
        throw new CircuitSolverError(`Invalid circuit: resistor '${c.id}' needs finite ohms > 0 (got ${String(c.ohms)}).`);
      }
    } else if (c.type === 'voltage_source') {
      if (!Number.isFinite(c.volts)) {
        throw new CircuitSolverError(`Invalid circuit: voltage source '${c.id}' needs a finite volts value.`);
      }
    } else if (c.type === 'current_source') {
      if (!Number.isFinite(c.amps)) {
        throw new CircuitSolverError(`Invalid circuit: current source '${c.id}' needs a finite amps value.`);
      }
    } else {
      const unknownId = (c as unknown as { id: unknown }).id;
      const unknownType = (c as unknown as { type: unknown }).type;
      throw new CircuitSolverError(
        `Invalid circuit: component '${String(unknownId)}' has unknown type '${String(unknownType)}'.`,
      );
    }
  }
}

export type FaultModification =
  | { kind: 'bridge_nodes'; nodeA: string; nodeB: string; bridgeOhms: number }
  | { kind: 'override_resistance'; componentId: string; ohms: number }
  | { kind: 'open_component'; componentId: string }
  | { kind: 'shunt_to_gnd'; node: string; shuntOhms: number };

export type FaultType =
  | 'solder_bridge'
  | 'shorted_component'
  | 'open_circuit'
  | 'parameter_drift'
  | 'reverse_polarity_leakage';

export interface HiddenFault {
  faultId: string;
  boardId: string;
  faultType: FaultType;
  targetComponentRef: string;
  description: string;
  modification: FaultModification;
  /** Nodes whose probed values change decisively under this fault. */
  affectedNodes: string[];
}

/**
 * Return a faulted copy of `circuit` with `fault.modification` applied.
 * Pure (no mutation); the result still passes `validateCircuit` for every
 * fault defined in this module.
 */
export function applyFaultToCircuit(circuit: Circuit, fault: HiddenFault): Circuit {
  const copy: Circuit = {
    id: circuit.id,
    name: circuit.name,
    nodes: [...circuit.nodes],
    components: circuit.components.map((c) => ({ ...c }) as CircuitComponent),
  };
  const mod = fault.modification;
  if (mod.kind === 'bridge_nodes') {
    if (!Number.isFinite(mod.bridgeOhms) || !(mod.bridgeOhms > 0)) {
      throw new CircuitSolverError(`Invalid fault '${fault.faultId}': bridgeOhms must be finite > 0.`);
    }
    copy.components.push({
      id: `fault-bridge-${fault.faultId}`,
      type: 'resistor',
      nodeA: mod.nodeA,
      nodeB: mod.nodeB,
      ohms: mod.bridgeOhms,
      description: `Fault ${fault.faultId}: solder bridge`,
    });
  } else if (mod.kind === 'override_resistance') {
    if (!Number.isFinite(mod.ohms) || !(mod.ohms > 0)) {
      throw new CircuitSolverError(`Invalid fault '${fault.faultId}': override ohms must be finite > 0.`);
    }
    const target = copy.components.find((c) => c.id === mod.componentId);
    if (!target || target.type !== 'resistor') {
      throw new CircuitSolverError(`Invalid fault '${fault.faultId}': '${mod.componentId}' is not a resistor.`);
    }
    (target as ResistorComponent).ohms = mod.ohms;
  } else if (mod.kind === 'open_component') {
    const target = copy.components.find((c) => c.id === mod.componentId);
    if (!target || target.type !== 'resistor') {
      throw new CircuitSolverError(`Invalid fault '${fault.faultId}': '${mod.componentId}' is not a resistor.`);
    }
    (target as ResistorComponent).ohms = R_OPEN_OHMS;
  } else {
    if (!Number.isFinite(mod.shuntOhms) || !(mod.shuntOhms > 0)) {
      throw new CircuitSolverError(`Invalid fault '${fault.faultId}': shuntOhms must be finite > 0.`);
    }
    copy.components.push({
      id: `fault-shunt-${fault.faultId}`,
      type: 'resistor',
      nodeA: mod.node,
      nodeB: GROUND_NODE,
      ohms: mod.shuntOhms,
      description: `Fault ${fault.faultId}: leakage shunt to ground`,
    });
  }
  return copy;
}

/**
 * Solve the linear DC operating point of `circuit` (with an optional hidden
 * fault applied first). Throws `CircuitSolverError` on invalid input or on
 * a singular MNA matrix (pivot < 1e-12: floating node, parallel conflicting
 * ideal voltage sources, or a degenerate voltage loop).
 *
 * ---------------------------------------------------------------------------
 * Virtual test-bench probing
 * ---------------------------------------------------------------------------
 */

export function formatSimVolts(v: number): string {
  return `${v.toFixed(3)} V`;
}

export function formatSimAmps(a: number): string {
  const ma = a * 1000;
  return Math.abs(ma) < 1000 ? `${ma.toFixed(3)} mA` : `${a.toFixed(3)} A`;
}

export function formatSimOhms(r: number): string {
  if (!Number.isFinite(r)) return 'OL (open circuit)';
  if (r >= 1_000_000) return `${(r / 1_000_000).toFixed(3)} MΩ`;
  if (r >= 1000) return `${(r / 1000).toFixed(3)} kΩ`;
  return `${r.toFixed(3)} Ω`;
}

export interface NodeVoltageReading {
  node: string;
  refNode: string;
  volts: number;
  formatted: string;
}

/**
 * Virtual voltmeter: `V(node) − V(refNode)` from a solved operating point.
 * Throws `CircuitSolverError` for unknown nodes.
 */
export function measureNodeVoltage(
  solution: DcSolution,
  node: string,
  refNode: string = GROUND_NODE,
): NodeVoltageReading {
  const a = canonicalNode(node);
  const b = canonicalNode(refNode);
  if (!(a in solution.nodeVoltages)) {
    throw new CircuitSolverError(`Unknown measurement node '${node}'.`);
  }
  if (!(b in solution.nodeVoltages)) {
    throw new CircuitSolverError(`Unknown reference node '${refNode}'.`);
  }
  const volts = solution.nodeVoltages[a]! - solution.nodeVoltages[b]!;
  return { node, refNode, volts, formatted: formatSimVolts(volts) };
}

export interface BranchCurrentReading {
  componentId: string;
  amps: number;
  milliamps: number;
  formatted: string;
}

/**
 * Virtual ammeter: branch current through `componentId` (see module sign
 * conventions). Throws `CircuitSolverError` for unknown ids.
 */
export function measureBranchCurrent(solution: DcSolution, componentId: string): BranchCurrentReading {
  if (!(componentId in solution.branchCurrents)) {
    throw new CircuitSolverError(`Unknown component '${componentId}' for branch-current measurement.`);
  }
  const amps = solution.branchCurrents[componentId]!;
  return { componentId, amps, milliamps: amps * 1000, formatted: formatSimAmps(amps) };
}

export type SupplyMode = 'unpowered_unplugged' | 'kill_sources';

export interface EffectiveResistanceReading {
  probeA: string;
  probeB: string;
  ohms: number;
  continuous: boolean;
  formatted: string;
}

/** Union-find connectivity over resistive branches (both ends canonicalized). */
function passiveNodesConnected(components: CircuitComponent[], a: string, b: string): boolean {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let cur = x;
    while (parent.get(cur) !== r) {
      const nxt = parent.get(cur) as string;
      parent.set(cur, r);
      cur = nxt;
    }
    return r;
  };
  const link = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    return find(x);
  };
  for (const c of components) {
    if (c.type !== 'resistor') continue;
    const na = link(canonicalNode(c.nodeA));
    const nb = link(canonicalNode(c.nodeB));
    parent.set(na, nb);
  }
  link(a);
  link(b);
  return find(a) === find(b);
}

/**
 * Virtual DMM ohmmeter / continuity test between two nodes.
 *
 * Mathematically justified unpowered measurement: all independent sources in
 * the (faulted) circuit are deactivated, a 1 A DC test current is injected
 * from `probeB` to `probeA` with `probeB` as the temporary 0 V reference,
 * and `R_eff = V(probeA) − V(probeB)` for `I_test = 1 A`.
 *
 * Deactivation semantics (`supplyMode`):
 * - `'unpowered_unplugged'` (default): every independent voltage AND current
 *   source is open-circuited. This models standard unpowered DMM
 *   continuity/resistance testing with the external supply unplugged: supply
 *   `voltage_source` elements (USB/battery inputs) are disconnected while
 *   on-board passives and fault bridges stay connected.
 * - `'kill_sources'`: voltage sources are replaced by shorts
 *   (`R_SHORTED_SOURCE_OHMS`) and current sources opened (classical
 *   zeroed-source network reduction).
 *
 * Probes in disconnected passive islands return `Infinity` (open circuit)
 * cleanly instead of crashing.
 */
export function measureEffectiveResistance(
  circuit: Circuit,
  probeA: string,
  probeB: string,
  injectedFault?: HiddenFault,
  options?: { supplyMode?: SupplyMode },
): EffectiveResistanceReading {
  const supplyMode = options?.supplyMode ?? 'unpowered_unplugged';
  const working = injectedFault ? applyFaultToCircuit(circuit, injectedFault) : circuit;
  const declared = working.nodes.map((n) => canonicalNode(String(n)));
  validateProbePair(probeA, probeB, declared);
  const a = canonicalNode(probeA.trim());
  const b = canonicalNode(probeB.trim());

  const passive: CircuitComponent[] = [];
  for (const c of working.components) {
    if (c.type === 'resistor') {
      passive.push({ ...c });
    } else if (c.type === 'voltage_source' && supplyMode === 'kill_sources') {
      passive.push({
        id: `${c.id}__shorted`,
        type: 'resistor',
        nodeA: c.positiveNode,
        nodeB: c.negativeNode,
        ohms: R_SHORTED_SOURCE_OHMS,
        description: 'Deactivated (shorted) voltage source for resistance test',
      });
    }
    // Current sources are always opens; voltage sources are opens in
    // `unpowered_unplugged` mode — both are simply omitted.
  }

  // Resistive connectivity between the probes (voltage shorts count as
  // conductive in `kill_sources` mode; the 1e-6 Ω links are real resistors).
  if (!passiveNodesConnected(passive, a, b)) {
    return {
      probeA,
      probeB,
      ohms: Number.POSITIVE_INFINITY,
      continuous: false,
      formatted: formatSimOhms(Number.POSITIVE_INFINITY),
    };
  }
  const testCircuit: Circuit = {
    id: working.id,
    name: working.name,
    nodes: working.nodes,
    components: [
      ...passive,
      { id: '__itest__', type: 'current_source', fromNode: probeB, toNode: probeA, amps: 1 },
    ],
  };
  const solved = solveWithReference(testCircuit, probeB);
  if (!solved) {
    throw new CircuitSolverError(
      `Cannot measure resistance between '${probeA}' and '${probeB}': passive network is singular.`,
    );
  }
  const raw = solved.nodeVoltages[a] ?? Number.NaN;
  if (!Number.isFinite(raw)) {
    throw new CircuitSolverError(`Cannot measure resistance between '${probeA}' and '${probeB}': non-physical result.`);
  }
  // Clamp sub-picovolt numerical noise to zero; anything else negative is a bug.
  const ohms = raw < 0 ? (raw > -1e-6 ? 0 : raw) : raw;
  if (ohms < 0) {
    throw new CircuitSolverError(`Cannot measure resistance between '${probeA}' and '${probeB}': non-physical result.`);
  }
  return {
    probeA,
    probeB,
    ohms,
    continuous: ohms <= CONTINUITY_THRESHOLD_OHMS,
    formatted: formatSimOhms(ohms),
  };
}

export function solveDcCircuit(circuit: Circuit, injectedFault?: HiddenFault): DcSolution {
  const working = injectedFault ? applyFaultToCircuit(circuit, injectedFault) : circuit;
  const validated = validateCircuit(working);
  const { a, z, voltageSources, orderedNodes } = buildMnaSystem(working.components, validated.orderedNodes);
  const x = solveLinearSystem(a, z);
  if (!x) {
    throw new CircuitSolverError(
      'Singular MNA matrix (pivot < 1e-12): floating node, parallel ideal voltage sources ' +
        'with different voltages, or a conflicting zero-impedance voltage loop. ' +
        'Check connectivity to GND and remove parallel ideal sources.',
    );
  }
  const nodeVoltages: Record<string, number> = { [GROUND_NODE]: 0 };
  orderedNodes.forEach((node, i) => {
    nodeVoltages[node] = x[i]!;
  });
  const branchCurrents: Record<string, number> = {};
  const componentPowerWatts: Record<string, number> = {};
  voltageSources.forEach((vs, k) => {
    const current = x[orderedNodes.length + k]!;
    branchCurrents[vs.id] = current;
    componentPowerWatts[vs.id] = vs.volts * current;
  });
  const vOf = (n: string): number => (canonicalNode(n) === GROUND_NODE ? 0 : (nodeVoltages[canonicalNode(n)] ?? 0));
  for (const c of working.components) {
    if (c.type === 'resistor') {
      const amps = (vOf(c.nodeA) - vOf(c.nodeB)) / c.ohms;
      branchCurrents[c.id] = amps;
      componentPowerWatts[c.id] = amps * amps * c.ohms;
    } else if (c.type === 'current_source') {
      branchCurrents[c.id] = c.amps;
      componentPowerWatts[c.id] = (vOf(c.fromNode) - vOf(c.toNode)) * c.amps;
    }
  }
  return { nodeVoltages, branchCurrents, componentPowerWatts };
}

/* ---------------------------------------------------------------------------
 * Reference virtual boards (nominal circuits + reproducible hidden faults)
 * ------------------------------------------------------------------------- */

export interface NominalNodeSpec {
  node: string;
  nominalVolts: number;
  toleranceFrac: number;
}

export interface ReferenceBoard {
  boardId: string;
  boardName: string;
  symptom: string;
  nominal: Circuit;
  faults: HiddenFault[];
  /** Canvas probe-pad id → circuit node (e.g. TP_3V3 → U1-14). */
  probeAliases: Record<string, string>;
  nominalSpecs: NominalNodeSpec[];
}

function r(
  id: string,
  nodeA: string,
  nodeB: string,
  ohms: number,
  description?: string,
): ResistorComponent {
  return { id, type: 'resistor', nodeA, nodeB, ohms, description };
}

function vSrc(
  id: string,
  positiveNode: string,
  negativeNode: string,
  volts: number,
  description?: string,
): VoltageSourceComponent {
  return { id, type: 'voltage_source', positiveNode, negativeNode, volts, description };
}

/**
 * F405 flight controller logic-rail model. The 3.3 V rail is an ideal LDO
 * output behind an explicit 10 Ω source/trace resistance; NRST rides on a
 * 40 kΩ internal pull-up against a 4.7 MΩ leakage path to ground, so an
 * open pull-up collapses NRST while a GND splash shorts it outright.
 */
function buildF405Board(): ReferenceBoard {
  const nominal: Circuit = {
    id: 'f405-flight-controller',
    name: 'F405 3V3 / NRST rail model',
    nodes: ['GND', 'LDO_OUT', 'U1-14', 'U1-15'],
    components: [
      vSrc('V_LDO', 'LDO_OUT', 'GND', 3.3, 'LDO regulator output (ideal + series R_SRC)'),
      r('R_SRC', 'LDO_OUT', 'U1-14', 10, 'LDO source + trace resistance'),
      r('R_LOAD', 'U1-14', 'GND', 1000, 'Board logic load'),
      r('R_PULLUP', 'U1-14', 'U1-15', 40_000, 'NRST internal pull-up (~40 kΩ)'),
      r('R_NRSTPD', 'U1-15', 'GND', 4_700_000, 'NRST leakage path to ground'),
    ],
  };
  return {
    boardId: 'f405-flight-controller',
    boardName: 'FPV Drone Flight Controller (F405)',
    symptom: 'Board enumerates no USB device; NRST test pad near 0 V instead of the 3.3 V pull-up.',
    nominal,
    probeAliases: { TP_3V3: 'U1-14', TP_NRST: 'U1-15' },
    nominalSpecs: [
      { node: 'U1-14', nominalVolts: 3.267, toleranceFrac: 0.05 },
      { node: 'U1-15', nominalVolts: 3.24, toleranceFrac: 0.05 },
    ],
    faults: [
      {
        faultId: 'f405-nrst-gnd-short',
        boardId: 'f405-flight-controller',
        faultType: 'solder_bridge',
        targetComponentRef: 'U1',
        description: 'Solder splash shorting the NRST net (U1 pin 15) to the ground plane.',
        modification: { kind: 'shunt_to_gnd', node: 'U1-15', shuntOhms: 0.4 },
        affectedNodes: ['U1-15', 'TP_NRST'],
      },
      {
        faultId: 'f405-pullup-open',
        boardId: 'f405-flight-controller',
        faultType: 'open_circuit',
        targetComponentRef: 'R_PULLUP',
        description: 'Cracked/open NRST pull-up resistor; leakage drags NRST low.',
        modification: { kind: 'open_component', componentId: 'R_PULLUP' },
        affectedNodes: ['U1-15', 'TP_NRST'],
      },
      {
        faultId: 'f405-pullup-drift',
        boardId: 'f405-flight-controller',
        faultType: 'parameter_drift',
        targetComponentRef: 'R_PULLUP',
        description: 'Pull-up resistor drifted high (40 kΩ → 470 kΩ); NRST divider sags.',
        modification: { kind: 'override_resistance', componentId: 'R_PULLUP', ohms: 470_000 },
        affectedNodes: ['U1-15', 'TP_NRST'],
      },
    ],
  };
}

/**
 * ESP32-S3 sensor-node 5 V rail model. A 0.5 Ω fuse feeds the rail; a
 * 56 Ω load draws the nominal ~90 mA idle current and a 10 k/20 k divider
 * mirrors the 3.3 V sense point. A reversed tantalum is a pure DC leakage
 * shunt (capacitors are DC opens, so it adds no nominal component).
 */
function buildEsp32Board(): ReferenceBoard {
  const nominal: Circuit = {
    id: 'esp32s3-sensor-node',
    name: 'ESP32-S3 5V rail model',
    nodes: ['GND', 'VUSB', 'TP_5V', 'U2-OUT'],
    components: [
      vSrc('V_USB', 'VUSB', 'GND', 5.0, 'USB 5 V input (unplugged during ohmmeter tests)'),
      r('F1', 'VUSB', 'TP_5V', 0.5, 'Input fuse / source resistance'),
      r('R_LOAD', 'TP_5V', 'GND', 56, 'Board load (~90 mA idle)'),
      r('R_DIV1', 'TP_5V', 'U2-OUT', 10_000, 'Sense divider top'),
      r('R_DIV2', 'U2-OUT', 'GND', 20_000, 'Sense divider bottom'),
    ],
  };
  return {
    boardId: 'esp32s3-sensor-node',
    boardName: 'ESP32-S3 IoT Sensor Node',
    symptom: 'Node boot-loops with brownout resets; 5 V rail sags and C4 runs hot.',
    nominal,
    probeAliases: { 'C4-POS': 'TP_5V' },
    nominalSpecs: [
      { node: 'TP_5V', nominalVolts: 4.956, toleranceFrac: 0.05 },
      { node: 'U2-OUT', nominalVolts: 3.304, toleranceFrac: 0.05 },
    ],
    faults: [
      {
        faultId: 'esp32-c4-rev-leak',
        boardId: 'esp32s3-sensor-node',
        faultType: 'reverse_polarity_leakage',
        targetComponentRef: 'C4',
        description: 'Reversed tantalum C4: DC leakage shunt dragging the 5 V rail down.',
        modification: { kind: 'shunt_to_gnd', node: 'TP_5V', shuntOhms: 2.75 },
        affectedNodes: ['TP_5V', 'C4-POS', 'U2-OUT'],
      },
      {
        faultId: 'esp32-f1-blown',
        boardId: 'esp32s3-sensor-node',
        faultType: 'open_circuit',
        targetComponentRef: 'F1',
        description: 'Blown input fuse F1; rail side floats to ~0 V through the load.',
        modification: { kind: 'open_component', componentId: 'F1' },
        affectedNodes: ['TP_5V', 'C4-POS', 'U2-OUT'],
      },
      {
        faultId: 'esp32-div-drift',
        boardId: 'esp32s3-sensor-node',
        faultType: 'parameter_drift',
        targetComponentRef: 'R_DIV2',
        description: 'Sense divider lower resistor drifted low (20 kΩ → 10 kΩ).',
        modification: { kind: 'override_resistance', componentId: 'R_DIV2', ohms: 10_000 },
        affectedNodes: ['U2-OUT'],
      },
    ],
  };
}

/**
 * USB-C PD trigger CC-line model. Each CC line has a 56 kΩ source pull-up,
 * a 5.1 kΩ sink pull-down (Rd) and a 10 MΩ healthy TVS leakage path. The
 * healthy channel (CC2) is the built-in control for CC1 faults.
 */
function buildUsbcBoard(): ReferenceBoard {
  const nominal: Circuit = {
    id: 'usbc-pd-trigger',
    name: 'USB-C PD CC-line model',
    nodes: ['GND', 'V5', 'CC1', 'CC2'],
    components: [
      vSrc('V_SRC', 'V5', 'GND', 5.0, 'Source-side pull-up supply'),
      r('R_PU1', 'V5', 'CC1', 56_000, 'CC1 source pull-up'),
      r('R_RD1', 'CC1', 'GND', 5_100, 'CC1 sink pull-down (Rd)'),
      r('D2_TVS', 'CC1', 'GND', 10_000_000, 'CC1 TVS leakage (healthy)'),
      r('R_PU2', 'V5', 'CC2', 56_000, 'CC2 source pull-up'),
      r('R_RD2', 'CC2', 'GND', 5_100, 'CC2 sink pull-down (Rd)'),
      r('D3_TVS', 'CC2', 'GND', 10_000_000, 'CC2 TVS leakage (healthy)'),
    ],
  };
  return {
    boardId: 'usbc-pd-trigger',
    boardName: 'USB-C Power Delivery Trigger',
    symptom: 'No PD negotiation; CC1 stuck at 0 V while CC2 shows a healthy pull-up voltage.',
    nominal,
    probeAliases: { TP_CC1: 'CC1', TP_CC2: 'CC2' },
    nominalSpecs: [
      { node: 'CC1', nominalVolts: 0.417, toleranceFrac: 0.1 },
      { node: 'CC2', nominalVolts: 0.417, toleranceFrac: 0.1 },
    ],
    faults: [
      {
        faultId: 'usbc-d2-shorted',
        boardId: 'usbc-pd-trigger',
        faultType: 'shorted_component',
        targetComponentRef: 'D2',
        description: 'TVS diode D2 failed short (EOS), clamping CC1 to ground.',
        modification: { kind: 'override_resistance', componentId: 'D2_TVS', ohms: 0.2 },
        affectedNodes: ['CC1', 'TP_CC1'],
      },
      {
        faultId: 'usbc-cc1-pu-open',
        boardId: 'usbc-pd-trigger',
        faultType: 'open_circuit',
        targetComponentRef: 'R_PU1',
        description: 'Open CC1 pull-up; Rd holds CC1 at 0 V (distinguish from a short by continuity).',
        modification: { kind: 'open_component', componentId: 'R_PU1' },
        affectedNodes: ['CC1', 'TP_CC1'],
      },
      {
        faultId: 'usbc-rd-drift',
        boardId: 'usbc-pd-trigger',
        faultType: 'parameter_drift',
        targetComponentRef: 'R_RD1',
        description: 'CC1 Rd drifted high (5.1 kΩ → 47 kΩ); CC1 floats above the valid range.',
        modification: { kind: 'override_resistance', componentId: 'R_RD1', ohms: 47_000 },
        affectedNodes: ['CC1', 'TP_CC1'],
      },
    ],
  };
}

const REFERENCE_BOARDS: ReferenceBoard[] = [buildF405Board(), buildEsp32Board(), buildUsbcBoard()];

export const REFERENCE_BOARD_IDS = REFERENCE_BOARDS.map((b) => b.boardId);

export function getReferenceBoard(boardId: string): ReferenceBoard | undefined {
  return REFERENCE_BOARDS.find((b) => b.boardId === boardId);
}

export function listReferenceBoards(): ReferenceBoard[] {
  return [...REFERENCE_BOARDS];
}

export function getFaultScenario(boardId: string, faultId: string): HiddenFault | undefined {
  return getReferenceBoard(boardId)?.faults.find((f) => f.faultId === faultId);
}

/* ---------------------------------------------------------------------------
 * Virtual lab sessions & ground-truth isolation
 * ------------------------------------------------------------------------- */

/**
 * Public circuit view: the ONLY circuit data ever passed to Muse Spark 1.3.
 * Component values are ALWAYS nominal (faulted values never appear here),
 * and the hidden fault (id, target ref, summary, faulted values) is absent
 * by construction.
 */
export interface AgentCircuitView {
  boardId: string;
  boardName: string;
  symptom: string;
  nodes: string[];
  probeAliases: Record<string, string>;
  nominalComponents: CircuitComponent[];
  nominalSpecs: NominalNodeSpec[];
  allowedProbeNodes: string[];
  maxToolCalls: number;
}

/** One recorded bench interaction (drives objective evidence scoring). */
export interface ProbeRecord {
  kind: 'voltage' | 'resistance' | 'current' | 'lookup' | 'other';
  /** Node, `A↔B` pair, component id, or lookup key the probe touched. */
  target: string;
  /** True when the reading was decisively outside the nominal spec. */
  abnormal: boolean;
  detail?: string;
}

/** Budget guard: maximum tool iterations per diagnostic run. */
export const MAX_TOOL_CALLS = 8;

export interface VirtualSessionOptions {
  maxToolCalls?: number;
  supplyMode?: SupplyMode;
}

/**
 * A hardware-free diagnostic session: holds the faulted circuit and the
 * withheld `HiddenFault` on the harness side, exposes an `AgentCircuitView`
 * plus logging measurement methods on the agent side.
 */
export class VirtualLabSession {
  readonly sessionId: string;
  readonly boardId: string;
  readonly maxToolCalls: number;
  readonly supplyMode: SupplyMode;
  private readonly reference: ReferenceBoard;
  private readonly hiddenFault: HiddenFault | null;
  private readonly faultedCircuit: Circuit;
  private readonly solution: DcSolution;
  private probeLog: ProbeRecord[] = [];
  private toolCallsUsed = 0;

  constructor(boardId: string, fault: HiddenFault | null, options?: VirtualSessionOptions) {
    const reference = getReferenceBoard(boardId);
    if (!reference) throw new CircuitSolverError(`Unknown virtual board '${boardId}'.`);
    this.reference = reference;
    this.boardId = boardId;
    this.hiddenFault = fault;
    this.maxToolCalls = options?.maxToolCalls ?? MAX_TOOL_CALLS;
    this.supplyMode = options?.supplyMode ?? 'unpowered_unplugged';
    this.sessionId = `vlab-${boardId}-${fault ? fault.faultId : 'nominal'}`;
    this.faultedCircuit = fault ? applyFaultToCircuit(reference.nominal, fault) : reference.nominal;
    this.solution = solveDcCircuit(this.faultedCircuit);
  }

  /** Withheld ground truth — harness/scoring side only, never sent to the model. */
  getGroundTruth(): HiddenFault | null {
    return this.hiddenFault;
  }

  /** Safe agent-side view: nominal values only, no fault identity. */
  getAgentView(): AgentCircuitView {
    return {
      boardId: this.reference.boardId,
      boardName: this.reference.boardName,
      symptom: this.reference.symptom,
      nodes: [...this.reference.nominal.nodes],
      probeAliases: { ...this.reference.probeAliases },
      nominalComponents: this.reference.nominal.components.map((c) => ({ ...c })),
      nominalSpecs: this.reference.nominalSpecs.map((s) => ({ ...s })),
      allowedProbeNodes: [...this.reference.nominal.nodes],
      maxToolCalls: this.maxToolCalls,
    };
  }

  getProbeLog(): ProbeRecord[] {
    return [...this.probeLog];
  }

  getToolCallsUsed(): number {
    return this.toolCallsUsed;
  }

  /**
   * Cross-isolate state restoration: replace the probe log with a defensive
   * copy of committed `records` (e.g. hydrated from Edge Cache) and restore
   * the tool-call counter. `toolCallsUsed` never moves backwards past the
   * restored log length.
   */
  restoreProbeLog(records: readonly ProbeRecord[], toolCallsUsed?: number): void {
    this.probeLog = records.map((r) => ({ ...r }));
    this.toolCallsUsed = typeof toolCallsUsed === 'number'
      ? Math.max(records.length, toolCallsUsed)
      : records.length;
  }

  resolveProbeNode(padOrNode: string): string {
    const alias = this.reference.probeAliases[padOrNode];
    return alias ?? padOrNode;
  }

  /**
   * Budget pre-check: throws `Tool budget exhausted` when no calls remain.
   * The counter itself is incremented only AFTER a measurement succeeds, so
   * failed probes (unknown node/component, self-continuity, singular bench)
   * never consume budget.
   */
  private assertBudgetRemaining(): void {
    if (this.toolCallsUsed >= this.maxToolCalls) {
      throw new CircuitSolverError(
        `Tool budget exhausted (${this.maxToolCalls} calls). Stop probing and commit to a diagnosis.`,
      );
    }
  }

  private nominalSpecFor(node: string): NominalNodeSpec | undefined {
    return this.reference.nominalSpecs.find((s) => s.node === node);
  }

  /** Powered DC voltage at a probe pad (or node) vs ground; logs the probe. */
  measureVoltage(padOrNode: string, refNode: string = GROUND_NODE): NodeVoltageReading {
    this.assertBudgetRemaining();
    const node = this.resolveProbeNode(padOrNode);
    const reading = measureNodeVoltage(this.solution, node, refNode);
    const spec = this.nominalSpecFor(node);
    const abnormal =
      spec !== undefined &&
      Math.abs(reading.volts - spec.nominalVolts) > Math.abs(spec.nominalVolts) * spec.toleranceFrac + 1e-9;
    this.toolCallsUsed += 1;
    this.probeLog.push({
      kind: 'voltage',
      target: padOrNode,
      abnormal,
      detail: `${reading.formatted} vs nominal ${spec ? formatSimVolts(spec.nominalVolts) : 'n/a'}`,
    });
    return reading;
  }

  /** Unpowered ohmmeter/continuity between two pads; logs the probe. */
  measureContinuity(padA: string, padB: string): EffectiveResistanceReading {
    this.assertBudgetRemaining();
    const nodeA = this.resolveProbeNode(padA);
    const nodeB = this.resolveProbeNode(padB);
    const reading = measureEffectiveResistance(this.faultedCircuit, nodeA, nodeB, undefined, {
      supplyMode: this.supplyMode,
    });
    this.toolCallsUsed += 1;
    this.probeLog.push({
      kind: 'resistance',
      target: `${padA}↔${padB}`,
      abnormal: reading.continuous,
      detail: reading.formatted,
    });
    return reading;
  }

  /** Branch current through a component; logs the probe (never abnormal by itself). */
  measureCurrent(componentId: string): BranchCurrentReading {
    this.assertBudgetRemaining();
    const reading = measureBranchCurrent(this.solution, componentId);
    this.toolCallsUsed += 1;
    this.probeLog.push({ kind: 'current', target: componentId, abnormal: false, detail: reading.formatted });
    return reading;
  }

  /** Record a datasheet/pinout lookup (context, not electrical evidence). */
  recordLookup(target: string, detail?: string): void {
    this.assertBudgetRemaining();
    this.toolCallsUsed += 1;
    this.probeLog.push({ kind: 'lookup', target, abnormal: false, detail });
  }
}

function pickRandomFault(reference: ReferenceBoard): HiddenFault {
  const index = Math.floor(Math.random() * reference.faults.length);
  return reference.faults[index] as HiddenFault;
}

/**
 * Create a virtual lab session for `boardId`.
 * - `faultId` names a reproducible scenario, `'nominal'` (or omitted) runs
 *   the healthy board, and `'random'` injects a uniformly chosen fault.
 */
export function createVirtualSession(
  boardId: string,
  faultId?: string,
  options?: VirtualSessionOptions,
): VirtualLabSession {
  const reference = getReferenceBoard(boardId);
  if (!reference) throw new CircuitSolverError(`Unknown virtual board '${boardId}'.`);
  if (faultId === undefined || faultId === 'nominal' || faultId === 'healthy') {
    return new VirtualLabSession(boardId, null, options);
  }
  if (faultId === 'random') return new VirtualLabSession(boardId, pickRandomFault(reference), options);
  const fault = reference.faults.find((f) => f.faultId === faultId);
  if (!fault) throw new CircuitSolverError(`Unknown fault scenario '${faultId}' for board '${boardId}'.`);
  return new VirtualLabSession(boardId, fault, options);
}

const FORBIDDEN_GROUND_TRUTH_KEYS = new Set([
  'hiddenfault',
  'faultid',
  'targetcomponentref',
  'faultsummary',
  'groundtruth',
  'injectedfault',
]);

function collectLeaks(value: unknown, leaks: string[], seen: Set<unknown>): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectLeaks(item, leaks, seen);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_GROUND_TRUTH_KEYS.has(key.toLowerCase())) leaks.push(`forbidden key '${key}'`);
    collectLeaks(item, leaks, seen);
  }
}

/**
 * Verify that a payload about to be sent to Muse Spark 1.3 (prompt context,
 * tool schemas, agent view) contains no withheld ground truth. Throws
 * `CircuitSolverError` listing every leak found: forbidden structured keys
 * (`hiddenFault`, `faultId`, `targetComponentRef`, `faultSummary`, …) and
 * the distinctive fault-id value itself.
 */
export function assertGroundTruthIsolated(payloadSentToModel: unknown, hiddenFault: HiddenFault | null): void {
  if (!hiddenFault) return;
  const leaks: string[] = [];
  collectLeaks(payloadSentToModel, leaks, new Set());
  if (hiddenFault.faultId.length >= 6) {
    const serialized = JSON.stringify(payloadSentToModel) ?? '';
    if (serialized.includes(hiddenFault.faultId)) leaks.push(`fault-id value '${hiddenFault.faultId}'`);
  }
  if (leaks.length > 0) {
    throw new CircuitSolverError(`Ground-truth isolation breach: ${leaks.join('; ')}.`);
  }
}

/* ---------------------------------------------------------------------------
 * Objective diagnosis scoring
 * ------------------------------------------------------------------------- */

export interface DiagnosisSubmission {
  componentRef: string;
  faultType: string;
  verificationStatus: 'confirmed' | 'hypothesis';
}

export interface DiagnosisScore {
  componentMatch: boolean;
  faultTypeMatch: boolean;
  evidenceConfirmed: boolean;
  probeCount: number;
  efficiencyScore: number;
  totalScore: number;
  summary: string;
}

/** Fault classes close enough to count as a type match (e.g. bridge ≈ short). */
const FAULT_TYPE_COMPAT: Record<string, string[]> = {
  solder_bridge: ['shorted_component'],
  shorted_component: ['solder_bridge'],
  reverse_polarity_leakage: ['shorted_component'],
  open_circuit: [],
  parameter_drift: [],
};

/**
 * Score a proposed diagnosis against the withheld `HiddenFault`:
 * 40 pts exact component match, 30 pts fault-type (or compatible class)
 * match, 20 pts decisive abnormal measurement on an affected node/branch
 * recorded in `probeLog` BEFORE diagnosis, 10 pts probe efficiency.
 * Without `evidenceConfirmed`, unverified guessing is capped at 45 pts.
 */
export function scoreDiagnosis(
  submission: DiagnosisSubmission,
  groundTruth: HiddenFault,
  probeLog: ProbeRecord[],
): DiagnosisScore {
  const componentMatch = submission.componentRef === groundTruth.targetComponentRef;
  const faultTypeMatch =
    submission.faultType === groundTruth.faultType ||
    (FAULT_TYPE_COMPAT[groundTruth.faultType] ?? []).includes(submission.faultType);
  const evidenceConfirmed =
    submission.verificationStatus === 'confirmed' &&
    probeLog.some(
      (p) =>
        p.abnormal &&
        (groundTruth.affectedNodes.some((n) => p.target.includes(n)) ||
          p.target.includes(groundTruth.targetComponentRef)),
    );
  const probeCount = probeLog.length;
  const efficiencyScore = Math.max(0, Math.min(100, Math.round(100 - 15 * Math.max(0, probeCount - 2))));
  let totalScore =
    (componentMatch ? 40 : 0) + (faultTypeMatch ? 30 : 0) + (evidenceConfirmed ? 20 : 0) + 10 * (efficiencyScore / 100);
  if (!evidenceConfirmed) totalScore = Math.min(totalScore, 45);
  totalScore = Math.round(Math.min(100, Math.max(0, totalScore)));
  const summary =
    `component ${componentMatch ? 'MATCH' : 'MISS'} (${submission.componentRef} vs ${groundTruth.targetComponentRef}); ` +
    `fault-type ${faultTypeMatch ? 'MATCH' : 'MISS'} (${submission.faultType} vs ${groundTruth.faultType}); ` +
    `evidence ${evidenceConfirmed ? 'CONFIRMED by measurement' : 'NOT confirmed'}; ` +
    `${probeCount} probe(s), efficiency ${efficiencyScore}; total ${totalScore}/100.`;
  return { componentMatch, faultTypeMatch, evidenceConfirmed, probeCount, efficiencyScore, totalScore, summary };
}
