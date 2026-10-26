/**
 * Meta Model API client layer for TraceForge Phase 1.
 *
 * Covers `muse-spark-1.3` (reasoning / structured outputs / tool calling)
 * and `sam-3.1` (visual segmentation), plus a deterministic simulation
 * fixture mode so tests and offline demos run without API keys.
 */

export const SPARK_MODEL_ID = 'muse-spark-1.3' as const;
export const SAM_MODEL_ID = 'sam-3.1' as const;
export const SPARK_CONTEXT_TOKENS = 1_048_576;

export type ModelId = typeof SPARK_MODEL_ID | typeof SAM_MODEL_ID;
export type ClientMode = 'live' | 'simulated';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max';

/** JSON-schema subset used for tool parameter definitions. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name:
    | 'lookup_pinout'
    | 'verify_rail_voltage'
    | 'check_continuity'
    | 'generate_rework_guidance';
  description: string;
  parameters: JsonSchema;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on tool-result messages. */
  tool_call_id?: string;
  /** Present on assistant messages that invoke tools. */
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: ToolDefinition['name'];
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  model?: ModelId;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  responseFormat?: 'text' | 'json';
  effort?: ReasoningEffort;
  stream?: boolean;
  maxTokens?: number;
}

export interface ChatResponse {
  model: ModelId;
  mode: ClientMode;
  content: string;
  toolCalls: ToolCall[];
  /** True when `content` was produced from a pre-recorded fixture. */
  simulated: boolean;
}

export interface DatasheetSection {
  title: string;
  text: string;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'lookup_pinout',
    description:
      'Look up the pinout entry for a component part number and pin number from the loaded datasheet context.',
    parameters: {
      type: 'object',
      properties: {
        part_number: { type: 'string', description: 'Manufacturer part number, e.g. STM32F405RGT6.' },
        pin_number: { type: 'string', description: 'Pin designator, e.g. "14" or "PA9".' },
      },
      required: ['part_number', 'pin_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_rail_voltage',
    description:
      'Compare a measured rail voltage against the nominal rail spec with tolerance.',
    parameters: {
      type: 'object',
      properties: {
        rail_name: { type: 'string', description: 'Rail net name, e.g. "3V3" or "5V".' },
        measured_volts: { type: 'number', description: 'Measured voltage in volts.' },
      },
      required: ['rail_name', 'measured_volts'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_continuity',
    description:
      'Check continuity between two probe points or pins and report resistance.',
    parameters: {
      type: 'object',
      properties: {
        probe_a: { type: 'string', description: 'First probe point id, e.g. "TP3" or "U1-14".' },
        probe_b: { type: 'string', description: 'Second probe point id.' },
      },
      required: ['probe_a', 'probe_b'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_rework_guidance',
    description:
      'Generate step-by-step soldering/rework instructions for a fault type and component reference.',
    parameters: {
      type: 'object',
      properties: {
        fault_type: {
          type: 'string',
          description: 'Fault class, e.g. "solder_bridge", "reverse_polarity", "shorted_diode".',
        },
        component_ref: { type: 'string', description: 'Board reference designator, e.g. "U1", "C4", "D2".' },
      },
      required: ['fault_type', 'component_ref'],
      additionalProperties: false,
    },
  },
];

/** Build a tool-call payload in the Meta Model API shape. */
export function buildToolCallPayload(request: ChatRequest): Record<string, unknown> {
  return {
    model: request.model ?? SPARK_MODEL_ID,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls
        ? {
            tool_calls: m.tool_calls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.arguments) },
            })),
          }
        : {}),
    })),
    ...(request.tools
      ? {
          tools: request.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }
      : {}),
    ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
    ...(request.stream ? { stream: true } : {}),
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
  };
}

/** Rough token estimate (chars / 4) used for payload budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface AssembledDatasheet {
  text: string;
  estimatedTokens: number;
  truncated: boolean;
  sectionsIncluded: string[];
}

/**
 * Assemble datasheet sections into one long-context payload, newest /
 * most-relevant first, truncating at `maxTokens` (default: full 1M window
 * minus a reasoning reserve).
 */
export function assembleDatasheetPayload(
  sections: DatasheetSection[],
  maxTokens = SPARK_CONTEXT_TOKENS - 65_536,
): AssembledDatasheet {
  const included: string[] = [];
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;

  for (const section of sections) {
    const chunk = `[DATASHEET: ${section.title}]\n${section.text}`;
    const cost = estimateTokens(chunk);
    if (used + cost > maxTokens) {
      truncated = true;
      break;
    }
    chunks.push(chunk);
    included.push(section.title);
    used += cost;
  }

  const text = chunks.join('\n\n');
  return { text, estimatedTokens: used, truncated, sectionsIncluded: included };
}

/** Minimal fetch-compatible signature so tests can inject fakes. */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface MetaClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Force a mode; defaults to `live` when an API key is present. */
  mode?: ClientMode;
  model?: ModelId;
  fetchFn?: FetchFn;
  /** Override simulated tool handlers per tool name. */
  simulatedTools?: Partial<Record<ToolDefinition['name'], (args: Record<string, unknown>) => unknown>>;
}

