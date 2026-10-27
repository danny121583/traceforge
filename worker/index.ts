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
}

export interface TraceForgeWorker {
  fetch(request: Request, env?: TraceForgeWorkerEnv): Promise<Response>;
  getService(): TraceForgeMaasService;
}

interface IssuedToken {
  scope: string;
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
 * Stateless cross-isolate OAuth signing (Phase 4)
 *
 * Cloudflare may route `/oauth/authorize`, `/oauth/token`, and `/mcp` to
 * DIFFERENT Worker isolates with disjoint in-memory Maps. To survive that,
 * authorization codes and access tokens are SELF-CONTAINED: the payload
 * (client, redirect, scope, PKCE challenge, expiry) is base64url-embedded in
 * the code/token and authenticated with a SHA-256 (`crypto.subtle`) signature
 * over a module-level internal Worker secret — so ANY isolate running this
 * Worker source can verify them without shared state. One-time code
 * consumption is still enforced per isolate (`authCodes` map + the
 * `consumedStatelessCodes` set below).
 * ------------------------------------------------------------------------- */

/** Internal Worker signing secret (never a user credential, never leaves the Worker). */
const STATELESS_SIGNING_SECRET = 'tf-internal-stateless-oauth-v1::worker-isolate-signing-only';
const STATELESS_CODE_PREFIX = 'tf_code_x.';
const STATELESS_TOKEN_PREFIX = 'tf_live_x.';

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

/** SHA-256 signature (hex) over the internal secret + payload segment. */
async function statelessSign(payloadB64: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${STATELESS_SIGNING_SECRET}.${payloadB64}`),
  );
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/* ---------------------------------------------------------------------------
 * Worker factory: one isolated service + OAuth stores per instance
 * ------------------------------------------------------------------------- */

/** Create an isolated TraceForge staging worker (fresh service + OAuth stores). */
export function createTraceForgeWorker(options: TraceForgeWorkerOptions = {}): TraceForgeWorker {
  const service = options.service ?? new TraceForgeMaasService();
  const operatorToken = options.operatorToken ?? WORKER_OPERATOR_TOKEN;
  const clock = options.clock ?? Date.now;
  const issuedTokens = new Map<string, IssuedToken>();
  const authCodes = new Map<string, AuthCodeRecord>();
  const oauthClients = new Map<string, OAuthClientRecord>();
  /** One-time consumption record for self-contained codes redeemed in THIS isolate. */
  const consumedStatelessCodes = new Set<string>();

  /** Verify a self-contained access token in ANY isolate (stateless SHA-256 signature + expiry). */
  async function verifyStatelessToken(token: string): Promise<IssuedToken | null> {
    if (!token.startsWith(STATELESS_TOKEN_PREFIX)) return null;
    const rest = token.slice(STATELESS_TOKEN_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    if (dot === -1) return null;
    const payloadB64 = rest.slice(0, dot);
    const sig = rest.slice(dot + 1);
    if (!payloadB64 || !sig) return null;
    if ((await statelessSign(payloadB64)) !== sig) return null;
    try {
      const payload = JSON.parse(b64urlDecodeText(payloadB64)) as {
        v?: number; scope?: string; exp?: number;
      };
      if (payload.v !== 1 || typeof payload.scope !== 'string' || typeof payload.exp !== 'number') return null;
      if (clock() > payload.exp) return null;
      return { scope: payload.scope, expiresAtMs: payload.exp };
    } catch {
      return null;
    }
  }

  /** Mint a self-contained access token verifiable in ANY isolate. */
  async function mintStatelessToken(scope: string): Promise<string> {
    const payloadB64 = b64urlEncodeText(JSON.stringify({
      v: 1,
      scope,
      exp: clock() + 3600 * 1000,
      n: randomHex('tf_n', 8),
    }));
    return `${STATELESS_TOKEN_PREFIX}${payloadB64}.${await statelessSign(payloadB64)}`;
  }

  /** Verify a self-contained authorization code in ANY isolate (signature + expiry + shape). */
  async function verifyStatelessAuthCode(code: string): Promise<AuthCodeRecord | null> {
    if (!code.startsWith(STATELESS_CODE_PREFIX)) return null;
    const rest = code.slice(STATELESS_CODE_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    if (dot === -1) return null;
    const payloadB64 = rest.slice(0, dot);
    const sig = rest.slice(dot + 1);
    if (!payloadB64 || !sig) return null;
    if ((await statelessSign(payloadB64)) !== sig) return null;
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
   * Map a PKCE-issued Bearer token onto the local operator token so the
   * MaaS service authorizes it with operator scopes. Unknown/revoked tokens
   * pass through untouched (the service rejects them honestly).
   */
  async function resolveServiceHeaders(request: Request): Promise<Record<string, string | string[] | undefined>> {
    const headers = incomingHeaders(request);
    const raw = headers['authorization'] ?? headers['Authorization'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = typeof value === 'string' ? value.match(/^\s*Bearer\s+(\S+)\s*$/i) : null;
    const token = match?.[1];
    if (token) {
      const issued = issuedTokens.get(token);
      if (issued && clock() <= issued.expiresAtMs) {
        return { ...headers, authorization: `Bearer ${operatorToken}`, Authorization: `Bearer ${operatorToken}` };
      }
      if (issued) issuedTokens.delete(token);
      // Cross-isolate path: self-contained token verified via SHA-256 (`crypto.subtle`).
      const stateless = await verifyStatelessToken(token);
      if (stateless) {
        return { ...headers, authorization: `Bearer ${operatorToken}`, Authorization: `Bearer ${operatorToken}` };
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
   * SHA-256-signed so `/oauth/token` succeeds even on a different isolate.
   * Also recorded in the isolate-local `authCodes` map so same-isolate
   * exchanges (and one-time consumption) keep working exactly as before.
   */
  async function issueAuthCode(clientId: string, redirectUri: string, scope: string, challenge: string): Promise<string> {
    const payloadB64 = b64urlEncodeText(JSON.stringify({
      v: 1,
      cid: clientId,
      ruri: redirectUri,
      scope,
      ch: challenge,
      exp: clock() + 10 * 60 * 1000,
    }));
    const code = `${STATELESS_CODE_PREFIX}${payloadB64}.${await statelessSign(payloadB64)}`;
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
      scope: input['scope'] ?? WORKER_DEFAULT_SCOPE,
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
      const code = await issueAuthCode(validated.clientId, validated.redirectUri, validated.scope, validated.challenge);
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
      const code = await issueAuthCode(validated.clientId, validated.redirectUri, validated.scope, validated.challenge);
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
        // different isolate. Verify the self-contained SHA-256 signature.
        const stateless = await verifyStatelessAuthCode(codeParam);
        if (!stateless) {
          return oauthError(400, 'invalid_grant', 'Authorization code is unknown or expired.', correlationId);
        }
        if (consumedStatelessCodes.has(codeParam)) {
          return oauthError(400, 'invalid_grant', 'Authorization code has already been redeemed.', correlationId);
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
      // One-time consumption within this isolate (both code generations).
      authCodes.delete(codeParam);
      consumedStatelessCodes.add(codeParam);
      const accessToken = await mintStatelessToken(stored.scope);
      issuedTokens.set(accessToken, { scope: stored.scope, expiresAtMs: clock() + 3600 * 1000 });
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
      return handleMcpRpc(body, await resolveServiceHeaders(request), correlationId);
    }

    if (method === 'GET' && path === '/api/maas/status') {
      const payload = await service.executeTool('traceforge.system.status', {}, await resolveServiceHeaders(request));
      return jsonResponse(200, payload, correlationId);
    }

    if (method === 'GET' && path === '/api/maas/catalog') {
      const payload = await service.executeTool('traceforge.capabilities.list', {}, await resolveServiceHeaders(request));
      return jsonResponse(200, payload, correlationId);
    }

    if (method === 'GET' && path === '/api/maas/audit') {
      try {
        const headers = await resolveServiceHeaders(request);
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

    return jsonResponse(404, { error: { code: 'MAAS_RESOURCE_NOT_FOUND', message: `Unknown worker path '${path}'.`, correlationId } }, correlationId);
  }

  return {
    fetch,
    getService: () => service,
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
