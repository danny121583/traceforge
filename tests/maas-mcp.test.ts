/**
 * TraceForge MaaS/MCP automated test suite — Workstream 2 verification.
 *
 * Covers all 14 required areas: discovery, schema validation, auth,
 * circuits, scenario creation, ground-truth isolation, measurements,
 * probe limits, investigation lifecycle, evaluation, budget, errors/rate
 * limits/kill switch, tenant isolation, and model identity + HTTP.
 */
import { describe, expect, it } from 'vitest';
import {
  JSON_RPC_VERSION,
  MCP_PROTOCOL_VERSION,
  createMaasCorrelationId,
  normalizeToolName,
  validateAgainstMaasSchema,
  type MaasJsonSchema,
} from '../src/maas/protocol';
import { TraceForgeVerificationEngine, type MaasVerificationReceipt } from '../src/maas/verification';
import { sanitizeForAuditText } from '../src/maas/security';
import {
  MaasToolError,
  TraceForgeMaasService,
} from '../src/maas/tools';
import { handleMaasMcpRequest, type MaasHttpResponse } from '../src/server/maas-mcp-server';
import { createVirtualSession } from '../src/lib/circuit-simulator';

const AGENT = { authorization: 'Bearer tf_agent_local_token' };
const SECONDARY = { authorization: 'Bearer tf_agent_secondary_token' };
const READONLY = { authorization: 'Bearer tf_readonly_local_token' };
const OPERATOR = { authorization: 'Bearer tf_operator_live_token' };

const FORBIDDEN_KEYS = ['"hiddenFault"', '"faultId"', '"targetComponentRef"', '"faultSummary"', '"groundTruth"', '"injectedFault"'];

function leakedKeys(payload: unknown): string[] {
  const text = JSON.stringify(payload) ?? '';
  return FORBIDDEN_KEYS.filter((k) => text.includes(k));
}

async function expectToolError(promise: Promise<unknown>, code: string): Promise<MaasToolError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MaasToolError);
    expect((err as MaasToolError).code).toBe(code);
    return err as MaasToolError;
  }
  throw new Error(`Expected MaasToolError ${code} but the call succeeded.`);
}

interface CapturedResponse {
  statusCode?: number;
  headers: Record<string, string>;
  body: string;
}

function capture(): { res: MaasHttpResponse; out: CapturedResponse } {
  const out: CapturedResponse = { headers: {}, body: '' };
  const res: MaasHttpResponse = {
    setHeader: (name, value) => {
      out.headers[name] = value;
    },
    end: (body) => {
      out.body = body;
    },
  };
  return { res, out };
}

const objSchema: MaasJsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    role: { type: 'string', enum: ['agent', 'owner'] },
  },
  required: ['name'],
  additionalProperties: false,
};

/* ---------------------------------------------------------------- area 1 -- */

