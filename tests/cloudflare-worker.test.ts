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
import { describe, expect, it } from 'vitest';
import { createTraceForgeWorker, verifyPkceS256 } from '../worker/index';
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
    expect(body['toolCount']).toBe(18);
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
    expect((listed.envelope['result'] as { tools: unknown[] }).tools).toHaveLength(18);

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
    expect(((await readJson(catalog)) as { count: number }).count).toBe(18);

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
    expect(body.toolCount).toBe(18);
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
      expect(body['toolCount']).toBe(18);
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