export interface SimulatedTrace {
  boardId: string;
  reasoning: string[];
  toolCalls: ToolCall[];
  citations: string[];
  diagnosis: string;
}

const DEFAULT_SIMULATED_TRACES: SimulatedTrace[] = [
  {
    boardId: 'f405-flight-controller',
    reasoning: [
      'Symptom: MCU held in reset, NRST reads 0.0V instead of 3.3V pull-up.',
      'lookup_pinout(STM32F405RGT6, 14) -> VDD 3.3V; pin 15 -> NRST (active-low reset).',
      'check_continuity(U1-14, U1-15) -> 0.4 ohm: direct short between adjacent pins.',
      'Conclusion: microscopic solder bridge pins 14-15 holds MCU in perpetual reset.',
    ],
    toolCalls: [
      { id: 'tc-1', name: 'lookup_pinout', arguments: { part_number: 'STM32F405RGT6', pin_number: '14' } },
      { id: 'tc-2', name: 'check_continuity', arguments: { probe_a: 'U1-14', probe_b: 'U1-15' } },
      { id: 'tc-3', name: 'generate_rework_guidance', arguments: { fault_type: 'solder_bridge', component_ref: 'U1' } },
    ],
    citations: ['STM32F405 datasheet §3 Pinouts, Table 5 (LQFP64)', 'STM32F405 §5.3.1 NRST electricals'],
    diagnosis: 'Solder bridge between STM32 Pin 14 (3.3V) and Pin 15 (NRST).',
  },
  {
    boardId: 'esp32s3-sensor-node',
    reasoning: [
      'Symptom: 5V rail sags to 4.2V, brownout resets, hot spot near C4.',
      'verify_rail_voltage(5V, 4.2) -> out of ±5% tolerance.',
      'Polarity check: tantalum C4 fitted reversed; reverse leakage draws excess current and overheats.',
    ],
    toolCalls: [
      { id: 'tc-1', name: 'verify_rail_voltage', arguments: { rail_name: '5V', measured_volts: 4.2 } },
      { id: 'tc-2', name: 'generate_rework_guidance', arguments: { fault_type: 'reverse_polarity', component_ref: 'C4' } },
    ],
    citations: ['ESP32-S3 datasheet §4.3 power/brownout', 'Tantalum capacitor polarity application note'],
    diagnosis: 'Reverse-polarity tantalum capacitor C4 on the 5V rail.',
  },
  {
    boardId: 'usbc-pd-trigger',
    reasoning: [
      'Symptom: no PD negotiation, CC1 stuck at 0V.',
      'check_continuity(CC1, GND) -> 0.2 ohm: dead short to ground.',
      'TVS diode D2 failed short (typical EOS failure mode), clamping CC1 to GND.',
    ],
    toolCalls: [
      { id: 'tc-1', name: 'check_continuity', arguments: { probe_a: 'CC1', probe_b: 'GND' } },
      { id: 'tc-2', name: 'generate_rework_guidance', arguments: { fault_type: 'shorted_diode', component_ref: 'D2' } },
    ],
    citations: ['USB-C spec §4.5 CC pull-down requirements', 'TVS diode datasheet: short-circuit failure mode'],
    diagnosis: 'Blown TVS protection diode D2 shorting CC1 to ground.',
  },
];

let toolCallSeq = 0;
function nextToolId(): string {
  toolCallSeq += 1;
  return `tc-sim-${toolCallSeq}`;
}

export class MetaClient {
  readonly mode: ClientMode;
  readonly model: ModelId;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchFn;
  private readonly simulatedTools: MetaClientOptions['simulatedTools'];

