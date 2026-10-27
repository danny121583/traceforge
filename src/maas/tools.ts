/**
 * TraceForge MaaS — 25-tool service layer (18 circuit-diagnostic + 7 assistant/KB).
 *
 * `TraceForgeMaasService` registers and executes every TraceForge MaaS tool (25 total)
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
import { KB_VERSION, KNOWLEDGE_BASE_ENTRIES, SUGGESTED_QUESTIONS } from '../data/knowledge-base';
import {
  queryTraceForgeRAG,
  sanitizeAssistantSessionContext,
  type AssistantSessionContext,
} from '../lib/rag-engine';
import {
  STANDARD_20_QA_BENCHMARK,
  handleAssistantChat,
  issueAssistantSessionTicket,
  type AssistantChatResponse,
  type StandardQaBenchmarkItem,
} from '../lib/assistant-server';
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

/** All 25 registered TraceForge MaaS tool descriptors (18 circuit-diagnostic + 7 assistant/KB). */
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
  descriptor('traceforge.kb.search', 'Search the versioned TraceForge knowledge base (BM25 + synonym expansion) at $0.00 with zero model calls. Returns ranked sources, coverage level, answer excerpt, and kbVersion.', objSchema({ query: S('Search query or question.'), limit: { type: 'number', description: 'Maximum matching entries to return (1..10, default 3).', minimum: 1, maximum: 10 } }, ['query']), null, true),
  descriptor('traceforge.chat.status', 'Retrieve TraceForge Assistant status, kbVersion, knowledge topic count, shared $2.00 live-chat allowance ledger, rate/concurrency limits, and caller conversation count. Never invokes paid inference.', objSchema(), null, true),
  descriptor('traceforge.chat.start', 'Start an actor-isolated TraceForge Assistant conversation, optionally bound to an owned scenarioId for session-grounded answers. Returns a conversationId plus a signed session ticket.', objSchema({ scenarioId: OPT_S('Optional owned scenarioId to bind this conversation to for session-grounded answers.'), title: OPT_S('Optional conversation label.') }, []), 'traceforge:discovery:read', false),
  descriptor(
    'traceforge.chat.ask',
    'Ask the TraceForge Assistant a question (or run a deterministic multi-question QA batch) using RAG-first retrieval over the versioned knowledge base ($0.00 by default). Live muse-spark-1.3 inference runs only when allowLiveInference=true with traceforge:live_inference:execute scope and budget headroom.',
    objSchema({
      message: OPT_S('Question to ask the assistant (required unless questions or runStandard20QuestionQa is provided).'),
      questions: { type: 'array', description: 'Optional batch of questions (1..25) for deterministic QA evaluation at $0.00.', items: { type: 'string' } },
      runStandard20QuestionQa: { type: 'boolean', description: 'When true, runs the built-in 20-question TraceForge QA benchmark at $0.00.' },
      conversationId: OPT_S('Optional owned conversationId from traceforge.chat.start to append turns and include history.'),
      scenarioId: OPT_S('Optional owned scenarioId to ground answers in sanitized session state (HiddenFault withheld).'),
      allowLiveInference: { type: 'boolean', description: 'Default false ($0.00 knowledge-only). Even when true, requires traceforge:live_inference:execute scope, a configured key, and budget headroom.' },
    }, []),
    'traceforge:discovery:read',
    false,
  ),
  descriptor('traceforge.chat.history', 'Retrieve ordered conversation history, cited knowledge sources, and token/cost summary for an owned conversationId.', objSchema({ conversationId: S('Owning conversation id returned by traceforge.chat.start or traceforge.chat.ask.') }, ['conversationId']), 'traceforge:discovery:read', true),
  descriptor('traceforge.chat.clear', 'Clear all messages in an owned conversationId while keeping the conversation container active.', objSchema({ conversationId: S('Owning conversation id to clear.') }, ['conversationId']), 'traceforge:discovery:read', false),
  descriptor(
    'traceforge.chat.feedback',
    'Submit quality and grounding feedback (helpful | unhelpful) on a TraceForge Assistant answer.',
    objSchema({
      conversationId: OPT_S('Optional conversation id associated with the answer.'),
      messageIndex: { type: 'number', description: 'Optional 0-based message index within the conversation.' },
      rating: { type: 'string', description: 'Feedback rating: helpful or unhelpful.', enum: ['helpful', 'unhelpful'] },
      comment: OPT_S('Optional diagnostic or documentation feedback note (max 500 chars).'),
    }, ['rating']),
    'traceforge:discovery:read',
    false,
  ),
];

