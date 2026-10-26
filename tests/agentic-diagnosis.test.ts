import { describe, expect, it } from 'vitest';
import {
  AGENTIC_MAX_TURNS,
  FINAL_DIAGNOSIS_MARKER,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  classifyFromEvidence,
  estimateConversationTokens,
  parseFinalDiagnosis,
  runAgenticDiagnosis,
} from '../src/lib/diagnostic-agent';
import {
  createVirtualSession,
  listReferenceBoards,
} from '../src/lib/circuit-simulator';
import {
  MetaClient,
  clampMaxTokens,
  estimateLiveCostUsd,
  estimateTokens,
  isRetryableChatError,
  type FetchFn,
} from '../src/lib/meta-client';
import {
  META_PROXY_MAX_BODY_BYTES,
  PROXY_BODY_TOO_LARGE_MESSAGE,
  clampProxyMaxTokens,
  handleMetaProxyRequest,
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
      calls.push(JSON.parse(init.body));
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
          return { ok: false, status: 503, json: async () => ({}) };
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
          seen.push({ body: init.body, headers: init.headers });
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
          seen.push(init.body);
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
