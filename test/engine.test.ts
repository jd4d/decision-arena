import test from "node:test";
import assert from "node:assert/strict";
import { runMatch, type Budget, type MatchSpec } from "../src/runner/engine.ts";
import { createReplay } from "../src/runner/replay.ts";
import { ERROR_MIN_MS, msToTicks, type LatencyMode } from "../src/runner/latency.ts";
import type { DecisionRec, EventRec, LogRec } from "../src/runner/log.ts";
import { scriptedBot, randomBot } from "../src/agents/bots.ts";
import type { Agent, DecisionResult } from "../src/agents/types.ts";
import type { Observation } from "../src/sim/observe.ts";
import { MAPS } from "../src/sim/maps.ts";
import { ROUND_TICKS, TANK_HP, TICK_HZ } from "../src/sim/tuning.ts";
import type { Action } from "../src/sim/types.ts";

const mapIds = Object.keys(MAPS);
const IDLE: Action = { drive: "stop", turret: 0, fire: false };

type Fake = Agent & { obs: Observation[]; maxInFlight: number };
/** Fake agent: `script(n, obs)` returns the n-th result. Tracks observations and concurrent in-flight calls. */
function fake(id: string, script: (n: number, o: Observation) => DecisionResult): Fake {
  let n = 0, inFlight = 0;
  const a: Fake = {
    info: { id, label: id, kind: "bot" },
    obs: [],
    maxInFlight: 0,
    async decide(o) {
      a.obs.push(o);
      a.maxInFlight = Math.max(a.maxInFlight, ++inFlight);
      await Promise.resolve();
      try { return script(n++, o); } finally { inFlight--; }
    },
  };
  return a;
}
const idle = (id = "idle", realMs = 100) => fake(id, () => ({ action: { ...IDLE }, realMs }));

function spec(agents: [Agent, Agent], over: Partial<MatchSpec> = {}): MatchSpec {
  return { runId: "t", matchId: "m", map: mapIds[0], seed: 1, latency: { mode: "scaled", factor: 1 }, agents, ...over };
}
const decisions = (r: LogRec[], slot?: 0 | 1) => r.filter((x): x is DecisionRec => x.k === "decision" && (slot === undefined || x.slot === slot));
const events = (r: LogRec[]) => r.filter((x): x is EventRec => x.k === "event");
/** Strip wall-clock fields so two runs compare equal. */
const stable = (r: LogRec[]) => r.map((x) => (x.k === "header" ? { ...x, createdAt: "" } : x.k === "result" ? { ...x, wallMs: 0 } : x));

// ---------- Determinism & replay ----------

test("identical (map, seed, agents) produce identical logs and checksums", async () => {
  for (const map of mapIds) {
    const run = () => runMatch(spec([scriptedBot({ thinkMs: 150 }), randomBot({ thinkMs: 220 })], { map, seed: 3 }));
    const a = await run(), b = await run();
    assert.deepEqual(stable(a.records), stable(b.records));
    assert.ok(a.records.filter((r) => r.k === "check").length > 0);
  }
});

function assertReplays(records: LogRec[], ctx: string) {
  const rp = createReplay(records);
  assert.ok(rp.checks.size > 0);
  while (rp.advance());
  assert.deepEqual(rp.mismatches, [], `${ctx}: checksum mismatches`);
  assert.equal(rp.world.tick, rp.result!.ticks, ctx);
  assert.deepEqual([rp.world.tanks[0].hp, rp.world.tanks[1].hp], rp.result!.hp, ctx);
  assert.equal(rp.world.winner, rp.result!.winner, ctx);
  // seek backwards then forwards re-simulates to the same state
  rp.seek(Math.floor(rp.result!.ticks / 2));
  rp.seek(rp.result!.ticks);
  assert.deepEqual(rp.mismatches, [], `${ctx}: mismatches after seek`);
}

test("replay re-simulates bot matches with zero mismatches on all maps and several seeds", async () => {
  for (const map of mapIds) {
    for (const seed of [1, 2, 3, 4]) {
      const { records } = await runMatch(spec([scriptedBot({ thinkMs: 120 }), scriptedBot({ thinkMs: 300, seed: 5 })], { map, seed }));
      assertReplays(records, `${map}/${seed}`);
      const rnd = await runMatch(spec([randomBot({ seed }), scriptedBot()], { map, seed, latency: { mode: "fixed", ms: 150 } }));
      assertReplays(rnd.records, `${map}/${seed}/random`);
    }
  }
});

