/**
 * TraceForge MaaS — 18-tool service layer.
 *
 * `TraceForgeMaasService` registers and executes every TraceForge MaaS tool
 * against the REAL in-repo engines (`circuit-simulator.ts`,
 * `diagnostic-agent.ts`, `meta-client.ts`, `samples.ts`). Independent of
 * Health eRecords: no imports outside this repository, no external
 * credentials, no network calls in simulated mode.
 *
 * Ground-truth isolation: `HiddenFault` objects live only inside stored
 * `VirtualLabSession` instances. Every scenario/circuit payload is verified
 * with `assertGroundTruthIsolated` before it leaves the service; ground
 * truth is disclosed to the owning actor only through `evaluation.score`.
 */

import {
  MAX_TOOL_CALLS,
  SIMULATOR_CAPABILITIES,
  assertGroundTruthIsolated,
  createVirtualSession,
  getReferenceBoard,
  listReferenceBoards,
  scoreDiagnosis,
  type AgentCircuitView,
  type HiddenFault,
  type ProbeRecord,
  type VirtualLabSession,
} from '../lib/circuit-simulator';
import {
  runAgenticDiagnosis,
  type AgentStep,
  type ProposedDiagnosis,
} from '../lib/diagnostic-agent';
import {
  AUTHORIZED_ADDITIONAL_BUDGET_USD,
  BUDGET_SAFETY_THRESHOLD_USD,
  MetaClient,
  STARTING_PROMOTIONAL_BALANCE_USD,
  TARGET_RESERVE_USD,
  type OperationalMode,
  type UsageTelemetry,
} from '../lib/meta-client';
import { SAMPLE_BOARDS } from '../data/samples';
import {
  MCP_PROTOCOL_VERSION,
  createMaasCorrelationId,
  maasError,
  normalizeToolName,
  validateAgainstMaasSchema,
  type MaasCapabilityDescriptor,
  type MaasErrorCode,
  type MaasJsonSchema,
  type MaasStructuredError,
} from './protocol';
import { TraceForgeVerificationEngine, type MaasVerificationReceipt } from './verification';
import {
  MAAS_LOCAL_TOKENS,
  MaasAuditLog,
  MaasAuthenticator,
  MaasKillSwitch,
  MaasRateLimiter,
  MaasSecurityError,
  type MaasAuthContext,
} from './security';

/* ---------------------------------------------------------------------------
 * Tool errors (thrown by dispatch, formatted by the MCP server layer)
 * ------------------------------------------------------------------------- */

/** Failure of one tool execution, carrying a structured MaaS error code. */
export class MaasToolError extends Error {
  readonly code: MaasErrorCode;
  readonly correlationId: string;
  readonly capability?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: MaasErrorCode, message: string, correlationId: string, capability?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MaasToolError';
    this.code = code;
    this.correlationId = correlationId;
    if (capability) this.capability = capability;
    if (details) this.details = details;
  }

  toStructuredError(): MaasStructuredError {
    return maasError(this.code, this.message, this.correlationId, this.capability, this.details);
  }
}

/** HTTP-ish status for a MaaS error code (audit + middleware use only). */
export function maasErrorStatus(code: MaasErrorCode): number {
  switch (code) {
    case 'MAAS_AUTHENTICATION_REQUIRED':
    case 'MAAS_CREDENTIALS_REVOKED':
      return 401;
    case 'MAAS_AUTHORIZATION_DENIED':
    case 'MAAS_CROSS_TENANT_ACCESS_DENIED':
      return 403;
    case 'MAAS_CAPABILITY_NOT_FOUND':
    case 'MAAS_RESOURCE_NOT_FOUND':
      return 404;
    case 'MAAS_RATE_LIMIT_EXCEEDED':
      return 429;
    case 'MAAS_INVALID_REQUEST':
    case 'MAAS_SCHEMA_VALIDATION_FAILED':
      return 400;
    default:
      return 200;
  }
}

/* ---------------------------------------------------------------------------
 * Tool descriptors (all 18)
 * ------------------------------------------------------------------------- */

function objSchema(properties: Record<string, MaasJsonSchema> = {}, required: string[] = []): MaasJsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const S = (description: string): MaasJsonSchema => ({ type: 'string', description });
const OPT_S = (description: string): MaasJsonSchema => ({ type: 'string', description });

function descriptor(
  name: string,
  description: string,
  inputSchema: MaasJsonSchema,
  requiredScope: string | null,
  readOnly: boolean,
): MaasCapabilityDescriptor {
  return {
    name,
    description,
    inputSchema,
    requiredScope,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: name === 'traceforge.scenarios.create',
      idempotentHint: readOnly,
      openWorldHint: false,
    },
  };
}

const SCENARIO_REF_SCHEMA = objSchema(
  {
    investigationId: OPT_S('Investigation id returned by traceforge.investigations.start.'),
    scenarioId: OPT_S('Scenario id returned by traceforge.scenarios.create.'),
  },
  [],
);

