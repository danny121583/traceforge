/**
 * TraceForge standalone Cloudflare Worker staging package tests.
 *
 * Exercises the Worker's `fetch(request, env)` handler across health, CORS,
 * RFC 9728 / RFC 8414 discovery metadata, RFC 7591 dynamic client
 * registration + OAuth 2.1 PKCE S256 token exchange, authenticated MCP tool
 * calls using the PKCE-issued access token, kill switch, and cross-tenant
 * isolation — plus a static guard that `worker/index.ts` carries zero
 * Node.js built-in imports.
 */
import { afterEach, describe, expect, it } from 'vitest';
import workerDefault, {
  TRACEFORGE_STATE_DO_NAME,
  TraceForgeStateDO,
  WORKER_DEFAULT_SCOPE,
  createTraceForgeWorker,
  verifyPkceS256,
} from '../worker/index';
import type { TraceForgeWorkerEnv } from '../worker/index';
import { MetaClient } from '../src/lib/meta-client';
import { TraceForgeMaasService } from '../src/maas/tools';
import workerSource from '../worker/index.ts?raw';

const ORIGIN = 'https://traceforge-mcp-staging.workers.dev';
const AGENT = 'Bearer tf_agent_local_token';
const SECONDARY = 'Bearer tf_agent_secondary_token';

function workerUrl(path: string): string {
  return `${ORIGIN}${path}`;
}

async function readJson(res: Response): Promise<unknown> {
  expect(res.headers.get('Content-Type')).toContain('application/json');
  return (await res.json()) as unknown;
}

/** Compute a PKCE S256 challenge the same way the Worker verifies it. */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
}

async function registerClient(path = '/oauth/register'): Promise<{ worker: ReturnType<typeof createTraceForgeWorker>; client: RegisteredClient }> {
  const worker = createTraceForgeWorker();
  const res = await worker.fetch(
    new Request(workerUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [`${ORIGIN}/callback`], grant_types: ['authorization_code'] }),
    }),
  );
  expect(res.status).toBe(201);
  const client = (await readJson(res)) as RegisteredClient;
  return { worker, client };
}

