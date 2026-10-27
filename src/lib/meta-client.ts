/**
 * Meta Model API client layer for TraceForge Phase 1.
 *
 * Covers `muse-spark-1.3` (reasoning / structured outputs / tool calling)
 * and `sam-3.1` (visual segmentation), plus a deterministic simulation
 * fixture mode so tests and offline demos run without API keys.
 */

export const SPARK_MODEL_ID = 'muse-spark-1.3' as const;
export const SAM_MODEL_ID = 'sam-3.1' as const;
export const SPARK_CONTEXT_TOKENS = 1_048_576;

export type ModelId = typeof SPARK_MODEL_ID | typeof SAM_MODEL_ID;
export type ClientMode = 'live' | 'simulated';
/** How segmentation masks are sourced. `simulated` is the legacy chat-mode alias of `static_fixture`. */
export type SegmentationMode = 'static_fixture' | 'simulated' | 'live_api';

/**
 * AI transparency classification (Phase 1.5). Every AI capability reports
 * one of these — never present simulated/fixture output as live inference.
 * - `LIVE_API`: verified execution through the real remote model.
 * - `SIMULATED`: deterministic mock or simulated output.
 * - `STATIC_FIXTURE`: predefined reference geometry or static fixture data.
 * - `UNVERIFIED`: live implementation exists but no real response confirmed yet.
 * - `UNAVAILABLE`: required proxy/key/capability is not configured.
 */
export type OperationalMode = 'LIVE_API' | 'SIMULATED' | 'STATIC_FIXTURE' | 'UNVERIFIED' | 'UNAVAILABLE';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';

/* ---------------------------------------------------------------------------
 * Token / cost telemetry & promotional-credit budget ledger (Milestone B)
 * ------------------------------------------------------------------------- */

/** Promotional-credit baseline recorded 2026-10-26 (see AGENTS.md §8). */
export const STARTING_PROMOTIONAL_BALANCE_USD = 147.26;
/** Maximum authorized incremental consumption across coding agent + runtime. */
export const AUTHORIZED_ADDITIONAL_BUDGET_USD = 100.0;
/** Mandatory ending balance: starting balance minus authorized budget. */
export const TARGET_RESERVE_USD = 47.26;
/** Stop discretionary model usage at this incremental spend (keeps a $5 buffer). */
export const BUDGET_SAFETY_THRESHOLD_USD = 95.0;
/** Planned split: $60 implementation + $20 debugging/corrections. */
export const CODING_AGENT_BUDGET_USD = 80.0;
/** Planned split: $10 live runtime testing + $10 demo/contingency. */
export const RUNTIME_TESTING_BUDGET_USD = 20.0;

/** Conservative per-token live planning rates (USD per 1M tokens). */
export const INPUT_COST_USD_PER_MTOKEN = 2.0;
export const OUTPUT_COST_USD_PER_MTOKEN = 6.0;

/* ---------------------------------------------------------------------------
 * Verified billing checkpoint (2026-10-26T18:49:40-05:00 provider snapshot)
 * ------------------------------------------------------------------------- */

/** Verified promotional-credit balance at the last provider checkpoint. */
export const LAST_VERIFIED_BALANCE_USD = 132.38;
/** Verified incremental consumption (Muse Code CLI + live API) at the checkpoint. */
export const LAST_VERIFIED_CONSUMED_USD = 14.88;
/** ISO timestamp of the last verified provider billing checkpoint. */
export const LAST_VERIFIED_TIMESTAMP = '2026-10-26T18:49:40-05:00';

/** Default / maximum `max_tokens` per chat request (runaway-request guard). */
export const DEFAULT_MAX_TOKENS = 1024;
export const MAX_TOKENS_CAP = 1024;
/** Bounded retry: at most one retry, transient 5xx only. */
export const MAX_CHAT_RETRIES = 1;
export const TRANSIENT_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
/** Per-attempt network timeout. Timeouts are not HTTP statuses: never retried. */
export const CLIENT_REQUEST_TIMEOUT_MS = 30_000;

/** Conservative live-rate cost for a token-count pair. */
export function estimateLiveCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * INPUT_COST_USD_PER_MTOKEN +
    (outputTokens / 1_000_000) * OUTPUT_COST_USD_PER_MTOKEN
  );
}

/** Clamp a requested `maxTokens` onto the runaway-request guard rail. */
export function clampMaxTokens(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_TOKENS;
  return Math.min(Math.max(1, Math.floor(requested)), MAX_TOKENS_CAP);
}

/**
 * Cumulative usage & cost ledger for one `MetaClient` lifetime.
 *
 * - `incurredCostUsd`: real spend — live-rate cost in `live` mode, always
 *   `$0.00` in `simulated` mode (zero-cost development default).
 * - `projectedLiveCostUsd`: what the session's tokens WOULD cost at live
 *   rates, tracked in every mode so users see the exact projected live cost
 *   of a simulated session before spending anything.
 * - `estimatedCostUsd` / `runtimeConsumptionUsd` mirror `incurredCostUsd`
 *   (conservative incurred-cost estimate / runtime API consumption).
 * - `providerReportedUsage` is sticky: true once any call's tokens came from
 *   the live API `usage` payload instead of local `estimateTokens`.
 */
export interface UsageTelemetry {
  totalRequests: number;
  failedRequests: number;
  retriedRequests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  providerReportedUsage: boolean;
  runtimeConsumptionUsd: number;
  codingAgentBudgetUsd: number;
  incurredCostUsd: number;
  projectedLiveCostUsd: number;
}