describe('1. tool discovery', () => {
  it('tools/list returns all 18 tools with names, descriptions, and schemas', async () => {
    const service = new TraceForgeMaasService();
    const { res, out } = capture();
    const handled = await handleMaasMcpRequest(
      { method: 'POST', url: '/api/mcp', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } },
      res,
      service,
    );
    expect(handled).toBe(true);
    expect(out.headers['X-Correlation-Id']).toBeTruthy();
    const envelope = JSON.parse(out.body) as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };
    expect(envelope.result.tools).toHaveLength(18);
    for (const tool of envelope.result.tools) {
      expect(tool.name.startsWith('traceforge.')).toBe(true);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('traceforge.capabilities.list returns all 18 descriptors with schemas, scopes, and annotations', async () => {
    const service = new TraceForgeMaasService();
    const result = (await service.executeTool('traceforge.capabilities.list', {}, {})) as {
      count: number;
      tools: Array<{ name: string; inputSchema: MaasJsonSchema; requiredScope: string | null; annotations: Record<string, boolean> }>;
    };
    expect(result.count).toBe(18);
    expect(result.tools).toHaveLength(18);
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations['readOnlyHint']).toBeDefined();
      expect('requiredScope' in tool).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------- area 2 -- */

describe('2. tool schema validation', () => {
  it('rejects a missing required field', () => {
    const result = validateAgainstMaasSchema({}, objSchema);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('name');
  });

  it('rejects wrong types and out-of-range numbers', () => {
    expect(validateAgainstMaasSchema({ name: 42 }, objSchema).valid).toBe(false);
    expect(validateAgainstMaasSchema({ name: 'x', age: 1.5 }, objSchema).valid).toBe(false);
    expect(validateAgainstMaasSchema({ name: 'x', age: 200 }, objSchema).valid).toBe(false);
    expect(validateAgainstMaasSchema({ name: 'x', role: 'intruder' }, objSchema).valid).toBe(false);
    expect(validateAgainstMaasSchema({ name: '' }, objSchema).valid).toBe(false);
    expect(validateAgainstMaasSchema({ name: 'ada', age: 30, role: 'agent' }, objSchema).valid).toBe(true);
  });

  it('rejects unknown additionalProperties', () => {
    const result = validateAgainstMaasSchema({ name: 'ada', META_API_KEY: 'x' }, objSchema);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('additionalProperties');
  });

  it('tool calls with invalid arguments fail with MAAS_SCHEMA_VALIDATION_FAILED', async () => {
    const service = new TraceForgeMaasService();
    await expectToolError(service.executeTool('traceforge.circuits.get', {}, {}), 'MAAS_SCHEMA_VALIDATION_FAILED');
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: 'x' }, AGENT),
      'MAAS_SCHEMA_VALIDATION_FAILED',
    );
  });
});

/* ---------------------------------------------------------------- area 3 -- */

describe('3. authentication and authorization', () => {
  it('public read-only tools succeed unauthenticated', async () => {
    const service = new TraceForgeMaasService();
    const status = (await service.executeTool('traceforge.system.status', {}, {})) as { mcpProtocolVersion: string };
    expect(status.mcpProtocolVersion).toBe('2025-06-18');
    const circuits = (await service.executeTool('traceforge.circuits.list', {}, {})) as { count: number };
    expect(circuits.count).toBe(3);
  });

  it('protected tools fail unauthenticated with MAAS_AUTHENTICATION_REQUIRED', async () => {
    const service = new TraceForgeMaasService();
    await expectToolError(
      service.executeTool('traceforge.scenarios.create', { boardId: 'f405-flight-controller' }, {}),
      'MAAS_AUTHENTICATION_REQUIRED',
    );
    await expectToolError(service.executeTool('traceforge.scenarios.list', {}, {}), 'MAAS_AUTHENTICATION_REQUIRED');
  });

  it('readonly token fails on write tools with MAAS_AUTHORIZATION_DENIED', async () => {
    const service = new TraceForgeMaasService();
    await expectToolError(
      service.executeTool('traceforge.scenarios.create', { boardId: 'f405-flight-controller' }, READONLY),
      'MAAS_AUTHORIZATION_DENIED',
    );
  });
});

/* ---------------------------------------------------------------- area 4 -- */

describe('4. circuit listing and inspection', () => {
  it('circuits.list returns all 3 boards with symptoms, node counts, test points, scenario counts', async () => {
    const service = new TraceForgeMaasService();
    const result = (await service.executeTool('traceforge.circuits.list', {}, {})) as {
      count: number;
      boards: Array<{ boardId: string; symptom: string; nominalNodeCount: number; testPoints: unknown[]; scenarioCount: number }>;
    };
    expect(result.count).toBe(3);
    const ids = result.boards.map((b) => b.boardId).sort();
    expect(ids).toEqual(['esp32s3-sensor-node', 'f405-flight-controller', 'usbc-pd-trigger']);
    for (const board of result.boards) {
      expect(board.symptom.length).toBeGreaterThan(0);
      expect(board.nominalNodeCount).toBeGreaterThan(0);
      expect(board.testPoints.length).toBeGreaterThan(0);
      expect(board.scenarioCount).toBe(3);
    }
    expect(leakedKeys(result)).toEqual([]);
  });

  it('circuits.get returns a nominal view plus PCB coordinates with zero leakage', async () => {
    const service = new TraceForgeMaasService();
    const result = (await service.executeTool('traceforge.circuits.get', { boardId: 'f405-flight-controller' }, {})) as {
      agentView: { boardId: string; nodes: string[]; nominalSpecs: unknown[] };
      pcbProbePoints: Array<{ x: number; y: number; label: string; net: string }>;
    };
    expect(result.agentView.boardId).toBe('f405-flight-controller');
    expect(result.agentView.nodes).toContain('GND');
    expect(result.agentView.nominalSpecs.length).toBeGreaterThan(0);
    for (const point of result.pcbProbePoints) {
      expect(typeof point.x).toBe('number');
      expect(typeof point.y).toBe('number');
      expect(typeof point.label).toBe('string');
      expect(typeof point.net).toBe('string');
    }
    expect(leakedKeys(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('f405-nrst-gnd-short');
  });
});

/* ---------------------------------------------------------------- area 5 -- */

describe('5. scenario creation', () => {
  it('returns an isolated scenarioId plus a verifiable cryptographic receipt with zero leakage', async () => {
    const service = new TraceForgeMaasService();
    const result = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      AGENT,
    )) as {
      scenarioId: string;
      verificationReceipt: MaasVerificationReceipt;
    };
    expect(result.scenarioId.startsWith('scn_')).toBe(true);
    expect(result.verificationReceipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verificationReceipt.hmacSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verificationReceipt.capabilityName).toBe('traceforge.scenarios.create');
    expect(service.getVerifier().verifyReceipt(result.verificationReceipt)).toBe(true);
    expect(leakedKeys(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('f405-nrst-gnd-short');
  });

  it('chains receipts across mutating calls', async () => {
    const service = new TraceForgeMaasService();
    const first = (await service.executeTool('traceforge.scenarios.create', { boardId: 'usbc-pd-trigger', faultSelector: 'nominal' }, AGENT)) as {
      scenarioId: string;
      verificationReceipt: { receiptHash: string; sequenceNumber: number };
    };
    const second = (await service.executeTool(
      'traceforge.measurements.voltage',
      { scenarioId: first.scenarioId, node: 'CC1' },
      AGENT,
    )) as { verificationReceipt: { previousReceiptHash: string; sequenceNumber: number } };
    expect(second.verificationReceipt.previousReceiptHash).toBe(first.verificationReceipt.receiptHash);
    expect(second.verificationReceipt.sequenceNumber).toBe(first.verificationReceipt.sequenceNumber + 1);
  });
});

/* ---------------------------------------------------------------- area 6 -- */

describe('6. ground-truth isolation', () => {
  it('withholds fault answers from circuits, scenarios, measurements, and investigations', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'usbc-pd-trigger', faultSelector: 'usbc-d2-shorted' },
      AGENT,
    )) as { scenarioId: string };
    const scenarioId = created.scenarioId;
    const voltage = await service.executeTool('traceforge.measurements.voltage', { scenarioId, node: 'CC1' }, AGENT);
    const started = (await service.executeTool('traceforge.investigations.start', { scenarioId }, AGENT)) as { investigationId: string };
    const status = await service.executeTool('traceforge.investigations.status', { scenarioId }, AGENT);
    const history = await service.executeTool('traceforge.investigations.history', { scenarioId }, AGENT);
    const result = await service.executeTool('traceforge.investigations.result', { scenarioId }, AGENT);
    for (const payload of [created, voltage, started, status, history, result]) {
      expect(leakedKeys(payload)).toEqual([]);
      expect(JSON.stringify(payload)).not.toContain('usbc-d2-shorted');
    }
  });

  it('evaluation.score rejects before any investigation or measurement', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      AGENT,
    )) as { scenarioId: string };
    await expectToolError(
      service.executeTool('traceforge.evaluation.score', { scenarioId: created.scenarioId }, AGENT),
      'MAAS_INVESTIGATION_INCOMPLETE',
    );
  });

  it('locks the session against post-evaluation probing', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      AGENT,
    )) as { scenarioId: string };
    await service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId }, AGENT);
    await service.executeTool('traceforge.evaluation.score', { scenarioId: created.scenarioId }, AGENT);
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'U1-15' }, AGENT),
      'MAAS_SESSION_ALREADY_EVALUATED',
    );
  });
});

