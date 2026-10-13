// One pool of matches from /api/matches, newest first, loaded page by page as the list scrolls. Filters run in the
// browser over the pages loaded so far; while a filter is on, more pages load until the list fills or the pool ends.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_PUBLIC_CONDITION, PUBLIC_CONDITIONS } from "../../api/contract.ts";
import type { MatchIndexEntry } from "../../analysis/schema.ts";
import { MAP_IDS, MAPS } from "../../sim/maps.ts";
import { ApiFailure, getVersions, listMatches, useStatus } from "../lib/api.ts";
import { useAsync } from "../lib/data.ts";
import { compareConditions, conditionLabel, mmss, ORIGIN_NOTE, originTag, titleCase, versionLabel } from "../lib/format.ts";
import { poolMatchHref } from "../lib/router.ts";
import { distinctColors } from "../lib/theme.ts";
import { MapThumb } from "./MapThumb.tsx";

type Filters = { version: string; condition: string; map: string; winner: string; tags: string[] };
const DEFAULT: Filters = { version: "all", condition: "all", map: "all", winner: "all", tags: [] };
const KEY = "decision-arena:filters:pool";

/** Open the match list filtered to one version (used by the results page's version picker). */
export function filterMatchesToVersion(version: string): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...DEFAULT, version })); } catch { /* ignore */ }
}
const PAGE = 100; // API maximum per request
const SHOW = 48; // cards added to the DOM per scroll step

function loadFilters(): Filters {
  try {
    const f = { ...DEFAULT, ...JSON.parse(sessionStorage.getItem(KEY) ?? "{}") } as Filters;
    return { version: String(f.version), condition: String(f.condition), map: String(f.map), winner: String(f.winner), tags: Array.isArray(f.tags) ? f.tags.map(String) : [] };
  } catch {
    return DEFAULT;
  }
}

type Pages = { matches: MatchIndexEntry[]; next: string | null; loading: boolean; error: ApiFailure | null; started: boolean };

export function MatchBrowser() {
  const { status } = useStatus();
  const [pages, setPages] = useState<Pages>({ matches: [], next: null, loading: true, error: null, started: false });
  // The version filter is applied by the server (a version can sit far down the newest-first list), so changing it reloads.
  const [version, setVersion] = useState(() => loadFilters().version);
  const versions = useAsync(() => getVersions().catch(() => null), []);
  const busy = useRef(false);
  const gen = useRef(0);
  const load = useCallback(async (cursor: string | null) => {
    if (busy.current && cursor) return;
    busy.current = true;
    const my = cursor ? gen.current : ++gen.current;
    setPages((p) => ({ ...p, loading: true, error: null }));
    try {
      const r = await listMatches(cursor, PAGE, version === "all" ? undefined : version);
      if (my !== gen.current) return; // a newer version choice replaced this load
      setPages((p) => ({ matches: cursor ? [...p.matches, ...r.matches] : r.matches, next: r.nextCursor, loading: false, error: null, started: true }));
    } catch (e) {
      if (my === gen.current) setPages((p) => ({ ...p, loading: false, error: e as ApiFailure, started: true }));
    } finally {
      if (my === gen.current) busy.current = false;
    }
  }, [version]);
  useEffect(() => { void load(null); }, [load]);

  const total = status?.communityMatches ?? null;
  let body;
  if (!pages.started) body = <div className="page-state"><div className="spinner" />Loading matches…</div>;
  else if (pages.error && !pages.matches.length) {
    body = (
      <div className="page-state page-state--error">
        <h2>Matches are unavailable</h2>
        <p>{pages.error.message}</p>
        <button className="btn" onClick={() => void load(null)}>Try again</button>
      </div>
    );
  } else if (!pages.matches.length) {
    body = (
      <div className="empty empty--big">
        <b>No matches yet.</b>
        <span>Every finished match lands here, newest first.</span>
        <a className="btn btn--primary" href="#/run">Run the first one →</a>
      </div>
    );
  } else {
    body = <FilteredCards pages={pages} loadMore={pages.next ? () => void load(pages.next) : null} version={version} setVersion={setVersion}
      versions={versions.status === "ready" && versions.data ? versions.data.versions.map((v) => v.id) : []} />;
  }

  return (
    <div className="browser">
      <header className="browser__head">
        <div>
          <div className="kicker">Replays</div>
          <h1>Matches</h1>
        </div>
        {total !== null && total > 0 && <div className="browser__total"><b>{total.toLocaleString()}</b> match{total === 1 ? "" : "es"} in the pool</div>}
      </header>
      <p className="browser__intro">
        Every match, newest first. The pool started with a seed tournament, run locally (tagged <span className="prov">seed</span>), and every match run
        from this site adds to it. Matches use real latency unless the card names another rule.
      </p>
      {body}
    </div>
  );
}

