import type { MetaClient, OperationalMode } from '../lib/meta-client';

const MODE_LABEL: Record<OperationalMode, string> = {
  LIVE_API: 'Live API',
  SIMULATED: 'Simulated',
  STATIC_FIXTURE: 'Static Fixture',
  UNVERIFIED: 'Unverified',
  UNAVAILABLE: 'Unavailable',
};

function chipClass(mode: OperationalMode): string {
  if (mode === 'LIVE_API') return 'tf-chip live';
  if (mode === 'SIMULATED' || mode === 'STATIC_FIXTURE') return 'tf-chip sim';
  if (mode === 'UNVERIFIED') return 'tf-chip unverified';
  return 'tf-chip unavailable';
}

export function Header({ client, onToggleMode }: { client: MetaClient; onToggleMode: () => void }) {
  const s = client.status();
  return (
    <header className="tf-header">
      <div className="tf-logo">
        <b>◈</b> TRACEFORGE
      </div>
      <div className="tf-status">
        <span className="tf-chip">Model: <strong>{s.model}</strong></span>
        <span className="tf-chip">Context: <strong>1M Tokens</strong></span>
        <span className={chipClass(s.sparkMode)} title="Muse Spark 1.3 reasoning capability mode">
          Muse Spark 1.3: <strong>{MODE_LABEL[s.sparkMode]}</strong>
        </span>
        <span className={chipClass(s.samMode)} title="SAM 3.1 segmentation capability mode">
          Segmentation: <strong>{s.samMode === 'STATIC_FIXTURE' ? 'Static Fixture (KiCad)' : MODE_LABEL[s.samMode]}</strong>
        </span>
        <button onClick={onToggleMode} title="Toggle live / simulated mode">
          {s.mode === 'live' ? 'Go simulated' : 'Go live'}
        </button>
      </div>
    </header>
  );
}
