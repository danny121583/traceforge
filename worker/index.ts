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

  /**
   * Map a PKCE-issued Bearer token onto the local operator token so the
   * MaaS service authorizes it with operator scopes. Unknown/revoked tokens
   * pass through untouched (the service rejects them honestly).
   */
  function serviceHeaders(request: Request): Record<string, string | string[] | undefined> {
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

  function issueAuthCode(clientId: string, redirectUri: string, scope: string, challenge: string): string {
    const code = randomHex('tf_code', 16);
    authCodes.set(code, {
      challenge,
      redirectUri,
      clientId,
      scope,
      expiresAtMs: clock() + 10 * 60 * 1000,
    });
    return code;
  }

  function validateAuthorizeInput(input: Record<string, string>): { clientId: string; redirectUri: string; state: string; challenge: string; scope: string } | Response {
    const correlationId = createMaasCorrelationId();
    const fail = (description: string): Response => oauthError(400, 'invalid_request', description, correlationId);
    const clientId = input['client_id'] ?? '';
    const redirectUri = input['redirect_uri'] ?? '';
    const challenge = input['code_challenge'] ?? '';
    const method = input['code_challenge_method'] ?? '';
    const client = oauthClients.get(clientId);
    if (!clientId || !client) return fail(`Unknown client_id '${clientId || '(missing)'}': register first via POST /oauth/register.`);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return fail(`redirect_uri '${redirectUri || '(missing)'}' is not registered for this client.`);
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
      const code = issueAuthCode(validated.clientId, validated.redirectUri, validated.scope, validated.challenge);
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
      const code = issueAuthCode(validated.clientId, validated.redirectUri, validated.scope, validated.challenge);
      return jsonResponse(200, { code, state: validated.state, redirect_uri: validated.redirectUri }, correlationId);
    }

    if (method === 'POST' && path === '/oauth/token') {
      const params = await readTokenParams(request);
      if (params['grant_type'] !== 'authorization_code') {
        return oauthError(400, 'unsupported_grant_type', 'Only grant_type=authorization_code is supported.', correlationId);
      }
      const stored = authCodes.get(params['code'] ?? '');
      if (!stored || clock() > stored.expiresAtMs) {
        return oauthError(400, 'invalid_grant', 'Authorization code is unknown or expired.', correlationId);
      }
      if (params['redirect_uri'] && params['redirect_uri'] !== stored.redirectUri) {
        return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorize request.', correlationId);
      }
      const verifier = params['code_verifier'] ?? '';
      if (!verifier || !(await verifyPkceS256(verifier, stored.challenge))) {
        return oauthError(400, 'invalid_grant', 'PKCE S256 code_verifier verification failed.', correlationId);
      }
      authCodes.delete(params['code'] as string);
      const accessToken = randomHex('tf_live');
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
      return handleMcpRpc(body, serviceHeaders(request), correlationId);
    }

    if (method === 'GET' && path === '/api/maas/status') {
      const payload = await service.executeTool('traceforge.system.status', {}, serviceHeaders(request));
      return jsonResponse(200, payload, correlationId);
    }

    if (method === 'GET' && path === '/api/maas/catalog') {
      const payload = await service.executeTool('traceforge.capabilities.list', {}, serviceHeaders(request));
      return jsonResponse(200, payload, correlationId);
    }

    if (method === 'GET' && path === '/api/maas/audit') {
      try {
        const headers = serviceHeaders(request);
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
