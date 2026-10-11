import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_PUBLIC_CONDITION } from "../../api/contract.ts";
import type { MatchIndexEntry } from "../../analysis/schema.ts";
import { MAPS } from "../../sim/maps.ts";
import { ArenaCanvas } from "../arena/ArenaCanvas.tsx";
import { getCommunitySummary, listMatches, useStatus } from "../lib/api.ts";
import { loadLog, useAsync } from "../lib/data.ts";
import { FEATURE_BUCKET_MS, FEATURE_POOL, featureBucket, pickFeatured } from "../lib/featured.ts";
import { compareConditions, conditionLabel, mmss, ms, ORIGIN_NOTE, originTag, pct, reasonLabel } from "../lib/format.ts";
import { MATCHES_HREF, poolMatchHref, RESULTS_HREF } from "../lib/router.ts";
import { agentRecord, leader, poolStory, shortName, totalMatches } from "../lib/summary.ts";
import { canonicalOrder, distinctColors, shortLabel, type TeamColor } from "../lib/theme.ts";
import { teamStyle } from "../match/BrainPanel.tsx";
import { buildModel, type MatchModel } from "../replay/model.ts";
import { Player } from "../replay/player.ts";
import { StatusStrip } from "./StatusStrip.tsx";

export const REPO_URL = "https://github.com/jd4d/decision-arena";

export function HomePage() {
  const { status } = useStatus();
  const fuel = status ? status.acceptingMatches : true;
  return (
    <div className="home">
      <section className="hero2">
        <div className="hero2__copy">
          <div className="kicker"><span className="live-dot" /> Live decision-model benchmark</div>
          <h1>Two decision models. One tank each. <em>Thinking costs time.</em></h1>
          <p>
            Jev 1.13 and Microsoft Decision 1 fight real-time tank duels. Every order lands after the model’s measured response time, so the
            enemy keeps moving while it thinks. Start a match, watch it live, and see where it lands in the results.
          </p>
          <div className="hero2__actions">
            {fuel ? (
              <a className="btn btn--cta" href="#/run">
                Run a match <span aria-hidden>→</span>
              </a>
            ) : (
              <span className="btn btn--cta is-off" aria-disabled="true">Arena out of fuel</span>
            )}
            <a className="btn btn--lg btn--ghost" href={MATCHES_HREF}>Watch replays</a>
          </div>
          <StatusStrip status={status} />
          {!fuel && <p className="hero2__fuel">The model credit for new matches is used up. Replays and results stay open.</p>}
        </div>
        <FeaturedArena />
      </section>

      <PoolBoard />

      <section className="how" aria-labelledby="how-h">
        <h2 id="how-h" className="sr-only">How it works</h2>
        {[
          ["Pick", "Choose a map and a latency rule, or leave both on Random. Sides and seed are drawn at random."],
          ["Watch", "Both models decide in real time. Ghosts show the enemy as each model last saw it."],
          ["Compare", "Your match joins the pool. See how it moved the win rates."],
        ].map(([t, d], i) => (
          <div key={t} className="how__step" style={{ "--i": i } as CSSProperties}>
            <span className="how__n">{i + 1}</span>
            <b>{t}</b>
            <p>{d}</p>
          </div>
        ))}
        <a className="how__more" href="#/methodology">How latency becomes game time →</a>
      </section>

      <SiteFooter />
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="sitefoot">
      <span>Decision Arena · sim-2 · protocol p1</span>
      <span>One pool: the t1 tournament, run locally, plus every match run from this site on Cloudflare in eastern North America. Each match is tagged with where it ran.</span>
      <span className="sitefoot__links">
        <a href="#/methodology">Methodology</a>
        <a href={REPO_URL} target="_blank" rel="noreferrer">Source on GitHub ↗</a>
      </span>
    </footer>
  );
}

// ---------------------------------------------------------------- featured replay (attract mode)

type Featured = { entry: MatchIndexEntry; model: MatchModel };

/** The newest ~100 pool entries (the API returns at most 100 per page). */
async function newestEntries(): Promise<MatchIndexEntry[]> {
  const first = await listMatches(null, FEATURE_POOL);
  if (first.matches.length >= FEATURE_POOL || !first.nextCursor) return first.matches;
  const second = await listMatches(first.nextCursor, FEATURE_POOL - first.matches.length).catch(() => null);
  return [...first.matches, ...(second?.matches ?? [])];
}

