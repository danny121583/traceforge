import type { MetaClient, UsageTelemetry } from '../lib/meta-client';
import { aiModeBadge } from '../lib/guided-ux';

export type ThemeMode = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'tf_theme';

/**
 * Workbench header organized into three balanced zones:
 * - Left: TraceForge logo and identity
 * - Center: Virtual Lab / Live AI operational-mode badge and mode switch
 * - Right: Light / Dark theme toggle
 */
export function Header(
  {
    client,
    onToggleMode,
    telemetry,
    badge: overrideBadge,
    theme = 'dark',
    onToggleTheme,
  }: {
    client: MetaClient;
    onToggleMode: () => void;
    telemetry?: UsageTelemetry;
    badge?: { label: string; className: string };
    theme?: ThemeMode;
    onToggleTheme?: () => void;
  },
) {
  const s = client.status();
  const badge = overrideBadge ?? aiModeBadge(s.sparkMode, { proxyConfigured: s.proxyConfigured });
  void telemetry;
  const isLight = theme === 'light';
  return (
    <header className="tf-header">
      <div className="tf-logo tf-header-left">
        <img src="/traceforge-icon-3d.png" alt="TraceForge 3D PCB icon" className="tf-logo-icon-3d" />
        <div className="tf-logo-copy">
          <span className="tf-logo-text">TRACEFORGE</span>
          <span className="tf-tagline">Find hidden electrical faults using an interactive virtual circuit laboratory.</span>
        </div>
      </div>
      <div className="tf-status tf-header-center" role="group" aria-label="Operational mode controls">
        <span className={badge.className}>
          <strong>{badge.label}</strong>
        </span>
        <button type="button" onClick={onToggleMode} title="Toggle live / virtual lab mode">
          {s.mode === 'live' ? 'Use Virtual Lab' : 'Use Live AI'}
        </button>
      </div>
      <div className="tf-header-right">
        <button
          type="button"
          className="tf-theme-toggle"
          onClick={onToggleTheme}
          aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
          aria-pressed={isLight}
          title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          <span className="tf-theme-toggle-icon" aria-hidden="true">
            {isLight ? '🌙' : '☀️'}
          </span>
          <span className="tf-theme-toggle-label">{isLight ? 'Dark Mode' : 'Light Mode'}</span>
        </button>
      </div>
    </header>
  );
}