/* ---------------------------------------------------------------- area 7 -- */

describe('7. valid and invalid measurements', () => {
  it('voltage matches the deterministic MNA solution', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      AGENT,
    )) as { scenarioId: string };
    const result = (await service.executeTool(
      'traceforge.measurements.voltage',
      { scenarioId: created.scenarioId, node: 'TP_NRST' },
      AGENT,
    )) as {
      volts: number; unit: string; formatted: string; nominalVolts: number; abnormal: boolean;
      probesUsed: number; probesRemaining: number; pcbHighlight: { x: number; y: number } | null;
      verificationReceipt: { receiptHash: string };
    };
    const reference = createVirtualSession('f405-flight-controller', 'f405-nrst-gnd-short').measureVoltage('TP_NRST', 'GND');
    expect(result.volts).toBeCloseTo(reference.volts, 9);
    expect(result.unit).toBe('V');
    expect(result.formatted).toBe(reference.formatted);
    expect(result.abnormal).toBe(true);
    expect(result.probesUsed).toBe(1);
    expect(result.probesRemaining).toBe(7);
    expect(result.pcbHighlight?.x).toBeGreaterThanOrEqual(0);
    expect(result.verificationReceipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('current and continuity return MNA values with receipts', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      AGENT,
    )) as { scenarioId: string };
    const current = (await service.executeTool(
      'traceforge.measurements.current',
      { scenarioId: created.scenarioId, componentId: 'R_LOAD' },
      AGENT,
    )) as { amps: number; unit: string; verificationReceipt: { receiptHash: string } };
    expect(Number.isFinite(current.amps)).toBe(true);
    expect(current.unit).toBe('A');
    expect(current.verificationReceipt.receiptHash).toBeTruthy();
    const continuity = (await service.executeTool(
      'traceforge.measurements.continuity',
      { scenarioId: created.scenarioId, probeA: 'U1-15', probeB: 'GND' },
      AGENT,
    )) as { ohms: number; unit: string; continuous: boolean; verificationReceipt: { receiptHash: string } };
    expect(continuity.unit).toBe('Ohm');
    expect(continuity.continuous).toBe(true);
    expect(continuity.verificationReceipt.receiptHash).toBeTruthy();
  });

  it('rejects invalid nodes, components, and self-continuity', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'NOPE-999' }, AGENT),
      'MAAS_RESOURCE_NOT_FOUND',
    );
    await expectToolError(
      service.executeTool('traceforge.measurements.current', { scenarioId: created.scenarioId, componentId: 'R_NOPE' }, AGENT),
      'MAAS_RESOURCE_NOT_FOUND',
    );
    await expectToolError(
      service.executeTool('traceforge.measurements.continuity', { scenarioId: created.scenarioId, probeA: 'U1-15', probeB: 'TP_NRST' }, AGENT),
      'MAAS_INVALID_REQUEST',
    );
  });

  it('history returns the ordered probe log, summary, and highlights', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'usbc-pd-trigger', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    await service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'CC1' }, AGENT);
    await service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'CC2' }, AGENT);
    const history = (await service.executeTool('traceforge.measurements.history', { scenarioId: created.scenarioId }, AGENT)) as {
      probeLog: Array<{ kind: string; target: string }>;
      activitySummary: { total: number };
      pcbHighlights: Array<{ target: string; point: { x: number } | null }>;
    };
    expect(history.probeLog).toHaveLength(2);
    expect(history.probeLog[0]?.target).toBe('CC1');
    expect(history.activitySummary.total).toBe(2);
    expect(history.pcbHighlights).toHaveLength(2);
    expect(history.pcbHighlights[0]?.point?.x).toBeGreaterThanOrEqual(0);
  });
});