/** Zeroed ledger (keeps the informational coding-agent allocation). */
export function emptyTelemetry(): UsageTelemetry {
  return {
    totalRequests: 0,
    failedRequests: 0,
    retriedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    providerReportedUsage: false,
    runtimeConsumptionUsd: 0,
    codingAgentBudgetUsd: CODING_AGENT_BUDGET_USD,
    incurredCostUsd: 0,
    projectedLiveCostUsd: 0,
  };
}

/** Budget-monitor snapshot derived from a `UsageTelemetry` ledger. */
export interface CostLedgerSnapshot {
  startingBalanceUsd: number;
  authorizedBudgetUsd: number;
  targetReserveUsd: number;
  safetyThresholdUsd: number;
  codingAgentBudgetUsd: number;
  runtimeConsumptionUsd: number;
  remainingBudgetUsd: number;
  projectedReserveUsd: number;
  safetyThresholdBreached: boolean;
  reserveBreached: boolean;
  /** Verified promotional-credit balance at the last provider checkpoint. */
  lastVerifiedBalanceUsd: number;
  /** Verified incremental consumption (Muse Code CLI + live API) at the checkpoint. */
  lastVerifiedConsumedUsd: number;
  /** ISO timestamp of the last verified provider billing checkpoint. */
  lastVerifiedTimestamp: string;
}

/** Derive the promotional-credit budget snapshot for the UI banner. */
export function buildCostLedger(telemetry: UsageTelemetry): CostLedgerSnapshot {
  const runtimeConsumptionUsd = telemetry.runtimeConsumptionUsd;
  const projectedReserveUsd = STARTING_PROMOTIONAL_BALANCE_USD - runtimeConsumptionUsd;
  return {
    startingBalanceUsd: STARTING_PROMOTIONAL_BALANCE_USD,
    authorizedBudgetUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD,
    targetReserveUsd: TARGET_RESERVE_USD,
    safetyThresholdUsd: BUDGET_SAFETY_THRESHOLD_USD,
    codingAgentBudgetUsd: telemetry.codingAgentBudgetUsd,
    runtimeConsumptionUsd,
    remainingBudgetUsd: AUTHORIZED_ADDITIONAL_BUDGET_USD - runtimeConsumptionUsd,
    projectedReserveUsd,
    safetyThresholdBreached: runtimeConsumptionUsd >= BUDGET_SAFETY_THRESHOLD_USD,
    reserveBreached: projectedReserveUsd < TARGET_RESERVE_USD,
    lastVerifiedBalanceUsd: LAST_VERIFIED_BALANCE_USD,
    lastVerifiedConsumedUsd: LAST_VERIFIED_CONSUMED_USD,
    lastVerifiedTimestamp: LAST_VERIFIED_TIMESTAMP,
  };
}

/** Provider `usage` payload shape (`/chat/completions` and the local proxy). */
export interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** True when `err` is a transient HTTP 502/503/504 worth exactly one retry. */
export function isRetryableChatError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // The proxy's key-missing 503 is a configuration state, never transient.
  if (msg.includes('not configured on the local server proxy')) return false;
  return /HTTP (502|503|504)\b/.test(msg);
}

/** Race a promise against a bounded timeout (timeouts are never retried). */
function withRequestTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} request timed out after ${ms} ms.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** JSON-schema subset used for tool parameter definitions. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name:
    | 'lookup_pinout'
    | 'verify_rail_voltage'
    | 'measure_node_voltage'
    | 'check_continuity'
    | 'measure_branch_current'
    | 'generate_rework_guidance';
  description: string;
  parameters: JsonSchema;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on tool-result messages. */
  tool_call_id?: string;
  /** Present on assistant messages that invoke tools. */
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: ToolDefinition['name'];
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  model?: ModelId;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  responseFormat?: 'text' | 'json';
  effort?: ReasoningEffort;
  stream?: boolean;
  maxTokens?: number;
}

export interface ChatResponse {
  model: ModelId;
  mode: ClientMode;
  content: string;
  toolCalls: ToolCall[];
  /** True when `content` was produced from a pre-recorded fixture. */
  simulated: boolean;
}

