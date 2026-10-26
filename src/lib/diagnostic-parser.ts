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

export type ProbeStatus = 'nominal' | 'abnormal' | 'inconclusive';
export type HypothesisLikelihood = 'high' | 'medium' | 'low';

export interface ProbeMeasurement {
  point: string;
  value: string;
  status: ProbeStatus;
}

export interface DatasheetSpec {
  section: string;
  spec: string;
}

export interface DiagnosticHypothesis {
  claim: string;
  likelihood: HypothesisLikelihood;
  falsificationTest: string;
}

export interface DiagnosticResult {
  boardId: string;
  faultType: string;
  componentRef: string;
  confidence: number;
  steps: DiagnosticStep[];
  rework: ReworkGuidance;
  citations: string[];
  /** Symptoms / visual flags the operator reported or the camera saw. */
  observedEvidence: string[];
  /** Actual multimeter / continuity readings backing the diagnosis. */
  probeMeasurements: ProbeMeasurement[];
  /** Manufacturer pinouts and limits cited as ground truth. */
  datasheetSpecs: DatasheetSpec[];
  /** Model conjectures — never verified electrical facts on their own. */
  hypotheses: DiagnosticHypothesis[];
  /** Concrete tests that would confirm or falsify the hypotheses. */
  nextVerificationSteps: string[];
}

const PROBE_STATUSES = new Set<ProbeStatus>(['nominal', 'abnormal', 'inconclusive']);
const LIKELIHOODS = new Set<HypothesisLikelihood>(['high', 'medium', 'low']);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function toStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`DiagnosticResult.${field} must be an array.`);
  return value.map((v: unknown, i: number) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`DiagnosticResult.${field}[${i}] must be a non-empty string.`);
    }
    return v;
  });
}

function toProbeMeasurements(value: unknown): ProbeMeasurement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('DiagnosticResult.probeMeasurements must be an array.');
  return value.map((m: unknown, i: number) => {
    if (!isRecord(m) || typeof m['point'] !== 'string' || (m['point'] as string).length === 0) {
      throw new Error(`DiagnosticResult.probeMeasurements[${i}].point must be a non-empty string.`);
    }
    if (typeof m['value'] !== 'string' || (m['value'] as string).length === 0) {
      throw new Error(`DiagnosticResult.probeMeasurements[${i}].value must be a non-empty string.`);
    }
    if (!PROBE_STATUSES.has(m['status'] as ProbeStatus)) {
      throw new Error(
        `DiagnosticResult.probeMeasurements[${i}].status must be one of 'nominal' | 'abnormal' | 'inconclusive'.`,
      );
    }
    return { point: m['point'] as string, value: m['value'] as string, status: m['status'] as ProbeStatus };
  });
}

function toDatasheetSpecs(value: unknown): DatasheetSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('DiagnosticResult.datasheetSpecs must be an array.');
  return value.map((s: unknown, i: number) => {
    if (!isRecord(s) || typeof s['section'] !== 'string' || (s['section'] as string).length === 0) {
      throw new Error(`DiagnosticResult.datasheetSpecs[${i}].section must be a non-empty string.`);
    }
    if (typeof s['spec'] !== 'string' || (s['spec'] as string).length === 0) {
      throw new Error(`DiagnosticResult.datasheetSpecs[${i}].spec must be a non-empty string.`);
    }
    return { section: s['section'] as string, spec: s['spec'] as string };
  });
}

function toHypotheses(value: unknown): DiagnosticHypothesis[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('DiagnosticResult.hypotheses must be an array.');
  return value.map((h: unknown, i: number) => {
    if (!isRecord(h) || typeof h['claim'] !== 'string' || (h['claim'] as string).length === 0) {
      throw new Error(`DiagnosticResult.hypotheses[${i}].claim must be a non-empty string.`);
    }
    if (!LIKELIHOODS.has(h['likelihood'] as HypothesisLikelihood)) {
      throw new Error(`DiagnosticResult.hypotheses[${i}].likelihood must be one of 'high' | 'medium' | 'low'.`);
    }
    if (typeof h['falsificationTest'] !== 'string' || (h['falsificationTest'] as string).length === 0) {
      throw new Error(`DiagnosticResult.hypotheses[${i}].falsificationTest must be a non-empty string.`);
    }
    return {
      claim: h['claim'] as string,
      likelihood: h['likelihood'] as HypothesisLikelihood,
      falsificationTest: h['falsificationTest'] as string,
    };
  });
}