/* ---------------------------------------------------------------- area 8 -- */

describe('8. probe-limit enforcement', () => {
  it('enforces MAX_TOOL_CALLS = 8 with MAAS_PROBE_BUDGET_EXHAUSTED on the 9th probe', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    for (let i = 0; i < 8; i += 1) {
      const node = i % 2 === 0 ? 'U1-14' : 'U1-15';
      const result = (await service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node }, AGENT)) as {
        probesUsed: number;
        probesRemaining: number;
      };
      expect(result.probesUsed).toBe(i + 1);
      expect(result.probesRemaining).toBe(7 - i);
    }
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'U1-14' }, AGENT),
      'MAAS_PROBE_BUDGET_EXHAUSTED',
    );
  });
});

/* ---------------------------------------------------------------- area 9 -- */

describe('9. full investigation lifecycle', () => {
  it('runs start -> status -> history -> result in SIMULATED mode', async () => {
    const service = new TraceForgeMaasService();
    const started = (await service.executeTool('traceforge.investigations.start', { boardId: 'usbc-pd-trigger' }, AGENT)) as {
      investigationId: string;
      scenarioId: string;
      operationalMode: string;
      turns: number;
      completed: boolean;
      verificationReceipt: { receiptHash: string };
    };
    expect(started.investigationId.startsWith('inv_')).toBe(true);
    expect(started.operationalMode).toBe('SIMULATED');
    expect(started.completed).toBe(true);
    expect(started.turns).toBeGreaterThan(0);
    expect(started.verificationReceipt.receiptHash).toBeTruthy();
    const status = (await service.executeTool('traceforge.investigations.status', { investigationId: started.investigationId }, AGENT)) as {
      status: string;
      operationalMode: string;
      probesUsed: number;
      maxToolCalls: number;
    };
    expect(status.status).toBe('completed');
    expect(status.operationalMode).toBe('SIMULATED');
    expect(status.probesUsed).toBeGreaterThan(0);
    expect(status.maxToolCalls).toBe(8);
    const history = (await service.executeTool('traceforge.investigations.history', { scenarioId: started.scenarioId }, AGENT)) as {
      steps: unknown[];
      probeLog: unknown[];
      activitySummary: { total: number };
    };
    expect(history.steps.length).toBeGreaterThan(0);
    expect(history.probeLog.length).toBeGreaterThan(0);
    expect(history.activitySummary.total).toBe(history.probeLog.length);
    const result = (await service.executeTool('traceforge.investigations.result', { scenarioId: started.scenarioId }, AGENT)) as {
      proposedDiagnosis: { componentRef: string; faultType: string; verificationStatus: string };
      verificationStatus: string;
      operationalMode: string;
      diagnosisSource: string;
      telemetry: { totalRequests: number };
    };
    expect(result.proposedDiagnosis.componentRef.length).toBeGreaterThan(0);
    expect(result.verificationStatus).toMatch(/confirmed|hypothesis/);
    expect(result.operationalMode).toBe('SIMULATED');
    expect(result.telemetry.totalRequests).toBeGreaterThan(0);
    expect(leakedKeys(result)).toEqual([]);
  });
});

