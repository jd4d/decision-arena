import test from "node:test";
import assert from "node:assert/strict";
import { buildQuestions, encodeState, PROTOCOL_VERSION, TURRET_LEVELS } from "../src/protocol/v2.ts";
import { observe, traceShot } from "../src/sim/observe.ts";
import { createWorld, setOrders, step, turretAngle } from "../src/sim/world.ts";
import { DRIVE_CMDS, type World } from "../src/sim/types.ts";
import { MAP_IDS } from "../src/sim/maps.ts";
import { rng } from "../src/sim/rng.ts";
import * as T from "../src/sim/tuning.ts";

/** Fire one shell from `slot` with both tanks frozen and report what really happens to it. */
function realOutcome(w: World, slot: 0 | 1): "direct" | "bank" | "self" | "miss" {
  const other = slot === 0 ? 1 : 0;
  setOrders(w, slot, { drive: "stop", turret: 0, fire: true });
  setOrders(w, other, { drive: "stop", turret: 0, fire: false });
  let bounced = false;
  for (let i = 0; i < T.SHELL_LIFETIME_TICKS + 5; i++) {
    step(w);
    for (const e of w.events) {
      if (e.type === "fizzle" || e.type === "expire" || e.type === "clash") return "miss";
      if (e.type === "bounce") bounced = true;
      if (e.type === "hit") return e.victim === slot ? "self" : bounced ? "bank" : "direct";
    }
    if (w.over) break;
  }
  return "miss";
}

function randomSetup(map: string, seed: number): World {
  const r = rng(seed);
  const w = createWorld(map, seed);
  // Place tanks at random legal spots by driving them briefly with random orders, then aim randomly.
  for (const t of w.tanks) { t.x = 2 + r() * (T.ARENA_W - 4); t.y = 2 + r() * (T.ARENA_H - 4); t.heading = r() * Math.PI * 2; t.turretRel = r() * Math.PI * 2; t.reload = 0; }
  step(w); // resolves any spawn inside a wall via the sim's own push-out
  for (const t of w.tanks) t.reload = 0;
  return w;
}

test("traceShot predicts the real simulation outcome of a shell fired with both tanks frozen", () => {
  const counts: Record<string, number> = { direct: 0, bank: 0, self: 0, miss: 0 };
  let agree = 0, total = 0;
  for (const map of MAP_IDS) for (let seed = 1; seed <= 150; seed++) {
    const w = randomSetup(map, seed);
    if (w.over) continue;
    const predicted = traceShot(w, 0, turretAngle(w.tanks[0])).result;
    const actual = realOutcome(structuredClone(w), 0);
    counts[actual]++;
    total++;
    if (predicted === actual) agree++;
    else assert.fail(`${map}/${seed}: predicted ${predicted}, sim did ${actual}`);
  }
  assert.equal(agree, total);
  // The sample must actually exercise every outcome, or the test proves little.
  for (const k of ["direct", "bank", "self", "miss"]) assert.ok(counts[k] > 0, `no ${k} outcomes sampled: ${JSON.stringify(counts)}`);
});

test("bankTurnDeg points at a real one-bounce hit", () => {
  let found = 0;
  for (const map of MAP_IDS) for (let seed = 1; seed <= 40; seed++) {
    const w = randomSetup(map, seed);
    const o = observe(w, 0);
    if (o.bankTurnDeg === null) continue;
    found++;
    const ang = turretAngle(w.tanks[0]) + (o.bankTurnDeg * Math.PI) / 180;
    assert.equal(traceShot(w, 0, ang).result, "bank", `${map}/${seed}`);
    // Turning the turret by that amount and firing for real banks into the enemy.
    const w2 = structuredClone(w);
    w2.tanks[0].turretRel += (o.bankTurnDeg * Math.PI) / 180;
    assert.equal(realOutcome(w2, 0), "bank", `${map}/${seed} real`);
  }
  assert.ok(found > 50, `only ${found} bank shots found`);
});

function sampleObs() {
  const w = createWorld("pillars", 4);
  setOrders(w, 0, { drive: "forward_left", turret: 0.4, fire: true });
  setOrders(w, 1, { drive: "forward", turret: -0.3, fire: true });
  for (let i = 0; i < 40; i++) step(w);
  return { w, o: observe(w, 0) };
}

