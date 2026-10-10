// Results for the one match pool (GET /api/summary/community): the t1 tournament it was seeded with plus every match
// run from the site, across all six latency rules.
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentConditionStats, RunSummary } from "../../analysis/schema.ts";
import { MAPS } from "../../sim/maps.ts";
import { getCommunitySummary } from "../lib/api.ts";
import { useAsync } from "../lib/data.ts";
import { compareConditions, conditionDetail, conditionLabel, driveLabel, ms, num, pct, usd } from "../lib/format.ts";
import { MATCHES_HREF } from "../lib/router.ts";
import { canonicalOrder, distinctColors } from "../lib/theme.ts";
import { CalibrationChart, DriveMix, LatencyHistogram, MapBars, WinRateChart, useSettleAnimations, wilson, type AgentMeta } from "./charts.tsx";

/** Size of the offline tournament the pool was seeded with (runs/t1: 6 rules × 3 maps × 25 seeds × both sides). */
const T1_MATCHES = 900;

export function ResultsPage() {
  const s = useAsync(getCommunitySummary, []);
  return (
    <div className="results">
      {s.status === "loading" ? (
        <div className="page-state"><div className="spinner" />Loading results…</div>
      ) : s.status === "error" ? (
        <div className="page-state page-state--error"><h2>Results are unavailable</h2><p>{s.error.message}</p></div>
      ) : !s.data.conditions.some((c) => c.matches > 0) ? (
        <div className="empty empty--big">
          <b>No matches yet.</b>
          <span>Results appear here as soon as the first match finishes.</span>
          <a className="btn btn--primary" href="#/run">Run the first match →</a>
        </div>
      ) : (
        <Summary s={s.data} />
      )}
    </div>
  );
}

type Agg = {
  matches: number; wins: number; losses: number; draws: number; decisions: number; shots: number; hits: number; selfHits: number;
  cost: number; p50: number; errors: number;
};

function aggregate(s: RunSummary, id: string): Agg | null {
  const rows = s.conditions.map((c) => c.byAgent[id]).filter((x): x is AgentConditionStats => !!x);
  if (!rows.length) return null;
  const sum = (f: (r: AgentConditionStats) => number) => rows.reduce((t, r) => t + f(r), 0);
  const decisions = sum((r) => r.decisions);
  return {
    matches: sum((r) => r.matches), wins: sum((r) => r.wins), losses: sum((r) => r.losses), draws: sum((r) => r.draws), decisions,
    shots: sum((r) => r.shots), hits: sum((r) => r.hits), selfHits: sum((r) => r.selfHits), errors: sum((r) => r.errors),
    cost: sum((r) => r.costPerMatch * r.matches),
    p50: decisions ? sum((r) => r.latencyMs.p50 * r.decisions) / decisions : NaN,
  };
}