/* --------------------------------------------------------------- area 10 -- */

describe('10. evaluation scoring and report', () => {
  it('scores 99/100 on f405-nrst-gnd-short with full component and evidence match', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      AGENT,
    )) as { scenarioId: string };
    await service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId }, AGENT);
    const scored = (await service.executeTool('traceforge.evaluation.score', { scenarioId: created.scenarioId }, AGENT)) as {
      score: { totalScore: number; componentMatch: boolean; faultTypeMatch: boolean; evidenceConfirmed: boolean; probeCount: number; efficiencyScore: number; summary: string };
      groundTruth: { faultId: string; targetComponentRef: string; faultType: string; description: string; healthy: boolean };
      verificationReceipt: { receiptHash: string };
    };
    expect(scored.score.totalScore).toBe(99);
    expect(scored.score.componentMatch).toBe(true);
    expect(scored.score.faultTypeMatch).toBe(true);
    expect(scored.score.evidenceConfirmed).toBe(true);
    expect(scored.groundTruth.faultId).toBe('f405-nrst-gnd-short');
    expect(scored.groundTruth.targetComponentRef).toBe('U1');
    expect(scored.groundTruth.healthy).toBe(false);
    expect(scored.verificationReceipt.receiptHash).toBeTruthy();
  });

  it('report requires a prior score and then returns the full audit report', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      AGENT,
    )) as { scenarioId: string };
    await expectToolError(
      service.executeTool('traceforge.evaluation.report', { scenarioId: created.scenarioId }, AGENT),
      'MAAS_INVESTIGATION_INCOMPLETE',
    );
    await service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId }, AGENT);
    await service.executeTool('traceforge.evaluation.score', { scenarioId: created.scenarioId }, AGENT);
    const report = (await service.executeTool('traceforge.evaluation.report', { scenarioId: created.scenarioId }, AGENT)) as {
      circuitSummary: { boardName: string } | null;
      measurementHistory: { probeLog: unknown[] };
      agentDiagnosis: { componentRef: string } | null;
      scorecard: { score: { totalScore: number } };
      reworkGuidance: { note: string; proposedComponent: string | null };
    };
    expect(report.circuitSummary?.boardName).toContain('F405');
    expect(report.measurementHistory.probeLog.length).toBeGreaterThan(0);
    expect(report.agentDiagnosis?.componentRef).toBe('U1');
    expect(report.scorecard.score.totalScore).toBe(99);
    expect(report.reworkGuidance.proposedComponent).toBe('U1');
  });
});

