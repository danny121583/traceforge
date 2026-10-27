/**
 * TraceForge standalone Cloudflare Worker staging package.
 *
 * `traceforge-mcp-staging` serves the TraceForge MaaS/MCP surface
 * (MCP 2025-06-18 JSON-RPC, OAuth 2.1 PKCE, MaaS REST) from a Worker origin
 * with ZERO Node.js imports — Web Standard `Request` / `Response` / `URL` /
 * `crypto.subtle` only.
 *
 * 100% independent of Health eRecords: no imports outside the TraceForge
 * repository, no shared credentials, no cross-project state. PKCE-issued
 * access tokens map to TraceForge's own local operator scopes only.
 */

import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_VERSION,
  MCP_PROTOCOL_VERSION,
  createMaasCorrelationId,
  normalizeToolName,
  type JsonRpcRequest,
} from '../src/maas/protocol';
import {
  MaasToolError,
  TraceForgeMaasService,
  maasErrorStatus,
} from '../src/maas/tools';
import { MaasSecurityError } from '../src/maas/security';
import {
  META_PROXY_CHAT_PATH,
  META_PROXY_MAX_BODY_BYTES,
  META_PROXY_SEGMENT_PATH,
  META_PROXY_STATUS_PATH,
  PROXY_BODY_TOO_LARGE_MESSAGE,
  PROXY_KEY_MISSING_MESSAGE,
  clampProxyMaxTokens,
  extractUpstreamErrorMessage,
  normalizeProxyMessages,
  normalizeProxyTools,
  resolveProxyEffort,
  safeParseToolArguments,
  scrubApiKeyFromText,
} from '../src/server/meta-proxy';

/** Worker name registered in `wrangler.toml`. */
export const WORKER_NAME = 'traceforge-mcp-staging';
/** Registered MaaS tool count served by this staging worker. */
export const WORKER_TOOL_COUNT = 18;
/** Local operator token that PKCE-issued tokens map to. */
export const WORKER_OPERATOR_TOKEN = 'tf_operator_live_token';
/** Default OAuth scope string minted with PKCE access tokens. */
export const WORKER_DEFAULT_SCOPE = [
  'traceforge:discovery:read',
  'traceforge:scenarios:read',
  'traceforge:scenarios:write',
  'traceforge:measurements:read',
  'traceforge:measurements:execute',
  'traceforge:investigations:read',
  'traceforge:investigations:execute',
  'traceforge:evaluation:score',
  'traceforge:live_inference:execute',
].join(' ');

/** All MaaS scopes advertised in RFC 9728 / RFC 8414 discovery metadata. */
export const WORKER_SCOPES = [
  'traceforge:discovery:read',
  'traceforge:circuits:read',
  'traceforge:scenarios:read',
  'traceforge:scenarios:write',
  'traceforge:measurements:read',
  'traceforge:measurements:execute',
  'traceforge:investigations:read',
  'traceforge:investigations:execute',
  'traceforge:evaluation:score',
  'traceforge:live_inference:execute',
  'traceforge:audit:read',
];

/** Worker bindings (`[vars]` in `wrangler.toml`; all optional at runtime). */
export interface TraceForgeWorkerEnv {
  TRACEFORGE_ENVIRONMENT?: string;
  MCP_PROTOCOL_VERSION?: string;
  [key: string]: string | undefined;
}

export interface TraceForgeWorkerOptions {
  service?: TraceForgeMaasService;
  operatorToken?: string;
  clock?: () => number;
  signingSecret?: string;
}

export interface TraceForgeWorker {
  fetch(request: Request, env?: TraceForgeWorkerEnv): Promise<Response>;
  getService(): TraceForgeMaasService;
  rotateSigningSecret(newSecret: string): void;
}

interface IssuedToken {
  scope: string;
  clientId: string;
  expiresAtMs: number;
}

interface AuthCodeRecord {
  challenge: string;
  redirectUri: string;
  clientId: string;
  scope: string;
  expiresAtMs: number;
}

interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  createdAtMs: number;
}

/* ---------------------------------------------------------------------------
 * Module-level pure helpers (CORS, envelopes, PKCE, header mapping)
 * ------------------------------------------------------------------------- */

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'X-Correlation-Id, MCP-Protocol-Version',
  };
}

function jsonResponse(status: number, payload: unknown, correlationId: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId,
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...corsHeaders(),
    },
  });
}

function emptyResponse(status: number, correlationId: string): Response {
  return new Response(null, {
    status,
    headers: {
      'X-Correlation-Id': correlationId,
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...corsHeaders(),
    },
  });
}

function randomHex(prefix: string, bytes = 24): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let hex = '';
  for (const b of raw) hex += b.toString(16).padStart(2, '0');
  return `${prefix}_${hex}`;
}