/** A watchable recent match from the pool, the same for everyone within a 5-minute bucket (lib/featured.ts). */
function FeaturedArena() {
  const [bucket, setBucket] = useState(() => featureBucket(Date.now()));
  const [state, setState] = useState<Featured | "loading" | "none" | "error">("loading");

  // Rotate at the next bucket boundary while the page stays open.
  useEffect(() => {
    const t = setTimeout(() => setBucket(featureBucket(Date.now())), FEATURE_BUCKET_MS - (Date.now() % FEATURE_BUCKET_MS) + 250);
    return () => clearTimeout(t);
  }, [bucket]);

  useEffect(() => {
    let live = true;
    (async (): Promise<Featured | null> => {
      const pick = pickFeatured(await newestEntries(), bucket * FEATURE_BUCKET_MS);
      if (!pick) return null;
      // If the pick's log won't load, fall back to the next match on the shortlist.
      for (const entry of pick.candidates) {
        try { return { entry, model: buildModel(await loadLog(entry.matchId)) }; } catch { /* next candidate */ }
      }
      throw new Error("No featured replay could be loaded.");
    })().then(
      (f) => { if (live) setState((old) => f ?? (typeof old === "object" ? old : "none")); },
      // Keep showing the current replay if a rotation fails.
      () => { if (live) setState((old) => (typeof old === "object" ? old : "error")); },
    );
    return () => { live = false; };
  }, [bucket]);

  const data = typeof state === "object" ? state : null;
  return (
    <figure className="hero2__arena">
      <div className="feature">
        {data ? (
          <AttractLoop key={data.entry.matchId} model={data.model} />
        ) : (
          <div className="feature__skel">
            {state === "loading" ? <div className="spinner" /> : state === "none" ? <span>No replays yet. <a href="#/run">Run the first match →</a></span> : <span>The featured replay is unavailable right now. <a href={MATCHES_HREF}>Browse matches →</a></span>}
          </div>
        )}
      </div>
      {data && <FeaturedCaption entry={data.entry} />}
    </figure>
  );
}

function FeaturedCaption({ entry: e }: { entry: MatchIndexEntry }) {
  const colors = distinctColors(e.agents);
  const tag = originTag(e.origin);
  const outcome = e.winner === null ? `Draw · ${reasonLabel(e.reason).toLowerCase()}` : `${shortName(e.labels[e.winner])} wins · ${reasonLabel(e.reason).toLowerCase()}`;
  return (
    <figcaption>
      <span className="feature__tag">Featured replay</span>
      <span className="feature__vs">
        <b style={{ color: colors[0].main }}>{e.labels[0]}</b> vs <b style={{ color: colors[1].main }}>{e.labels[1]}</b>
      </span>
      <span>
        {MAPS[e.map]?.name ?? e.map} · {conditionLabel(e.condition)} · {outcome} · {mmss(e.durationS)}
        {tag && <span className="prov" title={ORIGIN_NOTE}>{tag}</span>}
      </span>
      <a href={poolMatchHref(e.matchId)}>Watch full replay →</a>
    </figcaption>
  );
}

function AttractLoop({ model }: { model: MatchModel }) {
  const [player] = useState(() => new Player(model.endTick, model.slowTicks));
  const ref = useRef<HTMLDivElement>(null);
  const agents = model.header.agents;
  const colors = useMemo(() => distinctColors(agents.map((a) => a.id)) as [TeamColor, TeamColor], [agents]);
  const labels = useMemo(() => agents.map((a) => a.label) as [string, string], [agents]);
  const tags = useMemo(() => agents.map((a) => shortLabel(a.id, a.label)) as [string, string], [agents]);

  useEffect(() => {
    let visible = true;
    let timer = 0;
    // Loop forever, and only spend frames while on screen.
    const off = player.subscribe(() => {
      const s = player.getSnapshot();
      if (s.ended && !s.playing && visible) {
        clearTimeout(timer);
        timer = window.setTimeout(() => { player.seek(0); player.play(); }, 1600);
      }
    });
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting && document.visibilityState === "visible";
      if (visible) player.play();
      else player.pause();
    });
    if (ref.current) io.observe(ref.current);
    const start = window.setTimeout(() => player.play(), 400);
    return () => { off(); io.disconnect(); clearTimeout(timer); clearTimeout(start); player.dispose(); };
  }, [player]);

  return (
    <div className="feature__stage" ref={ref}>
      <ArenaCanvas model={model} player={player} colors={colors} tags={tags} labels={labels} endCard={false} />
    </div>
  );
}

// ---------------------------------------------------------------- compact pool scoreboard

/** Win-rate gap from 50% below which a non-significant lead reads as "too close to call". */
const EVEN = 0.03;

