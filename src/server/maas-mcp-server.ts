/**
 * TraceForge MaaS — Vite server middleware for MCP 2025-06-18 + MaaS REST.
 *
 * Mounted in `vite.config.ts` alongside `createMetaProxyMiddleware()`.
 * Framework-agnostic minimal request/response shapes keep this unit-testable
 * in Vitest without Node type dependencies.
 *
 * Routes:
 * - POST /api/mcp, POST /mcp — JSON-RPC 2.0 MCP (initialize, ping,
 *   tools/list, tools/call, resources/list, resources/read, prompts/list).
 * - GET /.well-known/oauth-protected-resource — RFC 9728 metadata.
 * - GET /api/maas/status — public read-only service status.
 * - GET /api/maas/catalog — public read-only capability catalog.
 * - GET /api/maas/audit — sanitized audit events (audit:read scope).
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
} from '../maas/protocol';
import { MaasToolError, TraceForgeMaasService, maasErrorStatus } from '../maas/tools';
import { MaasSecurityError } from '../maas/security';
import { KB_VERSION as ASSISTANT_KB_VERSION, handleAssistantChat, issueAssistantSessionTicket } from '../lib/assistant-server';

/** Minimal structural request (covers dev-server requests and test doubles). */
export interface MaasHttpRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?: (event: 'data' | 'end' | 'error', cb: (chunk?: unknown) => void) => void;
}

/** Minimal structural response. */
export interface MaasHttpResponse {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  end?: (body: string) => void;
}

export type MaasHttpNext = () => void;

const MCP_PATHS = new Set(['/api/mcp', '/mcp']);
const OAUTH_METADATA_PATH = '/.well-known/oauth-protected-resource';
const MAAS_STATUS_PATH = '/api/maas/status';
const MAAS_CATALOG_PATH = '/api/maas/catalog';
const MAAS_AUDIT_PATH = '/api/maas/audit';
const ASSISTANT_SESSION_PATH = '/api/assistant/session';
const ASSISTANT_CHAT_PATH = '/api/assistant/chat';

function serverEnv(name: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.[name];
  } catch {
    return undefined;
  }
}

const ALL_MAAS_SCOPES = [
  'traceforge:discovery:read',
  'traceforge:circuits:read',
  'traceforge:scenarios:read',
  'traceforge:scenarios:write',
  'traceforge:measurements:read',
  'traceforge:measurements:execute',
  'traceforge:investigations:read',
  'traceforge:investigations:execute',
  'traceforge:evaluation:score',
  'traceforge:assistant:chat',
  'traceforge:live_inference:execute',
  'traceforge:audit:read',
];

let sharedService: TraceForgeMaasService | undefined;

function defaultService(): TraceForgeMaasService {
  if (!sharedService) sharedService = new TraceForgeMaasService();
  return sharedService;
}

function sendJson(res: MaasHttpResponse, status: number, payload: unknown, correlationId: string): void {
  res.statusCode = status;
  res.setHeader?.('Content-Type', 'application/json');
  res.setHeader?.('X-Correlation-Id', correlationId);
  res.end?.(JSON.stringify(payload));
}