/** All 18 registered TraceForge MaaS tool descriptors. */
export const TRACEFORGE_MAAS_TOOL_DESCRIPTORS: MaasCapabilityDescriptor[] = [
  descriptor('traceforge.capabilities.list', 'List all registered TraceForge MaaS tool descriptors with schemas, scopes, and annotations.', objSchema(), null, true),
  descriptor('traceforge.system.status', 'Service health: MCP protocol version, solver capabilities, kill-switch status, active session count.', objSchema(), null, true),
  descriptor('traceforge.models.status', 'Truthful operational mode (LIVE_API/SIMULATED/STATIC_FIXTURE/UNVERIFIED/UNAVAILABLE) for muse-spark-1.3 and sam-3.1. Never exposes META_API_KEY.', objSchema(), null, true),
  descriptor('traceforge.budget.status', 'Promotional-credit baseline, authorized ceiling, mandatory reserve, safety threshold, and live/simulated token & cost ledger.', objSchema(), null, true),
  descriptor('traceforge.circuits.list', 'List the 3 sample/reference boards with symptoms, nominal node count, test points, and scenario count. Never exposes hidden fault answers.', objSchema(), null, true),
  descriptor('traceforge.circuits.get', 'Ground-truth-free AgentCircuitView plus PCB probe-point coordinates for one boardId.', objSchema({ boardId: S('Reference board id.') }, ['boardId']), null, true),
  descriptor('traceforge.scenarios.list', 'Fault scenario selectors for a boardId plus the caller\'s own active scenario sessions. Selectors never leak fault answers.', objSchema({ boardId: OPT_S('Reference board id (omit to list only your sessions).') }, []), 'traceforge:scenarios:read', true),
  descriptor('traceforge.scenarios.create', 'Create an actor-isolated VirtualLabSession for a boardId and optional faultSelector (random | nominal | faultId). Returns scenarioId plus a signed verificationReceipt with zero ground-truth leakage.', objSchema({ boardId: S('Reference board id.'), faultSelector: OPT_S('random | nominal | faultId | scenario-N index.') }, ['boardId']), 'traceforge:scenarios:write', false),
  descriptor('traceforge.measurements.voltage', 'DC voltage at a node (optional refNode, default GND) via the session MNA bench. Consumes probe budget.', objSchema({ scenarioId: S('Owning scenario id.'), node: S('Probe pad or node, e.g. TP_NRST or U1-15.'), refNode: OPT_S('Reference node (default GND).') }, ['scenarioId', 'node']), 'traceforge:measurements:execute', false),
  descriptor('traceforge.measurements.current', 'DC branch current through a componentId via the session MNA bench. Consumes probe budget.', objSchema({ scenarioId: S('Owning scenario id.'), componentId: S('Component id, e.g. R_LOAD.') }, ['scenarioId', 'componentId']), 'traceforge:measurements:execute', false),
  descriptor('traceforge.measurements.continuity', 'Unpowered resistance/continuity between probeA and probeB. Consumes probe budget.', objSchema({ scenarioId: S('Owning scenario id.'), probeA: S('First probe pad or node.'), probeB: S('Second probe pad or node.') }, ['scenarioId', 'probeA', 'probeB']), 'traceforge:measurements:execute', false),
  descriptor('traceforge.measurements.history', 'Ordered probeLog, activitySummary, and pcbHighlights for a scenarioId.', objSchema({ scenarioId: S('Owning scenario id.') }, ['scenarioId']), 'traceforge:measurements:read', true),
  descriptor('traceforge.investigations.start', 'Run agentic diagnosis on a scenarioId (or fresh scenario from boardId). Default mode simulated ($0.00). Live mode needs scope, budget headroom, and a configured upstream key.', objSchema({ scenarioId: OPT_S('Existing scenario id.'), boardId: OPT_S('Board id for a fresh scenario.'), mode: { type: 'string', description: 'simulated (default) or live.', enum: ['simulated', 'live'] } }, []), 'traceforge:investigations:execute', false),
  descriptor('traceforge.investigations.status', 'Status, operationalMode, turns, probesUsed, maxToolCalls for an investigationId or scenarioId.', SCENARIO_REF_SCHEMA, 'traceforge:investigations:read', true),
  descriptor('traceforge.investigations.history', 'Turn-by-turn steps, probeLog, activitySummary, and pcbHighlights for an investigationId or scenarioId.', SCENARIO_REF_SCHEMA, 'traceforge:investigations:read', true),
  descriptor('traceforge.investigations.result', 'Proposed diagnosis, classified evidence, verification status, operational mode, diagnosis source, and telemetry. Ground truth stays withheld.', SCENARIO_REF_SCHEMA, 'traceforge:investigations:read', true),
  descriptor('traceforge.evaluation.score', 'Score the completed investigation (or an explicit componentRef/faultType submission with >=1 probe) against the withheld HiddenFault. Discloses ground truth and locks the scenario against further probing.', objSchema({ scenarioId: S('Owning scenario id.'), submission: { type: 'object', description: 'Explicit { componentRef, faultType, verificationStatus } submission.', properties: { componentRef: S('Board reference designator.'), faultType: S('Fault class.'), verificationStatus: { type: 'string', description: 'confirmed | hypothesis.', enum: ['confirmed', 'hypothesis'] } }, required: ['componentRef', 'faultType', 'verificationStatus'], additionalProperties: false } }, ['scenarioId']), 'traceforge:evaluation:score', false),
  descriptor('traceforge.evaluation.report', 'Complete post-evaluation audit report. Only after evaluation.score ran on that scenario.', objSchema({ scenarioId: S('Evaluated scenario id.') }, ['scenarioId']), 'traceforge:evaluation:score', true),
];

/** Capabilities callable without a Bearer token (read-only discovery). */
export const PUBLIC_MAAS_CAPABILITIES: ReadonlySet<string> = new Set([
  'traceforge.capabilities.list',
  'traceforge.system.status',
  'traceforge.models.status',
  'traceforge.budget.status',
  'traceforge.circuits.list',
  'traceforge.circuits.get',
]);

/** Capabilities that mutate state and therefore carry a verificationReceipt. */
export const MUTATING_MAAS_CAPABILITIES: ReadonlySet<string> = new Set([
  'traceforge.scenarios.create',
  'traceforge.measurements.voltage',
  'traceforge.measurements.current',
  'traceforge.measurements.continuity',
  'traceforge.investigations.start',
  'traceforge.evaluation.score',
]);

/* ---------------------------------------------------------------------------
 * Stored records
 * ------------------------------------------------------------------------- */

export interface ScenarioRecord {
  scenarioId: string;
  boardId: string;
  ownerActorId: string;
  session: VirtualLabSession;
  evaluated: boolean;
  evaluatedAt?: string;
  scorecard?: Record<string, unknown>;
  faultSelector: string;
  createdAt: string;
}

export interface InvestigationRecord {
  investigationId: string;
  scenarioId: string;
  boardId: string;
  ownerActorId: string;
  operationalMode: OperationalMode;
  turns: number;
  steps: AgentStep[];
  probeEvents: ProbeRecord[];
  proposedDiagnosis: ProposedDiagnosis;
  classifiedEvidence: { abnormalVoltages: string[]; shortedContinuities: string[]; probeCount: number };
  telemetry: UsageTelemetry;
  diagnosisSource: string;
  createdAt: string;
}

export interface MaasServiceOptions {
  maxRequestsPerWindow?: number;
  rateLimitWindowMs?: number;
  maxSessionsPerActor?: number;
  /** Test/config seam: prior live spend added to the budget ledger. */
  initialIncurredCostUsd?: number;
  verificationKey?: string;
}

export type MaasHeaderMap = Record<string, string | string[] | undefined>;

let scenarioSeq = 0;
let investigationSeq = 0;

