import { describe, expect, it } from 'vitest';
import {
  AGENTIC_MAX_TURNS,
  FINAL_DIAGNOSIS_MARKER,
  SYNTHETIC_MNA_LEAKAGE_IDS,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  candidateComponentRefs,
  classifyFromEvidence,
  estimateConversationTokens,
  parseFinalDiagnosis,
  runAgenticDiagnosis,
} from '../src/lib/diagnostic-agent';
import {
  assertGroundTruthIsolated,
  createVirtualSession,
  listReferenceBoards,
} from '../src/lib/circuit-simulator';
import {
  MetaClient,
  TOOL_DEFINITIONS,
  clampMaxTokens,
  estimateLiveCostUsd,
  estimateTokens,
  isRetryableChatError,
  safeParseToolArguments as safeParseClientArgs,
  type ChatRequest,
  type ChatResponse,
  type FetchFn,
} from '../src/lib/meta-client';
import {
  META_PROXY_MAX_BODY_BYTES,
  PROXY_BODY_TOO_LARGE_MESSAGE,
  PROXY_KEY_MISSING_MESSAGE,
  clampProxyMaxTokens,
  handleMetaProxyRequest,
  normalizeProxyMessages,
  normalizeProxyTools,
  parseDotEnvApiKey,
  safeParseToolArguments,
} from '../src/server/meta-proxy';

describe('simulated measurement-reactive diagnosis (all 9 faults)', () => {
  const cases = listReferenceBoards().flatMap((b) => b.faults.map((f) => ({ boardId: b.boardId, fault: f })));
  expect(cases).toHaveLength(9);

  for (const { boardId, fault } of cases) {
    it(`diagnoses ${fault.faultId} from MNA tool outputs alone`, async () => {
      const client = new MetaClient({ mode: 'simulated' });
      const session = createVirtualSession(boardId, fault.faultId);
      const run = await runAgenticDiagnosis(session, client);

      expect(run.proposedDiagnosis.componentRef).toBe(fault.targetComponentRef);
      expect(run.proposedDiagnosis.faultType).toBe(fault.faultType);
      expect(run.proposedDiagnosis.verificationStatus).toBe('confirmed');
      expect(run.score).not.toBeNull();
      expect(run.score!.componentMatch).toBe(true);
      expect(run.score!.faultTypeMatch).toBe(true);
      expect(run.score!.evidenceConfirmed).toBe(true);
      expect(run.turns).toBeLessThanOrEqual(AGENTIC_MAX_TURNS);
      expect(run.turns).toBeLessThanOrEqual(3);
      expect(run.operationalMode).toBe('SIMULATED');

      // Turn stream narrates probing → continuity → diagnosis.
      const summaries = run.steps.map((s) => s.summary).join('\n');
      expect(summaries).toMatch(/Probing nominal rails/);
      expect(summaries).toMatch(/measure_node_voltage/);
      expect(summaries).toMatch(/Submitting evidence-backed diagnosis/);

      // No ground-truth leakage anywhere in the observable run record.
      const record = JSON.stringify({ steps: run.steps, proposed: run.proposedDiagnosis });
      expect(record).not.toContain(fault.faultId);
      expect(record).not.toContain('targetComponentRef');
      expect(record).not.toContain('HiddenFault');

      // Simulated telemetry: zero incurred cost, honest projected live cost.
      expect(run.telemetry.totalRequests).toBeGreaterThanOrEqual(2);
      expect(run.telemetry.failedRequests).toBe(0);
      expect(run.telemetry.inputTokens).toBeGreaterThan(0);
      expect(run.telemetry.outputTokens).toBeGreaterThan(0);
      expect(run.telemetry.incurredCostUsd).toBe(0);
      expect(run.telemetry.estimatedCostUsd).toBe(0);
      expect(run.telemetry.runtimeConsumptionUsd).toBe(0);
      expect(run.telemetry.projectedLiveCostUsd).toBeGreaterThan(0);
      expect(run.telemetry.providerReportedUsage).toBe(false);
    });
  }

  it('reports healthy boards without crashing and leaves the score null', async () => {
    const client = new MetaClient({ mode: 'simulated' });
    const session = createVirtualSession('usbc-pd-trigger', 'nominal');
    const run = await runAgenticDiagnosis(session, client);
    expect(run.proposedDiagnosis.faultType).toBe('no_fault');
    expect(run.proposedDiagnosis.componentRef).toBe('none');
    expect(run.score).toBeNull();
    expect(run.turns).toBeLessThanOrEqual(AGENTIC_MAX_TURNS);
  });

  it('keeps every turn prompt under the 1,500-token compact budget', () => {
    for (const board of listReferenceBoards()) {
      const session = createVirtualSession(board.boardId, board.faults[0]!.faultId);
      const view = session.getAgentView();
      const prompt = `${buildAgentSystemPrompt(view.maxToolCalls)}\n${buildAgentUserPrompt(view)}`;
      expect(estimateTokens(prompt)).toBeLessThan(1500);
      expect(estimateConversationTokens([
        { role: 'system', content: buildAgentSystemPrompt(view.maxToolCalls) },
        { role: 'user', content: buildAgentUserPrompt(view) },
      ])).toBeLessThan(1500);
    }
  });
});

