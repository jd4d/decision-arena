import { useMemo, useState, type CSSProperties } from "react";
import { DEFAULT_PUBLIC_CONDITION, PUBLIC_CONDITIONS, type PublicCondition } from "../../api/contract.ts";
import { MAP_IDS, MAPS } from "../../sim/maps.ts";
import { MapThumb } from "../browser/MapThumb.tsx";
import { ApiFailure, createMatch, getCommunitySummary, useStatus } from "../lib/api.ts";
import { useAsync } from "../lib/data.ts";
import { conditionLabel, ms, usd } from "../lib/format.ts";
import { liveHref, MATCHES_HREF, RESULTS_HREF } from "../lib/router.ts";
import { agentRecord, shortName } from "../lib/summary.ts";
import { canonicalOrder } from "../lib/theme.ts";
import { saveLaunch } from "../live/launch.ts";
import { StatusStrip } from "../home/StatusStrip.tsx";

/** Latency rules in contract order: the default first, then the controls and the speed variants. */
const RULES = Object.keys(PUBLIC_CONDITIONS) as PublicCondition[];

export function RunPage() {
  const { status } = useStatus(8000);
  const [map, setMap] = useState<string>("random");
  const [rule, setRule] = useState<PublicCondition>(DEFAULT_PUBLIC_CONDITION);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiFailure | null>(null);
  const pool = useAsync(() => getCommunitySummary().catch(() => null), []);
  const summary = pool.status === "ready" ? pool.data : null;
  // Typical medians at real latency and the usual cost of a match under the chosen rule, both from the pool.
  const medians = useMemo(() => {
    const agents = canonicalOrder(summary?.agents ?? []);
    const rows = agents.map((a) => ({ label: shortName(a.label), p50: agentRecord(summary, a.id, DEFAULT_PUBLIC_CONDITION).p50 }));
    return rows.length && rows.every((r) => Number.isFinite(r.p50)) ? rows : null;
  }, [summary]);
  const matchCost = useMemo(() => {
    const per = (summary?.agents ?? []).map((a) => agentRecord(summary, a.id, rule).costPerMatch);
    return per.length && per.every(Number.isFinite) ? per.reduce((t, x) => t + x, 0) : null;
  }, [summary, rule]);

  const outOfFuel = (status !== null && !status.acceptingMatches) || err?.code === "budget_exhausted";

  const start = async () => {
    if (busy || outOfFuel) return;
    setBusy(true);
    setErr(null);
    // Snapshot the pool results first, so the end screen can show how this match moved them.
    const beforeP = getCommunitySummary().catch(() => null);
    try {
      const res = await createMatch({ map, condition: rule });
      const before = await Promise.race([beforeP, new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
      saveLaunch(res.matchId, { liveUrl: res.liveUrl, queuePosition: res.queuePosition, map, condition: rule, createdAt: Date.now(), before });
      location.hash = liveHref(res.matchId);
    } catch (e) {
      setErr(e instanceof ApiFailure ? e : new ApiFailure("network", (e as Error).message));
      setBusy(false);
    }
  };

  return (
    <div className="runpage">
      <header className="runpage__head">
        <div className="kicker"><span className="live-dot" /> Run a match</div>
        <h1>Start a live duel</h1>
        <p>Jev 1.13 and Microsoft Decision 1 each drive a tank. You choose the map, then watch it play out as the models decide.</p>
        <StatusStrip status={status} compact />
      </header>

      {outOfFuel && <FuelOut />}

      <section className="step" aria-labelledby="step-map">
        <h2 id="step-map">Pick a map</h2>
        <div className="mapopts" role="radiogroup" aria-labelledby="step-map">
          {["random", ...MAP_IDS].map((id, i) => (
            <label key={id} className={`mapopt ${map === id ? "is-on" : ""}`} style={{ "--i": i } as CSSProperties}>
              <input type="radio" name="map" value={id} checked={map === id} onChange={() => setMap(id)} className="sr-only" />
              <span className="mapopt__thumb">
                {id === "random" ? (
                  <span className="mapopt__shuffle" aria-hidden>
                    {MAP_IDS.map((m, k) => <MapThumb key={m} map={m} className={`mapopt__cycle mapopt__cycle--${k}`} />)}
                    <span className="mapopt__dice">
                      <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="8.5" cy="8.5" r="1.4" /><circle cx="15.5" cy="15.5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="15.5" cy="8.5" r="1.4" /><circle cx="8.5" cy="15.5" r="1.4" /></svg>
                    </span>
                  </span>
                ) : (
                  <MapThumb map={id} />
                )}
              </span>
              <span className="mapopt__name">{id === "random" ? "Random" : MAPS[id].name}</span>
              <span className="mapopt__sub">{id === "random" ? "Let the arena choose" : mapBlurb(id)}</span>
              <span className="mapopt__check" aria-hidden />
            </label>
          ))}
        </div>
      </section>

      <aside className="realnote" aria-label="How latency works">
        <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 7v5.2l3.3 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <p>
          <b>Real response time is part of the fight.</b> The game keeps running while a model thinks, so a slower model reacts to an older picture of the battlefield.
          {medians && <> Typical medians: {medians.map((m) => `${m.label} ${ms(m.p50)}`).join(", ")}.</>}
        </p>
      </aside>

      <RulePicker rule={rule} onChange={setRule} />

      <section className="go" aria-label="Start">
        <div className="go__sides">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M7 7h11l-3-3M17 17H6l3 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div>
            <b>Sides and seed are random.</b> Either model may spawn on either side, so the spawn position can’t favour one of them.
          </div>
        </div>
        <div className="go__cta">
          <div className="go__summary">
            <span>{map === "random" ? "Random map" : MAPS[map].name}</span>
            <span className="go__dot">·</span>
            <span>{conditionLabel(rule)}</span>
          </div>
          <button className={`btn btn--cta ${busy ? "is-busy" : ""}`} onClick={start} disabled={busy || outOfFuel} aria-busy={busy}>
            {busy ? <><span className="spinner spinner--xs" /> Starting…</> : <>Start match <span aria-hidden>→</span></>}
          </button>
          <div className="go__fine">
            {matchCost !== null ? `About ${usd(matchCost)} of model credit per match` : "A fraction of a cent of model credit per match"}, paid by the project. Matches last up to 60 seconds of game time.
          </div>
        </div>
        {err && err.code !== "budget_exhausted" && <RunError err={err} onRetry={start} />}
      </section>
    </div>
  );
}

/** Compact, optional latency-rule choice. Real latency is preselected, so a visitor never has to open it. */
function RulePicker({ rule, onChange }: { rule: PublicCondition; onChange: (r: PublicCondition) => void }) {
  const [open, setOpen] = useState(false);
  const changed = rule !== DEFAULT_PUBLIC_CONDITION;
  return (
    <details className={`rule ${changed ? "is-changed" : ""}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="rule__sum">
        <span className="rule__k">Latency rule</span>
        <b className="rule__v">{PUBLIC_CONDITIONS[rule].label}</b>
        <span className="rule__tag">{changed ? "changed" : "default"}</span>
        <svg className="rule__chev" viewBox="0 0 16 16" aria-hidden><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {changed && !open && <span className="rule__blurb">{PUBLIC_CONDITIONS[rule].blurb}</span>}
      </summary>
      <div className="rule__panel">
        <p className="rule__intro">
          Optional. Real latency is the arena as intended; the other rules are the experiments behind the results, separating decision quality from speed.
        </p>
        <div className="rule__opts" role="radiogroup" aria-label="Latency rule">
          {RULES.map((c) => (
            <label key={c} className={`ruleopt ${rule === c ? "is-on" : ""}`}>
              <input type="radio" name="rule" value={c} checked={rule === c} onChange={() => onChange(c)} className="sr-only" />
              <span className="ruleopt__dot" aria-hidden />
              <span className="ruleopt__name">
                {PUBLIC_CONDITIONS[c].label}
                {c === DEFAULT_PUBLIC_CONDITION && <em>default</em>}
              </span>
              <span className="ruleopt__blurb">{PUBLIC_CONDITIONS[c].blurb}</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}

function mapBlurb(id: string): string {
  if (id === "open") return "No cover. Pure aim and dodging.";
  if (id === "pillars") return "Four pillars to hide behind.";
  if (id === "crossfire") return "Walls and lanes. Bank shots pay.";
  return "";
}

function FuelOut() {
  return (
    <div className="fuel" role="status">
      <svg className="fuel__icon" viewBox="0 0 32 32" aria-hidden>
        <path d="M7 27V7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v20M5 27h17M20 12h3a2 2 0 0 1 2 2v7a1.5 1.5 0 0 0 3 0V11l-4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="10" y="9" width="7" height="5" rx="1" fill="currentColor" opacity=".35" />
      </svg>
      <div>
        <b>The arena is out of fuel.</b>
        <p>Matches run on a fixed amount of model credit, and it has been used up. Every replay and result is still here.</p>
        <div className="fuel__links">
          <a className="btn btn--sm" href={MATCHES_HREF}>Watch replays</a>
          <a className="btn btn--sm btn--ghost" href={RESULTS_HREF}>See the results</a>
        </div>
      </div>
    </div>
  );
}

function RunError({ err, onRetry }: { err: ApiFailure; onRetry: () => void }) {
  const busy = err.code === "busy";
  return (
    <div className={`runerr ${busy ? "runerr--busy" : ""}`} role="alert">
      <b>{busy ? "The arena is full right now." : err.code === "network" ? "Can’t reach the arena." : "That didn’t start."}</b>
      <span>{busy ? "Every slot is taken and the queue is full. Give it a minute and try again." : err.message}</span>
      <button className="btn btn--sm" onClick={onRetry}>Try again</button>
    </div>
  );
}
