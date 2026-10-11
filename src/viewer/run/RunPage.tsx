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
  const { status } = useStatus();
  const [map, setMap] = useState<string>("random");
  const [rule, setRule] = useState<RuleChoice>("random");
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
    const per = (summary?.agents ?? []).map((a) => agentRecord(summary, a.id, rule === "random" ? undefined : rule).costPerMatch);
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
      const condition = rule === "random" ? RULES[Math.floor(Math.random() * RULES.length)] : rule;
      const res = await createMatch({ map, condition });
      const before = await Promise.race([beforeP, new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
      saveLaunch(res.matchId, { liveUrl: res.liveUrl, queuePosition: res.queuePosition, map, condition, createdAt: Date.now(), before });
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

      <section className="step" aria-labelledby="step-rule">
        <h2 id="step-rule">Pick a latency rule</h2>
        <RuleCards rule={rule} onChange={setRule} medians={medians} />
        <p className="step__note">
          By default the arena picks one of the six rules at random. <b>Real latency</b> is the arena as intended: the game keeps running while a model thinks, so a slower model reacts to an older picture of the battlefield.
          The other rules are the experiments behind the results, separating decision quality from speed.
          {medians && <> Typical medians: {medians.map((m) => `${m.label} ${ms(m.p50)}`).join(", ")}.</>}
        </p>
      </section>

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
            <span>{rule === "random" ? "Random latency rule" : conditionLabel(rule)}</span>
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

type RuleChoice = PublicCondition | "random";
type Medians = { label: string; p50: number }[] | null;

/** Game-time delay per decision for each model under a rule, from the pool's real-latency medians. */
function ruleDelays(c: PublicCondition, medians: Medians): number[] {
  const real = medians?.map((m) => m.p50) ?? [200, 280];
  const spec = PUBLIC_CONDITIONS[c].latency;
  const [kind, v] = spec.split(":");
  if (kind === "fixed") return real.map(() => Number(v));
  if (kind === "swap") return [...real].reverse().map((x) => x * Number(v));
  return real.map((x) => x * Number(v));
}

/** First-class latency-rule choice, styled like the map cards: Random (preselected) plus the six rules. */
function RuleCards({ rule, onChange, medians }: { rule: RuleChoice; onChange: (r: RuleChoice) => void; medians: Medians }) {
  const max = 1200;
  const names = medians?.map((m) => m.label) ?? ["Jev", "Microsoft"];
  return (
    <div className="mapopts ruleopts" role="radiogroup" aria-labelledby="step-rule">
      {(["random", ...RULES] as RuleChoice[]).map((c, i) => (
        <label key={c} className={`mapopt ${rule === c ? "is-on" : ""}`} style={{ "--i": i } as CSSProperties}>
          <input type="radio" name="rule" value={c} checked={rule === c} onChange={() => onChange(c)} className="sr-only" />
          <span className="mapopt__thumb ruleviz">
            {c === "random" ? (
              <span className="mapopt__dice" aria-hidden>
                <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="8.5" cy="8.5" r="1.4" /><circle cx="15.5" cy="15.5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="15.5" cy="8.5" r="1.4" /><circle cx="8.5" cy="15.5" r="1.4" /></svg>
              </span>
            ) : (
              <span className="ruleviz__bars" aria-label={`Delay per decision: ${ruleDelays(c, medians).map((d, k) => `${names[k]} ${Math.round(d)} ms`).join(", ")}`}>
                {ruleDelays(c, medians).map((d, k) => (
                  <span key={k} className={`ruleviz__row ruleviz__row--${k}`}>
                    <span className="ruleviz__who">{names[k]}</span>
                    <span className="ruleviz__track"><span className="ruleviz__fill" style={{ width: `${Math.min(100, (d / max) * 100)}%` }} /></span>
                    <span className="ruleviz__ms">{Math.round(d)} ms</span>
                  </span>
                ))}
              </span>
            )}
            {c === "random" && <span className="ruleviz__badge">default</span>}
          </span>
          <span className="mapopt__name">{c === "random" ? "Random" : PUBLIC_CONDITIONS[c].label}</span>
          <span className="mapopt__sub">{c === "random" ? "Let the arena pick a rule" : PUBLIC_CONDITIONS[c].blurb}</span>
          <span className="mapopt__check" aria-hidden />
        </label>
      ))}
    </div>
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