describe('FINAL_DIAGNOSIS parsing', () => {
  it('parses trailing JSON after the marker', () => {
    const parsed = parseFinalDiagnosis(
      `Some reasoning.\n${FINAL_DIAGNOSIS_MARKER} {"componentRef": "D2", "faultType": "shorted_component", "verificationStatus": "confirmed", "explanation": "CC1 clamped."}`,
    );
    expect(parsed).toMatchObject({ componentRef: 'D2', faultType: 'shorted_component', verificationStatus: 'confirmed' });
  });

  it('parses fenced JSON blocks', () => {
    const parsed = parseFinalDiagnosis(
      `${FINAL_DIAGNOSIS_MARKER}\n\`\`\`json\n{"componentRef": "F1", "faultType": "open_circuit"}\n\`\`\``,
    );
    expect(parsed).toMatchObject({ componentRef: 'F1', faultType: 'open_circuit', verificationStatus: 'hypothesis' });
  });

  it('rejects missing markers, malformed JSON, and unknown fault types', () => {
    expect(parseFinalDiagnosis('just reasoning, no marker')).toBeNull();
    expect(parseFinalDiagnosis(`${FINAL_DIAGNOSIS_MARKER} {not json`)).toBeNull();
    expect(parseFinalDiagnosis(`${FINAL_DIAGNOSIS_MARKER} {"componentRef": "D2", "faultType": "frobnicator"}`)).toBeNull();
    expect(parseFinalDiagnosis(`${FINAL_DIAGNOSIS_MARKER} {"faultType": "open_circuit"}`)).toBeNull();
  });
});

describe('live multi-turn tool-calling conversation (mocked fetch)', () => {
  function scriptedFetch(): { fetchFn: FetchFn; calls: unknown[] } {
    const calls: unknown[] = [];
    let n = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      calls.push(JSON.parse(init.body ?? ''));
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: 'CC1 reads 0V while CC2 is healthy; checking for a short to ground.',
                tool_calls: [{ id: 'tc-live-1', function: { name: 'measure_node_voltage', arguments: JSON.stringify({ node: 'CC1' }) } }],
              },
            }],
            usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: `CC1 clamped at 0.000 V with 0.200 Ω continuity to GND. ${FINAL_DIAGNOSIS_MARKER} {"componentRef": "D2", "faultType": "shorted_component", "verificationStatus": "confirmed", "explanation": "CC1 clamped with dead-short continuity while CC2 is healthy: TVS D2 failed short."}`,
              tool_calls: [],
            },
          }],
          usage: { prompt_tokens: 520, completion_tokens: 90, total_tokens: 610 },
        }),
      };
    };
    return { fetchFn, calls };
  }

  it('runs assistant tool_calls → tool results → final conclusion as LIVE_API with exact telemetry', async () => {
    const { fetchFn, calls } = scriptedFetch();
    const client = new MetaClient({ mode: 'live', apiKey: 'test-key', fetchFn });
    const session = createVirtualSession('usbc-pd-trigger', 'usbc-d2-shorted');
    const run = await runAgenticDiagnosis(session, client);

    expect(run.turns).toBe(2);
    expect(run.proposedDiagnosis).toMatchObject({ componentRef: 'D2', faultType: 'shorted_component' });
    expect(run.operationalMode).toBe('LIVE_API');
    expect(client.status().liveVerified).toBe(true);

    const kinds = run.steps.map((s) => s.kind);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_result');
    expect(run.steps.some((s) => s.kind === 'tool_result' && s.summary.includes('CC1'))).toBe(true);

    // The tool call really executed against the MNA bench.
    expect(session.getProbeLog().some((p) => p.target === 'CC1')).toBe(true);

    // Provider usage wins over local estimates, summed across both turns.
    expect(run.telemetry.totalRequests).toBe(2);
    expect(run.telemetry.failedRequests).toBe(0);
    expect(run.telemetry.providerReportedUsage).toBe(true);
    expect(run.telemetry.inputTokens).toBe(400 + 520);
    expect(run.telemetry.outputTokens).toBe(60 + 90);
    const expectedCost = estimateLiveCostUsd(920, 150);
    expect(run.telemetry.incurredCostUsd).toBeCloseTo(expectedCost, 12);
    expect(run.telemetry.projectedLiveCostUsd).toBeCloseTo(expectedCost, 12);

    // maxTokens guard applied on the wire.
    for (const body of calls as Array<{ max_tokens?: unknown }>) {
      expect(typeof body.max_tokens).toBe('number');
      expect(body.max_tokens as number).toBeLessThanOrEqual(1024);
    }

    expect(run.score).not.toBeNull();
    expect(run.score!.componentMatch).toBe(true);
    expect(run.score!.faultTypeMatch).toBe(true);
  });
});