/** Verify a PKCE S256 `code_verifier` against the stored `code_challenge`. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const computed = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return computed === challenge;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function incomingHeaders(request: Request): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  request.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/* ---------------------------------------------------------------------------
 * Stateless cross-isolate OAuth signing (Phase 4, hardened)
 *
 * Cloudflare may route `/oauth/authorize`, `/oauth/token`, and `/mcp` to
 * DIFFERENT Worker isolates with disjoint in-memory Maps. To survive that,
 * authorization codes and access tokens are SELF-CONTAINED: the payload
 * (client, redirect, scope, PKCE challenge, expiry) is base64url-embedded in
 * the code/token and authenticated with an HMAC-SHA-256 (`crypto.subtle`)
 * signature keyed by the Worker signing secret
 * (`TRACEFORGE_SESSION_SECRET` || `META_API_KEY` || options.signingSecret
 * || the internal default) — so ANY isolate sharing the secret can verify
 * them without shared state. One-time code consumption is enforced per
 * isolate (`authCodes` map + `consumedStatelessCodes`) AND across colocation
 * isolates via Cloudflare Edge Cache.
 * ------------------------------------------------------------------------- */

/** Internal Worker signing secret (never a user credential, never leaves the Worker). */
const STATELESS_SIGNING_SECRET = 'tf-internal-stateless-oauth-v1::worker-isolate-signing-only';
const STATELESS_CODE_PREFIX = 'tf_code_x.';
const STATELESS_TOKEN_PREFIX = 'tf_live_x.';
/** Edge-cache key prefix for cross-isolate one-time auth-code consumption. */
const EDGE_CACHE_OAUTH_CODE_PREFIX = 'https://traceforge-internal.local/oauth/code/';

function b64urlEncodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeText(b64: string): string {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * HMAC-SHA-256 signature (hex) over the payload segment, keyed by the
 * Worker signing secret (`TRACEFORGE_SESSION_SECRET` || `META_API_KEY` ||
 * options.signingSecret || the internal default).
 */
export async function statelessSign(payloadB64: string, signingSecret?: string): Promise<string> {
  const secret = signingSecret && signingSecret.length > 0 ? signingSecret : STATELESS_SIGNING_SECRET;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`traceforge-stateless-oauth-v2.${payloadB64}`));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 hex digest (used for edge-cache code-consumption keys). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

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

