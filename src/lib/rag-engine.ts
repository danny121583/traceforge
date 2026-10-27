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

export interface RagHistoryMessage {
  role: string;
  content: string;
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
  boards: ['board', 'circuit', 'reference', 'f405', 'esp32', 'usbc'],
  symptoms: ['symptom'],
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
  help: ['troubleshoot', 'guide', 'how', 'capabilities', 'features'],
  difference: ['vs', 'versus', 'compare'],
  vs: ['difference', 'versus'],
  capabilities: ['features', 'options', 'workflow', 'getting', 'started', 'tools'],
  features: ['capabilities', 'options', 'workflow', 'getting', 'started', 'tools'],
  options: ['capabilities', 'features', 'workflow', 'manual'],
  else: ['capabilities', 'features', 'advanced', 'manual', 'options'],
  next: ['step', 'workflow', 'troubleshoot', 'scoring', 'rework'],
  walkthrough: ['troubleshoot', 'workflow', 'step', 'example', 'getting'],
  refresh: ['oauth', 'token', 'mcp', 'reconnect'],
  reconnect: ['oauth', 'token', 'mcp', 'refresh'],
  theme: ['light', 'dark', 'workbench'],
  light: ['theme', 'dark', 'workbench'],
  dark: ['theme', 'light', 'workbench'],
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

const DIAGNOSIS_INTENT = /\bexplain\b.*\b(diagnosis|diagnose|result|verdict)\b|\b(my|this)\s+(diagnosis|diagnose|result|verdict)\b|\bexplain\s+my\s+(diagnosis|result|verdict)\b/i;
const SCORE_INTENT = /\b(why|how).{0,40}\b(score|scored|94|100|points|grade|graded)\b|\bmy\s+(score|grade|points|result)\b|\b\d{1,3}\s*\/\s*100\b/i;
const MEASUREMENTS_INTENT = /\bwhat\s+did\s+i\s+measure\b|\bmy\s+(measurements|probes|probe\s+log|readings)\b|\bshow\s+(my|the)\s+(measurements|probes)\b/i;
const TROUBLESHOOT_INTENT = /\b(help\s+me\s+)?troubleshoot\b|\bhelp\s+me\s+(debug|diagnose|fix)\b|\bdebug\s+(this|my|the)\b|\bcircuit\s+stuck\b|\bnot\s+working\b/i;

/** Conversational capability & help intents ("what else can I do?", "what can you help me with?", etc.). */
const CAPABILITY_INTENT =
  /\bwhat\s+else\s+(can|could|should|do)\s+(i|we|you)\b|\bwhat\s+else\s+is\s+there\b|\bwhat\s+can\s+(i|we|you)\s+(do|try|ask|explore)\b|\bwhat\s+can\s+you\s+help(\s+me)?(\s+with)?\b|\bhow\s+can\s+you\s+help\b|\bwhat\s+(features|capabilities|options|tools)\s+(are\s+there|do\s+you\s+have|does\s+traceforge\s+have|can\s+i\s+use)\b|\bwhat\s+is\s+available\b/i;

/** Post-diagnosis workflow intents ("what happens after the diagnosis?", "what comes after diagnosing?"). */
const POST_DIAGNOSIS_INTENT =
  /\bwhat\s+(happens|comes|do\s+i\s+do|is\s+next|should\s+i\s+do)\s+(after|once|when)\s+(the\s+|a\s+|my\s+)?(diagnosis|diagnosing|investigation|step\s*2)\b|\bafter\s+(the\s+|my\s+)?diagnosis\b/i;

/** Next-action recommendation intents ("what should I try next?", "what now?", "where should I probe next?"). */
const NEXT_STEP_INTENT =
  /\bwhat\s+(should|can|do)\s+(i|we)\s+(try|do|probe|measure|check|test)\s+next\b|\bwhat('s|\s+is)\s+the\s+next\s+step\b|\bwhere\s+should\s+i\s+probe\s+next\b|\bwhat\s+now\s*\??$/i;

/** Guided walkthrough intents ("can you walk me through this?", "walk me through it"). */
const WALKTHROUGH_INTENT =
  /^(can\s+you\s+|please\s+|could\s+you\s+)?(walk\s+me\s+through\s+(this|it|that|the\s+workflow|the\s+board|the\s+circuit|traceforge)|how\s+do\s+i\s+get\s+started|step[\s-]+by[\s-]+step\s+guide)[!.\s?]*$/i;

/** Board switching / comparison follow-up intents ("how about the other board?", "what about the other circuits?"). */
const OTHER_BOARD_INTENT =
  /\b(how|what)\s+about\s+the\s+(other|next|remaining|second|third)\s+(board|boards|circuit|circuits)\b|\bwhat\s+are\s+the\s+other\s+(boards|circuits)\b|\btell\s+me\s+about\s+the\s+other\s+(board|boards|circuit|circuits)\b/i;

/** Conversational follow-up / anaphora patterns referencing the prior turn ("tell me more", "how does that work?", "can you explain that?", "why?"). */
const FOLLOWUP_ELABORATE_INTENT =
  /^(tell\s+me\s+more|more\s+details?|elaborate|go\s+on|keep\s+going|and\s+then\s*\??|what\s+else\s*\??)[!.\s?]*$/i;
const FOLLOWUP_HOW_WORK_INTENT =
  /^(how\s+does\s+(that|it|this)\s+work|how\s+do\s+(they|those|these)\s+work|how\s+is\s+(that|it)\s+(done|measured|calculated|scored))[!.\s?]*$/i;
const FOLLOWUP_EXPLAIN_INTENT =
  /^(can\s+you\s+|could\s+you\s+|please\s+)?(explain\s+(that|it|this|those|the\s+previous\s+result|the\s+previous\s+answer|more)|clarify\s+(that|it|this)|what\s+does\s+(that|it|this)\s+mean|what\s+do\s+you\s+mean(\s+by\s+that)?)[!.\s?]*$/i;
const FOLLOWUP_WHY_INTENT =
  /^(why|why\s+is\s+(that|it)|why\s+does\s+(that|it)\s+(happen|matter|drop|sag)|how\s+come|why\s+so)[!.\s?]*$/i;
const ANAPHORA_PRONOUN_PATTERN =
  /\b(that|it|those|these|this|the\s+previous\s+(result|measurement|answer|board|step)|the\s+same\s+(board|node|rail)|its)\b/i;

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
  history?: RagHistoryMessage[] | null,
): RagResult {
  const raw = typeof question === 'string' ? question : '';
  const normalized = raw.trim();
  const lowered = normalized.toLowerCase();
  const session = sanitizeAssistantSessionContext(
    (sessionContext ?? {}) as Record<string, unknown>,
  );
  const cleanHistory: RagHistoryMessage[] = Array.isArray(history)
    ? history
        .filter(
          (m): m is RagHistoryMessage =>
            !!m &&
            typeof m === 'object' &&
            typeof m.role === 'string' &&
            typeof m.content === 'string' &&
            m.content.trim().length > 0,
        )
        .slice(-8)
    : [];

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
  if (
    session &&
    (DIAGNOSIS_INTENT.test(normalized) ||
      SCORE_INTENT.test(normalized) ||
      MEASUREMENTS_INTENT.test(normalized) ||
      TROUBLESHOOT_INTENT.test(normalized))
  ) {
    const sessionAnswer = answerSessionIntent(normalized, session);
    if (sessionAnswer) return sessionAnswer;
  }

  // 3b. Conversational capability, follow-up, walkthrough, next-step, post-diagnosis, and other-board intents.
  const conversationalAnswer = answerConversationalIntent(normalized, session, cleanHistory);
  if (conversationalAnswer) return conversationalAnswer;

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

  // 5. KB retrieval: inverted index + synonym expansion + history anaphora expansion + BM25 + coverage gate.
  const docs = buildIndex();
  const rawTerms = [...preTerms];
  const isAnaphoricOrShortFollowUp =
    cleanHistory.length > 0 &&
    (ANAPHORA_PRONOUN_PATTERN.test(normalized) || rawTerms.length <= 3);

  const historyContextTerms = isAnaphoricOrShortFollowUp
    ? extractHistoryDomainTerms(cleanHistory)
    : [];

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
  for (const ht of historyContextTerms) {
    if (!rawTerms.includes(ht)) {
      expanded.push({ term: ht, weight: 0.65, original: ht });
      for (const syn of SYNONYMS[ht] ?? []) {
        for (const st of tokenize(syn)) {
          if (st !== ht) expanded.push({ term: st, weight: 0.35, original: ht });
        }
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
    const passageLimit = top.doc.entry.id === 'selecting-circuits' ? 8 : 2;
    const lead = extractPassages(top.doc.entry, queryTokenSet, passageLimit).join('\n\n');
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

  // 6. Low coverage: flag for live inference when outside the knowledge corpus, while still returning a grounded, helpful overview at zero cost.
  const grounding = ranked.slice(0, 2).map((r) => ({
    entryId: r.doc.entry.id,
    title: r.doc.entry.title,
    excerpt: extractPassages(r.doc.entry, queryTokenSet, 1)[0] ?? '',
  }));
  const fallbackAnswer =
    'Here is how TraceForge can help with that topic from the local knowledge base (no live inference used, zero cost): ' +
    'TraceForge is a hardware-free virtual circuit diagnostic lab with three reference boards (F405 flight controller, ESP32-S3 sensor node, USB-C PD trigger), ' +
    'virtual voltage/current/continuity measurements on an 8-probe budget, evidence-backed diagnoses, and 0–100 scoring against a withheld hidden fault. ' +
    'You can ask me: How does TraceForge work? · Help me troubleshoot a circuit. · What does NRST mean? · Explain my diagnosis. · ' +
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

const SALIENT_DOMAIN_TERMS = new Set([
  'f405', 'stm32', 'stm32f405', 'flight', 'controller', 'nrst', 'swd', 'ldo', 'buck', 'mp1584', 'ams1117',
  'esp32', 'rp2040', 'sensor', 'i2c', 'sda', 'scl', 'pullup', 'bme280', 'brownout',
  'usbc', 'pd', 'vbus', 'cc1', 'cc2', 'stusb4500', 'mosfet', '20v', 'tvs', 'esd',
  'voltage', 'current', 'continuity', 'resistance', 'probe', 'probes', 'multimeter', 'mna',
  'diagnosis', 'hypothesis', 'evidence', 'score', 'scoring', 'rubric', 'efficiency', 'fault', 'short', 'open', 'solder', 'bridge',
  'virtual', 'live', 'muse', 'spark', 'replay', 'playback', 'demo',
  'mcp', 'oauth', 'token', 'refresh', 'chatgpt', 'canvas', 'pcb', 'theme', 'light', 'dark',
]);

function extractHistoryDomainTerms(history: RagHistoryMessage[]): string[] {
  const recentText = history
    .slice(-4)
    .map((m) => m.content)
    .join(' ');
  const tokens = tokenize(recentText);
  const found: string[] = [];
  for (const t of tokens) {
    if (SALIENT_DOMAIN_TERMS.has(t) && !found.includes(t)) {
      found.push(t);
    }
  }
  return found.slice(0, 6);
}

function findEntryById(id: string): KnowledgeBaseEntry | undefined {
  return KNOWLEDGE_BASE_ENTRIES.find((e) => e.id === id);
}

function makeSource(entryId: string, fallbackExcerpt?: string): RagSource {
  const entry = findEntryById(entryId);
  if (!entry) {
    return { entryId, title: entryId, excerpt: fallbackExcerpt ?? '' };
  }
  const firstPassage = splitPassages(entry.content)[0] ?? entry.content.slice(0, 260);
  return {
    entryId: entry.id,
    title: entry.title,
    excerpt: fallbackExcerpt ?? firstPassage,
  };
}

function answerConversationalIntent(
  normalized: string,
  session: AssistantSessionContext | null,
  history: RagHistoryMessage[],
): RagResult | null {
  const base = {
    blockedByPolicy: false as const,
    kbVersion: KB_VERSION,
    needsLiveInference: false as const,
    coverage: 'high' as const,
  };
  const boardLabel = session?.boardName ?? session?.boardId ?? 'the active board';
  const hasProbes = (session?.probeMeasurements?.length ?? 0) > 0;
  const hasDiagnosis = !!session?.proposedDiagnosis?.componentRef;
  const hasScore = typeof session?.score?.totalScore === 'number';

  // A. Capability / "What else can I do?" / "What can you help me with?"
  if (CAPABILITY_INTENT.test(normalized)) {
    const sessionNextLine = hasScore
      ? `In your current session on ${boardLabel} (scored ${session?.score?.totalScore}/100), you can click Re-roll random fault for a fresh challenge or switch reference boards.`
      : hasDiagnosis
        ? `In your current session on ${boardLabel}, you have a proposed diagnosis (${session?.proposedDiagnosis?.componentRef} · ${session?.proposedDiagnosis?.faultType}) — you can score it or ask me to explain the evidence.`
        : hasProbes
          ? `In your current session on ${boardLabel}, you have ${session?.probeMeasurements?.length} probe(s) logged — you can take continuity on an abnormal node or ask what to probe next.`
          : `Right now, you can pick one of the three reference boards (F405 Flight Controller, ESP32-S3 Sensor Node, or USB-C PD Trigger) and click Investigate in Virtual Lab.`;

    const answer = [
      'Here is what you can do in TraceForge and what I can help you with:',
      '1. Run a Guided Investigation — pick a circuit and fault scenario, then click Investigate in Virtual Lab or Replay Recorded Live Run.',
      '2. Probe the PCB Yourself — open Advanced Tools & Manual Bench Controls below the PCB canvas to measure node voltages, branch currents, or power-off continuity within the 8-probe budget.',
      '3. Switch Boards or Re-Roll Faults — compare the F405 Flight Controller, ESP32-S3 Sensor Node, and USB-C PD Trigger, or re-roll a random fault.',
      '4. Ask About Your Session — ask me to explain your diagnosis, break down your 0–100 score, interpret an abnormal rail reading (NRST, CC1, 3V3), or suggest your next probe.',
      sessionNextLine,
    ].join('\n\n');

    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [
        makeSource('getting-started'),
        makeSource('capabilities-limitations'),
      ],
      topicIds: ['getting-started', 'capabilities-limitations'],
    };
  }

  // B. Post-diagnosis workflow ("What happens after the diagnosis?")
  if (POST_DIAGNOSIS_INTENT.test(normalized)) {
    const sessionStatus = hasScore
      ? `Your current session on ${boardLabel} is evaluated at ${session?.score?.totalScore}/100. Ask me why you received that score, or re-roll a new fault scenario.`
      : hasDiagnosis
        ? `Your current session on ${boardLabel} has a proposed diagnosis (${session?.proposedDiagnosis?.componentRef} · ${session?.proposedDiagnosis?.faultType}). Evaluating it reveals the withheld fault and computes your 0–100 score.`
        : 'Once a diagnosis is proposed, TraceForge evaluates it against the withheld hidden fault.';

    const answer = [
      'After a diagnosis is proposed, TraceForge runs post-diagnosis evaluation in Step 3:',
      '1. Ground-Truth Comparison — your proposed component, fault class, and verification status (confirmed vs. hypothesis) are compared against the withheld hidden fault.',
      '2. 0–100 Score Breakdown — scores component match, fault-type match, electrical evidence confirmation, and probe efficiency within the 8-probe budget.',
      '3. Scenario Lock & Rework Guidance — revealing the answer locks the scenario against further probing and unlocks targeted rework guidance for confirmed faults.',
      `4. Next Actions — ${sessionStatus}`,
    ].join('\n\n');

    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [
        makeSource('scoring-verification'),
        makeSource('investigation-lifecycle'),
      ],
      topicIds: ['scoring-verification', 'investigation-lifecycle'],
    };
  }

  // C. Next-step recommendation ("What should I try next?", "Where should I start?")
  if (NEXT_STEP_INTENT.test(normalized)) {
    let answer: string;
    if (hasScore) {
      answer = [
        `You already completed and scored ${boardLabel} (${session?.score?.totalScore}/100). Here are great next steps:`,
        '• Click Re-roll random fault in Step 1 to test your troubleshooting on a different hidden fault on the same board.',
        '• Switch to one of the other reference circuits (F405 Flight Controller, ESP32-S3 Sensor Node, or USB-C PD 20V Trigger) to diagnose a different power/bus topology.',
        '• Open Advanced Tools & Manual Bench Controls below the PCB to practice manual 2-probe troubleshooting before running the automated investigator.',
      ].join('\n\n');
    } else if (hasDiagnosis) {
      answer = [
        `You have a proposed diagnosis on ${boardLabel} (${session?.proposedDiagnosis?.componentRef} · ${session?.proposedDiagnosis?.faultType}). Next:`,
        '• Check whether your probe log includes both an abnormal rail voltage and a decisive power-off continuity/resistance measurement on the suspect node.',
        '• Evaluate/score the diagnosis to see your 0–100 breakdown against the withheld hidden fault, or ask me "Explain my diagnosis."',
      ].join('\n\n');
    } else if (hasProbes) {
      answer = [
        `You have ${session?.probeMeasurements?.length} probe measurement(s) on ${boardLabel}:\n${formatProbeSummary(session?.probeMeasurements)}`,
        'Recommended next step: take a power-off continuity/resistance check on the first abnormal node to confirm whether a collapsed voltage is caused by a low-resistance short to ground, a pin-to-pin solder bridge, or an upstream open circuit.',
      ].join('\n\n');
    } else {
      answer = [
        `To get started on ${boardLabel}, follow this fast 3-step diagnostic flow:`,
        '1. Measure primary power rails first (for example TP_5V and TP_3V3 on F405, VBUS and 3V3 on ESP32-S3, or VBUS and CC1 on USB-C PD) and compare against nominal datasheet tolerances.',
        '2. When a node reads abnormal, switch to power-off continuity/resistance on that node to distinguish a hard short (< 2 Ω) from an open path or upstream regulator failure.',
        '3. Click Investigate in Virtual Lab (or propose your diagnosis once confirmed) to see the evidence chain and 0–100 score.',
      ].join('\n\n');
    }

    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [
        makeSource('troubleshooting-examples'),
        makeSource('investigation-lifecycle'),
      ],
      topicIds: ['troubleshooting-examples', 'investigation-lifecycle'],
    };
  }

  // D. Walkthrough request ("Can you walk me through this?")
  if (WALKTHROUGH_INTENT.test(normalized)) {
    const answer = [
      `Here is a step-by-step walkthrough of diagnosing a circuit in TraceForge (currently viewing ${boardLabel}):`,
      'Step 1: Select Circuit & Fault Scenario — pick your board (F405 Flight Controller, ESP32-S3 Sensor Node, or USB-C PD Trigger) and choose a symptom scenario or click Re-roll random fault. The actual fault remains withheld.',
      'Step 2: Probe & Investigate — click Investigate in Virtual Lab for an instant zero-cost MNA diagnostic run, or open Advanced Tools & Manual Bench Controls below the PCB canvas to take your own voltage, branch-current, and continuity measurements within the 8-probe budget.',
      'Step 3: Review Diagnostic Evidence & Score — inspect the recorded measurements against nominal datasheet specs, see whether the fault is Confirmed (backed by decisive electrical evidence) or a Hypothesis, and review the 0–100 evaluation score.',
    ].join('\n\n');

    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [
        makeSource('getting-started'),
        makeSource('investigation-lifecycle'),
      ],
      topicIds: ['getting-started', 'investigation-lifecycle'],
    };
  }

  // E. Other board comparison ("How about the other board?", "What about the other circuits?")
  if (OTHER_BOARD_INTENT.test(normalized)) {
    const currentText = `${session?.boardId ?? ''} ${session?.boardName ?? ''} ${history.slice(-2).map((m) => m.content).join(' ')}`.toLowerCase();
    const isF405 = /f405|flight/i.test(currentText);
    const isEsp32 = /esp32|sensor|rp2040/i.test(currentText);
    const isUsbc = /usbc|usb-c|pd|trigger/i.test(currentText);

    const boards: string[] = [];
    if (!isF405) {
      boards.push(
        '• FPV Drone Flight Controller (STM32F405) — step-down power tree (VBAT → MP1584 5V buck → AMS1117 3.3V LDO → STM32F405 MCU) with NRST reset and SWD debug pads; classic faults include NRST-to-GND shorts, pin-to-pin solder bridges on U1, and 3.3V rail collapse.',
      );
    }
    if (!isEsp32) {
      boards.push(
        '• IoT Environmental Sensor Node (ESP32-S3 / I2C Sensor Hub) — 3.3V LDO feeding an MCU and BME280/I2C sensor bus (SDA/SCL pull-ups R1/R2); classic faults include missing I2C pull-up resistors, stuck SDA/SCL lines, and decoupling capacitor leakage causing brownout resets.',
      );
    }
    if (!isUsbc) {
      boards.push(
        '• USB-C PD 20V Trigger Board (STUSB4500) — USB-C VBUS path, CC1/CC2 configuration pins with ESD protection diode D2 and Rd pull-down resistors, and pass-FET switch; classic faults include shorted CC1 ESD diode D2 blocking 20V PD negotiation.',
      );
    }
    if (boards.length === 0) {
      boards.push(
        '• FPV Drone Flight Controller (STM32F405) — VBAT → 5V buck → 3.3V LDO power tree + NRST/SWD.',
        '• IoT Environmental Sensor Node (ESP32-S3) — 3.3V regulator + I2C SDA/SCL pull-up network and sensor bus.',
        '• USB-C PD 20V Trigger Board — VBUS switch + CC1/CC2 PD negotiation and ESD protection.',
      );
    }

    const answer = [
      'Here are the other reference boards you can switch to in Step 1 (Select Circuit & Fault Scenario):',
      ...boards,
      'You can switch boards at any time from the Circuit dropdown in Step 1 — each board has its own PCB layout, nominal datasheet specs, and hidden fault scenarios.',
    ].join('\n\n');

    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [
        makeSource('selecting-circuits'),
        makeSource('troubleshooting-examples'),
      ],
      topicIds: ['selecting-circuits', 'troubleshooting-examples'],
    };
  }