export interface DatasheetSection {
  title: string;
  text: string;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'lookup_pinout',
    description:
      'Look up the pinout entry for a component part number and pin number from the loaded datasheet context.',
    parameters: {
      type: 'object',
      properties: {
        part_number: { type: 'string', description: 'Manufacturer part number, e.g. STM32F405RGT6.' },
        pin_number: { type: 'string', description: 'Pin designator, e.g. "14" or "PA9".' },
      },
      required: ['part_number', 'pin_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_rail_voltage',
    description:
      'Compare a measured rail voltage against the nominal rail spec with tolerance.',
    parameters: {
      type: 'object',
      properties: {
        rail_name: { type: 'string', description: 'Rail net name, e.g. "3V3" or "5V".' },
        measured_volts: { type: 'number', description: 'Measured voltage in volts.' },
      },
      required: ['rail_name', 'measured_volts'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_continuity',
    description:
      'Check continuity between two probe points or pins and report resistance.',
    parameters: {
      type: 'object',
      properties: {
        probe_a: { type: 'string', description: 'First probe point id, e.g. "TP3" or "U1-14".' },
        probe_b: { type: 'string', description: 'Second probe point id.' },
      },
      required: ['probe_a', 'probe_b'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_rework_guidance',
    description:
      'Generate step-by-step soldering/rework instructions for a fault type and component reference.',
    parameters: {
      type: 'object',
      properties: {
        fault_type: {
          type: 'string',
          description: 'Fault class, e.g. "solder_bridge", "reverse_polarity", "shorted_diode".',
        },
        component_ref: { type: 'string', description: 'Board reference designator, e.g. "U1", "C4", "D2".' },
      },
      required: ['fault_type', 'component_ref'],
      additionalProperties: false,
    },
  },
];

/**
 * Phase 1.5 virtual-lab tool schemas. These probe the deterministic MNA
 * solver (`measure_node_voltage`, `measure_branch_current`) and reuse the
 * legacy `check_continuity` / `lookup_pinout` / `generate_rework_guidance`
 * shapes. `TOOL_DEFINITIONS` (the original four) is unchanged for backwards
 * compatibility; use `VIRTUAL_LAB_TOOL_DEFINITIONS` for virtual sessions and
 * `ALL_TOOL_DEFINITIONS` when both generations must be offered.
 *
 * Ground-truth rule: none of these schemas carries fault ids, target refs,
 * or faulted values — they name only nodes, branches, and part numbers.
 */
export const VIRTUAL_LAB_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'measure_node_voltage',
    description:
      'Measure the powered DC voltage at a circuit node relative to GND using the deterministic MNA virtual bench.',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Circuit node or probe-pad id, e.g. "U1-15" or "TP_NRST".' },
        ref_node: { type: 'string', description: 'Reference node, defaults to "GND".' },
      },
      required: ['node'],
      additionalProperties: false,
    },
  },
  {
    name: 'measure_branch_current',
    description:
      'Measure the DC branch current through a virtual-bench component using the deterministic MNA solver.',
    parameters: {
      type: 'object',
      properties: {
        component_id: { type: 'string', description: 'Component id in the nominal netlist, e.g. "R_PULLUP".' },
      },
      required: ['component_id'],
      additionalProperties: false,
    },
  },
  ...TOOL_DEFINITIONS,
];

/** Union of legacy and virtual-lab tool schemas. */
export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...TOOL_DEFINITIONS,
  ...VIRTUAL_LAB_TOOL_DEFINITIONS.filter((t) => t.name === 'measure_node_voltage' || t.name === 'measure_branch_current'),
];

/**
 * Build a tool-call payload in the Meta Model API shape.
 *
 * When `request.effort` is set, BOTH `reasoning: { effort }` (legacy shape,
 * kept so existing payload-construction tests keep passing) AND the
 * upstream-required top-level `reasoning_effort` are included. The live wire
 * senders (`chatDirect` below and the server proxy) strip `reasoning` before
 * anything reaches `/chat/completions`, because api.meta.ai answers the
 * nested shape with HTTP 400.
 */
export function buildToolCallPayload(request: ChatRequest): Record<string, unknown> {
  return {
    model: request.model ?? SPARK_MODEL_ID,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls
        ? {
            tool_calls: m.tool_calls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.arguments) },
            })),
          }
        : {}),
    })),
    ...(request.tools
      ? {
          tools: request.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }
      : {}),
    ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    ...(request.effort ? { reasoning: { effort: request.effort }, reasoning_effort: request.effort } : {}),
    ...(request.stream ? { stream: true } : {}),
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
  };
}

/** Rough token estimate (chars / 4) used for payload budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Safely parse `tool_calls[].function.arguments`: passes already-parsed
 * objects through untouched, returns `{}` on invalid JSON (never throws).
 * Mirrors the server proxy's parser so both paths stay consistent.
 */
export function safeParseToolArguments(args: unknown): Record<string, unknown> {
  if (args === null || args === undefined) return {};
  if (typeof args === 'object') return args as Record<string, unknown>;
  if (typeof args !== 'string') return {};
  if (args.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Pull a human-readable message out of a proxy/upstream error payload. */
export function extractProxyErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' ? body : '';
  }
  const rec = body as Record<string, unknown>;
  const err = rec['error'];
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const msg = (err as Record<string, unknown>)['message'];
    if (typeof msg === 'string') return msg;
  }
  if (typeof rec['message'] === 'string') return rec['message'] as string;
  return '';
}

export interface AssembledDatasheet {
  text: string;
  estimatedTokens: number;
  truncated: boolean;
  sectionsIncluded: string[];
}

/**
 * Assemble datasheet sections into one long-context payload, newest /
 * most-relevant first, truncating at `maxTokens` (default: full 1M window
 * minus a reasoning reserve).
 */
export function assembleDatasheetPayload(
  sections: DatasheetSection[],
  maxTokens = SPARK_CONTEXT_TOKENS - 65_536,
): AssembledDatasheet {
  const included: string[] = [];
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;

  for (const section of sections) {
    const chunk = `[DATASHEET: ${section.title}]\n${section.text}`;
    const cost = estimateTokens(chunk);
    if (used + cost > maxTokens) {
      truncated = true;
      break;
    }
    chunks.push(chunk);
    included.push(section.title);
    used += cost;
  }

  const text = chunks.join('\n\n');
  return { text, estimatedTokens: used, truncated, sectionsIncluded: included };
}

/**
 * Minimal fetch-compatible signature so tests can inject fakes.
 * `body` is optional: real WhatWG fetch throws
 * `TypeError: Request with GET/HEAD method cannot have body`, so GET
 * requests (e.g. `proxyStatus`) must omit it entirely.
 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface MetaClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Force a mode; defaults to `live` when an API key is present. */
  mode?: ClientMode;
  /** Force a segmentation source; defaults to `live_api` in live mode, else `static_fixture`. */
  segmentationMode?: SegmentationMode;
  model?: ModelId;
  fetchFn?: FetchFn;
  /** Override simulated tool handlers per tool name. */
  simulatedTools?: Partial<Record<ToolDefinition['name'], (args: Record<string, unknown>) => unknown>>;
  /**
   * Local server-proxy base path used by browser live mode
   * (default `/api/meta`; set to `undefined` to disable the proxy route).
   * The proxy attaches `META_API_KEY` server-side; the browser never sees it.
   */
  proxyBaseUrl?: string;
}