const STEP_KINDS = new Set(['reasoning', 'tool_call', 'rule_check', 'citation', 'conclusion']);

/**
 * Validate an unknown parsed-JSON value against the DiagnosticResult
 * contract. Returns the typed result or throws a descriptive Error.
 *
 * The classified evidence fields are optional on input (older payloads
 * omit them) and default to `[]` — but when present they are strictly
 * validated so a hypothesis can never smuggle itself in as a bare
 * string, and a bare measurement can never pose as a verified fact
 * without an explicit nominal/abnormal/inconclusive status.
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
    observedEvidence: toStringArray(value['observedEvidence'], 'observedEvidence'),
    probeMeasurements: toProbeMeasurements(value['probeMeasurements']),
    datasheetSpecs: toDatasheetSpecs(value['datasheetSpecs']),
    hypotheses: toHypotheses(value['hypotheses']),
    nextVerificationSteps: toStringArray(value['nextVerificationSteps'], 'nextVerificationSteps'),
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

export interface ClassifiedEvidence {
  observedEvidence: string[];
  probeMeasurements: ProbeMeasurement[];
  datasheetSpecs: DatasheetSpec[];
  hypotheses: DiagnosticHypothesis[];
  nextVerificationSteps: string[];
}

const EMPTY_EVIDENCE: ClassifiedEvidence = {
  observedEvidence: [],
  probeMeasurements: [],
  datasheetSpecs: [],
  hypotheses: [],
  nextVerificationSteps: [],
};

function parseMeasurementLine(rest: string): ProbeMeasurement | null {
  // "TP3 = 3.28V nominal" / "U1-14 ↔ U1-15 reads 0.4Ω abnormal" / "CC1: 0V [abnormal]"
  const statusMatch = rest.match(/\b(nominal|abnormal|inconclusive)\b/i);
  const status = (statusMatch?.[1]?.toLowerCase() as ProbeStatus | undefined) ?? 'inconclusive';
  const pointMatch = rest.match(/^([A-Za-z0-9_.\-]+(?:\s*[↔\-–]\s*[A-Za-z0-9_.\-]+)?)\s*[:=]/);
  const point = pointMatch?.[1]?.trim() ?? rest.split(/\s reads |\s = /)[0]?.trim() ?? '';
  if (!point) return null;
  return { point, value: rest.trim(), status };
}

/**
 * Parse a streamed transcript into classified evidence buckets.
 *
 * Recognized section markers (case-insensitive, all optional):
 * - `OBSERVED:` / `SYMPTOM:` / `VISUAL:` → observedEvidence
 * - `MEASUREMENT:` / `PROBE:` / `READING:` → probeMeasurements
 *   (a trailing nominal|abnormal|inconclusive token sets status,
 *   otherwise `inconclusive`)
 * - `DATASHEET:` / `SPEC:` → datasheetSpecs ("Section — spec" split on
 *   the first `—`, `:` or `|` when present)
 * - `HYPOTHESIS:` (optionally `[high|medium|low]` + `FALSIFY:` /
 *   `TEST:`) → hypotheses
 * - `NEXT:` / `VERIFY:` / `NEXT STEP:` → nextVerificationSteps
 *
 * Unmarked lines fall back to `parseStreamTranscript` semantics: rule
 * checks (✓/⏚) become `inconclusive` probe measurements, ❚/CITATION
 * lines become datasheet specs, and ■/DIAGNOSIS lines become
 * low-likelihood hypotheses (explicitly speculative until measured).
 */
