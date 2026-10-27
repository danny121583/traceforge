/**
 * TraceForge deterministic RAG retrieval engine (RAG-first assistant).
 *
 * `queryTraceForgeRAG` answers from the versioned static knowledge base
 * (`KB_VERSION`, $0.00, zero model calls) using an inverted index +
 * synonym expansion + BM25-style ranking + topic classification + passage
 * extraction. It NEVER invokes live inference itself: when local coverage
 * is `low` it sets `needsLiveInference: true` and still returns a truthful
 * knowledge-only `fallbackAnswer` so the assistant works at $0.00 when live
 * inference is unavailable, unauthorized, or budget-limited.
 *
 * Ground-truth isolation: `AssistantSessionContext` is sanitized on entry
 * (forbidden `HiddenFault` keys stripped) and answers never contain
 * withheld fault answers before evaluation.
 */

import { KB_VERSION, KNOWLEDGE_BASE_ENTRIES, type KnowledgeBaseEntry } from '../data/knowledge-base';

export { KB_VERSION };

/** Sanitized active-session context the assistant may ground on. */
export interface AssistantProbeMeasurement {
  target: string;
  kind?: string;
  detail?: string;
  abnormal?: boolean;
}

export interface AssistantProposedDiagnosis {
  componentRef: string;
  faultType: string;
  verificationStatus: string;
  explanation?: string;
}

export interface AssistantScoreBreakdown {
  totalScore: number;
  componentMatch?: boolean;
  faultTypeMatch?: boolean;
  evidenceConfirmed?: boolean;
  probeCount?: number;
  efficiencyScore?: number;
  summary?: string;
}

export interface AssistantSessionContext {
  boardId?: string;
  boardName?: string;
  symptom?: string;
  lifecycleState?: string;
  probeMeasurements?: AssistantProbeMeasurement[];
  proposedDiagnosis?: AssistantProposedDiagnosis;
  verificationStatus?: string;
  score?: AssistantScoreBreakdown | null;
  evaluated?: boolean;
}

export interface RagSource {
  entryId: string;
  title: string;
  excerpt: string;
}

export type RagCoverage = 'high' | 'medium' | 'low';

export interface RagResult {
  /** Answer to render (grounded KB answer, or the knowledge-only fallback when coverage is low). */
  answer: string;
  /** Knowledge-only fallback; the server returns this when live inference is unavailable. */
  fallbackAnswer: string;
  sources: RagSource[];
  needsLiveInference: boolean;
  blockedByPolicy: boolean;
  coverage: RagCoverage;
  kbVersion: string;
  topicIds: string[];
}

/** Withheld ground-truth keys: stripped from session context, never answered from. */
export const ASSISTANT_FORBIDDEN_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'faultId',
  'faultType',
  'faultedComponent',
  'groundTruth',
  'hiddenFault',
  'injectedFault',
]);

/** Strip forbidden ground-truth keys (top level) from an untrusted session context. */
export function sanitizeAssistantSessionContext(
  context: Record<string, unknown> | AssistantSessionContext | undefined | null,
): AssistantSessionContext {
  if (!context || typeof context !== 'object') return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (ASSISTANT_FORBIDDEN_CONTEXT_KEYS.has(key)) continue;
    clean[key] = value;
  }
  return clean as AssistantSessionContext;
}

/* ---------------------------------------------------------------------------
 * Retrieval internals
 * ------------------------------------------------------------------------- */

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'do', 'does', 'did', 'doing', 'how', 'what', 'why', 'when', 'where', 'which',
  'who', 'whom', 'that', 'this', 'these', 'those', 'it', 'its', 'of', 'in',
  'on', 'at', 'to', 'for', 'with', 'about', 'into', 'over', 'after', 'by',
  'from', 'up', 'out', 'as', 'so', 'than', 'too', 'very', 'can', 'will',
  'just', 'should', 'now', 'my', 'me', 'i', 'you', 'your', 'we', 'our',
  'tell', 'give', 'get', 'got', 'please', 'like', 'mean', 'means', 'work',
  'works', 'working', 'thing', 'things', 'something', 'anything', 'there',
  'here', 'have', 'has', 'had', 'would', 'could', 'might', 'must', 'shall',
]);