function Summary({ s: raw }: { s: RunSummary }) {
  const [metric, setMetric] = useState<"winRate" | "scoreRate">("winRate");
  const rootRef = useRef<HTMLDivElement>(null);
  useSettleAnimations(rootRef);
  // Conditions in reading order: equal-latency control, scaled by multiplier, then swapped.
  const s = useMemo(() => ({ ...raw, agents: canonicalOrder(raw.agents), conditions: [...raw.conditions].sort((a, b) => compareConditions(a.condition, b.condition)) }), [raw]);
  const agents: AgentMeta[] = useMemo(() => {
    const cs = distinctColors(s.agents.map((a) => a.id));
    return s.agents.map((a, i) => ({ id: a.id, label: a.label, color: cs[i] }));
  }, [s]);
  const totalMatches = s.conditions.reduce((t, c) => t + c.matches, 0);
  const calib = useMemo(() => {
    const out: Record<string, { bin: string; n: number; hitRate: number }[]> = {};
    for (const a of agents) {
      const m = new Map<string, { n: number; hits: number }>();
      for (const c of s.conditions) for (const b of c.byAgent[a.id]?.fireCalibration ?? []) {
        const e = m.get(b.bin) ?? { n: 0, hits: 0 };
        e.n += b.n; e.hits += b.hitRate * b.n;
        m.set(b.bin, e);
      }
      out[a.id] = [...m.entries()].map(([bin, e]) => ({ bin, n: e.n, hitRate: e.n ? e.hits / e.n : 0 }));
    }
    return out;
  }, [s, agents]);
  const mix = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const a of agents) {
      const acc: Record<string, number> = {};
      let tot = 0;
      for (const c of s.conditions) {
        const st = c.byAgent[a.id];
        if (!st) continue;
        for (const [k, v] of Object.entries(st.driveMix)) acc[k] = (acc[k] ?? 0) + v * st.decisions;
        tot += st.decisions;
      }
      if (tot) for (const k of Object.keys(acc)) acc[k] /= tot;
      out[a.id] = acc;
    }
    return out;
  }, [s, agents]);

  return (
    <div className="summary" ref={rootRef}>
      <header className="summary__head">
        <div>
          <div className="kicker">Match pool</div>
          <h1>Results</h1>
          <div className="summary__meta">
            <span>{totalMatches.toLocaleString()} matches</span>
            <span>{s.conditions.length} latency rule{s.conditions.length === 1 ? "" : "s"}</span>
            <span>{s.sim} · {s.protocol}</span>
            <span>total model cost {usd(s.totalCostUsd)}</span>
            <span>updated {new Date(s.generatedAt).toLocaleString()}</span>
          </div>
        </div>
        <a className="btn" href={MATCHES_HREF}>Browse matches →</a>
      </header>
      <div className="notice notice--pool notice--community">
        <b>One pool.</b> It started with the {T1_MATCHES}-match t1 tournament, run locally, and every match run from this site adds to it:
        {" "}{totalMatches.toLocaleString()} matches so far. Every match is tagged with where it ran. <a href="#/methodology/caveats">Caveats →</a>
      </div>

      <Headline s={s} agents={agents} mix={mix} />

      <div className="agentcards">
        {agents.map((a, i) => {
          const g = aggregate(s, a.id);
          const wr = g ? wilson(g.wins, g.wins + g.losses) : null;
          return (
            <div key={a.id} className="agentcard" style={{ "--team": a.color.main, "--team-rgb": a.color.rgb.join(","), "--i": i } as CSSProperties}>
              <div className="agentcard__name">{a.label}</div>
              <div className="agentcard__model">{s.agents[i].model ?? a.id}</div>
              {g ? (
                <>
                  <div className="agentcard__big">
                    {g.wins + g.losses > 0 ? pct(wr!.p) : "—"}
                    <small>win rate, all rules{g.wins + g.losses > 0 ? ` · ${pct(wr!.lo)}–${pct(wr!.hi)}` : ""}</small>
                  </div>
                  <dl className="agentcard__stats">
                    <div><dt>Record</dt><dd>{g.wins}–{g.losses}–{g.draws}</dd></div>
                    <div><dt>Median latency</dt><dd>{ms(g.p50)}</dd></div>
                    <div><dt>Accuracy</dt><dd>{g.shots ? pct(g.hits / g.shots) : "—"}</dd></div>
                    <div><dt>Cost / match</dt><dd>{usd(g.matches ? g.cost / g.matches : NaN)}</dd></div>
                  </dl>
                </>
              ) : <div className="agentcard__none">No matches</div>}
            </div>
          );
        })}
      </div>

      <Panel
        title={metric === "winRate" ? "Win rate by latency condition" : "Score rate by latency condition"}
        sub={metric === "winRate" ? "Wins ÷ decisive matches (draws excluded), with Wilson 95% confidence intervals. The dashed line is 50%." : "(Wins + ½ draws) ÷ all matches, with Wilson 95% confidence intervals. The dashed line is 50%."}
        wide
        action={
          <div className="seg seg--sm" role="radiogroup">
            <button role="radio" aria-checked={metric === "winRate"} className={metric === "winRate" ? "is-on" : ""} onClick={() => setMetric("winRate")}>Win rate</button>
            <button role="radio" aria-checked={metric === "scoreRate"} className={metric === "scoreRate" ? "is-on" : ""} onClick={() => setMetric("scoreRate")}>Score rate</button>
          </div>
        }
      >
        <WinRateChart rows={s.conditions} agents={agents} metric={metric} />
      </Panel>

      <div className="grid2">
        <Panel title="Decision latency" sub={`Measured real response time per decision, all rules. Share of each agent’s decisions per 25 ms bin; dashed lines are medians.`}>
          <LatencyHistogram data={s.latencyHistogram} agents={agents} />
        </Panel>
        <Panel title="Fire calibration" sub="For shots fired, how often the shell hit, by the fire probability of the deciding call. All rules pooled; the dashed diagonal marks hit rate equal to P(fire).">
          <CalibrationChart bins={calib} agents={agents} />
        </Panel>
        <Panel title="Results by map" sub="Wins per agent and draws.">
          <MapBars maps={s.maps} agents={agents} mapName={(id) => MAPS[id]?.name ?? id} />
        </Panel>
        <Panel title="Drive mix" sub="Share of decisions per hull command.">
          <DriveMix mix={mix} agents={agents} />
        </Panel>
      </div>

      <Panel title="Shooting" sub="Per latency rule and agent." wide>
        <StatTable s={s} agents={agents} cols={[
          ["Record", (r) => `${r.wins}–${r.losses}–${r.draws}`],
          ["Win rate", (r) => (r.wins + r.losses ? `${pct(r.winRate.p)} [${pct(r.winRate.lo)}–${pct(r.winRate.hi)}]` : "—")],
          ["Score rate", (r) => pct(r.scoreRate.p)],
          ["Shots", (r) => String(r.shots)],
          ["Hits", (r) => String(r.hits)],
          ["Accuracy", (r) => (r.shots ? pct(r.accuracy, 1) : "—")],
          ["Self-hits", (r) => String(r.selfHits)],
          ["Fizzles", (r) => String(r.fizzles)],
          ["Damage taken", (r) => String(r.damageTaken)],
          ["First hit", (r) => (r.meanFirstHitS === null ? "—" : `${num(r.meanFirstHitS, 1)} s`)],
        ]} />
      </Panel>
      <Panel title="Speed, reliability and cost" sub="Per latency rule and agent. Effective latency is the game-time delay actually applied." wide>
        <StatTable s={s} agents={agents} cols={[
          ["Decisions", (r) => String(r.decisions)],
          ["Dec / s", (r) => num(r.decisionsPerS, 2)],
          ["p50", (r) => ms(r.latencyMs.p50)],
          ["p90", (r) => ms(r.latencyMs.p90)],
          ["Mean", (r) => ms(r.latencyMs.mean)],
          ["Eff. p50", (r) => ms(r.effLatencyMs.p50)],
          ["Errors", (r) => `${r.errors} (${pct(r.errorRate, 1)})`],
          ["Cost / match", (r) => usd(r.costPerMatch)],
          ["Cost / decision", (r) => usd(r.costPerDecision)],
        ]} />
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- headline

const HEAD_WIN: { key: string; label: string; match: (c: string) => boolean }[] = [
  { key: "equal", label: "Win rate at equal latency", match: (c) => c.startsWith("fixed-") },
  { key: "real", label: "Win rate at real latency", match: (c) => c === "scaled-1" },
  { key: "swap", label: "Win rate with latency swapped", match: (c) => c.startsWith("swap-") },
];

function Headline({ s, agents, mix }: { s: RunSummary; agents: AgentMeta[]; mix: Record<string, Record<string, number>> }) {
  const rows = HEAD_WIN.map((h) => {
    const conds = s.conditions.filter((c) => h.match(c.condition));
    const cells = agents.map((a) => {
      const st = conds.map((c) => c.byAgent[a.id]).filter((x): x is AgentConditionStats => !!x);
      const wins = st.reduce((t, r) => t + r.wins, 0), losses = st.reduce((t, r) => t + r.losses, 0), draws = st.reduce((t, r) => t + r.draws, 0);
      return st.length ? { wins, losses, draws, iv: wins + losses ? wilson(wins, wins + losses) : null } : null;
    });
    const matches = conds.reduce((t, c) => t + c.matches, 0), draws = conds.reduce((t, c) => t + c.draws, 0);
    const detail = conds.length === 1 ? conditionDetail(conds[0].condition) : "";
    const sub = conds.length
      ? `${matches} matches${draws ? ` · ${draws} draw${draws === 1 ? "" : "s"}` : ""}${detail ? ` · ${detail}` : ""}`
      : "no matches yet";
    return { ...h, sub, cells };
  });
  const totals = agents.map((a) => {
    const st = s.conditions.map((c) => c.byAgent[a.id]).filter((x): x is AgentConditionStats => !!x);
    const matches = st.reduce((t, r) => t + r.matches, 0), selfHits = st.reduce((t, r) => t + r.selfHits, 0);
    const top = Object.entries(mix[a.id] ?? {}).sort((p, q) => q[1] - p[1])[0];
    return { matches, selfHits, top };
  });
  const allMatches = s.conditions.reduce((t, c) => t + c.matches, 0);
  if (!s.conditions.length) return null;
  return (
    <section className="panel panel--wide headline" aria-labelledby="headline-h">
      <header className="panel__head">
        <div>
          <h2 id="headline-h">Headline</h2>
          <p>Computed from every finished match in the pool. Win rate is wins ÷ decisive matches (draws excluded) with a Wilson 95% interval; records are W–L–D.</p>
        </div>
      </header>
      <div className="table-wrap">
        <table className="hl">
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Measure</span></th>
              {agents.map((a) => <th key={a.id} scope="col" style={{ "--team": a.color.main } as CSSProperties}><span className="dotlabel">{a.label}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}<small>{r.sub}</small></th>
                {r.cells.map((c, i) => {
                  const a = agents[i];
                  return (
                    <td key={a.id} style={{ "--team": a.color.main } as CSSProperties}>
                      {c?.iv ? (
                        <div className="hl__win" title={`${a.label}: ${pct(c.iv.p, 1)} (95% CI ${pct(c.iv.lo, 1)}–${pct(c.iv.hi, 1)}), ${c.wins}W ${c.losses}L ${c.draws}D`}>
                          <b>{pct(c.iv.p)}</b>
                          <span>{pct(c.iv.lo)}–{pct(c.iv.hi)}</span>
                          <span className="hl__track" aria-hidden>
                            <i className="hl__mid" />
                            <i className="hl__ci" style={{ left: `${c.iv.lo * 100}%`, width: `${(c.iv.hi - c.iv.lo) * 100}%` }} />
                            <i className="hl__dot" style={{ left: `${c.iv.p * 100}%` }} />
                          </span>
                          <em>{c.wins}–{c.losses}–{c.draws}</em>
                        </div>
                      ) : <span className="hl__none">{c ? "no decisive matches" : "—"}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row">Self-hits per match<small>own shells hitting own tank · all {allMatches} matches</small></th>
              {agents.map((a, i) => (
                <td key={a.id} style={{ "--team": a.color.main } as CSSProperties}>
                  <div className="hl__num"><b>{totals[i].matches ? num(totals[i].selfHits / totals[i].matches, 2) : "—"}</b><span>{totals[i].selfHits} in {totals[i].matches}</span></div>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Dominant drive command<small>share of all decisions</small></th>
              {agents.map((a, i) => {
                const top = totals[i].top;
                return (
                  <td key={a.id} style={{ "--team": a.color.main } as CSSProperties}>
                    {top ? <div className="hl__num"><b className="hl__cmd">{driveLabel(top[0])}</b><span>{pct(top[1])}</span></div> : <span className="hl__none">—</span>}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Panel({ title, sub, children, wide, action }: { title: string; sub?: string; children: ReactNode; wide?: boolean; action?: ReactNode }) {
  return (
    <section className={`panel ${wide ? "panel--wide" : ""}`}>
      <header className="panel__head">
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function StatTable({ s, agents, cols }: { s: RunSummary; agents: AgentMeta[]; cols: [string, (r: AgentConditionStats) => string][] }) {
  if (!s.conditions.length) return <div className="chart-empty">No finished matches yet.</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Latency rule</th>
            <th>Agent</th>
            {cols.map(([h]) => <th key={h} className="num">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {s.conditions.map((c) => {
            const present = agents.filter((a) => c.byAgent[a.id]);
            return present.map((a, i) => (
              <tr key={`${c.condition}/${a.id}`} className={i === 0 ? "is-first" : ""}>
                {i === 0 && <td rowSpan={present.length} className="table__cond">{conditionLabel(c.condition)}<small>{c.matches} matches</small></td>}
                <td><span className="dotlabel" style={{ "--team": a.color.main } as CSSProperties}>{a.label}</span></td>
                {cols.map(([h, f]) => <td key={h} className="num">{f(c.byAgent[a.id])}</td>)}
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}
