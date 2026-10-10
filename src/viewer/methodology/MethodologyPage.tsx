// How the arena works. Rules, protocol wording and constants are imported from the code that runs the matches,
// so this page can't drift from what the models actually receive.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DEFAULT_PUBLIC_CONDITION, PUBLIC_CONDITIONS, type PublicCondition } from "../../api/contract.ts";
import { buildQuestions, encodeState, PROTOCOL_VERSION, TURRET_LEVELS, type Question } from "../../protocol/v1.ts";
import { msToTicks } from "../../runner/latency.ts";
import { MAPS } from "../../sim/maps.ts";
import { observe } from "../../sim/observe.ts";
import * as T from "../../sim/tuning.ts";
import { createWorld, setOrders, step } from "../../sim/world.ts";
import { SiteFooter, REPO_URL } from "../home/HomePage.tsx";
import { getCommunitySummary } from "../lib/api.ts";
import { useAsync } from "../lib/data.ts";
import { conditionLabel, ms, pct, usd } from "../lib/format.ts";
import { agentRecord, leader, poolStory, shortName, totalMatches } from "../lib/summary.ts";
import { canonicalOrder } from "../lib/theme.ts";

const SECTIONS: [string, string][] = [
  ["game", "The game"],
  ["latency", "Latency becomes game time"],
  ["protocol", "The protocol"],
  ["conditions", "Latency rules"],
  ["pool", "One pool"],
  ["speed", "Why speed matters"],
  ["caveats", "Known caveats"],
  ["cost", "Cost per match"],
  ["source", "Source"],
];

/** A mid-fight observation from the real simulation, encoded exactly as the models receive it. */
function sampleObservation() {
  const w = createWorld("pillars", 10);
  setOrders(w, 0, { drive: "forward", turret: 0.3, fire: false });
  setOrders(w, 1, { drive: "forward_left", turret: -0.2, fire: true });
  for (let i = 0; i < 30; i++) step(w);
  return observe(w, 0);
}

