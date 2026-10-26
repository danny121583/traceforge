import { describe, expect, it } from 'vitest';
import {
  validateDiagnosticResult,
  parseDiagnosticJson,
  parseStreamTranscript,
  extractCitations,
} from '../src/lib/diagnostic-parser';

const VALID = {
  boardId: 'f405-flight-controller',
  faultType: 'solder_bridge',
  componentRef: 'U1',
  confidence: 0.94,
  steps: [
    { kind: 'reasoning', text: 'NRST at 0.02V' },
    { kind: 'tool_call', text: 'lookup_pinout(STM32F405RGT6, 15)' },
    { kind: 'conclusion', text: 'Bridge pins 14-15' },
  ],
  rework: {
    ironTempC: 320,
    tip: 'hoof',
    steps: ['Remove bridge with wick'],
    safetyChecks: ['Power off'],
  },
  citations: ['STM32F405 §3'],
};

describe('structured output validation', () => {
  it('accepts a valid diagnostic result', () => {
    const r = validateDiagnosticResult(VALID);
    expect(r.componentRef).toBe('U1');
    expect(r.rework.ironTempC).toBe(320);
  });

  it('rejects missing board identity fields', () => {
    expect(() => validateDiagnosticResult({ ...VALID, boardId: '' })).toThrow();
    expect(() => validateDiagnosticResult({ ...VALID, componentRef: 42 })).toThrow();
  });

  it('rejects out-of-range confidence', () => {
    expect(() => validateDiagnosticResult({ ...VALID, confidence: 1.5 })).toThrow();
    expect(() => validateDiagnosticResult({ ...VALID, confidence: -0.1 })).toThrow();
  });

  it('rejects empty steps and bad step kinds', () => {
    expect(() => validateDiagnosticResult({ ...VALID, steps: [] })).toThrow();
    expect(() =>
      validateDiagnosticResult({ ...VALID, steps: [{ kind: 'guessing', text: 'x' }] }),
    ).toThrow();
  });

  it('rejects unsafe iron temperatures', () => {
    expect(() =>
      validateDiagnosticResult({ ...VALID, rework: { ...VALID.rework, ironTempC: 600 } }),
    ).toThrow();
  });

  it('parses JSON strings and rejects malformed JSON', () => {
    expect(parseDiagnosticJson(JSON.stringify(VALID)).faultType).toBe('solder_bridge');
    expect(() => parseDiagnosticJson('not json')).toThrow();
    expect(() => parseDiagnosticJson(JSON.stringify({ foo: 1 }))).toThrow();
  });
});

describe('stream transcript parsing', () => {
  it('classifies streamed lines by marker', () => {
    const steps = parseStreamTranscript(
      ['▸ reasoning here', '✓ RAIL 3V3 ok', '⏚ CONTINUITY short', '❚ CITATION x', '■ DIAGNOSIS bridge'].join('\n'),
    );
    expect(steps.map((s) => s.kind)).toEqual(['tool_call', 'rule_check', 'rule_check', 'citation', 'conclusion']);
  });

  it('skips blank lines', () => {
    expect(parseStreamTranscript('\n\n▸ hi\n\n')).toHaveLength(1);
  });
});

describe('citation extraction', () => {
  it('extracts datasheet markers and dedupes', () => {
    const text = '[DATASHEET: A]\nbody\n[DATASHEET: B]\n[DATASHEET: A]';
    expect(extractCitations(text)).toEqual(['A', 'B']);
  });
});