/* --------------------------------------------------------------- area 11 -- */

describe('11. budget restrictions', () => {
  it('blocks live mode without the live scope', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    await expectToolError(
      service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId, mode: 'live' }, AGENT),
      'MAAS_AUTHORIZATION_DENIED',
    );
  });

  it('blocks live mode when cost hits the $95.00 safety threshold', async () => {
    const service = new TraceForgeMaasService({ initialIncurredCostUsd: 96 });
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      OPERATOR,
    )) as { scenarioId: string };
    await expectToolError(
      service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId, mode: 'live' }, OPERATOR),
      'MAAS_BUDGET_THRESHOLD_EXCEEDED',
    );
  });

  it('reports live unavailability instead of spending with a clean ledger', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      OPERATOR,
    )) as { scenarioId: string };
    await expectToolError(
      service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId, mode: 'live' }, OPERATOR),
      'MAAS_UPSTREAM_UNAVAILABLE',
    );
  });

  it('budget.status reports the $147.26 baseline, $100 ceiling, $47.26 reserve, $95 threshold', async () => {
    const service = new TraceForgeMaasService();
    const budget = (await service.executeTool('traceforge.budget.status', {}, {})) as {
      startingBalanceUsd: number;
      authorizedCeilingUsd: number;
      mandatoryReserveUsd: number;
      safetyThresholdUsd: number;
      ledger: { incurredCostUsd: number; projectedLiveCostUsd: number };
    };
    expect(budget.startingBalanceUsd).toBe(147.26);
    expect(budget.authorizedCeilingUsd).toBe(100);
    expect(budget.mandatoryReserveUsd).toBe(47.26);
    expect(budget.safetyThresholdUsd).toBe(95);
    expect(budget.ledger.incurredCostUsd).toBe(0);
  });
});

/* --------------------------------------------------------------- area 12 -- */