async function readJsonBody(req: MaasHttpRequest): Promise<unknown> {
  if (req.body !== undefined) return req.body;
  if (typeof req.on !== 'function') return undefined;
  const text = await new Promise<string>((resolve, reject) => {
    let acc = '';
    req.on!('data', (chunk) => {
      acc += String(chunk);
      if (acc.length > 1_000_000) reject(new Error('Request body too large.'));
    });
    req.on!('end', () => resolve(acc));
    req.on!('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Malformed JSON body.');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Handle one MCP JSON-RPC call; always sets `X-Correlation-Id`. */
async function handleMcpRpc(
  req: MaasHttpRequest,
  res: MaasHttpResponse,
  service: TraceForgeMaasService,
  correlationId: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: JSON_RPC_VERSION, id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error: malformed JSON body.' } }, correlationId);
    return;
  }
  const rpc = asRecord(body);
  if (!rpc || rpc['jsonrpc'] !== JSON_RPC_VERSION || typeof rpc['method'] !== 'string') {
    sendJson(res, 400, { jsonrpc: JSON_RPC_VERSION, id: (rpc?.['id'] as string | number | null) ?? null, error: { code: JSON_RPC_INVALID_REQUEST, message: 'Invalid Request: expected { jsonrpc: "2.0", id, method }.' } }, correlationId);
    return;
  }
  const request = rpc as unknown as JsonRpcRequest;
  const params = asRecord(request.params) ?? {};
  const headers = req.headers ?? {};

  const ok = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: JSON_RPC_VERSION, id: request.id, result }, correlationId);
  };
  const fail = (code: number, message: string, httpStatus = 400): void => {
    sendJson(res, httpStatus, { jsonrpc: JSON_RPC_VERSION, id: request.id, error: { code, message } }, correlationId);
  };

  switch (request.method) {
    case 'initialize': {
      ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true }, resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'traceforge-maas', version: '0.1.0' },
      });
      return;
    }
    case 'notifications/initialized': {
      ok({});
      return;
    }
    case 'ping': {
      ok({});
      return;
    }
    case 'server/discover': {
      ok({
        serverInfo: { name: 'traceforge-maas', version: '0.1.0' },
        protocolVersion: MCP_PROTOCOL_VERSION,
        tools: service.listCapabilities().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });
      return;
    }
    case 'tools/list': {
      ok({
        tools: service.listCapabilities().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });
      return;
    }
    case 'tools/call': {
      const toolName = params['name'];
      if (typeof toolName !== 'string' || toolName.length === 0) {
        fail(JSON_RPC_INVALID_PARAMS, 'tools/call requires params.name (string).');
        return;
      }
      const toolArgs = asRecord(params['arguments']) ?? {};
      const canonical = normalizeToolName(toolName);
      try {
        const payload = await service.executeTool(canonical, toolArgs, headers);
        ok({
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: false,
        });
      } catch (err) {
        const structured = err instanceof MaasToolError
          ? err.toStructuredError()
          : { code: 'MAAS_EXECUTION_FAILED' as const, message: err instanceof Error ? err.message : String(err), correlationId, capability: toolName };
        ok({
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError: true,
        });
      }
      return;
    }
    case 'resources/list': {
      const catalog = (await service.executeTool('traceforge.circuits.list', {}, headers)) as { boards: Array<{ boardId: string; boardName: string; symptom: string }> };
      ok({
        resources: catalog.boards.map((b) => ({
          uri: `traceforge:///boards/${b.boardId}`,
          name: b.boardName,
          description: b.symptom,
          mimeType: 'application/json',
        })),
      });
      return;
    }
    case 'resources/read': {
      const uri = params['uri'];
      if (typeof uri !== 'string') {
        fail(JSON_RPC_INVALID_PARAMS, 'resources/read requires params.uri (string).');
        return;
      }
      const match = uri.match(/^traceforge:\/\/\/boards\/([A-Za-z0-9_-]+)$/);
      if (!match?.[1]) {
        fail(JSON_RPC_INVALID_PARAMS, `Unknown resource uri '${uri}'.`);
        return;
      }
      try {
        const payload = await service.executeTool('traceforge.circuits.get', { boardId: match[1] }, headers);
        ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload) }] });
      } catch (err) {
        const structured = err instanceof MaasToolError
          ? err.toStructuredError()
          : { code: 'MAAS_EXECUTION_FAILED' as const, message: err instanceof Error ? err.message : String(err), correlationId };
        ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(structured) }], isError: true });
      }
      return;
    }
    case 'prompts/list': {
      ok({
        prompts: [
          { name: 'traceforge.diagnose', description: 'Diagnose a TraceForge reference board from virtual-bench measurements (ground truth withheld).', arguments: [{ name: 'boardId', description: 'Reference board id.', required: true }] },
        ],
      });
      return;
    }
    default:
      fail(JSON_RPC_METHOD_NOT_FOUND, `Method not found: '${request.method}'.`, 404);
  }
}

/**
 * Handle one HTTP request. Returns `true` when the request targeted the MaaS
 * surface (response already sent), `false` when the caller should `next()`.
 */
