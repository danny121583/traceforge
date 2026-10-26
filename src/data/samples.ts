/** Reference test boards, SAM 3.1 overlays, datasheet extracts, and expected diagnostics. */
import type { DatasheetSection } from '../lib/meta-client';

export interface BBox {
  /** 0–1000 normalized board coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PinDef {
  number: string;
  name: string;
  function: string;
}

export interface BoardComponent {
  ref: string;
  partNumber: string;
  kind: 'IC' | 'capacitor' | 'diode' | 'resistor' | 'connector' | 'testpad';
  bbox: BBox;
  /** Simplified polygon mask for SAM 3.1 overlay rendering. */
  mask: Array<[number, number]>;
  pins?: PinDef[];
  notes?: string;
}

export interface ProbePoint {
  id: string;
  label: string;
  net: string;
  x: number;
  y: number;
  /** Expected live reading in the faulted state. */
  expectedVolts?: number;
  expectedOhmsToGnd?: number;
}

export interface ExpectedDiagnosticStep {
  order: number;
  action: string;
  detail: string;
}

export interface SampleBoard {
  id: string;
  name: string;
  subtitle: string;
  faultType: string;
  faultSummary: string;
  symptoms: string[];
  components: BoardComponent[];
  probePoints: ProbePoint[];
  datasheet: DatasheetSection[];
  expectedSteps: ExpectedDiagnosticStep[];
  rework: {
    ironTempC: number;
    tip: string;
    steps: string[];
    replacementPart?: string;
    safetyChecks: string[];
  };
}

