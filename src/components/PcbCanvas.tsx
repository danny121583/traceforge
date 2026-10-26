import { useRef, useState } from 'react';
import type { SampleBoard } from '../data/samples';

interface Props {
  board: SampleBoard;
  selectedRef: string | null;
  probeA: string | null;
  probeB: string | null;
  probeArmed: boolean;
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

/** Interactive PCB canvas: zoom/pan SVG with clickable SAM 3.1 overlays. */
export function PcbCanvas({ board, selectedRef, probeA, probeB, probeArmed, onSelectComponent, onProbePoint }: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const viewW = 1000 / zoom;
  const viewH = 1000 / zoom;
  const vx = (1000 - viewW) / 2 + pan.x;
  const vy = (1000 - viewH) / 2 + pan.y;

  return (
    <div className="tf-pane">
      <div className="tf-pane-head">
        <span>{board.name} — SAM 3.1 overlay</span>
        <span className="tf-canvas-tools">
          <button onClick={() => setZoom((z) => Math.min(4, +(z + 0.5).toFixed(2)))}>Zoom +</button>
          <button onClick={() => { setZoom((z) => Math.max(1, +(z - 0.5).toFixed(2))); if (zoom <= 1.5) setPan({ x: 0, y: 0 }); }}>Zoom −</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Reset</button>
        </span>
      </div>
      <div className="tf-canvas-wrap">
        <svg
          viewBox={`${vx} ${vy} ${viewW} ${viewH}`}
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
          <rect x={60} y={60} width={880} height={880} rx={18} fill="#10151c" stroke="#262c36" strokeWidth={3} />
          {/* decorative traces */}
          {[
            'M120,200 H880', 'M120,800 H880', 'M200,120 V880', 'M800,120 V880',
            'M120,450 H350 M650,450 H880', 'M450,120 V300 M450,600 V880',
          ].map((d, i) => (
            <path key={`t${i}`} d={d} stroke="#232b38" strokeWidth={4} fill="none" />
          ))}
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
            return (
              <g
                key={p.id}
                onClick={(e) => { e.stopPropagation(); onProbePoint(p.id); }}
                style={{ cursor: probeArmed ? 'crosshair' : 'pointer' }}
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={hl ? 26 : 18}
                  fill={isA ? '#ff6a1a' : isB ? '#35d0e0' : '#0c0e12'}
                  stroke={isA ? '#ff6a1a' : isB ? '#35d0e0' : '#e8eaf0'}
                  strokeWidth={4}
                />
                <text x={p.x + 30} y={p.y + 10} fill="#a7aebb" fontSize={24} fontFamily="monospace">
                  {isA ? 'A·' : ''}{isB ? 'B·' : ''}{p.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
