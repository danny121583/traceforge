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
  decryptSignedToken,
  encryptSignedToken,
  maasErrorStatus,
} from '../src/maas/tools';
import { MetaClient } from '../src/lib/meta-client';
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
  it('tools/list returns all 25 tools with names, descriptions, and schemas', async () => {
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
    expect(envelope.result.tools).toHaveLength(25);
    for (const tool of envelope.result.tools) {
      expect(tool.name.startsWith('traceforge.')).toBe(true);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('traceforge.capabilities.list returns all 25 descriptors with schemas, scopes, and annotations', async () => {
    const service = new TraceForgeMaasService();
    const result = (await service.executeTool('traceforge.capabilities.list', {}, {})) as {
      count: number;
      tools: Array<{ name: string; inputSchema: MaasJsonSchema; requiredScope: string | null; annotations: Record<string, boolean> }>;
    };
    expect(result.count).toBe(25);
    expect(result.tools).toHaveLength(25);
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
    expect((JSON.parse(catalog.out.body) as { count: number }).count).toBe(25);

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

/* --------------------------------------------------------------- area 15 -- */

describe('15. session expiration', () => {
  it('rejects expired sessions with MAAS_SESSION_EXPIRED (HTTP 410)', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    service.expireScenarioForTesting(created.scenarioId);
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'U1-14' }, AGENT),
      'MAAS_SESSION_EXPIRED',
    );
    await expectToolError(
      service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId }, AGENT),
      'MAAS_SESSION_EXPIRED',
    );
    await expectToolError(
      service.executeTool('traceforge.evaluation.score', { scenarioId: created.scenarioId }, AGENT),
      'MAAS_SESSION_EXPIRED',
    );
    expect(maasErrorStatus('MAAS_SESSION_EXPIRED')).toBe(410);
  });

  it('expires sessions past a short sessionTtlMs', async () => {
    const service = new TraceForgeMaasService({ sessionTtlMs: 10 });
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'usbc-pd-trigger', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'CC1' }, AGENT),
      'MAAS_SESSION_EXPIRED',
    );
  });

  it('keeps fresh sessions usable under the default 30-minute TTL', async () => {
    const service = new TraceForgeMaasService();
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    const record = service.getScenarioRecord(created.scenarioId);
    expect(record?.expiresAtMs).toBeGreaterThan(Date.now());
    const voltage = (await service.executeTool(
      'traceforge.measurements.voltage',
      { scenarioId: created.scenarioId, node: 'U1-14' },
      AGENT,
    )) as { probesUsed: number };
    expect(voltage.probesUsed).toBe(1);
  });
});

/* --------------------------------------------------------------- area 16 -- */

describe('16. concurrent investigations', () => {
  it('runs two investigations simultaneously with zero state bleed and independent valid scores', async () => {
    const service = new TraceForgeMaasService();
    const [startedA, startedB] = (await Promise.all([
      service.executeTool('traceforge.investigations.start', { boardId: 'f405-flight-controller' }, AGENT),
      service.executeTool('traceforge.investigations.start', { boardId: 'usbc-pd-trigger' }, AGENT),
    ])) as Array<{
      investigationId: string;
      scenarioId: string;
      boardId: string;
      operationalMode: string;
      completed: boolean;
    }>;
    expect(startedA.investigationId).not.toBe(startedB.investigationId);
    expect(startedA.scenarioId).not.toBe(startedB.scenarioId);
    expect(startedA.boardId).toBe('f405-flight-controller');
    expect(startedB.boardId).toBe('usbc-pd-trigger');
    expect(startedA.completed).toBe(true);
    expect(startedB.completed).toBe(true);

    const [historyA, historyB] = (await Promise.all([
      service.executeTool('traceforge.investigations.history', { scenarioId: startedA.scenarioId }, AGENT),
      service.executeTool('traceforge.investigations.history', { scenarioId: startedB.scenarioId }, AGENT),
    ])) as Array<{ probeLog: Array<{ target: string }> }>;
    expect(historyA.probeLog.length).toBeGreaterThan(0);
    expect(historyB.probeLog.length).toBeGreaterThan(0);
    const targetsA = historyA.probeLog.map((p) => p.target).join('|');
    const targetsB = historyB.probeLog.map((p) => p.target).join('|');
    expect(targetsA).not.toContain('CC1');
    expect(targetsA).not.toContain('CC2');
    expect(targetsB).not.toContain('U1-14');
    expect(targetsB).not.toContain('U1-15');

    const [scoredA, scoredB] = (await Promise.all([
      service.executeTool('traceforge.evaluation.score', { scenarioId: startedA.scenarioId }, AGENT),
      service.executeTool('traceforge.evaluation.score', { scenarioId: startedB.scenarioId }, AGENT),
    ])) as Array<{
      score: { totalScore: number; componentMatch: boolean; probeCount: number };
      groundTruth: { faultId: string };
    }>;
    for (const scored of [scoredA, scoredB]) {
      expect(scored.score.totalScore).toBeGreaterThanOrEqual(0);
      expect(scored.score.totalScore).toBeLessThanOrEqual(100);
      expect(scored.score.probeCount).toBeGreaterThan(0);
      expect(typeof scored.score.componentMatch).toBe('boolean');
      expect(scored.groundTruth.faultId.length).toBeGreaterThan(0);
    }
    // Post-evaluation disclosure is by design (owning actor only), and the
    // two boards draw from disjoint fault pools — independent ground truths.
    expect(scoredA.groundTruth.faultId).not.toBe(scoredB.groundTruth.faultId);
    expect(JSON.stringify(scoredB)).not.toContain('hiddenFault');
  });
});

/* --------------------------------------------------------------- area 17 -- */

describe('17. live mode with an injected liveClient', () => {
  it('runs traceforge.investigations.start in live mode and records telemetry', async () => {
    const liveClient = new MetaClient({ mode: 'simulated' });
    const service = new TraceForgeMaasService({ liveClient });
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      OPERATOR,
    )) as { scenarioId: string };
    const started = (await service.executeTool(
      'traceforge.investigations.start',
      { scenarioId: created.scenarioId, mode: 'live' },
      OPERATOR,
    )) as {
      investigationId: string;
      operationalMode: string;
      completed: boolean;
      verificationReceipt: { receiptHash: string };
    };
    expect(started.investigationId.startsWith('inv_')).toBe(true);
    expect(started.completed).toBe(true);
    expect(started.verificationReceipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    const result = (await service.executeTool(
      'traceforge.investigations.result',
      { scenarioId: created.scenarioId },
      OPERATOR,
    )) as {
      proposedDiagnosis: { componentRef: string; faultType: string };
      telemetry: { totalRequests: number; inputTokens: number };
    };
    expect(result.proposedDiagnosis.componentRef.length).toBeGreaterThan(0);
    expect(result.telemetry.totalRequests).toBeGreaterThan(0);
    expect(result.telemetry.inputTokens).toBeGreaterThan(0);
    expect(leakedKeys(result)).toEqual([]);
  });
});

