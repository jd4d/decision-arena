import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { MatchIndexEntry } from "../../analysis/schema.ts";
import { MAPS } from "../../sim/maps.ts";
import { loadIndex, NotFound, useAsync } from "../lib/data.ts";
import { compareConditions, conditionLabel, mmss, titleCase } from "../lib/format.ts";
import { matchHref, resultsHref } from "../lib/router.ts";
import { distinctColors, isDevRun } from "../lib/theme.ts";
import { MapThumb } from "./MapThumb.tsx";

type Filters = { run: string; condition: string; map: string; agent: string; winner: string; tags: string[]; sort: string };
const DEFAULT: Filters = { run: "all", condition: "all", map: "all", agent: "all", winner: "all", tags: [], sort: "run" };
const KEY = "decision-arena:filters";
const PAGE = 48;

function loadFilters(): Filters {
  try { return { ...DEFAULT, ...JSON.parse(sessionStorage.getItem(KEY) ?? "{}") }; } catch { return DEFAULT; }
}

export function MatchBrowser() {
  const idx = useAsync(loadIndex, []);
  const [f, setF] = useState<Filters>(loadFilters);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { sessionStorage.setItem(KEY, JSON.stringify(f)); setLimit(PAGE); }, [f]);
  const set = (patch: Partial<Filters>) => setF((o) => ({ ...o, ...patch }));

  const data = idx.status === "ready" ? idx.data : null;
  const options = useMemo(() => {
    const ms = data?.matches ?? [];
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    const agents = new Map<string, string>();
    for (const m of ms) m.agents.forEach((a, i) => agents.set(a, m.labels[i]));
    return {
      runs: data?.runs.map((r) => r.runId) ?? [],
      conditions: uniq(ms.map((m) => m.condition)).sort(compareConditions),
      maps: uniq(ms.map((m) => m.map)),
      agents: [...agents.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      tags: uniq(ms.flatMap((m) => m.highlights)),
    };
  }, [data]);

  const list = useMemo(() => {
    if (!data) return [];
    const runOrder = new Map(data.runs.map((r, i) => [r.runId, (isDevRun(r.runId) ? 1000 : 0) + i]));
    const out = data.matches.filter((m) =>
      (f.run === "all" || m.runId === f.run) &&
      (f.condition === "all" || m.condition === f.condition) &&
      (f.map === "all" || m.map === f.map) &&
      (f.agent === "all" || m.agents.includes(f.agent)) &&
      (f.winner === "all" || (f.winner === "draw" ? m.winner === null : m.winner !== null && m.agents[m.winner] === f.winner)) &&
      f.tags.every((t) => m.highlights.includes(t)),
    );
    const byRun = (a: MatchIndexEntry, b: MatchIndexEntry) => (runOrder.get(a.runId)! - runOrder.get(b.runId)!) || a.matchId.localeCompare(b.matchId, undefined, { numeric: true });
    const sorters: Record<string, (a: MatchIndexEntry, b: MatchIndexEntry) => number> = {
      run: byRun,
      short: (a, b) => a.durationS - b.durationS || byRun(a, b),
      long: (a, b) => b.durationS - a.durationS || byRun(a, b),
      action: (a, b) => b.highlights.length - a.highlights.length || a.durationS - b.durationS,
    };
    return out.sort(sorters[f.sort] ?? byRun);
  }, [data, f]);

  if (idx.status === "loading") return <div className="page-state"><div className="spinner" />Loading matches…</div>;
  if (idx.status === "error") return <NoData error={idx.error} />;
  const d = idx.data;
  const realRuns = d.runs.filter((r) => !isDevRun(r.runId));
  const featured = realRuns[realRuns.length - 1] ?? d.runs[d.runs.length - 1];
  const active = JSON.stringify(f) !== JSON.stringify(DEFAULT);

  return (
    <div className="browser">
      <section className="hero">
        <div className="hero__copy">
          <div className="kicker"><span className="live-dot" /> Real-time decision benchmark</div>
          <h1>Two decision models. One tank each. <em>Thinking costs time.</em></h1>
          <p>Every decision is applied after the model’s measured latency, so the enemy keeps moving while it thinks. Watch the replays, then check who controls better and how much speed matters.</p>
        </div>
        <div className="hero__stats">
          <Stat label="Matches" value={String(d.matches.length)} />
          <Stat label="Runs" value={String(d.runs.length)} />
          <Stat label="Conditions" value={String(new Set(d.matches.map((m) => m.condition)).size)} />
          {featured && <a className="btn btn--primary" href={resultsHref(featured.runId)}>Results · {featured.runId} →</a>}
        </div>
      </section>

      {d.devFixture && <div className="notice notice--dev"><b>Dev fixture data.</b> {d.devFixture}</div>}

      <div className="filters" role="search">
        <Select label="Run" value={f.run} onChange={(run) => set({ run })} options={options.runs.map((r) => [r, isDevRun(r) ? `${r} (dev)` : r])} />
        <Select label="Condition" value={f.condition} onChange={(condition) => set({ condition })} options={options.conditions.map((c) => [c, conditionLabel(c)])} />
        <Select label="Map" value={f.map} onChange={(map) => set({ map })} options={options.maps.map((m) => [m, MAPS[m]?.name ?? m])} />
        <Select label="Agent" value={f.agent} onChange={(agent) => set({ agent })} options={options.agents} />
        <Select label="Winner" value={f.winner} onChange={(winner) => set({ winner })} options={[["draw", "Draws"], ...options.agents]} />
        <Select label="Sort" value={f.sort} onChange={(sort) => set({ sort })} options={[["short", "Shortest"], ["long", "Longest"], ["action", "Most highlights"]]} allLabel="By run" allValue="run" />
        {active && <button className="btn btn--ghost btn--sm filters__reset" onClick={() => setF(DEFAULT)}>Reset</button>}
      </div>
      {options.tags.length > 0 && (
        <div className="tagbar" aria-label="Highlight filters">
          {options.tags.map((t) => {
            const on = f.tags.includes(t);
            return (
              <button key={t} className={`tag tag--${slug(t)} ${on ? "is-on" : ""}`} aria-pressed={on} onClick={() => set({ tags: on ? f.tags.filter((x) => x !== t) : [...f.tags, t] })}>
                {titleCase(t)}
              </button>
            );
          })}
          <span className="tagbar__count">{list.length} match{list.length === 1 ? "" : "es"}</span>
        </div>
      )}

      {list.length === 0 ? (
        <div className="empty">No matches fit these filters. <button className="linkish" onClick={() => setF(DEFAULT)}>Clear filters</button></div>
      ) : (
        <div className="cards">
          {list.slice(0, limit).map((m, i) => <MatchCard key={`${m.runId}/${m.matchId}`} m={m} i={i} />)}
        </div>
      )}
      {list.length > limit && (
        <div className="more"><button className="btn" onClick={() => setLimit((l) => l + PAGE)}>Show more ({list.length - limit} left)</button></div>
      )}
    </div>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function MatchCard({ m, i }: { m: MatchIndexEntry; i: number }) {
  const colors = distinctColors(m.agents);
  const winColor = m.winner !== null ? colors[m.winner] : null;
  const style = { "--i": Math.min(i, 16), "--win": winColor?.main ?? "#8b97a8", "--win-rgb": (winColor?.rgb ?? [139, 151, 168]).join(",") } as CSSProperties;
  return (
    <a className={`card ${m.winner === null ? "is-draw" : ""}`} href={matchHref(m.runId, m.matchId)} style={style}>
      <div className="card__map">
        <MapThumb map={m.map} seed={m.seed} colors={[colors[0].main, colors[1].main]} />
        <span className="card__mapname">{MAPS[m.map]?.name ?? m.map}</span>
        <span className="card__dur">{mmss(m.durationS)}</span>
        <span className="card__play" aria-hidden>
          <svg viewBox="0 0 16 16"><path d="M5 3v10l8-5z" fill="currentColor" /></svg>
        </span>
      </div>
      <div className="card__body">
        {[0, 1].map((slot) => {
          const won = m.winner === slot;
          return (
            <div key={slot} className={`card__side ${won ? "is-winner" : ""} ${m.winner !== null && !won ? "is-loser" : ""}`} style={{ "--team": colors[slot].main } as CSSProperties}>
              <span className="card__name">{m.labels[slot]}</span>
              <span className="card__hp">
                {Array.from({ length: Math.max(3, m.hp[slot]) }, (_, k) => <span key={k} className={k < m.hp[slot] ? "is-on" : ""} />)}
              </span>
              {won && <span className="card__win">WIN</span>}
            </div>
          );
        })}
        <div className="card__meta">
          <span>{m.winner === null ? "Draw" : titleCase(m.reason)}</span>
          <span>·</span>
          <span>{conditionLabel(m.condition)}</span>
          <span>·</span>
          <span>seed {m.seed}</span>
          <span className="card__run">{m.runId}</span>
        </div>
        {m.highlights.length > 0 && (
          <div className="card__tags">
            {m.highlights.map((h) => <span key={h} className={`tag tag--sm tag--${slug(h)}`}>{titleCase(h)}</span>)}
          </div>
        )}
      </div>
    </a>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><div className="stat__v">{value}</div><div className="stat__l">{label}</div></div>;
}

function Select({ label, value, onChange, options, allLabel = "All", allValue = "all" }: {
  label: string; value: string; onChange: (v: string) => void; options: (readonly [string, string])[] | [string, string][]; allLabel?: string; allValue?: string;
}) {
  return (
    <label className={`select ${value !== allValue ? "is-set" : ""}`}>
      <span className="select__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={allValue}>{allLabel}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export function NoData({ error }: { error: Error }) {
  const missing = error instanceof NotFound;
  return (
    <div className="page-state page-state--error">
      <h2>{missing ? "No data yet" : "Couldn’t load data"}</h2>
      {missing ? (
        <p>
          The viewer reads <code>public/data/index.json</code>. Export runs with <code>pnpm analyze</code> (add <code>--include-dev</code> for dev runs), or build dev
          fixture data with <code>node src/viewer/dev/make-fixture.ts</code>.
        </p>
      ) : (
        <p>{error.message}</p>
      )}
    </div>
  );
}