function edgeCachePutJson(key: string, value: unknown): void {
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    const ResponseCtor = (globalThis as { Response?: new (body: string, init: { headers: Record<string, string> }) => unknown }).Response;
    if (!ResponseCtor) return;
    void cache.put(key, new ResponseCtor(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
  } catch {
    // Best-effort only.
  }
}

/* ---------------------------------------------------------------------------
 * Worker factory: one isolated service + OAuth stores per instance
 * ------------------------------------------------------------------------- */

/** Create an isolated TraceForge staging worker (fresh service + OAuth stores). */
export function createTraceForgeWorker(options: TraceForgeWorkerOptions = {}): TraceForgeWorker {
  const service = options.service ?? new TraceForgeMaasService();
  // `options.operatorToken` is retained for backwards compatibility: the
  // legacy `tf_operator_live_token` remains valid via the MaaS local token
  // registry, but PKCE-issued tokens now resolve to per-client actors.
  void options.operatorToken;
  const clock = options.clock ?? Date.now;
  let configuredSigningSecret = options.signingSecret ?? STATELESS_SIGNING_SECRET;
  const issuedTokens = new Map<string, IssuedToken>();
  const authCodes = new Map<string, AuthCodeRecord>();
  const oauthClients = new Map<string, OAuthClientRecord>();
  /** One-time consumption record for self-contained codes redeemed in THIS isolate. */
  const consumedStatelessCodes = new Set<string>();

  /** Resolve the HMAC signing secret for one request (env wins, then options). */
  function resolveSigningSecret(env?: TraceForgeWorkerEnv): string {
    return env?.['TRACEFORGE_SESSION_SECRET']
      || env?.['META_API_KEY']
      || configuredSigningSecret
      || STATELESS_SIGNING_SECRET;
  }

  /** Verify a self-contained access token in ANY isolate (HMAC-SHA-256 + expiry). */
  async function verifyStatelessToken(token: string, signingSecret: string): Promise<IssuedToken | null> {
    if (!token.startsWith(STATELESS_TOKEN_PREFIX)) return null;
    const rest = token.slice(STATELESS_TOKEN_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    if (dot === -1) return null;
    const payloadB64 = rest.slice(0, dot);
    const sig = rest.slice(dot + 1);
    if (!payloadB64 || !sig) return null;
    if ((await statelessSign(payloadB64, signingSecret)) !== sig) return null;
    try {
      const payload = JSON.parse(b64urlDecodeText(payloadB64)) as {
        v?: number; scope?: string; cid?: string; exp?: number;
      };
      if (payload.v !== 1 || typeof payload.scope !== 'string' || typeof payload.exp !== 'number') return null;
      if (clock() > payload.exp) return null;
      return { scope: payload.scope, clientId: typeof payload.cid === 'string' ? payload.cid : 'default', expiresAtMs: payload.exp };
    } catch {
      return null;
    }
  }

  /** Mint a self-contained access token (with client binding) verifiable in ANY isolate. */
  async function mintStatelessToken(scope: string, clientId: string, signingSecret: string): Promise<string> {
    const payloadB64 = b64urlEncodeText(JSON.stringify({
      v: 1,
      scope,
      cid: clientId,
      exp: clock() + 3600 * 1000,
      n: randomHex('tf_n', 8),
    }));
    return `${STATELESS_TOKEN_PREFIX}${payloadB64}.${await statelessSign(payloadB64, signingSecret)}`;
  }

  /** Verify a self-contained authorization code in ANY isolate (signature + expiry + shape). */
  async function verifyStatelessAuthCode(code: string, signingSecret: string): Promise<AuthCodeRecord | null> {
    if (!code.startsWith(STATELESS_CODE_PREFIX)) return null;
    const rest = code.slice(STATELESS_CODE_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    if (dot === -1) return null;
    const payloadB64 = rest.slice(0, dot);
    const sig = rest.slice(dot + 1);
    if (!payloadB64 || !sig) return null;
    if ((await statelessSign(payloadB64, signingSecret)) !== sig) return null;
    try {
      const payload = JSON.parse(b64urlDecodeText(payloadB64)) as {
        v?: number; cid?: string; ruri?: string; scope?: string; ch?: string; exp?: number;
      };
      if (payload.v !== 1 || typeof payload.cid !== 'string' || typeof payload.ruri !== 'string') return null;
      if (typeof payload.scope !== 'string' || typeof payload.ch !== 'string' || typeof payload.exp !== 'number') return null;
      if (clock() > payload.exp) return null;
      return {
        challenge: payload.ch,
        redirectUri: payload.ruri,
        clientId: payload.cid,
        scope: payload.scope,
        expiresAtMs: payload.exp,
      };
    } catch {
      return null;
    }
  }

  /**
   * Register a verified PKCE-issued Bearer token under its own isolated
   * actor (`actor_oauth_<clientId>`) with exactly its granted scopes — never
   * the shared operator token. A revoked token passes through untouched so
   * the service rejects it with `MAAS_CREDENTIALS_REVOKED`; unknown tokens
   * pass through untouched so the service rejects them honestly.
   */
  function registerOAuthToken(token: string, scope: string, clientId: string): Record<string, string> {
    const grantedScopes = scope.split(/\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
    service.getAuthenticator().registerDynamicToken({
      token,
      actorId: `actor_oauth_${clientId || 'default'}`,
      role: grantedScopes.includes('traceforge:live_inference:execute') ? 'owner' : 'agent',
      scopes: grantedScopes,
    });
    return { authorization: `Bearer ${token}`, Authorization: `Bearer ${token}` };
  }

  async function resolveServiceHeaders(request: Request, env?: TraceForgeWorkerEnv): Promise<Record<string, string | string[] | undefined>> {
    const headers = incomingHeaders(request);
    const raw = headers['authorization'] ?? headers['Authorization'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = typeof value === 'string' ? value.match(/^\s*Bearer\s+(\S+)\s*$/i) : null;
    const token = match?.[1];
    if (token) {
      // Revoked tokens pass through untouched: `authenticate()` throws
      // `MAAS_CREDENTIALS_REVOKED` for them.
      if (service.getKillSwitch().isTokenRevoked(token)) return headers;
      const issued = issuedTokens.get(token);
      if (issued && clock() <= issued.expiresAtMs) {
        return { ...headers, ...registerOAuthToken(token, issued.scope, issued.clientId) };
      }
      if (issued) issuedTokens.delete(token);
      // Cross-isolate path: self-contained token verified via HMAC-SHA-256.
      const stateless = await verifyStatelessToken(token, resolveSigningSecret(env));
      if (stateless) {
        return { ...headers, ...registerOAuthToken(token, stateless.scope, stateless.clientId) };
      }
    }
    return headers;
  }

  function oauthError(status: number, error: string, description: string, correlationId: string): Response {
    return jsonResponse(status, { error, error_description: description, correlationId }, correlationId);
  }

  async function readTokenParams(request: Request): Promise<Record<string, string>> {
    const contentType = request.headers.get('content-type') ?? '';
    const params: Record<string, string> = {};
    if (contentType.includes('application/json')) {
      const body = asRecord(await request.json().catch(() => null)) ?? {};
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') params[key] = value;
      }
      return params;
    }
    const text = await request.text();
    for (const [key, value] of new URLSearchParams(text)) params[key] = value;
    return params;
  }

  /**
   * Mint a SELF-CONTAINED authorization code: the payload is embedded and
   * HMAC-SHA-256-signed so `/oauth/token` succeeds even on a different
   * isolate. Also recorded in the isolate-local `authCodes` map so
   * same-isolate exchanges (and one-time consumption) keep working exactly
   * as before.
   */
  async function issueAuthCode(clientId: string, redirectUri: string, scope: string, challenge: string, signingSecret: string): Promise<string> {
    const payloadB64 = b64urlEncodeText(JSON.stringify({
      v: 1,
      cid: clientId,
      ruri: redirectUri,
      scope,
      ch: challenge,
      exp: clock() + 10 * 60 * 1000,
    }));
    const code = `${STATELESS_CODE_PREFIX}${payloadB64}.${await statelessSign(payloadB64, signingSecret)}`;
    authCodes.set(code, {
      challenge,
      redirectUri,
      clientId,
      scope,
      expiresAtMs: clock() + 10 * 60 * 1000,
    });
    return code;
  }

  /** Valid redirect target for unknown (cross-isolate / pre-registered) client ids. */
  function isPermittedRedirectUri(uri: string): boolean {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol === 'https:') return true;
      if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return true;
      return false;
    } catch {
      return false;
    }
  }

  function validateAuthorizeInput(input: Record<string, string>): { clientId: string; redirectUri: string; state: string; challenge: string; scope: string } | Response {
    const correlationId = createMaasCorrelationId();
    const fail = (description: string): Response => oauthError(400, 'invalid_request', description, correlationId);
    const clientId = input['client_id'] ?? '';
    const redirectUri = input['redirect_uri'] ?? '';
    const challenge = input['code_challenge'] ?? '';
    const method = input['code_challenge_method'] ?? '';
    const client = oauthClients.get(clientId);
    if (!clientId) return fail(`Unknown client_id '(missing)': register first via POST /oauth/register.`);
    if (client) {
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        return fail(`redirect_uri '${redirectUri || '(missing)'}' is not registered for this client.`);
      }
    } else {
      // Stateless multi-isolate path: `/oauth/register` may have executed on
      // a different isolate, or the connector uses a pre-registered
      // client_id. Allow any non-empty client_id as long as the redirect
      // target is a valid `https://` (or `http://localhost` /
      // `http://127.0.0.1`) URL.
      if (!isPermittedRedirectUri(redirectUri)) {
        return fail(`redirect_uri '${redirectUri || '(missing)'}' must be a valid https:// (or http://localhost) URL.`);
      }
    }
    if (!challenge) return fail('code_challenge is required (PKCE S256).');
    if (method !== 'S256') return fail(`code_challenge_method must be 'S256', got '${method || '(missing)'}'.`);
    return {
      clientId,
      redirectUri,
      state: input['state'] ?? '',
      challenge,
      scope: input['scope']?.trim() ? input['scope'] : WORKER_DEFAULT_SCOPE,
    };
  }

  async function handleMcpRpc(body: unknown, headers: Record<string, string | string[] | undefined>, correlationId: string): Promise<Response> {
    const rpc = asRecord(body);
    if (!rpc || rpc['jsonrpc'] !== JSON_RPC_VERSION || typeof rpc['method'] !== 'string') {
      return jsonResponse(400, {
        jsonrpc: JSON_RPC_VERSION,
        id: (rpc?.['id'] as string | number | null) ?? null,
        error: { code: JSON_RPC_INVALID_REQUEST, message: 'Invalid Request: expected { jsonrpc: "2.0", id, method }.' },
      }, correlationId);
    }
    const request = rpc as unknown as JsonRpcRequest;
    const params = asRecord(request.params) ?? {};
    const ok = (result: unknown): Response => jsonResponse(200, { jsonrpc: JSON_RPC_VERSION, id: request.id, result }, correlationId);
    const fail = (code: number, message: string): Response => jsonResponse(200, {
      jsonrpc: JSON_RPC_VERSION,
      id: request.id,
      error: { code, message },
    }, correlationId);

    switch (request.method) {
      case 'initialize': {
        return ok({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: WORKER_NAME, version: '0.1.0' },
        });
      }
      case 'notifications/initialized': {
        return emptyResponse(202, correlationId);
      }
      case 'ping': {
        return ok({});
      }
      case 'tools/list': {
        return ok({
          tools: service.listCapabilities().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        });
      }
      case 'tools/call': {
        const toolName = params['name'];
        if (typeof toolName !== 'string' || toolName.length === 0) {
          return fail(JSON_RPC_INVALID_PARAMS, 'tools/call requires params.name (string).');
        }
        const toolArgs = asRecord(params['arguments']) ?? {};
        try {
          const payload = await service.executeTool(normalizeToolName(toolName), toolArgs, headers);
          return ok({
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: false,
          });
        } catch (err) {
          const structured = err instanceof MaasToolError
            ? err.toStructuredError()
            : { code: 'MAAS_EXECUTION_FAILED' as const, message: err instanceof Error ? err.message : String(err), correlationId, capability: toolName };
          return ok({
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
            isError: true,
          });
        }
      }
      case 'resources/list': {
        try {
          const catalog = (await service.executeTool('traceforge.circuits.list', {}, headers)) as {
            boards: Array<{ boardId: string; boardName: string; symptom: string }>;
          };
          return ok({
            resources: catalog.boards.map((b) => ({
              uri: `traceforge:///boards/${b.boardId}`,
              name: b.boardName,
              description: b.symptom,
              mimeType: 'application/json',
            })),
          });
        } catch (err) {
          return fail(JSON_RPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
        }
      }
      case 'resources/read': {
        const uri = params['uri'];
        if (typeof uri !== 'string') {
          return fail(JSON_RPC_INVALID_PARAMS, 'resources/read requires params.uri (string).');
        }
        const match = uri.match(/^traceforge:\/\/\/boards\/([A-Za-z0-9_-]+)$/);
        if (!match?.[1]) {
          return fail(JSON_RPC_INVALID_PARAMS, `Unknown resource uri '${uri}'.`);
        }
        try {
          const payload = await service.executeTool('traceforge.circuits.get', { boardId: match[1] }, headers);
          return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload) }] });
        } catch (err) {
          const structured = err instanceof MaasToolError
            ? err.toStructuredError()
            : { code: 'MAAS_EXECUTION_FAILED' as const, message: err instanceof Error ? err.message : String(err), correlationId };
          return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(structured) }], isError: true });
        }
      }
      case 'prompts/list': {
        return ok({
          prompts: [
            { name: 'traceforge.diagnose', description: 'Diagnose a TraceForge reference board from virtual-bench measurements (ground truth withheld).', arguments: [{ name: 'boardId', description: 'Reference board id.', required: true }] },
          ],
        });
      }
      default:
        return jsonResponse(404, {
          jsonrpc: JSON_RPC_VERSION,
          id: request.id,
          error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Method not found: '${request.method}'.` },
        }, correlationId);
    }
  }

  async function fetch(request: Request, env?: TraceForgeWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const correlationId = createMaasCorrelationId();
    const origin = url.origin;
    const signingSecret = resolveSigningSecret(env);
    // Server-secret wiring: an explicit TRACEFORGE_SESSION_SECRET keys the
    // service AES-256-GCM session tokens; otherwise the live-key derivation
    // inside `configureLiveApiKey` keys them with META_API_KEY.
    if (env?.['TRACEFORGE_SESSION_SECRET']) {
      service.configureSessionSecret(env['TRACEFORGE_SESSION_SECRET'] as string);
    }
    // Live Muse Spark 1.3 wiring: when the Worker environment provides a
    // server-side META_API_KEY, attach it to the MaaS service live client so
    // `mode: "live"` investigations execute against the real upstream.
    if (env?.['META_API_KEY'] && !service.hasLiveClient()) {
      service.configureLiveApiKey(env['META_API_KEY'] as string);
    }

    if (method === 'OPTIONS') {
      return emptyResponse(204, correlationId);
    }

    if (method === 'GET' && path === '/') {
      return jsonResponse(200, {
        worker: WORKER_NAME,
        protocolVersion: MCP_PROTOCOL_VERSION,
        toolCount: WORKER_TOOL_COUNT,
        project: 'TraceForge',
        isolation: 'independent-from-health-erecords',
        endpoints: {
          mcp: `${origin}/mcp`,
          health: `${origin}/health`,
          oauthProtectedResource: `${origin}/.well-known/oauth-protected-resource`,
          oauthAuthorizationServer: `${origin}/.well-known/oauth-authorization-server`,
        },
      }, correlationId);
    }

    if (method === 'GET' && (path === '/mcp' || path === '/api/mcp')) {
      return jsonResponse(200, {
        worker: WORKER_NAME,
        protocolVersion: MCP_PROTOCOL_VERSION,
        transport: 'streamable-http',
        endpoint: `${origin}/mcp`,
        toolCount: WORKER_TOOL_COUNT,
      }, correlationId);
    }

    if (method === 'GET' && path === '/health') {
      return jsonResponse(200, {
        worker: WORKER_NAME,
        protocolVersion: MCP_PROTOCOL_VERSION,
        toolCount: WORKER_TOOL_COUNT,
        project: 'TraceForge',
        isolation: 'independent-from-health-erecords',
        environment: env?.TRACEFORGE_ENVIRONMENT ?? 'staging',
        timestamp: new Date().toISOString(),
      }, correlationId);
    }

    if (method === 'GET' && path === '/.well-known/oauth-protected-resource') {
      return jsonResponse(200, {
        resource: `${origin}/mcp`,
        resource_name: 'TraceForge MaaS',
        authorization_servers: [origin],
        scopes_supported: [...WORKER_SCOPES],
        bearer_methods_supported: ['header'],
        token_endpoint_auth_methods_supported: ['none'],
      }, correlationId);
    }

    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return jsonResponse(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [...WORKER_SCOPES],
      }, correlationId);
    }

    if (method === 'POST' && path === '/oauth/register') {
      let body: unknown = null;
      try {
        body = await request.json();
      } catch {
        return oauthError(400, 'invalid_request', 'POST /oauth/register requires a JSON body.', correlationId);
      }
      const record = asRecord(body) ?? {};
      const redirectUris = record['redirect_uris'];
      if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === 'string')) {
        return oauthError(400, 'invalid_request', 'redirect_uris must be a non-empty string array (RFC 7591).', correlationId);
      }
      const clientId = randomHex('tf_client', 12);
      oauthClients.set(clientId, {
        clientId,
        redirectUris: redirectUris as string[],
        createdAtMs: clock(),
      });
      return jsonResponse(201, {
        client_id: clientId,
        client_secret_expires_at: 0,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }, correlationId);
    }

    if (method === 'GET' && path === '/oauth/authorize') {
      const input: Record<string, string> = {};
      for (const [key, value] of url.searchParams) input[key] = value;
      const validated = validateAuthorizeInput(input);
      if (validated instanceof Response) return validated;
      const code = await issueAuthCode(validated.clientId, validated.redirectUri, validated.scope, validated.challenge, signingSecret);
      const target = new URL(validated.redirectUri);
      target.searchParams.set('code', code);
      if (validated.state) target.searchParams.set('state', validated.state);
      return new Response(null, {
        status: 302,
        headers: {
          Location: target.toString(),
          'X-Correlation-Id': correlationId,
          'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
          ...corsHeaders(),
        },
      });
    }

    if (method === 'POST' && path === '/oauth/authorize') {
      const validated = validateAuthorizeInput(await readTokenParams(request));
      if (validated instanceof Response) return validated;
      const code = await issueAuthCode(validated.clientId, validated.redirectUri, validated.scope, validated.challenge, signingSecret);
      return jsonResponse(200, { code, state: validated.state, redirect_uri: validated.redirectUri }, correlationId);
    }

    if (method === 'POST' && path === '/oauth/token') {
      const params = await readTokenParams(request);
      if (params['grant_type'] !== 'authorization_code') {
        return oauthError(400, 'unsupported_grant_type', 'Only grant_type=authorization_code is supported.', correlationId);
      }
      const codeParam = params['code'] ?? '';
      let stored = authCodes.get(codeParam);
      if (stored && clock() > stored.expiresAtMs) {
        authCodes.delete(codeParam);
        return oauthError(400, 'invalid_grant', 'Authorization code is unknown or expired.', correlationId);
      }
      if (!stored) {
        // Cross-isolate path: the code was minted by `/oauth/authorize` on a
        // different isolate. Verify the self-contained HMAC-SHA-256 signature.
        const stateless = await verifyStatelessAuthCode(codeParam, signingSecret);
        if (!stateless) {
          return oauthError(400, 'invalid_grant', 'Authorization code is unknown or expired.', correlationId);
        }
        if (consumedStatelessCodes.has(codeParam)) {
          return oauthError(400, 'invalid_grant', 'Authorization code has already been redeemed.', correlationId);
        }
        // Cross-isolate replay check: a code redeemed on another isolate in
        // the same colocation is recorded in Cloudflare Edge Cache.
        try {
          const cache = (globalThis as { caches?: { default?: EdgeCacheLike } }).caches?.default;
          if (cache) {
            const hit = await cache.match(`${EDGE_CACHE_OAUTH_CODE_PREFIX}${await sha256Hex(codeParam)}`);
            if (hit) {
              return oauthError(400, 'invalid_grant', 'Authorization code has already been redeemed.', correlationId);
            }
          }
        } catch {
          // Best-effort only: edge persistence must never fail token exchange.
        }
        stored = stateless;
      }
      if (params['redirect_uri'] && params['redirect_uri'] !== stored.redirectUri) {
        return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorize request.', correlationId);
      }
      const verifier = params['code_verifier'] ?? '';
      if (!verifier || !(await verifyPkceS256(verifier, stored.challenge))) {
        return oauthError(400, 'invalid_grant', 'PKCE S256 code_verifier verification failed.', correlationId);
      }
      // One-time consumption: isolate-local (both code generations) AND
      // Cloudflare Edge Cache, so codes cannot be replayed across isolates
      // in the same colocation.
      authCodes.delete(codeParam);
      consumedStatelessCodes.add(codeParam);
      try {
        edgeCachePutJson(`${EDGE_CACHE_OAUTH_CODE_PREFIX}${await sha256Hex(codeParam)}`, { consumed: true, at: new Date().toISOString() });
      } catch {
        // Best-effort only.
      }
      const accessToken = await mintStatelessToken(stored.scope, stored.clientId, signingSecret);
      issuedTokens.set(accessToken, { scope: stored.scope, clientId: stored.clientId, expiresAtMs: clock() + 3600 * 1000 });
      return jsonResponse(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: stored.scope,
      }, correlationId);
    }

    if (method === 'POST' && (path === '/mcp' || path === '/api/mcp')) {
      let body: unknown = null;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, {
          jsonrpc: JSON_RPC_VERSION,
          id: null,
          error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error: malformed JSON body.' },
        }, correlationId);
      }
      return handleMcpRpc(body, await resolveServiceHeaders(request, env), correlationId);
    }

    if (method === 'GET' && path === '/api/maas/status') {
      const payload = await service.executeTool('traceforge.system.status', {}, await resolveServiceHeaders(request, env));
      return jsonResponse(200, payload, correlationId);
    }

    if (method === 'GET' && path === '/api/maas/catalog') {
      const payload = await service.executeTool('traceforge.capabilities.list', {}, await resolveServiceHeaders(request, env));
      return jsonResponse(200, payload, correlationId);
    }

    if (method === 'GET' && path === '/api/maas/audit') {
      try {
        const headers = await resolveServiceHeaders(request, env);
        const context = service.getAuthenticator().authenticate(headers);
        service.getAuthenticator().authorize(context, 'traceforge.audit', 'traceforge:audit:read');
        return jsonResponse(200, { events: service.getAuditLog().getEvents() }, correlationId);
      } catch (err) {
        const code = err instanceof MaasSecurityError ? err.code : 'MAAS_EXECUTION_FAILED';
        return jsonResponse(maasErrorStatus(code), {
          error: { code, message: err instanceof Error ? err.message : String(err), correlationId },
        }, correlationId);
      }
    }

    // Browser-facing Meta proxy: the Vercel frontend rewrites `/api/meta/*`
    // here. `META_API_KEY` stays server-side; the browser never sees it.
    if (method === 'GET' && path === META_PROXY_STATUS_PATH) {
      return jsonResponse(200, {
        configured: service.hasLiveClient(),
        mode: service.hasLiveClient() ? (service.isLiveVerified() ? 'LIVE_API' : 'UNVERIFIED') : 'UNAVAILABLE',
      }, correlationId);
    }

    if (method === 'POST' && path === META_PROXY_CHAT_PATH) {
      if (service.getKillSwitch().isGlobalKillActive()) {
        return jsonResponse(503, { error: `Meta proxy unavailable: ${service.getKillSwitch().getGlobalKillReason() ?? 'operator halt'}.` }, correlationId);
      }
      try {
        service.getRateLimiter().check('browser-meta-proxy');
      } catch (err) {
        return jsonResponse(429, { error: err instanceof Error ? err.message : String(err) }, correlationId);
      }
      if (service.isBudgetSafetyBreached()) {
        return jsonResponse(429, { error: 'Live inference blocked: spend reached the $95.00 safety threshold (see traceforge.budget.status).' }, correlationId);
      }
      const apiKey = env?.['META_API_KEY'];
      if (!apiKey) {
        return jsonResponse(503, { error: PROXY_KEY_MISSING_MESSAGE }, correlationId);
      }
      let rawText = '';
      try {
        rawText = await request.text();
      } catch {
        return jsonResponse(400, { error: 'Meta proxy could not read the request body.' }, correlationId);
      }
      if (rawText.length > META_PROXY_MAX_BODY_BYTES) {
        return jsonResponse(413, { error: PROXY_BODY_TOO_LARGE_MESSAGE }, correlationId);
      }
      let proxyBody: Record<string, unknown>;
      try {
        proxyBody = (rawText ? JSON.parse(rawText) : {}) as Record<string, unknown>;
      } catch {
        return jsonResponse(400, { error: 'Meta proxy request body must be valid JSON.' }, correlationId);
      }
      const maxTokens = clampProxyMaxTokens(proxyBody['maxTokens']);
      const normalizedTools = normalizeProxyTools(proxyBody['tools']);
      const normalizedMessages = normalizeProxyMessages(proxyBody['messages'] ?? []);
      const effort = resolveProxyEffort(proxyBody as { effort?: string; reasoning_effort?: string; reasoning?: { effort?: string } });
      let upstream: Response;
      try {
        upstream = await globalThis.fetch('https://api.meta.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: typeof proxyBody['model'] === 'string' ? proxyBody['model'] : 'muse-spark-1.3',
            messages: normalizedMessages,
            ...(normalizedTools ? { tools: normalizedTools } : {}),
            ...(proxyBody['responseFormat'] === 'json' ? { response_format: { type: 'json_object' } } : {}),
            ...(effort ? { reasoning_effort: effort } : {}),
            max_tokens: maxTokens,
          }),
        });
      } catch (err) {
        return jsonResponse(502, { error: scrubApiKeyFromText(err instanceof Error ? err.message : String(err), apiKey) }, correlationId);
      }
      if (!upstream.ok) {
        const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
        let detail = '';
        try {
          detail = extractUpstreamErrorMessage(await upstream.json());
        } catch {
          detail = '';
        }
        let message = `Meta Model API error: HTTP ${upstream.status}`;
        if (detail) message += ` — ${detail}`;
        return jsonResponse(status, { error: scrubApiKeyFromText(message, apiKey) }, correlationId);
      }
      const data = (await upstream.json()) as {
        choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: unknown } }> } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const message = data.choices?.[0]?.message;
      const promptTokens = typeof data.usage?.prompt_tokens === 'number' && Number.isFinite(data.usage.prompt_tokens)
        ? Math.max(0, Math.floor(data.usage.prompt_tokens))
        : Math.ceil(JSON.stringify(normalizedMessages).length / 4);
      const completionTokens = typeof data.usage?.completion_tokens === 'number' && Number.isFinite(data.usage.completion_tokens)
        ? Math.max(0, Math.floor(data.usage.completion_tokens))
        : Math.ceil((message?.content ?? '').length / 4);
      service.recordExternalLiveUsage({
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        providerReported: typeof data.usage?.prompt_tokens === 'number' && typeof data.usage?.completion_tokens === 'number',
      });
      return jsonResponse(200, {
        content: scrubApiKeyFromText(message?.content ?? '', apiKey),
        toolCalls: (message?.tool_calls ?? []).map((t) => ({
          id: t.id,
          name: t.function.name,
          arguments: safeParseToolArguments(t.function.arguments),
        })),
        model: typeof proxyBody['model'] === 'string' ? proxyBody['model'] : 'muse-spark-1.3',
        ...(data.usage ? { usage: data.usage } : {}),
      }, correlationId);
    }

    if (method === 'POST' && path === META_PROXY_SEGMENT_PATH) {
      const apiKey = env?.['META_API_KEY'];
      if (!apiKey) {
        return jsonResponse(503, { error: PROXY_KEY_MISSING_MESSAGE }, correlationId);
      }
      let segText = '';
      try {
        segText = await request.text();
      } catch {
        return jsonResponse(400, { error: 'Meta proxy could not read the request body.' }, correlationId);
      }
      if (segText.length > META_PROXY_MAX_BODY_BYTES) {
        return jsonResponse(413, { error: PROXY_BODY_TOO_LARGE_MESSAGE }, correlationId);
      }
      let segBody: { image?: unknown };
      try {
        segBody = (segText ? JSON.parse(segText) : {}) as { image?: unknown };
      } catch {
        return jsonResponse(400, { error: 'Meta proxy request body must be valid JSON.' }, correlationId);
      }
      let segUpstream: Response;
      try {
        segUpstream = await globalThis.fetch('https://api.meta.ai/v1/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'sam-3.1', input: segBody.image ?? {} }),
        });
      } catch (err) {
        return jsonResponse(502, { error: scrubApiKeyFromText(err instanceof Error ? err.message : String(err), apiKey) }, correlationId);
      }
      if (!segUpstream.ok) {
        const segStatus = segUpstream.status >= 400 && segUpstream.status <= 599 ? segUpstream.status : 502;
        let segDetail = '';
        try {
          segDetail = extractUpstreamErrorMessage(await segUpstream.json());
        } catch {
          segDetail = '';
        }
        let segMessage = `SAM 3.1 segmentation error: HTTP ${segUpstream.status}`;
        if (segDetail) segMessage += ` — ${segDetail}`;
        return jsonResponse(segStatus, { error: scrubApiKeyFromText(segMessage, apiKey) }, correlationId);
      }
      const segData = (await segUpstream.json()) as { masks?: unknown[]; confidence?: number };
      return jsonResponse(200, {
        masks: Array.isArray(segData.masks) ? segData.masks : [],
        confidence: typeof segData.confidence === 'number' ? segData.confidence : 0,
      }, correlationId);
    }

    return jsonResponse(404, { error: { code: 'MAAS_RESOURCE_NOT_FOUND', message: `Unknown worker path '${path}'.`, correlationId } }, correlationId);
  }

  return {
    fetch,
    getService: () => service,
    rotateSigningSecret: (newSecret: string): void => {
      if (newSecret && newSecret.length > 0) configuredSigningSecret = newSecret;
    },
  };
}

let sharedWorker: TraceForgeWorker | undefined;

function shared(): TraceForgeWorker {
  if (!sharedWorker) sharedWorker = createTraceForgeWorker();
  return sharedWorker;
}

/** Default Cloudflare Worker entrypoint (`wrangler.toml` `main`). */
export default {
  fetch(request: Request, env?: TraceForgeWorkerEnv): Promise<Response> {
    return shared().fetch(request, env);
  },
};