function PoolBoard() {
  const st = useAsync(() => getCommunitySummary().catch(() => null), []);
  if (st.status !== "ready") return <section className="board board--loading" aria-busy="true"><div className="spinner" /></section>;
  const s = st.data;
  if (!s) return null;
  const n = totalMatches(s);
  const agents = canonicalOrder(s.agents);
  const colors = distinctColors(agents.map((a) => a.id));
  if (n === 0) {
    return (
      <section className="board" aria-labelledby="board-h">
        <header className="board__head">
          <div>
            <div className="kicker">Scoreboard</div>
            <h2 id="board-h">No matches yet</h2>
            <p>Run the first one and it opens the results.</p>
          </div>
        </header>
      </section>
    );
  }
  const story = poolStory(s, agents);
  const REAL = DEFAULT_PUBLIC_CONDITION;
  const hasReal = totalMatches(s, REAL) > 0;
  // The big scoreboard pools every match in the pool, across all latency rules (wins ÷ decisive matches).
  const lead = leader(s, agents);
  const headline = !lead || (!lead.clear && lead.rate.p - 0.5 < EVEN)
    ? "Dead even across every match"
    : `${shortName(lead.label)} ${lead.clear ? "leads" : "edges ahead"} across every match`;
  const control = story.control;
  const ctl = story.decisions;
  const facts: string[] = [];
  if (control && ctl) facts.push(`${conditionLabel(control)}: ${shortName(ctl.label)} ${pct(ctl.rate.p)} (95% CI ${pct(ctl.rate.lo)}–${pct(ctl.rate.hi)}).`);
  const medians = agents.filter((a) => Number.isFinite(story.p50[a.id])).map((a) => `${shortName(a.label)} ${ms(story.p50[a.id])}`);
  if (medians.length) facts.push(`Median response: ${medians.join(", ")}.`);
  const conds = s.conditions.filter((c) => c.matches > 0).map((c) => c.condition).sort(compareConditions);
  return (
    <section className="board" aria-labelledby="board-h">
      <header className="board__head">
        <div>
          <div className="kicker">Scoreboard · {n.toLocaleString()} match{n === 1 ? "" : "es"} in the pool</div>
          <h2 id="board-h">{headline}</h2>
          {story.tagline && (
            <p className="board__why">
              {control && <span className="board__ctl">Equal-latency control</span>}
              {story.tagline}.
            </p>
          )}
          {facts.length > 0 && <p>{facts.join(" ")} Win rate is wins ÷ decisive matches.</p>}
        </div>
        <div className="board__links">
          <a className="btn btn--sm" href={RESULTS_HREF}>Full results →</a>
        </div>
      </header>
      <div className="board__grid">
        {agents.map((a, i) => {
          const r = agentRecord(s, a.id);
          const real = hasReal ? agentRecord(s, a.id, REAL).winRate : null;
          const eq = control ? agentRecord(s, a.id, control).winRate : null;
          return (
            <div key={a.id} className="board__agent" style={{ ...teamStyle(colors[i]), "--i": i } as CSSProperties}>
              <div className="board__name">{a.label}</div>
              <div className="board__big">{r.winRate ? pct(r.winRate.p) : "—"}<small>all matches</small></div>
              <div className="board__ci">{r.winRate ? `95% CI ${pct(r.winRate.lo)}–${pct(r.winRate.hi)}` : "no decisive matches"}</div>
              <dl>
                <div><dt>Record</dt><dd>{r.wins}–{r.losses}–{r.draws}</dd></div>
                <div><dt>Real latency</dt><dd>{real ? pct(real.p) : "—"}</dd></div>
                {control && <div><dt>Equal latency</dt><dd>{eq ? pct(eq.p) : "—"}</dd></div>}
                <div><dt>Median</dt><dd>{ms(story.p50[a.id])}</dd></div>
              </dl>
            </div>
          );
        })}
        <div className={`board__conds ${conds.length > 3 ? "is-two" : ""}`} style={{ "--rows": Math.ceil(conds.length / 2) } as CSSProperties}>
          {conds.map((c) => {
            const [ra, rb] = agents.slice(0, 2).map((a) => agentRecord(s, a.id, c));
            const dec = ra.wins + ra.losses;
            const share = dec ? ra.wins / dec : 0.5;
            return (
              <div key={c} className={`split ${c === REAL ? "is-real" : ""}`} title={`${conditionLabel(c)}: ${agents[0].label} ${ra.wins}, ${agents[1]?.label} ${rb?.wins ?? 0}, ${ra.draws} draws`}>
                <div className="split__label"><span>{conditionLabel(c)}</span><small>{totalMatches(s, c).toLocaleString()} matches</small></div>
                <div className="split__bar" style={{ "--a": colors[0].main, "--b": colors[1]?.main } as CSSProperties}>
                  <i style={{ width: `${share * 100}%` }}><b>{dec ? pct(share) : ""}</b></i>
                  <i style={{ width: `${(1 - share) * 100}%` }}><b>{dec ? pct(1 - share) : ""}</b></i>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
