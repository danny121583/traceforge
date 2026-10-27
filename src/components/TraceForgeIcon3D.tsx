/**
 * TraceForgeIcon3D — faithful vector rendition of the Project Owner's custom
 * 3D "TF" PCB-trace icon: an extruded cobalt-blue rounded block carrying
 * glowing lime-to-cyan PCB traces and circular via pads forming the letters
 * "T" and "F".
 *
 * The header badge itself renders the raster 3D artwork
 * (`/traceforge-icon-3d.jpg`); this component provides the same artwork as a
 * crisp inline SVG for favicon-scale and component-scale reuse.
 */
export function TraceForgeIcon3D(
  { size = 36, className = 'tf-logo-icon-3d', title = 'TraceForge 3D PCB icon' }:
  { size?: number; className?: string; title?: string },
) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient id="tf3d-block" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f6df6" />
          <stop offset="0.55" stopColor="#1d4fd7" />
          <stop offset="1" stopColor="#16389b" />
        </linearGradient>
        <linearGradient id="tf3d-trace" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#b6ff3c" />
          <stop offset="0.55" stopColor="#4dffa6" />
          <stop offset="1" stopColor="#35d0e0" />
        </linearGradient>
      </defs>
      <rect x="2" y="6" width="60" height="52" rx="13" fill="#0b1e5b" />
      <rect x="2" y="2" width="60" height="52" rx="13" fill="url(#tf3d-block)" />
      <rect
        x="2"
        y="2"
        width="60"
        height="52"
        rx="13"
        fill="none"
        stroke="#7db4ff"
        strokeOpacity="0.55"
        strokeWidth="1.5"
      />
      <g
        stroke="url(#tf3d-trace)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M14 20 H30 M22 20 V42" />
        <path d="M36 20 H50 M36 29 H47 M36 20 V42" />
      </g>
      <g fill="#0b1e5b" stroke="url(#tf3d-trace)" strokeWidth="2">
        <circle cx="14" cy="20" r="3.4" />
        <circle cx="30" cy="20" r="3.4" />
        <circle cx="22" cy="42" r="3.4" />
        <circle cx="36" cy="20" r="3.4" />
        <circle cx="50" cy="20" r="3.4" />
        <circle cx="36" cy="42" r="3.4" />
      </g>
      <g fill="#d8ffe9">
        <circle cx="14" cy="20" r="1.2" />
        <circle cx="30" cy="20" r="1.2" />
        <circle cx="22" cy="42" r="1.2" />
        <circle cx="36" cy="20" r="1.2" />
        <circle cx="50" cy="20" r="1.2" />
        <circle cx="36" cy="42" r="1.2" />
      </g>
    </svg>
  );
}
