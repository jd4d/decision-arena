// How the arena works. Rules, protocol wording and constants are imported from the code that runs the matches,
// so this page can't drift from what the models actually receive.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DEFAULT_PUBLIC_CONDITION, DEFAULT_PUBLIC_DECODER, PUBLIC_CONDITIONS, PUBLIC_DECODERS, type PublicCondition, type PublicDecoder } from "../../api/contract.ts";
import { buildQuestions, encodeState, PROTOCOL_VERSION, SCALED_FIRE_BAR, TURRET_LEVELS, type Question } from "../../protocol/v2.ts";
import { msToTicks } from "../../runner/latency.ts";
import { MAPS } from "../../sim/maps.ts";
import { observe } from "../../sim/observe.ts";
import * as T from "../../sim/tuning.ts";
import { createWorld, setOrders, step } from "../../sim/world.ts";
import { SiteFooter, REPO_URL } from "../home/HomePage.tsx";
import { p2Pools, pooledRecord, type VersionPool } from "../lib/pools.ts";
import { useAsync } from "../lib/data.ts";
import { conditionLabel, ms, pct, usd } from "../lib/format.ts";
import { agentRecord, shortName, totalMatches } from "../lib/summary.ts";
import { canonicalOrder } from "../lib/theme.ts";

const SECTIONS: [string, string][] = [
  ["pillars", "Design pillars"],
  ["game", "The game"],
  ["latency", "Latency becomes game time"],
  ["protocol", "The protocol"],
  ["methods", "Answer methods"],
  ["conditions", "Latency rules"],
  ["pool", "One pool per method"],
  ["speed", "Why speed matters"],
  ["caveats", "Known caveats"],
  ["cost", "Cost per match"],
  ["patch-notes", "Patch notes"],
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
  // p2 results, one summary per answer method. Sections that show pool numbers pool or compare them; never merged.
  const poolsA = useAsync(() => p2Pools().catch(() => [] as VersionPool[]), []);
  const pools = poolsA.status === "ready" ? poolsA.data : [];
  const pool = pools[0]?.s ?? null; // for shape-only facts (agents, histogram bins)
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

  const ag = canonicalOrder(pool?.agents ?? [{ id: "jev", label: "Jev 1.13" }, { id: "msd1", label: "Microsoft Decision 1" }]);
  const binMs = pool ? Object.values(pool.latencyHistogram)[0]?.binMs ?? 25 : 25;
  const n = pools.reduce((t, p) => t + totalMatches(p.s), 0);
  const totalCost = pools.reduce((t, p) => t + p.s.totalCostUsd, 0);
  const EQUAL = "fixed-250";
  /** Win rate (wins ÷ decisive) of an agent in one method's pool under one rule, as "56%" or "—". */
  const wr = (p: VersionPool, id: string, c: string) => { const r = agentRecord(p.s, id, c).winRate; return r ? pct(r.p) : "—"; };

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

        <Section id="pillars" title="Design pillars">
          <p>The arena is built to expose weaknesses in decision models, not to paper over them. Every rule below follows from four pillars.</p>
          <ol className="facts">
            <li><b>Same game, same question.</b> Both models get byte-identical state and questions in one call, with the same seeds, maps and endpoint.</li>
            <li><b>Answers are taken at face value.</b> A model’s probabilities decide what its tank does, under either of the two answer methods. Nothing is repaired, grouped or averaged, so high confidence in the right move plays best, while hedging and confident mistakes cost.</li>
            <li><b>Facts, not instructions.</b> Questions state facts that agree with the state and with the moment the answer lands. No hint points a model at a particular move.</li>
            <li><b>Speed is reported separately.</b> Real latency is the arena as intended; equal latency removes speed so only the decisions differ.</li>
          </ol>
        </Section>

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
            <i> T + effective latency</i>. Until then its tank keeps driving on its last orders, and the enemy keeps moving. Turret turns and
            turns in place are single steps that finish before the next answer can land, so each question already describes the turret as it
            will be once its current step is done. As soon as an
            answer lands, the next question is asked. In replays, the dashed <em>ghost</em> shows the enemy where the model last saw it.
          </p>
          <LatencyDiagram />
          <p className="method__small">
            Ticks are whole: {ms(250)} becomes {msToTicks(250)} ticks ({((msToTicks(250) / T.TICK_HZ) * 1000).toFixed(0)} ms). Game time runs with the clock while models think, but it never passes a tick where an unanswered decision could still land, so results are exact without depending on server timing. When a model answers slower than a fixed delay, a live match briefly slows down to wait for it.
          </p>
        </Section>

        <Section id="protocol" title={`The protocol (${PROTOCOL_VERSION})`}>
          <p>
            Both models get the same state and the same three questions through the same OpenRouter decisions endpoint. The state has full information: the map's walls, both tanks' positions, headings, speeds and reload, and every shell in flight. It also includes the egocentric facts each question depends on (where the enemy is relative to the hull and turret) and a shot trace computed with the game's own shell physics, which says whether a shell fired now would hit directly, hit after one bounce, bounce back into the shooter, or miss. Here is a real mid-fight example, generated by the protocol code:
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
          <p>
            Each answer is a set of probabilities: one per drive option, one per turret step ({TURRET_LEVELS.join(", ")}) and one for firing.
            How those probabilities become the tank’s action is the <a href="#/methodology/methods">answer method</a>, described next.
          </p>
        </Section>

        <Section id="methods" title="Answer methods">
          <p>
            p2 runs two answer methods side by side. Both models always play under the same method, they get the same state and questions under
            either one, and each method keeps its own results: you pick one when starting a match, and switch between them on the results page.
            Both follow the second pillar: the model’s own probabilities decide, with nothing grouped, averaged or repaired. They differ in
            <i> how</i> uncertainty costs.
          </p>
          <div className="methodtable" role="table" aria-label="The two answer methods">
            <div role="row" className="methodtable__head"><span role="columnheader" />{(["draw", "scaled"] as PublicDecoder[]).map((d) => <b key={d} role="columnheader">{PUBLIC_DECODERS[d].label}{d === DEFAULT_PUBLIC_DECODER ? " · default" : ""}</b>)}</div>
            <div role="row"><span role="rowheader">Driving</span><span data-label={PUBLIC_DECODERS.draw.label}>Draws one option in proportion to its probability: 60% forward drives forward 60% of the time.</span><span data-label={PUBLIC_DECODERS.scaled.label}>Takes the top option and scales it by its probability: 60% forward drives at 60% speed; a 30° turn in place becomes 18°.</span></div>
            <div role="row"><span role="rowheader">Turret</span><span data-label={PUBLIC_DECODERS.draw.label}>Draws one step the same way.</span><span data-label={PUBLIC_DECODERS.scaled.label}>The top step times its probability: 70% on “10° left” turns 7° left.</span></div>
            <div role="row"><span role="rowheader">Firing</span><span data-label={PUBLIC_DECODERS.draw.label}>Fires with probability p.</span><span data-label={PUBLIC_DECODERS.scaled.label}>Fires when p is at least {Math.round(SCALED_FIRE_BAR * 100)}%.</span></div>
            <div role="row"><span role="rowheader">Hedging costs</span><span data-label={PUBLIC_DECODERS.draw.label}>Randomly: a hedging model sometimes plays its other guesses, including bad ones.</span><span data-label={PUBLIC_DECODERS.scaled.label}>Steadily: a hedging model always plays its top guess, but timidly.</span></div>
            <div role="row"><span role="rowheader">Repeatable</span><span data-label={PUBLIC_DECODERS.draw.label}>Yes. Each draw is seeded from the game state, so the same answers to the same state always give the same action, whichever model answered.</span><span data-label={PUBLIC_DECODERS.scaled.label}>Yes. No randomness.</span></div>
          </div>
          {pools.length > 0 && (
            <>
              <div className="methodtable methodtable--results" role="table" aria-label="Results by answer method">
                <div role="row" className="methodtable__head"><span role="columnheader" />{[EQUAL, DEFAULT_PUBLIC_CONDITION].map((c) => <b key={c} role="columnheader">{conditionLabel(c)}</b>)}</div>
                {pools.map((p) => (
                  <div key={p.id} role="row">
                    <span role="rowheader">{p.label}</span>
                    {[EQUAL, DEFAULT_PUBLIC_CONDITION].map((c) => (
                      <span key={c} data-label={conditionLabel(c)}>{ag.map((a) => `${shortName(a.label)} ${wr(p, a.id, c)}`).join(" · ")} <small>({totalMatches(p.s, c).toLocaleString()} matches)</small></span>
                    ))}
                  </div>
                ))}
              </div>
              <p className="method__small">
                Win rates are wins ÷ decisive matches. The same models score differently under the two methods because they answer with
                different confidence: a model that spreads its probability is hurt more by the weighted draw. Full intervals are on the <a href="#/results">results page</a>.
              </p>
            </>
          )}
        </Section>

        <Section id="conditions" title="Latency rules">
          <p>
            <b>Real latency</b> is the arena as intended: each model’s measured response time becomes game time. Equal latency
            is the experiment behind the results: it separates decision quality from speed. When starting a match you pick a rule (or leave it on
            Random, the default, which draws one of the two with equal odds) and an answer method.
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
        </Section>

        <Section id="pool" title="One pool per method">
          <p>
            Every match lands in the pool for its protocol and answer method, and every result on this site is computed from those pools. Results from
            different versions are never merged. Each p2 answer method started with the same seed tournament: real and equal latency on every map,
            25 seeds, both sides, run locally from Jesse’s Mac. Every match run from this site, on Cloudflare in eastern North America, adds to its
            method’s pool.{pools.length > 0 && <> The p2 pools hold {n.toLocaleString()} matches now ({pools.map((p) => `${p.label.toLowerCase()} ${totalMatches(p.s).toLocaleString()}`).join(", ")}).</>}
          </p>
          <p className="method__small">
            Every match records where it ran: seed matches carry a <span className="prov">seed</span> tag in the match list and replays. The two places reach
            OpenRouter over slightly different network paths, so their measured latencies can differ a little (see the caveats).
          </p>
        </Section>

        <Section id="speed" title="Why speed matters">
          <p>
            A tank at full speed covers {T.TANK_SPEED} m per second. At {ms(280)} of latency the enemy has moved about {(T.TANK_SPEED * 0.28).toFixed(1)} m
            (about half a tank length) before the order lands, and a shell needs {((T.ARENA_W / 2) / T.SHELL_SPEED).toFixed(1)} s to cross half the arena.
            A better decision that arrives late can lose to a worse one that arrives early.
          </p>
          {pools.length > 0 && (
            <div className="speedcmp">
              {[EQUAL, DEFAULT_PUBLIC_CONDITION].map((c) => (
                <div key={c} className="speedcmp__col">
                  <div className="speedcmp__h">{conditionLabel(c)} · all p2 matches</div>
                  {ag.map((a, i) => {
                    const r = pooledRecord(pools, a.id, c).winRate;
                    return (
                      <div key={a.id} className={`speedcmp__bar speedcmp__bar--${i}`}>
                        <span>{a.label}</span>
                        <i style={{ "--w": r ? r.p : 0 } as CSSProperties} />
                        <b>{r ? pct(r.p) : "—"}</b>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {pools.length > 0 && (
            <p className="method__small">
              Win rates pooled over both answer methods (wins ÷ decisive matches). By method:{" "}
              {pools.map((p) => `${p.label.toLowerCase()}, ${ag.map((a) => `${shortName(a.label)} ${wr(p, a.id, EQUAL)}`).join(" / ")} at equal latency and ${ag.map((a) => `${shortName(a.label)} ${wr(p, a.id, DEFAULT_PUBLIC_CONDITION)}`).join(" / ")} at real latency`).join("; ")}.
              {" "}See the full intervals on the <a href="#/results">results page</a>.
            </p>
          )}
        </Section>

        <Section id="caveats" title="Known caveats">
          <ul className="caveats">
            <li><b>Question wording affects results.</b> Models act on the facts in each question far more than on the state. In p1, one model steered its turret by the hull bearing until the turret fact moved into the question; in p2, an always-on bank-shot hint in the state pulled one model’s turret away from the enemy a quarter of the time until it was limited to shots behind cover. Any wording change gets a new protocol version, and results across versions are never merged.</li>
            <li><b>The answer method changes the results.</b> The same answers play differently under the weighted draw and confidence-scaled, so win rates differ between the two methods. Neither is the “real” score: each measures something slightly different about a model’s confidence, which is why both are kept and shown separately.</li>
            <li><b>Shells collide.</b> A shell that touches another shell destroys both, so two tanks aiming straight at each other often cancel each other’s shots. That lengthens matches and lowers hit rates for both models equally.</li>
            <li><b>Walls stop tanks, and the drive question doesn’t mention them.</b> Tanks spend about a tenth of their driving time pressed against a wall. The rules and the dodge check know about walls; the drive question does not say which options would hit one.</li>
            <li><b>Latency histograms use {binMs} ms bins.</b> Differences smaller than a bin aren’t visible in the charts, although medians and decisions use exact values.</li>
            <li><b>Two places, one pool.</b> Seed matches ran locally from Jesse’s Mac with fixed seeds; site matches run on Cloudflare in eastern North America whenever visitors start them, with whatever load the providers have then. The network paths to OpenRouter differ slightly, so measured latency can shift a little between the two. Every match is tagged with its origin, so the two can always be separated.</li>
            <li><b>Network and provider variance.</b> Latency is measured end to end through OpenRouter, so routing and provider load are part of what is measured. Matches are capped site-wide so that rate limits don’t distort it.</li>
            <li><b>Draws</b> are excluded from win rates and reported separately; small samples have wide intervals.</li>
          </ul>
        </Section>

        <Section id="cost" title="Cost per match">
          {pools.length > 0 ? (
            <>
              <p>
                Each decision is one paid call. The p2 pools’ {n.toLocaleString()} matches used {usd(totalCost)} of model credit in total,
                about {usd(totalCost / Math.max(1, n))} per match. The answer method doesn’t change the calls, only how answers are used.
              </p>
              <div className="costgrid">
                {ag.map((a) => {
                  const rs = pools.map((p) => agentRecord(p.s, a.id, DEFAULT_PUBLIC_CONDITION)).filter((r) => r.matches > 0 && Number.isFinite(r.costPerMatch));
                  const m = rs.reduce((t, r) => t + r.matches, 0);
                  const cpm = m ? rs.reduce((t, r) => t + r.costPerMatch * r.matches, 0) / m : NaN;
                  return (
                    <div key={a.id}>
                      <span>{a.label}</span>
                      <b>{usd(cpm)}</b>
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

        <Section id="patch-notes" title="Patch notes">
          <p>Each protocol version changes what the models see or how their answers become actions, so results from different versions are kept separate. Pick a version on the <a href="#/results">results page</a>.</p>
          <h3 className="method__h3">p2 (simulation sim-3)</h3>
          <ul className="facts facts--tight">
            <li><b>Full information.</b> The state now has the map’s walls, both tanks’ positions, headings, speeds and reload, and every shell in flight, alongside p1’s egocentric facts.</li>
            <li><b>Shot check with bounces.</b> “A shot fired now would…” is traced with the game’s own shell physics: hit directly, hit after one bounce, bounce back into you, or miss. When a wall blocks the direct line, the turret question also gives the nearest bank shot.</li>
            <li><b>Turret in steps.</b> Each turret order is one step of {TURRET_LEVELS.slice(TURRET_LEVELS.indexOf("hold") + 1).map((l) => l.split(" ")[0]).join(", ")} left or right instead of a speed that runs until the next answer. The turret is stabilised: turning the hull no longer drags the aim. Questions assume the current step has finished.</li>
            <li><b>Driving.</b> Forward, curves and reverse keep going until the next answer; turning in place is a single 30° step. The enemy counts as “ahead” within 15°, half a turn step.</li>
            <li><b>Dodging.</b> The drive question says which drive options a shell already in flight would hit, worked out by playing the game forward.</li>
            <li><b>No orders echo.</b> p1 showed each tank its own current orders, and models anchored on repeating them. p2 shows only the hull’s course.</li>
            <li><b>Answers at face value, two ways.</b> p1 took the top drive option, averaged the turret answer and fired at p ≥ 0.5, which forgave hedging. p2 uses the model’s probabilities directly under one of two <a href="#/methodology/methods">answer methods</a>, picked per match and reported separately: a weighted draw (an option given 70% happens 70% of the time) and confidence-scaled (the top option, scaled by its probability).</li>
            <li><b>Two latency rules.</b> Real latency and equal latency (250 ms each). The scaled and swapped rules are gone.</li>
          </ul>
          <h3 className="method__h3">p1 (simulation sim-2)</h3>
          <ul className="facts facts--tight">
            <li>Egocentric facts only (enemy distance and direction, four wall distances), orders that ran until the next answer, and six latency rules.</li>
          </ul>
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
type DiagramCondition = "scaled-1" | "fixed-250";
const DIAGRAM_CONDITIONS: DiagramCondition[] = ["scaled-1", "fixed-250"];
/** Game-time latency of a decision: the model's own real time, or a flat 250 ms. */
const LAT: Record<DiagramCondition, (own: number) => number> = { "scaled-1": (r) => r, "fixed-250": () => 250 };
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
        Each block is one decision, measured in game time: the model sees the state at its left edge and its orders land at the right edge. Meanwhile the tank keeps driving on its last orders; turret turns and turns in place are single steps, so slower decisions mean fewer aiming corrections. Typical real response times are about 200 ms for Jev and 280 ms for Microsoft.
      </figcaption>
    </figure>
  );
}