function nextScenarioId(): string {
  scenarioSeq += 1;
  return `scn_${Date.now().toString(36)}${scenarioSeq.toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

function nextInvestigationId(): string {
  investigationSeq += 1;
  return `inv_${Date.now().toString(36)}${investigationSeq.toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requireString(args: Record<string, unknown>, key: string, correlationId: string, capability: string): string {
  const value = asString(args[key]);
  if (!value || value.length === 0) {
    throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', `Missing required string argument '${key}'.`, correlationId, capability);
  }
  return value;
}

/* ---------------------------------------------------------------------------
 * TraceForgeMaasService
 * ------------------------------------------------------------------------- */

/** PCB probe point in public fixture coordinates (no electrical answers). */
export interface MaasPcbPoint {
  x: number;
  y: number;
  label: string;
  net: string;
}

function publicProbePoints(boardId: string): MaasPcbPoint[] {
  const board = SAMPLE_BOARDS.find((b) => b.id === boardId);
  if (!board) return [];
  return board.probePoints.map((p) => ({ x: p.x, y: p.y, label: p.label, net: p.net }));
}

function findPcbPoint(boardId: string, padOrNode: string, resolvedNode: string): MaasPcbPoint | null {
  const points = publicProbePoints(boardId);
  return (
    points.find((p) => p.label === padOrNode) ??
    points.find((p) => p.net === resolvedNode || p.net === padOrNode) ??
    null
  );
}

function summarizeProbeLog(probeLog: ProbeRecord[]): { total: number; byKind: Record<string, number>; abnormal: number } {
  const byKind: Record<string, number> = {};
  let abnormal = 0;
  for (const p of probeLog) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    if (p.abnormal) abnormal += 1;
  }
  return { total: probeLog.length, byKind, abnormal };
}

function highlightsForSession(boardId: string, session: VirtualLabSession): Array<{ target: string; point: MaasPcbPoint | null }> {
  return session.getProbeLog().map((p) => {
    if (p.kind === 'voltage') {
      const resolved = session.resolveProbeNode(p.target);
      return { target: p.target, point: findPcbPoint(boardId, p.target, resolved) };
    }
    if (p.kind === 'resistance') {
      const [a = ''] = p.target.split('↔');
      const resolved = session.resolveProbeNode(a);
      return { target: p.target, point: findPcbPoint(boardId, a, resolved) };
    }
    return { target: p.target, point: null };
  });
}

/**
 * Registers and executes all 18 TraceForge MaaS tools with authentication,
 * authorization, rate limiting, kill-switch, audit, probe-budget, tenant
 * isolation, and verification-receipt enforcement.
 */
export class TraceForgeMaasService {
  private readonly descriptors = new Map<string, MaasCapabilityDescriptor>();
  private readonly simClient = new MetaClient({ mode: 'simulated' });
  private readonly verifier: TraceForgeVerificationEngine;
  private readonly killSwitch = new MaasKillSwitch();
  private readonly rateLimiter: MaasRateLimiter;
  private readonly authenticator: MaasAuthenticator;
  private readonly audit = new MaasAuditLog();
  private readonly scenarios = new Map<string, ScenarioRecord>();
  private readonly investigations = new Map<string, InvestigationRecord>();
  private readonly maxSessionsPerActor: number;
  private injectedLiveSpendUsd: number;

  constructor(options: MaasServiceOptions = {}) {
    for (const d of TRACEFORGE_MAAS_TOOL_DESCRIPTORS) this.descriptors.set(d.name, d);
    this.verifier = new TraceForgeVerificationEngine(options.verificationKey);
    this.rateLimiter = new MaasRateLimiter(options.maxRequestsPerWindow ?? 120, options.rateLimitWindowMs ?? 60_000);
    this.authenticator = new MaasAuthenticator(this.killSwitch);
    this.maxSessionsPerActor = options.maxSessionsPerActor ?? 25;
    this.injectedLiveSpendUsd = options.initialIncurredCostUsd ?? 0;
  }

  /* -- accessors for middleware / tests ----------------------------------- */

  listCapabilities(): MaasCapabilityDescriptor[] {
    return [...TRACEFORGE_MAAS_TOOL_DESCRIPTORS];
  }

  getKillSwitch(): MaasKillSwitch {
    return this.killSwitch;
  }

  getRateLimiter(): MaasRateLimiter {
    return this.rateLimiter;
  }

  getAuditLog(): MaasAuditLog {
    return this.audit;
  }

  getAuthenticator(): MaasAuthenticator {
    return this.authenticator;
  }

  getVerifier(): TraceForgeVerificationEngine {
    return this.verifier;
  }

  getActiveSessionCount(): number {
    return this.scenarios.size;
  }

  getScenarioRecord(scenarioId: string): ScenarioRecord | undefined {
    return this.scenarios.get(scenarioId);
  }

  /** Test/config seam: simulate prior live spend against the safety threshold. */
  injectLiveSpendForTesting(usd: number): void {
    this.injectedLiveSpendUsd += usd;
  }

  private effectiveIncurredCostUsd(): number {
    return this.simClient.getTelemetry().incurredCostUsd + this.injectedLiveSpendUsd;
  }

  /* -- central execution gate --------------------------------------------- */

  /**
   * Execute one tool by canonical dotted or underscore-normalized name.
   * Enforces kill switch, auth, rate limit, schema validation, tenant
   * isolation, probe budget, and receipt issuance. Throws `MaasToolError`
   * or `MaasSecurityError` on failure; every call is audit-logged.
   */
  async executeTool(name: string, args: Record<string, unknown>, headers: MaasHeaderMap = {}): Promise<unknown> {
    const correlationId = createMaasCorrelationId();
    const canonical = normalizeToolName(name);
    const descriptorEntry = this.descriptors.get(canonical);
    const run = async (): Promise<unknown> => {
      if (!descriptorEntry) {
        throw new MaasToolError('MAAS_CAPABILITY_NOT_FOUND', `Unknown MaaS capability '${name}'.`, correlationId, name);
      }
      const capability = descriptorEntry.name;
      if (this.killSwitch.isGlobalKillActive()) {
        throw new MaasToolError('MAAS_KILL_SWITCH_ACTIVE', `Global kill switch is active: ${this.killSwitch.getGlobalKillReason() ?? 'operator halt'}.`, correlationId, capability);
      }
      if (this.killSwitch.isToolDisabled(capability)) {
        throw new MaasToolError('MAAS_KILL_SWITCH_ACTIVE', `Capability '${capability}' is disabled by the operator kill switch.`, correlationId, capability);
      }
      if (this.killSwitch.isWriteFreezeActive() && MUTATING_MAAS_CAPABILITIES.has(capability)) {
        throw new MaasToolError('MAAS_KILL_SWITCH_ACTIVE', `Write freeze is active: mutating capability '${capability}' is halted.`, correlationId, capability);
      }
      let context: MaasAuthContext;
      try {
        context = this.authenticator.authenticate(headers);
        this.authenticator.authorize(context, capability, descriptorEntry.requiredScope);
      } catch (err) {
        if (err instanceof MaasSecurityError) {
          throw new MaasToolError(err.code, err.message, correlationId, capability);
        }
        throw err;
      }
      const rateKey = context.anonymous ? 'anonymous' : `actor:${context.actorId}`;
      try {
        this.rateLimiter.check(rateKey);
      } catch (err) {
        if (err instanceof MaasSecurityError) {
          throw new MaasToolError(err.code, err.message, correlationId, capability);
        }
        throw err;
      }
      const validation = validateAgainstMaasSchema(args, descriptorEntry.inputSchema);
      if (!validation.valid) {
        throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', `Schema validation failed: ${validation.errors.join('; ')}.`, correlationId, capability, { errors: validation.errors });
      }
      return this.dispatch(capability, args, context, correlationId);
    };
    try {
      const payload = await run();
      this.audit.record({ correlationId, actorId: this.actorIdForAudit(headers), capability: descriptorEntry?.name ?? name, outcome: 'success', argumentsSummary: args });
      return payload;
    } catch (err) {
      const code: MaasErrorCode = err instanceof MaasToolError
        ? err.code
        : err instanceof MaasSecurityError ? err.code : 'MAAS_EXECUTION_FAILED';
      this.audit.record({ correlationId, actorId: this.actorIdForAudit(headers), capability: descriptorEntry?.name ?? name, outcome: 'error', errorCode: code, argumentsSummary: args });
      if (err instanceof MaasToolError) throw err;
      if (err instanceof MaasSecurityError) throw new MaasToolError(err.code, err.message, correlationId, descriptorEntry?.name ?? name);
      throw new MaasToolError('MAAS_EXECUTION_FAILED', err instanceof Error ? err.message : String(err), correlationId, descriptorEntry?.name ?? name);
    }
  }

  private actorIdForAudit(headers: MaasHeaderMap): string {
    try {
      return this.authenticator.authenticate(headers).actorId;
    } catch {
      return 'anonymous';
    }
  }

  private dispatch(capability: string, args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> | unknown {
    switch (capability) {
      case 'traceforge.capabilities.list': return this.capabilitiesList();
      case 'traceforge.system.status': return this.systemStatus();
      case 'traceforge.models.status': return this.modelsStatus();
      case 'traceforge.budget.status': return this.budgetStatus();
      case 'traceforge.circuits.list': return this.circuitsList();
      case 'traceforge.circuits.get': return this.circuitsGet(args, correlationId);
      case 'traceforge.scenarios.list': return this.scenariosList(args, context);
      case 'traceforge.scenarios.create': return this.scenariosCreate(args, context, correlationId);
      case 'traceforge.measurements.voltage': return this.measureVoltage(args, context, correlationId);
      case 'traceforge.measurements.current': return this.measureCurrent(args, context, correlationId);
      case 'traceforge.measurements.continuity': return this.measureContinuity(args, context, correlationId);
      case 'traceforge.measurements.history': return this.measureHistory(args, context);
      case 'traceforge.investigations.start': return this.investigationsStart(args, context, correlationId);
      case 'traceforge.investigations.status': return this.investigationsStatus(args, context);
      case 'traceforge.investigations.history': return this.investigationsHistory(args, context);
      case 'traceforge.investigations.result': return this.investigationsResult(args, context);
      case 'traceforge.evaluation.score': return this.evaluationScore(args, context, correlationId);
      case 'traceforge.evaluation.report': return this.evaluationReport(args, context);
      default:
        throw new MaasToolError('MAAS_CAPABILITY_NOT_FOUND', `Unknown MaaS capability '${capability}'.`, correlationId, capability);
    }
  }

  /* -- scenario / investigation helpers ------------------------------------ */

  private requireOwnedScenario(scenarioId: string, context: MaasAuthContext, correlationId: string, capability: string): ScenarioRecord {
    const record = this.scenarios.get(scenarioId);
    if (!record) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown scenario '${scenarioId}'.`, correlationId, capability);
    }
    if (record.ownerActorId !== context.actorId) {
      throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Scenario '${scenarioId}' belongs to another actor.`, correlationId, capability);
    }
    return record;
  }

  private requireUsableSession(record: ScenarioRecord, correlationId: string, capability: string): VirtualLabSession {
    if (record.evaluated) {
      throw new MaasToolError('MAAS_SESSION_ALREADY_EVALUATED', `Scenario '${record.scenarioId}' was already evaluated; no further probing is allowed after ground-truth disclosure.`, correlationId, capability);
    }
    return record.session;
  }

  private checkProbeBudget(session: VirtualLabSession, scenarioId: string, correlationId: string, capability: string): void {
    if (session.getToolCallsUsed() >= session.maxToolCalls) {
      throw new MaasToolError('MAAS_PROBE_BUDGET_EXHAUSTED', `Probe budget exhausted for '${scenarioId}': ${session.maxToolCalls} of ${session.maxToolCalls} tool calls used (MAX_TOOL_CALLS = ${MAX_TOOL_CALLS}).`, correlationId, capability);
    }
  }

  private resolveInvestigation(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string, capability: string): InvestigationRecord {
    const investigationId = asString(args['investigationId']);
    const scenarioId = asString(args['scenarioId']);
    if (!investigationId && !scenarioId) {
      throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', 'Either investigationId or scenarioId is required.', correlationId, capability);
    }
    let record: InvestigationRecord | undefined;
    if (investigationId) record = this.investigations.get(investigationId);
    else {
      const owned = this.requireOwnedScenario(scenarioId as string, context, correlationId, capability);
      record = [...this.investigations.values()].filter((r) => r.scenarioId === owned.scenarioId).pop();
    }
    if (!record) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `No investigation found for '${investigationId ?? scenarioId}'.`, correlationId, capability);
    }
    if (record.ownerActorId !== context.actorId) {
      throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Investigation '${record.investigationId}' belongs to another actor.`, correlationId, capability);
    }
    return record;
  }

  private issueReceipt(capability: string, targetEntityId: string, assertions: string[], summary: string, correlationId: string): MaasVerificationReceipt {
    return this.verifier.issueReceipt({
      correlationId,
      capabilityName: capability,
      accessMode: 'execute',
      outcome: 'verified',
      targetEntityId,
      postconditionAssertions: assertions,
      summary,
    });
  }

  /* -- discovery & status --------------------------------------------------- */

  private capabilitiesList(): unknown {
    return { protocolVersion: MCP_PROTOCOL_VERSION, count: this.descriptors.size, tools: this.listCapabilities() };
  }

  private systemStatus(): unknown {
    return {
      service: 'traceforge-maas',
      mcpProtocolVersion: MCP_PROTOCOL_VERSION,
      solver: SIMULATOR_CAPABILITIES,
      killSwitch: this.killSwitch.snapshot(),
      activeSessionCount: this.scenarios.size,
      activeInvestigationCount: this.investigations.size,
      rateLimit: { maxRequestsPerWindow: this.rateLimiter.getMaxRequestsPerWindow(), windowMs: this.rateLimiter.getWindowMs() },
      timestamp: new Date().toISOString(),
    };
  }

  private modelsStatus(): unknown {
    const status = this.simClient.status();
    return {
      spark: { model: 'muse-spark-1.3', operationalMode: status.sparkMode, liveVerified: status.liveVerified },
      sam: { model: 'sam-3.1', operationalMode: status.samMode, note: 'Live SAM 3.1 deferred; static KiCad fixture overlays labeled STATIC_FIXTURE.' },
      transparencyNote: 'SIMULATED = deterministic mock; LIVE_API only after a verified real response. Simulated results are never presented as live inference.',
    };
  }

  private budgetStatus(): unknown {
    const telemetry = this.simClient.getTelemetry();
    const incurred = this.effectiveIncurredCostUsd();
    return {
      startingBalanceUsd: STARTING_PROMOTIONAL_BALANCE_USD,
      baselineNote: 'Unverified snapshot recorded 2026-10-26 (see AGENTS.md §8); provider-reported usage wins when present.',
      authorizedCeilingUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD,
      mandatoryReserveUsd: TARGET_RESERVE_USD,
      safetyThresholdUsd: BUDGET_SAFETY_THRESHOLD_USD,
      ledger: {
        incurredCostUsd: incurred,
        projectedLiveCostUsd: telemetry.projectedLiveCostUsd,
        inputTokens: telemetry.inputTokens,
        outputTokens: telemetry.outputTokens,
        totalRequests: telemetry.totalRequests,
        providerReportedUsage: telemetry.providerReportedUsage,
      },
      remainingBudgetUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD - incurred,
      safetyThresholdBreached: incurred >= BUDGET_SAFETY_THRESHOLD_USD,
    };
  }

  /* -- circuits & scenarios -------------------------------------------------- */

  private circuitsList(): unknown {
    return {
      count: listReferenceBoards().length,
      boards: listReferenceBoards().map((b) => {
        const sample = SAMPLE_BOARDS.find((s) => s.id === b.boardId);
        return {
          boardId: b.boardId,
          boardName: b.boardName,
          symptom: b.symptom,
          nominalNodeCount: b.nominal.nodes.length,
          testPoints: publicProbePoints(b.boardId),
          scenarioCount: b.faults.length,
          datasheetSections: (sample?.datasheet ?? []).map((d) => d.title),
        };
      }),
    };
  }

  private circuitsGet(args: Record<string, unknown>, correlationId: string): unknown {
    const capability = 'traceforge.circuits.get';
    const boardId = requireString(args, 'boardId', correlationId, capability);
    const reference = getReferenceBoard(boardId);
    if (!reference) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown board '${boardId}'.`, correlationId, capability);
    }
    const probeSession = createVirtualSession(boardId, 'nominal');
    const agentView: AgentCircuitView = probeSession.getAgentView();
    const payload = { boardId, agentView, pcbProbePoints: publicProbePoints(boardId) };
    assertGroundTruthIsolated(payload, probeSession.getGroundTruth());
    return payload;
  }

  private scenariosList(args: Record<string, unknown>, context: MaasAuthContext): unknown {
    const boardId = asString(args['boardId']);
    const boards = boardId ? listReferenceBoards().filter((b) => b.boardId === boardId) : listReferenceBoards();
    return {
      selectors: boards.map((b) => ({
        boardId: b.boardId,
        available: ['random', 'nominal', ...b.faults.map((_, index) => `scenario-${index}`)],
        scenarioCount: b.faults.length,
      })),
      mySessions: [...this.scenarios.values()]
        .filter((r) => r.ownerActorId === context.actorId)
        .map((r) => ({ scenarioId: r.scenarioId, boardId: r.boardId, evaluated: r.evaluated, faultSelector: r.faultSelector, createdAt: r.createdAt })),
    };
  }

  /**
   * Non-identifying label for a fault selector: the raw selector may BE a
   * faultId, which must never appear in any pre-evaluation response, so only
   * the selector KIND is stored and echoed.
   */
  private selectorLabel(faultSelector: string): string {
    if (faultSelector === 'random') return 'random';
    if (faultSelector === 'nominal' || faultSelector === 'healthy') return 'nominal';
    if (/^scenario-\d+$/.test(faultSelector)) return 'indexed';
    return 'explicit';
  }

  private createSessionForActor(boardId: string, faultSelector: string, ownerActorId: string): ScenarioRecord {
    const reference = getReferenceBoard(boardId);
    if (!reference) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown board '${boardId}'.`, createMaasCorrelationId(), 'traceforge.scenarios.create');
    }
    const owned = [...this.scenarios.values()].filter((r) => r.ownerActorId === ownerActorId).length;
    if (owned >= this.maxSessionsPerActor) {
      throw new MaasToolError('MAAS_RATE_LIMIT_EXCEEDED', `Actor '${ownerActorId}' already holds ${owned} scenarios (max ${this.maxSessionsPerActor}).`, createMaasCorrelationId(), 'traceforge.scenarios.create');
    }
    let faultId: string | undefined;
    if (faultSelector === 'random') faultId = 'random';
    else if (faultSelector === 'nominal' || faultSelector === 'healthy' || faultSelector === undefined) faultId = 'nominal';
    else if (/^scenario-\d+$/.test(faultSelector)) {
      const index = Number(faultSelector.split('-')[1]);
      const fault = reference.faults[index];
      if (!fault) throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown scenario selector '${faultSelector}' for board '${boardId}'.`, createMaasCorrelationId(), 'traceforge.scenarios.create');
      faultId = fault.faultId;
    } else {
      const fault = reference.faults.find((f) => f.faultId === faultSelector);
      if (!fault) throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown fault selector '${faultSelector}' for board '${boardId}'.`, createMaasCorrelationId(), 'traceforge.scenarios.create');
      faultId = fault.faultId;
    }
    const session = createVirtualSession(boardId, faultId);
    const scenarioId = nextScenarioId();
    const record: ScenarioRecord = {
      scenarioId,
      boardId,
      ownerActorId,
      session,
      evaluated: false,
      faultSelector: this.selectorLabel(faultSelector),
      createdAt: new Date().toISOString(),
    };
    this.scenarios.set(scenarioId, record);
    return record;
  }

  private scenariosCreate(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): unknown {
    const capability = 'traceforge.scenarios.create';
    const boardId = requireString(args, 'boardId', correlationId, capability);
    const faultSelector = asString(args['faultSelector']) ?? 'random';
    const record = this.createSessionForActor(boardId, faultSelector, context.actorId);
    const agentView = record.session.getAgentView();
    const payload = {
      scenarioId: record.scenarioId,
      boardId: record.boardId,
      faultSelector: record.faultSelector,
      agentView,
      maxToolCalls: record.session.maxToolCalls,
      probesRemaining: record.session.maxToolCalls - record.session.getToolCallsUsed(),
    };
    // Ground-truth isolation proof: the response must carry ZERO fault fields.
    assertGroundTruthIsolated(payload, record.session.getGroundTruth());
    const verificationReceipt = this.issueReceipt(
      capability,
      record.scenarioId,
      ['scenario isolated to owning actor', 'response scanned: zero ground-truth fields (hiddenFault/faultId/targetComponentRef/faultType/faultSummary absent)'],
      `Scenario ${record.scenarioId} created for board ${boardId}.`,
      correlationId,
    );
    return { ...payload, verificationReceipt };
  }

  /* -- measurements ----------------------------------------------------------- */

  private measureVoltage(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): unknown {
    const capability = 'traceforge.measurements.voltage';
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const node = requireString(args, 'node', correlationId, capability);
    const refNode = asString(args['refNode']) ?? 'GND';
    const record = this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    const session = this.requireUsableSession(record, correlationId, capability);
    this.checkProbeBudget(session, scenarioId, correlationId, capability);
    const resolved = session.resolveProbeNode(node);
    try {
      const reading = session.measureVoltage(node, refNode);
      const reference = getReferenceBoard(record.boardId);
      const spec = reference?.nominalSpecs.find((s) => s.node === resolved);
      const abnormal = spec !== undefined
        ? Math.abs(reading.volts - spec.nominalVolts) > Math.abs(spec.nominalVolts) * spec.toleranceFrac + 1e-9
        : false;
      const payload = {
        scenarioId,
        node,
        refNode,
        volts: reading.volts,
        unit: 'V',
        formatted: reading.formatted,
        nominalVolts: spec?.nominalVolts ?? null,
        abnormal,
        probesUsed: session.getToolCallsUsed(),
        probesRemaining: session.maxToolCalls - session.getToolCallsUsed(),
        pcbHighlight: findPcbPoint(record.boardId, node, resolved),
      };
      assertGroundTruthIsolated(payload, session.getGroundTruth());
      return {
        ...payload,
        verificationReceipt: this.issueReceipt(capability, scenarioId, ['voltage read from session MNA bench', 'probe budget decremented exactly once', 'response scanned: zero ground-truth fields'], `Voltage at ${node}: ${reading.formatted}.`, correlationId),
      };
    } catch (err) {
      if (err instanceof MaasToolError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('budget exhausted')) {
        throw new MaasToolError('MAAS_PROBE_BUDGET_EXHAUSTED', message, correlationId, capability);
      }
      if (message.includes('Unknown measurement node') || message.includes('Unknown reference node')) {
        throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', message, correlationId, capability);
      }
      throw new MaasToolError('MAAS_INVALID_REQUEST', message, correlationId, capability);
    }
  }

  private measureCurrent(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): unknown {
    const capability = 'traceforge.measurements.current';
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const componentId = requireString(args, 'componentId', correlationId, capability);
    const record = this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    const session = this.requireUsableSession(record, correlationId, capability);
    this.checkProbeBudget(session, scenarioId, correlationId, capability);
    try {
      const reading = session.measureCurrent(componentId);
      const payload = {
        scenarioId,
        componentId,
        amps: reading.amps,
        milliamps: reading.milliamps,
        unit: 'A',
        formatted: reading.formatted,
        probesUsed: session.getToolCallsUsed(),
        probesRemaining: session.maxToolCalls - session.getToolCallsUsed(),
      };
      assertGroundTruthIsolated(payload, session.getGroundTruth());
      return {
        ...payload,
        verificationReceipt: this.issueReceipt(capability, scenarioId, ['current read from session MNA bench', 'probe budget decremented exactly once', 'response scanned: zero ground-truth fields'], `Current through ${componentId}: ${reading.formatted}.`, correlationId),
      };
    } catch (err) {
      if (err instanceof MaasToolError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('budget exhausted')) {
        throw new MaasToolError('MAAS_PROBE_BUDGET_EXHAUSTED', message, correlationId, capability);
      }
      if (message.includes('Unknown component')) {
        throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', message, correlationId, capability);
      }
      throw new MaasToolError('MAAS_INVALID_REQUEST', message, correlationId, capability);
    }
  }

  private measureContinuity(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): unknown {
    const capability = 'traceforge.measurements.continuity';
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const probeA = requireString(args, 'probeA', correlationId, capability);
    const probeB = requireString(args, 'probeB', correlationId, capability);
    const record = this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    const session = this.requireUsableSession(record, correlationId, capability);
    this.checkProbeBudget(session, scenarioId, correlationId, capability);
    const resolvedA = session.resolveProbeNode(probeA);
    const resolvedB = session.resolveProbeNode(probeB);
    if (resolvedA === resolvedB) {
      throw new MaasToolError('MAAS_INVALID_REQUEST', `Self-continuity rejected: '${probeA}' and '${probeB}' resolve to the same node '${resolvedA}'.`, correlationId, capability);
    }
    try {
      const reading = session.measureContinuity(probeA, probeB);
      const payload = {
        scenarioId,
        probeA,
        probeB,
        ohms: Number.isFinite(reading.ohms) ? reading.ohms : 'OL',
        unit: 'Ohm',
        continuous: reading.continuous,
        formatted: reading.formatted,
        probesUsed: session.getToolCallsUsed(),
        probesRemaining: session.maxToolCalls - session.getToolCallsUsed(),
        pcbHighlight: [findPcbPoint(record.boardId, probeA, resolvedA), findPcbPoint(record.boardId, probeB, resolvedB)],
      };
      assertGroundTruthIsolated(payload, session.getGroundTruth());
      return {
        ...payload,
        verificationReceipt: this.issueReceipt(capability, scenarioId, ['resistance read from session MNA bench (unpowered model)', 'probe budget decremented exactly once', 'response scanned: zero ground-truth fields'], `Continuity ${probeA}↔${probeB}: ${reading.formatted}.`, correlationId),
      };
    } catch (err) {
      if (err instanceof MaasToolError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('budget exhausted')) {
        throw new MaasToolError('MAAS_PROBE_BUDGET_EXHAUSTED', message, correlationId, capability);
      }
      throw new MaasToolError('MAAS_INVALID_REQUEST', message, correlationId, capability);
    }
  }

  private measureHistory(args: Record<string, unknown>, context: MaasAuthContext): unknown {
    const capability = 'traceforge.measurements.history';
    const scenarioId = requireString(args, 'scenarioId', createMaasCorrelationId(), capability);
    const record = this.requireOwnedScenario(scenarioId, context, createMaasCorrelationId(), capability);
    const probeLog = record.session.getProbeLog();
    return {
      scenarioId,
      probeLog,
      activitySummary: summarizeProbeLog(probeLog),
      pcbHighlights: highlightsForSession(record.boardId, record.session),
      probesUsed: record.session.getToolCallsUsed(),
      probesRemaining: record.session.maxToolCalls - record.session.getToolCallsUsed(),
    };
  }

  /* -- investigations ---------------------------------------------------------- */

  private async investigationsStart(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.investigations.start';
    const scenarioIdArg = asString(args['scenarioId']);
    const boardIdArg = asString(args['boardId']);
    const mode = asString(args['mode']) ?? 'simulated';
    if (!scenarioIdArg && !boardIdArg) {
      throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', 'Either scenarioId or boardId is required.', correlationId, capability);
    }
    if (mode !== 'simulated' && mode !== 'live') {
      throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', `Invalid mode '${mode}': expected 'simulated' or 'live'.`, correlationId, capability);
    }
    let record: ScenarioRecord;
    if (scenarioIdArg) {
      record = this.requireOwnedScenario(scenarioIdArg, context, correlationId, capability);
      this.requireUsableSession(record, correlationId, capability);
    } else {
      const created = this.createSessionForActor(boardIdArg as string, 'random', context.actorId);
      record = created;
    }
    if (mode === 'live') {
      if (!context.scopes.includes('traceforge:live_inference:execute')) {
        throw new MaasToolError('MAAS_AUTHORIZATION_DENIED', `Actor '${context.actorId}' lacks required scope 'traceforge:live_inference:execute' for live inference.`, correlationId, capability);
      }
      if (this.effectiveIncurredCostUsd() >= BUDGET_SAFETY_THRESHOLD_USD) {
        throw new MaasToolError('MAAS_BUDGET_THRESHOLD_EXCEEDED', `Live inference blocked: incurred cost $${this.effectiveIncurredCostUsd().toFixed(2)} reached the $${BUDGET_SAFETY_THRESHOLD_USD.toFixed(2)} safety threshold.`, correlationId, capability);
      }
      throw new MaasToolError('MAAS_UPSTREAM_UNAVAILABLE', 'Live Muse Spark 1.3 upstream is not configured on this server (zero-cost simulated mode). No live call was attempted and no cost was incurred.', correlationId, capability);
    }
    const run = await runAgenticDiagnosis(record.session, this.simClient);
    const probeLog = record.session.getProbeLog();
    const abnormalVoltages = probeLog.filter((p) => p.kind === 'voltage' && p.abnormal).map((p) => p.target);
    const shortedContinuities = probeLog.filter((p) => p.kind === 'resistance' && p.abnormal).map((p) => p.target);
    const investigationId = nextInvestigationId();
    const stored: InvestigationRecord = {
      investigationId,
      scenarioId: record.scenarioId,
      boardId: record.boardId,
      ownerActorId: context.actorId,
      operationalMode: run.operationalMode,
      turns: run.turns,
      steps: run.steps,
      probeEvents: [...probeLog],
      proposedDiagnosis: run.proposedDiagnosis,
      classifiedEvidence: { abnormalVoltages, shortedContinuities, probeCount: probeLog.length },
      telemetry: run.telemetry,
      diagnosisSource: run.diagnosisSource,
      createdAt: new Date().toISOString(),
    };
    this.investigations.set(investigationId, stored);
    // The response carries counts and telemetry only — never the withheld fault.
    const payload = {
      investigationId,
      scenarioId: record.scenarioId,
      boardId: record.boardId,
      operationalMode: run.operationalMode,
      turns: run.turns,
      steps: run.steps.length,
      probesUsed: record.session.getToolCallsUsed(),
      maxToolCalls: record.session.maxToolCalls,
      completed: true,
    };
    assertGroundTruthIsolated(payload, record.session.getGroundTruth());
    return {
      ...payload,
      verificationReceipt: this.issueReceipt(capability, investigationId, ['agentic diagnosis completed against the session MNA bench', 'probe budget respected during investigation', 'response scanned: zero ground-truth fields'], `Investigation ${investigationId} completed in ${run.turns} turn(s) (${run.operationalMode}).`, correlationId),
    };
  }

  private investigationsStatus(args: Record<string, unknown>, context: MaasAuthContext): unknown {
    const record = this.resolveInvestigation(args, context, createMaasCorrelationId(), 'traceforge.investigations.status');
    const scenario = this.scenarios.get(record.scenarioId);
    return {
      investigationId: record.investigationId,
      scenarioId: record.scenarioId,
      status: 'completed' as const,
      operationalMode: record.operationalMode,
      turns: record.turns,
      probesUsed: scenario?.session.getToolCallsUsed() ?? record.probeEvents.length,
      maxToolCalls: scenario?.session.maxToolCalls ?? MAX_TOOL_CALLS,
    };
  }

  private investigationsHistory(args: Record<string, unknown>, context: MaasAuthContext): unknown {
    const record = this.resolveInvestigation(args, context, createMaasCorrelationId(), 'traceforge.investigations.history');
    const scenario = this.scenarios.get(record.scenarioId);
    const probeLog = scenario?.session.getProbeLog() ?? record.probeEvents;
    return {
      investigationId: record.investigationId,
      scenarioId: record.scenarioId,
      steps: record.steps,
      probeLog,
      activitySummary: summarizeProbeLog(probeLog),
      pcbHighlights: scenario ? highlightsForSession(record.boardId, scenario.session) : [],
    };
  }

  private investigationsResult(args: Record<string, unknown>, context: MaasAuthContext): unknown {
    const record = this.resolveInvestigation(args, context, createMaasCorrelationId(), 'traceforge.investigations.result');
    return {
      investigationId: record.investigationId,
      scenarioId: record.scenarioId,
      proposedDiagnosis: record.proposedDiagnosis,
      classifiedEvidence: record.classifiedEvidence,
      verificationStatus: record.proposedDiagnosis.verificationStatus,
      operationalMode: record.operationalMode,
      diagnosisSource: record.diagnosisSource,
      telemetry: record.telemetry,
    };
  }

  /* -- evaluation ---------------------------------------------------------------- */

  private evaluationScore(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): unknown {
    const capability = 'traceforge.evaluation.score';
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const record = this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    if (record.evaluated && record.scorecard) return record.scorecard;
    const groundTruth: HiddenFault | null = record.session.getGroundTruth();
    const probeLog = record.session.getProbeLog();
    const latestInvestigation = [...this.investigations.values()].filter((r) => r.scenarioId === scenarioId).pop();
    const submission = args['submission'] as { componentRef?: unknown; faultType?: unknown; verificationStatus?: unknown } | undefined;
    let componentRef: string | undefined;
    let faultType: string | undefined;
    let verificationStatus: 'confirmed' | 'hypothesis' = 'hypothesis';
    if (submission && typeof submission === 'object') {
      if (typeof submission['componentRef'] === 'string') componentRef = submission['componentRef'] as string;
      if (typeof submission['faultType'] === 'string') faultType = submission['faultType'] as string;
      if (submission['verificationStatus'] === 'confirmed') verificationStatus = 'confirmed';
    } else if (latestInvestigation) {
      componentRef = latestInvestigation.proposedDiagnosis.componentRef;
      faultType = latestInvestigation.proposedDiagnosis.faultType;
      verificationStatus = latestInvestigation.proposedDiagnosis.verificationStatus;
    }
    if (!componentRef || !faultType || probeLog.length === 0) {
      throw new MaasToolError('MAAS_INVESTIGATION_INCOMPLETE', `Scenario '${scenarioId}' has no completed investigation or probing evidence yet; evaluation requires at least one probe plus a proposed diagnosis.`, correlationId, capability);
    }
    if (!groundTruth) {
      const payload = {
        scenarioId,
        score: null,
        groundTruth: { healthy: true as const, boardId: record.boardId, note: 'Nominal session: nothing to score against.' },
      };
      record.evaluated = true;
      record.evaluatedAt = new Date().toISOString();
      record.scorecard = {
        ...payload,
        verificationReceipt: this.issueReceipt(capability, scenarioId, ['nominal session evaluated: no fault present', 'scenario locked against further probing'], `Scenario ${scenarioId} evaluated: healthy board.`, correlationId),
      };
      return record.scorecard;
    }
    const score = scoreDiagnosis({ componentRef, faultType, verificationStatus }, groundTruth, probeLog);
    record.evaluated = true;
    record.evaluatedAt = new Date().toISOString();
    record.scorecard = {
      scenarioId,
      score: {
        totalScore: score.totalScore,
        componentMatch: score.componentMatch,
        faultTypeMatch: score.faultTypeMatch,
        evidenceConfirmed: score.evidenceConfirmed,
        probeCount: score.probeCount,
        efficiencyScore: score.efficiencyScore,
        summary: score.summary,
      },
      groundTruth: {
        faultId: groundTruth.faultId,
        targetComponentRef: groundTruth.targetComponentRef,
        faultType: groundTruth.faultType,
        description: groundTruth.description,
        healthy: false as const,
      },
      verificationReceipt: this.issueReceipt(capability, scenarioId, ['diagnosis scored against withheld HiddenFault', 'ground truth disclosed to owning actor only', 'scenario locked against further probing'], `Scenario ${scenarioId} scored ${score.totalScore}/100.`, correlationId),
    };
    return record.scorecard;
  }

  private evaluationReport(args: Record<string, unknown>, context: MaasAuthContext): unknown {
    const capability = 'traceforge.evaluation.report';
    const correlationId = createMaasCorrelationId();
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const record = this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    if (!record.evaluated || !record.scorecard) {
      throw new MaasToolError('MAAS_INVESTIGATION_INCOMPLETE', `Scenario '${scenarioId}' has not been evaluated yet; run traceforge.evaluation.score first.`, correlationId, capability);
    }
    const scorecard = record.scorecard as { score: { evidenceConfirmed: boolean; totalScore: number } | null; groundTruth: Record<string, unknown> };
    const latestInvestigation = [...this.investigations.values()].filter((r) => r.scenarioId === scenarioId).pop();
    const reference = getReferenceBoard(record.boardId);
    const confirmed = (scorecard.score?.evidenceConfirmed ?? false) && latestInvestigation?.proposedDiagnosis.verificationStatus === 'confirmed';
    return {
      scenarioId,
      boardId: record.boardId,
      evaluatedAt: record.evaluatedAt,
      circuitSummary: reference ? { boardName: reference.boardName, symptom: reference.symptom, nodes: reference.nominal.nodes } : null,
      measurementHistory: {
        probeLog: record.session.getProbeLog(),
        activitySummary: summarizeProbeLog(record.session.getProbeLog()),
        pcbHighlights: highlightsForSession(record.boardId, record.session),
      },
      agentDiagnosis: latestInvestigation?.proposedDiagnosis ?? null,
      scorecard,
      reworkGuidance: confirmed
        ? {
            note: 'Fault confirmed by electrical evidence; rework is authorized.',
            proposedComponent: latestInvestigation?.proposedDiagnosis.componentRef,
            proposedFaultType: latestInvestigation?.proposedDiagnosis.faultType,
          }
        : { note: 'No confirmed fault: rework guidance withheld until evidence confirms a diagnosis.', proposedComponent: null },
      telemetry: latestInvestigation?.telemetry ?? this.simClient.getTelemetry(),
    };
  }
}

/** All known local token strings (for audit scrubbing and tests). */
export const MAAS_KNOWN_TOKEN_STRINGS: string[] = MAAS_LOCAL_TOKENS.map((t) => t.token);