/** Shape returned by the local server proxy for chat completions. */
export interface ProxyChatResult {
  content: string;
  toolCalls: ToolCall[];
  model?: string;
  /** Forwarded upstream token counts when the proxy observed them. */
  usage?: ProviderUsage;
}

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined';
}

export interface SegmentPoint {
  x: number;
  y: number;
}

export interface SegmentImageInput {
  url?: string;
  base64?: string;
  points?: SegmentPoint[];
}

export interface SegmentMask {
  id: string;
  label: string;
  polygon: number[][];
}

export interface SegmentImageResult {
  /** Never `live_api` unless a live SAM 3.1 call actually succeeded. */
  mode: 'static_fixture' | 'live_api';
  masks: SegmentMask[];
  confidence: number;
}

export interface SimulatedTrace {
  boardId: string;
  reasoning: string[];
  toolCalls: ToolCall[];
  citations: string[];
  diagnosis: string;
}

const DEFAULT_SIMULATED_TRACES: SimulatedTrace[] = [
  {
    boardId: 'f405-flight-controller',
    reasoning: [
      'Symptom: MCU held in reset, NRST reads 0.0V instead of 3.3V pull-up.',
      'lookup_pinout(STM32F405RGT6, 14) -> VDD 3.3V; pin 15 -> NRST (active-low reset).',
      'check_continuity(U1-14, U1-15) -> 0.4 ohm: direct short between adjacent pins.',
      'Conclusion: microscopic solder bridge pins 14-15 holds MCU in perpetual reset.',
    ],
    toolCalls: [
      { id: 'tc-1', name: 'lookup_pinout', arguments: { part_number: 'STM32F405RGT6', pin_number: '14' } },
      { id: 'tc-2', name: 'check_continuity', arguments: { probe_a: 'U1-14', probe_b: 'U1-15' } },
      { id: 'tc-3', name: 'generate_rework_guidance', arguments: { fault_type: 'solder_bridge', component_ref: 'U1' } },
    ],
    citations: ['STM32F405 datasheet §3 Pinouts, Table 5 (LQFP64)', 'STM32F405 §5.3.1 NRST electricals'],
    diagnosis: 'Solder bridge between STM32 Pin 14 (3.3V) and Pin 15 (NRST).',
  },
  {
    boardId: 'esp32s3-sensor-node',
    reasoning: [
      'Symptom: 5V rail sags to 4.2V, brownout resets, hot spot near C4.',
      'verify_rail_voltage(5V, 4.2) -> out of ±5% tolerance.',
      'Polarity check: tantalum C4 fitted reversed; reverse leakage draws excess current and overheats.',
    ],
    toolCalls: [
      { id: 'tc-1', name: 'verify_rail_voltage', arguments: { rail_name: '5V', measured_volts: 4.2 } },
      { id: 'tc-2', name: 'generate_rework_guidance', arguments: { fault_type: 'reverse_polarity', component_ref: 'C4' } },
    ],
    citations: ['ESP32-S3 datasheet §4.3 power/brownout', 'Tantalum capacitor polarity application note'],
    diagnosis: 'Reverse-polarity tantalum capacitor C4 on the 5V rail.',
  },
  {
    boardId: 'usbc-pd-trigger',
    reasoning: [
      'Symptom: no PD negotiation, CC1 stuck at 0V.',
      'check_continuity(CC1, GND) -> 0.2 ohm: dead short to ground.',
      'TVS diode D2 failed short (typical EOS failure mode), clamping CC1 to GND.',
    ],
    toolCalls: [
      { id: 'tc-1', name: 'check_continuity', arguments: { probe_a: 'CC1', probe_b: 'GND' } },
      { id: 'tc-2', name: 'generate_rework_guidance', arguments: { fault_type: 'shorted_diode', component_ref: 'D2' } },
    ],
    citations: ['USB-C spec §4.5 CC pull-down requirements', 'TVS diode datasheet: short-circuit failure mode'],
    diagnosis: 'Blown TVS protection diode D2 shorting CC1 to ground.',
  },
];

let toolCallSeq = 0;
function nextToolId(): string {
  toolCallSeq += 1;
  return `tc-sim-${toolCallSeq}`;
}

/** Deterministic KiCad-derived fixture masks used when SAM 3.1 is unreachable. */
export const STATIC_FIXTURE_MASKS: SegmentMask[] = [
  { id: 'fixture-u1', label: 'U1 QFP package (fixture)', polygon: [[120, 120], [360, 120], [360, 360], [120, 360]] },
  { id: 'fixture-c4', label: 'C4 capacitor (fixture)', polygon: [[420, 200], [520, 200], [520, 280], [420, 280]] },
  { id: 'fixture-d2', label: 'D2 diode (fixture)', polygon: [[600, 400], [680, 400], [680, 460], [600, 460]] },
];

export class MetaClient {
  readonly mode: ClientMode;
  readonly segmentationMode: SegmentationMode;
  readonly model: ModelId;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchFn;
  private readonly simulatedTools: MetaClientOptions['simulatedTools'];
  private readonly proxyBaseUrl?: string;
  /** Set only after a verified real response arrives (gates `LIVE_API`). */
  private verifiedLiveApi = false;
  /**
   * Set once `proxyStatus()` reports `configured: true` (server holds a
   * `META_API_KEY`). Drives the "Live AI (Ready)" badge while `sparkMode`
   * is still `UNVERIFIED`; never gates `LIVE_API` by itself.
   */
  private proxyConfigured = false;

