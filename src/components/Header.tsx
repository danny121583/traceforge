import type { MetaClient, OperationalMode, UsageTelemetry } from '../lib/meta-client';

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

export function Header(
  { client, onToggleMode, telemetry }: { client: MetaClient; onToggleMode: () => void; telemetry?: UsageTelemetry },
) {
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
        {telemetry && (
          <span
            className={s.sparkMode === 'LIVE_API' ? 'tf-chip live' : 'tf-chip sim'}
            title="Session token telemetry: input / output tokens, incurred vs projected live cost"
          >
            Tokens: <strong>{telemetry.inputTokens} in / {telemetry.outputTokens} out</strong>
            {' '}· Cost: <strong>${telemetry.incurredCostUsd.toFixed(2)} incurred (${telemetry.projectedLiveCostUsd.toFixed(4)} projected)</strong>
            {' '}· Req: <strong>{telemetry.totalRequests}</strong>
            {' '}· Retry: <strong>{telemetry.retriedRequests}</strong>
          </span>
        )}
        <button onClick={onToggleMode} title="Toggle live / simulated mode">
          {s.mode === 'live' ? 'Go simulated' : 'Go live'}
        </button>
      </div>
    </header>
  );
}