  constructor(options: MetaClientOptions = {}) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    this.apiKey = options.apiKey ?? env?.['META_API_KEY'];
    this.mode = options.mode ?? (this.apiKey ? 'live' : 'simulated');
    this.model = options.model ?? SPARK_MODEL_ID;
    this.baseUrl = (options.baseUrl ?? 'https://api.meta.ai/v1').replace(/\/$/, '');
    this.fetchFn = options.fetchFn;
    this.simulatedTools = options.simulatedTools;
  }

  /** Active status snapshot for the workbench header. */
  status(): { model: ModelId; contextTokens: number; segmenter: 'sam-3.1'; mode: ClientMode } {
    return { model: this.model, contextTokens: SPARK_CONTEXT_TOKENS, segmenter: 'sam-3.1', mode: this.mode };
  }

  /** Execute a single tool call (simulated fixture when offline). */
  executeTool(name: ToolDefinition['name'], args: Record<string, unknown>): unknown {
    const override = this.simulatedTools?.[name];
    if (override) return override(args);
    return defaultSimulatedToolResult(name, args);
  }

  /** Look up a pre-recorded high-fidelity trace for a board (fixture mode). */
  getSimulatedTrace(boardId: string): SimulatedTrace | undefined {
    return DEFAULT_SIMULATED_TRACES.find((t) => t.boardId === boardId);
  }

  /** List all bundled simulated traces. */
  listSimulatedTraces(): SimulatedTrace[] {
    return [...DEFAULT_SIMULATED_TRACES];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.mode === 'simulated') return this.simulatedChat(request);
    const fetchFn = this.fetchFn ?? globalThis.fetch.bind(globalThis);
    const payload = buildToolCallPayload({ ...request, model: request.model ?? this.model });
    const res = await fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Meta Model API error: HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    const message = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((t) => ({
      id: t.id,
      name: t.function.name as ToolCall['name'],
      arguments: JSON.parse(t.function.arguments || '{}') as Record<string, unknown>,
    }));
    return {
      model: request.model ?? this.model,
      mode: 'live',
      content: message?.content ?? '',
      toolCalls,
      simulated: false,
    };
  }

  /** Stream a chat completion as content deltas (simulated by chunking the fixture). */
  async *streamChat(request: ChatRequest): AsyncGenerator<string, ChatResponse, void> {
    const response = await this.chat(request);
    if (this.mode === 'simulated') {
      const words = response.content.split(/(?<=\s)/);
      let emitted = '';
      for (const w of words) {
        emitted += w;
        yield w;
      }
      void emitted;
    } else {
      yield response.content;
    }
    return response;
  }

  private async simulatedChat(request: ChatRequest): Promise<ChatResponse> {
    const boardId = detectBoardId(request.messages.map((m) => m.content).join('\n'));
    const trace: SimulatedTrace =
      (boardId !== undefined ? this.getSimulatedTrace(boardId) : undefined) ?? DEFAULT_SIMULATED_TRACES[0] as SimulatedTrace;
    const content = [
      ...trace.reasoning.map((r) => `▸ ${r}`),
      '',
      `DIAGNOSIS: ${trace.diagnosis}`,
      `CITATIONS: ${trace.citations.join(' | ')}`,
    ].join('\n');
    const toolCalls: ToolCall[] = trace.toolCalls.map((t) => ({ ...t, id: nextToolId() }));
    return { model: request.model ?? this.model, mode: 'simulated', content, toolCalls, simulated: true };
  }
}

const BOARD_KEYWORDS: Array<{ id: string; keys: string[] }> = [
  { id: 'f405-flight-controller', keys: ['f405', 'flight controller', 'stm32'] },
  { id: 'esp32s3-sensor-node', keys: ['esp32', 'sensor node', 'c4'] },
  { id: 'usbc-pd-trigger', keys: ['usb-c', 'usbc', 'pd trigger', 'cc1'] },
];

/** Heuristic board matcher for fixture selection (exported for tests). */
export function detectBoardId(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const entry of BOARD_KEYWORDS) {
    if (entry.keys.some((k) => lower.includes(k))) return entry.id;
  }
  return undefined;
}

/** Default deterministic fixture results for each tool. */
export function defaultSimulatedToolResult(
  name: ToolDefinition['name'],
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'lookup_pinout':
      return {
        part_number: args['part_number'],
        pin_number: args['pin_number'],
        function: pinFunctionHint(String(args['part_number'] ?? ''), String(args['pin_number'] ?? '')),
        source: 'simulated datasheet extract',
      };
    case 'verify_rail_voltage':
      return {
        rail_name: args['rail_name'],
        measured_volts: args['measured_volts'],
        note: 'simulated rail reading',
      };
    case 'check_continuity':
      return {
        probe_a: args['probe_a'],
        probe_b: args['probe_b'],
        resistance_ohms: continuityFixture(String(args['probe_a'] ?? ''), String(args['probe_b'] ?? '')),
        note: 'simulated continuity reading',
      };
    case 'generate_rework_guidance':
      return {
        fault_type: args['fault_type'],
        component_ref: args['component_ref'],
        steps: [
          'Power off board, disconnect battery/USB, verify 0V on rails.',
          'Set iron to lead-free 320°C (leaded 300°C), fine chisel tip.',
          'Apply flux, clear fault with solder wick — never scrape.',
          'Clean with IPA, inspect under magnification, re-test rails.',
        ],
      };
  }
}

function pinFunctionHint(partNumber: string, pin: string): string {
  const p = partNumber.toLowerCase();
  if (p.includes('stm32f405')) {
    if (pin === '14') return 'VDD (3.3V supply)';
    if (pin === '15') return 'NRST (active-low reset, internal pull-up)';
    return 'GPIO / see datasheet Table 5';
  }
  if (p.includes('esp32')) return 'See ESP32-S3 pin function table';
  return 'See component datasheet';
}

function continuityFixture(a: string, b: string): number {
  const pair = [a.toLowerCase(), b.toLowerCase()].sort().join('|');
  if (pair.includes('u1-14') && pair.includes('u1-15')) return 0.4;
  if (pair.includes('cc1') && pair.includes('gnd')) return 0.2;
  return 12_000_000; // open circuit
}
