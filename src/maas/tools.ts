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
  type AgenticDiagnosisRun,
  type AgentStep,
  type ProposedDiagnosis,
} from '../lib/diagnostic-agent';
import {
  AUTHORIZED_ADDITIONAL_BUDGET_USD,
  BUDGET_SAFETY_THRESHOLD_USD,
  LAST_VERIFIED_BALANCE_USD,
  LAST_VERIFIED_CONSUMED_USD,
  LAST_VERIFIED_TIMESTAMP,
  MetaClient,
  STARTING_PROMOTIONAL_BALANCE_USD,
  TARGET_RESERVE_USD,
  estimateLiveCostUsd,
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
    case 'MAAS_SESSION_EXPIRED':
      return 410;
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
  /** Wall-clock expiry for the actor-isolated session (default TTL 30 min). */
  expiresAtMs: number;
  /**
   * True when this record was rehydrated on a cold isolate from a signed
   * `scn_...` token instead of being created locally. Gates cross-isolate
   * auto-diagnosis so in-isolate scenarios without probes still report
   * `MAAS_INVESTIGATION_INCOMPLETE`.
   */
  hydratedFromToken?: boolean;
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
  /** Wall-clock session TTL in ms (default 30 * 60 * 1000). */
  sessionTtlMs?: number;
  /** Optional live Muse Spark 1.3 client for `mode: "live"` investigations. */
  liveClient?: MetaClient;
}

export type MaasHeaderMap = Record<string, string | string[] | undefined>;

let scenarioSeq = 0;
let investigationSeq = 0;

/* ---------------------------------------------------------------------------
 * Authenticated scenario / investigation ids (cross-isolate hydration)
 *
 * Cloudflare may route successive ChatGPT MCP calls to DIFFERENT Worker
 * isolates with disjoint in-memory Maps. To survive that, `scenarioId`
 * (`scn_...`) and `investigationId` (`inv_...`) are SELF-CONTAINED: the
 * payload (board/fault indexes, owner, expiry, sequence) is encrypted with
 * AES-256-GCM (random 96-bit IV per token, Additional Data bound to the
 * token prefix) and hex-encoded — so it carries ZERO readable board/fault
 * strings and always passes `assertGroundTruthIsolated` — and authenticated
 * with BOTH the 128-bit GCM tag and an HMAC-SHA-256 tag, so ANY isolate
 * holding the same session secret can verify and rehydrate the record
 * without shared state. Tenant isolation, session expiry, and ground-truth
 * isolation are enforced on every hydrate exactly as on the originating
 * isolate. There is no XOR masking and no FNV-1a anywhere in this module.
 * ------------------------------------------------------------------------- */

const SCN_TOKEN_PREFIX = 'scn_';
const INV_TOKEN_PREFIX = 'inv_';

/** HMAC tag domain separating scenario/investigation signatures. */
const TOKEN_TAG_DOMAIN = 'traceforge-maas-id-v2';
/** AES-GCM key-derivation domain. */
const TOKEN_AEAD_DOMAIN = 'traceforge-aead-v2::';
/** HMAC key domain. */
const TOKEN_HMAC_DOMAIN = 'traceforge-maas-hmac-v2::';
/** Default session secret (overridden via options or live-key derivation). */
export const DEFAULT_SESSION_SECRET = 'tf-default-session-secret-v2';

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += (b as number).toString(16).padStart(2, '0');
  return hex;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Derive the 256-bit AES-GCM CryptoKey for one session secret. */
async function aeadKeyForSecret(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${TOKEN_AEAD_DOMAIN}${secret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** HMAC-SHA-256 over text under a domain-separated session-secret key. */
async function hmacSignHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${TOKEN_HMAC_DOMAIN}${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(sig));
}

/** Constant-time equality for lowercase hex tags (lengths must match). */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Authenticated-encrypt a token payload: AES-256-GCM (random 96-bit IV,
 * prefix bound as Additional Data, 128-bit GCM tag) plus an 8-hex-char
 * HMAC-SHA-256 tag so the format stays `${prefix}${hex}_${tag8}` matching
 * `/^(scn|inv)_[0-9a-f]+_[0-9a-f]{8}$/`.
 */
export async function encryptSignedToken(prefix: string, payload: Record<string, unknown>, secret: string): Promise<string> {
  const aesKey = await aeadKeyForSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: new TextEncoder().encode(prefix) }, aesKey, plaintext as unknown as BufferSource),
  );
  const combined = new Uint8Array(iv.length + sealed.length);
  combined.set(iv, 0);
  combined.set(sealed, iv.length);
  const hex = bytesToHex(combined);
  const tag8 = (await hmacSignHex(secret, `${prefix}|${hex}|${TOKEN_TAG_DOMAIN}`)).slice(0, 8);
  return `${prefix}${hex}_${tag8}`;
}

/**
 * Verify and decrypt a token: validates prefix, `_${tag8}` suffix, and hex
 * shape, checks the HMAC-SHA-256 tag in constant time, then AES-256-GCM
 * decrypts (128-bit GCM tag verification included). Returns `null` on any
 * failure — wrong key, bit flip, truncation, or malformed JSON.
 */