export const SAMPLE_BOARDS: SampleBoard[] = [
  {
    id: 'f405-flight-controller',
    name: 'FPV Drone Flight Controller (F405)',
    subtitle: 'STM32F405RGT6 · 4-layer · 36×36 mm',
    faultType: 'solder_bridge',
    faultSummary:
      'Microscopic solder bridge between STM32 Pin 14 (3.3V VDD) and Pin 15 (NRST), holding the MCU in perpetual reset.',
    symptoms: [
      'Board enumerates no USB device; Betaflight Configurator shows no port.',
      'NRST test pad measures 0.02 V (expected 3.3 V pull-up).',
      '3V3 rail sags to 3.05 V under load; MCU package stays cold.',
      'Visual: faint solder fillet bridging adjacent LQFP64 pins 14–15 under 10× loupe.',
    ],
    components: [
      {
        ref: 'U1',
        partNumber: 'STM32F405RGT6',
        kind: 'IC',
        bbox: { x: 350, y: 300, w: 300, h: 300 },
        mask: [[350, 300], [650, 300], [650, 600], [350, 600]],
        pins: [
          { number: '14', name: 'VDD', function: '3.3V digital supply — power pin' },
          { number: '15', name: 'NRST', function: 'Active-low reset, internal pull-up to VDD' },
          { number: '16', name: 'VDDA', function: 'Analog supply 3.3V' },
          { number: '23', name: 'PA9', function: 'USART1_TX' },
          { number: '24', name: 'PA10', function: 'USART1_RX' },
        ],
        notes: 'LQFP64, 0.5 mm pitch. Suspect bridge pins 14–15.',
      },
      { ref: 'C7', partNumber: 'GRM155R71C104KA88', kind: 'capacitor', bbox: { x: 660, y: 340, w: 60, h: 40 }, mask: [[660, 340], [720, 340], [720, 380], [660, 380]], notes: '100 nF VDD decoupling.' },
      { ref: 'Y1', partNumber: 'ABM8-8.000MHZ', kind: 'resistor', bbox: { x: 300, y: 620, w: 120, h: 60 }, mask: [[300, 620], [420, 620], [420, 680], [300, 680]], notes: '8 MHz HSE crystal.' },
      { ref: 'TP_NRST', partNumber: 'TESTPAD', kind: 'testpad', bbox: { x: 700, y: 500, w: 50, h: 50 }, mask: [[700, 500], [750, 500], [750, 550], [700, 550]], notes: 'Exposed NRST via.' },
      { ref: 'TP_3V3', partNumber: 'TESTPAD', kind: 'testpad', bbox: { x: 700, y: 580, w: 50, h: 50 }, mask: [[700, 580], [750, 580], [750, 630], [700, 630]], notes: 'Exposed 3V3 rail.' },
      { ref: 'J1', partNumber: 'USB-C-16P', kind: 'connector', bbox: { x: 420, y: 120, w: 160, h: 100 }, mask: [[420, 120], [580, 120], [580, 220], [420, 220]], notes: 'USB-C for DFU / Betaflight.' },
    ],
    probePoints: [
      { id: 'U1-14', label: 'U1 pin 14 (VDD)', net: '3V3', x: 350, y: 380, expectedVolts: 3.05 },
      { id: 'U1-15', label: 'U1 pin 15 (NRST)', net: 'NRST', x: 350, y: 410, expectedVolts: 0.02 },
      { id: 'TP_3V3', label: 'TP_3V3', net: '3V3', x: 725, y: 605, expectedVolts: 3.05 },
      { id: 'TP_NRST', label: 'TP_NRST', net: 'NRST', x: 725, y: 525, expectedVolts: 0.02 },
      { id: 'GND', label: 'GND pad', net: 'GND', x: 120, y: 850, expectedVolts: 0 },
    ],
    datasheet: [
      {
        title: 'STM32F405 — §3 Pinouts, Table 5 (LQFP64)',
        text: 'Pin 14: VDD — digital power supply, 1.8–3.6 V (nominal 3.3 V). Pin 15: NRST — reset, bidirectional with internal pull-up (~40 kΩ to VDD), active low. Driving NRST below VIL(min)=0.7 V for >20 µs forces a full device reset.',
      },
      {
        title: 'STM32F405 — §5.3.1 NRST electricals',
        text: 'NRST floating level rests at VDD via the internal pull-up. A DC path from NRST to VDD through less than ~1 kΩ indicates an assembly short; the device will remain in reset and the core will draw only leakage current (MCU stays cold).',
      },
      {
        title: 'Assembly — LQFP 0.5mm pitch inspection',
        text: '0.5 mm pitch QFPs are prone to microscopic bridging under excess paste. Confirm with DMM continuity (<2 Ω beep) between suspect adjacent pins with power removed.',
      },
    ],
    expectedSteps: [
      { order: 1, action: 'lookup_pinout', detail: 'Confirm U1 pin 14 = VDD 3.3V and pin 15 = NRST (active-low).' },
      { order: 2, action: 'verify_rail_voltage', detail: 'NRST at 0.02 V vs 3.3 V nominal → hard fault, not noise.' },
      { order: 3, action: 'check_continuity', detail: 'U1-14 ↔ U1-15 reads 0.4 Ω → direct pin-to-pin short.' },
      { order: 4, action: 'generate_rework_guidance', detail: 'Wick the bridge at U1 pins 14–15, re-test NRST pull-up.' },
    ],
    rework: {
      ironTempC: 320,
      tip: '1.2 mm hoof / fine chisel',
      steps: [
        'Power off, unplug LiPo + USB. Verify 0 V on 3V3 pad.',
        'Flood pins 14–15 with no-clean flux.',
        '320 °C iron, drag a clean tinned hoof tip from pin 16 toward pin 13 to pull the bridge onto the tip.',
        'If solder persists, use 1.5 mm wick with fresh flux — press, do not scrape.',
        'Clean with IPA, inspect at 10×, meter U1-14 ↔ U1-15 (expect open, >1 MΩ).',
        'Power via USB, confirm NRST = 3.3 V and USB enumeration.',
      ],
      safetyChecks: ['LiPo disconnected before iron touches board', 'ESD wrist strap on', 'Fume extraction running'],
    },
  },
  {
    id: 'esp32s3-sensor-node',
    name: 'ESP32-S3 IoT Sensor Node',
    subtitle: 'ESP32-S3-WROOM-1 · battery + USB-C · 5V rail',
    faultType: 'reverse_polarity',
    faultSummary:
      'Reverse-polarity tantalum decoupling capacitor (C4) on the 5 V rail overheating and triggering the brownout detector.',
    symptoms: [
      'Node boot-loops; serial shows "Brownout detector was triggered".',
      '5 V rail sags to 4.2 V; C4 package too hot to touch (>85 °C).',
      'Current draw 480 mA at idle (expected ~90 mA).',
      'Stripe (positive) of tantalum C4 faces ground instead of 5V.',
    ],
    components: [
      {
        ref: 'U1',
        partNumber: 'ESP32-S3-WROOM-1',
        kind: 'IC',
        bbox: { x: 300, y: 200, w: 400, h: 300 },
        mask: [[300, 200], [700, 200], [700, 500], [300, 500]],
        pins: [
          { number: '3V3', name: '3V3', function: 'Regulated output to sensors' },
          { number: '5V', name: '5V', function: 'USB / input rail' },
          { number: 'EN', name: 'EN', function: 'Active-high enable with RC delay' },
        ],
      },
      { ref: 'C4', partNumber: 'TAJC106M035R', kind: 'capacitor', bbox: { x: 560, y: 560, w: 90, h: 60 }, mask: [[560, 560], [650, 560], [650, 620], [560, 620]], notes: '10 µF tantalum, 35 V. Fitted reversed — stripe toward GND.' },
      { ref: 'U2', partNumber: 'AMS1117-3.3', kind: 'IC', bbox: { x: 200, y: 560, w: 120, h: 80 }, mask: [[200, 560], [320, 560], [320, 640], [200, 640]], notes: '3.3 V LDO feeding ESP32.' },
      { ref: 'TP_5V', partNumber: 'TESTPAD', kind: 'testpad', bbox: { x: 760, y: 560, w: 50, h: 50 }, mask: [[760, 560], [810, 560], [810, 610], [760, 610]] },
      { ref: 'J1', partNumber: 'USB-C-16P', kind: 'connector', bbox: { x: 430, y: 80, w: 140, h: 90 }, mask: [[430, 80], [570, 80], [570, 170], [430, 170]] },
    ],
    probePoints: [
      { id: 'TP_5V', label: 'TP_5V', net: '5V', x: 785, y: 585, expectedVolts: 4.2 },
      { id: 'C4-POS', label: 'C4 + terminal', net: '5V', x: 640, y: 590, expectedVolts: 4.2 },
      { id: 'U2-OUT', label: 'U2 3V3 out', net: '3V3', x: 300, y: 600, expectedVolts: 3.1 },
      { id: 'GND', label: 'GND pad', net: 'GND', x: 120, y: 850, expectedVolts: 0 },
    ],
    datasheet: [
      {
        title: 'ESP32-S3 — §4.3 Power & brownout',
        text: 'The brownout detector triggers a reset when VDD falls below ~2.8 V (VDD3P3). Sagging input rails under excess load produce cyclic "Brownout detector was triggered" boot loops.',
      },
      {
        title: 'TAJC tantalum — polarity application note',
        text: 'Tantalum capacitors are polarized: the stripe marks POSITIVE. Reverse bias above ~1 V causes high leakage current, self-heating, and eventual venting/ignition. A reversed 10 µF part on 5 V can draw hundreds of mA and drag the rail down.',
      },
      {
        title: 'AMS1117-3.3 — dropout characteristics',
        text: 'Dropout ~1.1 V at 500 mA. With the 5 V rail sagged to 4.2 V the regulator output falls to ~3.1 V, marginal for the ESP32-S3 RF calibration.',
      },
    ],
    expectedSteps: [
      { order: 1, action: 'verify_rail_voltage', detail: '5 V rail at 4.2 V: −16%, outside ±5% tolerance.' },
      { order: 2, action: 'lookup_pinout', detail: 'Identify C4 as polarized tantalum; stripe must face 5V.' },
      { order: 3, action: 'check_continuity', detail: 'Thermal + current evidence isolates C4 as leakage path.' },
      { order: 4, action: 'generate_rework_guidance', detail: 'Remove C4, replace with correctly oriented part.' },
    ],
    rework: {
      ironTempC: 320,
      tip: '2.4 mm chisel + hot air 350 °C',
      steps: [
        'Power off, unplug USB/battery. Let C4 cool — burn hazard.',
        'Remove C4 with hot air (350 °C, low flow) or two-iron method.',
        'Clean pads with wick + flux; tin one pad.',
        'Fit new TAJC106M035R with stripe toward the 5V pad. Verify orientation twice.',
        'Reflow, clean IPA, power via current-limited supply (200 mA limit) first.',
        'Confirm 5.0 V rail, 3.3 V LDO output, idle current ~90 mA.',
      ],
      replacementPart: 'TAJC106M035R (10 µF tantalum, 35 V) — or ceramic GRM21BR61E106KA73 as non-polarized alt',
      safetyChecks: ['C4 is a burn hazard — do not touch', 'Current-limited supply for first power-up', 'Watch for venting/smoke on tantalums'],
    },
  },
  {
    id: 'usbc-pd-trigger',
    name: 'USB-C Power Delivery Trigger',
    subtitle: 'CH224K PD sink · 20V output · CC1/CC2 sense',
    faultType: 'shorted_diode',
    faultSummary: 'Blown TVS protection diode (D2) shorting the CC1 line to ground.',
    symptoms: [
      'No PD negotiation; charger stays at 5 V, never offers 20 V.',
      'CC1 line measures 0.00 V (expected ~0.4–1.2 V pull-up by source).',
      'CC1 ↔ GND reads 0.2 Ω with power removed.',
      'D2 package shows micro-crater / discoloration from EOS event.',
    ],
    components: [
      {
        ref: 'U1',
        partNumber: 'CH224K',
        kind: 'IC',
        bbox: { x: 380, y: 300, w: 240, h: 240 },
        mask: [[380, 300], [620, 300], [620, 540], [380, 540]],
        pins: [
          { number: 'CC1', name: 'CC1', function: 'Configuration channel 1 sense' },
          { number: 'CC2', name: 'CC2', function: 'Configuration channel 2 sense' },
          { number: 'CFG', name: 'CFG', function: 'Voltage select strapping' },
        ],
      },
      { ref: 'D2', partNumber: 'ESD05V52D-C', kind: 'diode', bbox: { x: 300, y: 600, w: 70, h: 50 }, mask: [[300, 600], [370, 600], [370, 650], [300, 650]], notes: 'TVS on CC1, failed short (typical EOS mode).' },
      { ref: 'D3', partNumber: 'ESD05V52D-C', kind: 'diode', bbox: { x: 630, y: 600, w: 70, h: 50 }, mask: [[630, 600], [700, 600], [700, 650], [630, 650]], notes: 'TVS on CC2, healthy reference.' },
      { ref: 'J1', partNumber: 'USB-C-24P', kind: 'connector', bbox: { x: 400, y: 110, w: 200, h: 110 }, mask: [[400, 110], [600, 110], [600, 220], [400, 220]] },
      { ref: 'TP_CC1', partNumber: 'TESTPAD', kind: 'testpad', bbox: { x: 240, y: 680, w: 50, h: 50 }, mask: [[240, 680], [290, 680], [290, 730], [240, 730]] },
      { ref: 'TP_CC2', partNumber: 'TESTPAD', kind: 'testpad', bbox: { x: 710, y: 680, w: 50, h: 50 }, mask: [[710, 680], [760, 680], [760, 730], [710, 730]] },
    ],
    probePoints: [
      { id: 'CC1', label: 'TP_CC1', net: 'CC1', x: 265, y: 705, expectedVolts: 0.0 },
      { id: 'CC2', label: 'TP_CC2', net: 'CC2', x: 735, y: 705, expectedVolts: 0.8 },
      { id: 'GND', label: 'GND pad', net: 'GND', x: 120, y: 850, expectedVolts: 0 },
    ],
    datasheet: [
      {
        title: 'USB-C spec — §4.5 CC requirements',
        text: 'A sink advertises Rd (5.1 kΩ) on CC1/CC2; the source pull-up places ~0.4–1.2 V on the connected CC line. A CC line at 0 V with cable attached indicates a short to ground or a failed protection device.',
      },
      {
        title: 'ESD05V52D-C — failure modes',
        text: 'Under electrical overstress beyond peak pulse power, the TVS junction fails short-circuit, clamping the protected line to ground. Remedy: remove/replace the diode; the line recovers if the controller is undamaged.',
      },
      {
        title: 'CH224K — PD negotiation debug',
        text: 'If neither CC1 nor CC2 rises above 0.2 V, the CH224K stays in detach and negotiates nothing. Compare CC1 vs CC2: asymmetry isolates the fault to one line’s protection network.',
      },
    ],
    expectedSteps: [
      { order: 1, action: 'verify_rail_voltage', detail: 'CC1 at 0.00 V vs CC2 at 0.8 V → fault is CC1-specific.' },
      { order: 2, action: 'check_continuity', detail: 'CC1 ↔ GND 0.2 Ω → hard short on CC1.' },
      { order: 3, action: 'lookup_pinout', detail: 'D2 is the CC1 TVS; short-circuit is its known EOS failure mode.' },
      { order: 4, action: 'generate_rework_guidance', detail: 'Remove D2 to confirm recovery, then replace.' },
    ],
    rework: {
      ironTempC: 300,
      tip: 'fine conical + tweezers',
      steps: [
        'Power off, unplug charger and load. Verify 0 V on VBUS.',
        'Remove D2 with tweezers + 300 °C iron (one pad at a time, add flux).',
        'Meter CC1 ↔ GND: expect open (>1 MΩ). Plug charger: CC1 should rise to ~0.4–1.2 V.',
        'Fit new ESD05V52D-C (or PRTR5V0U2X) in the same orientation.',
        'Re-test PD negotiation through 5/9/15/20 V steps with an e-load.',
      ],
      replacementPart: 'ESD05V52D-C (bidirectional TVS array)',
      safetyChecks: ['VBUS can carry 20 V — verify 0 V before probing', 'Confirm charger-side current limit during first negotiation'],
    },
  },
];

/** Continuity fixtures between named points in the faulted state (ohms). */
export const SIMULATED_CONTINUITY: Record<string, number> = {
  'U1-14|U1-15': 0.4,
  'CC1|GND': 0.2,
  'TP_5V|GND': 11.5,
};

export function getBoard(id: string): SampleBoard | undefined {
  return SAMPLE_BOARDS.find((b) => b.id === id);
}
