// Event-driven game clock. Each agent has at most one decision in flight. A decision requested at tick T is
// applied at T + effective latency (in ticks); orders persist until then. The engine waits for real responses
// before stepping past a tick whose apply time is still unknown, so results match real-time play exactly
// without depending on harness timing.
import type { Agent, DecisionResult } from "../agents/types.ts";
import { observe } from "../sim/observe.ts";
import { ROUND_TICKS, SIM_VERSION, TICK_HZ } from "../sim/tuning.ts";
import { checksum, createWorld, setOrders, step } from "../sim/world.ts";
import { PROTOCOL_VERSION } from "../protocol/v1.ts";
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

type Pending = { n: number; issueTick: number; done: boolean; promise: Promise<void>; res?: DecisionResult; applyTick?: number; effMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export async function runMatch(spec: MatchSpec, opts: { budget?: Budget; onRecord?: (r: LogRec) => void } = {}): Promise<{ records: LogRec[]; result: ResultRec }> {
  const t0 = performance.now();
  const records: LogRec[] = [];
  const emit = (r: LogRec) => { records.push(r); opts.onRecord?.(r); };
  const header: HeaderRec = {
    k: "header", v: LOG_VERSION, runId: spec.runId, matchId: spec.matchId, condition: spec.condition ?? conditionName(spec.latency),
    createdAt: new Date().toISOString(), sim: SIM_VERSION, protocol: PROTOCOL_VERSION, map: spec.map, seed: spec.seed,
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
    const p: Pending = { n: seq[slot]++, issueTick: w.tick, done: false, promise: Promise.resolve() };
    p.promise = (async () => {
      let res: DecisionResult;
      try { res = await spec.agents[slot].decide(obs); }
      catch (e) { res = { action: null, realMs: 0, error: (e as Error).message }; }
      if (res.error) await sleep(ERROR_MIN_MS); // back off a little in real time too
      p.res = res;
      p.effMs = latencyOf(slot, res.realMs, !!res.error);
      p.applyTick = p.issueTick + msToTicks(p.effMs);
      p.done = true;
      if (res.cost && opts.budget) opts.budget.spent += res.cost;
    })();
    pending[slot] = p;
  };

  while (!w.over) {
    // 1) Apply decisions that land on this tick.
    for (const slot of [0, 1] as const) {
      const p = pending[slot];
      if (p?.done && p.applyTick === w.tick) {
        const r = p.res!;
        if (r.action) setOrders(w, slot, r.action);
        const rec: DecisionRec = {
          k: "decision", slot, n: p.n, issueTick: p.issueTick, applyTick: p.applyTick, realMs: Math.round(r.realMs), effMs: Math.round(p.effMs!),
          action: r.action, detail: r.detail, cost: r.cost, tokens: r.tokens, provider: r.provider, error: r.error,
        };
        decisions[slot].push(rec);
        emit(rec);
        pending[slot] = null;
      }
    }
    if (opts.budget && opts.budget.spent > opts.budget.hardCap) { aborted = true; break; }
    // 2) Idle agents request a new decision from the current state.
    for (const slot of [0, 1] as const) if (!pending[slot]) issue(slot);
    // 3) Make sure every in-flight decision has a known apply tick before time advances.
    const waiting = pending.filter((p) => p && !p.done).map((p) => p!.promise);
    if (waiting.length) await Promise.all(waiting);
    // 4) Advance one tick.
    step(w);
    for (const e of w.events) emit({ k: "event", ...e });
    if (w.tick % TICK_HZ === 0 || w.over) emit({ k: "check", t: w.tick, sum: checksum(w) });
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