/* --------------------------------------------------------------- area 18 -- */

describe('18. verified billing checkpoint', () => {
  it('budget.status surfaces the $147.26 baseline and the verified $113.63 checkpoint', async () => {
    const service = new TraceForgeMaasService();
    const budget = (await service.executeTool('traceforge.budget.status', {}, {})) as {
      startingBalanceUsd: number;
      authorizedCeilingUsd: number;
      mandatoryReserveUsd: number;
      safetyThresholdUsd: number;
      lastVerifiedBalanceUsd: number;
      lastVerifiedConsumedUsd: number;
      lastVerifiedTimestamp: string;
      verifiedRemainingBudgetUsd: number;
      verifiedNote: string;
      ledgerScopeNote: string;
    };
    expect(budget.startingBalanceUsd).toBe(147.26);
    expect(budget.authorizedCeilingUsd).toBe(100);
    expect(budget.mandatoryReserveUsd).toBe(47.26);
    expect(budget.safetyThresholdUsd).toBe(95);
    expect(budget.lastVerifiedBalanceUsd).toBe(113.63);
    expect(budget.lastVerifiedConsumedUsd).toBe(33.63);
    expect(budget.lastVerifiedTimestamp).toBe('2026-10-27T00:40:47-05:00');
    expect(budget.verifiedRemainingBudgetUsd).toBeCloseTo(66.37, 2);
    expect(budget.verifiedNote).toContain('$113.63');
    expect(budget.verifiedNote).toContain('$33.63');
    expect(budget.ledgerScopeNote).toContain('lastVerifiedConsumedUsd');
  });
});

/* --------------------------------------------------------------- area 19 -- */

function stubLiveClient(onCall: () => void): MetaClient {
  return new MetaClient({
    mode: 'live',
    apiKey: 'tf-test-live-key',
    segmentationMode: 'static_fixture',
    fetchFn: async () => {
      onCall();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: 'Stubbed live reasoning. FINAL_DIAGNOSIS: {"componentRef":"U1","faultType":"solder_bridge","verificationStatus":"confirmed","explanation":"Stubbed live verdict."}',
            },
          }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        }),
      };
    },
  });
}

