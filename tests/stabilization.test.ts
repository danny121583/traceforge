import { describe, expect, it } from 'vitest';
import {
  validateDiagnosticResult,
  parseDiagnosticJson,
  parseEvidenceTranscript,
  diagnosisVerificationStatus,
} from '../src/lib/diagnostic-parser';
import { parseVoltage, parseResistance, validateProbePair } from '../src/lib/electrical';
import { MetaClient, STATIC_FIXTURE_MASKS } from '../src/lib/meta-client';

const BASE = {
  boardId: 'f405-flight-controller',
  faultType: 'solder_bridge',
  componentRef: 'U1',
  confidence: 0.82,
  steps: [{ kind: 'reasoning', text: 'NRST at 0.02V' }],
  rework: { ironTempC: 320, tip: 'hoof', steps: ['Remove bridge with wick'], safetyChecks: ['Power off'] },
  citations: ['STM32F405 §3'],
};

describe('multimeter voltage parsing', () => {
  it('parses V, mV, uV, raw numbers, and negative rails', () => {
    expect(parseVoltage('3.3V')).toBeCloseTo(3.3);
    expect(parseVoltage('3300mV')).toBeCloseTo(3.3);
    expect(parseVoltage('500uV')).toBeCloseTo(0.0005);
    expect(parseVoltage('500µV')).toBeCloseTo(0.0005);
    expect(parseVoltage('-12V')).toBeCloseTo(-12);
    expect(parseVoltage('-5 V')).toBeCloseTo(-5);
    expect(parseVoltage(3.3)).toBeCloseTo(3.3);
    expect(parseVoltage('0.02')).toBeCloseTo(0.02);
    expect(parseVoltage('  5V  ')).toBeCloseTo(5);
  });

  it('rejects malformed voltage inputs', () => {
    expect(() => parseVoltage('abc')).toThrow();
    expect(() => parseVoltage('')).toThrow();
    expect(() => parseVoltage('3.3X')).toThrow();
    expect(() => parseVoltage(Number.NaN)).toThrow();
  });
});