export async function decryptSignedToken(prefix: string, token: string, secret: string): Promise<Record<string, unknown> | null> {
  if (typeof token !== 'string' || !token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  const sep = rest.lastIndexOf('_');
  if (sep <= 0) return null;
  const hex = rest.slice(0, sep);
  const tag = rest.slice(sep + 1);
  if (hex.length < 56 || hex.length > 8192 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/.test(hex) || !/^[0-9a-f]{8}$/.test(tag)) return null;
  const expected = (await hmacSignHex(secret, `${prefix}|${hex}|${TOKEN_TAG_DOMAIN}`)).slice(0, 8);
  if (!constantTimeHexEqual(expected, tag)) return null;
  const combined = hexToBytes(hex);
  if (!combined || combined.length < 12 + 16) return null;
  const iv = combined.slice(0, 12);
  const sealed = combined.slice(12);
  try {
    const aesKey = await aeadKeyForSecret(secret);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: new TextEncoder().encode(prefix) },
      aesKey,
      sealed as unknown as BufferSource,
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function encodeScenarioToken(payload: { b: number; f: number; o: string; x: number; q: number }, secret: string): Promise<string> {
  return encryptSignedToken(SCN_TOKEN_PREFIX, payload as unknown as Record<string, unknown>, secret);
}

async function decodeScenarioToken(token: string, secret: string): Promise<{ b: number; f: number; o: string; x: number; q: number } | null> {
  const decoded = await decryptSignedToken(SCN_TOKEN_PREFIX, token, secret);
  if (!decoded) return null;
  const { b, f, o, x, q } = decoded as { b: unknown; f: unknown; o: unknown; x: unknown; q: unknown };
  if (!Number.isInteger(b) || !Number.isInteger(f) || typeof o !== 'string' || o.length === 0) return null;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof q !== 'number' || !Number.isFinite(q)) return null;
  return { b: b as number, f: f as number, o, x, q };
}

export interface InvestigationTokenExtras {
  /** Stored operational mode (e.g. 'LIVE_API') for cross-isolate restoration. */
  m?: OperationalMode;
  /** Stored turn count. */
  t?: number;
  /** Stored proposed diagnosis. */
  d?: ProposedDiagnosis;
  /** Stored diagnosis source ('model_final_diagnosis' | 'evidence_fallback'). */
  src?: string;
  /** Stored usage telemetry snapshot. */
  u?: UsageTelemetry;
}

async function encodeInvestigationToken(payload: { s: string; o: string; q: number } & InvestigationTokenExtras, secret: string): Promise<string> {
  return encryptSignedToken(INV_TOKEN_PREFIX, payload as unknown as Record<string, unknown>, secret);
}

async function decodeInvestigationToken(token: string, secret: string): Promise<({ s: string; o: string; q: number } & InvestigationTokenExtras) | null> {
  const decoded = await decryptSignedToken(INV_TOKEN_PREFIX, token, secret);
  if (!decoded) return null;
  const { s, o, q, m, t, d, src, u } = decoded as {
    s: unknown; o: unknown; q: unknown; m: unknown; t: unknown; d: unknown; src: unknown; u: unknown;
  };
  if (typeof s !== 'string' || s.length === 0 || typeof o !== 'string' || o.length === 0) return null;
  if (typeof q !== 'number' || !Number.isFinite(q)) return null;
  const extras: InvestigationTokenExtras = {};
  if (typeof m === 'string' && m.length > 0) extras.m = m as OperationalMode;
  if (typeof t === 'number' && Number.isFinite(t)) extras.t = t;
  if (d !== null && typeof d === 'object' && !Array.isArray(d)) extras.d = d as ProposedDiagnosis;
  if (typeof src === 'string' && src.length > 0) extras.src = src;
  if (u !== null && typeof u === 'object' && !Array.isArray(u)) extras.u = u as UsageTelemetry;
  return { s, o, q, ...extras };
}

/* ---------------------------------------------------------------------------
 * Best-effort Cloudflare Edge Cache persistence (cross-isolate, same colo)
 *
 * In addition to the self-contained signed tokens above, completed
 * investigations and evaluated scorecards are best-effort stored in
 * `caches.default` (present on Cloudflare Workers, absent in Node/tests)
 * keyed by stable internal URLs. A cold isolate in the same edge colocation
 * can then hydrate the EXACT `LIVE_API` InvestigationRecord and scorecard
 * when the caller passes only a scenarioId — no second live API call.
 * All payloads are ground-truth-free (verified by
 * `assertGroundTruthIsolated` before they are stored or returned).
 * ------------------------------------------------------------------------- */

const EDGE_CACHE_SCENARIO_PREFIX = 'https://traceforge-internal.local/scn/';
const EDGE_CACHE_INVESTIGATION_PREFIX = 'https://traceforge-internal.local/inv/';

interface EdgeCacheLike {
  match(key: string): Promise<{ json(): Promise<unknown> } | undefined>;
  put(key: string, response: unknown): Promise<void>;
}

function getEdgeCache(): EdgeCacheLike | null {
  try {
    const cache = (globalThis as { caches?: { default?: EdgeCacheLike } }).caches?.default;
    return cache ?? null;
  } catch {
    return null;
  }
}

async function edgeCacheGet<T>(key: string): Promise<T | null> {
  const cache = getEdgeCache();
  if (!cache) return null;
  try {
    const res = await cache.match(key);
    if (!res) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function edgeCachePut(key: string, value: unknown): void {
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    const ResponseCtor = (globalThis as { Response?: new (body: string, init: { headers: Record<string, string> }) => unknown }).Response;
    if (!ResponseCtor) return;
    void cache.put(key, new ResponseCtor(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
  } catch {
    // Best-effort only: edge persistence must never fail a tool call.
  }
}

function edgeScenarioKey(scenarioId: string): string {
  return `${EDGE_CACHE_SCENARIO_PREFIX}${scenarioId}`;
}

/* ---------------------------------------------------------------------------
 * Runtime live-AI telemetry snapshot (cross-isolate, same colo)
 *
 * Whenever a real live call succeeds — `investigationsStart` with an
 * explicit `mode: "live"` or a browser Live AI call via `/api/meta/chat` on
 * the Worker — the cumulative live spend and `liveVerified: true` flag are
 * persisted to `caches.default` under this key. Read-only tools
 * (`traceforge.models.status`, `traceforge.budget.status`) read/merge the
 * snapshot instead of invoking paid inference, so every isolate in the
 * colocation reports the same Worker runtime ledger without spending.
 * ------------------------------------------------------------------------- */

const EDGE_CACHE_RUNTIME_TELEMETRY_KEY = 'https://traceforge-internal.local/runtime/telemetry';

interface EdgeRuntimeTelemetrySnapshot {
  incurredCostUsd?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalRequests?: unknown;
  liveVerified?: unknown;
}

function asNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function edgeInvestigationKey(investigationId: string): string {
  return `${EDGE_CACHE_INVESTIGATION_PREFIX}${investigationId}`;
}

interface EdgeCachedScenario {
  investigation?: InvestigationRecord;
  evaluated?: boolean;
  evaluatedAt?: string;
  scorecard?: Record<string, unknown>;
}

function isEdgeCachedScenario(value: unknown): value is EdgeCachedScenario {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInvestigationRecord(value: unknown): value is InvestigationRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return typeof r['investigationId'] === 'string' && typeof r['scenarioId'] === 'string' && typeof r['ownerActorId'] === 'string';
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
  private readonly sessionTtlMs: number;
  private liveClient?: MetaClient;
  private liveVerificationError: string | null = null;
  /** AES-256-GCM + HMAC-SHA-256 session secret for `scn_`/`inv_` tokens. */
  private sessionSecret: string;
  /** Live spend recorded via `recordExternalLiveUsage` (browser `/api/meta/chat` + MCP live calls). */
  private externalLiveSpendUsd = 0;
  private externalInputTokens = 0;
  private externalOutputTokens = 0;
  private externalTotalRequests = 0;
  private externalProviderReported = false;
  /** Remote-colo spend/verified flag merged from the edge-cached runtime snapshot. */
  private edgeCachedLiveSpendUsd = 0;
  private edgeLiveVerified = false;

  constructor(options: MaasServiceOptions = {}) {
    for (const d of TRACEFORGE_MAAS_TOOL_DESCRIPTORS) this.descriptors.set(d.name, d);
    this.verifier = new TraceForgeVerificationEngine(options.verificationKey);
    this.rateLimiter = new MaasRateLimiter(options.maxRequestsPerWindow ?? 120, options.rateLimitWindowMs ?? 60_000);
    this.authenticator = new MaasAuthenticator(this.killSwitch);
    this.maxSessionsPerActor = options.maxSessionsPerActor ?? 25;
    this.injectedLiveSpendUsd = options.initialIncurredCostUsd ?? 0;
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 60 * 1000;
    this.sessionSecret = options.verificationKey ?? DEFAULT_SESSION_SECRET;
    if (options.liveClient) this.liveClient = options.liveClient;
  }

  /** Override the AES-256-GCM session secret (tests, key rotation). */
  configureSessionSecret(secret: string): void {
    if (!secret || secret.length === 0) return;
    this.sessionSecret = secret;
  }

  /** Rotate the session secret: tokens minted under the old secret stop verifying. */
  rotateSessionSecret(newSecret: string): void {
    this.configureSessionSecret(newSecret);
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

  /** Test seam: force one scenario past its TTL so expiry paths are exercisable. */
  expireScenarioForTesting(scenarioId: string): void {
    const record = this.scenarios.get(scenarioId);
    if (!record) throw new Error(`Unknown scenario '${scenarioId}'.`);
    record.expiresAtMs = Date.now() - 1;
  }

  /** True once a live Muse Spark 1.3 client is attached (env key or injected). */
  hasLiveClient(): boolean {
    return this.liveClient !== undefined;
  }

  /**
   * Attach a live Muse Spark 1.3 client from a server-side `META_API_KEY`.
   * The key is consumed strictly server-side and never exposed in payloads.
   * When the session secret is still the default, it is derived from the
   * live key so the deployed Worker automatically keys AES-256-GCM with its
   * server-side Cloudflare secret (`META_API_KEY` / `TRACEFORGE_SESSION_SECRET`).
   */
  configureLiveApiKey(apiKey: string): void {
    if (!apiKey || !apiKey.trim()) return;
    this.liveClient = new MetaClient({ mode: 'live', apiKey: apiKey.trim(), segmentationMode: 'static_fixture' });
    if (this.sessionSecret === DEFAULT_SESSION_SECRET) {
      this.sessionSecret = `tf-live-derived::${apiKey.trim()}`;
    }
    this.liveVerificationError = null;
  }

  /**
   * Record externally observed live usage (browser Live AI calls via
   * `/api/meta/chat` and MCP `mode: "live"` calls) into the shared Worker
   * runtime ledger, and persist it to `caches.default` so every isolate in
   * the colocation reports the same spend without invoking paid inference.
   */
  recordExternalLiveUsage(usage: { inputTokens: number; outputTokens: number; providerReported: boolean }): void {
    const input = asNonNegativeNumber(usage.inputTokens);
    const output = asNonNegativeNumber(usage.outputTokens);
    const cost = estimateLiveCostUsd(input, output);
    this.externalInputTokens += input;
    this.externalOutputTokens += output;
    this.externalTotalRequests += 1;
    this.externalLiveSpendUsd += cost;
    if (usage.providerReported) this.externalProviderReported = true;
    this.edgeLiveVerified = true;
    void this.persistEdgeRuntimeSnapshot();
  }

  /** Merge the edge-cached runtime snapshot into the in-memory ledger view. */
  private async refreshEdgeRuntimeSnapshot(): Promise<void> {
    const snapshot = await edgeCacheGet<EdgeRuntimeTelemetrySnapshot>(EDGE_CACHE_RUNTIME_TELEMETRY_KEY);
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot['liveVerified'] === true) this.edgeLiveVerified = true;
    // The snapshot holds cumulative cross-isolate spend; only the remote
    // portion (beyond this isolate's own external ledger) is added to avoid
    // double counting.
    const remote = asNonNegativeNumber(snapshot['incurredCostUsd']) - this.externalLiveSpendUsd;
    if (remote > this.edgeCachedLiveSpendUsd) this.edgeCachedLiveSpendUsd = remote;
  }

  /** Best-effort persist of the cumulative runtime snapshot (never throws). */
  private async persistEdgeRuntimeSnapshot(): Promise<void> {
    try {
      const previous = await edgeCacheGet<EdgeRuntimeTelemetrySnapshot>(EDGE_CACHE_RUNTIME_TELEMETRY_KEY);
      const previousSpend = previous && typeof previous === 'object' ? asNonNegativeNumber(previous['incurredCostUsd']) : 0;
      const cumulative = Math.max(
        previousSpend,
        this.externalLiveSpendUsd + this.edgeCachedLiveSpendUsd + (this.liveClient?.getTelemetry().incurredCostUsd ?? 0),
      );
      edgeCachePut(EDGE_CACHE_RUNTIME_TELEMETRY_KEY, {
        incurredCostUsd: cumulative,
        inputTokens: this.externalInputTokens + (this.liveClient?.getTelemetry().inputTokens ?? 0),
        outputTokens: this.externalOutputTokens + (this.liveClient?.getTelemetry().outputTokens ?? 0),
        totalRequests: this.externalTotalRequests + (this.liveClient?.getTelemetry().totalRequests ?? 0),
        liveVerified: true,
      });
      this.edgeCachedLiveSpendUsd = Math.max(0, cumulative - this.externalLiveSpendUsd);
      this.edgeLiveVerified = true;
    } catch {
      // Best-effort only.
    }
  }

  /** True once any real live call has verified this runtime (isolate or colo). */
  isLiveVerified(): boolean {
    return (this.liveClient?.status().liveVerified ?? false) || this.edgeLiveVerified;
  }

  /** True when the $95.00 safety stop is breached by either spend measure. */
  isBudgetSafetyBreached(): boolean {
    const incurred = this.effectiveIncurredCostUsd();
    return incurred >= BUDGET_SAFETY_THRESHOLD_USD
      || (LAST_VERIFIED_CONSUMED_USD + incurred) >= BUDGET_SAFETY_THRESHOLD_USD;
  }

  private combinedTelemetry(): { incurredCostUsd: number; projectedLiveCostUsd: number; inputTokens: number; outputTokens: number; totalRequests: number; providerReportedUsage: boolean } {
    const sim = this.simClient.getTelemetry();
    const live = this.liveClient?.getTelemetry();
    return {
      incurredCostUsd: sim.incurredCostUsd + (live?.incurredCostUsd ?? 0) + this.externalLiveSpendUsd,
      projectedLiveCostUsd: sim.projectedLiveCostUsd + (live?.projectedLiveCostUsd ?? 0) + this.externalLiveSpendUsd,
      inputTokens: sim.inputTokens + (live?.inputTokens ?? 0) + this.externalInputTokens,
      outputTokens: sim.outputTokens + (live?.outputTokens ?? 0) + this.externalOutputTokens,
      totalRequests: sim.totalRequests + (live?.totalRequests ?? 0) + this.externalTotalRequests,
      providerReportedUsage: sim.providerReportedUsage || (live?.providerReportedUsage ?? false) || this.externalProviderReported,
    };
  }

  private effectiveIncurredCostUsd(): number {
    return this.combinedTelemetry().incurredCostUsd + this.injectedLiveSpendUsd + this.edgeCachedLiveSpendUsd;
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

  private async dispatch(capability: string, args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
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

  private async requireOwnedScenario(scenarioId: string, context: MaasAuthContext, correlationId: string, capability: string): Promise<ScenarioRecord> {
    const record = this.scenarios.get(scenarioId);
    if (record) {
      if (record.ownerActorId !== context.actorId) {
        throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Scenario '${scenarioId}' belongs to another actor.`, correlationId, capability);
      }
      if (Date.now() > record.expiresAtMs) {
        throw new MaasToolError('MAAS_SESSION_EXPIRED', `Scenario '${scenarioId}' has expired.`, correlationId, capability);
      }
      return record;
    }
    // Cold-isolate path: rehydrate from the self-contained AES-256-GCM
    // `scn_...` token minted by whichever isolate created the scenario.
    // Invalid or unparseable tokens fail exactly as before.
    const decoded = await decodeScenarioToken(scenarioId, this.sessionSecret);
    if (!decoded) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown scenario '${scenarioId}'.`, correlationId, capability);
    }
    const boards = listReferenceBoards();
    const reference = boards[decoded.b];
    if (!reference || decoded.b < 0 || decoded.f < -1 || decoded.f >= reference.faults.length) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown scenario '${scenarioId}'.`, correlationId, capability);
    }
    const faultId = decoded.f === -1 ? 'nominal' : reference.faults[decoded.f]?.faultId;
    if (!faultId) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown scenario '${scenarioId}'.`, correlationId, capability);
    }
    let session: VirtualLabSession;
    try {
      session = createVirtualSession(reference.boardId, faultId);
    } catch {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown scenario '${scenarioId}'.`, correlationId, capability);
    }
    const hydrated: ScenarioRecord = {
      scenarioId,
      boardId: reference.boardId,
      ownerActorId: decoded.o,
      session,
      evaluated: false,
      faultSelector: decoded.f === -1 ? 'nominal' : 'indexed',
      createdAt: new Date().toISOString(),
      expiresAtMs: decoded.x,
      hydratedFromToken: true,
    };
    this.scenarios.set(scenarioId, hydrated);
    if (Date.now() > hydrated.expiresAtMs) {
      throw new MaasToolError('MAAS_SESSION_EXPIRED', `Scenario '${scenarioId}' has expired.`, correlationId, capability);
    }
    if (hydrated.ownerActorId !== context.actorId) {
      throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Scenario '${scenarioId}' belongs to another actor.`, correlationId, capability);
    }
    return hydrated;
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

  /**
   * Build and store an `InvestigationRecord` for a scenario from one
   * deterministic agentic-diagnosis run against this isolate's session bench.
   */
  private async diagnoseAndStoreInvestigation(
    investigationId: string,
    scenarioRecord: ScenarioRecord,
    ownerActorId: string,
  ): Promise<InvestigationRecord> {
    const run: AgenticDiagnosisRun = await runAgenticDiagnosis(scenarioRecord.session, this.simClient);
    const probeLog = scenarioRecord.session.getProbeLog();
    const stored: InvestigationRecord = {
      investigationId,
      scenarioId: scenarioRecord.scenarioId,
      boardId: scenarioRecord.boardId,
      ownerActorId,
      operationalMode: run.operationalMode,
      turns: run.turns,
      steps: run.steps,
      probeEvents: [...probeLog],
      proposedDiagnosis: run.proposedDiagnosis,
      classifiedEvidence: {
        abnormalVoltages: probeLog.filter((p) => p.kind === 'voltage' && p.abnormal).map((p) => p.target),
        shortedContinuities: probeLog.filter((p) => p.kind === 'resistance' && p.abnormal).map((p) => p.target),
        probeCount: probeLog.length,
      },
      telemetry: run.telemetry,
      diagnosisSource: run.diagnosisSource,
      createdAt: new Date().toISOString(),
    };
    this.investigations.set(investigationId, stored);
    edgeCachePut(edgeInvestigationKey(investigationId), stored);
    edgeCachePut(edgeScenarioKey(scenarioRecord.scenarioId), { investigation: stored });
    return stored;
  }

  private async nextSignedInvestigationId(scenarioId: string, ownerActorId: string, extras: InvestigationTokenExtras = {}): Promise<string> {
    investigationSeq += 1;
    return encodeInvestigationToken({ s: scenarioId, o: ownerActorId, q: investigationSeq, ...extras }, this.sessionSecret);
  }

  private async resolveInvestigation(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string, capability: string): Promise<InvestigationRecord> {
    const investigationId = asString(args['investigationId']);
    const scenarioId = asString(args['scenarioId']);
    if (!investigationId && !scenarioId) {
      throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', 'Either investigationId or scenarioId is required.', correlationId, capability);
    }
    if (investigationId) {
      const existing = this.investigations.get(investigationId);
      if (existing) {
        if (existing.ownerActorId !== context.actorId) {
          throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Investigation '${existing.investigationId}' belongs to another actor.`, correlationId, capability);
        }
        return existing;
      }
      // Cold-isolate path: rehydrate from the AES-256-GCM `inv_...` token.
      // Only a valid token hydrates; anything else fails exactly as before.
      const decoded = await decodeInvestigationToken(investigationId, this.sessionSecret);
      if (!decoded) {
        throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `No investigation found for '${investigationId}'.`, correlationId, capability);
      }
      if (decoded.o !== context.actorId) {
        throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Investigation '${investigationId}' belongs to another actor.`, correlationId, capability);
      }
      // Same-colo edge fast path: the exact completed record (LIVE_API or
      // simulated) may already be cached — restore it with zero new API calls.
      const cached = await edgeCacheGet<unknown>(edgeInvestigationKey(investigationId));
      if (isInvestigationRecord(cached) && cached.ownerActorId === context.actorId && cached.investigationId === investigationId) {
        this.investigations.set(investigationId, cached);
        return cached;
      }
      const scenarioRecord = await this.requireOwnedScenario(decoded.s, context, correlationId, capability);
      // Populate the session bench deterministically when this cold isolate
      // has logged no probes yet (needed for history/evaluation views).
      const stored = await this.diagnoseAndStoreInvestigation(investigationId, scenarioRecord, context.actorId);
      // Token-carried completed fields win: a LIVE_API investigation started
      // on Isolate A still reports operationalMode LIVE_API (and its exact
      // diagnosis/telemetry) on Isolate B without a second live API call.
      if (decoded.m !== undefined) stored.operationalMode = decoded.m;
      if (decoded.t !== undefined) stored.turns = decoded.t;
      if (decoded.d !== undefined) stored.proposedDiagnosis = decoded.d;
      if (decoded.src !== undefined) stored.diagnosisSource = decoded.src;
      if (decoded.u !== undefined) stored.telemetry = decoded.u;
      return stored;
    }
    const owned = await this.requireOwnedScenario(scenarioId as string, context, correlationId, capability);
    const record = [...this.investigations.values()].filter((r) => r.scenarioId === owned.scenarioId).pop();
    if (record) {
      if (record.ownerActorId !== context.actorId) {
        throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Investigation '${record.investigationId}' belongs to another actor.`, correlationId, capability);
      }
      return record;
    }
    // Same-colo edge fast path for scenario-only lookups: restore the exact
    // cached LIVE_API record when the caller passes only a scenarioId.
    const cachedByScenario = await edgeCacheGet<unknown>(edgeScenarioKey(owned.scenarioId));
    if (isEdgeCachedScenario(cachedByScenario) && isInvestigationRecord(cachedByScenario.investigation)) {
      const inv = cachedByScenario.investigation;
      if (inv.ownerActorId === context.actorId && inv.scenarioId === owned.scenarioId) {
        this.investigations.set(inv.investigationId, inv);
        return inv;
      }
    }
    // Cold-isolate path: the scenario hydrated from a foreign `scn_...` token
    // (never created in this isolate's map) carries no investigation yet, so
    // run the deterministic diagnosis here. Scenarios created in THIS isolate
    // keep throwing `MAAS_RESOURCE_NOT_FOUND` so existing behavior is intact.
    if (!owned.hydratedFromToken) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `No investigation found for '${scenarioId}'.`, correlationId, capability);
    }
    return this.diagnoseAndStoreInvestigation(await this.nextSignedInvestigationId(owned.scenarioId, context.actorId), owned, context.actorId);
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

  private async modelsStatus(): Promise<unknown> {
    if (!this.liveClient) {
      const status = this.simClient.status();
      return {
        spark: { model: 'muse-spark-1.3', operationalMode: status.sparkMode, liveVerified: status.liveVerified, executionSource: 'Deterministic Virtual Lab', liveCredentialConfigured: false },
        sam: { model: 'sam-3.1', operationalMode: status.samMode, executionSource: 'Static Reference Fixture', note: 'Live SAM 3.1 deferred; static KiCad fixture overlays labeled STATIC_FIXTURE.' },
        transparencyNote: 'SIMULATED = deterministic mock; LIVE_API only after a verified real response. Simulated results are never presented as live inference.',
      };
    }
    // Explicit spending control: this read-only tool NEVER calls
    // `live.chat(...)` — paid inference is only triggered by an explicit
    // `mode: "live"` investigation or a browser `/api/meta/chat` call. The
    // live-verified flag comes from this isolate's client plus the
    // edge-cached runtime snapshot persisted by real live calls.
    await this.refreshEdgeRuntimeSnapshot();
    const status = this.liveClient.status();
    const verified = status.liveVerified || this.edgeLiveVerified;
    const operationalMode: OperationalMode = verified ? 'LIVE_API' : 'UNVERIFIED';
    const executionSource = 'Live Muse Spark 1.3';
    return {
      spark: {
        model: 'muse-spark-1.3',
        operationalMode,
        liveVerified: verified,
        executionSource,
        liveCredentialConfigured: true,
        ...(this.liveVerificationError ? { error: this.liveVerificationError } : {}),
      },
      sam: { model: 'sam-3.1', operationalMode: status.samMode, executionSource: 'Static Reference Fixture', note: 'Live SAM 3.1 deferred; static KiCad fixture overlays labeled STATIC_FIXTURE.' },
      transparencyNote: 'SIMULATED = deterministic mock; LIVE_API only after a verified real response. Simulated results are never presented as live inference.',
    };
  }

  private async budgetStatus(): Promise<unknown> {
    await this.refreshEdgeRuntimeSnapshot();
    const telemetry = this.combinedTelemetry();
    const incurred = this.effectiveIncurredCostUsd();
    return {
      startingBalanceUsd: STARTING_PROMOTIONAL_BALANCE_USD,
      baselineNote: 'Unverified snapshot recorded 2026-10-26 (see AGENTS.md §8); provider-reported usage wins when present.',
      authorizedCeilingUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD,
      mandatoryReserveUsd: TARGET_RESERVE_USD,
      safetyThresholdUsd: BUDGET_SAFETY_THRESHOLD_USD,
      lastVerifiedBalanceUsd: LAST_VERIFIED_BALANCE_USD,
      lastVerifiedConsumedUsd: LAST_VERIFIED_CONSUMED_USD,
      lastVerifiedTimestamp: LAST_VERIFIED_TIMESTAMP,
      verifiedNote: 'Verified $122.78 balance ($24.48 consumed across Muse Code CLI + live API; $75.52 remaining of $100.00 authorized budget) as of 2026-10-26T20:08:24-05:00.',
      verifiedRemainingBudgetUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD - LAST_VERIFIED_CONSUMED_USD,
      ledger: {
        incurredCostUsd: incurred,
        projectedLiveCostUsd: telemetry.projectedLiveCostUsd,
        inputTokens: telemetry.inputTokens,
        outputTokens: telemetry.outputTokens,
        totalRequests: telemetry.totalRequests,
        providerReportedUsage: telemetry.providerReportedUsage,
      },
      ledgerScopeNote: 'ledger tracks runtime Meta API calls observed by this Worker isolate/colo since deployment, while lastVerifiedConsumedUsd ($24.48) is the provider-confirmed cumulative consumption across Muse Code CLI and runtime API.',
      remainingBudgetUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD - incurred,
      safetyThresholdBreached: this.isBudgetSafetyBreached(),
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

  private async createSessionForActor(boardId: string, faultSelector: string, ownerActorId: string): Promise<ScenarioRecord> {
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
    // Self-contained AES-256-GCM id: board/fault indexes (never readable
    // strings), owner, expiry, and sequence — authenticated encryption plus
    // an HMAC-SHA-256 tag, so any cold isolate with the session secret can
    // verify and rehydrate without shared state. The fault index is read
    // back from the session ground truth so `random` selectors rehydrate to
    // the exact injected fault.
    const boards = listReferenceBoards();
    const boardIdx = boards.findIndex((b) => b.boardId === boardId);
    const groundTruth = session.getGroundTruth();
    const faultIdx = groundTruth
      ? reference.faults.findIndex((f) => f.faultId === groundTruth.faultId)
      : -1;
    const expiresAtMs = Date.now() + this.sessionTtlMs;
    scenarioSeq += 1;
    const scenarioId = await encodeScenarioToken({ b: boardIdx, f: faultIdx, o: ownerActorId, x: expiresAtMs, q: scenarioSeq }, this.sessionSecret);
    const record: ScenarioRecord = {
      scenarioId,
      boardId,
      ownerActorId,
      session,
      evaluated: false,
      faultSelector: this.selectorLabel(faultSelector),
      createdAt: new Date().toISOString(),
      expiresAtMs,
      hydratedFromToken: false,
    };
    this.scenarios.set(scenarioId, record);
    return record;
  }

  private async scenariosCreate(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.scenarios.create';
    const boardId = requireString(args, 'boardId', correlationId, capability);
    const faultSelector = asString(args['faultSelector']) ?? 'random';
    const record = await this.createSessionForActor(boardId, faultSelector, context.actorId);
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

  private async measureVoltage(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.measurements.voltage';
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const node = requireString(args, 'node', correlationId, capability);
    const refNode = asString(args['refNode']) ?? 'GND';
    const record = await this.requireOwnedScenario(scenarioId, context, correlationId, capability);
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

  private async measureCurrent(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.measurements.current';
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const componentId = requireString(args, 'componentId', correlationId, capability);
    const record = await this.requireOwnedScenario(scenarioId, context, correlationId, capability);
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

  private async measureContinuity(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.measurements.continuity';
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const probeA = requireString(args, 'probeA', correlationId, capability);
    const probeB = requireString(args, 'probeB', correlationId, capability);
    const record = await this.requireOwnedScenario(scenarioId, context, correlationId, capability);
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

  private async measureHistory(args: Record<string, unknown>, context: MaasAuthContext): Promise<unknown> {
    const capability = 'traceforge.measurements.history';
    const scenarioId = requireString(args, 'scenarioId', createMaasCorrelationId(), capability);
    const record = await this.requireOwnedScenario(scenarioId, context, createMaasCorrelationId(), capability);
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
    const explicitMode = asString(args['mode']);
    let mode: string;
    if (explicitMode === 'simulated' || explicitMode === 'live') {
      mode = explicitMode;
    } else if (explicitMode !== undefined) {
      throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', `Invalid mode '${explicitMode}': expected 'simulated' or 'live'.`, correlationId, capability);
    } else {
      // Explicit live-AI spending control: an omitted `mode` ALWAYS defaults
      // to 'simulated' (non-billable Virtual Lab execution, $0.00), even when
      // a live client is attached. Only an explicit `mode: "live"` argument
      // can trigger paid `muse-spark-1.3` inference.
      mode = 'simulated';
    }
    if (!scenarioIdArg && !boardIdArg) {
      throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', 'Either scenarioId or boardId is required.', correlationId, capability);
    }
    let record: ScenarioRecord;
    if (scenarioIdArg) {
      record = await this.requireOwnedScenario(scenarioIdArg, context, correlationId, capability);
      this.requireUsableSession(record, correlationId, capability);
    } else {
      const created = await this.createSessionForActor(boardIdArg as string, 'random', context.actorId);
      record = created;
    }
    if (mode === 'live') {
      if (!context.scopes.includes('traceforge:live_inference:execute')) {
        throw new MaasToolError('MAAS_AUTHORIZATION_DENIED', `Actor '${context.actorId}' lacks required scope 'traceforge:live_inference:execute' for live inference.`, correlationId, capability);
      }
      if (this.isBudgetSafetyBreached()) {
        throw new MaasToolError('MAAS_BUDGET_THRESHOLD_EXCEEDED', `Live inference blocked: incurred cost $${this.effectiveIncurredCostUsd().toFixed(2)} reached the $${BUDGET_SAFETY_THRESHOLD_USD.toFixed(2)} safety threshold.`, correlationId, capability);
      }
      if (!this.liveClient) {
        throw new MaasToolError('MAAS_UPSTREAM_UNAVAILABLE', 'Live Muse Spark 1.3 upstream is not configured on this server (zero-cost simulated mode). No live call was attempted and no cost was incurred.', correlationId, capability);
      }
    }
    let run: AgenticDiagnosisRun;
    if (mode === 'live' && this.liveClient) {
      // Live failures NEVER fall back to the simulator: an upstream error is
      // reported honestly so simulated output is never shown as live.
      try {
        run = await runAgenticDiagnosis(record.session, this.liveClient);
      } catch (err) {
        throw new MaasToolError('MAAS_UPSTREAM_UNAVAILABLE', err instanceof Error ? err.message : String(err), correlationId, capability);
      }
      // A real live call succeeded: persist the lightweight runtime telemetry
      // + verification snapshot so read-only tools report LIVE_API without
      // invoking paid inference again.
      this.edgeLiveVerified = true;
      void this.persistEdgeRuntimeSnapshot();
    } else {
      run = await runAgenticDiagnosis(record.session, this.simClient);
    }
    const probeLog = record.session.getProbeLog();
    const abnormalVoltages = probeLog.filter((p) => p.kind === 'voltage' && p.abnormal).map((p) => p.target);
    const shortedContinuities = probeLog.filter((p) => p.kind === 'resistance' && p.abnormal).map((p) => p.target);
    const executionSource = run.operationalMode === 'LIVE_API' ? 'Live Muse Spark 1.3' : 'Deterministic Virtual Lab';
    const investigationId = await this.nextSignedInvestigationId(record.scenarioId, context.actorId, {
      m: run.operationalMode,
      t: run.turns,
      d: run.proposedDiagnosis,
      src: run.diagnosisSource,
      u: run.telemetry,
    });
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
    // Best-effort edge persistence so a cold isolate in the same colocation
    // hydrates this exact completed record (LIVE_API included) with no new
    // API call, even for scenarioId-only lookups.
    edgeCachePut(edgeInvestigationKey(investigationId), stored);
    edgeCachePut(edgeScenarioKey(record.scenarioId), { investigation: stored });
    // The response carries counts and telemetry only — never the withheld fault.
    const payload = {
      investigationId,
      scenarioId: record.scenarioId,
      boardId: record.boardId,
      operationalMode: run.operationalMode,
      executionSource,
      diagnosisSource: run.diagnosisSource,
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

  private async investigationsStatus(args: Record<string, unknown>, context: MaasAuthContext): Promise<unknown> {
    const record = await this.resolveInvestigation(args, context, createMaasCorrelationId(), 'traceforge.investigations.status');
    const scenario = this.scenarios.get(record.scenarioId);
    return {
      investigationId: record.investigationId,
      scenarioId: record.scenarioId,
      status: 'completed' as const,
      operationalMode: record.operationalMode,
      executionSource: record.operationalMode === 'LIVE_API' ? 'Live Muse Spark 1.3' : 'Deterministic Virtual Lab',
      diagnosisSource: record.diagnosisSource,
      turns: record.turns,
      probesUsed: scenario?.session.getToolCallsUsed() ?? record.probeEvents.length,
      maxToolCalls: scenario?.session.maxToolCalls ?? MAX_TOOL_CALLS,
    };
  }

  private async investigationsHistory(args: Record<string, unknown>, context: MaasAuthContext): Promise<unknown> {
    const record = await this.resolveInvestigation(args, context, createMaasCorrelationId(), 'traceforge.investigations.history');
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

  private async investigationsResult(args: Record<string, unknown>, context: MaasAuthContext): Promise<unknown> {
    const record = await this.resolveInvestigation(args, context, createMaasCorrelationId(), 'traceforge.investigations.result');
    return {
      investigationId: record.investigationId,
      scenarioId: record.scenarioId,
      proposedDiagnosis: record.proposedDiagnosis,
      classifiedEvidence: record.classifiedEvidence,
      verificationStatus: record.proposedDiagnosis.verificationStatus,
      operationalMode: record.operationalMode,
      executionSource: record.operationalMode === 'LIVE_API' ? 'Live Muse Spark 1.3' : 'Deterministic Virtual Lab',
      diagnosisSource: record.diagnosisSource,
      telemetry: record.telemetry,
    };
  }

  /* -- evaluation ---------------------------------------------------------------- */

  private async evaluationScore(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.evaluation.score';
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const record = await this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    if (record.evaluated && record.scorecard) return record.scorecard;
    // Same-colo edge fast path: a cold isolate restores the exact cached
    // LIVE_API investigation + scorecard when the caller passes only a
    // scenarioId — no second live API call, no re-probing.
    if (record.hydratedFromToken) {
      const cached = await edgeCacheGet<unknown>(edgeScenarioKey(scenarioId));
      if (isEdgeCachedScenario(cached)) {
        if (isInvestigationRecord(cached.investigation) && cached.investigation.ownerActorId === context.actorId && cached.investigation.scenarioId === scenarioId) {
          this.investigations.set(cached.investigation.investigationId, cached.investigation);
        }
        if (cached.evaluated === true && cached.scorecard !== undefined) {
          record.evaluated = true;
          if (typeof cached.evaluatedAt === 'string') record.evaluatedAt = cached.evaluatedAt;
          record.scorecard = cached.scorecard as Record<string, unknown>;
          return record.scorecard;
        }
      }
    }
    // Cold-isolate path: a scenario hydrated from a foreign `scn_...` token
    // arrives with zero local probes, so run the deterministic diagnosis here
    // (and persist it as the latest investigation) before scoring. Scenarios
    // created in THIS isolate without probes still throw
    // `MAAS_INVESTIGATION_INCOMPLETE` below.
    if (record.hydratedFromToken && record.session.getProbeLog().length === 0) {
      await this.diagnoseAndStoreInvestigation(
        await this.nextSignedInvestigationId(record.scenarioId, context.actorId),
        record,
        context.actorId,
      );
    }
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
      edgeCachePut(edgeScenarioKey(scenarioId), { evaluated: true, evaluatedAt: record.evaluatedAt, scorecard: record.scorecard });
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
    edgeCachePut(edgeScenarioKey(scenarioId), {
      investigation: latestInvestigation,
      evaluated: true,
      evaluatedAt: record.evaluatedAt,
      scorecard: record.scorecard,
    });
    return record.scorecard;
  }

  private async evaluationReport(args: Record<string, unknown>, context: MaasAuthContext): Promise<unknown> {
    const capability = 'traceforge.evaluation.report';
    const correlationId = createMaasCorrelationId();
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const record = await this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    // Cold-isolate path: score on this isolate first when the hydrated
    // scenario has never been evaluated here. Local scenarios still throw
    // `MAAS_INVESTIGATION_INCOMPLETE` when unevaluated.
    if (record.hydratedFromToken && !record.evaluated) {
      await this.evaluationScore({ scenarioId }, context, correlationId);
    }
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

