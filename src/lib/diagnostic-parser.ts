/** Parser / validator for Muse Spark 1.3 structured diagnostic outputs. */

export interface DiagnosticStep {
  kind: 'reasoning' | 'tool_call' | 'rule_check' | 'citation' | 'conclusion';
  text: string;
}

export interface ReworkGuidance {
  ironTempC: number;
  tip: string;
  steps: string[];
  replacementPart?: string;
  safetyChecks: string[];
}

export interface DiagnosticResult {
  boardId: string;
  faultType: string;
  componentRef: string;
  confidence: number;
  steps: DiagnosticStep[];
  rework: ReworkGuidance;
  citations: string[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const STEP_KINDS = new Set(['reasoning', 'tool_call', 'rule_check', 'citation', 'conclusion']);

/**
 * Validate an unknown parsed-JSON value against the DiagnosticResult
 * contract. Returns the typed result or throws a descriptive Error.
 */
export function validateDiagnosticResult(value: unknown): DiagnosticResult {
  if (!isRecord(value)) throw new Error('DiagnosticResult must be a JSON object.');
  for (const key of ['boardId', 'faultType', 'componentRef']) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      throw new Error(`DiagnosticResult.${key} must be a non-empty string.`);
    }
  }
  if (typeof value['confidence'] !== 'number' || value['confidence'] < 0 || value['confidence'] > 1) {
    throw new Error('DiagnosticResult.confidence must be a number in [0, 1].');
  }
  if (!Array.isArray(value['steps']) || value['steps'].length === 0) {
    throw new Error('DiagnosticResult.steps must be a non-empty array.');
  }
  const steps: DiagnosticStep[] = value['steps'].map((s: unknown, i: number) => {
    if (!isRecord(s) || !STEP_KINDS.has(s['kind'] as string) || typeof s['text'] !== 'string' || s['text'].length === 0) {
      throw new Error(`DiagnosticResult.steps[${i}] must have a valid kind and non-empty text.`);
    }
    return { kind: s['kind'] as DiagnosticStep['kind'], text: s['text'] as string };
  });
  if (!isRecord(value['rework'])) throw new Error('DiagnosticResult.rework must be an object.');
  const reworkRaw = value['rework'] as Record<string, unknown>;
  if (typeof reworkRaw['ironTempC'] !== 'number' || reworkRaw['ironTempC'] < 150 || reworkRaw['ironTempC'] > 450) {
    throw new Error('DiagnosticResult.rework.ironTempC must be a number in [150, 450].');
  }
  if (!Array.isArray(reworkRaw['steps']) || reworkRaw['steps'].length === 0) {
    throw new Error('DiagnosticResult.rework.steps must be a non-empty array.');
  }
  if (!Array.isArray(reworkRaw['safetyChecks'])) {
    throw new Error('DiagnosticResult.rework.safetyChecks must be an array.');
  }
  if (!Array.isArray(value['citations'])) throw new Error('DiagnosticResult.citations must be an array.');
  return {
    boardId: value['boardId'] as string,
    faultType: value['faultType'] as string,
    componentRef: value['componentRef'] as string,
    confidence: value['confidence'] as number,
    steps,
    rework: {
      ironTempC: reworkRaw['ironTempC'] as number,
      tip: typeof reworkRaw['tip'] === 'string' ? (reworkRaw['tip'] as string) : 'fine chisel',
      steps: reworkRaw['steps'] as string[],
      replacementPart: typeof reworkRaw['replacementPart'] === 'string' ? (reworkRaw['replacementPart'] as string) : undefined,
      safetyChecks: reworkRaw['safetyChecks'] as string[],
    },
    citations: value['citations'] as string[],
  };
}

/** Parse a JSON string (e.g. a structured model output) into a DiagnosticResult. */
export function parseDiagnosticJson(text: string): DiagnosticResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Diagnostic output is not valid JSON.');
  }
  return validateDiagnosticResult(parsed);
}

/** Split a streamed chat transcript into typed steps (lines starting with ▸, ✓, ⏚, ❚, ■). */
export function parseStreamTranscript(content: string): DiagnosticStep[] {
  const steps: DiagnosticStep[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('✓') || line.startsWith('⏚')) steps.push({ kind: 'rule_check', text: line });
    else if (line.startsWith('❚') || line.startsWith('CITATION')) steps.push({ kind: 'citation', text: line });
    else if (line.startsWith('■') || line.startsWith('DIAGNOSIS')) steps.push({ kind: 'conclusion', text: line });
    else if (line.startsWith('▸') || line.startsWith('🔧')) steps.push({ kind: 'tool_call', text: line });
    else steps.push({ kind: 'reasoning', text: line });
  }
  return steps;
}

/** Extract `[DATASHEET: ...]` / citation markers from assembled payload text. */
export function extractCitations(text: string): string[] {
  const out: string[] = [];
  const re = /\[DATASHEET:\s*([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!.trim());
  return [...new Set(out)];
}
