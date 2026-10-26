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
  messages?: Array<{ role: string; content: string }>;
  tools?: unknown[];
  responseFormat?: 'text' | 'json';
  effort?: string;
  maxTokens?: number;
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
  const apiKey = env?.getApiKey ? env.getApiKey() : readApiKeyFromServerEnv();
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
        const upstream = await withUpstreamTimeout(
          fetchFn(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: body?.model ?? 'muse-spark-1.3',
              messages: body?.messages ?? [],
              ...(body?.tools ? { tools: body.tools } : {}),
              ...(body?.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
              ...(body?.effort ? { reasoning: { effort: body.effort } } : {}),
              max_tokens: maxTokens,
            }),
          }),
        );
        if (!upstream.ok) {
          sendJson(res, 502, { error: `Meta Model API error: HTTP ${upstream.status}` });
          return true;
        }
        const data = (await upstream.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
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
            arguments: JSON.parse(t.function.arguments || '{}'),
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
        sendJson(res, 502, { error: `SAM 3.1 segmentation error: HTTP ${upstream.status}` });
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
