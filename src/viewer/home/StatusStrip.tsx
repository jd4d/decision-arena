import type { StatusResponse } from "../../api/contract.ts";

const PER_MATCH_USD = 0.003;

/** Live arena status from /api/status: live matches, queue, matches in the pool and fuel. */
export function StatusStrip({ status, compact = false }: { status: StatusResponse | null; compact?: boolean }) {
  if (!status) {
    return (
      <div className={`status ${compact ? "status--compact" : ""} is-loading`} aria-busy="true">
        <span className="status__item"><span className="status__skel" /></span>
        <span className="status__item"><span className="status__skel" /></span>
        <span className="status__item"><span className="status__skel" /></span>
      </div>
    );
  }
  const fuelLeft = status.creditRemainingUsd;
  const fuelFrac = fuelLeft !== null && fuelLeft + status.spentUsd > 0 ? fuelLeft / (fuelLeft + status.spentUsd) : null;
  return (
    <div className={`status ${compact ? "status--compact" : ""}`} aria-live="polite">
      <span className={`status__item ${status.liveMatches > 0 ? "is-live" : ""}`}>
        <span className="status__dot" />
        <b>{status.liveMatches}</b> live now
      </span>
      <span className="status__item">
        <b>{status.queued}</b> in queue
      </span>
      <span className="status__item">
        <b>{status.communityMatches.toLocaleString()}</b> match{status.communityMatches === 1 ? "" : "es"} in the pool
      </span>
      {status.acceptingMatches ? (
        fuelLeft !== null && (
          <span className="status__item status__fuel" title={`About $${fuelLeft.toFixed(2)} of model credit left`}>
            <span className="status__gauge" aria-hidden><i style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, fuelFrac ?? 1))})` }} /></span>
            ≈ <b>{Math.floor(fuelLeft / PER_MATCH_USD).toLocaleString()}</b> matches of fuel
          </span>
        )
      ) : (
        <span className="status__item status__empty"><span className="status__dot" /> Arena out of fuel</span>
      )}
    </div>
  );
}
