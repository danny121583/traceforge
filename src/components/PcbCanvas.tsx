import { useRef, useState } from 'react';
import type { SampleBoard } from '../data/samples';
import type { SegmentationMode } from '../lib/meta-client';
import type { PcbContinuityLine, PcbMeasuredPoint } from '../lib/guided-ux';

interface Props {
  board: SampleBoard;
  selectedRef: string | null;
  probeA: string | null;
  probeB: string | null;
  probeArmed: boolean;
  segmentationMode?: SegmentationMode;
  /** Live highlight: pad ids for the currently executing (or most recent) real measurement. */
  activePointIds?: string[];
  /** Computed readouts from real `ProbeRecord` entries, keyed by probe point id. */
  measuredPoints?: Record<string, PcbMeasuredPoint>;
  /** Live (or most recent) continuity vector between two probe pads. */
  activeContinuityLine?: PcbContinuityLine | null;
  onSelectComponent: (ref: string | null) => void;
  onProbePoint: (id: string) => void;
}

const KIND_COLOR: Record<string, string> = {
  IC: '#35d0e0',
  capacitor: '#ff6a1a',
  diode: '#ffb020',
  resistor: '#a7aebb',
  connector: '#3ddc84',
  testpad: '#e8eaf0',
};

/** Default framing: entire board (components x 120..810, pads y 80..850) centered, undistorted. */
const BASE_VIEW = { x: 40, y: 40, w: 920, h: 860 };

/** Short readout for a callout pill, e.g. `3.267 V` / `0.400 Ω` (+ ` !` when abnormal). */
function shortReading(reading: string, abnormal: boolean): string {
  const m = reading.match(/(-?[\d.]+\s?(?:V|mV|Ω|kΩ|MΩ|mA|A\b|OL))/);
  const base = m?.[1]?.trim() ?? reading.slice(0, 16).trim();
  if (!base) return '';
  return abnormal ? `${base} !` : base;
}

/**
 * Interactive PCB canvas: zoom/pan SVG with clickable SAM 3.1 overlays.
 * The default viewBox frames the whole board (J1 at top through the GND
 * pad at y=850); live measurement highlights (pulse rings, readout
 * callouts, continuity vectors) render ONLY from real `ProbeRecord`
 * entries passed in via `activePointIds` / `measuredPoints` /
 * `activeContinuityLine` — never synthesized when no measurement was made.
 */
