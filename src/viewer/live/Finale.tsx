// End of a live match: the result card, then "Your match in context": the pool's win rates under this match's latency
// rule and over the whole pool, which now count it, and how much this match moved them.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MatchIndexEntry, RunSummary } from "../../api/contract.ts";
import type { ResultRec } from "../../runner/log.ts";
import { MAPS } from "../../sim/maps.ts";
import { getCommunitySummary } from "../lib/api.ts";
import { clock, conditionLabel, ms, pct, ptsDelta, reasonLabel, usd } from "../lib/format.ts";
import { RESULTS_HREF } from "../lib/router.ts";
import { agentRecord, totalMatches, withMatch } from "../lib/summary.ts";
import { agentColor, canonicalOrder, distinctColors, type TeamColor } from "../lib/theme.ts";
import { teamStyle } from "../match/BrainPanel.tsx";
import type { MatchModel } from "../replay/model.ts";

type Props = {
  model: MatchModel;
  result: ResultRec;
  entry: MatchIndexEntry;
  /** Pool summary from before the match, when known. */
  before: RunSummary | null;
  onClose: () => void;
  onRewatch: () => void;
};

type After = { summary: RunSummary; synthesized: boolean };

/** The pool summary including this match. The server's aggregate may lag a moment behind "done". */
async function fetchAfter(entry: MatchIndexEntry, before: RunSummary | null, alive: () => boolean): Promise<After> {
  const want = before ? totalMatches(before) + 1 : 0;
  let last: RunSummary | null = null;
  for (let i = 0; i < 4 && alive(); i++) {
    try {
      last = await getCommunitySummary();
      if (!before || totalMatches(last) >= want) return { summary: last, synthesized: false };
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  const base = last ?? before;
  if (!base) throw new Error("The pool results are unavailable right now.");
  return { summary: withMatch(base, entry), synthesized: true };
}

export function Finale({ model, result, entry, before, onClose, onRewatch }: Props) {
  const h = model.header;
  const agents = h.agents;
  const colors = useMemo(() => distinctColors(agents.map((a) => a.id)) as [TeamColor, TeamColor], [agents]);
  const ctxAgents = useMemo(() => canonicalOrder(agents.map((a) => ({ id: a.id, label: a.label }))), [agents]);
  const ctxColors = useMemo(() => ctxAgents.map((a) => agentColor(a.id)) as [TeamColor, TeamColor], [ctxAgents]);
  const [stage, setStage] = useState<"card" | "context">("card");
  const [after, setAfter] = useState<After | null>(null);
  const [afterErr, setAfterErr] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    fetchAfter(entry, before, () => alive).then((a) => alive && setAfter(a), (e: Error) => alive && setAfterErr(e.message));
    const t = setTimeout(() => alive && setStage("context"), 1700);
    return () => { alive = false; clearTimeout(t); };
  }, [entry, before]);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const winner = result.winner;
  const durS = result.ticks / h.tickHz;
  const maxHp = Math.max(3, model.frames[0].tanks[0].hp, model.frames[0].tanks[1].hp);
  const mapName = MAPS[h.map]?.name ?? h.map;

  return (
    <div className={`finale is-${stage}`} role="dialog" aria-modal="true" aria-labelledby="finale-title">
      <div className="finale__scrim" onClick={onClose} />
      <div className="finale__inner">
        <button ref={closeRef} className="finale__close" onClick={onClose} aria-label="Close and look at the arena">
          <svg viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>

        <section className="finale__card" style={winner !== null ? ({ "--win": colors[winner].main, "--win-rgb": colors[winner].rgb.join(",") } as CSSProperties) : undefined}>
          <div className="finale__kicker">{reasonLabel(result.reason)} · {clock(durS)}</div>
          <h2 id="finale-title" className={`finale__title ${winner === null ? "is-draw" : ""}`}>
            {winner === null ? "Draw" : <>{agents[winner].label} <span>wins</span></>}
          </h2>
          <div className="finale__sub">{mapName} · seed {h.seed}</div>
          <div className="finale__sides">
            {([0, 1] as const).map((slot) => {
              const st = result.stats[slot];
              const won = winner === slot;
              return (
                <div key={slot} className={`fside ${won ? "is-winner" : ""} ${winner !== null && !won ? "is-loser" : ""}`} style={{ ...teamStyle(colors[slot]), "--i": slot } as CSSProperties}>
                  <div className="fside__head">
                    <span className="fside__name">{agents[slot].label}</span>
                    <span className="fside__hp" aria-label={`${result.hp[slot]} of ${maxHp} HP left`}>
                      {Array.from({ length: maxHp }, (_, i) => <i key={i} className={i < result.hp[slot] ? "is-on" : ""} />)}
                    </span>
                  </div>
                  <dl className="fside__stats">
                    <div><dt>Decisions</dt><dd>{st.decisions}</dd></div>
                    <div><dt>Median</dt><dd>{ms(st.latencyMs.p50)}</dd></div>
                    <div><dt>Hits</dt><dd>{st.hits}/{st.shots}</dd></div>
                    <div><dt>Own goals</dt><dd>{st.selfHits}</dd></div>
                    <div><dt>Cost</dt><dd>{usd(st.cost)}</dd></div>
                  </dl>
                </div>
              );
            })}
          </div>
        </section>

        <div className="finale__reveal" aria-hidden={stage !== "context"}>
          <div className="finale__reveal-inner">
            <Context entry={entry} agents={ctxAgents} colors={ctxColors} before={before} after={after} afterErr={afterErr} show={stage === "context"} />
          </div>
        </div>

        <div className="finale__actions">
          <button className="btn btn--primary btn--lg" onClick={onRewatch}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Watch again
          </button>
          <a className="btn btn--lg" href="#/run">Run another match</a>
          <a className="btn btn--ghost btn--lg" href={RESULTS_HREF}>See all results →</a>
        </div>
      </div>
    </div>
  );
}

