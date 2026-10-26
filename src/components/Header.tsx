import type { MetaClient } from '../lib/meta-client';

export function Header({ client, onToggleMode }: { client: MetaClient; onToggleMode: () => void }) {
  const s = client.status();
  const segLabel =
    s.segmentationMode === 'live_api'
      ? 'Live SAM 3.1'
      : s.segmentationMode === 'simulated'
        ? 'Simulated (Fixture)'
        : 'Static Fixture (KiCad)';
  return (
    <header className="tf-header">
      <div className="tf-logo">
        <b>◈</b> TRACEFORGE
      </div>
      <div className="tf-status">
        <span className="tf-chip">Model: <strong>{s.model}</strong></span>
        <span className="tf-chip">Context: <strong>1M Tokens</strong></span>
        <span className={`tf-chip ${s.mode === 'live' ? 'live' : 'sim'}`}>
          Muse Spark 1.3: <strong>{s.mode === 'live' ? 'Live' : 'Simulated (Fixture)'}</strong>
        </span>
        <span className={`tf-chip ${s.segmentationMode === 'live_api' ? 'live' : 'sim'}`}>
          Segmentation: <strong>{segLabel}</strong>
        </span>
        <button onClick={onToggleMode} title="Toggle live / simulated mode">
          {s.mode === 'live' ? 'Go simulated' : 'Go live'}
        </button>
      </div>
    </header>
  );
}
