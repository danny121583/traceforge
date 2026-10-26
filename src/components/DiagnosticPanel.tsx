import type { ClassifiedEvidence } from '../lib/diagnostic-parser';

interface Props {
  boardName: string;
  evidence: ClassifiedEvidence;
  verification: { status: 'confirmed' | 'hypothesis'; reason: string };
}

const STATUS_CHIP: Record<string, string> = {
  nominal: 'tf-ev-chip ok',
  abnormal: 'tf-ev-chip warn',
  inconclusive: 'tf-ev-chip mute',
};

const LIKELIHOOD_CHIP: Record<string, string> = {
  high: 'tf-ev-chip warn',
  medium: 'tf-ev-chip cite',
  low: 'tf-ev-chip mute',
};

/**
 * Classified diagnostic panel: observed symptoms, real probe readings,
 * datasheet ground truth, and explicitly-labeled model hypotheses are
 * rendered in separate sections so a conjecture can never be mistaken
 * for a verified electrical fact.
 */
export function DiagnosticPanel({ boardName, evidence, verification }: Props) {
  const confirmed = verification.status === 'confirmed';
  return (
    <div className="tf-card tf-dx">
      <h3>DIAGNOSTIC EVIDENCE · {boardName.toUpperCase()}</h3>
      <div className={`tf-verdict ${confirmed ? 'ok' : 'hypo'}`}>
        {confirmed ? '● CONFIRMED BY MEASUREMENT' : '● HYPOTHESIS — NOT YET MEASURED'}
        <span className="tf-verdict-reason">{verification.reason}</span>
      </div>

      <h4>Observed Evidence</h4>
      {evidence.observedEvidence.length === 0 ? (
        <div className="tf-ev-empty">No observed symptoms recorded.</div>
      ) : (
        <ul className="tf-ev-list">
          {evidence.observedEvidence.map((e, i) => (
            <li key={i}>
              <span className="tf-ev-chip ok">observed</span> {e}
            </li>
          ))}
        </ul>
      )}

      <h4>Probe Measurements</h4>
      {evidence.probeMeasurements.length === 0 ? (
        <div className="tf-ev-empty">No probe measurements yet — hypotheses below are unverified.</div>
      ) : (
        <ul className="tf-ev-list">
          {evidence.probeMeasurements.map((m, i) => (
            <li key={i}>
              <span className={STATUS_CHIP[m.status] ?? 'tf-ev-chip mute'}>{m.status}</span>{' '}
              <strong>{m.point}</strong> · {m.value}
            </li>
          ))}
        </ul>
      )}

      <h4>Datasheet Specifications</h4>
      {evidence.datasheetSpecs.length === 0 ? (
        <div className="tf-ev-empty">No datasheet citations.</div>
      ) : (
        <ul className="tf-ev-list">
          {evidence.datasheetSpecs.map((d, i) => (
            <li key={i}>
              <span className="tf-ev-chip cite">spec</span> <strong>{d.section}</strong>
              {d.spec !== d.section && <> — {d.spec}</>}
            </li>
          ))}
        </ul>
      )}

      <h4>Diagnostic Hypotheses</h4>
      {evidence.hypotheses.length === 0 ? (
        <div className="tf-ev-empty">No hypotheses proposed.</div>
      ) : (
        <ul className="tf-ev-list">
          {evidence.hypotheses.map((h, i) => (
            <li key={i}>
              <span className={LIKELIHOOD_CHIP[h.likelihood] ?? 'tf-ev-chip mute'}>
                hypothesis · {h.likelihood}
              </span>{' '}
              {h.claim}
              <div className="tf-falsify">Falsify: {h.falsificationTest}</div>
            </li>
          ))}
        </ul>
      )}

      <h4>Recommended Next Steps</h4>
      {evidence.nextVerificationSteps.length === 0 ? (
        <div className="tf-ev-empty">No follow-up steps proposed.</div>
      ) : (
        <ol className="tf-ev-list">
          {evidence.nextVerificationSteps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
