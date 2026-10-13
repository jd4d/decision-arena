// Event-driven game clock. Each agent has at most one decision in flight. A decision requested at tick T is
// applied at T + effective latency (in ticks); orders persist until then. The engine waits for real responses
// before stepping past a tick whose apply time is still unknown, so results match real-time play exactly
// without depending on harness timing.
import type { Agent, DecisionResult } from "../agents/types.ts";
import { observe } from "../sim/observe.ts";
import { ROUND_TICKS, SIM_VERSION, TICK_HZ } from "../sim/tuning.ts";
import { checksum, createWorld, setOrders, step } from "../sim/world.ts";
import { CURRENT_PROTOCOL } from "../protocol/v2.ts";
import { LOG_VERSION, type DecisionRec, type HeaderRec, type LogRec, type ResultRec, type SlotStats } from "./log.ts";
import { conditionName, ERROR_MIN_MS, makeLatencyFn, msToTicks, type LatencyMode } from "./latency.ts";

export type Budget = { spent: number; hardCap: number };

export type MatchSpec = {
  runId: string;
  matchId: string;
  map: string;
  seed: number;
  latency: LatencyMode;
  condition?: string;
  agents: [Agent, Agent];
};

type Pending = {
  n: number;
  issueTick: number;
  issuedAt: number; // wall clock (performance.now) when requested
  known: boolean; // applyTick is determined (response arrived)
  done: boolean; // result may be applied (after any error back-off)
  promise: Promise<void>;
  res?: DecisionResult;
  applyTick?: number;
  effMs?: number;
  preMs?: number; // resampled latency drawn at request time
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** Live-streaming hook: called after every simulated tick. Every decision applying at or before `tick` has already been emitted. */
export type TickInfo = { tick: number; inflight: [{ issueTick: number } | null, { issueTick: number } | null] };

export async function runMatch(
  spec: MatchSpec,
  opts: { budget?: Budget; onRecord?: (r: LogRec) => void; onTick?: (info: TickInfo) => void | Promise<void> } = {},
): Promise<{ records: LogRec[]; result: ResultRec }> {
  const t0 = performance.now();
  const records: LogRec[] = [];
  const emit = (r: LogRec) => { records.push(r); opts.onRecord?.(r); };
  // Model agents carry the protocol label they decode with; both sides must agree. Bot-only matches use the live label.
  const labels = [...new Set(spec.agents.map((a) => a.info.protocol).filter((p): p is string => !!p))];
  if (labels.length > 1) throw new Error(`agents disagree on protocol: ${labels.join(", ")}`);
  const header: HeaderRec = {
    k: "header", v: LOG_VERSION, runId: spec.runId, matchId: spec.matchId, condition: spec.condition ?? conditionName(spec.latency),
    createdAt: new Date().toISOString(), sim: SIM_VERSION, protocol: labels[0] ?? CURRENT_PROTOCOL, map: spec.map, seed: spec.seed,
    tickHz: TICK_HZ, roundTicks: ROUND_TICKS, latency: spec.latency,
    agents: spec.agents.map((a, i) => ({ ...a.info, slot: i as 0 | 1 })),
  };
  emit(header);

  const w = createWorld(spec.map, spec.seed);
  const latencyOf = makeLatencyFn(spec.latency, spec.seed);
  const pending: [Pending | null, Pending | null] = [null, null];
  const seq = [0, 0];
  const decisions: DecisionRec[][] = [[], []];
  let aborted = false;

  const issue = (slot: 0 | 1) => {
    const obs = observe(w, slot);
    const p: Pending = { n: seq[slot]++, issueTick: w.tick, issuedAt: performance.now(), known: false, done: false, promise: Promise.resolve(), preMs: latencyOf.draw?.(slot) };
    p.promise = (async () => {
      let res: DecisionResult;
      try { res = await spec.agents[slot].decide(obs); }
      catch (e) { res = { action: null, realMs: 0, error: (e as Error).message }; }
      p.res = res;
      p.effMs = latencyOf(slot, res.realMs, !!res.error, p.preMs);
      p.applyTick = p.issueTick + msToTicks(p.effMs);
      p.known = true;
      if (res.cost && opts.budget) opts.budget.spent += res.cost;
      if (res.error) await sleep(ERROR_MIN_MS); // back off a little in real time too
      p.done = true;
    })();
    pending[slot] = p;
  };

  /**
   * Earliest tick at which a still-unanswered decision could possibly apply. The game may run every tick strictly
   * before it without knowing the answer. This lets game time flow in parallel with in-flight requests (live play
   * runs at real speed) while producing exactly the same results as waiting for every answer up front.
   * scaled: an answer not yet back after E ms has realMs > E, so effMs >= E*factor (error floors only raise it).
   * fixed: effMs is ms (or max(ms, ERROR_MIN_MS) on error), known in advance. resampled: drawn when requested, so also known.
   */
  const lat = spec.latency;
  const minApplyTick = (p: Pending, now: number): number => {
    if (p.known) return p.applyTick!;
    if (lat.mode === "scaled") return p.issueTick + msToTicks(Math.max(0, now - p.issuedAt) * lat.factor);
    if (lat.mode === "fixed") return p.issueTick + msToTicks(lat.ms); // error only raises it to max(ms, ERROR_MIN_MS)
    return p.issueTick + (p.preMs !== undefined ? msToTicks(p.preMs) : 1); // resampled: drawn at request time (error only raises it)
  };
  /** ms until minApplyTick(p) would exceed `tick` (scaled only); otherwise wait for the answer. */
  const msUntilPast = (p: Pending, tick: number, now: number): number | null => {
    if (lat.mode !== "scaled" || lat.factor <= 0) return null;
    const needMs = ((tick - p.issueTick) * 1000) / (TICK_HZ * lat.factor);
    return Math.max(1, needMs - (now - p.issuedAt) + 0.5);
  };

  const applyPending = (slot: 0 | 1, p: Pending) => {
    const r = p.res!;
    if (r.action) setOrders(w, slot, r.action);
    const rec: DecisionRec = {
      k: "decision", slot, n: p.n, issueTick: p.issueTick, applyTick: p.applyTick!, realMs: Math.round(r.realMs), effMs: Math.round(p.effMs!),
      action: r.action, detail: r.detail, cost: r.cost, tokens: r.tokens, provider: r.provider, error: r.error,
    };
    decisions[slot].push(rec);
    emit(rec);
    pending[slot] = null;
  };

  while (!w.over) {
    // 1) Apply decisions that land on this tick.
    for (const slot of [0, 1] as const) {
      const p = pending[slot];
      if (p?.done && p.applyTick === w.tick) applyPending(slot, p);
    }
    if (opts.budget && opts.budget.spent > opts.budget.hardCap) { aborted = true; break; }
    // 2) Idle agents request a new decision from the current state.
    for (const slot of [0, 1] as const) if (!pending[slot]) issue(slot);
    // 3) Before simulating this tick, make sure no in-flight decision could still apply at it (or must apply now).
    while (true) {
      const now = performance.now();
      const blockers = pending.filter((p): p is Pending => !!p && (p.known ? p.applyTick! <= w.tick && !p.done : minApplyTick(p, now) <= w.tick));
      if (!blockers.length) break;
      const waits: Promise<unknown>[] = blockers.map((p) => p.promise);
      const timers = blockers.filter((p) => !p.known).map((p) => msUntilPast(p, w.tick, now)).filter((x): x is number => x !== null);
      if (timers.length) waits.push(sleep(Math.min(...timers)));
      await Promise.race(waits);
    }
    // A decision may have become applicable while waiting: apply it before stepping.
    for (const slot of [0, 1] as const) {
      const p = pending[slot];
      if (p?.done && p.applyTick === w.tick) { applyPending(slot, p); if (!pending[slot]) issue(slot); }
    }
    // 4) Advance one tick.
    step(w);
    for (const e of w.events) emit({ k: "event", ...e });
    if (w.tick % TICK_HZ === 0 || w.over) emit({ k: "check", t: w.tick, sum: checksum(w) });
    if (opts.onTick) await opts.onTick({ tick: w.tick, inflight: [pending[0] ? { issueTick: pending[0].issueTick } : null, pending[1] ? { issueTick: pending[1].issueTick } : null] });
  }
  // Let stragglers finish so their cost is counted (not applied: the match is over).
  await Promise.all(pending.filter(Boolean).map((p) => p!.promise));

  const events = records.filter((r) => r.k === "event") as Extract<LogRec, { k: "event" }>[];
  const stats = ([0, 1] as const).map((slot): SlotStats => {
    const ds = decisions[slot];
    const lat = ds.filter((d) => !d.error).map((d) => d.realMs);
    const hits = events.filter((e) => e.type === "hit" && e.owner === slot && !e.self);
    const extra = pending[slot]?.res?.cost ?? 0;
    return {
      decisions: ds.length,
      errors: ds.filter((d) => d.error).length,
      shots: events.filter((e) => e.type === "fire" && e.slot === slot).length,
      fizzles: events.filter((e) => e.type === "fizzle" && e.slot === slot).length,
      hits: hits.length,
      selfHits: events.filter((e) => e.type === "hit" && e.owner === slot && e.self).length,
      damageTaken: events.filter((e) => e.type === "hit" && e.victim === slot).length,
      cost: ds.reduce((s, d) => s + (d.cost ?? 0), 0) + extra,
      latencyMs: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), mean: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0, max: lat.length ? Math.max(...lat) : 0 },
      firstHitTick: hits[0]?.t ?? null,
    };
  }) as [SlotStats, SlotStats];
  const end = events.find((e) => e.type === "end");
  const result: ResultRec = {
    k: "result",
    winner: aborted ? null : w.winner,
    reason: aborted ? "aborted" : end && end.type === "end" ? end.reason : "time",
    ticks: w.tick,
    hp: [w.tanks[0].hp, w.tanks[1].hp],
    stats,
    wallMs: Math.round(performance.now() - t0),
  };
  emit(result);
  return { records, result };
}