/** Synonym expansion: query term -> additional index terms (weight 0.5). */
const SYNONYMS: Record<string, string[]> = {
  voltage: ['volts', 'rail', 'v'],
  volts: ['voltage', 'rail'],
  current: ['amps', 'draw', 'ammeter'],
  amps: ['current', 'draw'],
  continuity: ['resistance', 'ohms', 'short', 'beep', 'ohmmeter'],
  resistance: ['continuity', 'ohms', 'short'],
  ohms: ['resistance', 'continuity'],
  short: ['continuity', 'shorted', 'bridge'],
  shorted: ['short', 'shorted_component'],
  measure: ['measurement', 'probe', 'multimeter', 'reading'],
  measurement: ['measure', 'probe', 'multimeter', 'reading'],
  measurements: ['measure', 'probe', 'multimeter', 'reading', 'voltage'],
  probe: ['measure', 'measurement', 'multimeter'],
  probing: ['measure', 'measurement', 'probe'],
  multimeter: ['measure', 'measurement', 'probe', 'dmm'],
  troubleshoot: ['debug', 'diagnose', 'fix', 'walkthrough', 'example'],
  troubleshooting: ['debug', 'diagnose', 'fix', 'walkthrough', 'example'],
  debug: ['troubleshoot', 'diagnose'],
  diagnose: ['troubleshoot', 'diagnosis', 'diagnostic'],
  diagnosis: ['diagnose', 'diagnostic', 'evidence', 'hypothesis'],
  explain: ['evidence', 'diagnosis', 'summary'],
  score: ['scoring', 'points', 'grade', 'evaluation', '100'],
  scoring: ['score', 'points', 'evaluation'],
  points: ['score', 'scoring'],
  grade: ['score', 'evaluation'],
  evaluation: ['score', 'scoring', 'verify'],
  verify: ['evaluation', 'confirm', 'verification'],
  confirmed: ['confirm', 'verification', 'evidence'],
  fault: ['faults', 'failure', 'defect'],
  faults: ['fault', 'scenario'],
  hidden: ['fault', 'scenario', 'withheld'],
  scenario: ['fault', 'hidden'],
  board: ['circuit', 'reference'],
  circuit: ['board', 'circuitry'],
  circuits: ['board', 'circuit'],
  live: ['live_inference', 'model', 'muse_spark'],
  ai: ['model', 'live', 'muse_spark'],
  model: ['live', 'ai', 'muse_spark'],
  virtual: ['simulated', 'lab', 'deterministic'],
  simulated: ['virtual', 'lab', 'deterministic'],
  lab: ['virtual', 'simulated'],
  sim: ['virtual', 'simulated'],
  pcb: ['canvas', 'layout', 'overlay'],
  canvas: ['pcb', 'layout'],
  zoom: ['pan', 'canvas', 'magnification'],
  pan: ['zoom', 'canvas'],
  mcp: ['oauth', 'pkce', 'api', 'tools', 'integration'],
  oauth: ['mcp', 'pkce', 'token'],
  nrst: ['reset', 'pull-up', 'pullup'],
  reset: ['nrst'],
  'pull-up': ['pullup', 'nrst'],
  pullup: ['pull-up', 'nrst'],
  rails: ['voltage', 'supply'],
  usb: ['usbc', 'pd', 'cc'],
  usbc: ['usb', 'pd', 'cc'],
  pd: ['usbc', 'cc', 'negotiation', 'delivery'],
  cc1: ['cc', 'usbc'],
  cc2: ['cc', 'usbc', 'control'],
  '20v': ['20', 'pd', 'negotiation'],
  f405: ['stm32', 'flight'],
  stm32: ['f405', 'flight', 'mcu'],
  esp32: ['sensor', 's3', 'brownout'],
  sensor: ['esp32', 'hub'],
  rp2040: ['sensor', 'hub', 'esp32'],
  hub: ['sensor'],
  brownout: ['boot-loop', 'sag', 'rail'],
  sag: ['brownout', 'rail', 'voltage'],
  i2c: ['sda', 'scl', 'bus'],
  rework: ['solder', 'replace', 'guidance'],
  error: ['errors', 'reject', 'invalid', 'unknown'],
  errors: ['error', 'reject'],
  help: ['troubleshoot', 'guide', 'how'],
  difference: ['vs', 'versus', 'compare'],
  vs: ['difference', 'versus'],
};

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+|your\s+)?previous\s+instructions?/i,
  /ignore\s+(all\s+)?(the\s+|your\s+)?(system|above|prior)\b/i,
  /disregard\s+(all\s+|any\s+)?(previous|prior|above|system)\b/i,
  /reveal\s+(the\s+)?(system\s+prompt|hidden\s+fault|ground\s+truth|fault\s?id\b|injected\s+fault)/i,
  /reveal\s+.*before\s+evaluation/i,
  /print\s+META_API_KEY/i,
  /META_API_KEY/i,
  /system\s+prompt/i,
  /\b(jailbreak|prompt\s*injection|override\s+(your|system|all))\b/i,
  /reveal\s+.*fault/i,
  /show\s+me\s+the\s+(hidden\s+fault|ground\s+truth|fault\s?id)/i,
  /disclose\s+(the\s+)?(hidden\s+fault|ground\s+truth)/i,
  /what\s+(is|was)\s+the\s+(hidden|injected|withheld)\s+fault/i,
];

