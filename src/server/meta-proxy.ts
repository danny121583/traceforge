/**
 * TraceForge Phase 1.5 — Local Meta API server proxy (Node side only).
 *
 * The browser bundle must NEVER see `META_API_KEY`: browser live traffic is
 * POSTed to these same-origin endpoints, and this middleware attaches the key
 * from the server process environment before forwarding upstream. The key is
 * never echoed in any HTTP response. Without a key, `/status` reports
 * `{ configured: false, mode: 'UNAVAILABLE' }` and the inference endpoints
 * answer HTTP 503 with a zero-cost simulated-mode message.
 *
 * Framework-agnostic minimal request/response shapes keep this unit-testable
 * in Vitest without Node type dependencies; `vite.config.ts` mounts it via
 * `configureServer`.
 */

export const META_PROXY_PREFIX = '/api/meta';
export const META_PROXY_STATUS_PATH = '/api/meta/status';
export const META_PROXY_CHAT_PATH = '/api/meta/chat';
export const META_PROXY_SEGMENT_PATH = '/api/meta/segment';

export const PROXY_KEY_MISSING_MESSAGE =
  'Live Meta API key is not configured on the local server proxy. Running in zero-cost simulated mode.';

/** Default `max_tokens` applied when the caller omits it (runaway guard). */
export const META_PROXY_DEFAULT_MAX_TOKENS = 1024;
/** Hard ceiling: upstream `max_tokens` is always clamped to this value. */
export const META_PROXY_MAX_TOKENS_CAP = 1024;
/** Largest accepted JSON request body (bytes/chars); larger bodies get HTTP 413. */
export const META_PROXY_MAX_BODY_BYTES = 256_000;
/** Bounded upstream timeout; exceeded waits answer HTTP 504, never hang. */
export const META_PROXY_UPSTREAM_TIMEOUT_MS = 30_000;

export const PROXY_BODY_TOO_LARGE_MESSAGE =
  `Meta proxy request body exceeds the ${META_PROXY_MAX_BODY_BYTES}-byte limit.`;

/** Clamp a caller-supplied `maxTokens` onto the proxy guard rail. */
export function clampProxyMaxTokens(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return META_PROXY_DEFAULT_MAX_TOKENS;
  return Math.min(Math.max(1, Math.floor(requested)), META_PROXY_MAX_TOKENS_CAP);
}

/** Upstream token counts forwarded verbatim (never the API key). */
export interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Pick only finite numeric usage fields out of an upstream payload. */
function pickUsage(value: unknown): UpstreamUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const src = value as Record<string, unknown>;
  const out: UpstreamUsage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    const v = src[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.max(0, Math.floor(v));
  }
  return out.prompt_tokens !== undefined || out.completion_tokens !== undefined || out.total_tokens !== undefined
    ? out
    : undefined;
}