export function MethodologyPage({ section }: { section: string | null }) {
  const summary = useAsync(() => getCommunitySummary().catch(() => null), []);
  const pool = summary.status === "ready" && summary.data && totalMatches(summary.data) > 0 ? summary.data : null;
  const obs = useMemo(sampleObservation, []);
  const state = useMemo(() => encodeState(obs), [obs]);
  const questions = useMemo(() => buildQuestions(obs), [obs]);
  const [active, setActive] = useState(section ?? "game");

  useEffect(() => {
    if (!section) return;
    document.getElementById(`m-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [section]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => {
        const vis = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id.slice(2));
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    for (const [id] of SECTIONS) {
      const el = document.getElementById(`m-${id}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  const go = (id: string) => {
    document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(history.state, "", `${location.pathname}${location.search}#/methodology/${id}`);
  };

  const rec = (id: string, c: string) => agentRecord(pool, id, c);
  const ag = canonicalOrder(pool?.agents ?? [{ id: "jev", label: "Jev 1.13" }, { id: "msd1", label: "Microsoft Decision 1" }]);
  const binMs = pool ? Object.values(pool.latencyHistogram)[0]?.binMs ?? 25 : 25;
  const story = poolStory(pool, ag);
  const n = totalMatches(pool);
  /** "Microsoft 61%" for the agent winning most decisive matches under a rule, or "even". */
  const ahead = (c: string) => {
    const l = leader(pool, ag, c);
    return l ? `${shortName(l.label)} ${pct(l.rate.p)}` : "even";
  };
  const swap = (Object.keys(PUBLIC_CONDITIONS) as PublicCondition[]).find((c) => c.startsWith("swap-")) ?? "swap-1";

  return (
    <div className="method">
      <aside className="method__toc" aria-label="On this page">
        <div className="kicker">Methodology</div>
        <nav>
          {SECTIONS.map(([id, label]) => (
            <button key={id} className={active === id ? "is-on" : ""} onClick={() => go(id)}>{label}</button>
          ))}
        </nav>
      </aside>

      <article className="method__body">
        <header className="method__intro">
          <div className="kicker">How the arena works</div>
          <h1>A benchmark where thinking costs time</h1>
          <p>
            Two structured decision models each drive a tank. The game never waits for them: a decision is applied only after the model’s
            measured response time has passed in game time, so a slower model acts on an older picture of the battlefield. Everything below is
            rendered from the code that runs the matches.
          </p>
        </header>

        <Section id="game" title="The game">
          <p>A top-down duel in a {T.ARENA_W} × {T.ARENA_H} m arena, simulated at {T.TICK_HZ} ticks per second. The simulation is pure and seeded, so every replay is re-simulated from its log and checked against recorded checksums.</p>
          <ul className="facts">
            <li><b>{T.TANK_HP} HP</b> per tank; each hit removes 1.</li>
            <li><b>{T.ROUND_SECONDS} s</b> rounds; at time-out more HP wins, equal HP is a draw.</li>
            <li><b>Shells</b> fly at {T.SHELL_SPEED} m/s and bounce off walls {T.SHELL_MAX_BOUNCES === 1 ? "once" : `${T.SHELL_MAX_BOUNCES} times`}, so a tank can hit itself.</li>
            <li><b>Reload</b> {(T.RELOAD_TICKS / T.TICK_HZ).toFixed(1)} s, at most {T.MAX_SHELLS_PER_TANK} shells in flight.</li>
            <li><b>Hull</b> {T.TANK_SPEED} m/s forward, {T.TANK_REVERSE_SPEED} m/s reverse; the turret turns independently.</li>
            <li><b>Maps</b> {Object.values(MAPS).map((m) => m.name).join(", ")}: point-symmetric, so neither spawn is favoured.</li>
          </ul>
          <Quote label="Rules text sent with every decision">{String(state.rules)}</Quote>
        </Section>

        <Section id="latency" title="Latency becomes game time">
          <p>
            When a model is asked for a decision at tick <i>T</i>, it sees the state at <i>T</i>. Its answer is applied at tick
            <i> T + effective latency</i>. Until then its tank keeps executing its previous orders, and the enemy keeps moving. As soon as an
            answer lands, the next question is asked. In replays, the dashed <em>ghost</em> shows the enemy where the model last saw it.
          </p>
          <LatencyDiagram />
          <p className="method__small">
            Ticks are whole: {ms(250)} becomes {msToTicks(250)} ticks ({((msToTicks(250) / T.TICK_HZ) * 1000).toFixed(0)} ms). Game time runs with the clock while models think, but it never passes a tick where an unanswered decision could still land, so results are exact without depending on server timing. When a model answers slower than a fixed delay, a live match briefly slows down to wait for it.
          </p>
        </Section>

        <Section id="protocol" title={`The protocol (${PROTOCOL_VERSION})`}>
          <p>
            Both models get the same plain-language state and the same three questions through the same OpenRouter decisions endpoint. There are no raw coordinates; everything is egocentric. Here is a real mid-fight example, generated by the protocol code:
          </p>
          <div className="proto">
            <div className="proto__state">
              <div className="proto__label">State</div>
              <pre className="code"><code>{JSON.stringify({ ...state, rules: "…(above)" }, null, 2)}</code></pre>
            </div>
            <div className="proto__qs">
              {Object.entries(questions).map(([key, q]) => <QuestionCard key={key} name={key} q={q} />)}
            </div>
          </div>
          <ul className="facts facts--tight">
            <li><b>Drive</b> takes the most likely option.</li>
            <li><b>Turret</b> uses the expected rotation over the {TURRET_LEVELS.length} levels, so a split answer turns slowly.</li>
            <li><b>Fire</b> shoots when the probability is at least 0.5.</li>
          </ul>
        </Section>

        <Section id="conditions" title="Latency rules">
          <p>
            <b>Real latency is the default</b>, and a visitor never has to change it: each model’s measured response time becomes game time. The other five rules
            are the experiments behind the results. They separate decision quality from speed, and anyone can pick one under “Latency rule” when starting a match.
          </p>
          <div className="condlist">
            {(Object.keys(PUBLIC_CONDITIONS) as PublicCondition[]).map((c) => (
              <div key={c} className={`condlist__row ${c === DEFAULT_PUBLIC_CONDITION ? "" : "is-dim"}`}>
                <b>{PUBLIC_CONDITIONS[c].label}{c === DEFAULT_PUBLIC_CONDITION ? " · default" : ""}</b>
                <code>{PUBLIC_CONDITIONS[c].latency}</code>
                <span>{PUBLIC_CONDITIONS[c].blurb}</span>
              </div>
            ))}
          </div>
          <p className="method__small">
            Swapped latency samples each model’s response time from the other model’s recorded latency distribution in the pool, so the faster thinker gets the
            slower reflexes and the other way round. The scaled rules multiply each measured response time before it becomes game time.
          </p>
        </Section>

        <Section id="pool" title="One pool">
          <p>
            Every match lands in one pool, and every result on this site is computed from it. The pool started with the t1 tournament: each of the six rules on
            every map, 25 seeds, both sides, run locally from Jesse’s Mac. Every match run from this site, on Cloudflare in eastern North America, adds to it.
            {pool && <> It holds {n.toLocaleString()} matches now.</>}
          </p>
          <p className="method__small">
            Every match records where it ran: seed matches carry a <span className="prov">seed · t1</span> tag in the match list and replays. The two places reach
            OpenRouter over slightly different network paths, so their measured latencies can differ a little (see the caveats).
          </p>
        </Section>

        <Section id="speed" title="Why speed matters">
          <p>
            A tank at full speed covers {T.TANK_SPEED} m per second. At {ms(280)} of latency the enemy has moved about {(T.TANK_SPEED * 0.28).toFixed(1)} m
            (about half a tank length) before the order lands, and a shell needs {((T.ARENA_W / 2) / T.SHELL_SPEED).toFixed(1)} s to cross half the arena.
            A better decision that arrives late can lose to a worse one that arrives early.
          </p>
          {pool && (
            <div className="speedcmp">
              {[story.control ?? "fixed-250", DEFAULT_PUBLIC_CONDITION, swap].map((c) => (
                <div key={c} className="speedcmp__col">
                  <div className="speedcmp__h">{conditionLabel(c)}</div>
                  {ag.map((a, i) => {
                    const r = rec(a.id, c);
                    return (
                      <div key={a.id} className={`speedcmp__bar speedcmp__bar--${i}`}>
                        <span>{a.label}</span>
                        <i style={{ "--w": r.winRate ? r.winRate.p : 0 } as CSSProperties} />
                        <b>{r.winRate ? pct(r.winRate.p) : "—"}</b>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {pool && (
            <p className="method__small">
              Pool win rates (wins ÷ decisive matches): {conditionLabel(story.control ?? "fixed-250").toLowerCase()}, {ahead(story.control ?? "fixed-250")};
              real latency, {ahead(DEFAULT_PUBLIC_CONDITION)}; swapped latency, {ahead(swap)}.{story.tagline && <> {story.tagline}.</>}
              {" "}See the full intervals on the <a href="#/results">results page</a>.
            </p>
          )}
        </Section>

        <Section id="caveats" title="Known caveats">
          <ul className="caveats">
            <li><b>Question wording affects results.</b> Protocol {PROTOCOL_VERSION} puts the one fact each question hinges on into its wording. Without that, one model steered its turret by the hull bearing. Any wording change gets a new protocol version, and results across versions are never merged.</li>
            <li><b>Latency histograms use {binMs} ms bins.</b> Differences smaller than a bin aren’t visible in the charts, although medians and decisions use exact values.</li>
            <li><b>Two places, one pool.</b> The t1 seed matches ran locally from Jesse’s Mac with fixed seeds; site matches run on Cloudflare in eastern North America whenever visitors start them, with whatever load the providers have then. The network paths to OpenRouter differ slightly, so measured latency can shift a little between the two. Every match is tagged with its origin, so the two can always be separated.</li>
            <li><b>Network and provider variance.</b> Latency is measured end to end through OpenRouter, so routing and provider load are part of what is measured. Matches are capped site-wide so that rate limits don’t distort it.</li>
            <li><b>Draws</b> are excluded from win rates and reported separately; small samples have wide intervals.</li>
          </ul>
        </Section>

        <Section id="cost" title="Cost per match">
          {pool ? (
            <>
              <p>
                Each decision is one paid call. The pool’s {n.toLocaleString()} matches used {usd(pool.totalCostUsd)} of model credit in total,
                about {usd(pool.totalCostUsd / Math.max(1, n))} per match.
              </p>
              <div className="costgrid">
                {ag.map((a) => {
                  const r = agentRecord(pool, a.id, DEFAULT_PUBLIC_CONDITION);
                  return (
                    <div key={a.id}>
                      <span>{a.label}</span>
                      <b>{usd(r.costPerMatch)}</b>
                      <small>per match at real latency</small>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p>About $0.003 per match for both models together.</p>
          )}
          <p className="method__small">Matches started from this site are paid from a fixed amount of OpenRouter credit. When it runs out, the arena says it is out of fuel and stops taking new matches; replays and results stay up.</p>
        </Section>

        <Section id="source" title="Source">
          <p>
            The simulation, protocol, engine, analysis and this viewer are open source. Simulation <code>{T.SIM_VERSION}</code> and protocol <code>{PROTOCOL_VERSION}</code> are frozen; changes ship under new versions so stored replays keep working.
          </p>
          <a className="btn btn--primary" href={REPO_URL} target="_blank" rel="noreferrer">
            <GitHubMark /> github.com/jd4d/decision-arena
          </a>
        </Section>
      </article>
      <div className="method__foot"><SiteFooter /></div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`m-${id}`} className="method__sec" aria-labelledby={`m-${id}-h`}>
      <h2 id={`m-${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

function Quote({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="quote">
      <figcaption>{label}</figcaption>
      <blockquote>{children}</blockquote>
    </figure>
  );
}

function QuestionCard({ name, q }: { name: string; q: Question }) {
  const kind = q.type === "choice" ? "pick one" : q.type === "score" ? "probability over levels" : "probability (0–1)";
  return (
    <div className="qcard">
      <div className="qcard__head"><code>{name}</code><span>{q.type} · {kind}</span></div>
      <p className="qcard__text">“{q.instructions}”</p>
      {q.type === "choice" && (
        <ul className="qcard__opts">{Object.entries(q.criteria).map(([k, v]) => <li key={k}><code>{k}</code> {v}</li>)}</ul>
      )}
      {q.type === "score" && <div className="qcard__levels">{q.criteria.map((c) => <span key={c}>{c}</span>)}</div>}
    </div>
  );
}

export function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <path d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2z" />
    </svg>
  );
}

// ---------------------------------------------------------------- latency diagram

const DIAG_MS = 1200;
type DiagramCondition = "scaled-1" | "fixed-250" | "scaled-2";
const DIAGRAM_CONDITIONS: DiagramCondition[] = ["fixed-250", "scaled-1", "scaled-2"];
const LAT: Record<DiagramCondition, (real: number) => number> = { "scaled-1": (r) => r, "fixed-250": () => 250, "scaled-2": (r) => r * 2 };
/** Two lanes of decisions on a game-time axis; switching the condition re-times them. */
function LatencyDiagram() {
  const [cond, setCond] = useState<DiagramCondition>("scaled-1");
  const reals: [number[], number[]] = [[190, 205, 185, 200, 195, 210], [270, 290, 265, 300, 280]];
  const lanes = reals.map((rs) => {
    const out: { from: number; to: number; real: number }[] = [];
    let t = 0;
    for (const r of rs) {
      const eff = (msToTicks(LAT[cond](r)) / T.TICK_HZ) * 1000;
      if (t >= DIAG_MS) break;
      out.push({ from: t, to: Math.min(DIAG_MS, t + eff), real: r });
      t += eff;
    }
    return out;
  });
  const x = (v: number) => `${(v / DIAG_MS) * 100}%`;
  return (
    <figure className="ldiag">
      <div className="ldiag__bar">
        <div className="seg seg--sm" role="radiogroup" aria-label="Illustrated condition">
          {DIAGRAM_CONDITIONS.map((c) => (
            <button key={c} role="radio" aria-checked={cond === c} className={cond === c ? "is-on" : ""} onClick={() => setCond(c)}>{conditionLabel(c)}</button>
          ))}
        </div>
        <span className="ldiag__legend"><i className="ldiag__k ldiag__k--issue" /> state seen <i className="ldiag__k ldiag__k--apply" /> orders land</span>
      </div>
      <div className="ldiag__plot">
        <div className="ldiag__axis" aria-hidden>
          {Array.from({ length: DIAG_MS / 200 + 1 }, (_, i) => (
            <span key={i} style={{ left: x(i * 200) }}>{i * 200} ms</span>
          ))}
        </div>
        {(["Jev", "Microsoft"] as const).map((who, lane) => (
          <div key={who} className={`ldiag__lane ldiag__lane--${lane}`}>
            <span className="ldiag__who">{who}<small>≈ {Math.round(LAT[cond](lane === 0 ? 195 : 280))} ms</small></span>
            <div className="ldiag__track">
              {lanes[lane].map((d, i) => (
                <div key={i} className="ldiag__dec" style={{ left: x(d.from), width: x(d.to - d.from) }}>
                  <i className="ldiag__issue" />
                  {d.to < DIAG_MS && <i className="ldiag__apply" />}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="ldiag__sweep" aria-hidden />
      </div>
      <figcaption>
        Each block is one decision, measured in game time: the model sees the state at its left edge and its orders land at the right edge. Meanwhile the tank keeps running its previous orders. Typical real response times are about 200 ms for Jev and 280 ms for Microsoft.
      </figcaption>
    </figure>
  );
}