describe('bounded retry and budget guards (MetaClient)', () => {
  it('retries once on transient 503, then succeeds', async () => {
    let n = 0;
    const client = new MetaClient({
      mode: 'live',
      apiKey: 'k',
      fetchFn: async () => {
        n += 1;
        if (n === 1) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }) };
      },
    });
    const res = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('ok');
    expect(n).toBe(2);
    const t = client.getTelemetry();
    expect(t.totalRequests).toBe(1);
    expect(t.retriedRequests).toBe(1);
    expect(t.failedRequests).toBe(0);
  });

  it('never retries 4xx/401/500 and counts the failure', async () => {
    for (const status of [400, 401, 403, 500]) {
      let n = 0;
      const client = new MetaClient({
        mode: 'live',
        apiKey: 'k',
        fetchFn: async () => {
          n += 1;
          return { ok: false, status, json: async () => ({}) };
        },
      });
      await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(`HTTP ${status}`);
      expect(n).toBe(1);
      const t = client.getTelemetry();
      expect(t.failedRequests).toBe(1);
      expect(t.retriedRequests).toBe(0);
    }
  });

  it('never retries the proxy key-missing 503', async () => {
    const g = globalThis as Record<string, unknown>;
    const hadWindow = g['window'];
    g['window'] = {};
    try {
      let n = 0;
      const client = new MetaClient({
        mode: 'live',
        fetchFn: async () => {
          n += 1;
          return { ok: false, status: 503, json: async () => ({ error: PROXY_KEY_MISSING_MESSAGE }) };
        },
      });
      await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
        /not configured on the local server proxy/,
      );
      expect(n).toBe(1);
      expect(client.getTelemetry().retriedRequests).toBe(0);
    } finally {
      if (hadWindow === undefined) delete g['window'];
      else g['window'] = hadWindow;
    }
  });

  it('clamps maxTokens and classifies retryable errors', () => {
    expect(clampMaxTokens(undefined)).toBe(1024);
    expect(clampMaxTokens(8192)).toBe(1024);
    expect(clampMaxTokens(100)).toBe(100);
    expect(isRetryableChatError(new Error('Meta Model API error: HTTP 503'))).toBe(true);
    expect(isRetryableChatError(new Error('Meta Model API error: HTTP 500'))).toBe(false);
    expect(isRetryableChatError(new Error('Meta Model API error: HTTP 401'))).toBe(false);
    expect(isRetryableChatError(new Error('Live Meta API key is not configured on the local server proxy. x'))).toBe(false);
    expect(isRetryableChatError(new Error('Meta Model API request timed out after 30000 ms.'))).toBe(false);
  });

  it('resets telemetry to a zeroed ledger', async () => {
    const client = new MetaClient({ mode: 'simulated' });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(client.getTelemetry().totalRequests).toBe(1);
    client.resetTelemetry();
    const t = client.getTelemetry();
    expect(t.totalRequests).toBe(0);
    expect(t.inputTokens).toBe(0);
    expect(t.incurredCostUsd).toBe(0);
    expect(t.codingAgentBudgetUsd).toBe(80);
  });
});

describe('proxy budget guards (meta-proxy)', () => {
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      end(b: string) {
        this.body = b;
      },
    };
  }

  it('forwards upstream usage without echoing the key and clamps max_tokens', async () => {
    const secret = 'sk-test-proxy-secret';
    const seen: Array<{ body: string; headers: Record<string, string> }> = [];
    const res = fakeRes();
    await handleMetaProxyRequest(
      { method: 'POST', url: '/api/meta/chat', body: { model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8192 } },
      res,
      {
        getApiKey: () => secret,
        fetchFn: async (_url, init) => {
          seen.push({ body: init.body ?? '', headers: init.headers });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: 'live!', tool_calls: [] } }],
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            }),
          };
        },
      },
    );
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body) as { usage?: { prompt_tokens?: number } };
    expect(payload.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    expect(res.body).not.toContain(secret);
    const upstream = JSON.parse(seen[0]!.body) as { max_tokens?: number };
    expect(upstream.max_tokens).toBe(1024);
  });

  it('applies the default max_tokens of 1024 when the caller omits it', async () => {
    const seen: string[] = [];
    const res = fakeRes();
    await handleMetaProxyRequest(
      { method: 'POST', url: '/api/meta/chat', body: { messages: [{ role: 'user', content: 'hi' }] } },
      res,
      {
        getApiKey: () => 'k',
        fetchFn: async (_u, init) => {
          seen.push(init.body ?? '');
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }) };
        },
      },
    );
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(seen[0]!) as { max_tokens?: number }).max_tokens).toBe(1024);
  });

  it('rejects oversized bodies with 413 before touching upstream', async () => {
    let upstreamHit = false;
    const res = fakeRes();
    await handleMetaProxyRequest(
      {
        method: 'POST',
        url: '/api/meta/chat',
        body: { messages: [], padding: 'x'.repeat(META_PROXY_MAX_BODY_BYTES) },
      },
      res,
      {
        getApiKey: () => 'k',
        fetchFn: async () => {
          upstreamHit = true;
          return { ok: true, status: 200, json: async () => ({}) };
        },
      },
    );
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: PROXY_BODY_TOO_LARGE_MESSAGE });
    expect(upstreamHit).toBe(false);
  });

  it('clamps proxy maxTokens inputs', () => {
    expect(clampProxyMaxTokens(undefined)).toBe(1024);
    expect(clampProxyMaxTokens(99999)).toBe(1024);
    expect(clampProxyMaxTokens(256)).toBe(256);
  });
});