  /** Record the latest proxy key-configuration signal (Phase 2). */
  setProxyConfigured(configured: boolean): void {
    this.proxyConfigured = configured;
  }

  /** Whether the server proxy has reported a configured `META_API_KEY`. */
  isProxyConfigured(): boolean {
    return this.proxyConfigured;
  }
  /**
   * Set only when a live SAM 3.1 segmentation call actually succeeds.
   * Tracked separately from `verifiedLiveApi` so a live Muse Spark 1.3
   * session never flips the SAM badge to `LIVE_API` (SAM 3.1 is deferred
   * per AGENTS.md §8b; the app pins `segmentationMode: 'static_fixture'`).
   */
  private verifiedSamLiveApi = false;
  /** Cumulative runtime ledger (Milestone B). */
  private telemetry: UsageTelemetry = emptyTelemetry();

  constructor(options: MetaClientOptions = {}) {
    // SECURITY: `META_API_KEY` is read from the process environment ONLY on
    // the Node server side. Browser bundles must NEVER embed the key: in a
    // browser runtime (`window` defined) this reads nothing and live traffic
    // goes through the local server proxy instead. `VITE_*` env access is
    // deliberately absent from this module for the same reason.
    const inBrowser = isBrowserRuntime();
    const env = inBrowser
      ? undefined
      : (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    this.apiKey = options.apiKey ?? env?.['META_API_KEY'];
    this.mode = options.mode ?? (this.apiKey ? 'live' : 'simulated');
    this.segmentationMode =
      options.segmentationMode ?? (this.mode === 'live' ? 'live_api' : 'static_fixture');
    this.model = options.model ?? SPARK_MODEL_ID;
    this.baseUrl = (options.baseUrl ?? 'https://api.meta.ai/v1').replace(/\/$/, '');
    this.fetchFn = options.fetchFn;
    this.simulatedTools = options.simulatedTools;
    this.proxyBaseUrl = options.proxyBaseUrl ?? (inBrowser ? '/api/meta' : undefined);
  }

  /** Whether this client would route live traffic through the server proxy. */
  usesProxyRoute(): boolean {
    return isBrowserRuntime() && !this.apiKey && this.proxyBaseUrl !== undefined;
  }

  private sparkOperationalMode(): OperationalMode {
    if (this.mode === 'simulated') return 'SIMULATED';
    if (this.verifiedLiveApi) return 'LIVE_API';
    if (this.apiKey || this.proxyBaseUrl) return 'UNVERIFIED';
    return 'UNAVAILABLE';
  }

  private samOperationalMode(): OperationalMode {
    if (this.segmentationMode !== 'live_api') return 'STATIC_FIXTURE';
    if (this.mode === 'simulated') return 'STATIC_FIXTURE';
    if (this.verifiedSamLiveApi || this.verifiedLiveApi) return 'LIVE_API';
    if (this.apiKey || this.proxyBaseUrl) return 'UNVERIFIED';
    return 'UNAVAILABLE';
  }

  /** Active status snapshot for the workbench header. */
  status(): {
    model: ModelId;
    contextTokens: number;
    segmenter: 'sam-3.1';
    mode: ClientMode;
    segmentationMode: SegmentationMode;
    /** Phase 1.5 transparency: Muse Spark reasoning capability mode. */
    sparkMode: OperationalMode;
    /** Phase 1.5 transparency: SAM segmentation capability mode. */
    samMode: OperationalMode;
    /** True once a real remote response has been verified this session. */
    liveVerified: boolean;
    /** Latest `proxyStatus()` configured signal (Phase 2 badge support). */
    proxyConfigured: boolean;
  } {
    return {
      model: this.model,
      contextTokens: SPARK_CONTEXT_TOKENS,
      segmenter: 'sam-3.1',
      mode: this.mode,
      segmentationMode: this.segmentationMode,
      sparkMode: this.sparkOperationalMode(),
      samMode: this.samOperationalMode(),
      liveVerified: this.verifiedLiveApi,
      proxyConfigured: this.proxyConfigured,
    };
  }

  /** Cumulative usage & cost ledger snapshot (a copy; mutate via calls). */
  getTelemetry(): UsageTelemetry {
    return { ...this.telemetry };
  }

  /** Zero the cumulative ledger (keeps the coding-agent allocation). */
  resetTelemetry(): void {
    this.telemetry = emptyTelemetry();
  }

  /** Promotional-credit budget snapshot for the UI monitor banner. */
  getCostLedger(): CostLedgerSnapshot {
    return buildCostLedger(this.telemetry);
  }

  /**
   * Fold one attempt's token counts into the ledger. `liveSpend` marks
   * whether the tokens bill real money (`live` mode) or only project it
   * (`simulated` mode: incurred stays `$0.00` while the projected live cost
   * still accrues so users see exact session pricing before spending).
   */
  private accumulateTokens(
    inputTokens: number,
    outputTokens: number,
    providerReported: boolean,
    liveSpend: boolean,
  ): void {
    this.telemetry.inputTokens += inputTokens;
    this.telemetry.outputTokens += outputTokens;
    if (providerReported) this.telemetry.providerReportedUsage = true;
    const liveCost = estimateLiveCostUsd(inputTokens, outputTokens);
    this.telemetry.projectedLiveCostUsd += liveCost;
    if (liveSpend) {
      this.telemetry.incurredCostUsd += liveCost;
      this.telemetry.estimatedCostUsd = this.telemetry.incurredCostUsd;
      this.telemetry.runtimeConsumptionUsd = this.telemetry.incurredCostUsd;
    }
  }

  /** Prefer provider `usage` counts; fall back to local estimates. */
  private resolveUsage(
    usage: ProviderUsage | undefined,
    fallbackInput: number,
    fallbackOutput: number,
  ): { input: number; output: number; providerReported: boolean } {
    const prompt = usage?.prompt_tokens;
    const completion = usage?.completion_tokens;
    if (typeof prompt === 'number' && Number.isFinite(prompt) && typeof completion === 'number' && Number.isFinite(completion)) {
      return { input: Math.max(0, Math.floor(prompt)), output: Math.max(0, Math.floor(completion)), providerReported: true };
    }
    return { input: fallbackInput, output: fallbackOutput, providerReported: false };
  }

  /**
   * Query the local server proxy status (`GET <proxyBaseUrl>/status`).
   * Reports whether the server holds a `META_API_KEY` — without ever
   * exposing the key itself.
   */
  async proxyStatus(): Promise<{ configured: boolean; mode: OperationalMode }> {
    if (!this.proxyBaseUrl) return { configured: false, mode: 'UNAVAILABLE' };
    const fetchFn = this.fetchFn ?? globalThis.fetch.bind(globalThis);
    // No `body` on GET: real WhatWG fetch (browsers/Node) throws
    // `TypeError: Request with GET/HEAD method cannot have body`.
    const res = await fetchFn(`${this.proxyBaseUrl}/status`, {
      method: 'GET',
      headers: {},
    });
    if (!res.ok) throw new Error(`Meta proxy status error: HTTP ${res.status}`);
    const data = (await res.json()) as { configured?: boolean; mode?: OperationalMode };
    if (data.configured === true) this.proxyConfigured = true;
    return {
      configured: data.configured === true,
      mode: data.mode ?? (data.configured ? 'UNVERIFIED' : 'UNAVAILABLE'),
    };
  }

  /**
   * Segment a board image with SAM 3.1.
   *
   * Offline / fixture modes transparently return the bundled KiCad
   * fixture masks labeled `static_fixture` — never pretending live
   * model execution happened. Live mode shapes a Meta Model API
   * `/v1/responses` payload and propagates HTTP failures to the
   * caller instead of fabricating masks.
   */
  async segmentImage(image: SegmentImageInput): Promise<SegmentImageResult> {
    if (this.segmentationMode !== 'live_api' || this.mode !== 'live') {
      return {
        mode: 'static_fixture',
        masks: STATIC_FIXTURE_MASKS.map((m) => ({ ...m, polygon: m.polygon.map((p) => [...p]) })),
        confidence: 0.5,
      };
    }
    if (!image.url && !image.base64) {
      throw new Error('segmentImage requires an image url or base64 payload.');
    }
    const fetchFn = this.fetchFn ?? globalThis.fetch.bind(globalThis);
    if (this.usesProxyRoute()) {
      // Browser live mode: proxy attaches the key server-side. No
      // `Authorization` header is ever constructed in browser code.
      const res = await fetchFn(`${this.proxyBaseUrl}/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image }),
      });
      if (res.status === 503) {
        throw new Error('Live Meta API key is not configured on the local server proxy. Running in zero-cost simulated mode.');
      }
      if (!res.ok) throw new Error(`SAM 3.1 segmentation error: HTTP ${res.status}`);
      const data = (await res.json()) as { masks?: SegmentMask[]; confidence?: number };
      if (!Array.isArray(data.masks)) throw new Error('SAM 3.1 response missing masks array.');
      this.verifiedLiveApi = true;
      this.verifiedSamLiveApi = true;
      return {
        mode: 'live_api',
        masks: data.masks,
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      };
    }
    const res = await fetchFn(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: SAM_MODEL_ID,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Segment PCB components; return masks with labels and polygons.' },
              ...(image.url ? [{ type: 'input_image', image_url: image.url }] : []),
              ...(image.base64
                ? [{ type: 'input_image', image_url: `data:image/png;base64,${image.base64}` }]
                : []),
              ...(image.points?.length ? [{ type: 'input_points', points: image.points }] : []),
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`SAM 3.1 segmentation error: HTTP ${res.status}`);
    const data = (await res.json()) as {
      masks?: Array<{ id?: string; label?: string; polygon?: number[][] }>;
      confidence?: number;
    };
    if (!Array.isArray(data.masks)) throw new Error('SAM 3.1 response missing masks array.');
    this.verifiedLiveApi = true;
    this.verifiedSamLiveApi = true;
    return {
      mode: 'live_api',
      masks: data.masks.map((m, i) => ({
        id: typeof m.id === 'string' ? m.id : `sam-${i}`,
        label: typeof m.label === 'string' ? m.label : `mask-${i}`,
        polygon: Array.isArray(m.polygon) ? m.polygon : [],
      })),
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    };
  }

  /** Execute a single tool call (simulated fixture when offline). */
  executeTool(name: ToolDefinition['name'], args: Record<string, unknown>): unknown {
    const override = this.simulatedTools?.[name];
    if (override) return override(args);
    return defaultSimulatedToolResult(name, args);
  }

  /** Look up a pre-recorded high-fidelity trace for a board (fixture mode). */
  getSimulatedTrace(boardId: string): SimulatedTrace | undefined {
    return DEFAULT_SIMULATED_TRACES.find((t) => t.boardId === boardId);
  }

  /** List all bundled simulated traces. */
  listSimulatedTraces(): SimulatedTrace[] {
    return [...DEFAULT_SIMULATED_TRACES];
  }

  /**
   * Chat completion with cumulative telemetry and bounded retry.
   *
   * - `maxTokens` is clamped to `MAX_TOKENS_CAP` (default 1024) so runaway
   *   requests cannot occur.
   * - At most one retry, only on transient HTTP 502/503/504. Never retried:
   *   4xx/401/403, timeouts, and the proxy's key-missing 503 (a
   *   configuration state, not a transient failure).
   * - Every attempt folds input tokens into the ledger; successful attempts
   *   add output tokens (provider `usage` counts when present).
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.mode === 'simulated') {
      const response = await this.simulatedChat(request);
      this.telemetry.totalRequests += 1;
      this.accumulateTokens(
        estimateTokens(request.messages.map((m) => m.content).join('\n')),
        estimateTokens(response.content),
        false,
        false,
      );
      return response;
    }
    const capped: ChatRequest = {
      ...request,
      model: request.model ?? this.model,
      maxTokens: clampMaxTokens(request.maxTokens),
    };
    const fetchFn = this.fetchFn ?? globalThis.fetch.bind(globalThis);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const response = this.usesProxyRoute()
          ? await this.chatViaProxy(capped, fetchFn)
          : await this.chatDirect(capped, fetchFn);
        if (attempts > 1) this.telemetry.retriedRequests += 1;
        this.telemetry.totalRequests += 1;
        return response;
      } catch (err) {
        const mayRetry = attempts <= MAX_CHAT_RETRIES && isRetryableChatError(err);
        if (!mayRetry) {
          if (attempts > 1) this.telemetry.retriedRequests += 1;
          this.telemetry.totalRequests += 1;
          this.telemetry.failedRequests += 1;
          throw err;
        }
        // Single bounded retry: loop once more.
      }
    }
  }

  /** Browser live mode: POST to the local server proxy WITHOUT any `Authorization` header. */
  private async chatViaProxy(request: ChatRequest, fetchFn: FetchFn): Promise<ChatResponse> {
    // The proxy attaches `META_API_KEY` server-side and never echoes it back.
    // Messages/tools go through `buildToolCallPayload` first so the proxy
    // and direct paths send 100% consistent OpenAI wire shapes.
    const wire = buildToolCallPayload({ ...request, model: request.model ?? this.model });
    const bodyText = JSON.stringify({
      model: wire.model,
      messages: wire.messages,
      ...(wire.tools !== undefined ? { tools: wire.tools } : {}),
      responseFormat: request.responseFormat,
      effort: request.effort,
      maxTokens: request.maxTokens,
    });
    const res = await withRequestTimeout(
      fetchFn(`${this.proxyBaseUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
      }),
      CLIENT_REQUEST_TIMEOUT_MS,
      'Meta proxy',
    );
    if (!res.ok) {
      // Read the proxy's JSON error field so the thrown Error carries the
      // exact upstream status/detail (a 503 here is upstream-transient
      // UNLESS it is the proxy's key-missing configuration state).
      let proxyDetail = '';
      try {
        proxyDetail = extractProxyErrorMessage(await res.json());
      } catch {
        proxyDetail = '';
      }
      this.accumulateTokens(estimateTokens(bodyText), 0, false, true);
      if (res.status === 503 && proxyDetail.includes('not configured on the local server proxy')) {
        throw new Error('Live Meta API key is not configured on the local server proxy. Running in zero-cost simulated mode.');
      }
      throw new Error(
        proxyDetail && proxyDetail !== `Meta Model API error: HTTP ${res.status}`
          ? `Meta Model API error: HTTP ${res.status} — ${proxyDetail}`
          : (proxyDetail || `Meta Model API error: HTTP ${res.status}`),
      );
    }
    const data = (await res.json()) as Partial<ProxyChatResult> & {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: unknown } }> } }>;
    };
    const toolCalls: ToolCall[] = Array.isArray(data.toolCalls)
      ? data.toolCalls
      : (data.choices?.[0]?.message?.tool_calls ?? []).map((t) => ({
          id: t.id,
          name: t.function.name as ToolCall['name'],
          arguments: safeParseToolArguments(t.function.arguments),
        }));
    const content = data.content ?? data.choices?.[0]?.message?.content ?? '';
    const usage = this.resolveUsage(
      data.usage,
      estimateTokens(bodyText),
      estimateTokens(content + JSON.stringify(toolCalls)),
    );
    this.accumulateTokens(usage.input, usage.output, usage.providerReported, true);
    this.verifiedLiveApi = true;
    return {
      model: request.model ?? this.model,
      mode: 'live',
      content,
      toolCalls,
      simulated: false,
    };
  }

  /** Node/server live mode: direct upstream call with server-side Bearer [REDACTED] */
  private async chatDirect(request: ChatRequest, fetchFn: FetchFn): Promise<ChatResponse> {
    const payload = buildToolCallPayload({ ...request, model: request.model ?? this.model });
    // Meta's OpenAI-compatible `/chat/completions` requires top-level
    // `reasoning_effort` and rejects `reasoning` with HTTP 400 — strip the
    // legacy nested shape; `reasoning_effort` (set above) rides along.
    delete payload['reasoning'];
    const bodyText = JSON.stringify(payload);
    const res = await withRequestTimeout(
      fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: bodyText,
      }),
      CLIENT_REQUEST_TIMEOUT_MS,
      'Meta Model API',
    );
    if (!res.ok) {
      let directDetail = '';
      try {
        directDetail = extractProxyErrorMessage(await res.json());
      } catch {
        directDetail = '';
      }
      this.accumulateTokens(estimateTokens(bodyText), 0, false, true);
      throw new Error(
        directDetail && directDetail !== `Meta Model API error: HTTP ${res.status}`
          ? `Meta Model API error: HTTP ${res.status} — ${directDetail}`
          : (directDetail || `Meta Model API error: HTTP ${res.status}`),
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: unknown } }> } }>;
      usage?: ProviderUsage;
    };
    const message = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((t) => ({
      id: t.id,
      name: t.function.name as ToolCall['name'],
      arguments: safeParseToolArguments(t.function.arguments),
    }));
    const content = message?.content ?? '';
    const usage = this.resolveUsage(
      data.usage,
      estimateTokens(bodyText),
      estimateTokens(content + JSON.stringify(toolCalls)),
    );
    this.accumulateTokens(usage.input, usage.output, usage.providerReported, true);
    this.verifiedLiveApi = true;
    return {
      model: request.model ?? this.model,
      mode: 'live',
      content,
      toolCalls,
      simulated: false,
    };
  }

  /** Stream a chat completion as content deltas (simulated by chunking the fixture). */
  async *streamChat(request: ChatRequest): AsyncGenerator<string, ChatResponse, void> {
    const response = await this.chat(request);
    if (this.mode === 'simulated') {
      const words = response.content.split(/(?<=\s)/);
      let emitted = '';
      for (const w of words) {
        emitted += w;
        yield w;
      }
      void emitted;
    } else {
      yield response.content;
    }
    return response;
  }

  private async simulatedChat(request: ChatRequest): Promise<ChatResponse> {
    const boardId = detectBoardId(request.messages.map((m) => m.content).join('\n'));
    const trace: SimulatedTrace =
      (boardId !== undefined ? this.getSimulatedTrace(boardId) : undefined) ?? DEFAULT_SIMULATED_TRACES[0] as SimulatedTrace;
    const content = [
      ...trace.reasoning.map((r) => `▸ ${r}`),
      '',
      `DIAGNOSIS: ${trace.diagnosis}`,
      `CITATIONS: ${trace.citations.join(' | ')}`,
    ].join('\n');
    const toolCalls: ToolCall[] = trace.toolCalls.map((t) => ({ ...t, id: nextToolId() }));
    return { model: request.model ?? this.model, mode: 'simulated', content, toolCalls, simulated: true };
  }
}