test("replay covers matches ending by time limit and by destruction", async () => {
  const t = await runMatch(spec([idle("a"), idle("b")]));
  assert.equal(t.result.reason, "time");
  assert.equal(t.result.ticks, ROUND_TICKS);
  assertReplays(t.records, "time");

  // A scripted bot against a stationary target should score kills; search a bounded set of maps/seeds.
  let found: Awaited<ReturnType<typeof runMatch>> | undefined;
  for (const map of mapIds) {
    for (let seed = 1; seed <= 6 && !found; seed++) {
      const r = await runMatch(spec([scriptedBot({ thinkMs: 60 }), idle("target", 100)], { map, seed, latency: { mode: "fixed", ms: 60 } }));
      if (r.result.reason === "destroyed") found = r;
    }
    if (found) break;
  }
  assert.ok(found, "no scripted-vs-idle match ended by destruction on any map/seed 1-6");
  assert.equal(found.result.winner, 0);
  assert.ok(found.result.ticks < ROUND_TICKS);
  assertReplays(found.records, "destroyed");
});

// ---------- Decision timing ----------

test("decisions apply at issueTick + max(1, ceil(ms*30/1000))", async () => {
  for (const ms of [0, 1, 20, 33, 34, 100, 250, 999, 1000]) {
    const a = idle("a", ms), b = idle("b", ms * 2 + 7);
    const { records } = await runMatch(spec([a, b]));
    for (const slot of [0, 1] as const) {
      const real = slot === 0 ? ms : ms * 2 + 7;
      const expected = Math.max(1, Math.ceil((real * TICK_HZ) / 1000));
      assert.equal(expected, msToTicks(real));
      const ds = decisions(records, slot);
      assert.ok(ds.length >= 1);
      for (const d of ds) assert.equal(d.applyTick - d.issueTick, expected, `slot ${slot} ms ${real}`);
    }
  }
});

test("orders persist between decisions; each slot has at most one decision in flight", async () => {
  const A: Action = { drive: "forward", turret: 0.5, fire: false };
  const B: Action = { drive: "reverse", turret: -0.25, fire: false };
  const a = fake("a", (n) => ({ action: n === 0 ? A : n === 1 ? B : { ...B }, realMs: 200 }));
  const b = idle("b", 100);
  const { records } = await runMatch(spec([a, b]));
  assert.equal(a.maxInFlight, 1);
  assert.equal(b.maxInFlight, 1);
  // First observation: idle orders; second sees A (applied), third sees B.
  assert.deepEqual(a.obs[0].self.orders, IDLE);
  assert.deepEqual(a.obs[1].self.orders, A);
  assert.deepEqual(a.obs[2].self.orders, B);
  for (const slot of [0, 1] as const) {
    const ds = decisions(records, slot);
    ds.forEach((d, i) => {
      assert.equal(d.n, i);
      if (i === 0) assert.equal(d.issueTick, 0);
      else {
        // next decision is requested the moment the previous one lands: never overlapping, never idle
        assert.equal(d.issueTick, ds[i - 1].applyTick);
      }
    });
  }
  // Observation ticks agree with log issueTicks.
  assert.deepEqual(a.obs.slice(0, decisions(records, 0).length).map((o) => o.tick), decisions(records, 0).map((d) => d.issueTick));
});

test("a slow slot does not stall or reorder the fast slot's decisions", async () => {
  const slow = idle("slow", 1500), fast = idle("fast", 100);
  const { records } = await runMatch(spec([slow, fast]));
  assert.ok(decisions(records, 1).length > decisions(records, 0).length * 5);
  assert.equal(slow.maxInFlight, 1);
  assert.equal(fast.maxInFlight, 1);
});

test("latency modes: scaled factor 2 doubles delay; fixed ignores realMs", async () => {
  const delays = async (latency: LatencyMode, realMs: number) => {
    const { records } = await runMatch(spec([idle("a", realMs), idle("b", realMs)], { latency }));
    return [...new Set(decisions(records).map((d) => d.applyTick - d.issueTick))];
  };
  const s1 = await delays({ mode: "scaled", factor: 1 }, 200);
  const s2 = await delays({ mode: "scaled", factor: 2 }, 200);
  assert.deepEqual(s1, [msToTicks(200)]);
  assert.deepEqual(s2, [msToTicks(400)]);
  assert.equal(s2[0], 2 * s1[0]);
  const f1 = await delays({ mode: "fixed", ms: 500 }, 10);
  const f2 = await delays({ mode: "fixed", ms: 500 }, 5000);
  assert.deepEqual(f1, [msToTicks(500)]);
  assert.deepEqual(f2, f1);
  const rs = await runMatch(spec([idle("a", 10), idle("b", 10)], { latency: { mode: "resampled", traces: [[300], [600]] } }));
  assert.deepEqual([...new Set(decisions(rs.records, 0).map((d) => d.applyTick - d.issueTick))], [msToTicks(300)]);
  assert.deepEqual([...new Set(decisions(rs.records, 1).map((d) => d.applyTick - d.issueTick))], [msToTicks(600)]);
});

