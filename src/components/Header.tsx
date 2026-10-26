import type { MetaClient } from '../lib/meta-client';

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
        <span className="tf-chip">Segmenter: <strong>SAM 3.1</strong></span>
        <span className={`tf-chip ${s.mode === 'live' ? 'live' : 'sim'}`}>
          Mode: <strong>{s.mode === 'live' ? 'Live' : 'Simulated'}</strong>
        </span>
        <button onClick={onToggleMode} title="Toggle live / simulated mode">
          {s.mode === 'live' ? 'Go simulated' : 'Go live'}
        </button>
      </div>
    </header>
  );
}