describe('pre-live validation: proxy wire format + status forwarding', () => {
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      end(b: string) {
        this.body = b;
      },
    };
  }

  interface WireToolCall {
    id?: unknown;
    type?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  }
  interface WireBody {
    tools?: Array<{ type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } }>;
    messages: Array<{ role?: unknown; content?: unknown; tool_calls?: WireToolCall[]; tool_call_id?: unknown }>;
  }

  it('normalizes flat tools + internal tool_calls to OpenAI wire shape upstream', async () => {
    const seen: string[] = [];
    const res = fakeRes();
    await handleMetaProxyRequest(
      {
        method: 'POST',
        url: '/api/meta/chat',
        body: {
          model: 'muse-spark-1.3',
          messages: [
            { role: 'user', content: 'CC1 stuck at 0V' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'tc-1', name: 'measure_node_voltage', arguments: { node: 'CC1' } }],
            },
            { role: 'tool', content: '{"node":"CC1","volts":0}', tool_call_id: 'tc-1' },
          ],
          tools: [
            { name: 'measure_node_voltage', description: 'flat tool', parameters: { type: 'object' } },
            {
              type: 'function',
              function: { name: 'check_continuity', description: 'wrapped tool', parameters: { type: 'object' } },
            },
          ],
        },
      },
      res,
      {
        getApiKey: () => 'k',
        fetchFn: async (_u, init) => {
          seen.push(init.body ?? '');
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }) };
        },
      },
    );
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    const upstream = JSON.parse(seen[0]!) as WireBody;
    // Every tool wrapped, flat or pre-wrapped alike.
    expect(upstream.tools).toHaveLength(2);
    for (const t of upstream.tools ?? []) {
      expect(t.type).toBe('function');
      expect(typeof t.function?.name).toBe('string');
      expect(typeof t.function?.description).toBe('string');
      expect(t.function?.parameters).toBeDefined();
    }
    expect(upstream.tools?.[0]?.function?.name).toBe('measure_node_voltage');
    expect(upstream.tools?.[1]?.function?.name).toBe('check_continuity');
    // Assistant content defaulted to '' and internal tool_calls serialized.
    const assistant = upstream.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(assistant).toBeDefined();
    expect(assistant!.content).toBe('');
    expect(assistant!.tool_calls).toHaveLength(1);
    expect(assistant!.tool_calls?.[0]?.type).toBe('function');
    expect(assistant!.tool_calls?.[0]?.function?.name).toBe('measure_node_voltage');
    expect(typeof assistant!.tool_calls?.[0]?.function?.arguments).toBe('string');
    expect(JSON.parse(assistant!.tool_calls?.[0]?.function?.arguments as string)).toEqual({ node: 'CC1' });
    // role: 'tool' result message preserved with its tool_call_id.
    expect(upstream.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'tc-1')).toBe(true);
  });

  it('browser proxy mode sends OpenAI-valid tools on Turn 1 and wire tool_calls + tool messages on Turn 2', async () => {
    const g = globalThis as Record<string, unknown>;
    const hadWindow = g['window'];
    g['window'] = {};
    try {
      const upstreamBodies: WireBody[] = [];
      const upstreamFetch = async (
        _url: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ) => {
        const parsed = JSON.parse(init.body ?? '') as WireBody;
        upstreamBodies.push(parsed);
        const hasToolMsg = parsed.messages.some((m) => m.role === 'tool');
        if (!hasToolMsg) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{
                message: {
                  content: 'CC1 reads 0V while CC2 is healthy; checking for a short to ground.',
                  tool_calls: [{
                    id: 'tc-live-1',
                    function: { name: 'measure_node_voltage', arguments: JSON.stringify({ node: 'CC1' }) },
                  }],
                },
              }],
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: `CC1 clamped. ${FINAL_DIAGNOSIS_MARKER} {"componentRef": "D2", "faultType": "shorted_component", "verificationStatus": "confirmed", "explanation": "bench evidence"}`,
                tool_calls: [],
              },
            }],
          }),
        };
      };
      const proxyFetch: FetchFn = async (_url, init) => {
        const res = fakeRes();
        await handleMetaProxyRequest(
          { method: 'POST', url: '/api/meta/chat', body: JSON.parse(init.body ?? '') },
          res,
          { getApiKey: () => 'emulated-proxy-key', fetchFn: upstreamFetch },
        );
        return {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(res.body) as unknown,
        };
      };
      const client = new MetaClient({ mode: 'live', fetchFn: proxyFetch, proxyBaseUrl: '/api/meta' });
      expect(client.usesProxyRoute()).toBe(true);

      // Turn 1: flat ToolDefinitions must arrive upstream OpenAI-wrapped.
      const r1 = await client.chat({
        messages: [{ role: 'user', content: 'CC1 stuck at 0V' }],
        tools: TOOL_DEFINITIONS,
      });
      expect(r1.toolCalls).toHaveLength(1);
      const turn1 = upstreamBodies[0]!;
      expect((turn1.tools ?? []).length).toBeGreaterThan(0);
      for (const t of turn1.tools ?? []) {
        expect(t.type).toBe('function');
        expect(typeof t.function?.name).toBe('string');
        expect(typeof t.function?.description).toBe('string');
        expect(t.function?.parameters).toBeDefined();
      }

      // Turn 2: internal-shape assistant tool_calls + role: 'tool' message.
      const r2 = await client.chat({
        messages: [
          { role: 'user', content: 'CC1 stuck at 0V' },
          { role: 'assistant', content: r1.content, tool_calls: r1.toolCalls },
          {
            role: 'tool',
            content: JSON.stringify({ node: 'CC1', volts: 0, formatted: '0.000 V' }),
            tool_call_id: r1.toolCalls[0]!.id,
          },
        ],
        tools: TOOL_DEFINITIONS,
      });
      expect(r2.content).toContain('CC1 clamped');
      const turn2 = upstreamBodies[1]!;
      const assistant = turn2.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
      expect(assistant).toBeDefined();
      expect(assistant!.tool_calls).toHaveLength(1);
      expect(assistant!.tool_calls?.[0]).toMatchObject({
        id: 'tc-live-1',
        type: 'function',
        function: { name: 'measure_node_voltage' },
      });
      expect(typeof assistant!.tool_calls?.[0]?.function?.arguments).toBe('string');
      expect(JSON.parse(assistant!.tool_calls?.[0]?.function?.arguments as string)).toEqual({ node: 'CC1' });
      expect(turn2.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'tc-live-1')).toBe(true);
    } finally {
      if (hadWindow === undefined) delete g['window'];
      else g['window'] = hadWindow;
    }
  });

  it('forwards upstream 400/401/403 verbatim (never 502) and MetaClient never retries them', async () => {
    const g = globalThis as Record<string, unknown>;
    const hadWindow = g['window'];
    g['window'] = {};
    try {
      for (const status of [400, 401, 403]) {
        const upstreamFetch = async () => ({
          ok: false,
          status,
          json: async () => ({ error: { message: 'upstream says no' } }),
        });
        // Server side: status preserved with upstream detail, never 502.
        const res = fakeRes();
        await handleMetaProxyRequest(
          { method: 'POST', url: '/api/meta/chat', body: { messages: [{ role: 'user', content: 'hi' }] } },
          res,
          { getApiKey: () => 'test-proxy-key', fetchFn: upstreamFetch },
        );
        expect(res.statusCode).toBe(status);
        const payload = JSON.parse(res.body) as { error?: string };
        expect(payload.error).toContain(`HTTP ${status}`);
        expect(payload.error).toContain('upstream says no');
        expect(res.body).not.toContain('test-proxy-key');

        // Client side through the proxy: single attempt, exact status surfaced.
        let n = 0;
        const proxyFetch: FetchFn = async (_url, init) => {
          n += 1;
          const inner = fakeRes();
          await handleMetaProxyRequest(
            { method: 'POST', url: '/api/meta/chat', body: JSON.parse(init.body ?? '') },
            inner,
            { getApiKey: () => 'k', fetchFn: upstreamFetch },
          );
          return {
            ok: inner.statusCode >= 200 && inner.statusCode < 300,
            status: inner.statusCode,
            json: async () => JSON.parse(inner.body) as unknown,
          };
        };
        const client = new MetaClient({ mode: 'live', fetchFn: proxyFetch, proxyBaseUrl: '/api/meta' });
        await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(`HTTP ${status}`);
        expect(n).toBe(1);
        expect(client.getTelemetry().retriedRequests).toBe(0);
        expect(client.getTelemetry().failedRequests).toBe(1);
      }
    } finally {
      if (hadWindow === undefined) delete g['window'];
      else g['window'] = hadWindow;
    }
  });

  it('safe-parses invalid tool arguments to {} on both proxy and client paths', () => {
    expect(safeParseToolArguments('not json{{')).toEqual({});
    expect(safeParseToolArguments('')).toEqual({});
    expect(safeParseToolArguments(undefined)).toEqual({});
    expect(safeParseToolArguments(null)).toEqual({});
    expect(safeParseToolArguments({ a: 1 })).toEqual({ a: 1 });
    expect(safeParseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(safeParseClientArgs('{bad')).toEqual({});
    expect(safeParseClientArgs('{"ok":true}')).toEqual({ ok: true });
    expect(safeParseClientArgs({ b: 2 })).toEqual({ b: 2 });
  });

  it('normalizes already-wrapped tools/messages idempotently', () => {
    const wrapped = [{ type: 'function', function: { name: 'n', description: 'd', parameters: { type: 'object' } } }];
    expect(normalizeProxyTools(wrapped)).toEqual(wrapped);
    const msgs = normalizeProxyMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'x', type: 'function', function: { name: 'n', arguments: '{"a":1}' } }],
      },
    ]);
    expect(msgs[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'x', type: 'function', function: { name: 'n', arguments: '{"a":1}' } }],
    });
  });

  it('parses .env bodies for live key detection without caching empties', () => {
    expect(parseDotEnvApiKey('# comment\nMETA_API_KEY="test-key-123"\n')).toBe('test-key-123');
    expect(parseDotEnvApiKey("META_API_KEY='abc' # trailing\n")).toBe('abc');
    expect(parseDotEnvApiKey('OTHER=1\nMETA_API_KEY=  xyz  \n')).toBe('xyz');
    expect(parseDotEnvApiKey('META_API_KEY=\n')).toBeUndefined();
    expect(parseDotEnvApiKey('# META_API_KEY=commented\n')).toBeUndefined();
    expect(parseDotEnvApiKey('')).toBeUndefined();
  });
});