export async function handleMaasMcpRequest(
  req: MaasHttpRequest,
  res: MaasHttpResponse,
  service: TraceForgeMaasService = defaultService(),
): Promise<boolean> {
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? '';
  const method = (req.method ?? 'GET').toUpperCase();
  const correlationId = createMaasCorrelationId();

  if (method === 'POST' && MCP_PATHS.has(path)) {
    await handleMcpRpc(req, res, service, correlationId);
    return true;
  }
  if (method === 'GET' && path === OAUTH_METADATA_PATH) {
    sendJson(res, 200, {
      resource: '/mcp',
      resource_name: 'TraceForge MaaS',
      authorization_servers: [],
      scopes_supported: ALL_MAAS_SCOPES,
      bearer_methods_supported: ['header'],
      token_endpoint_auth_methods_supported: ['none'],
    }, correlationId);
    return true;
  }
  if (method === 'GET' && path === MAAS_STATUS_PATH) {
    const payload = await service.executeTool('traceforge.system.status', {}, req.headers ?? {});
    sendJson(res, 200, payload, correlationId);
    return true;
  }
  if (method === 'GET' && path === MAAS_CATALOG_PATH) {
    const payload = await service.executeTool('traceforge.capabilities.list', {}, req.headers ?? {});
    sendJson(res, 200, payload, correlationId);
    return true;
  }
  if (method === 'GET' && path === MAAS_AUDIT_PATH) {
    try {
      const context = service.getAuthenticator().authenticate(req.headers ?? {});
      service.getAuthenticator().authorize(context, 'traceforge.audit', 'traceforge:audit:read');
      sendJson(res, 200, { events: service.getAuditLog().getEvents() }, correlationId);
    } catch (err) {
      const code = err instanceof MaasSecurityError ? err.code : 'MAAS_EXECUTION_FAILED';
      sendJson(res, maasErrorStatus(code), { error: { code, message: err instanceof Error ? err.message : String(err), correlationId } }, correlationId);
    }
    return true;
  }
  // TraceForge Assistant (RAG-first, $0.00 knowledge answers; live inference
  // only when fully authorized). The server key stays server-side.
  if ((method === 'GET' || method === 'POST') && path === ASSISTANT_SESSION_PATH) {
    const signingSecret = serverEnv('TRACEFORGE_SESSION_SECRET') ?? serverEnv('META_API_KEY') ?? 'tf-assistant-dev-signing-only';
    const issued = await issueAssistantSessionTicket(signingSecret);
    sendJson(res, 200, {
      sessionTicket: issued.sessionTicket,
      sessionId: issued.sessionId,
      expiresAtMs: issued.expiresAtMs,
      kbVersion: ASSISTANT_KB_VERSION,
    }, correlationId);
    return true;
  }
  if (method === 'POST' && path === ASSISTANT_CHAT_PATH) {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Assistant request body must be valid JSON.' }, correlationId);
      return true;
    }
    const signingSecret = serverEnv('TRACEFORGE_SESSION_SECRET') ?? serverEnv('META_API_KEY') ?? 'tf-assistant-dev-signing-only';
    const handled = await handleAssistantChat({
      service,
      body: body ?? {},
      headers: req.headers ?? {},
      signingSecret,
      apiKey: serverEnv('META_API_KEY'),
    });
    sendJson(res, handled.status, handled.payload, correlationId);
    return true;
  }
  return false;
}

/** Vite `configureServer` middleware mounting the MaaS + MCP surface. */
export function createMaasMcpMiddleware(service?: TraceForgeMaasService): (req: MaasHttpRequest, res: MaasHttpResponse, next: MaasHttpNext) => void {
  const instance = service ?? defaultService();
  return (req, res, next) => {
    handleMaasMcpRequest(req, res, instance).then((handled) => {
      if (!handled) next();
    }).catch(() => {
      try {
        res.statusCode = JSON_RPC_INTERNAL_ERROR;
        res.end?.(JSON.stringify({ error: 'Internal MaaS middleware error.' }));
      } catch {
        next();
      }
    });
  };
}
