import { describe, expect, it } from 'vitest';
import {
  MetaClient,
  TOOL_DEFINITIONS,
  SPARK_MODEL_ID,
  SPARK_CONTEXT_TOKENS,
  assembleDatasheetPayload,
  buildToolCallPayload,
  detectBoardId,
  estimateTokens,
  defaultSimulatedToolResult,
} from '../src/lib/meta-client';

describe('tool schema generation', () => {
  it('defines all four required tools with JSON schemas', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(names).toEqual([
      'check_continuity',
      'generate_rework_guidance',
      'lookup_pinout',
      'verify_rail_voltage',
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.required.length).toBeGreaterThan(0);
      for (const key of tool.parameters.required) {
        expect(tool.parameters.properties[key]).toBeDefined();
      }
    }
  });

  it('lookup_pinout requires part_number and pin_number', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'lookup_pinout')!;
    expect(tool.parameters.required).toEqual(['part_number', 'pin_number']);
  });
});

describe('request payload formatting', () => {
  it('builds a Meta API payload with model, messages, tools, and response format', () => {
    const payload = buildToolCallPayload({
      messages: [{ role: 'user', content: 'NRST reads 0V' }],
      tools: TOOL_DEFINITIONS,
      responseFormat: 'json',
      effort: 'medium',
    });
    expect(payload['model']).toBe(SPARK_MODEL_ID);
    expect(payload['messages']).toHaveLength(1);
    const tools = payload['tools'] as unknown[];
    expect(tools).toHaveLength(4);
    expect(payload['response_format']).toEqual({ type: 'json_object' });
    expect(payload['reasoning']).toEqual({ effort: 'medium' });
  });

  it('serializes tool calls with stringified arguments', () => {
    const payload = buildToolCallPayload({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc-1', name: 'lookup_pinout', arguments: { part_number: 'STM32F405RGT6', pin_number: '14' } }],
        },
      ],
    });
    const msgs = payload['messages'] as Array<{ tool_calls: Array<{ function: { arguments: string } }> }>;
    expect(JSON.parse(msgs[0]!.tool_calls[0]!.function.arguments)).toEqual({
      part_number: 'STM32F405RGT6',
      pin_number: '14',
    });
  });
});

describe('datasheet payload assembly', () => {
  it('assembles sections with citation markers within the 1M window', () => {
    const result = assembleDatasheetPayload([
      { title: 'A', text: 'pinout data' },
      { title: 'B', text: 'electricals' },
    ]);
    expect(result.text).toContain('[DATASHEET: A]');
    expect(result.sectionsIncluded).toEqual(['A', 'B']);
    expect(result.estimatedTokens).toBeLessThan(SPARK_CONTEXT_TOKENS);
    expect(result.truncated).toBe(false);
  });

  it('truncates when exceeding maxTokens', () => {
    const big = 'x'.repeat(4000);
    const result = assembleDatasheetPayload(
      [
        { title: 'A', text: big },
        { title: 'B', text: big },
      ],
      1500,
    );
    expect(result.truncated).toBe(true);
    expect(result.sectionsIncluded).toEqual(['A']);
  });

  it('estimates ~1 token per 4 chars', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('MetaClient simulation mode', () => {
  it('defaults to simulated mode without an API key', () => {
    const client = new MetaClient({ mode: 'simulated' });
    expect(client.mode).toBe('simulated');
    expect(client.status()).toMatchObject({ model: 'muse-spark-1.3', contextTokens: 1_048_576, segmenter: 'sam-3.1' });
  });

  it('returns a fixture trace for a known board', async () => {
    const client = new MetaClient({ mode: 'simulated' });
    const res = await client.chat({
      messages: [{ role: 'user', content: 'STM32 F405 flight controller held in reset' }],
    });
    expect(res.simulated).toBe(true);
    expect(res.content).toContain('DIAGNOSIS');
    expect(res.toolCalls.length).toBeGreaterThan(0);
  });

  it('streams fixture content as deltas ending in the full response', async () => {
    const client = new MetaClient({ mode: 'simulated' });
    let streamed = '';
    const final = await (async () => {
      const gen = client.streamChat({ messages: [{ role: 'user', content: 'USB-C PD trigger CC1 fault' }] });
      let out: unknown;
      for await (const d of gen) {
        streamed += d;
        out = d;
      }
      void out;
      return gen;
    })();
    void final;
    // Re-run to capture the returned response object via manual iteration
    const gen2 = client.streamChat({ messages: [{ role: 'user', content: 'USB-C PD trigger CC1 fault' }] });
    let response;
    let text = '';
    while (true) {
      const n = await gen2.next();
      if (n.done) {
        response = n.value;
        break;
      }
      text += n.value;
    }
    expect(text).toBe(response.content);
    expect(streamed.length).toBeGreaterThan(0);
  });

  it('live mode posts to the Meta Model API with bearer auth', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const client = new MetaClient({
      mode: 'live',
      apiKey: 'test-key',
      fetchFn: async (url, init) => {
        calls.push({ url, body: init.body, headers: init.headers });
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }),
        };
      },
    });
    const res = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.mode).toBe('live');
    expect(calls[0]!.url).toContain('/chat/completions');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer test-key');
  });

  it('live mode throws on HTTP errors', async () => {
    const client = new MetaClient({
      mode: 'live',
      apiKey: 'k',
      fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('HTTP 500');
  });

  it('executes simulated tools deterministically', () => {
    const client = new MetaClient({ mode: 'simulated' });
    const pin = client.executeTool('lookup_pinout', { part_number: 'STM32F405RGT6', pin_number: '15' }) as { function: string };
    expect(pin.function).toContain('NRST');
    const cont = client.executeTool('check_continuity', { probe_a: 'U1-14', probe_b: 'U1-15' }) as { resistance_ohms: number };
    expect(cont.resistance_ohms).toBe(0.4);
  });

  it('defaultSimulatedToolResult reports open circuits for unrelated nets', () => {
    const r = defaultSimulatedToolResult('check_continuity', { probe_a: 'TP_5V', probe_b: 'GND' }) as { resistance_ohms: number };
    expect(r.resistance_ohms).toBeGreaterThan(1_000_000);
  });

  it('detectBoardId matches each sample board', () => {
    expect(detectBoardId('STM32 flight controller issue')).toBe('f405-flight-controller');
    expect(detectBoardId('ESP32 sensor node brownout')).toBe('esp32s3-sensor-node');
    expect(detectBoardId('USB-C PD trigger CC1 short')).toBe('usbc-pd-trigger');
    expect(detectBoardId('unrelated toaster')).toBeUndefined();
  });
});