test("p2 state carries the world frame and stays deterministic", () => {
  const { w, o } = sampleObs();
  assert.equal(PROTOCOL_VERSION, "p2");
  const s = encodeState(o) as any;
  assert.equal(JSON.stringify(s), JSON.stringify(encodeState(observe(w, 0))));
  assert.equal(s.arena.width_m, T.ARENA_W);
  assert.equal(s.arena.walls.length, w.walls.length);
  assert.deepEqual(s.you.position_m, { x: Math.round(w.tanks[0].x * 10) / 10, y: Math.round(w.tanks[0].y * 10) / 10 });
  assert.deepEqual(s.enemy.position_m, { x: Math.round(w.tanks[1].x * 10) / 10, y: Math.round(w.tanks[1].y * 10) / 10 });
  for (const t of [s.you, s.enemy]) {
    assert.ok(t.hull_heading_deg >= 0 && t.hull_heading_deg < 360);
    assert.ok(t.turret_heading_deg >= 0 && t.turret_heading_deg < 360);
  }
  assert.match(s.rules, /bounce off walls exactly once/);
  assert.match(s.your_shot.if_fired_now, /^would (hit the enemy directly|hit the enemy after one bounce off a wall|bounce back and hit you|miss) \(assuming both tanks stay still\)$/);
  assert.ok(Array.isArray(s.shells) && s.shells.length === w.shells.length, "both tanks fired, so shells are listed");
  assert.equal(JSON.stringify(s).includes('"tick"'), false);
});

test("p2 heading convention matches the egocentric bearing", () => {
  // Relative bearing from the world headings must agree with direction_from_hull (positive = right = clockwise).
  for (let seed = 1; seed <= 30; seed++) {
    const w = randomSetup("open", seed);
    const o = observe(w, 0);
    const toEnemy = (Math.atan2(w.tanks[1].y - w.tanks[0].y, w.tanks[1].x - w.tanks[0].x) * 180) / Math.PI;
    const rel = ((toEnemy - o.self.pose.hullHeadingDeg + 540) % 360) - 180;
    assert.ok(Math.abs(rel - o.enemy.bearingFromHullDeg) < 1e-6, `seed ${seed}`);
  }
});

test("p2 questions keep p1's keys and criteria; turret levels are labelled in degrees", () => {
  const { o } = sampleObs();
  const q = buildQuestions(o);
  assert.deepEqual(Object.keys(q).sort(), ["drive", "fire", "turret"]);
  if (q.drive.type === "choice") assert.deepEqual(Object.keys(q.drive.criteria), [...DRIVE_CMDS]);
  if (q.turret.type === "score") assert.deepEqual(q.turret.criteria, TURRET_LEVELS);
  assert.match(q.drive.instructions, /How should your hull drive until your next decision\?$/);
  assert.match(q.turret.instructions, /How far should your turret turn in its next step\?$/);
  assert.match(q.fire.instructions, /a shot fired now would (hit the enemy directly|hit the enemy after one bounce off a wall|bounce back and hit you|miss) if both tanks stayed still/);
});

test("bank-shot hint: only in the turret question, and only when a wall blocks the direct line", () => {
  let blocked = 0, clear = 0;
  for (const map of MAP_IDS) for (let seed = 1; seed <= 60; seed++) {
    const o = observe(randomSetup(map, seed), 0);
    const s = encodeState(o) as any, q = buildQuestions(o);
    assert.equal("nearest_bank_shot" in s.your_shot, false, "no bank hint in the state");
    if (o.enemy.lineOfSight) {
      clear++;
      assert.doesNotMatch(q.turret.instructions, /bank shot|wall blocks/, `${map}/${seed}`);
    } else {
      blocked++;
      assert.match(q.turret.instructions, /but a wall blocks the direct line; (no bank shot is within reach|a bank shot off a wall is lined up now|a bank shot off a wall needs your turret \d+° (left|right))\./, `${map}/${seed}`);
      if (o.bankTurnDeg) assert.ok(q.turret.instructions.includes(`${Math.abs(o.bankTurnDeg)}° ${o.bankTurnDeg > 0 ? "right" : "left"}`));
    }
  }
  assert.ok(blocked > 5 && clear > 50, `blocked ${blocked}, clear ${clear}`);
});