describe('proxyStatus GET request shape (spec-compliant fetch)', () => {
  it('omits body on GET /status so real WhatWG fetch never throws', async () => {
    const seen: Array<{ url: string; method: string; hasBody: boolean }> = [];
    const strictFetch: FetchFn = async (url, init) => {
      // Real browsers/Node throw `TypeError: Request with GET/HEAD method
      // cannot have body` — emulate that exactly.
      if (init.method === 'GET' && 'body' in init) {
        throw new TypeError('Request with GET/HEAD method cannot have body.');
      }
      seen.push({ url, method: init.method, hasBody: 'body' in init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ configured: true, mode: 'UNVERIFIED' as const }),
      };
    };
    const client = new MetaClient({ mode: 'live', fetchFn: strictFetch, proxyBaseUrl: '/api/meta' });
    await expect(client.proxyStatus()).resolves.toEqual({ configured: true, mode: 'UNVERIFIED' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ url: '/api/meta/status', method: 'GET', hasBody: false });
  });
});

describe('diagnosis provenance (diagnosisSource)', () => {
  it("marks model_final_diagnosis when the model emits FINAL_DIAGNOSIS JSON", async () => {
    let n = 0;
    const fetchFn: FetchFn = async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: 'CC1 reads 0V while CC2 is healthy; checking for a short to ground.',
                tool_calls: [{ id: 'tc-src-1', function: { name: 'measure_node_voltage', arguments: JSON.stringify({ node: 'CC1' }) } }],
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: `CC1 clamped. ${FINAL_DIAGNOSIS_MARKER} {"componentRef": "D2", "faultType": "shorted_component", "verificationStatus": "confirmed", "explanation": "CC1 clamped with dead-short continuity while CC2 is healthy: TVS D2 failed short."}`,
              tool_calls: [],
            },
          }],
        }),
      };
    };
    const client = new MetaClient({ mode: 'live', apiKey: 'test-key', fetchFn });
    const session = createVirtualSession('usbc-pd-trigger', 'usbc-d2-shorted');
    const run = await runAgenticDiagnosis(session, client);
    expect(run.proposedDiagnosis).toMatchObject({ componentRef: 'D2', faultType: 'shorted_component' });
    expect(run.diagnosisSource).toBe('model_final_diagnosis');
  });

  it('marks evidence_fallback for the deterministic simulated policy', async () => {
    const client = new MetaClient({ mode: 'simulated' });
    const session = createVirtualSession('usbc-pd-trigger', 'usbc-d2-shorted');
    const run = await runAgenticDiagnosis(session, client);
    expect(run.proposedDiagnosis).toMatchObject({ componentRef: 'D2', faultType: 'shorted_component' });
    expect(run.diagnosisSource).toBe('evidence_fallback');
  });
});