async function fullPkceToken(params: {
  worker: ReturnType<typeof createTraceForgeWorker>;
  client: RegisteredClient;
  verifier?: string;
  asJson?: boolean;
}): Promise<{ accessToken: string; scope: string }> {
  const verifier = params.verifier ?? 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = await pkceChallenge(verifier);
  const redirectUri = params.client.redirect_uris[0] as string;
  const state = 'st_test_123';
  const authorizeUrl =
    `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent(params.client.client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
  const authorized = await params.worker.fetch(new Request(authorizeUrl, { method: 'GET' }));
  expect(authorized.status).toBe(302);
  const location = authorized.headers.get('Location') ?? '';
  const code = new URL(location).searchParams.get('code') ?? '';
  expect(code.length).toBeGreaterThan(0);

  const tokenBody = params.asJson
    ? JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier })
    : new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }).toString();
  const tokenRes = await params.worker.fetch(
    new Request(workerUrl('/oauth/token'), {
      method: 'POST',
      headers: { 'Content-Type': params.asJson ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: tokenBody,
    }),
  );
  expect(tokenRes.status).toBe(200);
  const token = (await readJson(tokenRes)) as { access_token: string; token_type: string; expires_in: number; scope: string };
  return { accessToken: token.access_token, scope: token.scope };
}

async function mcpCall(
  worker: ReturnType<typeof createTraceForgeWorker>,
  method: string,
  params: Record<string, unknown>,
  auth?: string,
): Promise<{ status: number; envelope: Record<string, unknown>; res: Response }> {
  const res = await worker.fetch(
    new Request(workerUrl('/mcp'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const envelope = (await readJson(res)) as Record<string, unknown>;
  return { status: res.status, envelope, res };
}

describe('worker health and CORS', () => {
  it('GET /health reports the staging worker identity and isolation', async () => {
    const worker = createTraceForgeWorker();
    const res = await worker.fetch(new Request(workerUrl('/health')));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body['worker']).toBe('traceforge-mcp-staging');
    expect(body['protocolVersion']).toBe('2025-06-18');
    expect(body['toolCount']).toBe(25);
    expect(body['project']).toBe('TraceForge');
    expect(body['isolation']).toBe('independent-from-health-erecords');
  });

  it('answers CORS preflight with 204 and exposes correlation/protocol headers', async () => {
    const worker = createTraceForgeWorker();
    const preflight = await worker.fetch(new Request(workerUrl('/mcp'), { method: 'OPTIONS' }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const exposed = preflight.headers.get('Access-Control-Expose-Headers') ?? '';
    expect(exposed).toContain('X-Correlation-Id');
    expect(exposed).toContain('MCP-Protocol-Version');

    const health = await worker.fetch(new Request(workerUrl('/health')));
    expect(health.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(health.headers.get('X-Correlation-Id')).toMatch(/^tf_corr_/);
  });
});

describe('RFC 9728 / RFC 8414 discovery metadata', () => {
  it('serves RFC 9728 protected-resource metadata pointing at the Worker origin', async () => {
    const worker = createTraceForgeWorker();
    const res = await worker.fetch(new Request(workerUrl('/.well-known/oauth-protected-resource')));
    expect(res.status).toBe(200);
    const meta = (await readJson(res)) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(meta.resource).toBe(`${ORIGIN}/mcp`);
    expect(meta.authorization_servers).toContain(ORIGIN);
    expect(meta.scopes_supported).toContain('traceforge:live_inference:execute');
    expect(meta.bearer_methods_supported).toContain('header');
  });

  it('serves RFC 8414 authorization-server metadata with S256 PKCE', async () => {
    const worker = createTraceForgeWorker();
    const res = await worker.fetch(new Request(workerUrl('/.well-known/oauth-authorization-server')));
    expect(res.status).toBe(200);
    const meta = (await readJson(res)) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(meta.code_challenge_methods_supported).toContain('S256');
  });
});

describe('RFC 7591 registration + OAuth 2.1 PKCE S256 exchange', () => {
  it('registers a dynamic client with token_endpoint_auth_method none', async () => {
    const { client } = await registerClient();
    expect(client.client_id.length).toBeGreaterThan(0);
    expect(client.redirect_uris).toHaveLength(1);
    expect(client.grant_types).toContain('authorization_code');
    expect(client.token_endpoint_auth_method).toBe('none');
  });

  it('verifies PKCE S256 with crypto.subtle (RFC 7636 test vector shape)', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await pkceChallenge(verifier);
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    expect(await verifyPkceS256('wrong-verifier', challenge)).toBe(false);
  });

  it('GET /oauth/authorize redirects with code+state; form token exchange mints a Bearer token', async () => {
    const { worker, client } = await registerClient();
    const { accessToken, scope } = await fullPkceToken({ worker, client });
    expect(accessToken.length).toBeGreaterThan(0);
    expect(scope).toContain('traceforge:investigations:execute');
  });

  it('POST /oauth/authorize returns JSON code; JSON token exchange also works', async () => {
    const { worker, client } = await registerClient();
    const verifier = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const challenge = await pkceChallenge(verifier);
    const redirectUri = client.redirect_uris[0] as string;
    const authorizeRes = await worker.fetch(
      new Request(workerUrl('/oauth/authorize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          state: 'json_state',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      }),
    );
    expect(authorizeRes.status).toBe(200);
    const authorized = (await readJson(authorizeRes)) as { code: string; state: string; redirect_uri: string };
    expect(authorized.code.length).toBeGreaterThan(0);
    expect(authorized.state).toBe('json_state');
    expect(authorized.redirect_uri).toBe(redirectUri);

    const tokenRes = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: authorized.code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const token = (await readJson(tokenRes)) as { access_token: string; token_type: string; expires_in: number };
    expect(token.token_type).toBe('Bearer');
    expect(token.expires_in).toBe(3600);
    expect(token.access_token.length).toBeGreaterThan(0);
  });

  it('rejects a wrong code_verifier with invalid_grant', async () => {
    const { worker, client } = await registerClient();
    const verifier = 'correct-verifier-000000000000000000000001';
    const challenge = await pkceChallenge(verifier);
    const redirectUri = client.redirect_uris[0] as string;
    const authorized = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent(client.client_id)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
        { method: 'GET' },
      ),
    );
    const code = new URL(authorized.headers.get('Location') ?? '').searchParams.get('code') ?? '';
    const tokenRes = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: 'wrong-verifier-000000000000000000000002',
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(400);
    expect(((await readJson(tokenRes)) as { error: string }).error).toBe('invalid_grant');
  });
});

describe('authenticated MCP over the Worker', () => {
  it('serves initialize, ping, tools/list, resources/list, resources/read, prompts/list', async () => {
    const worker = createTraceForgeWorker();
    const init = await mcpCall(worker, 'initialize', {});
    expect(init.status).toBe(200);
    expect((init.envelope['result'] as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');

    const ping = await mcpCall(worker, 'ping', {});
    expect((ping.envelope['result'] as Record<string, unknown>)).toEqual({});

    const listed = await mcpCall(worker, 'tools/list', {});
    expect((listed.envelope['result'] as { tools: unknown[] }).tools).toHaveLength(25);

    const resources = await mcpCall(worker, 'resources/list', {});
    expect((resources.envelope['result'] as { resources: unknown[] }).resources).toHaveLength(3);

    const read = await mcpCall(worker, 'resources/read', { uri: 'traceforge:///boards/f405-flight-controller' });
    const contents = (read.envelope['result'] as { contents: Array<{ text: string }> }).contents;
    expect(contents[0]?.text).toContain('f405-flight-controller');

    const prompts = await mcpCall(worker, 'prompts/list', {});
    expect((prompts.envelope['result'] as { prompts: Array<{ name: string }> }).prompts[0]?.name).toBe('traceforge.diagnose');
  });

  it('runs a full MaaS flow with the PKCE-issued access token', async () => {
    const { worker, client } = await registerClient();
    const { accessToken } = await fullPkceToken({ worker, client, asJson: true });
    const auth = `Bearer ${accessToken}`;

    const created = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.scenarios.create',
      arguments: { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
    }, auth);
    const payload = (created.envelope['result'] as { structuredContent: { scenarioId: string } }).structuredContent;
    expect(payload.scenarioId.startsWith('scn_')).toBe(true);

    const measured = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.measurements.voltage',
      arguments: { scenarioId: payload.scenarioId, node: 'U1-14' },
    }, auth);
    expect((measured.envelope['result'] as { structuredContent: { probesUsed: number } }).structuredContent.probesUsed).toBe(1);

    const started = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.investigations.start',
      arguments: { scenarioId: payload.scenarioId },
    }, auth);
    expect((started.envelope['result'] as { structuredContent: { completed: boolean } }).structuredContent.completed).toBe(true);

    const scored = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.evaluation.score',
      arguments: { scenarioId: payload.scenarioId },
    }, auth);
    expect(
      (scored.envelope['result'] as { structuredContent: { score: { totalScore: number } | null } }).structuredContent.score,
    ).toBeTruthy();
  });

  it('rejects unauthenticated protected calls and serves status/catalog/audit', async () => {
    const worker = createTraceForgeWorker();
    const denied = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.scenarios.create',
      arguments: { boardId: 'f405-flight-controller' },
    });
    const structured = (denied.envelope['result'] as { structuredContent: { code: string }; isError: boolean });
    expect(structured.isError).toBe(true);
    expect(structured.structuredContent.code).toBe('MAAS_AUTHENTICATION_REQUIRED');

    const status = await worker.fetch(new Request(workerUrl('/api/maas/status')));
    expect(status.status).toBe(200);
    expect(((await readJson(status)) as { service: string }).service).toBe('traceforge-maas');

    const catalog = await worker.fetch(new Request(workerUrl('/api/maas/catalog')));
    expect(((await readJson(catalog)) as { count: number }).count).toBe(25);

    const anonymousAudit = await worker.fetch(new Request(workerUrl('/api/maas/audit')));
    expect(anonymousAudit.status).toBe(401);
  });
});

describe('worker kill switch and cross-tenant isolation', () => {
  it('halts tools/call under the global kill switch and releases cleanly', async () => {
    const worker = createTraceForgeWorker();
    worker.getService().getKillSwitch().setGlobalKillSwitch(true, 'staging test halt');
    const halted = await mcpCall(worker, 'tools/call', { name: 'traceforge.system.status', arguments: {} });
    expect(
      (halted.envelope['result'] as { structuredContent: { code: string }; isError: boolean }).structuredContent.code,
    ).toBe('MAAS_KILL_SWITCH_ACTIVE');
    worker.getService().getKillSwitch().setGlobalKillSwitch(false);
    const released = await mcpCall(worker, 'tools/call', { name: 'traceforge.system.status', arguments: {} });
    expect(
      (released.envelope['result'] as { structuredContent: { service: string } }).structuredContent.service,
    ).toBe('traceforge-maas');
  });

  it('blocks cross-tenant scenario access through the Worker', async () => {
    const worker = createTraceForgeWorker();
    const created = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.scenarios.create',
      arguments: { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
    }, AGENT);
    const scenarioId = (created.envelope['result'] as { structuredContent: { scenarioId: string } }).structuredContent.scenarioId;
    const crossed = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.measurements.voltage',
      arguments: { scenarioId, node: 'U1-14' },
    }, SECONDARY);
    expect(
      (crossed.envelope['result'] as { structuredContent: { code: string }; isError: boolean }).structuredContent.code,
    ).toBe('MAAS_CROSS_TENANT_ACCESS_DENIED');
  });
});

describe('Phase 4: root and MCP discovery endpoints', () => {
  it('GET / returns the worker identity, protocol, tool count, and endpoints', async () => {
    const worker = createTraceForgeWorker();
    const res = await worker.fetch(new Request(workerUrl('/')));
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      worker: string;
      protocolVersion: string;
      toolCount: number;
      project: string;
      isolation: string;
      endpoints: Record<string, string>;
    };
    expect(body.worker).toBe('traceforge-mcp-staging');
    expect(body.protocolVersion).toBe('2025-06-18');
    expect(body.toolCount).toBe(25);
    expect(body.project).toBe('TraceForge');
    expect(body.isolation).toBe('independent-from-health-erecords');
    expect(body.endpoints.mcp).toBe(`${ORIGIN}/mcp`);
    expect(body.endpoints.health).toBe(`${ORIGIN}/health`);
    expect(body.endpoints.oauthProtectedResource).toBe(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(body.endpoints.oauthAuthorizationServer).toBe(`${ORIGIN}/.well-known/oauth-authorization-server`);
  });

  it('GET /mcp and GET /api/mcp describe the streamable-http endpoint', async () => {
    const worker = createTraceForgeWorker();
    for (const path of ['/mcp', '/api/mcp']) {
      const res = await worker.fetch(new Request(workerUrl(path)));
      expect(res.status).toBe(200);
      const body = (await readJson(res)) as Record<string, unknown>;
      expect(body['worker']).toBe('traceforge-mcp-staging');
      expect(body['protocolVersion']).toBe('2025-06-18');
      expect(body['transport']).toBe('streamable-http');
      expect(body['endpoint']).toBe(`${ORIGIN}/mcp`);
      expect(body['toolCount']).toBe(25);
    }
  });
});

describe('Phase 4: stateless multi-isolate OAuth/MCP hardening', () => {
  async function crossIsolateAuthorize(authorizeWorker: ReturnType<typeof createTraceForgeWorker>, clientId: string, redirectUri: string) {
    const verifier = `cross-isolate-verifier-${Math.random().toString(36).slice(2)}-0000000000`;
    const challenge = await pkceChallenge(verifier);
    const url =
      `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
    const authorized = await authorizeWorker.fetch(new Request(url, { method: 'GET' }));
    return { authorized, verifier, redirectUri };
  }

  async function exchangeOn(
    tokenWorker: ReturnType<typeof createTraceForgeWorker>,
    location: string,
    verifier: string,
    redirectUri: string,
  ) {
    const code = new URL(location).searchParams.get('code') ?? '';
    expect(code.length).toBeGreaterThan(0);
    return tokenWorker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      }),
    );
  }

  it('redeems an authorization code on a DIFFERENT isolate (stateless PKCE)', async () => {
    const workerA = createTraceForgeWorker();
    const workerB = createTraceForgeWorker();
    const { authorized, verifier, redirectUri } = await crossIsolateAuthorize(workerA, 'pre-registered-connector-id', `${ORIGIN}/callback`);
    expect(authorized.status).toBe(302);
    const tokenRes = await exchangeOn(workerB, authorized.headers.get('Location') ?? '', verifier, redirectUri);
    expect(tokenRes.status).toBe(200);
    const token = (await readJson(tokenRes)) as { access_token: string; token_type: string; scope: string };
    expect(token.token_type).toBe('Bearer');
    expect(token.access_token.length).toBeGreaterThan(0);
    expect(token.scope).toContain('traceforge:investigations:execute');
  });

  it('honors the access token on a THIRD isolate for protected MCP calls', async () => {
    const workerA = createTraceForgeWorker();
    const workerB = createTraceForgeWorker();
    const workerC = createTraceForgeWorker();
    const { authorized, verifier, redirectUri } = await crossIsolateAuthorize(workerA, 'another-connector-id', `${ORIGIN}/callback`);
    const tokenRes = await exchangeOn(workerB, authorized.headers.get('Location') ?? '', verifier, redirectUri);
    const { access_token: accessToken } = (await readJson(tokenRes)) as { access_token: string };
    const created = await mcpCall(workerC, 'tools/call', {
      name: 'traceforge.scenarios.create',
      arguments: { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
    }, `Bearer ${accessToken}`);
    const structured = created.envelope['result'] as { structuredContent: { scenarioId: string }; isError: boolean };
    expect(structured.isError ?? false).toBe(false);
    expect(structured.structuredContent.scenarioId.startsWith('scn_')).toBe(true);
  });

  it('allows unknown client_ids with valid https/localhost redirects, rejects bad ones', async () => {
    const worker = createTraceForgeWorker();
    const challenge = await pkceChallenge('stateless-verifier-00000000000000000001');
    const good = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent('pre-registered-external')}` +
          `&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
        { method: 'GET' },
      ),
    );
    expect(good.status).toBe(302);

    const local = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent('localhost-tool')}` +
          `&redirect_uri=${encodeURIComponent('http://localhost:8787/callback')}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
        { method: 'GET' },
      ),
    );
    expect(local.status).toBe(302);

    const plainHttp = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent('evil-client')}` +
          `&redirect_uri=${encodeURIComponent('http://example.com/cb')}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
        { method: 'GET' },
      ),
    );
    expect(plainHttp.status).toBe(400);

    const missingClient = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
        { method: 'GET' },
      ),
    );
    expect(missingClient.status).toBe(400);

    const missingChallenge = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent('x-client')}` +
          `&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}&code_challenge_method=S256`,
        { method: 'GET' },
      ),
    );
    expect(missingChallenge.status).toBe(400);

    const plainMethod = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent('x-client')}` +
          `&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=plain`,
        { method: 'GET' },
      ),
    );
    expect(plainMethod.status).toBe(400);
  });

  it('still rejects a mismatched redirect_uri for a REGISTERED client', async () => {
    const { worker, client } = await registerClient();
    const challenge = await pkceChallenge('registered-mismatch-verifier-00000001');
    const res = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent(client.client_id)}` +
          `&redirect_uri=${encodeURIComponent('https://attacker.example/x')}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
        { method: 'GET' },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('enforces one-time code consumption within an isolate', async () => {
    const worker = createTraceForgeWorker();
    const verifier = 'one-time-verifier-0000000000000000000001';
    const challenge = await pkceChallenge(verifier);
    const redirectUri = `${ORIGIN}/callback`;
    const authorized = await worker.fetch(
      new Request(
        `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent('replay-client')}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
        { method: 'GET' },
      ),
    );
    const code = new URL(authorized.headers.get('Location') ?? '').searchParams.get('code') ?? '';
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString();
    const first = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    expect(first.status).toBe(200);
    const second = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    expect(second.status).toBe(400);
    expect(((await readJson(second)) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects tampered stateless codes and tokens', async () => {
    const workerA = createTraceForgeWorker();
    const { authorized, verifier, redirectUri } = await crossIsolateAuthorize(workerA, 'tamper-client', `${ORIGIN}/callback`);
    const location = authorized.headers.get('Location') ?? '';
    const code = new URL(location).searchParams.get('code') ?? '';
    const tampered = `${code.slice(0, -2)}AA`;
    const badExchange = await workerA.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: tampered,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      }),
    );
    expect(badExchange.status).toBe(400);

    const forged = await mcpCall(workerA, 'tools/call', {
      name: 'traceforge.scenarios.create',
      arguments: { boardId: 'f405-flight-controller' },
    }, 'Bearer tf_live_x.forged-payload.deadbeef');
    const structured = (forged.envelope['result'] as { structuredContent: { code: string }; isError: boolean });
    expect(structured.isError).toBe(true);
    expect(structured.structuredContent.code).toBe('MAAS_AUTHENTICATION_REQUIRED');
  });
});

describe('Phase 5: cross-isolate scenario/investigation hydration', () => {
  it('flows create -> voltage -> start -> result -> score -> report across 6 cold isolates; 7th rejects cross-tenant', async () => {
    const w1 = createTraceForgeWorker();
    const w2 = createTraceForgeWorker();
    const w3 = createTraceForgeWorker();
    const w4 = createTraceForgeWorker();
    const w5 = createTraceForgeWorker();
    const w6 = createTraceForgeWorker();
    const w7 = createTraceForgeWorker();

    const created = await mcpCall(w1, 'tools/call', {
      name: 'traceforge.scenarios.create',
      arguments: { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
    }, AGENT);
    const createdContent = created.envelope['result'] as { structuredContent: { scenarioId: string }; isError: boolean };
    expect(createdContent.isError ?? false).toBe(false);
    const scenarioId = createdContent.structuredContent.scenarioId;
    expect(scenarioId.startsWith('scn_')).toBe(true);

    const measured = await mcpCall(w2, 'tools/call', {
      name: 'traceforge.measurements.voltage',
      arguments: { scenarioId, node: 'U1-14' },
    }, AGENT);
    const measuredContent = measured.envelope['result'] as { structuredContent: { probesUsed: number }; isError: boolean };
    expect(measuredContent.isError ?? false).toBe(false);
    expect(measuredContent.structuredContent.probesUsed).toBe(1);

    const started = await mcpCall(w3, 'tools/call', {
      name: 'traceforge.investigations.start',
      arguments: { scenarioId },
    }, AGENT);
    const startedContent = started.envelope['result'] as { structuredContent: { investigationId: string; completed: boolean }; isError: boolean };
    expect(startedContent.isError ?? false).toBe(false);
    expect(startedContent.structuredContent.completed).toBe(true);
    const investigationId = startedContent.structuredContent.investigationId;
    expect(investigationId.startsWith('inv_')).toBe(true);

    const result = await mcpCall(w4, 'tools/call', {
      name: 'traceforge.investigations.result',
      arguments: { investigationId },
    }, AGENT);
    const resultContent = result.envelope['result'] as { structuredContent: { proposedDiagnosis: unknown }; isError: boolean };
    expect(resultContent.isError ?? false).toBe(false);
    expect(resultContent.structuredContent.proposedDiagnosis).toBeTruthy();

    const scored = await mcpCall(w5, 'tools/call', {
      name: 'traceforge.evaluation.score',
      arguments: { scenarioId },
    }, AGENT);
    const scoredContent = scored.envelope['result'] as { structuredContent: { score: { totalScore: number } | null }; isError: boolean };
    expect(scoredContent.isError ?? false).toBe(false);
    expect(scoredContent.structuredContent.score).toBeTruthy();

    const reported = await mcpCall(w6, 'tools/call', {
      name: 'traceforge.evaluation.report',
      arguments: { scenarioId },
    }, AGENT);
    const reportedContent = reported.envelope['result'] as { structuredContent: { scorecard: unknown }; isError: boolean };
    expect(reportedContent.isError ?? false).toBe(false);
    expect(reportedContent.structuredContent.scorecard).toBeTruthy();

    const crossed = await mcpCall(w7, 'tools/call', {
      name: 'traceforge.measurements.voltage',
      arguments: { scenarioId, node: 'U1-14' },
    }, SECONDARY);
    expect(
      (crossed.envelope['result'] as { structuredContent: { code: string }; isError: boolean }).structuredContent.code,
    ).toBe('MAAS_CROSS_TENANT_ACCESS_DENIED');
  });
});

describe('Phase 6: live mode via env.META_API_KEY', () => {
  it('mints PKCE tokens carrying the live_inference scope', async () => {
    expect(WORKER_DEFAULT_SCOPE).toContain('traceforge:live_inference:execute');
    const { worker, client } = await registerClient();
    const { scope } = await fullPkceToken({ worker, client });
    expect(scope).toContain('traceforge:live_inference:execute');
  });

  it('attaches a live client when env.META_API_KEY is present without exposing the key', async () => {
    const worker = createTraceForgeWorker();
    expect(worker.getService().hasLiveClient()).toBe(false);
    const res = await worker.fetch(new Request(workerUrl('/health')), { META_API_KEY: 'tf-test-server-key' });
    expect(res.status).toBe(200);
    expect(worker.getService().hasLiveClient()).toBe(true);
    expect(JSON.stringify(await readJson(res))).not.toContain('tf-test-server-key');

    const blank = createTraceForgeWorker();
    await blank.fetch(new Request(workerUrl('/health')), { META_API_KEY: '   ' });
    expect(blank.getService().hasLiveClient()).toBe(false);

    const missing = createTraceForgeWorker();
    await missing.fetch(new Request(workerUrl('/health')));
    expect(missing.getService().hasLiveClient()).toBe(false);
  });
});

describe('Phase 6: cross-isolate LIVE_API preservation', () => {
  const LIVE_OPERATOR = { authorization: 'Bearer tf_operator_live_token' };

  it('preserves LIVE_API investigation results across isolates without a second live call', async () => {
    let liveCalls = 0;
    const liveClient = new MetaClient({
      mode: 'live',
      apiKey: 'tf-test-live-key',
      segmentationMode: 'static_fixture',
      fetchFn: async () => {
        liveCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: 'Stubbed live reasoning. FINAL_DIAGNOSIS: {"componentRef":"U1","faultType":"solder_bridge","verificationStatus":"confirmed","explanation":"Stubbed live verdict from canned upstream."}',
              },
            }],
            usage: { prompt_tokens: 12, completion_tokens: 6 },
          }),
        };
      },
    });
    const serviceA = new TraceForgeMaasService({ liveClient });
    const created = (await serviceA.executeTool(
      'traceforge.scenarios.create',
      { boardId: 'f405-flight-controller', faultSelector: 'f405-nrst-gnd-short' },
      LIVE_OPERATOR,
    )) as { scenarioId: string };
    const started = (await serviceA.executeTool(
      'traceforge.investigations.start',
      { scenarioId: created.scenarioId, mode: 'live' },
      LIVE_OPERATOR,
    )) as {
      investigationId: string;
      operationalMode: string;
      executionSource: string;
      diagnosisSource: string;
      completed: boolean;
    };
    expect(started.completed).toBe(true);
    expect(started.operationalMode).toBe('LIVE_API');
    expect(started.executionSource).toBe('Live Muse Spark 1.3');
    expect(liveCalls).toBeGreaterThan(0);

    // The signed token is opaque hex: zero readable ground-truth strings.
    expect(started.investigationId).toMatch(/^inv_[0-9a-f]+_[0-9a-f]{64}$/);
    expect(started.investigationId).not.toContain('f405-nrst-gnd-short');

    // Cold isolate B has no live client, so any LIVE_API label it reports
    // must come from the hydrated token — never a second live API call.
    const serviceB = new TraceForgeMaasService();
    expect(serviceB.hasLiveClient()).toBe(false);
    const resultB = (await serviceB.executeTool(
      'traceforge.investigations.result',
      { investigationId: started.investigationId },
      LIVE_OPERATOR,
    )) as {
      operationalMode: string;
      executionSource: string;
      diagnosisSource: string;
      proposedDiagnosis: { componentRef: string; faultType: string };
    };
    expect(resultB.operationalMode).toBe('LIVE_API');
    expect(resultB.executionSource).toBe('Live Muse Spark 1.3');
    expect(resultB.diagnosisSource).toBe(started.diagnosisSource);
    expect(resultB.proposedDiagnosis.componentRef).toBe('U1');

    const statusB = (await serviceB.executeTool(
      'traceforge.investigations.status',
      { investigationId: started.investigationId },
      LIVE_OPERATOR,
    )) as { operationalMode: string; executionSource: string };
    expect(statusB.operationalMode).toBe('LIVE_API');
    expect(statusB.executionSource).toBe('Live Muse Spark 1.3');
  });
});

describe('browser backend routes /api/meta/*', () => {
  const CHAT_KEY = 'tf-test-worker-meta-key';

  async function postMetaChat(
    worker: ReturnType<typeof createTraceForgeWorker>,
    body: unknown,
    env?: Record<string, string>,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const res = await worker.fetch(
      new Request(workerUrl('/api/meta/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env as unknown as Parameters<ReturnType<typeof createTraceForgeWorker>['fetch']>[1],
    );
    return { status: res.status, payload: (await res.json()) as Record<string, unknown> };
  }

  it('GET /api/meta/status reports UNCONFIGURED vs live-ready without leaking the key', async () => {
    const worker = createTraceForgeWorker();
    const missing = await worker.fetch(new Request(workerUrl('/api/meta/status')));
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ configured: false, mode: 'UNAVAILABLE' });

    const configuredWorker = createTraceForgeWorker();
    const ready = await configuredWorker.fetch(new Request(workerUrl('/api/meta/status')), { META_API_KEY: CHAT_KEY });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ configured: true, mode: 'UNVERIFIED' });
  });

  it('POST /api/meta/chat answers 503 without a key and never echoes one', async () => {
    const worker = createTraceForgeWorker();
    const { status, payload } = await postMetaChat(worker, { messages: [{ role: 'user', content: 'hi' }] });
    expect(status).toBe(503);
    expect(payload['error']).toContain('not configured on the local server proxy');
  });

  it('POST /api/meta/chat forwards with the key, records usage, and scrubs it', async () => {
    const worker = createTraceForgeWorker();
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = async (url: unknown, init?: { body?: string }) => {
      if (typeof url === 'string' && url.includes('api.meta.ai')) {
        seen.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'live answer', tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url as string, init as RequestInit);
    };
    try {
      const { status, payload } = await postMetaChat(
        worker,
        { messages: [{ role: 'user', content: 'Hello, Forge!' }], maxTokens: 32, effort: 'low' },
        { META_API_KEY: CHAT_KEY },
      );
      expect(status).toBe(200);
      expect(payload['content']).toBe('live answer');
      expect(payload['model']).toBe('muse-spark-1.3');
      expect(JSON.stringify(payload)).not.toContain(CHAT_KEY);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('"reasoning_effort":"low"');
      expect(seen[0]).not.toContain(CHAT_KEY);

      const budget = (await worker.getService().executeTool('traceforge.budget.status', {}, {})) as {
        ledger: { incurredCostUsd: number; totalRequests: number; providerReportedUsage: boolean };
      };
      expect(budget.ledger.totalRequests).toBe(1);
      expect(budget.ledger.incurredCostUsd).toBeGreaterThan(0);
      expect(budget.ledger.providerReportedUsage).toBe(true);

      const models = (await worker.getService().executeTool('traceforge.models.status', {}, {})) as {
        spark: { operationalMode: string; liveVerified: boolean };
      };
      expect(models.spark.operationalMode).toBe('LIVE_API');
      expect(models.spark.liveVerified).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('POST /api/meta/chat is blocked by the $95.00 budget safety stop', async () => {
    const worker = createTraceForgeWorker();
    worker.getService().injectLiveSpendForTesting(96);
    const { status, payload } = await postMetaChat(
      worker,
      { messages: [{ role: 'user', content: 'hi' }] },
      { META_API_KEY: CHAT_KEY },
    );
    expect(status).toBe(429);
    expect(String(payload['error'])).toContain('$95.00');
  });

  it('POST /api/meta/segment answers 503 without a key', async () => {
    const worker = createTraceForgeWorker();
    const res = await worker.fetch(
      new Request(workerUrl('/api/meta/segment'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: {} }),
      }),
    );
    expect(res.status).toBe(503);
  });
});

describe('OAuth per-client actor isolation on the Worker', () => {
  it('binds each clientId to its own actorId with only granted scopes', async () => {
    const worker = createTraceForgeWorker();
    const first = await worker.fetch(
      new Request(workerUrl('/oauth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [`${ORIGIN}/callback`] }),
      }),
    );
    const clientA = (await readJson(first)) as { client_id: string; redirect_uris: string[] };
    const second = await worker.fetch(
      new Request(workerUrl('/oauth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [`${ORIGIN}/callback`] }),
      }),
    );
    const clientB = (await readJson(second)) as { client_id: string; redirect_uris: string[] };
    const { accessToken: tokenA } = await fullPkceToken({ worker, client: { ...clientA, grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' } });
    const { accessToken: tokenB } = await fullPkceToken({ worker, client: { ...clientB, grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' } });

    const created = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.scenarios.create',
      arguments: { boardId: 'f405-flight-controller', faultSelector: 'nominal' },
    }, `Bearer ${tokenA}`);
    const scenarioId = (created.envelope['result'] as { structuredContent: { scenarioId: string } }).structuredContent.scenarioId;
    expect(scenarioId.startsWith('scn_')).toBe(true);

    const crossed = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.measurements.voltage',
      arguments: { scenarioId, node: 'U1-14' },
    }, `Bearer ${tokenB}`);
    expect(
      (crossed.envelope['result'] as { structuredContent: { code: string } }).structuredContent.code,
    ).toBe('MAAS_CROSS_TENANT_ACCESS_DENIED');

    worker.getService().getKillSwitch().revokeToken(tokenA);
    const revoked = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.measurements.voltage',
      arguments: { scenarioId, node: 'U1-14' },
    }, `Bearer ${tokenA}`);
    expect(
      (revoked.envelope['result'] as { structuredContent: { code: string } }).structuredContent.code,
    ).toBe('MAAS_CREDENTIALS_REVOKED');
    worker.getService().getKillSwitch().restoreToken(tokenA);
  });

  it('rotates the stateless signing secret', async () => {
    const { worker, client } = await registerClient();
    const { accessToken } = await fullPkceToken({ worker, client });
    const ok = await mcpCall(worker, 'tools/call', { name: 'traceforge.system.status', arguments: {} }, `Bearer ${accessToken}`);
    expect((ok.envelope['result'] as { isError: boolean }).isError ?? false).toBe(false);
    // A worker holding a different secret rejects the foreign stateless token.
    const rotated = createTraceForgeWorker({ signingSecret: 'tf-worker-rotated-signing-secret' });
    const denied = await mcpCall(rotated, 'tools/call', { name: 'traceforge.system.status', arguments: {} }, `Bearer ${accessToken}`);
    expect(
      (denied.envelope['result'] as { structuredContent: { code: string } }).structuredContent.code,
    ).toBe('MAAS_AUTHENTICATION_REQUIRED');
    // Same-worker rotation keeps fresh PKCE flows working.
    worker.rotateSigningSecret('tf-worker-fresh-secret');
    const { accessToken: fresh } = await fullPkceToken({ worker, client });
    const freshOk = await mcpCall(worker, 'tools/call', { name: 'traceforge.system.status', arguments: {} }, `Bearer ${fresh}`);
    expect((freshOk.envelope['result'] as { isError: boolean }).isError ?? false).toBe(false);
  });
});

describe('server-authorized diagnostic telemetry', () => {
  const OPERATOR_AUTH = 'Bearer tf_operator_live_token';
  const AGENT_AUTH = 'Bearer tf_agent_local_token';

  it('returns 401 without a Bearer token', async () => {
    const worker = createTraceForgeWorker();
    const res = await worker.fetch(new Request(workerUrl('/api/maas/telemetry')));
    expect(res.status).toBe(401);
    const body = (await readJson(res)) as { error: { code: string } };
    expect(body.error.code).toBe('MAAS_AUTHENTICATION_REQUIRED');
  });

  it('returns 403 for a token without traceforge:audit:read', async () => {
    const worker = createTraceForgeWorker();
    const res = await worker.fetch(
      new Request(workerUrl('/api/maas/telemetry'), { headers: { Authorization: AGENT_AUTH } }),
    );
    expect(res.status).toBe(403);
    const body = (await readJson(res)) as { error: { code: string } };
    expect(body.error.code).toBe('MAAS_AUTHORIZATION_DENIED');
  });

  it('returns models, budget, and system status for an authorized token', async () => {
    const worker = createTraceForgeWorker();
    const res = await worker.fetch(
      new Request(workerUrl('/api/maas/telemetry'), { headers: { Authorization: OPERATOR_AUTH } }),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      systemStatus: { service: string };
      modelsStatus: { spark: { model: string } };
      budgetStatus: { safetyThresholdUsd: number };
    };
    expect(body.systemStatus.service).toBe('traceforge-maas');
    expect(body.modelsStatus.spark.model).toBe('muse-spark-1.3');
    expect(body.budgetStatus.safetyThresholdUsd).toBe(95);
  });
});

describe('TraceForgeStateDO durable persistence across Worker restarts', () => {
  const HOOK_KEY = '__traceforgeDurableStorage';

  afterEach(() => {
    // Never leak the isolate-global durable hook into other suites: the DO
    // constructor installs it, and every other test expects it absent.
    delete (globalThis as Record<string, unknown>)[HOOK_KEY];
  });

  it('routes default.fetch through the DO and persists probes/history/investigation/scorecard across redeploys', async () => {
    // One shared transactional store: every reconstructed DO instance is
    // backed by this same Map, simulating a Worker redeploy / isolate
    // eviction where in-memory service Maps are lost but DO storage survives.
    const backing = new Map<string, unknown>();
    const storageFor = () => ({
      get: async (key: string): Promise<unknown> => backing.get(key),
      put: async (key: string, value: unknown): Promise<void> => {
        backing.set(key, value);
      },
    });

    let currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const routedNames: string[] = [];
    const mockNs = {
      idFromName: (name: string): unknown => {
        routedNames.push(name);
        return name;
      },
      get: (_id: unknown) => ({
        fetch: (request: Request): Promise<Response> => currentDo.fetch(request),
      }),
    };
    const env: TraceForgeWorkerEnv = { TRACEFORGE_STATE_DO: mockNs };

    async function mcpViaDefault(
      method: string,
      params: Record<string, unknown>,
      auth?: string,
    ): Promise<Record<string, unknown>> {
      const res = await workerDefault.fetch(
        new Request(workerUrl('/mcp'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: auth } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
        env,
      );
      return (await readJson(res)) as Record<string, unknown>;
    }

    async function toolViaDefault(
      name: string,
      toolArgs: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const envelope = await mcpViaDefault('tools/call', { name, arguments: toolArgs }, AGENT);
      const result = envelope['result'] as {
        structuredContent: Record<string, unknown>;
        isError: boolean;
      };
      expect(result.isError ?? false).toBe(false);
      return result.structuredContent;
    }

    const created = await toolViaDefault('traceforge.scenarios.create', {
      boardId: 'f405-flight-controller',
      faultSelector: 'f405-nrst-gnd-short',
    });
    const scenarioId = created['scenarioId'] as string;
    expect(scenarioId.startsWith('scn_')).toBe(true);

    // The request was routed through the canonical singleton Durable Object
    // (not the in-process shared worker), and scenario state landed in
    // durable storage.
    expect(TRACEFORGE_STATE_DO_NAME).toBe('traceforge-canonical-v1');
    expect(routedNames).toContain('traceforge-canonical-v1');
    expect(backing.size).toBeGreaterThan(0);

    const first = await toolViaDefault('traceforge.measurements.voltage', {
      scenarioId,
      node: 'U1-14',
    });
    expect(first['probesUsed']).toBe(1);

    // Simulate a Worker redeploy: a brand-new DO instance (fresh service
    // Maps) over the SAME storage Map.
    currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const second = await toolViaDefault('traceforge.measurements.voltage', {
      scenarioId,
      node: 'U1-14',
    });
    expect(second['probesUsed']).toBe(2);

    currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const third = await toolViaDefault('traceforge.measurements.voltage', {
      scenarioId,
      node: 'U1-14',
    });
    expect(third['probesUsed']).toBe(3);

    // Ordered measurement history survives restarts.
    currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const history = await toolViaDefault('traceforge.measurements.history', { scenarioId });
    const probeLog = history['probeLog'] as unknown[];
    expect(probeLog).toHaveLength(3);
    expect(history['activitySummary']).toMatchObject({ total: 3 });

    // One stable investigation id across restarts.
    const started = await toolViaDefault('traceforge.investigations.start', { scenarioId });
    expect(started['completed']).toBe(true);
    const investigationId = started['investigationId'] as string;
    expect(investigationId.startsWith('inv_')).toBe(true);

    currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const result = await toolViaDefault('traceforge.investigations.result', { investigationId });
    expect(result['proposedDiagnosis']).toBeTruthy();
    const status = await toolViaDefault('traceforge.investigations.status', { scenarioId });
    expect(status['investigationId']).toBe(investigationId);

    // Immutable evaluation scorecard across restarts: score, re-score on a
    // fresh DO, and report all agree byte-for-byte.
    const scored = await toolViaDefault('traceforge.evaluation.score', { scenarioId });
    expect(scored['score']).toBeTruthy();

    currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const rescored = await toolViaDefault('traceforge.evaluation.score', { scenarioId });
    expect(rescored).toEqual(scored);

    const reported = await toolViaDefault('traceforge.evaluation.report', { scenarioId });
    expect(reported['scorecard']).toEqual(scored);
  });

  it('falls back to the shared worker when no DO binding is configured', async () => {
    const res = await workerDefault.fetch(new Request(workerUrl('/health')), {});
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body['worker']).toBe('traceforge-mcp-staging');
  });
});

describe('OAuth 2.1 refresh tokens, rotation, revocation, and DO persistence', () => {
  const HOOK_KEY = '__traceforgeDurableStorage';

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[HOOK_KEY];
  });

  async function issuePkcePair(
    worker: ReturnType<typeof createTraceForgeWorker>,
    client: RegisteredClient,
    scope?: string,
  ): Promise<{ accessToken: string; refreshToken: string; scope: string; expiresIn: number }> {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await pkceChallenge(verifier);
    const redirectUri = client.redirect_uris[0] as string;
    const authorizeUrl =
      `${ORIGIN}/oauth/authorize?client_id=${encodeURIComponent(client.client_id)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=st_refresh` +
      (scope ? `&scope=${encodeURIComponent(scope)}` : '') +
      `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
    const authorized = await worker.fetch(new Request(authorizeUrl, { method: 'GET' }));
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('Location') ?? '').searchParams.get('code') ?? '';
    const tokenRes = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const body = (await readJson(tokenRes)) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_token.startsWith('tf_rt_x.')).toBe(true);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      scope: body.scope,
      expiresIn: body.expires_in,
    };
  }

  it('advertises refresh_token grant and revocation_endpoint in discovery and client registration', async () => {
    const { worker, client } = await registerClient();
    expect(client.grant_types).toEqual(['authorization_code', 'refresh_token']);

    const res = await worker.fetch(new Request(workerUrl('/.well-known/oauth-authorization-server')));
    expect(res.status).toBe(200);
    const meta = (await readJson(res)) as {
      grant_types_supported: string[];
      revocation_endpoint: string;
    };
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(meta.revocation_endpoint).toBe(`${ORIGIN}/oauth/revoke`);
  });

  it('issues a refresh_token on authorization_code exchange, rotates it on refresh, and rejects replay', async () => {
    const { worker, client } = await registerClient();
    const initial = await issuePkcePair(worker, client);

    const refreshRes = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: initial.refreshToken,
          client_id: client.client_id,
        }).toString(),
      }),
    );
    expect(refreshRes.status).toBe(200);
    const rotated = (await readJson(refreshRes)) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(rotated.token_type).toBe('Bearer');
    expect(rotated.expires_in).toBe(3600);
    expect(rotated.access_token).not.toBe(initial.accessToken);
    expect(rotated.refresh_token).not.toBe(initial.refreshToken);
    expect(rotated.scope).toBe(initial.scope);

    // Refreshed access token works for authenticated MCP calls.
    const statusCall = await mcpCall(
      worker,
      'tools/call',
      { name: 'traceforge.system.status', arguments: {} },
      `Bearer ${rotated.access_token}`,
    );
    expect((statusCall.envelope['result'] as { isError: boolean }).isError ?? false).toBe(false);

    // Replaying the old (consumed) refresh token is rejected with invalid_grant.
    const replayRes = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: initial.refreshToken,
        }),
      }),
    );
    expect(replayRes.status).toBe(400);
    const replayErr = (await readJson(replayRes)) as { error: string };
    expect(replayErr.error).toBe('invalid_grant');
  });

  it('rejects expired refresh tokens with invalid_grant', async () => {
    let now = 1_700_000_000_000;
    const worker = createTraceForgeWorker({ clock: () => now });
    const reg = await worker.fetch(
      new Request(workerUrl('/oauth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [`${ORIGIN}/callback`] }),
      }),
    );
    const client = (await readJson(reg)) as RegisteredClient;
    const initial = await issuePkcePair(worker, client);

    // Advance clock past the 30-day refresh token TTL.
    now += 31 * 24 * 3600 * 1000;
    const expiredRes = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: initial.refreshToken,
        }),
      }),
    );
    expect(expiredRes.status).toBe(400);
    const err = (await readJson(expiredRes)) as { error: string; error_description: string };
    expect(err.error).toBe('invalid_grant');
    expect(err.error_description).toContain('expired');
  });

  it('preserves or narrows scopes on refresh and rejects scope escalation with invalid_scope', async () => {
    const { worker, client } = await registerClient();
    const initial = await issuePkcePair(
      worker,
      client,
      'traceforge:discovery:read traceforge:circuits:read traceforge:scenarios:read',
    );

    // Escalation attempt -> invalid_scope
    const escalated = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: initial.refreshToken,
          scope: 'traceforge:discovery:read traceforge:live_inference:execute',
        }),
      }),
    );
    expect(escalated.status).toBe(400);
    const escErr = (await readJson(escalated)) as { error: string };
    expect(escErr.error).toBe('invalid_scope');

    // Valid narrowing -> succeeds and preserves unconsumed token until this valid exchange
    const narrowed = await worker.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: initial.refreshToken,
          scope: 'traceforge:discovery:read traceforge:circuits:read',
        }),
      }),
    );
    expect(narrowed.status).toBe(200);
    const body = (await readJson(narrowed)) as { scope: string };
    expect(body.scope).toBe('traceforge:discovery:read traceforge:circuits:read');
  });

  it('enforces client binding on refresh and supports POST /oauth/revoke across Durable Object restarts', async () => {
    const backing = new Map<string, unknown>();
    const storageFor = () => ({
      get: async (key: string): Promise<unknown> => backing.get(key),
      put: async (key: string, value: unknown): Promise<void> => {
        backing.set(key, value);
      },
    });
    let currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const env: TraceForgeWorkerEnv = {
      TRACEFORGE_STATE_DO: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: (req: Request) => currentDo.fetch(req) }),
      },
    };

    const regA = await workerDefault.fetch(
      new Request(workerUrl('/oauth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [`${ORIGIN}/callback`] }),
      }),
      env,
    );
    const clientA = (await readJson(regA)) as RegisteredClient;

    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await pkceChallenge(verifier);
    const authRes = await workerDefault.fetch(
      new Request(`${ORIGIN}/oauth/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientA.client_id,
          redirect_uri: `${ORIGIN}/callback`,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
      }),
      env,
    );
    const { code } = (await readJson(authRes)) as { code: string };
    const tokRes = await workerDefault.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${ORIGIN}/callback`,
          code_verifier: verifier,
        }),
      }),
      env,
    );
    const issued = (await readJson(tokRes)) as { access_token: string; refresh_token: string };

    // Simulate DO restart; wrong client_id is rejected
    currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const wrongClient = await workerDefault.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          client_id: 'tf_client_other',
        }),
      }),
      env,
    );
    expect(wrongClient.status).toBe(400);
    expect(((await readJson(wrongClient)) as { error: string }).error).toBe('invalid_grant');

    // Correct client_id succeeds after DO restart
    const refreshedRes = await workerDefault.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          client_id: clientA.client_id,
        }),
      }),
      env,
    );
    expect(refreshedRes.status).toBe(200);
    const refreshed = (await readJson(refreshedRes)) as { access_token: string; refresh_token: string };

    // Replay of the first refresh token fails even after another DO restart
    currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const replayAfterRestart = await workerDefault.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
        }),
      }),
      env,
    );
    expect(replayAfterRestart.status).toBe(400);

    // Revoke the new refresh token and access token via POST /oauth/revoke
    const revokeRt = await workerDefault.fetch(
      new Request(workerUrl('/oauth/revoke'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: refreshed.refresh_token, token_type_hint: 'refresh_token' }),
      }),
      env,
    );
    expect(revokeRt.status).toBe(200);

    const revokeAt = await workerDefault.fetch(
      new Request(workerUrl('/oauth/revoke'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: refreshed.access_token, token_type_hint: 'access_token' }),
      }),
      env,
    );
    expect(revokeAt.status).toBe(200);

    // After another DO restart, both the revoked refresh token and revoked access token are rejected
    currentDo = new TraceForgeStateDO({ storage: storageFor() }, {});
    const useRevokedRt = await workerDefault.fetch(
      new Request(workerUrl('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshed.refresh_token,
        }),
      }),
      env,
    );
    expect(useRevokedRt.status).toBe(400);

    const useRevokedAt = await workerDefault.fetch(
      new Request(workerUrl('/mcp'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${refreshed.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'traceforge.scenarios.create', arguments: { boardId: 'f405-flight-controller' } },
        }),
      }),
      env,
    );
    const mcpBody = (await readJson(useRevokedAt)) as {
      result: { structuredContent: { code: string } };
    };
    expect(mcpBody.result.structuredContent.code).toBe('MAAS_CREDENTIALS_REVOKED');
  });
});