function FilteredCards({ pages, loadMore, version, setVersion, versions }: {
  pages: Pages; loadMore: (() => void) | null; version: string; setVersion: (v: string) => void; versions: string[];
}) {
  const matches = pages.matches;
  const [f0, setF0] = useState<Filters>(loadFilters);
  // version lives in MatchBrowser (it decides what the server returns); everything else filters the loaded pages.
  const f = { ...f0, version };
  const setF = (next: Filters | ((o: Filters) => Filters)) => {
    const n = typeof next === "function" ? next(f) : next;
    if (n.version !== version) setVersion(n.version);
    setF0(n);
  };
  const [limit, setLimit] = useState(SHOW);
  const fKey = JSON.stringify(f);
  useEffect(() => { try { sessionStorage.setItem(KEY, fKey); } catch { /* ignore */ } setLimit(SHOW); }, [fKey]);
  const set = (patch: Partial<Filters>) => setF((o) => ({ ...o, ...patch }));

  const options = useMemo(() => {
    const uniq = (xs: string[]) => [...new Set(xs)];
    const agents = new Map<string, string>();
    for (const m of matches) m.agents.forEach((a, i) => agents.set(a, m.labels[i]));
    return {
      versions: uniq([...versions, ...matches.map((m) => m.version).filter((v): v is string => !!v)]),
      conditions: uniq([...Object.keys(PUBLIC_CONDITIONS), ...matches.map((m) => m.condition)]).sort(compareConditions),
      maps: uniq([...MAP_IDS, ...matches.map((m) => m.map)]),
      agents: [...agents.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      tags: uniq(matches.flatMap((m) => m.highlights)).sort(),
    };
  }, [matches, versions]);

  const list = useMemo(() => matches.filter((m) =>
    (version === "all" || !m.version || m.version === version) &&
    (f.condition === "all" || m.condition === f.condition) &&
    (f.map === "all" || m.map === f.map) &&
    (f.winner === "all" || (f.winner === "draw" ? m.winner === null : m.winner !== null && m.agents[m.winner] === f.winner)) &&
    f.tags.every((t) => m.highlights.includes(t)),
  ), [matches, fKey]);

  const active = JSON.stringify(f) !== JSON.stringify(DEFAULT);
  const shown = list.slice(0, limit);
  const canGrow = list.length > limit || !!loadMore;

  // Infinite scroll: when the end of the list comes near, show more of what is loaded, else fetch the next page.
  // The observer is rebuilt whenever the list changes, so a sentinel that stays on screen (a sparse filter) keeps
  // pulling pages until the screen fills or the pool runs out.
  const sentinel = useRef<HTMLDivElement>(null);
  const grow = useRef<() => void>(() => {});
  grow.current = () => {
    if (list.length > limit) setLimit((l) => l + SHOW);
    else if (loadMore && !pages.loading && !pages.error) loadMore();
  };
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canGrow) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) grow.current(); }, { rootMargin: "900px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [canGrow, list.length, limit, matches.length, pages.loading]);

  return (
    <>
      <div className="filters" role="search">
        <Select label="Version" value={f.version} onChange={(version) => set({ version })} options={options.versions.map((v) => [v, versionLabel(v)])} />
        <Select label="Latency rule" value={f.condition} onChange={(condition) => set({ condition })} options={options.conditions.map((c) => [c, conditionLabel(c)])} />
        <Select label="Map" value={f.map} onChange={(map) => set({ map })} options={options.maps.map((m) => [m, MAPS[m]?.name ?? m])} />
        <Select label="Winner" value={f.winner} onChange={(winner) => set({ winner })} options={[["draw", "Draws"], ...options.agents]} />
        {active && <button className="btn btn--ghost btn--sm filters__reset" onClick={() => setF(DEFAULT)}>Reset</button>}
      </div>
      <div className="tagbar" aria-label="Highlight filters">
        {options.tags.map((t) => {
          const on = f.tags.includes(t);
          return (
            <button key={t} className={`tag tag--${slug(t)} ${on ? "is-on" : ""}`} aria-pressed={on} onClick={() => set({ tags: on ? f.tags.filter((x) => x !== t) : [...f.tags, t] })}>
              {titleCase(t)}
            </button>
          );
        })}
        <span className="tagbar__count" aria-live="polite">
          {active
            ? `${list.length.toLocaleString()} of ${matches.length.toLocaleString()} loaded match${matches.length === 1 ? "" : "es"}${loadMore ? " · filters apply as more load" : ""}`
            : `${matches.length.toLocaleString()} match${matches.length === 1 ? "" : "es"}${loadMore ? " loaded" : ""}`}
        </span>
      </div>

      {list.length === 0 && !loadMore ? (
        <div className="empty">No matches fit these filters. <button className="linkish" onClick={() => setF(DEFAULT)}>Clear filters</button></div>
      ) : (
        <div className="cards">
          {shown.map((m, i) => <MatchCard key={m.matchId} m={m} i={i % SHOW} />)}
        </div>
      )}
      <div ref={sentinel} className="more">
        {pages.error ? (
          <span className="more__err">Couldn’t load more: {pages.error.message} <button className="btn btn--sm" onClick={() => loadMore?.()}>Retry</button></span>
        ) : pages.loading ? (
          <span className="more__busy"><span className="spinner spinner--xs" /> Loading more matches…</span>
        ) : canGrow ? (
          <button className="btn" onClick={() => grow.current()}>Show more</button>
        ) : list.length > 0 ? (
          <span className="more__end">That’s every match{active ? " that fits" : ""}.</span>
        ) : null}
      </div>
    </>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function MatchCard({ m, i }: { m: MatchIndexEntry; i: number }) {
  const colors = distinctColors(m.agents);
  const winColor = m.winner !== null ? colors[m.winner] : null;
  const style = { "--i": Math.min(i, 16), "--win": winColor?.main ?? "#8b97a8", "--win-rgb": (winColor?.rgb ?? [139, 151, 168]).join(",") } as CSSProperties;
  const tag = originTag(m.origin);
  return (
    <a className={`card ${m.winner === null ? "is-draw" : ""}`} href={poolMatchHref(m.matchId)} style={style}>
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
          {m.condition !== DEFAULT_PUBLIC_CONDITION && <><span>·</span><span className="card__cond">{conditionLabel(m.condition)}</span></>}
          {m.version && <><span>·</span><span className="card__ver" title={m.version.replace(":", " · ")}>{versionLabel(m.version)}</span></>}
          {tag && <span className="card__run prov" title={ORIGIN_NOTE}>{tag}</span>}
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