describe('reasoning_effort wire parameter (upstream HTTP 400 fix)', () => {
  function fakeRes() {
    return {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      end(b: string) {
        this.body = b;
      },
    };
  }

  async function postChat(body: Record<string, unknown>, seen: string[]): Promise<ReturnType<typeof fakeRes>> {
    const res = fakeRes();
    await handleMetaProxyRequest(
      { method: 'POST', url: '/api/meta/chat', body },
      res,
      {
        getApiKey: () => 'test-proxy-key',
        fetchFn: async (_u, init) => {
          seen.push(init.body ?? '');
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }) };
        },
      },
    );
    expect(res.statusCode).toBe(200);
    return res;
  }

  it("sends top-level reasoning_effort (never reasoning) when effort is supplied", async () => {
    const seen: string[] = [];
    await postChat({ messages: [{ role: 'user', content: 'hi' }], effort: 'low' }, seen);
    const upstream = JSON.parse(seen[0]!) as Record<string, unknown>;
    expect(upstream['reasoning_effort']).toBe('low');
    expect(upstream).not.toHaveProperty('reasoning');
  });

  it('resolves the legacy reasoning.effort shape to reasoning_effort', async () => {
    const seen: string[] = [];
    await postChat({ messages: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'low' } }, seen);
    const upstream = JSON.parse(seen[0]!) as Record<string, unknown>;
    expect(upstream['reasoning_effort']).toBe('low');
    expect(upstream).not.toHaveProperty('reasoning');
  });

  it('passes through an explicit reasoning_effort field without adding reasoning', async () => {
    const seen: string[] = [];
    await postChat({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' }, seen);
    const upstream = JSON.parse(seen[0]!) as Record<string, unknown>;
    expect(upstream['reasoning_effort']).toBe('low');
    expect(upstream).not.toHaveProperty('reasoning');
  });

  it('omits both keys when no effort is supplied', async () => {
    const seen: string[] = [];
    await postChat({ messages: [{ role: 'user', content: 'hi' }], }, seen);
    const upstream = JSON.parse(seen[0]!) as Record<string, unknown>;
    expect(upstream).not.toHaveProperty('reasoning_effort');
    expect(upstream).not.toHaveProperty('reasoning');
  });

  it('chatDirect sends reasoning_effort and no reasoning key to /chat/completions', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const client = new MetaClient({
      mode: 'live',
      apiKey: 'test-key',
      fetchFn: async (url, init) => {
        calls.push({ url, body: init.body ?? '' });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }) };
      },
    });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }], effort: 'low' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/chat/completions');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['reasoning_effort']).toBe('low');
    expect(body).not.toHaveProperty('reasoning');
  });
});