/** Race an upstream call against the bounded proxy timeout. */
function withUpstreamTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Meta Model API upstream request timed out after ${META_PROXY_UPSTREAM_TIMEOUT_MS} ms.`)),
      META_PROXY_UPSTREAM_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Minimal structural request (covers real dev-server requests and test doubles). */
export interface ProxyRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Pre-parsed JSON body (tests / body-parsing stacks). */
  body?: unknown;
  on?: (event: 'data' | 'end' | 'error', cb: (chunk?: unknown) => void) => void;
}

/** Minimal structural response. */
export interface ProxyResponse {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  end?: (body: string) => void;
}

export type ProxyNext = () => void;

export type UpstreamFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface MetaProxyEnv {
  getApiKey: () => string | undefined;
  baseUrl: string;
  fetchFn: UpstreamFetch;
}

function readApiKeyFromServerEnv(): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const key = proc?.env?.['META_API_KEY'];
  return key && key.length > 0 ? key : undefined;
}

/**
 * Safely parse `tool_calls[].function.arguments`: returns `{}` on invalid
 * JSON and passes already-parsed objects through untouched.
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

interface NormalizedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One normalized assistant `tool_calls` entry in OpenAI wire shape. */
function normalizeOneToolCall(t: unknown): NormalizedToolCall | null {
  if (!t || typeof t !== 'object') return null;
  const rec = t as Record<string, unknown>;
  const fn = rec['function'];
  if (fn !== null && typeof fn === 'object') {
    // Already OpenAI-wrapped: re-stringify object arguments, keep strings.
    const fnRec = fn as Record<string, unknown>;
    const raw = fnRec['arguments'];
    const args = typeof raw === 'string' ? raw : JSON.stringify((raw ?? {}) as Record<string, unknown>);
    return {
      id: typeof rec['id'] === 'string' ? (rec['id'] as string) : '',
      type: 'function',
      function: { name: typeof fnRec['name'] === 'string' ? (fnRec['name'] as string) : '', arguments: args },
    };
  }
  // Internal ToolCall shape: { id, name, arguments }.
  const raw = rec['arguments'];
  const args = typeof raw === 'string' ? raw : JSON.stringify((raw ?? {}) as Record<string, unknown>);
  return {
    id: typeof rec['id'] === 'string' ? (rec['id'] as string) : '',
    type: 'function',
    function: { name: typeof rec['name'] === 'string' ? (rec['name'] as string) : '', arguments: args },
  };
}

/**
 * Normalize assistant `tool_calls` to OpenAI Chat Completions wire shape:
 * `{ id, type: 'function', function: { name, arguments: '<json>' } }`.
 * Accepts internal `{ id, name, arguments }` items and already-wrapped
 * items alike.
 */
export function normalizeProxyToolCalls(toolCalls: unknown): NormalizedToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: NormalizedToolCall[] = [];
  for (const t of toolCalls) {
    const n = normalizeOneToolCall(t);
    if (n) out.push(n);
  }
  return out;
}

export interface NormalizedTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/**
 * Normalize `tools` so the upstream payload ALWAYS wraps every tool as
 * `{ type: 'function', function: { name, description, parameters } }`,
 * whether callers sent flat `{ name, description, parameters }` items or
 * already-wrapped OpenAI items.
 */
export function normalizeProxyTools(tools: unknown): NormalizedTool[] | undefined {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => {
    if (t !== null && typeof t === 'object') {
      const rec = t as Record<string, unknown>;
      const fn = rec['function'];
      if (fn !== null && typeof fn === 'object') {
        const fnRec = fn as Record<string, unknown>;
        return {
          type: 'function' as const,
          function: {
            name: typeof fnRec['name'] === 'string' ? (fnRec['name'] as string) : '',
            description: typeof fnRec['description'] === 'string' ? (fnRec['description'] as string) : '',
            parameters: fnRec['parameters'],
          },
        };
      }
      return {
        type: 'function' as const,
        function: {
          name: typeof rec['name'] === 'string' ? (rec['name'] as string) : '',
          description: typeof rec['description'] === 'string' ? (rec['description'] as string) : '',
          parameters: rec['parameters'],
        },
      };
    }
    return { type: 'function' as const, function: { name: '', description: '', parameters: undefined } };
  });
}

export interface NormalizedMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: NormalizedToolCall[];
}

/**
 * Normalize chat messages to OpenAI Chat Completions wire shape:
 * assistant `tool_calls` in internal `{ id, name, arguments }` shape are
 * serialized to `{ id, type: 'function', function: { name, arguments } }`,
 * and assistant `content` defaults to `''` when null/undefined (the API
 * requires a string or null when tool calls are present; `''` is safest).
 */
export function normalizeProxyMessages(messages: unknown): NormalizedMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return { role: 'user', content: '' };
    const rec = m as Record<string, unknown>;
    const role = typeof rec['role'] === 'string' ? (rec['role'] as string) : 'user';
    let content: string;
    if (rec['content'] === null || rec['content'] === undefined) {
      content = role === 'assistant' ? '' : '';
    } else if (typeof rec['content'] === 'string') {
      content = rec['content'] as string;
    } else {
      try {
        content = JSON.stringify(rec['content']);
      } catch {
        content = '';
      }
    }
    const out: NormalizedMessage = { role, content };
    if (typeof rec['tool_call_id'] === 'string') out.tool_call_id = rec['tool_call_id'] as string;
    if (rec['tool_calls'] !== undefined) out.tool_calls = normalizeProxyToolCalls(rec['tool_calls']);
    return out;
  });
}

/** Pull a human-readable message out of an upstream error payload. */
export function extractUpstreamErrorMessage(body: unknown): string {
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

/** Scrub the API key out of an error string in case it ever appears. */
export function scrubApiKeyFromText(text: string, apiKey: string | undefined): string {
  if (!apiKey || apiKey.length === 0) return text;
  return text.split(apiKey).join('[REDACTED]');
}

/**
 * Parse a `.env` file body for `META_API_KEY=<value>`: strips optional
 * quotes/whitespace and ignores comments and other lines.
 */
export function parseDotEnvApiKey(text: string): string | undefined {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().replace(/^\uFEFF/, '');
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^META_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = (match[1] ?? '').trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      const end = value.indexOf(quote, 1);
      value = end !== -1 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    value = value.trim();
    if (value.length > 0) return value;
    // Present-but-empty: never cache — keep scanning, resolve as missing.
  }
  return undefined;
}

/**
 * Best-effort live `.env` read (Node server side only). Uses a dynamic
 * `node:fs` import so browser bundles never resolve it; any failure
 * resolves to `undefined` (zero-cost mode) instead of throwing.
 */
async function readDotEnvApiKey(): Promise<string | undefined> {
  try {
    const proc = (globalThis as { process?: { cwd?: () => string } }).process;
    if (!proc || typeof proc.cwd !== 'function') return undefined;
    let fs: { readFileSync?: (path: string, encoding: string) => string } | undefined;
    try {
      // Indirect dynamic import: the specifier never appears as a static
      // module reference, so browser type-checks/bundles never resolve
      // `node:fs` (no @types/node needed) and non-Node runtimes just fail
      // into the catch below.
      const dynamicImport = new Function('spec', 'return import(spec)') as (
        spec: string,
      ) => Promise<unknown>;
      const mod = (await dynamicImport('node:fs')) as
        | { readFileSync?: (path: string, encoding: string) => string; default?: { readFileSync?: (path: string, encoding: string) => string } };
      fs = mod.default ?? mod;
    } catch {
      return undefined;
    }
    if (!fs || typeof fs.readFileSync !== 'function') return undefined;
    const cwd = proc.cwd();
    const dotenvPath = `${cwd.replace(/\/$/, '')}/.env`;
    let text: string;
    try {
      text = fs.readFileSync(dotenvPath, 'utf8');
    } catch {
      return undefined;
    }
    return parseDotEnvApiKey(text);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective server API key WITHOUT caching: explicit override
 * first, then `process.env.META_API_KEY`, then a fresh `.env` read — so if
 * the owner drops `META_API_KEY` into `.env` while the Vite server is
 * already running, the very next `/api/meta/status` or `/api/meta/chat`
 * request picks it up immediately. Never resolves to an empty string.
 */
export async function resolveServerApiKey(
  explicitGetApiKey?: () => string | undefined,
): Promise<string | undefined> {
  // An explicitly provided getter is authoritative (even when it resolves to
  // missing) so test doubles stay hermetic; only when NO getter is provided
  // — the real Vite middleware path — do we consult process.env and `.env`.
  if (explicitGetApiKey) {
    const explicit = explicitGetApiKey();
    return explicit && explicit.length > 0 ? explicit : undefined;
  }
  const fromEnv = readApiKeyFromServerEnv();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const fromDotEnv = await readDotEnvApiKey();
  return fromDotEnv && fromDotEnv.length > 0 ? fromDotEnv : undefined;
}

async function readJsonBody(req: ProxyRequest): Promise<unknown> {
  if (req.body !== undefined) {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (text.length > META_PROXY_MAX_BODY_BYTES) throw new Error(PROXY_BODY_TOO_LARGE_MESSAGE);
    return req.body;
  }
  if (typeof req.on !== 'function') return undefined;
  const text = await new Promise<string>((resolve, reject) => {
    let acc = '';
    req.on!('data', (chunk) => {
      acc += String(chunk);
      if (acc.length > META_PROXY_MAX_BODY_BYTES) {
        reject(new Error(PROXY_BODY_TOO_LARGE_MESSAGE));
      }
    });
    req.on!('end', () => resolve(acc));
    req.on!('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function sendJson(res: ProxyResponse, status: number, payload: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader?.('Content-Type', 'application/json');
  res.end?.(JSON.stringify(payload));
}

interface ChatProxyBody {
  model?: string;
  messages?: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown }>;
  tools?: unknown[];
  responseFormat?: 'text' | 'json';
  effort?: string;
  /** Top-level passthrough (preferred upstream wire key). */
  reasoning_effort?: string;
  /** Legacy nested shape — resolved, never forwarded (upstream answers HTTP 400). */
  reasoning?: { effort?: string };
  maxTokens?: number;
}

/**
 * Resolve the concise-thinking effort for POST /api/meta/chat from any
 * accepted caller shape: `effort`, top-level `reasoning_effort`, or the
 * legacy nested `reasoning: { effort }`. Returns `undefined` when none is
 * supplied (both wire keys are then omitted upstream).
 */
export function resolveProxyEffort(body: ChatProxyBody | undefined): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const direct = body.effort;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const flat = body.reasoning_effort;
  if (typeof flat === 'string' && flat.length > 0) return flat;
  const nested = body.reasoning;
  if (nested && typeof nested === 'object' && typeof nested.effort === 'string' && nested.effort.length > 0) {
    return nested.effort;
  }
  return undefined;
}

interface SegmentProxyBody {
  image?: { url?: string; base64?: string; points?: Array<{ x: number; y: number }> };
}

/**
 * Handle one proxy request. Returns `true` when the request targeted the
 * proxy (response already sent), `false` when the caller should `next()` on.
 */
export async function handleMetaProxyRequest(
  req: ProxyRequest,
  res: ProxyResponse,
  env?: Partial<MetaProxyEnv>,
): Promise<boolean> {
  const url = req.url ?? '';
  const path = url.split('?')[0];
  if (path !== META_PROXY_STATUS_PATH && path !== META_PROXY_CHAT_PATH && path !== META_PROXY_SEGMENT_PATH) {
    return false;
  }
  // Resolved fresh on EVERY request (never cached): explicit override, then
  // `process.env.META_API_KEY`, then a live `.env` read — so a key dropped
  // into `.env` while the Vite server runs takes effect on the next request.
  const apiKey = await resolveServerApiKey(env?.getApiKey);
  const baseUrl = (env?.baseUrl ?? 'https://api.meta.ai/v1').replace(/\/$/, '');
  const fetchFn: UpstreamFetch =
    env?.fetchFn ??
    ((u, init) =>
      globalThis.fetch(u, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      }).then(async (r) => ({ ok: r.ok, status: r.status, json: () => r.json() as Promise<unknown> })));

  if (req.method === 'GET' && path === META_PROXY_STATUS_PATH) {
    // Never include the key — only whether one is configured.
    sendJson(res, 200, { configured: apiKey !== undefined, mode: apiKey ? 'UNVERIFIED' : 'UNAVAILABLE' });
    return true;
  }

  if (req.method === 'POST' && (path === META_PROXY_CHAT_PATH || path === META_PROXY_SEGMENT_PATH)) {
    if (!apiKey) {
      sendJson(res, 503, { error: PROXY_KEY_MISSING_MESSAGE });
      return true;
    }
    let body: (ChatProxyBody & SegmentProxyBody & Record<string, unknown>) | undefined;
    try {
      body = (await readJsonBody(req)) as ChatProxyBody & SegmentProxyBody & Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('exceeds')) {
        // Oversized request body: refuse before touching the upstream API.
        sendJson(res, 413, { error: message });
        return true;
      }
      sendJson(res, 400, { error: message });
      return true;
    }
    try {
      if (path === META_PROXY_CHAT_PATH) {
        // Runaway-request guard: always send a bounded `max_tokens`.
        const maxTokens = clampProxyMaxTokens(body?.maxTokens);
        // Normalize to OpenAI Chat Completions wire shape: flat tools get
        // wrapped, and internal-shape assistant tool_calls get serialized.
        const normalizedTools = normalizeProxyTools(body?.tools);
        const normalizedMessages = normalizeProxyMessages(body?.messages ?? []);
        // Meta's OpenAI-compatible endpoint requires top-level
        // `reasoning_effort` and rejects `reasoning` with HTTP 400, so the
        // nested shape is resolved here and NEVER forwarded upstream.
        const effort = resolveProxyEffort(body);
        const upstream = await withUpstreamTimeout(
          fetchFn(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: body?.model ?? 'muse-spark-1.3',
              messages: normalizedMessages,
              ...(normalizedTools ? { tools: normalizedTools } : {}),
              ...(body?.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
              ...(effort ? { reasoning_effort: effort } : {}),
              max_tokens: maxTokens,
            }),
          }),
        );
        if (!upstream.ok) {
          // Forward the upstream status verbatim for 400..599 (a 400/401/403
          // is a client/auth error, NOT a retryable 502) plus any upstream
          // error detail — scrubbed of the key in case it ever appears.
          const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
          let detail = '';
          try {
            detail = extractUpstreamErrorMessage(await upstream.json());
          } catch {
            detail = '';
          }
          let message = `Meta Model API error: HTTP ${upstream.status}`;
          if (detail) message += ` — ${detail}`;
          sendJson(res, status, { error: scrubApiKeyFromText(message, apiKey) });
          return true;
        }
        const data = (await upstream.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{ id: string; function: { name: string; arguments: unknown } }>;
            };
          }>;
          usage?: unknown;
        };
        const message = data.choices?.[0]?.message;
        // Fresh object with known fields only: the key is never echoed, and
        // provider token counts ride along in `usage` when present.
        const usage = pickUsage(data.usage);
        sendJson(res, 200, {
          content: message?.content ?? '',
          toolCalls: (message?.tool_calls ?? []).map((t) => ({
            id: t.id,
            name: t.function.name,
            arguments: safeParseToolArguments(t.function.arguments),
          })),
          model: body?.model ?? 'muse-spark-1.3',
          ...(usage ? { usage } : {}),
        });
        return true;
      }
      const upstream = await withUpstreamTimeout(
        fetchFn(`${baseUrl}/v1/responses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'sam-3.1', input: body?.image ?? {} }),
        }),
      );
      if (!upstream.ok) {
        const segStatus = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
        let segDetail = '';
        try {
          segDetail = extractUpstreamErrorMessage(await upstream.json());
        } catch {
          segDetail = '';
        }
        let segMessage = `SAM 3.1 segmentation error: HTTP ${upstream.status}`;
        if (segDetail) segMessage += ` — ${segDetail}`;
        sendJson(res, segStatus, { error: scrubApiKeyFromText(segMessage, apiKey) });
        return true;
      }
      const data = (await upstream.json()) as { masks?: unknown[]; confidence?: number };
      sendJson(res, 200, {
        masks: Array.isArray(data.masks) ? data.masks : [],
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('timed out')) {
        sendJson(res, 504, { error: message });
        return true;
      }
      sendJson(res, 502, { error: message });
      return true;
    }
  }

  sendJson(res, 404, { error: `Unknown Meta proxy endpoint: ${path}` });
  return true;
}

/** Connect-style middleware for `vite.config.ts` (`configureServer`). */
export function createMetaProxyMiddleware(env?: Partial<MetaProxyEnv>) {
  return function metaProxyMiddleware(req: ProxyRequest, res: ProxyResponse, next: ProxyNext): void {
    void handleMetaProxyRequest(req, res, env).then((handled) => {
      if (!handled) next();
    });
  };
}