const GREETING_PATTERN = /^(hi|hello|hey|yo|thanks|thank\s+you|good\s+(morning|afternoon|evening)|bye|ok|okay)[!.\s]*$/i;

const DIAGNOSIS_INTENT = /\bexplain\b.*\b(diagnosis|diagnose|result|verdict)\b|\b(my|this)\s+(diagnosis|diagnose|result|verdict)\b|\bexplain\s+(it|this)\b/i;
const SCORE_INTENT = /\b(why|how).{0,40}\b(score|scored|94|100|points|grade|graded)\b|\bmy\s+(score|grade|points|result)\b|\b\d{1,3}\s*\/\s*100\b/i;
const MEASUREMENTS_INTENT = /\bwhat\s+did\s+i\s+measure\b|\bmy\s+(measurements|probes|probe\s+log|readings)\b|\bshow\s+(my|the)\s+(measurements|probes)\b/i;
const TROUBLESHOOT_INTENT = /\b(help\s+me\s+)?troubleshoot\b|\bhelp\s+me\s+(debug|diagnose|fix)\b|\bdebug\s+(this|my|the)\b|\bcircuit\s+stuck\b|\bnot\s+working\b/i;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_+\-.]/g, ' ')
    .split(/[\s_]+/)
    .map((t) => t.replace(/^[+.\-]+|[+.\-]+$/g, ''))
    .filter((t) => t.length >= 2);
}

interface IndexedEntry {
  entry: KnowledgeBaseEntry;
  termFreq: Map<string, number>;
  length: number;
}

let indexCache: IndexedEntry[] | null = null;
let avgDocLength = 0;

function buildIndex(): IndexedEntry[] {
  if (indexCache) return indexCache;
  const indexed: IndexedEntry[] = KNOWLEDGE_BASE_ENTRIES.map((entry) => {
    const text = `${entry.title} ${entry.topics.join(' ')} ${entry.keywords.join(' ')} ${entry.content}`;
    const freq = new Map<string, number>();
    const tokens = tokenize(text);
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    return { entry, termFreq: freq, length: tokens.length };
  });
  avgDocLength = indexed.reduce((sum, d) => sum + d.length, 0) / Math.max(1, indexed.length);
  indexCache = indexed;
  return indexed;
}

function docFreq(term: string, docs: IndexedEntry[]): number {
  let df = 0;
  for (const d of docs) if ((d.termFreq.get(term) ?? 0) > 0) df += 1;
  return df;
}