describe('worker package independence', () => {
  it('contains zero Node.js built-in imports', () => {
    const source: string = workerSource;
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/require\s*\(\s*['"]node:/);
    expect(source).not.toMatch(/require\s*\(\s*['"](fs|path|crypto|http|https|url|util|os|child_process)['"]/);
    expect(source).not.toMatch(/from\s+['"](fs|path|crypto|http|https|url|util|os|child_process)['"]/);
    const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));
    expect(importLines.filter((line) => /health/i.test(line))).toEqual([]);
    expect(source).not.toMatch(/from\s+['"][^'"]*health[^'"]*['"]/i);
    expect(source).not.toMatch(/require\s*\([^)]*health/i);
    expect(source).toContain('independent-from-health-erecords');
  });
});

describe('assistant MCP parity over the Worker (25 tools)', () => {
  it('documents resource_documentation and serves GET /docs/mcp with the 25-tool catalog', async () => {
    const worker = createTraceForgeWorker();
    const meta = (await readJson(
      await worker.fetch(new Request(workerUrl('/.well-known/oauth-protected-resource'))),
    )) as { resource_documentation: string; scopes_supported: string[] };
    expect(meta.resource_documentation).toBe(`${ORIGIN}/docs/mcp`);
    expect(meta.scopes_supported).toContain('traceforge:assistant:chat');

    const docs = await worker.fetch(new Request(workerUrl('/docs/mcp')));
    expect(docs.status).toBe(200);
    const body = (await readJson(docs)) as {
      toolCount: number; tools: string[]; protocolVersion: string;
      oauth: { dynamicRegistration: string; clients: string[] };
    };
    expect(body.toolCount).toBe(25);
    expect(body.protocolVersion).toBe('2025-06-18');
    for (const name of [
      'traceforge.kb.search',
      'traceforge.chat.status',
      'traceforge.chat.start',
      'traceforge.chat.ask',
      'traceforge.chat.history',
      'traceforge.chat.clear',
      'traceforge.chat.feedback',
    ]) {
      expect(body.tools).toContain(name);
    }
    expect(body.oauth.clients.join(' ')).toContain('agent.meta.ai');
  });

  it('accepts DCR from ChatGPT, Muse/Meta AI, and generic clients with or without client_name', async () => {
    const cases = [
      { name: 'ChatGPT with client_name', body: { client_name: 'ChatGPT TraceForge', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] } },
      { name: 'ChatGPT without client_name', body: { redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] } },
      { name: 'Muse hatch with client_name', body: { client_name: 'Muse', redirect_uris: ['https://agent.meta.ai/api/hatch/oauth/callback'] } },
      { name: 'Muse api without client_name', body: { redirect_uris: ['https://agent.meta.ai/api/oauth/callback'] } },
      { name: 'generic localhost', body: { client_name: 'dev-client', redirect_uris: ['http://localhost:8787/callback'] } },
    ];
    for (const c of cases) {
      const worker = createTraceForgeWorker();
      const res = await worker.fetch(
        new Request(workerUrl('/oauth/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(c.body),
        }),
      );
      expect(res.status).toBe(201);
      const client = (await readJson(res)) as { client_id: string; client_name?: string; redirect_uris: string[] };
      expect(client.client_id.length).toBeGreaterThan(0);
      expect(client.redirect_uris).toEqual((c.body as { redirect_uris: string[] }).redirect_uris);
    }
  });

  it('runs the assistant conversation lifecycle with a Muse-style PKCE OAuth token', async () => {
    const worker = createTraceForgeWorker();
    const reg = await worker.fetch(
      new Request(workerUrl('/oauth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Muse test agent',
          redirect_uris: ['https://agent.meta.ai/api/hatch/oauth/callback'],
        }),
      }),
    );
    expect(reg.status).toBe(201);
    const client = (await readJson(reg)) as RegisteredClient;
    const { accessToken, scope } = await fullPkceToken({ worker, client });
    expect(scope).toContain('traceforge:discovery:read');
    expect(scope).toContain('traceforge:assistant:chat');
    const auth = `Bearer ${accessToken}`;

    const started = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.chat.start',
      arguments: { title: 'oauth lifecycle' },
    }, auth);
    const conv = (started.envelope['result'] as { structuredContent: { conversationId: string; ownerActorId: string } }).structuredContent;
    expect(conv.conversationId.startsWith('conv_')).toBe(true);
    expect(conv.ownerActorId.startsWith('actor_oauth_')).toBe(true);

    const asked = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.chat.ask',
      arguments: { conversationId: conv.conversationId, message: 'How does TraceForge work?' },
    }, auth);
    const answer = (asked.envelope['result'] as { structuredContent: { reply: string; liveInvoked: boolean; kbVersion: string } }).structuredContent;
    expect(answer.reply.length).toBeGreaterThan(0);
    expect(answer.liveInvoked).toBe(false);
    expect(answer.kbVersion).toBe('2026.10.27-v3');

    const history = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.chat.history',
      arguments: { conversationId: conv.conversationId },
    }, auth);
    expect(
      (history.envelope['result'] as { structuredContent: { messageCount: number } }).structuredContent.messageCount,
    ).toBe(2);

    const qa = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.chat.ask',
      arguments: { runStandard20QuestionQa: true },
    }, auth);
    const report = (qa.envelope['result'] as { structuredContent: {
      passedCount: number; failedCount: number; allPassed: boolean; totalCostUsd: number; kbVersion: string;
    } }).structuredContent;
    expect(report.passedCount).toBe(20);
    expect(report.failedCount).toBe(0);
    expect(report.allPassed).toBe(true);
    expect(report.totalCostUsd).toBe(0);
    expect(report.kbVersion).toBe('2026.10.27-v3');
  }, 60000);

  it('answers generic-client interop methods and isolates conversations per actor', async () => {
    const worker = createTraceForgeWorker();
    const init = await mcpCall(worker, 'initialize', {});
    expect((init.envelope['result'] as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');

    const discovered = await mcpCall(worker, 'server/discover', {});
    expect((discovered.envelope['result'] as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    expect(((discovered.envelope['result'] as { tools: unknown[] }).tools ?? [])).toHaveLength(25);

    const ping = await mcpCall(worker, 'ping', {});
    expect(ping.envelope['result']).toEqual({});

    const initialized = await worker.fetch(
      new Request(workerUrl('/mcp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'notifications/initialized', params: {} }),
      }),
    );
    expect(initialized.status).toBe(202);

    const anonSearch = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.kb.search',
      arguments: { query: 'What is the 8-probe budget?' },
    });
    const kb = (anonSearch.envelope['result'] as { structuredContent: { sources: unknown[]; incurredCostUsd: number } }).structuredContent;
    expect(kb.sources.length).toBeGreaterThan(0);
    expect(kb.incurredCostUsd).toBe(0);

    const started = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.chat.start',
      arguments: {},
    }, AGENT);
    const conv = (started.envelope['result'] as { structuredContent: { conversationId: string } }).structuredContent;

    const crossed = await mcpCall(worker, 'tools/call', {
      name: 'traceforge.chat.history',
      arguments: { conversationId: conv.conversationId },
    }, SECONDARY);
    const structured = (crossed.envelope['result'] as { structuredContent: { code: string }; isError: boolean });
    expect(structured.isError).toBe(true);
    expect(structured.structuredContent.code).toBe('MAAS_CROSS_TENANT_ACCESS_DENIED');
  });
});