  // F. Conversational follow-ups referencing the previous turn ("Tell me more", "How does that work?", "Can you explain that?", "Why?")
  const isFollowUpIntent =
    FOLLOWUP_ELABORATE_INTENT.test(normalized) ||
    FOLLOWUP_HOW_WORK_INTENT.test(normalized) ||
    FOLLOWUP_EXPLAIN_INTENT.test(normalized) ||
    FOLLOWUP_WHY_INTENT.test(normalized);

  if (isFollowUpIntent) {
    const contextTerms = extractHistoryDomainTerms(history);
    if (contextTerms.length > 0) {
      const docs = buildIndex();
      const expanded: Array<{ term: string; weight: number; original: string }> = [];
      for (const t of contextTerms) {
        expanded.push({ term: t, weight: 1, original: t });
        for (const syn of SYNONYMS[t] ?? []) {
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
      const second = ranked[1];
      if (top && top.score > 0) {
        const passages = splitPassages(top.doc.entry.content);
        const detailPassages = passages.length > 1 ? passages.slice(1, 3) : passages.slice(0, 2);
        const extraPassage =
          second && second.score >= MEDIUM_THRESHOLD
            ? extractPassages(second.doc.entry, queryTokenSet, 1)[0]
            : undefined;
        const bodyParts = [...detailPassages];
        if (extraPassage && !bodyParts.includes(extraPassage)) {
          bodyParts.push(extraPassage);
        }
        const answer = bodyParts.join('\n\n');
        const supporting = [top, ...(second && second.score >= MEDIUM_THRESHOLD ? [second] : [])];
        return {
          ...base,
          answer,
          fallbackAnswer: answer,
          sources: supporting.map((r) => ({
            entryId: r.doc.entry.id,
            title: r.doc.entry.title,
            excerpt: extractPassages(r.doc.entry, queryTokenSet, 1)[0] ?? '',
          })),
          topicIds: supporting.map((r) => r.doc.entry.id),
        };
      }
    }

    // If there is no prior history topic, ground in the active session or general workflow overview.
    if (hasDiagnosis || hasProbes) {
      const sessionFollowUp = answerSessionIntent('Explain my diagnosis.', session as AssistantSessionContext);
      if (sessionFollowUp) return sessionFollowUp;
    }

    const gettingStarted = findEntryById('getting-started');
    const lifecycle = findEntryById('investigation-lifecycle');
    const answer = [
      gettingStarted ? splitPassages(gettingStarted.content).slice(0, 2).join(' ') : '',
      lifecycle ? splitPassages(lifecycle.content).slice(0, 2).join(' ') : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      ...base,
      answer,
      fallbackAnswer: answer,
      sources: [makeSource('getting-started'), makeSource('investigation-lifecycle')],
      topicIds: ['getting-started', 'investigation-lifecycle'],
    };
  }

  return null;
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