type Agent = { id: string; label: string };

function Context({ entry, agents, colors, before, after, afterErr, show }: {
  entry: MatchIndexEntry; agents: Agent[]; colors: [TeamColor, TeamColor]; before: RunSummary | null; after: After | null; afterErr: string | null; show: boolean;
}) {
  // Dots start at the "before" values and glide to the new ones once the panel is on screen.
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (!show || !after) return;
    const t = setTimeout(() => setMoved(true), 450);
    return () => clearTimeout(t);
  }, [show, after]);

  if (afterErr && !after) return <section className="ctx"><h3>Your match in context</h3><p className="ctx__note">{afterErr}</p></section>;
  if (!after) return <section className="ctx"><h3>Your match in context</h3><div className="ctx__loading"><div className="spinner" /> Counting your match into the pool…</div></section>;

  const s = after.summary;
  const cond = entry.condition;
  const n = totalMatches(s);
  const nCond = totalMatches(s, cond);
  const mapRow = s.maps.find((m) => m.map === entry.map);

  return (
    <section className="ctx" aria-labelledby="ctx-h">
      <header className="ctx__head">
        <h3 id="ctx-h">Your match in context</h3>
        <p>
          The pool: <b>{n.toLocaleString()}</b> match{n === 1 ? "" : "es"}, yours included{after.synthesized ? " (counted locally while the server catches up)" : ""}. Win rate is wins ÷ decisive matches with a 95% interval.
          {!before && " Shared links can’t show how much this match moved the numbers."}
        </p>
      </header>
      <RateRow title={conditionLabel(cond)} sub={`${nCond.toLocaleString()} match${nCond === 1 ? "" : "es"} with your match’s latency rule`} agents={agents} colors={colors} now={s} prev={before} condition={cond} moved={moved} highlight />
      <RateRow title="Whole pool" sub={`${n.toLocaleString()} matches, every latency rule`} agents={agents} colors={colors} now={s} prev={before} moved={moved} />
      {mapRow && (
        <p className="ctx__map">
          On {MAPS[entry.map]?.name ?? entry.map}: {agents.map((a, i) => <span key={a.id} style={{ color: colors[i].main }}>{a.label} {mapRow.winsByAgent[a.id] ?? 0}</span>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, " · ", el] : [el]), [])}
          {" · "}{mapRow.draws} draw{mapRow.draws === 1 ? "" : "s"} in {mapRow.matches.toLocaleString()} pool matches.
        </p>
      )}
    </section>
  );
}

function RateRow({ title, sub, agents, colors, now, prev, condition, moved, highlight }: {
  title: string; sub: string; agents: Agent[]; colors: [TeamColor, TeamColor]; now: RunSummary; prev: RunSummary | null; condition?: string; moved: boolean; highlight?: boolean;
}) {
  return (
    <div className={`ctx__row ${highlight ? "is-highlight" : ""}`}>
      <div className="ctx__label">
        <b>{title}</b>
        <small>{sub}</small>
      </div>
      <div className="ctx__agents">
        {agents.map((a, i) => {
          const rec = agentRecord(now, a.id, condition);
          const old = prev ? agentRecord(prev, a.id, condition) : null;
          const iv = rec.winRate;
          const from = old?.winRate ?? iv;
          const show = moved || !from ? iv : from;
          const delta = iv && old?.winRate ? iv.p - old.winRate.p : null;
          return (
            <div key={a.id} className="ctx__agent" style={teamStyle(colors[i])}>
              <div className="ctx__val">
                <span className="ctx__name">{a.label}</span>
                <b>{iv ? pct(iv.p) : "—"}</b>
                {delta !== null && (
                  <span className={`ctx__delta ${delta > 0.0005 ? "is-up" : delta < -0.0005 ? "is-down" : ""} ${moved ? "is-on" : ""}`}>
                    {delta > 0.0005 ? "▲" : delta < -0.0005 ? "▼" : "•"} {ptsDelta(delta)}
                  </span>
                )}
              </div>
              <div className="ctx__track" aria-label={iv ? `${a.label}: ${pct(iv.p, 1)}, 95% interval ${pct(iv.lo)}–${pct(iv.hi)}` : `${a.label}: no decisive matches`}>
                <i className="ctx__mid" />
                {show && <i className="ctx__ci" style={{ left: `${show.lo * 100}%`, width: `${(show.hi - show.lo) * 100}%` }} />}
                {old?.winRate && <i className="ctx__ghost" style={{ left: `${old.winRate.p * 100}%` }} />}
                {show && <i className="ctx__dot" style={{ left: `${show.p * 100}%` }} />}
              </div>
              <div className="ctx__rec">{rec.wins}–{rec.losses}–{rec.draws}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