describe('12. API errors, rate limiting, and kill switch', () => {
  it('returns MAAS_CAPABILITY_NOT_FOUND for unknown tools and accepts underscore names', async () => {
    const service = new TraceForgeMaasService();
    await expectToolError(service.executeTool('traceforge.nope.missing', {}, AGENT), 'MAAS_CAPABILITY_NOT_FOUND');
    expect(normalizeToolName('traceforge_circuits_list')).toBe('traceforge.circuits.list');
    expect(normalizeToolName('traceforge.circuits.list')).toBe('traceforge.circuits.list');
    const listed = (await service.executeTool('traceforge_circuits_list', {}, {})) as { count: number };
    expect(listed.count).toBe(3);
  });

  it('enforces the sliding-window rate limit with MAAS_RATE_LIMIT_EXCEEDED', async () => {
    const service = new TraceForgeMaasService({ maxRequestsPerWindow: 3 });
    await service.executeTool('traceforge.system.status', {}, AGENT);
    await service.executeTool('traceforge.system.status', {}, AGENT);
    await service.executeTool('traceforge.system.status', {}, AGENT);
    await expectToolError(service.executeTool('traceforge.system.status', {}, AGENT), 'MAAS_RATE_LIMIT_EXCEEDED');
  });

  it('global kill switch halts calls with MAAS_KILL_SWITCH_ACTIVE and releases cleanly', async () => {
    const service = new TraceForgeMaasService();
    service.getKillSwitch().setGlobalKillSwitch(true, 'test halt');
    await expectToolError(service.executeTool('traceforge.system.status', {}, {}), 'MAAS_KILL_SWITCH_ACTIVE');
    service.getKillSwitch().setGlobalKillSwitch(false);
    const status = (await service.executeTool('traceforge.system.status', {}, {})) as { service: string };
    expect(status.service).toBe('traceforge-maas');
  });

  it('supports per-tool disable and token revocation', async () => {
    const service = new TraceForgeMaasService();
    service.getKillSwitch().disableTool('traceforge.system.status');
    await expectToolError(service.executeTool('traceforge.system.status', {}, {}), 'MAAS_KILL_SWITCH_ACTIVE');
    service.getKillSwitch().enableTool('traceforge.system.status');
    service.getKillSwitch().revokeToken('tf_agent_local_token');
    await expectToolError(
      service.executeTool('traceforge.scenarios.create', { boardId: 'f405-flight-controller' }, AGENT),
      'MAAS_CREDENTIALS_REVOKED',
    );
    service.getKillSwitch().restoreToken('tf_agent_local_token');
  });
});

/* --------------------------------------------------------------- area 13 -- */

describe('13. session isolation across actors', () => {
  it('blocks secondary actors from scenarios and investigations they do not own', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'U1-14' }, SECONDARY),
      'MAAS_CROSS_TENANT_ACCESS_DENIED',
    );
    const started = (await service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId }, AGENT)) as {
      investigationId: string;
    };
    await expectToolError(
      service.executeTool('traceforge.investigations.status', { investigationId: started.investigationId }, SECONDARY),
      'MAAS_CROSS_TENANT_ACCESS_DENIED',
    );
    await expectToolError(
      service.executeTool('traceforge.evaluation.report', { scenarioId: created.scenarioId }, SECONDARY),
      'MAAS_CROSS_TENANT_ACCESS_DENIED',
    );
  });
});

/* --------------------------------------------------------------- area 14 -- */