export function parseEvidenceTranscript(content: string): ClassifiedEvidence {
  const out: ClassifiedEvidence = {
    observedEvidence: [],
    probeMeasurements: [],
    datasheetSpecs: [],
    hypotheses: [],
    nextVerificationSteps: [],
  };
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const marked = line.match(
      /^(?:▸\s*)?(OBSERVED|SYMPTOM|VISUAL|MEASUREMENT|PROBE|READING|DATASHEET|SPEC|HYPOTHESIS|NEXT(?: STEP)?|VERIFY)\s*(?:\[\s*(high|medium|low)\s*\])?\s*:\s*(.*)$/i,
    );
    if (marked) {
      const tag = marked[1]!.toUpperCase().replace(/\s+/g, ' ');
      const tagLikelihood = (marked[2]?.toLowerCase() as HypothesisLikelihood | undefined) ?? null;
      const rest = (marked[3] ?? '').trim();
      if (!rest) continue;
      if (tag === 'OBSERVED' || tag === 'SYMPTOM' || tag === 'VISUAL') {
        out.observedEvidence.push(rest);
      } else if (tag === 'MEASUREMENT' || tag === 'PROBE' || tag === 'READING') {
        const m = parseMeasurementLine(rest);
        if (m) out.probeMeasurements.push(m);
        else out.observedEvidence.push(rest);
      } else if (tag === 'DATASHEET' || tag === 'SPEC') {
        const parts = rest.split(/\s*[—–|:]\s*/);
        out.datasheetSpecs.push(
          parts.length > 1
            ? { section: parts[0]!.trim(), spec: parts.slice(1).join(': ').trim() }
            : { section: rest, spec: rest },
        );
      } else if (tag === 'HYPOTHESIS') {
        out.hypotheses.push(parseHypothesisLine(tagLikelihood ? `[${tagLikelihood}] ${rest}` : rest));
      } else {
        out.nextVerificationSteps.push(rest);
      }
      continue;
    }
    // Unmarked fallback keeps plain transcripts classifiable.
    if (line.startsWith('✓') || line.startsWith('⏚')) {
      const m = parseMeasurementLine(line.replace(/^[✓⏚]\s*/, ''));
      if (m) out.probeMeasurements.push(m);
      else out.observedEvidence.push(line);
    } else if (line.startsWith('❚') || line.startsWith('CITATION')) {
      const body = line.replace(/^[❚]\s*/, '').replace(/^CITATION\s*:?\s*/i, '').trim() || line;
      out.datasheetSpecs.push({ section: body, spec: body });
    } else if (line.startsWith('■') || line.startsWith('DIAGNOSIS')) {
      const claim = line.replace(/^[■]\s*/, '').replace(/^DIAGNOSIS\s*:?\s*/i, '').trim() || line;
      out.hypotheses.push({ claim, likelihood: 'low', falsificationTest: 'Confirm with probe measurements.' });
    } else if (line.startsWith('[DATASHEET:')) {
      out.datasheetSpecs.push({ section: line, spec: line });
    }
  }
  return out;
}

function parseHypothesisLine(rest: string): DiagnosticHypothesis {
  const likelihoodMatch = rest.match(/\[\s*(high|medium|low)\s*\]/i);
  const likelihood = (likelihoodMatch?.[1]?.toLowerCase() as HypothesisLikelihood | undefined) ?? 'medium';
  const falsifyMatch = rest.match(/\b(?:FALSIFY|TEST)\s*:\s*(.+)$/i);
  const falsificationTest = falsifyMatch?.[1]?.trim() ?? 'Confirm with probe measurements.';
  const claim = rest
    .replace(/\[\s*(high|medium|low)\s*\]/i, '')
    .replace(/\b(?:FALSIFY|TEST)\s*:\s*(.+)$/i, '')
    .trim();
  return { claim: claim || rest, likelihood, falsificationTest };
}

/**
 * Verification status of a diagnosis: `confirmed` only when at least
 * one probe measurement has a decisive nominal/abnormal status;
 * anything resting solely on hypotheses or inconclusive readings is
 * `hypothesis` and must be labeled as such in the UI.
 */
export function diagnosisVerificationStatus(result: Pick<DiagnosticResult, 'probeMeasurements' | 'hypotheses'>): {
  status: 'confirmed' | 'hypothesis';
  reason: string;
} {
  const decisive = result.probeMeasurements.filter((m) => m.status === 'nominal' || m.status === 'abnormal');
  if (decisive.length > 0) {
    return {
      status: 'confirmed',
      reason: `${decisive.length} decisive probe measurement(s) support the diagnosis.`,
    };
  }
  if (result.hypotheses.length > 0) {
    return {
      status: 'hypothesis',
      reason: 'Diagnosis rests on hypotheses without decisive probe measurements.',
    };
  }
  return { status: 'hypothesis', reason: 'No probe measurements recorded yet.' };
}

/** Extract `[DATASHEET: ...]` / citation markers from assembled payload text. */
export function extractCitations(text: string): string[] {
  const out: string[] = [];
  const re = /\[DATASHEET:\s*([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!.trim());
  return [...new Set(out)];
}

export { EMPTY_EVIDENCE };
