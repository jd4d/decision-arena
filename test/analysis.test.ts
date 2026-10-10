import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecisionRec, EventRec, LogRec, ResultRec, SlotStats } from "../src/runner/log.ts";
import { agentConditionStats, fireBin, highlights, indexEntry, latencyHistogram, summarizeRun, toMatch, wilson } from "../src/analysis/aggregate.ts";

const st = (o: Partial<SlotStats> = {}): SlotStats => ({ decisions: 2, errors: 0, shots: 0, fizzles: 0, hits: 0, selfHits: 0, damageTaken: 0, cost: 0.01, latencyMs: { p50: 0, p90: 0, mean: 0, max: 0 }, firstHitTick: null, ...o });

function log(a: string, b: string, events: any[], result: Partial<ResultRec>, decisions: Partial<DecisionRec>[] = [], cond = "c1", map = "open"): LogRec[] {
  return [
    { k: "header", v: 1, runId: "r", matchId: `${a}-${b}-${map}`, condition: cond, createdAt: "", sim: "s", protocol: "p", map, seed: 1, tickHz: 30, roundTicks: 2700, latency: { mode: "fixed", ms: 0 } as any,
      agents: [{ id: a, label: a.toUpperCase(), kind: "bot", slot: 0 }, { id: b, label: b.toUpperCase(), kind: "bot", slot: 1 }] },
    ...decisions.map((d, i) => ({ k: "decision", slot: 0, n: i, issueTick: 0, applyTick: 0, realMs: 100, effMs: 120, action: { drive: "forward", turret: 0, fire: false }, ...d }) as DecisionRec),
    ...events.map((e) => ({ k: "event", ...e }) as EventRec),
    { k: "result", winner: null, reason: "time", ticks: 300, hp: [3, 3], stats: [st(), st()], wallMs: 1, ...result } as ResultRec,
  ];
}

test("wilson interval", () => {
  const w = wilson(5, 10);
  assert.equal(w.p, 0.5);
  assert.ok(Math.abs(w.lo - 0.2366) < 1e-3 && Math.abs(w.hi - 0.7634) < 1e-3);
  assert.deepEqual(wilson(0, 0), { p: 0, lo: 0, hi: 1 });
});

test("fireBin edges", () => {
  assert.equal(fireBin(0.3), "<0.5");
  assert.equal(fireBin(0.5), "0.5-0.6");
  assert.equal(fireBin(0.69), "0.6-0.7");
  assert.equal(fireBin(0.8), "0.8-0.9");
  assert.equal(fireBin(1), "0.9-1.0");
});

test("aborted and result-less logs are excluded", () => {
  assert.equal(toMatch(log("a", "b", [], { reason: "aborted" })), null);
  assert.equal(toMatch(log("a", "b", [], {}).slice(0, -1)), null);
  assert.ok(toMatch(log("a", "b", [], {})));
});

test("aggregates by agent id across swapped slots, accuracy and calibration", () => {
  const detail = (p: number) => ({ driveP: {}, turretP: {}, fireP: p });
  // match 1: a (slot0) hits b twice, wins; one shot with detail fireP .85 hit, one 0.55 missed
  const m1 = toMatch(log("a", "b", [
    { t: 10, type: "fire", slot: 0, shell: 1 }, { t: 20, type: "hit", shell: 1, owner: 0, victim: 1, self: false, x: 0, y: 0, hpAfter: 2 },
    { t: 40, type: "fire", slot: 0, shell: 2 },
    { t: 60, type: "end", winner: 0, reason: "destroyed" },
  ], { winner: 0, reason: "destroyed", hp: [3, 1], stats: [st({ firstHitTick: 20, cost: 0.02 }), st()] },
  [{ applyTick: 5, action: { drive: "forward", turret: 0, fire: true }, detail: detail(0.85) }, { applyTick: 30, action: { drive: "stop", turret: 0, fire: true }, detail: detail(0.55) }, { applyTick: 35, realMs: 9999, action: null, error: "x" }]))!;
  // match 2: swapped slots, b wins (slot 0), a loses
  const m2 = toMatch(log("b", "a", [], { winner: 0, reason: "destroyed", hp: [3, 0] }))!;
  const m3 = toMatch(log("a", "b", [], {}))!; // draw
  const s = agentConditionStats([m1, m2, m3], "a");
  assert.deepEqual([s.matches, s.wins, s.losses, s.draws], [3, 1, 1, 1]);
  assert.equal(s.winRate.p, 0.5);
  assert.equal(s.scoreRate.p, 1.5 / 3);
  assert.equal(s.shots, 2);
  assert.equal(s.hits, 1);
  assert.equal(s.accuracy, 0.5);
  assert.equal(s.meanFirstHitS, 20 / 30);
  assert.equal(s.latencyMs.mean, 100); // error decision excluded
  assert.equal(s.errors, 0); // from stats, synthetic
  assert.equal(s.driveMix.forward + s.driveMix.stop, 1);
  const cal = Object.fromEntries(s.fireCalibration.map((c) => [c.bin, c]));
  assert.deepEqual([cal["0.8-0.9"].n, cal["0.8-0.9"].hitRate, cal["0.5-0.6"].n, cal["0.5-0.6"].hitRate], [1, 1, 1, 0]);
  const sb = agentConditionStats([m1, m2, m3], "b");
  assert.deepEqual([sb.wins, sb.losses, sb.draws], [1, 1, 1]);
});

test("highlights", () => {
  const hit = (t: number, owner: 0 | 1, victim: 0 | 1, hpAfter: number, self = false) => ({ t, type: "hit", shell: t, owner, victim, self, x: 0, y: 0, hpAfter });
  const m = toMatch(log("a", "b", [
    hit(10, 1, 0, 2), hit(20, 1, 0, 1), hit(30, 0, 1, 2), hit(40, 0, 1, 1), hit(2600, 0, 1, 0),
    { t: 50, type: "clash", shells: [1, 2], x: 0, y: 0 }, hit(55, 1, 1, 2, true),
  ], { winner: 0, reason: "destroyed", ticks: 2600 }))!;
  const h = highlights(m);
  for (const x of ["self-hit", "shell clash", "comeback", "last-second"]) assert.ok(h.includes(x), x);
  assert.ok(!h.includes("flawless"));
  const flaw = toMatch(log("a", "b", [hit(10, 0, 1, 2)], { winner: 0, reason: "destroyed" }))!;
  assert.ok(highlights(flaw).includes("flawless"));
  assert.deepEqual(highlights(toMatch(log("a", "b", [], {}))!), ["timeout draw"]);
});

test("latency histogram caps and summary/index shape", () => {
  const m = toMatch(log("a", "b", [], { winner: 1, reason: "destroyed" }, [{ realMs: 10 }, { realMs: 30 }, { realMs: 5000 }]))!;
  const h = latencyHistogram([m], "a");
  assert.equal(h.binMs, 25);
  assert.equal(h.counts.length, 61);
  assert.deepEqual([h.counts[0], h.counts[1], h.counts[60]], [1, 1, 1]);
  const sum = summarizeRun("r", [m], "now");
  assert.equal(sum.maps[0].winsByAgent.b, 1);
  assert.equal(sum.conditions[0].byAgent.a.losses, 1);
  assert.equal(sum.totalCostUsd, 0.02);
  const e = indexEntry(m);
  assert.deepEqual([e.agents, e.winner, e.durationS], [["a", "b"], 1, 10]);
});