export function PcbCanvas({
  board,
  selectedRef,
  probeA,
  probeB,
  probeArmed,
  segmentationMode = 'static_fixture',
  activePointIds = [],
  measuredPoints = {},
  activeContinuityLine = null,
  onSelectComponent,
  onProbePoint,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const viewW = BASE_VIEW.w / zoom;
  const viewH = BASE_VIEW.h / zoom;
  const vx = BASE_VIEW.x + (BASE_VIEW.w - viewW) / 2 + pan.x;
  const vy = BASE_VIEW.y + (BASE_VIEW.h - viewH) / 2 + pan.y;
  const activeSet = new Set(activePointIds);

  return (
    <div className="tf-pane">
      <div className="tf-pane-head">
        <span>{board.name} — Interactive Circuit Layout</span>
        <span className="tf-chip" title="Segmentation source: fixture masks are not live model output">
          {segmentationMode === 'live_api' ? 'Live SAM 3.1' : 'Static Fixture (KiCad)'}
        </span>
        <span className="tf-canvas-tools">
          <button onClick={() => setZoom((z) => Math.min(4, +(z + 0.5).toFixed(2)))}>Zoom +</button>
          <button onClick={() => { setZoom((z) => Math.max(1, +(z - 0.5).toFixed(2))); if (zoom <= 1.5) setPan({ x: 0, y: 0 }); }}>Zoom −</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Reset</button>
        </span>
      </div>
      <div className="tf-canvas-wrap">
        <svg
          viewBox={`${vx} ${vy} ${viewW} ${viewH}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
            (e.target as SVGElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const k = viewW / 600;
            setPan({
              x: drag.current.px - (e.clientX - drag.current.x) * k,
              y: drag.current.py - (e.clientY - drag.current.y) * k,
            });
          }}
          onPointerUp={() => { drag.current = null; }}
        >
          <rect x={60} y={50} width={880} height={840} rx={18} fill="#10151c" stroke="#262c36" strokeWidth={3} />
          {/* decorative traces */}
          {[
            'M120,200 H880', 'M120,800 H880', 'M200,120 V860', 'M800,120 V860',
            'M120,450 H350 M650,450 H880', 'M450,120 V300 M450,600 V860',
          ].map((d, i) => (
            <path key={`t${i}`} d={d} stroke="#232b38" strokeWidth={4} fill="none" />
          ))}
          {/* live continuity vector under the pads so pads + callouts stay on top */}
          {activeContinuityLine && (
            <g pointerEvents="none">
              <line
                className="tf-continuity-vector"
                x1={activeContinuityLine.x1}
                y1={activeContinuityLine.y1}
                x2={activeContinuityLine.x2}
                y2={activeContinuityLine.y2}
                stroke={activeContinuityLine.abnormal ? '#ff5470' : '#35d0e0'}
                strokeWidth={4}
                strokeDasharray="12 8"
              />
              {(() => {
                const mx = (activeContinuityLine.x1 + activeContinuityLine.x2) / 2;
                const my = (activeContinuityLine.y1 + activeContinuityLine.y2) / 2;
                const text = shortReading(activeContinuityLine.label, activeContinuityLine.abnormal);
                if (!text) return null;
                const w = text.length * 13 + 18;
                const bx = Math.min(Math.max(mx - w / 2, 66), 934 - w);
                return (
                  <g>
                    <rect
                      x={bx}
                      y={my - 44}
                      width={w}
                      height={32}
                      rx={8}
                      className={activeContinuityLine.abnormal ? 'tf-callout-badge abnormal' : 'tf-callout-badge'}
                    />
                    <text
                      x={bx + w / 2}
                      y={my - 21}
                      textAnchor="middle"
                      fontSize={20}
                      fontFamily="monospace"
                      className={activeContinuityLine.abnormal ? 'tf-callout-text abnormal' : 'tf-callout-text'}
                    >
                      {text}
                    </text>
                  </g>
                );
              })()}
            </g>
          )}
          {board.components.map((c) => {
            const color = KIND_COLOR[c.kind] ?? '#fff';
            const selected = c.ref === selectedRef;
            const pts = c.mask.map((p) => p.join(',')).join(' ');
            return (
              <g
                key={c.ref}
                onClick={(e) => { e.stopPropagation(); onSelectComponent(c.ref); }}
                style={{ cursor: 'pointer' }}
              >
                <polygon
                  points={pts}
                  fill={selected ? `${color}55` : `${color}22`}
                  stroke={color}
                  strokeWidth={selected ? 5 : 3}
                  strokeDasharray={c.kind === 'testpad' ? '10 6' : undefined}
                />
                <text x={c.bbox.x + 6} y={c.bbox.y - 10} fill={color} fontSize={28} fontFamily="monospace">
                  {c.ref}
                </text>
              </g>
            );
          })}
          {board.probePoints.map((p) => {
            const isA = probeA === p.id;
            const isB = probeB === p.id;
            const hl = isA || isB;
            const isActive = activeSet.has(p.id);
            const measured = measuredPoints[p.id];
            const callout = measured && measured.reading ? shortReading(measured.reading, measured.abnormal) : '';
            const cw = callout ? callout.length * 12 + 18 : 0;
            const cxRight = p.x + 34;
            const cx = cxRight + cw > 946 ? p.x - 34 - cw : cxRight;
            const cy = Math.max(p.y - 52, 56);
            return (
              <g
                key={p.id}
                onClick={(e) => { e.stopPropagation(); onProbePoint(p.id); }}
                style={{ cursor: probeArmed ? 'crosshair' : 'pointer' }}
              >
                {isActive && (
                  <circle className="tf-probe-pulse" cx={p.x} cy={p.y} r={30} fill="none" stroke={measured?.abnormal ? '#ff5470' : '#ff6a1a'} strokeWidth={4} />
                )}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={hl || isActive ? 26 : 18}
                  fill={isA ? '#ff6a1a' : isB ? '#35d0e0' : measured ? (measured.abnormal ? '#3a1420' : '#0e1a13') : '#0c0e12'}
                  stroke={isA ? '#ff6a1a' : isB ? '#35d0e0' : measured ? (measured.abnormal ? '#ff5470' : '#3ddc84') : '#e8eaf0'}
                  strokeWidth={4}
                />
                <text x={p.x + 30} y={p.y + 10} fill="#a7aebb" fontSize={24} fontFamily="monospace">
                  {isA ? 'A·' : ''}{isB ? 'B·' : ''}{p.label}
                </text>
                {callout && (
                  <g pointerEvents="none">
                    <rect
                      x={cx}
                      y={cy}
                      width={cw}
                      height={30}
                      rx={8}
                      className={measured.abnormal ? 'tf-callout-badge abnormal' : 'tf-callout-badge'}
                    />
                    <text
                      x={cx + cw / 2}
                      y={cy + 22}
                      textAnchor="middle"
                      fontSize={19}
                      fontFamily="monospace"
                      className={measured.abnormal ? 'tf-callout-text abnormal' : 'tf-callout-text'}
                    >
                      {callout}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="tf-tp-strip" aria-label="Test-point status">
        {board.probePoints.map((p) => {
          const measured = measuredPoints[p.id];
          const isActive = activeSet.has(p.id);
          const cls = isActive
            ? 'tf-tp-chip active'
            : measured
              ? measured.abnormal
                ? 'tf-tp-chip abnormal'
                : 'tf-tp-chip nominal'
              : 'tf-tp-chip';
          const suffix = measured && measured.reading
            ? ` · ${shortReading(measured.reading, false)}${measured.abnormal ? ' !' : ''}`
            : '';
          return (
            <button
              key={p.id}
              className={cls}
              onClick={() => onProbePoint(p.id)}
              title={measured?.reading ? `${p.label}: ${measured.reading}` : `${p.label}: not probed yet`}
            >
              {p.label}{suffix}
            </button>
          );
        })}
      </div>
    </div>
  );
}
