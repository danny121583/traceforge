import type { MetaClient, UsageTelemetry } from '../lib/meta-client';
import { aiModeBadge } from '../lib/guided-ux';

/**
 * Simplified workbench header: TraceForge identity + tagline, one truthful
 * AI operational-mode badge, and the live/simulated toggle. Model
 * attribution, context window, segmentation, and token/budget telemetry live
 * in the "Technology, Telemetry & Budget Details" drawer at the page bottom.
 */
export function Header(
  { client, onToggleMode, telemetry }: { client: MetaClient; onToggleMode: () => void; telemetry?: UsageTelemetry },
) {
  const s = client.status();
  const badge = aiModeBadge(s.sparkMode);
  void telemetry;
  return (
    <header className="tf-header">
      <div className="tf-logo">
        <img src="/traceforge-icon-3d.png" alt="TraceForge 3D PCB icon" className="tf-logo-icon-3d" />
        <span className="tf-logo-text">TRACEFORGE</span>
        <span className="tf-tagline">Find hidden electrical faults using an interactive virtual circuit laboratory.</span>
      </div>
      <div className="tf-status">
        <span className={badge.className}>
          <strong>{badge.label}</strong>
        </span>
        <button onClick={onToggleMode} title="Toggle live / simulated mode">
          {s.mode === 'live' ? 'Switch to Simulated' : 'Switch to Live AI'}
        </button>
      </div>
    </header>
  );
}