describe('14. simulated vs live model identity and HTTP middleware', () => {
  it('models.status reports SIMULATED spark and STATIC_FIXTURE sam with no key exposure', async () => {
    const service = new TraceForgeMaasService();
    const models = (await service.executeTool('traceforge.models.status', {}, {})) as {
      spark: { model: string; operationalMode: string };
      sam: { model: string; operationalMode: string };
    };
    expect(models.spark.model).toBe('muse-spark-1.3');
    expect(models.spark.operationalMode).toBe('SIMULATED');
    expect(models.sam.model).toBe('sam-3.1');
    expect(models.sam.operationalMode).toBe('STATIC_FIXTURE');
    expect(JSON.stringify(models)).not.toContain('META_API_KEY');
  });

  it('POST /api/mcp tools/call executes underscore names and stamps X-Correlation-Id', async () => {
    const service = new TraceForgeMaasService();
    const { res, out } = capture();
    const handled = await handleMaasMcpRequest(
      {
        method: 'POST',
        url: '/api/mcp',
        headers: {},
        body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'traceforge_system_status', arguments: {} } },
      },
      res,
      service,
    );
    expect(handled).toBe(true);
    expect(out.headers['X-Correlation-Id']).toMatch(/^tf_corr_/);
    const envelope = JSON.parse(out.body) as {
      jsonrpc: string;
      id: number;
      result: { content: Array<{ type: string; text: string }>; structuredContent: { service: string }; isError: boolean };
    };
    expect(envelope.jsonrpc).toBe(JSON_RPC_VERSION);
    expect(envelope.result.isError).toBe(false);
    expect(envelope.result.structuredContent.service).toBe('traceforge-maas');
  });

  it('POST /api/mcp tools/call wraps tool failures in an isError envelope', async () => {
    const service = new TraceForgeMaasService();
    const { res, out } = capture();
    await handleMaasMcpRequest(
      {
        method: 'POST',
        url: '/mcp',
        headers: {},
        body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'traceforge.scenarios.create', arguments: { boardId: 'f405-flight-controller' } } },
      },
      res,
      service,
    );
    const envelope = JSON.parse(out.body) as {
      result: { structuredContent: { code: string }; isError: boolean };
    };
    expect(envelope.result.isError).toBe(true);
    expect(envelope.result.structuredContent.code).toBe('MAAS_AUTHENTICATION_REQUIRED');
  });

  it('serves RFC 9728 metadata, status, catalog, and a scoped audit endpoint', async () => {
    const service = new TraceForgeMaasService();
    await service.executeTool('traceforge.scenarios.create', { boardId: 'f405-flight-controller', faultSelector: 'nominal' }, AGENT);

    const meta = capture();
    expect(await handleMaasMcpRequest({ method: 'GET', url: '/.well-known/oauth-protected-resource', headers: {} }, meta.res, service)).toBe(true);
    const metadata = JSON.parse(meta.out.body) as { scopes_supported: string[]; bearer_methods_supported: string[] };
    expect(metadata.scopes_supported).toContain('traceforge:live_inference:execute');
    expect(metadata.bearer_methods_supported).toContain('header');

    const status = capture();
    expect(await handleMaasMcpRequest({ method: 'GET', url: '/api/maas/status', headers: {} }, status.res, service)).toBe(true);
    expect((JSON.parse(status.out.body) as { mcpProtocolVersion: string }).mcpProtocolVersion).toBe(MCP_PROTOCOL_VERSION);

    const catalog = capture();
    expect(await handleMaasMcpRequest({ method: 'GET', url: '/api/maas/catalog', headers: {} }, catalog.res, service)).toBe(true);
    expect((JSON.parse(catalog.out.body) as { count: number }).count).toBe(18);

    const anonymousAudit = capture();
    expect(await handleMaasMcpRequest({ method: 'GET', url: '/api/maas/audit', headers: {} }, anonymousAudit.res, service)).toBe(true);
    expect(anonymousAudit.res.statusCode).toBe(401);

    const deniedAudit = capture();
    expect(await handleMaasMcpRequest({ method: 'GET', url: '/api/maas/audit', headers: READONLY }, deniedAudit.res, service)).toBe(true);
    expect(deniedAudit.res.statusCode).toBe(403);

    const audit = capture();
    expect(await handleMaasMcpRequest({ method: 'GET', url: '/api/maas/audit', headers: OPERATOR }, audit.res, service)).toBe(true);
    const events = (JSON.parse(audit.out.body) as { events: Array<{ correlationId: string }> }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.correlationId).toMatch(/^tf_corr_/);
    expect(audit.out.body).not.toContain('tf_agent_local_token');
  });

  it('scrubs META_API_KEY, bearer tokens, and known token strings from audit text', () => {
    const scrubbed = sanitizeForAuditText(
      'key=META_API_KEY header="Bearer abc123XYZ" token=tf_agent_local_token done',
      ['tf_agent_local_token'],
    );
    expect(scrubbed).not.toContain('META_API_KEY');
    expect(scrubbed).not.toContain('abc123XYZ');
    expect(scrubbed).not.toContain('tf_agent_local_token');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('creates unique correlation ids and verifies chained receipts', () => {
    const first = createMaasCorrelationId();
    const second = createMaasCorrelationId('tf_corr');
    expect(first).not.toBe(second);
    expect(first.startsWith('tf_corr_')).toBe(true);
    const engine = new TraceForgeVerificationEngine('test-key');
    const receipt = engine.issueReceipt({
      capabilityName: 'traceforge.scenarios.create',
      accessMode: 'execute',
      targetEntityId: 'scn_test',
      postconditionAssertions: ['a'],
      summary: 'test',
    });
    expect(engine.verifyReceipt(receipt)).toBe(true);
    expect(engine.verifyReceipt({ ...receipt, summary: 'tampered' })).toBe(false);
  });
});
