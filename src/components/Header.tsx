import type { MetaClient, UsageTelemetry } from '../lib/meta-client';
import { aiModeBadge } from '../lib/guided-ux';

/**
 * Simplified workbench header: TraceForge identity + tagline, one truthful
 * AI operational-mode badge, and the live/simulated toggle. Model
 * attribution, context window, segmentation, and token/budget telemetry live
 * in the "Technology, Telemetry & Budget Details" drawer at the page bottom.
 */
export function Header(
  {
    client,
    onToggleMode,
    telemetry,
    badge: overrideBadge,
  }: {
    client: MetaClient;
    onToggleMode: () => void;
    telemetry?: UsageTelemetry;
    badge?: { label: string; className: string };
  },
) {
  const s = client.status();
  const badge = overrideBadge ?? aiModeBadge(s.sparkMode, { proxyConfigured: s.proxyConfigured });
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
        <button onClick={onToggleMode} title="Toggle live / virtual lab mode">
          {s.mode === 'live' ? 'Use Virtual Lab' : 'Use Live AI'}
        </button>
      </div>
    </header>
  );
}