describe('19. explicit live-AI spending control', () => {
  it("omitted mode defaults to simulated ($0.00) even when a liveClient is attached", async () => {
    let liveCalls = 0;
    const service = new TraceForgeMaasService({ liveClient: stubLiveClient(() => { liveCalls += 1; }) });
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      OPERATOR,
    )) as { scenarioId: string };
    const started = (await service.executeTool(
      'traceforge.investigations.start',
      { scenarioId: created.scenarioId },
      OPERATOR,
    )) as { operationalMode: string; executionSource: string; completed: boolean };
    expect(started.completed).toBe(true);
    expect(started.operationalMode).toBe('SIMULATED');
    expect(started.executionSource).toBe('Deterministic Virtual Lab');
    expect(liveCalls).toBe(0);
  });

  it('explicit mode live invokes the liveClient and records LIVE_API telemetry', async () => {
    let liveCalls = 0;
    const service = new TraceForgeMaasService({ liveClient: stubLiveClient(() => { liveCalls += 1; }) });
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      OPERATOR,
    )) as { scenarioId: string };
    const started = (await service.executeTool(
      'traceforge.investigations.start',
      { scenarioId: created.scenarioId, mode: 'live' },
      OPERATOR,
    )) as { operationalMode: string; executionSource: string };
    expect(started.operationalMode).toBe('LIVE_API');
    expect(started.executionSource).toBe('Live Muse Spark 1.3');
    expect(liveCalls).toBeGreaterThan(0);
  });

  it('read-only models.status NEVER invokes live inference', async () => {
    let liveCalls = 0;
    const service = new TraceForgeMaasService({ liveClient: stubLiveClient(() => { liveCalls += 1; }) });
    const before = (await service.executeTool('traceforge.models.status', {}, OPERATOR)) as {
      spark: { operationalMode: string; liveVerified: boolean; executionSource: string; liveCredentialConfigured: boolean };
    };
    expect(liveCalls).toBe(0);
    expect(before.spark.operationalMode).toBe('UNVERIFIED');
    expect(before.spark.liveVerified).toBe(false);
    expect(before.spark.executionSource).toBe('Live Muse Spark 1.3');
    expect(before.spark.liveCredentialConfigured).toBe(true);

    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      OPERATOR,
    )) as { scenarioId: string };
    await service.executeTool('traceforge.investigations.start', { scenarioId: created.scenarioId, mode: 'live' }, OPERATOR);
    expect(liveCalls).toBeGreaterThan(0);
    const after = (await service.executeTool('traceforge.models.status', {}, OPERATOR)) as {
      spark: { operationalMode: string; liveVerified: boolean };
    };
    expect(after.spark.operationalMode).toBe('LIVE_API');
    expect(after.spark.liveVerified).toBe(true);
  });

  it('enforces the $95.00 safety stop against verified + runtime spend', async () => {
    // $33.63 verified + $60.00 runtime = $93.63 < $95.00: not breached yet.
    const service = new TraceForgeMaasService({ initialIncurredCostUsd: 60 });
    expect(service.isBudgetSafetyBreached()).toBe(false);
    service.injectLiveSpendForTesting(25.5);
    expect(service.isBudgetSafetyBreached()).toBe(true);
    const budget = (await service.executeTool('traceforge.budget.status', {}, {})) as {
      safetyThresholdBreached: boolean;
      ledger: { incurredCostUsd: number };
    };
    expect(budget.safetyThresholdBreached).toBe(true);
    expect(budget.ledger.incurredCostUsd).toBeCloseTo(85.5, 6);
  });

  it('recordExternalLiveUsage feeds the shared runtime ledger', async () => {
    const service = new TraceForgeMaasService();
    service.recordExternalLiveUsage({ inputTokens: 1000, outputTokens: 500, providerReported: true });
    const budget = (await service.executeTool('traceforge.budget.status', {}, {})) as {
      ledger: { incurredCostUsd: number; inputTokens: number; outputTokens: number; totalRequests: number };
    };
    expect(budget.ledger.totalRequests).toBe(1);
    expect(budget.ledger.inputTokens).toBe(1000);
    expect(budget.ledger.outputTokens).toBe(500);
    expect(budget.ledger.incurredCostUsd).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- area 20 -- */

describe('20. AES-256-GCM session tokens', () => {
  const SECRET = 'tf-test-session-secret-v2';

  it('encrypts to the scn_/inv_ format with a randomized IV', async () => {
    const payload = { b: 0, f: 0, o: 'actor_test', x: 123, q: 1 };
    const first = await encryptSignedToken('scn_', payload, SECRET);
    const second = await encryptSignedToken('scn_', payload, SECRET);
    expect(first).toMatch(/^(scn|inv)_[0-9a-f]+_[0-9a-f]{64}$/);
    expect(second).toMatch(/^(scn|inv)_[0-9a-f]+_[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(await decryptSignedToken('scn_', first, SECRET)).toEqual(payload);
    expect(await decryptSignedToken('scn_', second, SECRET)).toEqual(payload);
    const inv = await encryptSignedToken('inv_', { s: 'x', o: 'y', q: 2 }, SECRET);
    expect(inv).toMatch(/^inv_[0-9a-f]+_[0-9a-f]{64}$/);
  });

  it('produces distinct 96-bit IVs and ciphertexts for identical payloads (IND-CPA, zero nonce reuse)', async () => {
    const payload = { s: 'scn_alpha', o: 'actor_test', q: 1 };
    const tokenA = await encryptSignedToken('inv_', payload, SECRET);
    const tokenB = await encryptSignedToken('inv_', payload, SECRET);
    expect(tokenA).toMatch(/^inv_[0-9a-f]+_[0-9a-f]{64}$/);
    expect(tokenB).toMatch(/^inv_[0-9a-f]+_[0-9a-f]{64}$/);
    // Distinct 96-bit IVs: first 24 hex chars after the prefix differ.
    const ivHexA = tokenA.slice('inv_'.length, 'inv_'.length + 24);
    const ivHexB = tokenB.slice('inv_'.length, 'inv_'.length + 24);
    expect(ivHexA).toMatch(/^[0-9a-f]{24}$/);
    expect(ivHexB).toMatch(/^[0-9a-f]{24}$/);
    expect(ivHexA).not.toBe(ivHexB);
    // Distinct ciphertexts overall, both decrypting to the identical payload.
    expect(tokenA).not.toBe(tokenB);
    expect(await decryptSignedToken('inv_', tokenA, SECRET)).toEqual(payload);
    expect(await decryptSignedToken('inv_', tokenB, SECRET)).toEqual(payload);
  });

  it('rejects 1-bit modifications, truncation, wrong secret, and prefix swaps (256-bit HMAC + 128-bit GCM)', async () => {
    const token = await encryptSignedToken('scn_', { b: 0, f: 0, o: 'actor_test', x: 1, q: 1 }, SECRET);
    const hex = token.slice('scn_'.length, token.lastIndexOf('_'));
    const suffix = token.slice(token.lastIndexOf('_'));
    // 1-bit modification of the ciphertext hex (single hex char flip).
    const flipIndex = 30;
    const flippedChar = hex[flipIndex] === 'a' ? 'b' : 'a';
    const flipped = `scn_${hex.slice(0, flipIndex)}${flippedChar}${hex.slice(flipIndex + 1)}${suffix}`;
    expect(await decryptSignedToken('scn_', flipped, SECRET)).toBeNull();
    // 1-bit modification of the 64-char HMAC tag (last hex char flip).
    const tagFlipped = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(await decryptSignedToken('scn_', tagFlipped, SECRET)).toBeNull();
    // Truncation and wrong secret.
    expect(await decryptSignedToken('scn_', token.slice(0, token.length - 10), SECRET)).toBeNull();
    expect(await decryptSignedToken('scn_', token, 'wrong-secret')).toBeNull();
    // Prefix swap: additionalData binding rejects the foreign prefix.
    expect(await decryptSignedToken('inv_', token, SECRET)).toBeNull();
  });

  it('converges cold isolates sharing durable/edge storage on the same investigationId', async () => {
    const store = new Map<string, string>();
    const holder = globalThis as unknown as { caches?: unknown };
    const previous = holder.caches;
    holder.caches = {
      default: {
        async match(key: string): Promise<{ json(): Promise<unknown> } | undefined> {
          const raw = store.get(key);
          if (raw === undefined) return undefined;
          return { async json() { return JSON.parse(raw) as unknown; } };
        },
        async put(key: string, response: Response): Promise<void> {
          store.set(key, await response.text());
        },
      },
    };
    try {
      const sharedSecret = 'tf-test-converge-secret-v3';
      const isoA = new TraceForgeMaasService();
      isoA.configureSessionSecret(sharedSecret);
      const isoB = new TraceForgeMaasService();
      isoB.configureSessionSecret(sharedSecret);
      const created = (await isoA.executeTool(
        'traceforge.scenarios.create',
        { boardId: 'usbc-pd-trigger', faultSelector: 'scenario-0' },
        AGENT,
      )) as { scenarioId: string };
      const started = (await isoA.executeTool(
        'traceforge.investigations.start',
        { scenarioId: created.scenarioId },
        AGENT,
      )) as { investigationId: string };
      expect(started.investigationId).toMatch(/^inv_[0-9a-f]+_[0-9a-f]{64}$/);
      const status = (await isoB.executeTool(
        'traceforge.investigations.status',
        { scenarioId: created.scenarioId },
        AGENT,
      )) as { investigationId: string };
      const result = (await isoB.executeTool(
        'traceforge.investigations.result',
        { scenarioId: created.scenarioId },
        AGENT,
      )) as { investigationId: string };
      expect(status.investigationId).toBe(started.investigationId);
      expect(result.investigationId).toBe(started.investigationId);
    } finally {
      holder.caches = previous;
    }
  });

  it('rejects rotated-secret tokens on cold-isolate hydration', async () => {
    const serviceA = new TraceForgeMaasService();
    const created = (await serviceA.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
      AGENT,
    )) as { scenarioId: string };
    // Same isolate still serves the in-memory record after rotation.
    serviceA.rotateSessionSecret('tf-rotated-secret-v2');
    const same = (await serviceA.executeTool(
      'traceforge.measurements.voltage',
      { scenarioId: created.scenarioId, node: 'U1-14' },
      AGENT,
    )) as { volts: number };
    expect(typeof same.volts).toBe('number');
    // A cold isolate holding only the new secret cannot hydrate the token.
    const cold = new TraceForgeMaasService();
    cold.rotateSessionSecret('tf-rotated-secret-v2');
    await expectToolError(
      cold.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'U1-14' }, AGENT),
      'MAAS_RESOURCE_NOT_FOUND',
    );
  });

  it('isolates OAuth clients per actorId with scoped access and revocation', async () => {
    const service = new TraceForgeMaasService();
    const fullScopes = [
      'traceforge:discovery:read',
      'traceforge:circuits:read',
      'traceforge:scenarios:read',
      'traceforge:scenarios:write',
      'traceforge:measurements:read',
      'traceforge:measurements:execute',
      'traceforge:investigations:read',
      'traceforge:investigations:execute',
      'traceforge:evaluation:score',
    ];
    service.getAuthenticator().registerDynamicToken({
      token: 'tf_oauth_client_a_token',
      actorId: 'actor_oauth_clientA',
      role: 'agent',
      scopes: fullScopes,
    });
    service.getAuthenticator().registerDynamicToken({
      token: 'tf_oauth_client_b_token',
      actorId: 'actor_oauth_clientB',
      role: 'agent',
      scopes: fullScopes,
    });
    const headersA = { authorization: 'Bearer tf_oauth_client_a_token' };
    const headersB = { authorization: 'Bearer tf_oauth_client_b_token' };
    const created = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'esp32s3-sensor-node', faultSelector: 'nominal' },
      headersA,
    )) as { scenarioId: string };
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'TP_5V' }, headersB),
      'MAAS_CROSS_TENANT_ACCESS_DENIED',
    );
    const own = (await service.executeTool(
      'traceforge.measurements.voltage',
      { scenarioId: created.scenarioId, node: 'TP_5V' },
      headersA,
    )) as { volts: number };
    expect(typeof own.volts).toBe('number');

    // Scope enforcement: a discovery-only token cannot create scenarios.
    service.getAuthenticator().registerDynamicToken({
      token: 'tf_oauth_narrow_token',
      actorId: 'actor_oauth_narrow',
      role: 'readonly',
      scopes: ['traceforge:discovery:read'],
    });
    await expectToolError(
      service.executeTool(
        'traceforge.scenarios.create',
        { boardId: 'esp32s3-sensor-node' },
        { authorization: 'Bearer tf_oauth_narrow_token' },
      ),
      'MAAS_AUTHORIZATION_DENIED',
    );

    // Revocation: the revoked token fails with MAAS_CREDENTIALS_REVOKED.
    service.getKillSwitch().revokeToken('tf_oauth_client_a_token');
    await expectToolError(
      service.executeTool('traceforge.measurements.voltage', { scenarioId: created.scenarioId, node: 'TP_5V' }, headersA),
      'MAAS_CREDENTIALS_REVOKED',
    );
    service.getKillSwitch().restoreToken('tf_oauth_client_a_token');
  });
});