describe('live diagnosis uses concise reasoning effort', () => {
  it('runAgenticDiagnosis passes effort low on every live chat call', async () => {
    const wireBodies: Array<Record<string, unknown>> = [];
    let n = 0;
    const baseFetch: FetchFn = async (_url, init) => {
      wireBodies.push(JSON.parse(init.body ?? '') as Record<string, unknown>);
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: 'CC1 reads 0V while CC2 is healthy; checking for a short to ground.',
                tool_calls: [{ id: 'tc-eff-1', function: { name: 'measure_node_voltage', arguments: JSON.stringify({ node: 'CC1' }) } }],
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: `CC1 clamped. ${FINAL_DIAGNOSIS_MARKER} {"componentRef": "D2", "faultType": "shorted_component", "verificationStatus": "confirmed", "explanation": "bench evidence"}`,
              tool_calls: [],
            },
          }],
        }),
      };
    };
    class RecordingClient extends MetaClient {
      efforts: Array<string | undefined> = [];
      override async chat(req: ChatRequest): Promise<ChatResponse> {
        this.efforts.push(req.effort);
        return super.chat(req);
      }
    }
    const client = new RecordingClient({ mode: 'live', apiKey: 'test-key', fetchFn: baseFetch });
    const session = createVirtualSession('usbc-pd-trigger', 'usbc-d2-shorted');
    const run = await runAgenticDiagnosis(session, client);
    expect(run.proposedDiagnosis).toMatchObject({ componentRef: 'D2', faultType: 'shorted_component' });
    // Every live turn (plus any synthesis turn) requested concise thinking.
    expect(client.efforts.length).toBeGreaterThanOrEqual(2);
    for (const effort of client.efforts) expect(effort).toBe('low');
    // …and the wire proves it: top-level reasoning_effort, never reasoning.
    expect(wireBodies.length).toBeGreaterThanOrEqual(2);
    for (const body of wireBodies) {
      expect(body['reasoning_effort']).toBe('low');
      expect(body).not.toHaveProperty('reasoning');
    }
  });
});