test("an errored decision keeps previous orders and costs at least ERROR_MIN_MS", async () => {
  const A: Action = { drive: "turn_right", turret: 0.3, fire: false };
  const a = fake("a", (n) =>
    n === 0 ? { action: A, realMs: 100 }
    : n === 1 ? { action: null, realMs: 10, error: "boom" }
    : { action: { ...A }, realMs: 100 });
  const b = idle("b", 100);
  const { records, result } = await runMatch(spec([a, b]));
  const ds = decisions(records, 0);
  const err = ds[1];
  assert.equal(err.error, "boom");
  assert.equal(err.action, null);
  assert.ok(err.effMs >= ERROR_MIN_MS);
  assert.ok(err.applyTick - err.issueTick >= msToTicks(ERROR_MIN_MS));
  assert.deepEqual(a.obs[2].self.orders, A, "orders from before the error must persist");
  assert.equal(result.stats[0].errors, 1);
  assert.equal(result.stats[1].errors, 0);
  // fixed mode also floors errors at ERROR_MIN_MS
  const c = fake("c", (n) => (n === 0 ? { action: null, realMs: 0, error: "x" } : { action: { ...IDLE }, realMs: 0 }));
  const r2 = await runMatch(spec([c, idle("d", 0)], { latency: { mode: "fixed", ms: 30 } }));
  const e2 = decisions(r2.records, 0)[0];
  assert.ok(e2.effMs >= ERROR_MIN_MS);
  assert.equal(e2.applyTick - e2.issueTick, msToTicks(ERROR_MIN_MS));
});

test("an agent that throws is treated as an errored decision", async () => {
  const a = fake("a", (n) => { if (n === 0) throw new Error("kaput"); return { action: { ...IDLE }, realMs: 100 }; });
  const { records } = await runMatch(spec([a, idle("b")]));
  const d = decisions(records, 0)[0];
  assert.equal(d.error, "kaput");
  assert.equal(d.action, null);
  assert.ok(d.effMs >= ERROR_MIN_MS);
});

// ---------- Budget ----------

test("budget hardCap aborts with reason 'aborted' when agents report cost", async () => {
  const costly = (id: string) => fake(id, () => ({ action: { ...IDLE }, realMs: 100, cost: 1 }));
  const budget: Budget = { spent: 0, hardCap: 5 };
  const { result, records } = await runMatch(spec([costly("a"), costly("b")]), { budget });
  assert.equal(result.reason, "aborted");
  assert.equal(result.winner, null);
  assert.ok(result.ticks < ROUND_TICKS);
  assert.ok(budget.spent > budget.hardCap);
  assert.ok(budget.spent < budget.hardCap + 10, "should stop promptly after the cap is crossed");
  assert.equal(records.at(-1)?.k, "result");
  // free agents never trip the budget
  const ok = await runMatch(spec([idle("a"), idle("b")]), { budget: { spent: 0, hardCap: 0 } });
  assert.equal(ok.result.reason, "time");
});

test("onRecord receives every record in order", async () => {
  const seen: LogRec[] = [];
  const { records } = await runMatch(spec([idle("a"), idle("b")]), { onRecord: (r) => seen.push(r) });
  assert.deepEqual(seen, records);
  assert.equal(records[0].k, "header");
  assert.equal(records.at(-1)?.k, "result");
});

// ---------- Result stats ----------

test("result stats (shots/hits/selfHits/fizzles/damage) match the events", async () => {
  let totalShots = 0;
  for (const map of mapIds) {
    for (const seed of [1, 2, 3]) {
      const { records, result } = await runMatch(spec([scriptedBot({ thinkMs: 80 }), randomBot({ thinkMs: 150, seed })], { map, seed, latency: { mode: "fixed", ms: 100 } }));
      const ev = events(records);
      for (const slot of [0, 1] as const) {
        const st = result.stats[slot];
        const shots = ev.filter((e) => e.type === "fire" && e.slot === slot).length;
        const hits = ev.filter((e) => e.type === "hit" && e.owner === slot && !e.self).length;
        const selfHits = ev.filter((e) => e.type === "hit" && e.owner === slot && e.self).length;
        const taken = ev.filter((e) => e.type === "hit" && e.victim === slot).length;
        assert.equal(st.shots, shots, `${map}/${seed} slot ${slot} shots`);
        assert.equal(st.hits, hits);
        assert.equal(st.selfHits, selfHits);
        assert.equal(st.damageTaken, taken);
        assert.equal(st.fizzles, ev.filter((e) => e.type === "fizzle" && e.slot === slot).length);
        assert.equal(st.decisions, decisions(records, slot).length);
        // HP in the result agrees with damage taken
        assert.equal(result.hp[slot], Math.max(0, TANK_HP - taken));
        totalShots += shots;
      }
      const firstHit = ev.find((e) => e.type === "hit" && !e.self && e.owner === 0);
      assert.equal(result.stats[0].firstHitTick, firstHit?.t ?? null);
    }
  }
  assert.ok(totalShots > 0, "bots never fired; stats test is vacuous");
});