/* --------------------------------------------------------------- area 21 -- */

describe('21. all-3-board fault matrix end to end', () => {
  const MATRIX: Array<{ boardId: string; faultId: string; voltageNode: string; currentComponent: string; continuity: [string, string] }> = [
    { boardId: 'f405-flight-controller', faultId: 'f405-nrst-gnd-short', voltageNode: 'U1-14', currentComponent: 'R_LOAD', continuity: ['U1-14', 'GND'] },
    { boardId: 'f405-flight-controller', faultId: 'f405-pullup-open', voltageNode: 'TP_NRST', currentComponent: 'R_LOAD', continuity: ['TP_3V3', 'GND'] },
    { boardId: 'f405-flight-controller', faultId: 'f405-pullup-drift', voltageNode: 'U1-15', currentComponent: 'R_PULLUP', continuity: ['U1-14', 'GND'] },
    { boardId: 'esp32s3-sensor-node', faultId: 'esp32-c4-rev-leak', voltageNode: 'TP_5V', currentComponent: 'R_LOAD', continuity: ['C4-POS', 'GND'] },
    { boardId: 'esp32s3-sensor-node', faultId: 'esp32-f1-blown', voltageNode: 'U2-OUT', currentComponent: 'F1', continuity: ['TP_5V', 'GND'] },
    { boardId: 'esp32s3-sensor-node', faultId: 'esp32-div-drift', voltageNode: 'TP_5V', currentComponent: 'R_DIV1', continuity: ['C4-POS', 'GND'] },
    { boardId: 'usbc-pd-trigger', faultId: 'usbc-d2-shorted', voltageNode: 'CC1', currentComponent: 'R_PU1', continuity: ['CC1', 'CC2'] },
    { boardId: 'usbc-pd-trigger', faultId: 'usbc-cc1-pu-open', voltageNode: 'CC2', currentComponent: 'R_RD1', continuity: ['CC1', 'CC2'] },
    { boardId: 'usbc-pd-trigger', faultId: 'usbc-rd-drift', voltageNode: 'CC1', currentComponent: 'R_PU2', continuity: ['CC2', 'GND'] },
  ];

  for (const entry of MATRIX) {
    it(`${entry.boardId} / ${entry.faultId}: MCP tools match local MNA end to end`, async () => {
      const service = new TraceForgeMaasService();
      const created = (await service.executeTool(
        'traceforge.scenarios.create',
        { boardId: entry.boardId, faultSelector: entry.faultId },
        AGENT,
      )) as { scenarioId: string; boardId: string };
      expect(created.scenarioId).toMatch(/^scn_[0-9a-f]+_[0-9a-f]{64}$/);
      expect(created.boardId).toBe(entry.boardId);

      const localSession = createVirtualSession(entry.boardId, entry.faultId);
      const localVolts = localSession.measureVoltage(entry.voltageNode).volts;
      const localAmps = localSession.measureCurrent(entry.currentComponent).amps;
      const volts = (await service.executeTool(
        'traceforge.measurements.voltage',
        { scenarioId: created.scenarioId, node: entry.voltageNode },
        AGENT,
      )) as { volts: number; abnormal: boolean };
      expect(volts.volts).toBeCloseTo(localVolts, 9);

      const current = (await service.executeTool(
        'traceforge.measurements.current',
        { scenarioId: created.scenarioId, componentId: entry.currentComponent },
        AGENT,
      )) as { amps: number };
      expect(current.amps).toBeCloseTo(localAmps, 9);

      const continuity = (await service.executeTool(
        'traceforge.measurements.continuity',
        { scenarioId: created.scenarioId, probeA: entry.continuity[0], probeB: entry.continuity[1] },
        AGENT,
      )) as { continuous: boolean };
      expect(typeof continuity.continuous).toBe('boolean');

      const started = (await service.executeTool(
        'traceforge.investigations.start',
        { scenarioId: created.scenarioId },
        AGENT,
      )) as { investigationId: string; operationalMode: string; completed: boolean };
      expect(started.investigationId).toMatch(/^inv_[0-9a-f]+_[0-9a-f]{64}$/);
      expect(started.operationalMode).toBe('SIMULATED');
      expect(started.completed).toBe(true);

      const result = (await service.executeTool(
        'traceforge.investigations.result',
        { scenarioId: created.scenarioId },
        AGENT,
      )) as { proposedDiagnosis: { componentRef: string; faultType: string } };
      expect(result.proposedDiagnosis.componentRef.length).toBeGreaterThan(0);
      expect(leakedKeys(result)).toEqual([]);

      const score = (await service.executeTool(
        'traceforge.evaluation.score',
        { scenarioId: created.scenarioId },
        AGENT,
      )) as { score: { totalScore: number } | null; groundTruth: { faultId?: string } };
      expect(score.score === null || typeof score.score.totalScore === 'number').toBe(true);

      const report = (await service.executeTool(
        'traceforge.evaluation.report',
        { scenarioId: created.scenarioId },
        AGENT,
      )) as { scenarioId: string; boardId: string };
      expect(report.scenarioId).toBe(created.scenarioId);
      expect(report.boardId).toBe(entry.boardId);
    });
  }
});