/** BM25-style score of one entry against expanded query terms. */
function bm25Score(
  queryTerms: Array<{ term: string; weight: number }>,
  doc: IndexedEntry,
  docs: IndexedEntry[],
): { score: number; matchedOriginals: Set<string>; genericOnly: boolean } {
  const k1 = 1.2;
  const b = 0.75;
  const N = docs.length;
  let score = 0;
  const matchedOriginals = new Set<string>();
  let specificMatch = false;
  for (const { term, weight, original } of queryTerms as Array<{ term: string; weight: number; original: string }>) {
    const tf = doc.termFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const df = docFreq(term, docs);
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgDocLength));
    score += weight * idf * norm;
    matchedOriginals.add(original);
    if (idf > 1.0) specificMatch = true;
  }
  return { score, matchedOriginals, genericOnly: !specificMatch };
}

const HIGH_THRESHOLD = 2.2;
const MEDIUM_THRESHOLD = 0.9;

function splitPassages(content: string): string[] {
  return content
    .split(/\n\n+/)
    .flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z0-9])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function extractPassages(entry: KnowledgeBaseEntry, queryTokenSet: Set<string>, maxPassages: number): string[] {
  const passages = splitPassages(entry.content);
  const scored = passages.map((p) => {
    const tokens = new Set(tokenize(p));
    let hits = 0;
    for (const q of queryTokenSet) if (tokens.has(q)) hits += 1;
    return { p, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);
  const picked = scored.filter((s) => s.hits > 0).slice(0, maxPassages).map((s) => s.p);
  if (picked.length === 0) return [passages[0] ?? entry.content.slice(0, 300)];
  return picked.map((p) => (p.length > 500 ? `${p.slice(0, 497)}…` : p));
}

function formatProbeSummary(measurements: AssistantProbeMeasurement[] | undefined): string {
  if (!measurements || measurements.length === 0) return 'No probe measurements are recorded in this session yet.';
  return measurements
    .map((m, i) => {
      const flag = m.abnormal ? 'ABNORMAL' : 'nominal';
      const value = m.detail ? ` — ${m.detail}` : '';
      return `${i + 1}. ${m.target} (${m.kind ?? 'probe'}, ${flag})${value}`;
    })
    .join('\n');
}

/**
 * Deterministic RAG retrieval over the versioned TraceForge knowledge base.
 * Zero model calls in every path.
 */
export function queryTraceForgeRAG(
  question: string,
  sessionContext?: AssistantSessionContext | Record<string, unknown> | null,
): RagResult {
  const raw = typeof question === 'string' ? question : '';
  const normalized = raw.trim();
  const lowered = normalized.toLowerCase();
  const session = sanitizeAssistantSessionContext(
    (sessionContext ?? {}) as Record<string, unknown>,
  );

  const base = {
    blockedByPolicy: false,
    kbVersion: KB_VERSION,
    topicIds: [] as string[],
  };

  // 1. Prompt-injection refusal (no citations, no live call, zero model calls).
  if (PROMPT_INJECTION_PATTERNS.some((re) => re.test(normalized))) {
    const answer =
      'I can\u2019t help with that: I don\u2019t reveal system prompts, credentials, or withheld hidden-fault answers before evaluation. ' +
      'I can help you explore TraceForge, troubleshoot circuits, understand measurements, or explain a completed diagnosis instead.';
    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [],
      needsLiveInference: false,
      blockedByPolicy: true,
      coverage: 'high',
    };
  }

  // 2. Simple greetings (no citation clutter).
  if (lowered.length <= 24 && GREETING_PATTERN.test(normalized)) {
    const answer =
      'Hi! I can help you explore TraceForge, troubleshoot circuits, understand measurements, or answer questions. What would you like to know?';
    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [],
      needsLiveInference: false,
      coverage: 'high',
    };
  }

  // 3. Active-session grounded intents (never accept or expose HiddenFault ground truth).
  if (session && (DIAGNOSIS_INTENT.test(normalized) || SCORE_INTENT.test(normalized) || MEASUREMENTS_INTENT.test(normalized) || TROUBLESHOOT_INTENT.test(normalized))) {
    const sessionAnswer = answerSessionIntent(normalized, session);
    if (sessionAnswer) return sessionAnswer;
  }

  // 4. Product-name overview: a question about TraceForge itself (no other
  // significant terms) grounds to the Getting Started entry — the product
  // name is specific to this corpus, not a generic keyword.
  const preTerms = tokenize(lowered).filter((t) => !STOPWORDS.has(t));
  if (preTerms.length > 0 && preTerms.every((t) => t === 'traceforge')) {
    const overview = KNOWLEDGE_BASE_ENTRIES.find((e) => e.id === 'getting-started');
    if (overview) {
      const excerpt = extractPassages(overview, new Set(['traceforge', 'work', 'workflow']), 2).join('\n\n');
      return {
        ...base,
        answer: excerpt,
        fallbackAnswer: excerpt,
        sources: [{ entryId: overview.id, title: overview.title, excerpt: extractPassages(overview, new Set(['traceforge']), 1)[0] ?? '' }],
        needsLiveInference: false,
        coverage: 'high',
        topicIds: [overview.id],
      };
    }
  }

  // 5. KB retrieval: inverted index + synonym expansion + BM25 + coverage gate.
  const docs = buildIndex();
  const rawTerms = preTerms;
  const expanded: Array<{ term: string; weight: number; original: string }> = [];
  for (const t of rawTerms) {
    expanded.push({ term: t, weight: 1, original: t });
    for (const syn of SYNONYMS[t] ?? []) {
      // Normalize synonyms through the same tokenizer so multi-word and
      // underscored aliases (for example live_inference) match index terms.
      for (const st of tokenize(syn)) {
        if (st !== t) expanded.push({ term: st, weight: 0.5, original: t });
      }
    }
  }
  const queryTokenSet = new Set(expanded.map((e) => e.term));

  const ranked = docs
    .map((doc) => ({ doc, ...bm25Score(expanded, doc, docs) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];

  let coverage: RagCoverage = 'low';
  if (top && !top.genericOnly) {
    if (top.score >= HIGH_THRESHOLD && top.matchedOriginals.size >= 2) coverage = 'high';
    else if (top.score >= MEDIUM_THRESHOLD && top.matchedOriginals.size >= 2) coverage = 'medium';
    else if (top.score >= HIGH_THRESHOLD + 1.5 && top.matchedOriginals.size >= 1) coverage = 'medium';
  }

  if ((coverage === 'high' || coverage === 'medium') && top) {
    const supporting = ranked.filter((r) => r.score >= MEDIUM_THRESHOLD && !r.genericOnly).slice(0, 3);
    const sources: RagSource[] = supporting.map((r) => ({
      entryId: r.doc.entry.id,
      title: r.doc.entry.title,
      excerpt: extractPassages(r.doc.entry, queryTokenSet, 1)[0] ?? '',
    }));
    const lead = extractPassages(top.doc.entry, queryTokenSet, 2).join('\n\n');
    const answer = `${lead}`;
    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources,
      needsLiveInference: false,
      coverage,
      topicIds: supporting.map((r) => r.doc.entry.id),
    };
  }

  // 6. Low coverage: flag for live inference but still answer from knowledge at $0.00.
  const grounding = ranked.slice(0, 2).map((r) => ({
    entryId: r.doc.entry.id,
    title: r.doc.entry.title,
    excerpt: extractPassages(r.doc.entry, queryTokenSet, 1)[0] ?? '',
  }));
  const fallbackAnswer =
    'I don\u2019t have verified TraceForge documentation that answers that yet, so here is what I can say from the knowledge base (no live inference used, zero cost): ' +
    'TraceForge is a hardware-free virtual circuit lab with three reference boards (F405 flight controller, ESP32-S3 sensor node, USB-C PD trigger), ' +
    'virtual voltage/current/continuity measurements on an 8-probe budget, evidence-backed diagnoses, and 0–100 scoring against a withheld hidden fault. ' +
    'Try one of these instead: How does TraceForge work? · Help me troubleshoot a circuit. · What does NRST mean? · Explain my diagnosis. · ' +
    'How do virtual measurements work? · What\u2019s the difference between Virtual Lab and Live AI?';
  return {
    ...base,
    answer: fallbackAnswer,
    fallbackAnswer,
    sources: grounding,
    needsLiveInference: true,
    coverage: 'low',
    topicIds: grounding.map((g) => g.entryId),
  };
}

function answerSessionIntent(normalized: string, session: AssistantSessionContext): RagResult | null {
  const base = {
    blockedByPolicy: false as const,
    kbVersion: KB_VERSION,
    topicIds: [] as string[],
  };
  const boardLabel = session.boardName ?? session.boardId ?? 'the current board';
  const hasDiagnosis = !!session.proposedDiagnosis?.componentRef;
  const hasScore = typeof session.score?.totalScore === 'number';
  const hasProbes = (session.probeMeasurements?.length ?? 0) > 0;

  // Explain-my-diagnosis: grounded in the sanitized session only.
  if (DIAGNOSIS_INTENT.test(normalized)) {
    if (hasDiagnosis) {
      const d = session.proposedDiagnosis as AssistantProposedDiagnosis;
      const lines = [
        `Your diagnosis on ${boardLabel}: ${d.componentRef} · ${d.faultType} (${d.verificationStatus}).`,
      ];
      if (d.explanation) lines.push(`Reasoning: ${d.explanation}`);
      lines.push(`Evidence behind it:\n${formatProbeSummary(session.probeMeasurements)}`);
      if (hasScore) {
        lines.push(
          `Evaluation: ${session.score?.totalScore}/100 — component ${session.score?.componentMatch ? 'MATCH' : 'MISS'}, ` +
          `fault-type ${session.score?.faultTypeMatch ? 'MATCH' : 'MISS'}, ` +
          `evidence ${session.score?.evidenceConfirmed ? 'CONFIRMED' : 'NOT confirmed'} (${session.score?.probeCount ?? 0} probes).` +
          (session.score?.summary ? ` ${session.score.summary}` : ''),
        );
      } else {
        lines.push('This session has not been scored yet — scoring discloses the hidden fault and locks the scenario, so score only when probing is done.');
      }
      const answer = lines.join('\n\n');
      return {
        ...base,
        answer,
        fallbackAnswer: answer,
        sources: [{ entryId: 'diagnostic-evidence', title: 'Investigation Results Guide — Evidence & Hypotheses', excerpt: 'A diagnosis is confirmed only when electrical measurements decisively back it; without decisive measurements it stays an unverified hypothesis.' }],
        needsLiveInference: false,
        coverage: 'high',
        topicIds: ['diagnostic-evidence'],
      };
    }
    const answer =
      'There is no completed diagnosis in this session yet. A TraceForge diagnosis names a component reference, a fault class, and a verification status (confirmed or hypothesis) with the measurements behind it. ' +
      'Run an investigation or log manual probes first, then ask me to explain it — ' +
      'I will ground the explanation in your recorded measurements and proposed diagnosis (never in the withheld hidden fault).';
    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [{ entryId: 'diagnostic-evidence', title: 'Investigation Results Guide — Evidence & Hypotheses', excerpt: 'A TraceForge diagnosis has four parts: the proposed component reference, the fault class, the verification status (confirmed or hypothesis), and a written explanation citing the measurements.' }],
      needsLiveInference: false,
      coverage: 'medium',
      topicIds: ['diagnostic-evidence'],
    };
  }

  // Why-did-I-get-X/100: rubric + live score breakdown when evaluated.
  if (SCORE_INTENT.test(normalized)) {
    if (hasScore) {
      const s = session.score as AssistantScoreBreakdown;
      const answer = [
        `Your score on ${boardLabel}: ${s.totalScore}/100.`,
        `Breakdown — component ${s.componentMatch ? 'MATCH' : 'MISS'}, fault-type ${s.faultTypeMatch ? 'MATCH' : 'MISS'}, ` +
        `evidence ${s.evidenceConfirmed ? 'CONFIRMED' : 'NOT confirmed'}, ${s.probeCount ?? 0} probes, efficiency ${s.efficiencyScore ?? 'n/a'}.` +
        (s.summary ? ` ${s.summary}` : ''),
        'Near-perfect scores that miss 100 almost always come from one part: a slightly-off fault class on the right component, ' +
        'thin evidence (right guess, no abnormal measurement confirming it), or extra probes reducing the efficiency component.',
      ].join('\n\n');
      return {
        ...base,
        answer,
        fallbackAnswer: answer,
        sources: [{ entryId: 'scoring-verification', title: 'Investigation Results Guide — Scoring & Verification', excerpt: 'Component match, fault-type match, evidence confirmation, and probe efficiency combine into a 0–100 score with a written summary.' }],
        needsLiveInference: false,
        coverage: 'high',
        topicIds: ['scoring-verification'],
      };
    }
    const answer = [
      'TraceForge scores diagnoses 0–100 against the withheld hidden fault: component match (right component?), fault-type match (right fault class?), ' +
      'evidence confirmation (did decisive abnormal measurements back it?), and probe efficiency (fewer probes score higher).',
      'This session has no evaluated score yet — run an investigation and score it first, then ask again and I will break down exactly which part cost points.',
    ].join('\n\n');
    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [{ entryId: 'scoring-verification', title: 'Investigation Results Guide — Scoring & Verification', excerpt: 'Component match, fault-type match, evidence confirmation, and probe efficiency combine into a 0–100 score with a written summary.' }],
      needsLiveInference: false,
      coverage: 'medium',
      topicIds: ['scoring-verification'],
    };
  }

  // What-did-I-measure: probe log summary.
  if (MEASUREMENTS_INTENT.test(normalized)) {
    const answer = hasProbes
      ? `Your recorded measurements on ${boardLabel}:\n${formatProbeSummary(session.probeMeasurements)}`
      : 'No probe measurements are recorded in this session yet. Run an investigation or log manual probes, then ask again.';
    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: hasProbes
        ? [{ entryId: 'voltage-measurements', title: 'Measurement Guide — Node Voltage', excerpt: 'Every voltage reading is compared against its nominal datasheet spec and tolerance; abnormal readings are flagged, never asserted as root cause.' }]
        : [],
      needsLiveInference: false,
      coverage: hasProbes ? 'high' : 'medium',
      topicIds: hasProbes ? ['voltage-measurements'] : [],
    };
  }

  // Help-me-troubleshoot: session-aware next steps.
  if (TROUBLESHOOT_INTENT.test(normalized)) {
    const contextLine = session.symptom
      ? `Reported symptom on ${boardLabel}: ${session.symptom}`
      : `Current board: ${boardLabel}.`;
    const probeLine = hasProbes
      ? `You already have ${session.probeMeasurements?.length} recorded probe(s):\n${formatProbeSummary(session.probeMeasurements)}\n\nNext: compare each reading against its nominal spec, then take continuity on the first abnormal node (power off in the model).`
      : 'Start with rail voltages from the nominal spec table, then take continuity on the first abnormal node — that order isolates most faults within the 8-probe budget.';
    const answer = `${contextLine}\n\n${probeLine}\n\nTell me what you measured and I will help interpret it against the datasheet specs.`;
    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [{ entryId: 'troubleshooting-examples', title: 'Circuit Reference — F405, USB-C PD & RP2040 Troubleshooting', excerpt: 'Start with rail voltages from the nominal spec table, then take continuity on the first abnormal node — that order isolates most faults within the 8-probe budget.' }],
      needsLiveInference: false,
      coverage: hasProbes ? 'high' : 'medium',
      topicIds: ['troubleshooting-examples'],
    };
  }

  return null;
}