const BOARD_KEYWORDS: Array<{ id: string; keys: string[] }> = [
  { id: 'f405-flight-controller', keys: ['f405', 'flight controller', 'stm32'] },
  { id: 'esp32s3-sensor-node', keys: ['esp32', 'sensor node', 'c4'] },
  { id: 'usbc-pd-trigger', keys: ['usb-c', 'usbc', 'pd trigger', 'cc1'] },
];

/** Heuristic board matcher for fixture selection (exported for tests). */
export function detectBoardId(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const entry of BOARD_KEYWORDS) {
    if (entry.keys.some((k) => lower.includes(k))) return entry.id;
  }
  return undefined;
}

/** Default deterministic fixture results for each tool. */
export function defaultSimulatedToolResult(
  name: ToolDefinition['name'],
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'lookup_pinout':
      return {
        part_number: args['part_number'],
        pin_number: args['pin_number'],
        function: pinFunctionHint(String(args['part_number'] ?? ''), String(args['pin_number'] ?? '')),
        source: 'simulated datasheet extract',
      };
    case 'verify_rail_voltage':
      return {
        rail_name: args['rail_name'],
        measured_volts: args['measured_volts'],
        note: 'simulated rail reading',
      };
    case 'measure_node_voltage':
      return {
        node: args['node'],
        ref_node: args['ref_node'] ?? 'GND',
        note: 'simulated MNA node-voltage reading (wire to the virtual bench for exact values)',
      };
    case 'measure_branch_current':
      return {
        component_id: args['component_id'],
        note: 'simulated MNA branch-current reading (wire to the virtual bench for exact values)',
      };
    case 'check_continuity':
      return {
        probe_a: args['probe_a'],
        probe_b: args['probe_b'],
        resistance_ohms: continuityFixture(String(args['probe_a'] ?? ''), String(args['probe_b'] ?? '')),
        note: 'simulated continuity reading',
      };
    case 'generate_rework_guidance':
      return {
        fault_type: args['fault_type'],
        component_ref: args['component_ref'],
        steps: [
          'Power off board, disconnect battery/USB, verify 0V on rails.',
          'Set iron to lead-free 320°C (leaded 300°C), fine chisel tip.',
          'Apply flux, clear fault with solder wick — never scrape.',
          'Clean with IPA, inspect under magnification, re-test rails.',
        ],
      };
  }
}

function pinFunctionHint(partNumber: string, pin: string): string {
  const p = partNumber.toLowerCase();
  if (p.includes('stm32f405')) {
    if (pin === '14') return 'VDD (3.3V supply)';
    if (pin === '15') return 'NRST (active-low reset, internal pull-up)';
    return 'GPIO / see datasheet Table 5';
  }
  if (p.includes('esp32')) return 'See ESP32-S3 pin function table';
  return 'See component datasheet';
}

function continuityFixture(a: string, b: string): number {
  const pair = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
  if (pair.includes('u1-14') && pair.includes('u1-15')) return 0.4;
  if (pair.includes('cc1') && pair.includes('gnd')) return 0.2;
  return 12_000_000; // open circuit
}