/* --------------------------------------------------------------- area 22 -- */

describe('22. cross-isolate MCP session consistency', () => {
  /**
   * Shared mock `caches.default`: every `TraceForgeMaasService` instance is
   * an independent Worker isolate (own in-memory Maps); the mock Edge Cache
   * plus the shared session secret is the ONLY shared state — exactly the
   * production cross-isolate model.
   */
  const SHARED_ISOLATE_SECRET = 'tf-test-shared-isolate-secret-v1';

  function installSharedEdgeCache(): { store: Map<string, string>; uninstall: () => void } {
    const store = new Map<string, string>();
    const holder = globalThis as unknown as { caches?: unknown };
    const previous = holder.caches;
    holder.caches = {
      default: {
        async match(key: string): Promise<{ json(): Promise<unknown> } | undefined> {
          const raw = store.get(key);
          if (raw === undefined) return undefined;
          return { async json() { return JSON.parse(raw) as unknown; } };
        },
        async put(key: string, response: Response): Promise<void> {
          store.set(key, await response.text());
        },
      },
    };
    return {
      store,
      uninstall: () => {
        holder.caches = previous;
      },
    };
  }

  function freshIsolate(): TraceForgeMaasService {
    const service = new TraceForgeMaasService();
    service.configureSessionSecret(SHARED_ISOLATE_SECRET);
    return service;
  }

  it('Defects A & B: probes accumulate across isolates with monotonic probesUsed and ordered history', async () => {
    const { uninstall } = installSharedEdgeCache();
    try {
      const isoA = freshIsolate();
      const isoB = freshIsolate();
      const isoC = freshIsolate();
      const created = (await isoA.executeTool(
        'traceforge.scenarios.create',
        { boardId: 'usbc-pd-trigger', faultSelector: 'scenario-0' },
        AGENT,
      )) as { scenarioId: string };
      const { scenarioId } = created;

      const voltage = (await isoA.executeTool(
        'traceforge.measurements.voltage',
        { scenarioId, node: 'TP_CC1' },
        AGENT,
      )) as { probesUsed: number };
      expect(voltage.probesUsed).toBe(1);

      // Fresh isolate B must observe 1 committed probe and count 2, not 1.
      const current = (await isoB.executeTool(
        'traceforge.measurements.current',
        { scenarioId, componentId: 'R_PU1' },
        AGENT,
      )) as { probesUsed: number };
      expect(current.probesUsed).toBe(2);

      const continuity = (await isoC.executeTool(
        'traceforge.measurements.continuity',
        { scenarioId, probeA: 'TP_CC1', probeB: 'GND' },
        AGENT,
      )) as { probesUsed: number };
      expect(continuity.probesUsed).toBe(3);

      // The ORIGINAL isolate A refreshes stale in-memory state from Edge Cache.
      const history = (await isoA.executeTool(
        'traceforge.measurements.history',
        { scenarioId },
        AGENT,
      )) as { probesUsed: number; probeLog: Array<{ kind: string; target: string }> };
      expect(history.probesUsed).toBe(3);
      expect(history.probeLog.map((p) => p.kind)).toEqual(['voltage', 'current', 'resistance']);
      expect(history.probeLog.map((p) => p.target)).toEqual(['TP_CC1', 'R_PU1', 'TP_CC1↔GND']);
    } finally {
      uninstall();
    }
  });

  it('failed probes never consume budget and never persist state', async () => {
    const { uninstall } = installSharedEdgeCache();
    try {
      const isoA = freshIsolate();
      const isoB = freshIsolate();
      const created = (await isoA.executeTool(
        'traceforge.scenarios.create',
        { boardId: 'usbc-pd-trigger', faultSelector: 'scenario-0' },
        AGENT,
      )) as { scenarioId: string };
      const { scenarioId } = created;
      await isoA.executeTool('traceforge.measurements.voltage', { scenarioId, node: 'TP_CC1' }, AGENT);

      await expectToolError(
        isoB.executeTool('traceforge.measurements.voltage', { scenarioId, node: 'NON_EXISTENT_NODE' }, AGENT),
        'MAAS_RESOURCE_NOT_FOUND',
      );
      await expectToolError(
        isoB.executeTool('traceforge.measurements.continuity', { scenarioId, probeA: 'TP_CC1', probeB: 'TP_CC1' }, AGENT),
        'MAAS_INVALID_REQUEST',
      );

      const history = (await isoA.executeTool(
        'traceforge.measurements.history',
        { scenarioId },
        AGENT,
      )) as { probesUsed: number; probeLog: unknown[] };
      expect(history.probesUsed).toBe(1);
      expect(history.probeLog).toHaveLength(1);
    } finally {
      uninstall();
    }
  });

  it('Defect C: one stable investigationId across isolates for start/status/history/result', async () => {
    const { uninstall } = installSharedEdgeCache();
    try {
      const isoA = freshIsolate();
      const isoB = freshIsolate();
      const isoC = freshIsolate();
      const isoD = freshIsolate();
      const created = (await isoA.executeTool(
        'traceforge.scenarios.create',
        { boardId: 'usbc-pd-trigger', faultSelector: 'scenario-0' },
        AGENT,
      )) as { scenarioId: string };
      const { scenarioId } = created;

      const started = (await isoA.executeTool(
        'traceforge.investigations.start',
        { scenarioId },
        AGENT,
      )) as { investigationId: string; probesUsed: number; turns: number };
      expect(started.investigationId).toMatch(/^inv_[0-9a-f]+_[0-9a-f]{64}$/);

      const status = (await isoB.executeTool(
        'traceforge.investigations.status',
        { scenarioId },
        AGENT,
      )) as { investigationId: string; turns: number; probesUsed: number };
      const history = (await isoC.executeTool(
        'traceforge.investigations.history',
        { scenarioId },
        AGENT,
      )) as { investigationId: string; probeLog: unknown[] };
      const result = (await isoD.executeTool(
        'traceforge.investigations.result',
        { scenarioId },
        AGENT,
      )) as { investigationId: string; proposedDiagnosis: { componentRef: string; faultType: string } };

      expect(status.investigationId).toBe(started.investigationId);
      expect(history.investigationId).toBe(started.investigationId);
      expect(result.investigationId).toBe(started.investigationId);
      expect(status.turns).toBe(started.turns);
      expect(status.probesUsed).toBe(started.probesUsed);
      expect(result.proposedDiagnosis.componentRef.length).toBeGreaterThan(0);
      expect(leakedKeys(result)).toEqual([]);
    } finally {
      uninstall();
    }
  });

  it('Defect C (cold edge): two cold isolates sharing durable/edge storage converge on one investigationId', async () => {
    // Create with NO shared cache, then install a SHARED one: the first cold
    // isolate mints a fresh random-IV `inv_...` token and persists it, and the
    // second cold isolate reuses it from durable/edge storage.
    const solo = freshIsolate();
    const created = (await solo.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'usbc-pd-trigger', faultSelector: 'scenario-0' },
      AGENT,
    )) as { scenarioId: string };
    const { scenarioId } = created;

    const { uninstall } = installSharedEdgeCache();
    try {
      const coldB = freshIsolate();
      const status = (await coldB.executeTool(
        'traceforge.investigations.status',
        { scenarioId },
        AGENT,
      )) as { investigationId: string };
      expect(status.investigationId).toMatch(/^inv_[0-9a-f]+_[0-9a-f]{64}$/);

      // C shares the same durable/edge storage B persisted to: it must reuse
      // B's canonical investigationId rather than minting a new random one.
      const coldC = freshIsolate();
      const result = (await coldC.executeTool(
        'traceforge.investigations.result',
        { scenarioId },
        AGENT,
      )) as { investigationId: string; proposedDiagnosis: { componentRef: string } };
      expect(result.investigationId).toBe(status.investigationId);
      expect(result.proposedDiagnosis.componentRef.length).toBeGreaterThan(0);
    } finally {
      uninstall();
    }
  });

  it('Defect D: evaluation.score and evaluation.report agree on one immutable scorecard', async () => {
    const { uninstall } = installSharedEdgeCache();
    try {
      const isoA = freshIsolate();
      const isoB = freshIsolate();
      const isoC = freshIsolate();
      const isoD = freshIsolate();
      const created = (await isoA.executeTool(
        'traceforge.scenarios.create',
        { boardId: 'usbc-pd-trigger', faultSelector: 'scenario-0' },
        AGENT,
      )) as { scenarioId: string };
      const { scenarioId } = created;

      const manual = (await isoA.executeTool(
        'traceforge.measurements.voltage',
        { scenarioId, node: 'TP_CC1' },
        AGENT,
      )) as { probesUsed: number };
      expect(manual.probesUsed).toBe(1);
      const started = (await isoA.executeTool(
        'traceforge.investigations.start',
        { scenarioId },
        AGENT,
      )) as { probesUsed: number };

      const scored = (await isoB.executeTool(
        'traceforge.evaluation.score',
        { scenarioId },
        AGENT,
      )) as {
        score: { totalScore: number; probeCount: number; efficiencyScore: number; summary: string };
        groundTruth: { faultId: string };
      };
      expect(scored.score.probeCount).toBe(started.probesUsed);
      expect(scored.score.probeCount).toBeGreaterThan(1);

      // Report on a DIFFERENT isolate returns the exact same scorecard.
      const report = (await isoC.executeTool(
        'traceforge.evaluation.report',
        { scenarioId },
        AGENT,
      )) as {
        scorecard: { score: { totalScore: number; probeCount: number; efficiencyScore: number; summary: string } };
        measurementHistory: { probeLog: unknown[] };
      };
      expect(report.scorecard).toEqual({
        scenarioId,
        score: scored.score,
        groundTruth: scored.groundTruth,
        verificationReceipt: expect.anything(),
      });
      expect(report.scorecard.score.totalScore).toBe(scored.score.totalScore);
      expect(report.measurementHistory.probeLog).toHaveLength(scored.score.probeCount);

      // Re-scoring anywhere returns the identical immutable scorecard.
      const rescored = (await isoD.executeTool(
        'traceforge.evaluation.score',
        { scenarioId },
        AGENT,
      )) as { score: { totalScore: number } };
      expect(rescored.score.totalScore).toBe(scored.score.totalScore);
      const rereported = (await isoD.executeTool(
        'traceforge.evaluation.report',
        { scenarioId },
        AGENT,
      )) as { scorecard: { score: { totalScore: number } } };
      expect(rereported.scorecard.score.totalScore).toBe(scored.score.totalScore);

      // The locked scenario rejects further probing on every isolate.
      await expectToolError(
        isoD.executeTool('traceforge.measurements.voltage', { scenarioId, node: 'TP_CC2' }, AGENT),
        'MAAS_SESSION_ALREADY_EVALUATED',
      );
      await expectToolError(
        isoA.executeTool('traceforge.measurements.current', { scenarioId, componentId: 'R_PU1' }, AGENT),
        'MAAS_SESSION_ALREADY_EVALUATED',
      );
    } finally {
      uninstall();
    }
  });

  it('scenarios.list is consistent across isolates while isolating actors', async () => {
    const { uninstall } = installSharedEdgeCache();
    try {
      const isoA = freshIsolate();
      const isoB = freshIsolate();
      const created = (await isoA.executeTool(
        'traceforge.scenarios.create',
        { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
        AGENT,
      )) as { scenarioId: string };

      const listed = (await isoB.executeTool('traceforge.scenarios.list', {}, AGENT)) as {
        mySessions: Array<{ scenarioId: string; evaluated: boolean }>;
      };
      expect(listed.mySessions.map((s) => s.scenarioId)).toContain(created.scenarioId);

      const foreign = (await isoB.executeTool('traceforge.scenarios.list', {}, SECONDARY)) as {
        mySessions: Array<{ scenarioId: string }>;
      };
      expect(foreign.mySessions.map((s) => s.scenarioId)).not.toContain(created.scenarioId);
    } finally {
      uninstall();
    }
  });
});