describe('multimeter resistance parsing', () => {
  it('parses ohms, kilo, mega, and milli scales', () => {
    expect(parseResistance('0.4 Ω')).toBeCloseTo(0.4);
    expect(parseResistance('100 ohm')).toBeCloseTo(100);
    expect(parseResistance('4.7kΩ')).toBeCloseTo(4700);
    expect(parseResistance('10k')).toBeCloseTo(10_000);
    expect(parseResistance('12MΩ')).toBeCloseTo(12_000_000);
    expect(parseResistance('2M')).toBeCloseTo(2_000_000);
    expect(parseResistance('500mΩ')).toBeCloseTo(0.5);
    expect(parseResistance(4700)).toBe(4700);
  });

  it('maps open-circuit indicators to Infinity', () => {
    for (const token of ['inf', 'OL', 'ol', 'open', '---']) {
      expect(parseResistance(token)).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('rejects malformed and negative resistances', () => {
    expect(() => parseResistance('abc')).toThrow();
    expect(() => parseResistance('')).toThrow();
    expect(() => parseResistance('-4 Ω')).toThrow();
    expect(() => parseResistance('-10k')).toThrow();
    expect(() => parseResistance(-1)).toThrow();
    expect(() => parseResistance('10 parsecs')).toThrow();
  });
});

describe('probe point validation', () => {
  const known = ['TP3', 'TP_5V', 'GND'];

  it('accepts a valid distinct pair', () => {
    expect(() => validateProbePair('TP3', 'GND', known)).not.toThrow();
  });

  it('rejects missing probe points', () => {
    expect(() => validateProbePair(null, 'GND', known)).toThrow(/missing/i);
    expect(() => validateProbePair('TP3', undefined, known)).toThrow(/missing/i);
    expect(() => validateProbePair('  ', 'GND', known)).toThrow();
  });

  it('rejects self-measurements and unknown points', () => {
    expect(() => validateProbePair('TP3', 'TP3', known)).toThrow();
    expect(() => validateProbePair('TP3', 'NOPE', known)).toThrow(/unknown/i);
    expect(() => validateProbePair('NOPE', 'GND', known)).toThrow(/unknown/i);
  });
});

describe('evidence classification', () => {
  it('validates classified fields and defaults them to empty', () => {
    const bare = validateDiagnosticResult(BASE);
    expect(bare.observedEvidence).toEqual([]);
    expect(bare.probeMeasurements).toEqual([]);
    expect(bare.datasheetSpecs).toEqual([]);
    expect(bare.hypotheses).toEqual([]);
    expect(bare.nextVerificationSteps).toEqual([]);

    const full = validateDiagnosticResult({
      ...BASE,
      observedEvidence: ['NRST reads 0.02V'],
      probeMeasurements: [{ point: 'TP3', value: '0.02V', status: 'abnormal' }],
      datasheetSpecs: [{ section: '§3 Pinouts', spec: 'NRST active-low' }],
      hypotheses: [{ claim: 'Solder bridge pins 14-15', likelihood: 'high', falsificationTest: 'Wick and re-probe' }],
      nextVerificationSteps: ['Re-probe NRST after rework'],
    });
    expect(full.probeMeasurements[0]).toEqual({ point: 'TP3', value: '0.02V', status: 'abnormal' });
    expect(full.hypotheses[0]!.likelihood).toBe('high');
  });

  it('rejects malformed classified fields', () => {
    expect(() =>
      validateDiagnosticResult({ ...BASE, probeMeasurements: [{ point: 'TP3', value: '0V' }] }),
    ).toThrow(/status/);
    expect(() =>
      validateDiagnosticResult({
        ...BASE,
        hypotheses: [{ claim: 'x', likelihood: 'certain', falsificationTest: 'y' }],
      }),
    ).toThrow(/likelihood/);
    expect(() =>
      validateDiagnosticResult({ ...BASE, hypotheses: [{ claim: '', likelihood: 'low', falsificationTest: 'y' }] }),
    ).toThrow();
    expect(() => validateDiagnosticResult({ ...BASE, probeMeasurements: 'none' })).toThrow();
  });

  it('round-trips classified fields through JSON', () => {
    const text = JSON.stringify({
      ...BASE,
      observedEvidence: ['hot spot near C4'],
      probeMeasurements: [{ point: '5V', value: '4.2V', status: 'abnormal' }],
      datasheetSpecs: [{ section: '§4.3', spec: 'brownout 4.4V' }],
      hypotheses: [{ claim: 'C4 reversed', likelihood: 'medium', falsificationTest: 'lift C4, re-measure rail' }],
      nextVerificationSteps: ['Lift C4 and re-measure'],
    });
    const r = parseDiagnosticJson(text);
    expect(r.observedEvidence).toEqual(['hot spot near C4']);
    expect(r.nextVerificationSteps).toHaveLength(1);
  });

  it('keeps hypotheses distinct from verified facts in transcripts', () => {
    const ev = parseEvidenceTranscript(
      [
        'OBSERVED: NRST test pad reads 0.02V, MCU cold',
        'MEASUREMENT: TP3 = 0.02V abnormal',
        'DATASHEET: §5.3.1 NRST — active-low, internal pull-up to 3.3V',
        'HYPOTHESIS [high]: solder bridge pins 14-15 FALSIFY: wick bridge, re-probe NRST',
        'NEXT: re-probe NRST after rework',
      ].join('\n'),
    );
    expect(ev.observedEvidence).toHaveLength(1);
    expect(ev.probeMeasurements).toEqual([{ point: 'TP3', value: 'TP3 = 0.02V abnormal', status: 'abnormal' }]);
    expect(ev.datasheetSpecs[0]!.section).toContain('5.3.1');
    expect(ev.hypotheses).toEqual([
      { claim: 'solder bridge pins 14-15', likelihood: 'high', falsificationTest: 'wick bridge, re-probe NRST' },
    ]);
    expect(ev.nextVerificationSteps).toHaveLength(1);
  });

  it('marks unmeasured diagnoses as hypotheses, measured ones as confirmed', () => {
    const hypo = diagnosisVerificationStatus({
      probeMeasurements: [],
      hypotheses: [{ claim: 'bridge?', likelihood: 'low', falsificationTest: 'probe it' }],
    });
    expect(hypo.status).toBe('hypothesis');

    const inconclusive = diagnosisVerificationStatus({
      probeMeasurements: [{ point: 'X', value: '?', status: 'inconclusive' }],
      hypotheses: [{ claim: 'bridge?', likelihood: 'high', falsificationTest: 'probe it' }],
    });
    expect(inconclusive.status).toBe('hypothesis');

    const confirmed = diagnosisVerificationStatus({
      probeMeasurements: [{ point: 'TP3', value: '0.02V', status: 'abnormal' }],
      hypotheses: [{ claim: 'bridge', likelihood: 'high', falsificationTest: 'wick it' }],
    });
    expect(confirmed.status).toBe('confirmed');
  });
});

describe('SAM segmentation transparency', () => {
  it('exposes a segmentation mode in status', () => {
    expect(new MetaClient({ mode: 'simulated' }).status().segmentationMode).toBe('static_fixture');
    expect(new MetaClient({ mode: 'live', apiKey: 'k' }).status().segmentationMode).toBe('live_api');
    expect(
      new MetaClient({ mode: 'live', apiKey: 'k', segmentationMode: 'static_fixture' }).status().segmentationMode,
    ).toBe('static_fixture');
  });

  it('returns fixture masks honestly labeled when offline', async () => {
    const client = new MetaClient({ mode: 'simulated' });
    const res = await client.segmentImage({ url: 'file://board.png' });
    expect(res.mode).toBe('static_fixture');
    expect(res.masks.length).toBeGreaterThan(0);
    expect(res.masks).toEqual(STATIC_FIXTURE_MASKS);
  });

  it('returns fixture masks when segmentation is forced to fixture in live mode', async () => {
    const client = new MetaClient({ mode: 'live', apiKey: 'k', segmentationMode: 'static_fixture' });
    const res = await client.segmentImage({ url: 'file://board.png' });
    expect(res.mode).toBe('static_fixture');
  });

  it('shapes a live /v1/responses payload and reports live masks', async () => {
    const calls: string[] = [];
    const client = new MetaClient({
      mode: 'live',
      apiKey: 'k',
      fetchFn: async (url, init) => {
        calls.push(`${url} ${init.body}`);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            masks: [{ id: 'm1', label: 'U1', polygon: [[0, 0], [1, 1]] }],
            confidence: 0.91,
          }),
        };
      },
    });
    const res = await client.segmentImage({ url: 'file://board.png', points: [{ x: 1, y: 2 }] });
    expect(res.mode).toBe('live_api');
    expect(res.masks[0]!.id).toBe('m1');
    expect(res.confidence).toBeCloseTo(0.91);
    expect(calls[0]).toContain('/v1/responses');
    expect(calls[0]).toContain('sam-3.1');
  });

  it('surfaces API failure instead of fabricating masks', async () => {
    const client = new MetaClient({
      mode: 'live',
      apiKey: 'k',
      fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    await expect(client.segmentImage({ url: 'file://board.png' })).rejects.toThrow('HTTP 503');
  });

  it('rejects live segmentation without image input', async () => {
    const client = new MetaClient({ mode: 'live', apiKey: 'k' });
    await expect(client.segmentImage({})).rejects.toThrow(/url or base64/);
  });
});