describe('candidate component refs (ground-truth-free designator hints)', () => {
  it('lists physical designators only — synthetic MNA leakage ids excluded', () => {
    for (const board of listReferenceBoards()) {
      const session = createVirtualSession(board.boardId, board.faults[0]!.faultId);
      const refs = candidateComponentRefs(session.getAgentView());
      for (const c of session.getAgentView().nominalComponents) {
        if (SYNTHETIC_MNA_LEAKAGE_IDS.has(c.id)) expect(refs).not.toContain(c.id);
        else expect(refs).toContain(c.id);
      }
      for (const fault of board.faults) expect(refs).toContain(fault.targetComponentRef);
    }
    const usbc = candidateComponentRefs(createVirtualSession('usbc-pd-trigger', 'usbc-d2-shorted').getAgentView());
    expect(usbc).toContain('D2');
    expect(usbc).toContain('D3');
    expect(usbc).not.toContain('D2_TVS');
    expect(usbc).not.toContain('D3_TVS');
    const esp = candidateComponentRefs(createVirtualSession('esp32s3-sensor-node', 'esp32-c4-rev-leak').getAgentView());
    expect(esp).toContain('C4');
    const f405 = candidateComponentRefs(createVirtualSession('f405-flight-controller', 'f405-nrst-gnd-short').getAgentView());
    expect(f405).toContain('U1');
    expect(f405).not.toContain('R_NRSTPD');
  });

  it('buildAgentUserPrompt carries the candidate line and Turn 3 starts with FINAL_DIAGNOSIS', () => {
    const session = createVirtualSession('usbc-pd-trigger', 'usbc-d2-shorted');
    const prompt = buildAgentUserPrompt(session.getAgentView());
    expect(prompt).toMatch(/Candidate component refs:/);
    expect(prompt).toContain('D2');
    // The netlist still names the MNA leakage model, but now with its role
    // visible so the model can map it to the physical diode in the refs.
    expect(prompt).toContain('TVS leakage');
    const system = buildAgentSystemPrompt(session.getAgentView().maxToolCalls);
    expect(system).toContain('NO tool calls');
    expect(system).toContain('line 1');
    expect(system).toContain(FINAL_DIAGNOSIS_MARKER);
    expect(system).toContain('Candidate component refs');
    // Short-to-ground attribution: IC pin bridge vs connector-line TVS short.
    expect(system).toContain('solder_bridge');
    expect(system).toContain('shorted_component');
    expect(system).toContain('U1-15');
    expect(system).toContain('D2');
  });

  it('netlist lines carry component role descriptions', () => {
    const f405 = buildAgentUserPrompt(
      createVirtualSession('f405-flight-controller', 'f405-nrst-gnd-short').getAgentView(),
    );
    expect(f405).toContain('NRST leakage path to ground');
    expect(f405).toContain('NRST internal pull-up');
    const usbc = buildAgentUserPrompt(
      createVirtualSession('usbc-pd-trigger', 'usbc-d2-shorted').getAgentView(),
    );
    expect(usbc).toContain('TVS leakage');
  });

  it('assertGroundTruthIsolated still passes for all 9 fault scenarios', () => {
    const cases = listReferenceBoards().flatMap((b) => b.faults.map((f) => ({ boardId: b.boardId, fault: f })));
    expect(cases).toHaveLength(9);
    for (const { boardId, fault } of cases) {
      const session = createVirtualSession(boardId, fault.faultId);
      const view = session.getAgentView();
      const payload = {
        messages: [
          { role: 'system', content: buildAgentSystemPrompt(view.maxToolCalls) },
          { role: 'user', content: buildAgentUserPrompt(view) },
        ],
        tools: TOOL_DEFINITIONS,
      };
      expect(() => assertGroundTruthIsolated(payload, session.getGroundTruth())).not.toThrow();
    }
  });
});

describe('evidence-only classifier units', () => {
  it('separates a bridge beep from an open pull-up on identical 0V readings', () => {
    const session = createVirtualSession('f405-flight-controller', 'f405-nrst-gnd-short');
    const view = session.getAgentView();
    const volts = [
      { node: 'U1-14', volts: 3.2665, nominalVolts: 3.267, toleranceFrac: 0.05, abnormal: false },
      { node: 'U1-15', volts: 0.0, nominalVolts: 3.24, toleranceFrac: 0.05, abnormal: true },
    ];
    const bridge = classifyFromEvidence(view, volts, [{ probeA: 'U1-15', probeB: 'GND', ohms: 0.4, continuous: true }]);
    expect(bridge).toMatchObject({ componentRef: 'U1', faultType: 'solder_bridge', verificationStatus: 'confirmed' });
    const open = classifyFromEvidence(view, volts, [{ probeA: 'U1-15', probeB: 'GND', ohms: 4678013, continuous: false }]);
    expect(open).toMatchObject({ componentRef: 'R_PULLUP', faultType: 'open_circuit', verificationStatus: 'confirmed' });
  });
});