/* --------------------------------------------------------------- area 23 -- */

const CHAT_TOOL_NAMES = [
  'traceforge.kb.search',
  'traceforge.chat.status',
  'traceforge.chat.start',
  'traceforge.chat.ask',
  'traceforge.chat.history',
  'traceforge.chat.clear',
  'traceforge.chat.feedback',
];

describe('23. assistant & knowledge base tools (25-tool catalog)', () => {
  it('exposes all 7 chat/kb tools with schemas, scopes, and annotations', async () => {
    const service = new TraceForgeMaasService();
    const result = (await service.executeTool('traceforge.capabilities.list', {}, {})) as {
      count: number;
      tools: Array<{ name: string; requiredScope: string | null; annotations: { readOnlyHint: boolean } }>;
    };
    expect(result.count).toBe(25);
    const byName = new Map(result.tools.map((t) => [t.name, t]));
    for (const name of CHAT_TOOL_NAMES) {
      expect(byName.has(name)).toBe(true);
    }
    expect(byName.get('traceforge.kb.search')?.requiredScope).toBe(null);
    expect(byName.get('traceforge.chat.status')?.requiredScope).toBe(null);
    expect(byName.get('traceforge.chat.start')?.requiredScope).toBe('traceforge:discovery:read');
    expect(byName.get('traceforge.chat.ask')?.requiredScope).toBe('traceforge:discovery:read');
    expect(byName.get('traceforge.chat.history')?.requiredScope).toBe('traceforge:discovery:read');
    expect(byName.get('traceforge.chat.clear')?.requiredScope).toBe('traceforge:discovery:read');
    expect(byName.get('traceforge.chat.feedback')?.requiredScope).toBe('traceforge:discovery:read');
    expect(byName.get('traceforge.kb.search')?.annotations.readOnlyHint).toBe(true);
    expect(byName.get('traceforge.chat.status')?.annotations.readOnlyHint).toBe(true);
    expect(byName.get('traceforge.chat.ask')?.annotations.readOnlyHint).toBe(false);
  });

  it('serves kb.search and chat.status without a token; chat tools require auth', async () => {
    const service = new TraceForgeMaasService();
    const kb = (await service.executeTool('traceforge.kb.search', { query: 'What does NRST mean?' }, {})) as {
      kbVersion: string; coverage: string; answer: string; sources: unknown[]; liveInvoked: boolean; incurredCostUsd: number;
    };
    expect(kb.kbVersion).toBe('2026.10.27-v4');
    expect(kb.answer.length).toBeGreaterThan(0);
    expect(kb.sources.length).toBeGreaterThan(0);
    expect(kb.liveInvoked).toBe(false);
    expect(kb.incurredCostUsd).toBe(0);

    const status = (await service.executeTool('traceforge.chat.status', {}, {})) as {
      kbVersion: string; topicCount: number; liveUsage: { allowanceUsd: number }; limits: Record<string, number>;
      activeConversationCount: number; feedbackCount: number; suggestedQuestions: string[];
    };
    expect(status.kbVersion).toBe('2026.10.27-v4');
    expect(status.topicCount).toBe(18);
    expect(status.liveUsage.allowanceUsd).toBe(2);
    expect(status.limits['maxLiveCallsPerSession']).toBe(10);
    expect(status.suggestedQuestions.length).toBeGreaterThan(0);

    await expectToolError(service.executeTool('traceforge.chat.start', {}, {}), 'MAAS_AUTHENTICATION_REQUIRED');
    await expectToolError(
      service.executeTool('traceforge.chat.ask', { message: 'Hello?' }, {}),
      'MAAS_AUTHENTICATION_REQUIRED',
    );
  });

  it('runs the full conversation lifecycle with scenario grounding and no leakage', async () => {
    const service = new TraceForgeMaasService();
    const scenario = (await service.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      AGENT,
    )) as { scenarioId: string };
    await service.executeTool(
      'traceforge.measurements.voltage',
      { scenarioId: scenario.scenarioId, node: 'TP_NRST' },
      AGENT,
    );

    const started = (await service.executeTool(
      'traceforge.chat.start',
      { scenarioId: scenario.scenarioId, title: 'lifecycle probe' },
      AGENT,
    )) as {
      conversationId: string; ownerActorId: string; scenarioId: string; sessionTicket: string;
      kbVersion: string; suggestedQuestions: string[]; messageCount: number;
    };
    expect(started.conversationId.startsWith('conv_')).toBe(true);
    expect(started.ownerActorId).toBe('actor_chatgpt_agent');
    expect(started.scenarioId).toBe(scenario.scenarioId);
    expect(started.sessionTicket.startsWith('tf_chat_')).toBe(true);
    expect(started.kbVersion).toBe('2026.10.27-v4');
    expect(started.messageCount).toBe(0);

    const first = (await service.executeTool(
      'traceforge.chat.ask',
      { conversationId: started.conversationId, message: 'What did I measure in this session?' },
      AGENT,
    )) as {
      conversationId: string; reply: string; sources: Array<{ entryId: string }>; mode: string;
      liveInvoked: boolean; kbVersion: string; incurredCostUsd: number; messageCount: number;
    };
    expect(first.conversationId).toBe(started.conversationId);
    expect(first.reply).toContain('TP_NRST');
    expect(first.liveInvoked).toBe(false);
    expect(first.incurredCostUsd).toBe(0);
    expect(first.messageCount).toBe(2);
    expect(leakedKeys(first)).toEqual([]);

    const second = (await service.executeTool(
      'traceforge.chat.ask',
      { conversationId: started.conversationId, message: 'How do virtual voltage measurements work?' },
      AGENT,
    )) as { reply: string; messageCount: number; sources: unknown[] };
    expect(second.messageCount).toBe(4);
    expect(second.sources.length).toBeGreaterThan(0);
    expect(leakedKeys(second)).toEqual([]);

    const history = (await service.executeTool(
      'traceforge.chat.history',
      { conversationId: started.conversationId },
      AGENT,
    )) as {
      conversationId: string; ownerActorId: string; scenarioId: string; messageCount: number;
      messages: Array<{ role: string; content: string }>; kbVersion: string;
    };
    expect(history.messageCount).toBe(4);
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history.kbVersion).toBe('2026.10.27-v4');

    const feedback = (await service.executeTool(
      'traceforge.chat.feedback',
      { conversationId: started.conversationId, messageIndex: 1, rating: 'helpful', comment: 'grounded answer' },
      AGENT,
    )) as { feedbackId: string; recorded: boolean; rating: string; kbVersion: string };
    expect(feedback.recorded).toBe(true);
    expect(feedback.rating).toBe('helpful');

    const cleared = (await service.executeTool(
      'traceforge.chat.clear',
      { conversationId: started.conversationId },
      AGENT,
    )) as { conversationId: string; cleared: boolean; messageCount: number };
    expect(cleared.cleared).toBe(true);
    expect(cleared.messageCount).toBe(0);

    const after = (await service.executeTool(
      'traceforge.chat.history',
      { conversationId: started.conversationId },
      AGENT,
    )) as { messageCount: number };
    expect(after.messageCount).toBe(0);

    const status = (await service.executeTool('traceforge.chat.status', {}, AGENT)) as {
      activeConversationCount: number; feedbackCount: number;
    };
    expect(status.activeConversationCount).toBeGreaterThanOrEqual(1);
    expect(status.feedbackCount).toBeGreaterThanOrEqual(1);
  });

  it('auto-starts an ephemeral conversation when chat.ask omits conversationId', async () => {
    const service = new TraceForgeMaasService();
    const asked = (await service.executeTool(
      'traceforge.chat.ask',
      { message: 'How does TraceForge work?' },
      AGENT,
    )) as { conversationId: string; reply: string; messageCount: number };
    expect(asked.conversationId.startsWith('conv_')).toBe(true);
    expect(asked.reply.length).toBeGreaterThan(0);
    expect(asked.messageCount).toBe(2);
  });

  it('isolates conversations per actor', async () => {
    const service = new TraceForgeMaasService();
    const started = (await service.executeTool('traceforge.chat.start', {}, AGENT)) as { conversationId: string };
    const conv = started.conversationId;
    await expectToolError(
      service.executeTool('traceforge.chat.history', { conversationId: conv }, SECONDARY),
      'MAAS_CROSS_TENANT_ACCESS_DENIED',
    );
    await expectToolError(
      service.executeTool('traceforge.chat.ask', { conversationId: conv, message: 'Hello?' }, SECONDARY),
      'MAAS_CROSS_TENANT_ACCESS_DENIED',
    );
    await expectToolError(
      service.executeTool('traceforge.chat.clear', { conversationId: conv }, SECONDARY),
      'MAAS_CROSS_TENANT_ACCESS_DENIED',
    );
    await expectToolError(
      service.executeTool('traceforge.chat.feedback', { conversationId: conv, rating: 'helpful' }, SECONDARY),
      'MAAS_CROSS_TENANT_ACCESS_DENIED',
    );
    await expectToolError(
      service.executeTool('traceforge.chat.history', { conversationId: 'conv_deadbeefdeadbeefdeadbeef' }, AGENT),
      'MAAS_RESOURCE_NOT_FOUND',
    );
    // Owner's own conversation still works after the cross-actor denials.
    const history = (await service.executeTool('traceforge.chat.history', { conversationId: conv }, AGENT)) as {
      messageCount: number;
    };
    expect(history.messageCount).toBe(0);
  });

  it('rejects invalid chat inputs without spending', async () => {
    const service = new TraceForgeMaasService();
    await expectToolError(service.executeTool('traceforge.chat.ask', {}, AGENT), 'MAAS_SCHEMA_VALIDATION_FAILED');
    await expectToolError(
      service.executeTool('traceforge.chat.ask', { questions: [] }, AGENT),
      'MAAS_SCHEMA_VALIDATION_FAILED',
    );
    await expectToolError(
      service.executeTool(
        'traceforge.chat.ask',
        { questions: Array.from({ length: 26 }, (_, i) => `Question ${i}?`) },
        AGENT,
      ),
      'MAAS_SCHEMA_VALIDATION_FAILED',
    );
    await expectToolError(
      service.executeTool('traceforge.chat.feedback', { rating: 'meh' }, AGENT),
      'MAAS_SCHEMA_VALIDATION_FAILED',
    );
  });

  it('runs a custom deterministic batch QA via questions[]', async () => {
    const service = new TraceForgeMaasService();
    const report = (await service.executeTool(
      'traceforge.chat.ask',
      { questions: ['How does TraceForge work?', 'What does NRST mean?'] },
      AGENT,
    )) as {
      qaMode: boolean; kbVersion: string; totalQuestions: number; allPassed: boolean;
      liveCallsInvoked: number; totalCostUsd: number;
      results: Array<{ answer: string; liveInvoked: boolean; costUsd: number; passed: boolean }>;
    };
    expect(report.qaMode).toBe(true);
    expect(report.kbVersion).toBe('2026.10.27-v4');
    expect(report.totalQuestions).toBe(2);
    expect(report.liveCallsInvoked).toBe(0);
    expect(report.totalCostUsd).toBe(0);
    for (const result of report.results) {
      expect(result.answer.length).toBeGreaterThan(0);
      expect(result.liveInvoked).toBe(false);
      expect(result.costUsd).toBe(0);
    }
  });

  it('answers standards-compliant MCP methods (initialize, server/discover, ping, notifications) over HTTP', async () => {
    const service = new TraceForgeMaasService();
    const call = async (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const { res, out } = capture();
      const handled = await handleMaasMcpRequest(
        { method: 'POST', url: '/api/mcp', headers, body: { jsonrpc: '2.0', id: 7, method, params } },
        res,
        service,
      );
      expect(handled).toBe(true);
      return JSON.parse(out.body) as { result: Record<string, unknown> };
    };
    const init = await call('initialize', {});
    expect(init.result['protocolVersion']).toBe('2025-06-18');

    const discovered = await call('server/discover', {});
    expect((discovered.result['serverInfo'] as { name: string }).name).toBe('traceforge-maas');
    expect(discovered.result['protocolVersion']).toBe('2025-06-18');
    expect((discovered.result['tools'] as unknown[]).length).toBe(25);

    const ping = await call('ping', {});
    expect(ping.result).toEqual({});

    const initialized = await call('notifications/initialized', {});
    expect(initialized.result).toEqual({});

    const listed = await call('tools/list', {});
    const names = ((listed.result['tools'] as Array<{ name: string }>) ?? []).map((t) => t.name);
    for (const name of CHAT_TOOL_NAMES) {
      expect(names).toContain(name);
    }

    const searched = await call('tools/call', { name: 'traceforge.kb.search', arguments: { query: 'How do I start an investigation?' } });
    const structured = searched.result['structuredContent'] as { answer: string; liveInvoked: boolean; kbVersion: string };
    expect(structured.answer.length).toBeGreaterThan(0);
    expect(structured.liveInvoked).toBe(false);
    expect(structured.kbVersion).toBe('2026.10.27-v4');
  });
});