/** Capabilities callable without a Bearer token (read-only discovery). */
export const PUBLIC_MAAS_CAPABILITIES: ReadonlySet<string> = new Set([
  'traceforge.capabilities.list',
  'traceforge.system.status',
  'traceforge.models.status',
  'traceforge.budget.status',
  'traceforge.circuits.list',
  'traceforge.circuits.get',
  'traceforge.kb.search',
  'traceforge.chat.status',
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
  /**
   * Monotonically increasing state version for cross-isolate merge ordering.
   * Bumped on every committed probe, investigation, and evaluation, then
   * persisted to Edge Cache alongside the probe log.
   */
  version: number;
  /** Canonical completed investigation for this scenario, if any. */
  latestInvestigation?: InvestigationRecord;
}

/**
 * Canonical serializable scenario state synchronized across Worker isolates
 * through `caches.default` (Edge Cache, same colocation) under
 * `edgeScenarioKey(scenarioId)`. Every read (`requireOwnedScenario`) merges
 * the newer side into the isolate-local `ScenarioRecord`; every mutation
 * (probe, investigation, evaluation) bumps `version` and awaits persistence
 * before the HTTP response leaves the Worker. `evaluated` + `scorecard` are
 * immutable once set: they are never overwritten or re-scored.
 */
export interface PersistedScenarioState {
  scenarioId: string;
  boardId: string;
  ownerActorId: string;
  faultSelector: string;
  createdAt: string;
  expiresAtMs: number;
  /** Monotonically increasing state version for concurrent/sequential merge. */
  version: number;
  /** Ordered committed probe records (multiset-merged across isolates). */
  probeLog: ProbeRecord[];
  toolCallsUsed: number;
  /** Canonical completed investigation for this scenario, if any. */
  investigation?: InvestigationRecord;
  /** Immutable evaluation state once evaluation.score has completed. */
  evaluated: boolean;
  evaluatedAt?: string;
  scorecard?: Record<string, unknown>;
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

/* ---------------------------------------------------------------------------
 * Authenticated scenario / investigation ids (cross-isolate hydration)
 *
 * Cloudflare may route successive ChatGPT MCP calls to DIFFERENT Worker
 * isolates with disjoint in-memory Maps. To survive that, `scenarioId`
 * (`scn_...`) and `investigationId` (`inv_...`) are SELF-CONTAINED: the
 * payload (board/fault indexes, owner, expiry, sequence) is encrypted with
 * AES-256-GCM (fresh random 96-bit IV per token via
 * `crypto.getRandomValues`, Additional Data bound to the token prefix,
 * explicit 128-bit GCM tag) and hex-encoded — so it carries ZERO readable
 * board/fault strings and always passes `assertGroundTruthIsolated` — and
 * authenticated with BOTH the 128-bit GCM tag and the full 256-bit
 * HMAC-SHA-256 Encrypt-then-MAC tag (`_${tag64}`), verified in constant
 * time BEFORE decryption, so ANY isolate holding the same session secret
 * can verify and rehydrate the record without shared state. AES and HMAC
 * keys are derived via standard Web Crypto HKDF-SHA-256 with distinct
 * domain info labels. Tenant isolation, session expiry, and ground-truth
 * isolation are enforced on every hydrate exactly as on the originating
 * isolate. There is no XOR masking, no FNV-1a, and no deterministic IV
 * anywhere in this module.
 * ------------------------------------------------------------------------- */

const SCN_TOKEN_PREFIX = 'scn_';
const INV_TOKEN_PREFIX = 'inv_';

/** HMAC tag domain separating scenario/investigation signatures. */
const TOKEN_TAG_DOMAIN = 'traceforge-maas-id-v3';
/** HKDF info label for the 256-bit AES-GCM key (distinct from HMAC). */
const TOKEN_AEAD_INFO = 'traceforge-aead-hkdf-v3';
/** HKDF info label for the 256-bit HMAC-SHA-256 key (distinct from AEAD). */
const TOKEN_HMAC_INFO = 'traceforge-hmac-hkdf-v3';
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

/** Import one session secret as an HKDF-SHA-256 base key. */
async function hkdfBaseKeyForSecret(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
}

/** Derive the 256-bit AES-GCM CryptoKey for one session secret via HKDF-SHA-256. */
async function aeadKeyForSecret(secret: string): Promise<CryptoKey> {
  const base = await hkdfBaseKeyForSecret(secret);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(TOKEN_AEAD_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Derive the 256-bit HMAC-SHA-256 CryptoKey for one session secret via HKDF-SHA-256. */
async function hmacKeyForSecret(secret: string): Promise<CryptoKey> {
  const base = await hkdfBaseKeyForSecret(secret);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(TOKEN_HMAC_INFO) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/** HMAC-SHA-256 over text under a domain-separated session-secret key (full 64 hex chars). */
async function hmacSignHex(secret: string, text: string): Promise<string> {
  const key = await hmacKeyForSecret(secret);
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
 * Authenticated-encrypt a token payload: AES-256-GCM (fresh random 96-bit
 * IV per call, prefix bound as Additional Data, explicit 128-bit GCM tag)
 * plus the full 64-hex-char HMAC-SHA-256 Encrypt-then-MAC tag, so the
 * format is `${prefix}${hex}_${tag64}` matching
 * `/^(scn|inv)_[0-9a-f]+_[0-9a-f]{64}$/`. Identical payloads encrypt to
 * distinct ciphertexts (IND-CPA semantic security, zero nonce reuse).
 */
export async function encryptSignedToken(prefix: string, payload: Record<string, unknown>, secret: string): Promise<string> {
  const aesKey = await aeadKeyForSecret(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: new TextEncoder().encode(prefix), tagLength: 128 },
      aesKey,
      plaintext as unknown as BufferSource,
    ),
  );
  const combined = new Uint8Array(iv.length + sealed.length);
  combined.set(iv, 0);
  combined.set(sealed, iv.length);
  const hex = bytesToHex(combined);
  const tag64 = await hmacSignHex(secret, `${prefix}|${hex}|${TOKEN_TAG_DOMAIN}`);
  return `${prefix}${hex}_${tag64}`;
}

/**
 * Verify and decrypt a token: validates prefix, `_${tag64}` suffix, and hex
 * shape, checks the full 256-bit HMAC-SHA-256 tag in constant time BEFORE
 * decryption, then AES-256-GCM decrypts (explicit 128-bit GCM tag
 * verification included). Returns `null` on any failure — wrong key, bit
 * flip, truncation, prefix swap, or malformed JSON.
 */
export async function decryptSignedToken(prefix: string, token: string, secret: string): Promise<Record<string, unknown> | null> {
  if (typeof token !== 'string' || !token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  const sep = rest.lastIndexOf('_');
  if (sep <= 0) return null;
  const hex = rest.slice(0, sep);
  const tag = rest.slice(sep + 1);
  if (hex.length < 56 || hex.length > 8192 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/.test(hex) || !/^[0-9a-f]{64}$/.test(tag)) return null;
  const expected = await hmacSignHex(secret, `${prefix}|${hex}|${TOKEN_TAG_DOMAIN}`);
  if (!constantTimeHexEqual(expected, tag)) return null;
  const combined = hexToBytes(hex);
  if (!combined || combined.length < 12 + 16) return null;
  const iv = combined.slice(0, 12);
  const sealed = combined.slice(12);
  try {
    const aesKey = await aeadKeyForSecret(secret);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: new TextEncoder().encode(prefix), tagLength: 128 },
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
 * TraceForge Assistant live-chat budget allocation & abuse protections
 *
 * RAG-first routing answers from the versioned static knowledge base at
 * $0.00. Paid `muse-spark-1.3` inference for assistant chat is gated behind
 * ALL of: an explicit per-request opt-in, a valid session ticket or scoped
 * Bearer token, a configured server key, and an atomic reservation against
 * the shared ledger below. Usage is tracked in the shared runtime ledger
 * (persisted via `persistEdgeRuntimeSnapshot` so every isolate enforces
 * the same allowance) and surfaced in `traceforge.budget.status`.
 * ------------------------------------------------------------------------- */

/** Maximum cumulative paid assistant-chat spend (USD) across the runtime ledger. */
export const ASSISTANT_LIVE_ALLOWANCE_USD = 2.0;
/** Maximum paid assistant-chat calls per chat session id. */
export const MAX_ASSISTANT_LIVE_CALLS_PER_SESSION = 10;
/** Maximum concurrent in-flight paid assistant-chat calls per isolate. */
export const MAX_CONCURRENT_ASSISTANT_LIVE_CALLS = 2;
/** Maximum assistant user-message length (characters). */
export const ASSISTANT_MAX_INPUT_CHARS = 1000;
/** Maximum conversation history messages accepted per chat request. */
export const ASSISTANT_MAX_HISTORY_MESSAGES = 8;
/** Maximum paid assistant-chat completion tokens per model call. */
export const ASSISTANT_MAX_OUTPUT_TOKENS = 350;

/** Outcome of an assistant live-call reservation attempt (fail-closed). */
export interface AssistantLiveReservation {
  ok: boolean;
  reason?: string;
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

/**
 * Optional global durable storage adapter (Cloudflare Free-tier SQLite
 * Durable Object `TraceForgeStateDO`, which installs itself here). On
 * `*.workers.dev`, `caches.default` is a no-op (`match()` always resolves
 * to `undefined`) and MCP requests arrive from many egress IPs across edge
 * PoPs/isolates — so the durable hook is checked FIRST for strong global
 * session consistency across all isolates, PoPs, and Worker restarts.
 */
export interface DurableStorageHook {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export function getDurableStorageHook(): DurableStorageHook | null {
  const hook = (globalThis as { __traceforgeDurableStorage?: DurableStorageHook }).__traceforgeDurableStorage;
  return hook && typeof hook.get === 'function' && typeof hook.put === 'function' ? hook : null;
}

async function edgeCacheGet<T>(key: string): Promise<T | null> {
  const hook = getDurableStorageHook();
  if (hook) {
    try {
      const val = await hook.get(key);
      if (val !== undefined && val !== null) return val as T;
    } catch {
      // Fall through to caches.default on durable-read failure.
    }
  }
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

/**
 * Best-effort Edge Cache write, AWAITED before the tool response leaves the
 * isolate so a successive request routed to another isolate in the same
 * colocation observes the committed state. Never throws: edge persistence
 * must never fail a tool call.
 */
async function edgeCachePut(key: string, value: unknown): Promise<void> {
  const hook = getDurableStorageHook();
  if (hook) {
    try {
      await hook.put(key, value);
    } catch {
      // Best-effort only: durable persistence must never fail a tool call.
    }
  }
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    const ResponseCtor = (globalThis as { Response?: new (body: string, init: { headers: Record<string, string> }) => unknown }).Response;
    if (!ResponseCtor) return;
    await cache.put(
      key,
      new ResponseCtor(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' },
      }),
    );
  } catch {
    // Best-effort only: edge persistence must never fail a tool call.
  }
}

function edgeScenarioKey(scenarioId: string): string {
  return `${EDGE_CACHE_SCENARIO_PREFIX}${scenarioId}`;
}

/** Per-actor scenario index for cross-isolate `traceforge.scenarios.list`. */
function edgeActorKey(actorId: string): string {
  return `https://traceforge-internal.local/actor-scenarios/${encodeURIComponent(actorId)}`;
}

export interface ActorScenarioEntry {
  scenarioId: string;
  boardId: string;
  evaluated: boolean;
  faultSelector: string;
  createdAt: string;
}

/** Deterministic content signature for one committed probe record. */
function probeSignature(p: ProbeRecord): string {
  return JSON.stringify([p.kind, p.target, p.abnormal, p.detail ?? null]);
}

/**
 * Multiset union of two probe logs: start from the longer log and append
 * copies present in the shorter log beyond the longer log's multiplicity.
 * Sequential isolates always hold prefix logs, so the longer side wins
 * verbatim (order preserved); concurrent isolates converge on the same
 * count. Duplicate identical probes are preserved by multiplicity, never
 * collapsed.
 */
function mergeProbeLogs(a: ProbeRecord[], b: ProbeRecord[]): ProbeRecord[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  const base = a.length >= b.length ? [...a] : [...b];
  const other = a.length >= b.length ? b : a;
  const countInto = (log: ProbeRecord[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const p of log) {
      const sig = probeSignature(p);
      m.set(sig, (m.get(sig) ?? 0) + 1);
    }
    return m;
  };
  const baseCounts = countInto(base);
  const otherCounts = countInto(other);
  for (const [sig, n] of otherCounts) {
    const have = baseCounts.get(sig) ?? 0;
    if (n > have) {
      base.push(...other.filter((p) => probeSignature(p) === sig).slice(0, n - have));
    }
  }
  return base;
}

function isProbeRecordArray(value: unknown): value is ProbeRecord[] {
  return Array.isArray(value) && value.every((p) => p !== null && typeof p === 'object' && typeof (p as { kind: unknown }).kind === 'string' && typeof (p as { target: unknown }).target === 'string');
}

function isPersistedScenarioState(value: unknown): value is PersistedScenarioState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return typeof r['scenarioId'] === 'string'
    && typeof r['boardId'] === 'string'
    && typeof r['ownerActorId'] === 'string'
    && typeof r['version'] === 'number'
    && typeof r['toolCallsUsed'] === 'number'
    && typeof r['evaluated'] === 'boolean'
    && isProbeRecordArray(r['probeLog']);
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
  assistantIncurredCostUsd?: unknown;
  assistantLiveRequests?: unknown;
  assistantInputTokens?: unknown;
  assistantOutputTokens?: unknown;
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
 * TraceForge Assistant conversations & feedback (MCP chat tools)
 *
 * `traceforge.chat.*` and `traceforge.kb.search` share the exact same
 * retrieval, conversation-state, session-grounding, and budget-control
 * engine as the website floating assistant (`POST /api/assistant/chat` via
 * `handleAssistantChat`): every answer runs RAG-first over the versioned
 * knowledge base at $0.00, and paid `muse-spark-1.3` inference happens only
 * through the same gated live path. Conversations are actor-isolated
 * (`ownerActorId`, `MAAS_CROSS_TENANT_ACCESS_DENIED` on cross-actor access),
 * mirrored to edge storage for cross-isolate reads, and never carry
 * withheld `HiddenFault` ground truth (verified with
 * `assertGroundTruthIsolated` before use).
 * ------------------------------------------------------------------------- */

/** One stored assistant message with its RAG grounding snapshot. */
export interface AssistantConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: Array<{ entryId: string; title: string; excerpt: string }>;
  mode?: string;
  liveInvoked?: boolean;
  kbVersion?: string;
  timestamp: string;
}

/** Actor-isolated multi-turn assistant conversation. */
export interface AssistantConversationRecord {
  conversationId: string;
  ownerActorId: string;
  scenarioId: string | null;
  title: string;
  messages: AssistantConversationMessage[];
  createdAt: string;
  updatedAt: string;
  sessionTicket: string;
  sessionId: string;
  ticketExpiresAtMs: number;
}

/** One quality/grounding feedback entry on an assistant answer. */
export interface AssistantFeedbackRecord {
  feedbackId: string;
  actorId: string;
  conversationId: string | null;
  messageIndex?: number;
  rating: 'helpful' | 'unhelpful';
  comment?: string;
  kbVersion: string;
  createdAt: string;
}

/**
 * Synthetic evaluated-session context grounding the deterministic QA
 * benchmark: an F405 board with two recorded abnormal probes, a confirmed
 * U1 solder-bridge diagnosis, and a 99/100 evaluated score. Contains zero
 * withheld fault answers — only the same sanitized fields a real evaluated
 * session exposes to the assistant.
 */
const QA_BENCHMARK_SESSION_CONTEXT: Record<string, unknown> = {
  boardId: 'f405-flight-controller',
  boardName: 'FPV Drone Flight Controller (F405)',
  symptom: 'Board enumerates no USB device; NRST test pad near 0 V instead of the 3.3 V pull-up.',
  lifecycleState: 'evaluated',
  probeMeasurements: [
    { target: 'TP_NRST', kind: 'voltage', detail: '0.020 V (nominal 3.240 V)', abnormal: true },
    { target: 'U1-14↔U1-15', kind: 'resistance', detail: '0.4 Ohm SHORT', abnormal: true },
  ],
  proposedDiagnosis: {
    componentRef: 'U1',
    faultType: 'solder_bridge',
    verificationStatus: 'confirmed',
    explanation: 'NRST crushed plus pin-to-pin short.',
  },
  verificationStatus: 'confirmed',
  score: {
    totalScore: 99,
    componentMatch: true,
    faultTypeMatch: true,
    evidenceConfirmed: true,
    probeCount: 5,
    efficiencyScore: 92,
    summary: 'Component and fault-type match with confirmed evidence.',
  },
  evaluated: true,
};

const EDGE_CACHE_CONVERSATION_PREFIX = 'https://traceforge-internal.local/conv/';
const EDGE_CACHE_ASSISTANT_FEEDBACK_KEY = 'https://traceforge-internal.local/assistant-feedback';

function edgeConversationKey(conversationId: string): string {
  return `${EDGE_CACHE_CONVERSATION_PREFIX}${conversationId}`;
}

/** Per-actor conversation index for cross-isolate `traceforge.chat.status`. */
function edgeActorConversationsKey(actorId: string): string {
  return `https://traceforge-internal.local/actor-conversations/${encodeURIComponent(actorId)}`;
}

function randomAssistantId(prefix: string): string {
  const raw = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}${bytesToHex(raw)}`;
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
 * Registers and executes all 25 TraceForge MaaS tools with authentication,
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
  /** Assistant live-chat ledger (this isolate): paid muse-spark-1.3 chat calls only. */
  private assistantLiveRequests = 0;
  private assistantInputTokens = 0;
  private assistantOutputTokens = 0;
  private assistantIncurredCostUsd = 0;
  /** In-flight paid assistant-chat calls (concurrency cap, this isolate only). */
  private assistantActiveCalls = 0;
  /** Paid assistant-chat calls consumed per chat session id (this isolate). */
  private readonly assistantSessionCalls = new Map<string, number>();
  /** Actor-isolated assistant conversations (`conv_...` ids, this isolate). */
  private readonly conversations = new Map<string, AssistantConversationRecord>();
  /** Assistant answer feedback entries (this isolate; mirrored to edge storage). */
  private readonly assistantFeedback: AssistantFeedbackRecord[] = [];
  /** Server-side live key for MCP assistant chat (never exposed in payloads). */
  private liveApiKey?: string;
  /** Remote-colo assistant spend merged from the edge-cached runtime snapshot. */
  private edgeCachedAssistantSpendUsd = 0;
  private edgeCachedAssistantRequests = 0;

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
    this.liveApiKey = apiKey.trim();
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
    const remoteAssistant = asNonNegativeNumber(snapshot['assistantIncurredCostUsd']) - this.assistantIncurredCostUsd;
    if (remoteAssistant > this.edgeCachedAssistantSpendUsd) this.edgeCachedAssistantSpendUsd = remoteAssistant;
    const remoteAssistantRequests = Math.floor(asNonNegativeNumber(snapshot['assistantLiveRequests'])) - this.assistantLiveRequests;
    if (remoteAssistantRequests > this.edgeCachedAssistantRequests) this.edgeCachedAssistantRequests = remoteAssistantRequests;
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
      const previousAssistant = previous && typeof previous === 'object' ? asNonNegativeNumber(previous['assistantIncurredCostUsd']) : 0;
      const cumulativeAssistant = Math.max(previousAssistant, this.assistantIncurredCostUsd + this.edgeCachedAssistantSpendUsd);
      const previousAssistantRequests = previous && typeof previous === 'object' ? Math.floor(asNonNegativeNumber(previous['assistantLiveRequests'])) : 0;
      const cumulativeAssistantRequests = Math.max(previousAssistantRequests, this.assistantLiveRequests + this.edgeCachedAssistantRequests);
      await edgeCachePut(EDGE_CACHE_RUNTIME_TELEMETRY_KEY, {
        incurredCostUsd: cumulative,
        inputTokens: this.externalInputTokens + (this.liveClient?.getTelemetry().inputTokens ?? 0),
        outputTokens: this.externalOutputTokens + (this.liveClient?.getTelemetry().outputTokens ?? 0),
        totalRequests: this.externalTotalRequests + (this.liveClient?.getTelemetry().totalRequests ?? 0),
        liveVerified: true,
        assistantIncurredCostUsd: cumulativeAssistant,
        assistantLiveRequests: cumulativeAssistantRequests,
        assistantInputTokens: this.assistantInputTokens,
        assistantOutputTokens: this.assistantOutputTokens,
      });
      this.edgeCachedLiveSpendUsd = Math.max(0, cumulative - this.externalLiveSpendUsd);
      this.edgeCachedAssistantSpendUsd = Math.max(0, cumulativeAssistant - this.assistantIncurredCostUsd);
      this.edgeCachedAssistantRequests = Math.max(0, cumulativeAssistantRequests - this.assistantLiveRequests);
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
    return this.combinedTelemetry().incurredCostUsd + this.injectedLiveSpendUsd + this.edgeCachedLiveSpendUsd + this.effectiveAssistantSpendUsd();
  }

  /** Cumulative paid assistant-chat spend (this isolate + merged remote colo). */
  effectiveAssistantSpendUsd(): number {
    return this.assistantIncurredCostUsd + this.edgeCachedAssistantSpendUsd;
  }

  /** Cumulative paid assistant-chat call count (this isolate + merged remote colo). */
  effectiveAssistantRequests(): number {
    return this.assistantLiveRequests + this.edgeCachedAssistantRequests;
  }

  /** Shared-ledger snapshot of assistant live-chat usage (served in `traceforge.budget.status`). */
  getAssistantLiveUsage(): {
    liveRequests: number;
    inputTokens: number;
    outputTokens: number;
    incurredCostUsd: number;
    activeCalls: number;
    allowanceUsd: number;
    remainingAllowanceUsd: number;
  } {
    const incurred = this.effectiveAssistantSpendUsd();
    return {
      liveRequests: this.effectiveAssistantRequests(),
      inputTokens: this.assistantInputTokens,
      outputTokens: this.assistantOutputTokens,
      incurredCostUsd: incurred,
      activeCalls: this.assistantActiveCalls,
      allowanceUsd: ASSISTANT_LIVE_ALLOWANCE_USD,
      remainingAllowanceUsd: Math.max(0, ASSISTANT_LIVE_ALLOWANCE_USD - incurred),
    };
  }

  /**
   * Atomically reserve one paid assistant live-chat call. Enforces, in
   * order: global kill switch, the project $95.00 safety threshold, the
   * $2.00 assistant live allowance, the per-isolate concurrency cap
   * (<= 2), the per-client rate limit, and the per-session request cap
   * (<= 10). Fails closed whenever budget/accounting is exhausted or
   * uncertain. Pair every success with exactly one `commit` (paid call
   * completed) or `release` (not completed).
   */
  tryReserveAssistantLiveCall(sessionId: string, clientKey = 'anonymous'): AssistantLiveReservation {
    if (!Number.isFinite(this.assistantIncurredCostUsd) || !Number.isFinite(this.edgeCachedAssistantSpendUsd)) {
      return { ok: false, reason: 'accounting_uncertain' };
    }
    if (this.killSwitch.isGlobalKillActive()) return { ok: false, reason: 'kill_switch' };
    if (this.isBudgetSafetyBreached()) return { ok: false, reason: 'project_budget_exhausted' };
    if (this.effectiveAssistantSpendUsd() >= ASSISTANT_LIVE_ALLOWANCE_USD) return { ok: false, reason: 'chat_allowance_exhausted' };
    if (this.assistantActiveCalls >= MAX_CONCURRENT_ASSISTANT_LIVE_CALLS) return { ok: false, reason: 'concurrency_limit' };
    try {
      this.rateLimiter.check(`assistant-live:${clientKey}`);
    } catch {
      return { ok: false, reason: 'rate_limited' };
    }
    const used = typeof sessionId === 'string' && sessionId.length > 0 ? (this.assistantSessionCalls.get(sessionId) ?? 0) : 0;
    if (!Number.isFinite(used) || used >= MAX_ASSISTANT_LIVE_CALLS_PER_SESSION) return { ok: false, reason: 'session_limit' };
    this.assistantActiveCalls += 1;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.assistantSessionCalls.set(sessionId, used + 1);
    }
    return { ok: true };
  }

  /**
   * Commit one reserved paid assistant live-chat call to the shared ledger
   * (exactly one commit per successful reservation that reached upstream).
   */
  commitAssistantLiveCall(usage: { inputTokens: number; outputTokens: number }): void {
    this.assistantActiveCalls = Math.max(0, this.assistantActiveCalls - 1);
    const input = asNonNegativeNumber(usage.inputTokens);
    const output = asNonNegativeNumber(usage.outputTokens);
    this.assistantLiveRequests += 1;
    this.assistantInputTokens += input;
    this.assistantOutputTokens += output;
    this.assistantIncurredCostUsd += estimateLiveCostUsd(input, output);
    void this.persistEdgeRuntimeSnapshot();
  }

  /** Release a reservation without charging (upstream skipped or failed). */
  releaseAssistantLiveCall(): void {
    this.assistantActiveCalls = Math.max(0, this.assistantActiveCalls - 1);
  }

  /**
   * Server-authorized technical diagnostic snapshot: system, model, and
   * budget status together. Served only behind `traceforge:audit:read`
   * authorization (`GET /api/maas/telemetry`, `traceforge.budget.status`
   * tool paths); never exposed through a frontend toggle.
   */
  async getTelemetrySnapshot(): Promise<{ systemStatus: unknown; modelsStatus: unknown; budgetStatus: unknown }> {
    return {
      systemStatus: this.systemStatus(),
      modelsStatus: await this.modelsStatus(),
      budgetStatus: await this.budgetStatus(),
    };
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
      case 'traceforge.kb.search': return this.kbSearch(args, correlationId);
      case 'traceforge.chat.status': return this.chatStatus(context);
      case 'traceforge.chat.start': return this.chatStart(args, context, correlationId);
      case 'traceforge.chat.ask': return this.chatAsk(args, context, correlationId);
      case 'traceforge.chat.history': return this.chatHistory(args, context, correlationId);
      case 'traceforge.chat.clear': return this.chatClear(args, context, correlationId);
      case 'traceforge.chat.feedback': return this.chatFeedback(args, context, correlationId);
      default:
        throw new MaasToolError('MAAS_CAPABILITY_NOT_FOUND', `Unknown MaaS capability '${capability}'.`, correlationId, capability);
    }
  }

  /* -- scenario / investigation helpers ------------------------------------ */

  /**
   * Merge a canonical `PersistedScenarioState` from Edge Cache into the
   * isolate-local record. Probe logs merge by multiset union (the longer
   * prefix wins verbatim; the session bench is restored when the merged log
   * grows), investigations attach by version ordering, and
   * `evaluated`/`scorecard` are immutable once set anywhere. Records owned
   * by another actor are never merged.
   */
  private mergePersistedScenarioState(record: ScenarioRecord, edge: PersistedScenarioState): void {
    if (edge.scenarioId !== record.scenarioId || edge.ownerActorId !== record.ownerActorId) return;
    // Never extend a locally expired session (preserves the test seam and
    // token expiry semantics); only adopt an earlier edge expiry.
    record.expiresAtMs = Math.min(record.expiresAtMs, edge.expiresAtMs);
    const localLog = record.session.getProbeLog();
    const merged = mergeProbeLogs(localLog, edge.probeLog);
    const mergedUsed = Math.max(record.session.getToolCallsUsed(), edge.toolCallsUsed, merged.length);
    if (merged.length > localLog.length || mergedUsed > record.session.getToolCallsUsed()) {
      record.session.restoreProbeLog(merged, mergedUsed);
    }
    if (edge.version > record.version) record.version = edge.version;
    const localInv = record.latestInvestigation
      ?? [...this.investigations.values()].filter((r) => r.scenarioId === record.scenarioId).pop();
    if (edge.investigation
      && edge.investigation.scenarioId === record.scenarioId
      && edge.investigation.ownerActorId === record.ownerActorId
      && (!localInv || edge.version >= record.version)) {
      this.investigations.set(edge.investigation.investigationId, edge.investigation);
      record.latestInvestigation = edge.investigation;
    } else if (localInv) {
      record.latestInvestigation = localInv;
    }
    // Immutability of evaluation: once evaluated anywhere, the scorecard
    // can never be overwritten or re-scored.
    if (edge.evaluated === true) {
      record.evaluated = true;
      if (typeof edge.evaluatedAt === 'string') record.evaluatedAt = edge.evaluatedAt;
      if (edge.scorecard !== undefined) record.scorecard = edge.scorecard;
    }
    if (record.latestInvestigation) {
      this.investigations.set(record.latestInvestigation.investigationId, record.latestInvestigation);
    }
  }

  /** Fetch the canonical scenario state from Edge Cache and merge it in. */
  private async syncScenarioFromEdge(record: ScenarioRecord): Promise<void> {
    const edge = await edgeCacheGet<unknown>(edgeScenarioKey(record.scenarioId));
    if (isPersistedScenarioState(edge)) {
      this.mergePersistedScenarioState(record, edge);
      return;
    }
    // Backwards compatibility: pre-version entries stored only
    // `{ investigation }` under the scenario key.
    if (isEdgeCachedScenario(edge) && isInvestigationRecord(edge.investigation)
      && edge.investigation.scenarioId === record.scenarioId
      && edge.investigation.ownerActorId === record.ownerActorId
      && !record.latestInvestigation) {
      this.investigations.set(edge.investigation.investigationId, edge.investigation);
      record.latestInvestigation = edge.investigation;
    }
  }

  /** Canonical persisted snapshot of one isolate-local record. */
  private persistedStateFor(record: ScenarioRecord): PersistedScenarioState {
    const latest = record.latestInvestigation
      ?? [...this.investigations.values()].filter((r) => r.scenarioId === record.scenarioId).pop();
    if (latest) record.latestInvestigation = latest;
    return {
      scenarioId: record.scenarioId,
      boardId: record.boardId,
      ownerActorId: record.ownerActorId,
      faultSelector: record.faultSelector,
      createdAt: record.createdAt,
      expiresAtMs: record.expiresAtMs,
      version: record.version,
      probeLog: record.session.getProbeLog(),
      toolCallsUsed: record.session.getToolCallsUsed(),
      ...(latest ? { investigation: latest } : {}),
      evaluated: record.evaluated,
      ...(record.evaluatedAt ? { evaluatedAt: record.evaluatedAt } : {}),
      ...(record.scorecard ? { scorecard: record.scorecard } : {}),
    };
  }

  /** Awaited persist of the canonical scenario state to Edge Cache. */
  private async persistScenarioState(record: ScenarioRecord): Promise<void> {
    await edgeCachePut(edgeScenarioKey(record.scenarioId), this.persistedStateFor(record));
  }

  /**
   * Canonical investigation id for one scenario: reuses the stored
   * `latestInvestigation.investigationId` when it already exists (warm
   * isolate or Edge Cache / Durable Object merge), otherwise mints a fresh
   * random-IV `inv_...` token via `encodeInvestigationToken`. The caller
   * persists it via `storeInvestigationRun` (TraceForgeStateDO / Edge
   * Cache), so all subsequent `status`, `history`, `result`, `score`, and
   * `report` calls across isolates return the exact same `investigationId`.
   */
  private async mintCanonicalInvestigationId(
    scenarioRecord: ScenarioRecord,
    ownerActorId: string,
    extras: InvestigationTokenExtras = {},
  ): Promise<string> {
    const existing = scenarioRecord.latestInvestigation?.investigationId;
    if (existing) return existing;
    const mapped = [...this.investigations.values()].filter((r) => r.scenarioId === scenarioRecord.scenarioId).pop();
    if (mapped) {
      scenarioRecord.latestInvestigation = mapped;
      return mapped.investigationId;
    }
    return encodeInvestigationToken({ s: scenarioRecord.scenarioId, o: ownerActorId, q: 1, ...extras }, this.sessionSecret);
  }

  private async requireOwnedScenario(scenarioId: string, context: MaasAuthContext, correlationId: string, capability: string): Promise<ScenarioRecord> {
    const record = this.scenarios.get(scenarioId);
    if (record) {
      // Cross-isolate freshness: another isolate may have committed probes,
      // an investigation, or an evaluation since this isolate cached the
      // record — ALWAYS merge the canonical Edge Cache state, even on a
      // local in-memory hit, before enforcing ownership and expiry.
      await this.syncScenarioFromEdge(record);
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
      version: 0,
    };
    this.scenarios.set(scenarioId, hydrated);
    // A cold isolate starts from an empty probe log: adopt every committed
    // probe, the canonical investigation, and any immutable evaluation from
    // the Edge Cache before enforcing ownership and expiry.
    await this.syncScenarioFromEdge(hydrated);
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
   * Build, store, and persist an `InvestigationRecord` from one
   * deterministic agentic-diagnosis run against this isolate's session
   * bench. The record becomes the scenario's canonical `latestInvestigation`,
   * the scenario version bumps, and BOTH the investigation key and the
   * canonical scenario state are awaited to Edge Cache before returning — so
   * `status`, `history`, `result`, `score`, and `report` agree on one stable
   * `investigationId` across isolates.
   */
  private async storeInvestigationRun(
    investigationId: string,
    scenarioRecord: ScenarioRecord,
    ownerActorId: string,
    run: AgenticDiagnosisRun,
  ): Promise<InvestigationRecord> {
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
    scenarioRecord.latestInvestigation = stored;
    scenarioRecord.version = (scenarioRecord.version ?? 0) + 1;
    await edgeCachePut(edgeInvestigationKey(investigationId), stored);
    await this.persistScenarioState(scenarioRecord);
    return stored;
  }

  private async diagnoseAndStoreInvestigation(
    investigationId: string,
    scenarioRecord: ScenarioRecord,
    ownerActorId: string,
  ): Promise<InvestigationRecord> {
    const run: AgenticDiagnosisRun = await runAgenticDiagnosis(scenarioRecord.session, this.simClient);
    return this.storeInvestigationRun(investigationId, scenarioRecord, ownerActorId, run);
  }

  /**
   * Cold-isolate canonical diagnosis: reuses the stored canonical
   * investigation id when Edge Cache / Durable Object state already holds
   * one for this scenario, otherwise mints a fresh random-IV `inv_...`
   * token from the run extras and persists it via `storeInvestigationRun`
   * so all isolates sharing durable/edge storage converge on the same id.
   */
  private async diagnoseAndStoreCanonicalInvestigation(
    scenarioRecord: ScenarioRecord,
    ownerActorId: string,
  ): Promise<InvestigationRecord> {
    const run: AgenticDiagnosisRun = await runAgenticDiagnosis(scenarioRecord.session, this.simClient);
    const investigationId = await this.mintCanonicalInvestigationId(scenarioRecord, ownerActorId, {
      m: run.operationalMode,
      t: run.turns,
      d: run.proposedDiagnosis,
      src: run.diagnosisSource,
      u: run.telemetry,
    });
    return this.storeInvestigationRun(investigationId, scenarioRecord, ownerActorId, run);
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
        // Hydrate + sync the owning scenario from durable/edge state so
        // `this.scenarios.get(record.scenarioId)` is warm even on a cold
        // isolate queried by `investigationId` alone.
        await this.requireOwnedScenario(existing.scenarioId, context, correlationId, capability);
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
        // Same hydration as the in-memory hit: the owning scenario must be
        // warm and synced from durable/edge state on this isolate too.
        await this.requireOwnedScenario(cached.scenarioId, context, correlationId, capability);
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
    // `requireOwnedScenario` already merged the canonical Edge Cache state,
    // so the canonical investigation for this scenario — created on any
    // isolate — is returned with its exact `investigationId` here.
    const record = owned.latestInvestigation
      ?? [...this.investigations.values()].filter((r) => r.scenarioId === owned.scenarioId).pop();
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
    // run the canonical diagnosis here and persist it — cold isolates sharing
    // durable/edge storage converge on the same `investigationId`. Scenarios
    // created in THIS isolate keep throwing `MAAS_RESOURCE_NOT_FOUND` so
    // existing behavior is intact.
    if (!owned.hydratedFromToken) {
      throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `No investigation found for '${scenarioId}'.`, correlationId, capability);
    }
    return this.diagnoseAndStoreCanonicalInvestigation(owned, context.actorId);
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
      verifiedNote: 'Verified $113.63 balance ($33.63 consumed across Muse Code CLI + live API; $66.37 remaining of $100.00 authorized budget) as of 2026-10-27T00:40:47-05:00.',
      verifiedRemainingBudgetUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD - LAST_VERIFIED_CONSUMED_USD,
      ledger: {
        incurredCostUsd: incurred,
        projectedLiveCostUsd: telemetry.projectedLiveCostUsd,
        inputTokens: telemetry.inputTokens,
        outputTokens: telemetry.outputTokens,
        totalRequests: telemetry.totalRequests,
        providerReportedUsage: telemetry.providerReportedUsage,
      },
      ledgerScopeNote: 'ledger tracks runtime Meta API calls observed by this Worker isolate/colo since deployment, while lastVerifiedConsumedUsd ($33.63) is the provider-confirmed cumulative consumption across Muse Code CLI and runtime API.',
      remainingBudgetUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD - incurred,
      safetyThresholdBreached: this.isBudgetSafetyBreached(),
      assistant: {
        ...this.getAssistantLiveUsage(),
        maxCallsPerSession: MAX_ASSISTANT_LIVE_CALLS_PER_SESSION,
        maxConcurrentCalls: MAX_CONCURRENT_ASSISTANT_LIVE_CALLS,
        maxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
      },
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

  private async scenariosList(args: Record<string, unknown>, context: MaasAuthContext): Promise<unknown> {
    const boardId = asString(args['boardId']);
    const boards = boardId ? listReferenceBoards().filter((b) => b.boardId === boardId) : listReferenceBoards();
    return {
      selectors: boards.map((b) => ({
        boardId: b.boardId,
        available: ['random', 'nominal', ...b.faults.map((_, index) => `scenario-${index}`)],
        scenarioCount: b.faults.length,
      })),
      // Cross-isolate consistency: merge the per-actor Edge Cache index so a
      // cold isolate lists the actor's sessions from every isolate in the
      // colocation, while actors stay strictly isolated from one another.
      mySessions: await this.listActorScenarios(context.actorId),
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
      version: 0,
    };
    this.scenarios.set(scenarioId, record);
    // Commit the initial canonical state + actor index before returning, so
    // a successive request on another isolate observes this scenario.
    await this.persistScenarioState(record);
    await this.updateActorScenarioIndex(record);
    return record;
  }

  /** Upsert one scenario entry in the per-actor Edge Cache index. */
  private async updateActorScenarioIndex(record: ScenarioRecord): Promise<void> {
    try {
      const key = edgeActorKey(record.ownerActorId);
      const existing = await edgeCacheGet<unknown>(key);
      const entries: ActorScenarioEntry[] = Array.isArray(existing) ? (existing as ActorScenarioEntry[]) : [];
      const entry: ActorScenarioEntry = {
        scenarioId: record.scenarioId,
        boardId: record.boardId,
        evaluated: record.evaluated,
        faultSelector: record.faultSelector,
        createdAt: record.createdAt,
      };
      const at = entries.findIndex((e) => e && e.scenarioId === record.scenarioId);
      if (at >= 0) entries[at] = entry;
      else entries.push(entry);
      await edgeCachePut(key, entries);
    } catch {
      // Best-effort only.
    }
  }

  /** Merge the per-actor Edge Cache index with isolate-local sessions. */
  private async listActorScenarios(ownerActorId: string): Promise<ActorScenarioEntry[]> {
    const local = [...this.scenarios.values()]
      .filter((r) => r.ownerActorId === ownerActorId)
      .map((r): ActorScenarioEntry => ({ scenarioId: r.scenarioId, boardId: r.boardId, evaluated: r.evaluated, faultSelector: r.faultSelector, createdAt: r.createdAt }));
    try {
      const edge = await edgeCacheGet<unknown>(edgeActorKey(ownerActorId));
      if (!Array.isArray(edge)) return local;
      const merged = new Map<string, ActorScenarioEntry>();
      for (const e of local) merged.set(e.scenarioId, e);
      for (const e of edge) {
        if (e === null || typeof e !== 'object' || Array.isArray(e)) continue;
        const rec = e as Partial<ActorScenarioEntry>;
        if (typeof rec.scenarioId !== 'string' || typeof rec.boardId !== 'string') continue;
        const prev = merged.get(rec.scenarioId);
        merged.set(rec.scenarioId, {
          scenarioId: rec.scenarioId,
          boardId: rec.boardId,
          evaluated: rec.evaluated === true || prev?.evaluated === true,
          faultSelector: typeof rec.faultSelector === 'string' ? rec.faultSelector : (prev?.faultSelector ?? 'indexed'),
          createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : (prev?.createdAt ?? new Date(0).toISOString()),
        });
      }
      return [...merged.values()];
    } catch {
      return local;
    }
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
      // Commit before responding: bump the version and await Edge Cache
      // persistence so the next call — on ANY isolate — observes this probe.
      record.version = (record.version ?? 0) + 1;
      await this.persistScenarioState(record);
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
      record.version = (record.version ?? 0) + 1;
      await this.persistScenarioState(record);
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
      record.version = (record.version ?? 0) + 1;
      await this.persistScenarioState(record);
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
    const executionSource = run.operationalMode === 'LIVE_API' ? 'Live Muse Spark 1.3' : 'Deterministic Virtual Lab';
    // Canonical per-scenario identity: reuse the stored `latestInvestigation`
    // id when one already exists, otherwise mint a fresh random-IV `inv_...`
    // token and persist it via `storeInvestigationRun` — the completed record
    // is awaited to Edge Cache / TraceForgeStateDO so cold isolates hydrate
    // the EXACT record (LIVE_API included) with no new API call.
    const investigationId = await this.mintCanonicalInvestigationId(record, context.actorId, {
      m: run.operationalMode,
      t: run.turns,
      d: run.proposedDiagnosis,
      src: run.diagnosisSource,
      u: run.telemetry,
    });
    await this.storeInvestigationRun(investigationId, record, context.actorId, run);
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
    // Immutable evaluation: `requireOwnedScenario` already merged the
    // canonical Edge Cache state, so an evaluation completed on ANY isolate
    // is returned verbatim here — never re-scored with a different probe
    // count.
    if (record.evaluated && record.scorecard) return record.scorecard;
    // Cold-isolate path: a scenario hydrated from a foreign `scn_...` token
    // arrives with zero local probes (and no canonical investigation yet),
    // so run the canonical diagnosis here and persist it — cold isolates
    // sharing durable/edge storage converge on the same probes and the same
    // `investigationId` — before scoring. Scenarios created in THIS isolate
    // without probes still throw `MAAS_INVESTIGATION_INCOMPLETE` below.
    if (record.hydratedFromToken && record.session.getProbeLog().length === 0) {
      await this.diagnoseAndStoreCanonicalInvestigation(record, context.actorId);
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
      // Lock + publish the immutable scorecard before responding.
      record.version = (record.version ?? 0) + 1;
      await this.persistScenarioState(record);
      await this.updateActorScenarioIndex(record);
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
    // Lock + publish the immutable scorecard before responding: `evaluation
    // .report` on ANY isolate returns this exact scorecard verbatim.
    record.version = (record.version ?? 0) + 1;
    await this.persistScenarioState(record);
    await this.updateActorScenarioIndex(record);
    return record.scorecard;
  }

  private async evaluationReport(args: Record<string, unknown>, context: MaasAuthContext): Promise<unknown> {
    const capability = 'traceforge.evaluation.report';
    const correlationId = createMaasCorrelationId();
    const scenarioId = requireString(args, 'scenarioId', correlationId, capability);
    const record = await this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    // Cold-isolate path: score on this isolate first when the scenario was
    // never evaluated anywhere. When another isolate already evaluated it,
    // `requireOwnedScenario` merged the immutable scorecard above, so the
    // report below returns it verbatim — never re-running `scoreDiagnosis`
    // with a different probe count. Local unevaluated scenarios still throw
    // `MAAS_INVESTIGATION_INCOMPLETE`.
    if (record.hydratedFromToken && !record.evaluated) {
      await this.evaluationScore({ scenarioId }, context, correlationId);
    }
    if (!record.evaluated || !record.scorecard) {
      throw new MaasToolError('MAAS_INVESTIGATION_INCOMPLETE', `Scenario '${scenarioId}' has not been evaluated yet; run traceforge.evaluation.score first.`, correlationId, capability);
    }
    const scorecard = record.scorecard as { score: { evidenceConfirmed: boolean; totalScore: number } | null; groundTruth: Record<string, unknown> };
    const latestInvestigation = record.latestInvestigation
      ?? [...this.investigations.values()].filter((r) => r.scenarioId === scenarioId).pop();
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

  /* -- assistant conversations & knowledge base -------------------------------- */

  /** Persist one conversation to memory + edge storage and refresh the actor index. */
  private async persistConversation(record: AssistantConversationRecord): Promise<void> {
    this.conversations.set(record.conversationId, record);
    await edgeCachePut(edgeConversationKey(record.conversationId), record);
    try {
      const key = edgeActorConversationsKey(record.ownerActorId);
      const existing = await edgeCacheGet<unknown>(key);
      const ids: string[] = Array.isArray(existing)
        ? (existing as unknown[]).filter((e): e is string => typeof e === 'string')
        : [];
      if (!ids.includes(record.conversationId)) ids.push(record.conversationId);
      await edgeCachePut(key, ids);
    } catch {
      // Best-effort only: index persistence must never fail a tool call.
    }
  }

  /** Mint, store, and persist an actor-owned conversation with a signed session ticket. */
  private async startConversation(ownerActorId: string, scenarioId: string | null, title?: string): Promise<AssistantConversationRecord> {
    const issued = await issueAssistantSessionTicket(this.sessionSecret);
    const now = new Date().toISOString();
    const record: AssistantConversationRecord = {
      conversationId: randomAssistantId('conv_'),
      ownerActorId,
      scenarioId,
      title: title && title.length > 0 ? title : 'TraceForge Assistant Conversation',
      messages: [],
      createdAt: now,
      updatedAt: now,
      sessionTicket: issued.sessionTicket,
      sessionId: issued.sessionId,
      ticketExpiresAtMs: issued.expiresAtMs,
    };
    await this.persistConversation(record);
    return record;
  }

  /** Load an owned conversation from memory or edge storage (tenant-checked). */
  private async requireOwnedConversation(
    conversationId: string,
    context: MaasAuthContext,
    correlationId: string,
    capability: string,
  ): Promise<AssistantConversationRecord> {
    const local = this.conversations.get(conversationId);
    if (local) {
      if (local.ownerActorId !== context.actorId) {
        throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Conversation '${conversationId}' belongs to another actor.`, correlationId, capability);
      }
      return local;
    }
    const edge = await edgeCacheGet<unknown>(edgeConversationKey(conversationId));
    if (edge !== null && typeof edge === 'object' && !Array.isArray(edge)) {
      const record = edge as AssistantConversationRecord;
      if (typeof record.conversationId === 'string' && Array.isArray(record.messages)) {
        if (record.ownerActorId !== context.actorId) {
          throw new MaasToolError('MAAS_CROSS_TENANT_ACCESS_DENIED', `Conversation '${conversationId}' belongs to another actor.`, correlationId, capability);
        }
        this.conversations.set(record.conversationId, record);
        return record;
      }
    }
    throw new MaasToolError('MAAS_RESOURCE_NOT_FOUND', `Unknown conversation '${conversationId}'.`, correlationId, capability);
  }

  /** Conversation ids owned by one actor (memory + edge index merged). */
  private async listActorConversationIds(ownerActorId: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const record of this.conversations.values()) {
      if (record.ownerActorId === ownerActorId) ids.add(record.conversationId);
    }
    try {
      const edge = await edgeCacheGet<unknown>(edgeActorConversationsKey(ownerActorId));
      if (Array.isArray(edge)) {
        for (const entry of edge) {
          if (typeof entry === 'string') ids.add(entry);
        }
      }
    } catch {
      // Best-effort only.
    }
    return [...ids];
  }

  /** Total recorded feedback items (memory + edge mirror merged without double counting). */
  private async assistantFeedbackCount(): Promise<number> {
    try {
      const edge = await edgeCacheGet<unknown>(EDGE_CACHE_ASSISTANT_FEEDBACK_KEY);
      if (Array.isArray(edge)) return Math.max(this.assistantFeedback.length, edge.length);
    } catch {
      // Best-effort only.
    }
    return this.assistantFeedback.length;
  }

  /** Mirror one feedback entry into edge storage (best-effort read-modify-write). */
  private async persistAssistantFeedback(entry: AssistantFeedbackRecord): Promise<void> {
    this.assistantFeedback.push(entry);
    try {
      const edge = await edgeCacheGet<unknown>(EDGE_CACHE_ASSISTANT_FEEDBACK_KEY);
      const list: AssistantFeedbackRecord[] = Array.isArray(edge) ? (edge as AssistantFeedbackRecord[]) : [];
      if (!list.some((e) => e !== null && typeof e === 'object' && (e as AssistantFeedbackRecord).feedbackId === entry.feedbackId)) {
        list.push(entry);
      }
      await edgeCachePut(EDGE_CACHE_ASSISTANT_FEEDBACK_KEY, list);
    } catch {
      // Best-effort only.
    }
  }

  private kbSearch(args: Record<string, unknown>, correlationId: string): unknown {
    const capability = 'traceforge.kb.search';
    const query = requireString(args, 'query', correlationId, capability);
    const rawLimit = args['limit'];
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(10, Math.max(1, Math.floor(rawLimit)))
      : 3;
    const rag = queryTraceForgeRAG(query);
    return {
      query,
      kbVersion: KB_VERSION,
      coverage: rag.coverage,
      answer: rag.answer,
      sources: rag.sources.slice(0, limit),
      topicIds: rag.topicIds.slice(0, limit),
      liveInvoked: false,
      incurredCostUsd: 0,
    };
  }

  private async chatStatus(context: MaasAuthContext): Promise<unknown> {
    await this.refreshEdgeRuntimeSnapshot();
    return {
      kbVersion: KB_VERSION,
      topicCount: KNOWLEDGE_BASE_ENTRIES.length,
      suggestedQuestions: SUGGESTED_QUESTIONS,
      liveUpstreamConfigured: this.hasLiveClient(),
      defaultMode: 'knowledge_base',
      liveUsage: this.getAssistantLiveUsage(),
      limits: {
        allowanceUsd: ASSISTANT_LIVE_ALLOWANCE_USD,
        projectSafetyThresholdUsd: BUDGET_SAFETY_THRESHOLD_USD,
        maxLiveCallsPerSession: MAX_ASSISTANT_LIVE_CALLS_PER_SESSION,
        maxConcurrentLiveCalls: MAX_CONCURRENT_ASSISTANT_LIVE_CALLS,
        maxInputChars: ASSISTANT_MAX_INPUT_CHARS,
        maxHistoryMessages: ASSISTANT_MAX_HISTORY_MESSAGES,
        maxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
      },
      activeConversationCount: (await this.listActorConversationIds(context.actorId)).length,
      feedbackCount: await this.assistantFeedbackCount(),
    };
  }

  private async chatStart(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.chat.start';
    const scenarioId = asString(args['scenarioId']) ?? null;
    const title = asString(args['title']);
    if (scenarioId) {
      await this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    }
    const record = await this.startConversation(context.actorId, scenarioId, title);
    return {
      conversationId: record.conversationId,
      ownerActorId: context.actorId,
      scenarioId: record.scenarioId,
      title: record.title,
      sessionTicket: record.sessionTicket,
      sessionId: record.sessionId,
      expiresAtMs: record.ticketExpiresAtMs,
      kbVersion: KB_VERSION,
      suggestedQuestions: SUGGESTED_QUESTIONS,
      messageCount: 0,
    };
  }

  /**
   * Build the sanitized session context for one owned scenario: board,
   * symptom, recorded probes, proposed diagnosis, and evaluated score.
   * Withheld `HiddenFault` fields are stripped and the result is verified
   * ground-truth-free before it ever reaches the assistant.
   */
  private async buildAssistantSessionContext(
    scenarioId: string,
    context: MaasAuthContext,
    correlationId: string,
    capability: string,
  ): Promise<AssistantSessionContext> {
    const record = await this.requireOwnedScenario(scenarioId, context, correlationId, capability);
    const reference = getReferenceBoard(record.boardId);
    const latest = record.latestInvestigation
      ?? [...this.investigations.values()].filter((r) => r.scenarioId === record.scenarioId).pop();
    const raw: Record<string, unknown> = {
      boardId: record.boardId,
      ...(reference ? { boardName: reference.boardName, symptom: reference.symptom } : {}),
      lifecycleState: record.evaluated ? 'evaluated' : 'active',
      probeMeasurements: record.session.getProbeLog().map((p) => ({
        target: p.target,
        kind: p.kind,
        detail: p.detail ?? '',
        abnormal: p.abnormal,
      })),
    };
    if (latest) {
      raw['proposedDiagnosis'] = { ...latest.proposedDiagnosis };
      raw['verificationStatus'] = latest.proposedDiagnosis.verificationStatus;
    }
    if (record.evaluated && record.scorecard !== undefined) {
      const scorecard = record.scorecard as { score?: unknown };
      if (scorecard !== null && typeof scorecard === 'object' && scorecard.score !== null && typeof scorecard.score === 'object') {
        raw['score'] = { ...(scorecard.score as Record<string, unknown>) };
        raw['evaluated'] = true;
      }
    }
    const clean = sanitizeAssistantSessionContext(raw);
    assertGroundTruthIsolated(clean, record.session.getGroundTruth());
    return clean;
  }

  private async chatAsk(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.chat.ask';
    if (args['runStandard20QuestionQa'] === true) {
      return this.runAssistantQa(STANDARD_20_QA_BENCHMARK);
    }
    const questionsRaw = args['questions'];
    if (questionsRaw !== undefined) {
      if (!Array.isArray(questionsRaw)
        || questionsRaw.length < 1
        || questionsRaw.length > 25
        || !questionsRaw.every((q): q is string => typeof q === 'string' && q.length > 0)) {
        throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', 'questions must be an array of 1..25 non-empty strings.', correlationId, capability);
      }
      return this.runAssistantQa(questionsRaw.map((question, index): StandardQaBenchmarkItem => ({
        id: index + 1,
        question,
        mustContainTerms: [],
      })));
    }
    const message = asString(args['message']);
    if (!message || message.trim().length === 0) {
      throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', 'One of message, questions, or runStandard20QuestionQa is required.', correlationId, capability);
    }
    const conversationIdArg = asString(args['conversationId']);
    const scenarioIdArg = asString(args['scenarioId']) ?? undefined;
    if (scenarioIdArg) {
      await this.requireOwnedScenario(scenarioIdArg, context, correlationId, capability);
    }
    let record: AssistantConversationRecord;
    if (conversationIdArg) {
      record = await this.requireOwnedConversation(conversationIdArg, context, correlationId, capability);
      if (scenarioIdArg) {
        record.scenarioId = scenarioIdArg;
      }
    } else {
      record = await this.startConversation(context.actorId, scenarioIdArg ?? null, undefined);
    }
    const sessionContext = record.scenarioId
      ? await this.buildAssistantSessionContext(record.scenarioId, context, correlationId, capability)
      : {};
    const history = record.messages
      .slice(-ASSISTANT_MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, ASSISTANT_MAX_INPUT_CHARS) }));
    // Live inference stays explicitly gated: the caller's token must carry
    // `traceforge:live_inference:execute`, exactly like `mode: "live"`
    // investigations. Anything else answers from knowledge at $0.00.
    const allowLive = args['allowLiveInference'] === true
      && context.scopes.includes('traceforge:live_inference:execute');
    const handled = await handleAssistantChat({
      service: this,
      body: {
        message,
        history,
        allowLiveInference: allowLive,
        sessionContext: sessionContext as Record<string, unknown>,
        sessionTicket: record.sessionTicket,
      },
      headers: {},
      signingSecret: this.sessionSecret,
      apiKey: this.liveApiKey,
    });
    if (handled.status !== 200) {
      const problem = handled.payload as { error?: string };
      throw new MaasToolError('MAAS_INVALID_REQUEST', typeof problem.error === 'string' ? problem.error : 'Assistant request failed.', correlationId, capability);
    }
    const result = handled.payload as AssistantChatResponse;
    const timestamp = new Date().toISOString();
    record.messages.push({ role: 'user', content: message, timestamp });
    record.messages.push({
      role: 'assistant',
      content: result.reply,
      sources: result.sources,
      mode: result.mode,
      liveInvoked: result.liveInvoked,
      kbVersion: result.kbVersion,
      timestamp,
    });
    record.updatedAt = timestamp;
    await this.persistConversation(record);
    return {
      conversationId: record.conversationId,
      question: message,
      reply: result.reply,
      sources: result.sources,
      mode: result.mode,
      liveInvoked: result.liveInvoked,
      kbVersion: result.kbVersion,
      ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
      incurredCostUsd: result.liveInvoked && result.usage
        ? estimateLiveCostUsd(result.usage.inputTokens, result.usage.outputTokens)
        : 0,
      messageCount: record.messages.length,
    };
  }

  /**
   * Deterministic QA evaluation over 1..25 questions at $0.00. Every
   * question runs knowledge-only (`handleAssistantChat` with live
   * inference disabled, no server key) against the synthetic evaluated
   * session, then verifies grounding, expected-topic retrieval, key
   * accuracy terms, and zero withheld-fault leakage.
   */
  private async runAssistantQa(items: StandardQaBenchmarkItem[]): Promise<unknown> {
    const sessionContext = sanitizeAssistantSessionContext({ ...QA_BENCHMARK_SESSION_CONTEXT });
    const results: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const rag = queryTraceForgeRAG(item.question, sessionContext);
      const handled = await handleAssistantChat({
        service: this,
        body: { message: item.question, sessionContext: sessionContext as Record<string, unknown> },
        headers: {},
        signingSecret: this.sessionSecret,
        apiKey: undefined,
      });
      const payload = handled.payload as {
        reply?: unknown;
        sources?: unknown;
        mode?: unknown;
        liveInvoked?: unknown;
      };
      const reply = typeof payload.reply === 'string' ? payload.reply : '';
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      const topicIds = rag.topicIds;
      const groundingVerified = sources.length > 0 || rag.blockedByPolicy;
      const policyVerified = item.expectedPolicyRefusal === true ? rag.blockedByPolicy : true;
      const topicVerified = item.expectedTopicIds !== undefined
        ? item.expectedTopicIds.some((t) => topicIds.includes(t))
        : true;
      const lowered = reply.toLowerCase();
      const termsVerified = item.mustContainTerms.every((t) => lowered.includes(t.toLowerCase()));
      const leakScan = JSON.stringify({ reply, sources });
      const leakFree = !/"(hiddenFault|faultId|targetComponentRef|groundTruth|injectedFault)"/.test(leakScan)
        && !/hiddenFault|targetComponentRef|injectedFault/.test(leakScan);
      const passed = groundingVerified && policyVerified && topicVerified && termsVerified && leakFree;
      results.push({
        index: item.id,
        question: item.question,
        answer: reply,
        sources,
        topicIds,
        mode: typeof payload.mode === 'string' ? payload.mode : 'knowledge_base',
        liveInvoked: false,
        tokens: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        groundingVerified,
        accuracyVerified: topicVerified && termsVerified,
        passed,
      });
    }
    const passedCount = results.filter((r) => r['passed'] === true).length;
    return {
      qaMode: true,
      kbVersion: KB_VERSION,
      totalQuestions: results.length,
      passedCount,
      failedCount: results.length - passedCount,
      allPassed: passedCount === results.length,
      liveCallsInvoked: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      results,
    };
  }

  private async chatHistory(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.chat.history';
    const conversationId = requireString(args, 'conversationId', correlationId, capability);
    const record = await this.requireOwnedConversation(conversationId, context, correlationId, capability);
    const inputTokens = 0;
    const outputTokens = 0;
    return {
      conversationId: record.conversationId,
      ownerActorId: record.ownerActorId,
      scenarioId: record.scenarioId,
      kbVersion: KB_VERSION,
      messageCount: record.messages.length,
      messages: record.messages,
      tokenSummary: { inputTokens, outputTokens, incurredCostUsd: 0 },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async chatClear(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.chat.clear';
    const conversationId = requireString(args, 'conversationId', correlationId, capability);
    const record = await this.requireOwnedConversation(conversationId, context, correlationId, capability);
    record.messages = [];
    record.updatedAt = new Date().toISOString();
    await this.persistConversation(record);
    return { conversationId: record.conversationId, cleared: true, messageCount: 0, kbVersion: KB_VERSION };
  }

  private async chatFeedback(args: Record<string, unknown>, context: MaasAuthContext, correlationId: string): Promise<unknown> {
    const capability = 'traceforge.chat.feedback';
    const rating = asString(args['rating']);
    if (rating !== 'helpful' && rating !== 'unhelpful') {
      throw new MaasToolError('MAAS_SCHEMA_VALIDATION_FAILED', `Invalid rating '${String(rating)}': expected 'helpful' or 'unhelpful'.`, correlationId, capability);
    }
    const conversationId = asString(args['conversationId']) ?? null;
    if (conversationId) {
      await this.requireOwnedConversation(conversationId, context, correlationId, capability);
    }
    const rawIndex = args['messageIndex'];
    const messageIndex = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
      ? rawIndex
      : undefined;
    const rawComment = asString(args['comment']) ?? '';
    const entry: AssistantFeedbackRecord = {
      feedbackId: randomAssistantId('fb_'),
      actorId: context.actorId,
      conversationId,
      ...(messageIndex !== undefined ? { messageIndex } : {}),
      rating,
      ...(rawComment.length > 0 ? { comment: rawComment.slice(0, 500) } : {}),
      kbVersion: KB_VERSION,
      createdAt: new Date().toISOString(),
    };
    await this.persistAssistantFeedback(entry);
    return {
      feedbackId: entry.feedbackId,
      recorded: true,
      rating: entry.rating,
      conversationId: entry.conversationId,
      kbVersion: KB_VERSION,
    };
  }
}

/** All known local token strings (for audit scrubbing and tests). */
export const MAAS_KNOWN_TOKEN_STRINGS: string[] = MAAS_LOCAL_TOKENS.map((t) => t.token);

