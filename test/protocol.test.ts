import test from "node:test";
import assert from "node:assert/strict";
import { buildQuestions, decode, encodeState, TURRET_LEVELS, TURRET_VALUES, type Answers } from "../src/protocol/v1.ts";
import { observe } from "../src/sim/observe.ts";
import { createWorld, setOrders, step } from "../src/sim/world.ts";
import { DRIVE_CMDS } from "../src/sim/types.ts";
import { MAPS } from "../src/sim/maps.ts";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

function answers(o: { drive?: Record<string, number>; turret?: Record<string, number>; fire?: number } = {}): Answers {
  return {
    drive: { type: "choice", choice: "stop", probabilities: o.drive ?? { stop: 1 } },
    turret: { type: "score", score: 3, probabilities: o.turret ?? { "3": 1 } },
    fire: { type: "noul", noul: o.fire ?? 0 },
  };
}

test("TURRET_LEVELS and TURRET_VALUES line up and are symmetric", () => {
  assert.equal(TURRET_LEVELS.length, 7);
  assert.equal(TURRET_VALUES.length, TURRET_LEVELS.length);
  TURRET_VALUES.forEach((v, i) => assert.ok(near(v, -TURRET_VALUES[TURRET_VALUES.length - 1 - i])));
  assert.equal(TURRET_VALUES[3], 0);
});

test("decode: turret probabilities keyed by index", () => {
  const d = decode(answers({ turret: { "0": 0.25, "6": 0.75 } }));
  assert.ok(near(d.action.turret, 0.25 * TURRET_VALUES[0] + 0.75 * TURRET_VALUES[6]));
  assert.deepEqual(Object.keys(d.detail.turretP).sort(), [TURRET_LEVELS[0], TURRET_LEVELS[6]].sort());
});

test("decode: turret probabilities keyed by label give the same result as by index", () => {
  const byIndex = decode(answers({ turret: { "1": 0.3, "4": 0.5, "5": 0.2 } }));
  const byLabel = decode(answers({ turret: { [TURRET_LEVELS[1]]: 0.3, [TURRET_LEVELS[4]]: 0.5, [TURRET_LEVELS[5]]: 0.2 } }));
  assert.ok(near(byLabel.action.turret, byIndex.action.turret));
  assert.deepEqual(byLabel.detail.turretP, byIndex.detail.turretP);
});

test("decode: turret is the expected value over TURRET_VALUES (normalised)", () => {
  for (let i = 0; i < TURRET_VALUES.length; i++) assert.ok(near(decode(answers({ turret: { [String(i)]: 1 } })).action.turret, TURRET_VALUES[i]));
  // unnormalised input is normalised
  assert.ok(near(decode(answers({ turret: { "6": 0.2 } })).action.turret, TURRET_VALUES[6]));
  const p = [0.05, 0.1, 0.15, 0.3, 0.2, 0.1, 0.1];
  const expected = p.reduce((s, x, i) => s + x * TURRET_VALUES[i], 0) / p.reduce((s, x) => s + x, 0);
  const d = decode(answers({ turret: Object.fromEntries(p.map((x, i) => [String(i), x])) }));
  assert.ok(near(d.action.turret, expected));
  // symmetric distribution -> zero
  assert.ok(near(decode(answers({ turret: { "0": 0.5, "6": 0.5 } })).action.turret, 0));
  // unknown keys are ignored; nothing usable -> hold
  assert.ok(near(decode(answers({ turret: { bogus: 1, "7": 1, "-1": 1 } })).action.turret, 0));
  assert.ok(near(decode(answers({ turret: { bogus: 1, "6": 1 } })).action.turret, TURRET_VALUES[6]));
});

test("decode: drive is the argmax over valid commands", () => {
  for (const cmd of DRIVE_CMDS) {
    const probs = Object.fromEntries(DRIVE_CMDS.map((c) => [c, c === cmd ? 0.4 : 0.1]));
    assert.equal(decode(answers({ drive: probs })).action.drive, cmd);
  }
  // invalid keys never win
  assert.equal(decode(answers({ drive: { warp: 0.99, reverse: 0.01 } })).action.drive, "reverse");
  // nothing valid -> stop
  assert.equal(decode(answers({ drive: { warp: 1 } })).action.drive, "stop");
});

test("decode: fire uses p >= 0.5", () => {
  assert.equal(decode(answers({ fire: 0.5 })).action.fire, true);
  assert.equal(decode(answers({ fire: 0.51 })).action.fire, true);
  assert.equal(decode(answers({ fire: 0.4999 })).action.fire, false);
  assert.equal(decode(answers({ fire: 0 })).action.fire, false);
  assert.equal(decode(answers({ fire: 1 })).action.fire, true);
  assert.equal(decode(answers({ fire: 0.7 })).detail.fireP, 0.7);
});

test("decode: malformed answers throw", () => {
  const ok = answers();
  assert.doesNotThrow(() => decode(ok));
  for (const k of ["drive", "turret", "fire"]) {
    const missing = { ...ok };
    delete missing[k];
    assert.throws(() => decode(missing), /malformed/, `missing ${k}`);
  }
  assert.throws(() => decode({}), /malformed/);
  assert.throws(() => decode({ ...ok, drive: ok.fire }), /malformed/);
  assert.throws(() => decode({ ...ok, turret: ok.drive }), /malformed/);
  assert.throws(() => decode({ ...ok, fire: ok.turret }), /malformed/);
});

function sampleObs() {
  const w = createWorld(Object.keys(MAPS)[1] ?? "open", 4);
  w.tanks[0].x = 11.37; w.tanks[0].y = 4.21; w.tanks[0].heading = 0.7;
  w.tanks[1].x = 23.58; w.tanks[1].y = 13.94;
  setOrders(w, 0, { drive: "forward_left", turret: 0.4, fire: true });
  for (let i = 0; i < 40; i++) step(w);
  return { w, o: observe(w, 0) };
}

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

test("encodeState has no raw coordinates and is byte-identical for the same observation", () => {
  const { w, o } = sampleObs();
  const a = JSON.stringify(encodeState(o));
  assert.equal(a, JSON.stringify(encodeState(o)));
  assert.equal(a, JSON.stringify(encodeState(observe(w, 0))));
  for (const k of allKeys(JSON.parse(a))) assert.ok(!/^(x|y|pos|position|coords?|coordinates)$/i.test(k), `coordinate-like key ${k}`);
  // No rounded world position of either tank leaks through (checked at 0.1 resolution, as encoded).
  for (const t of w.tanks) for (const v of [t.x, t.y]) {
    const s = String(Math.round(v * 10) / 10);
    if (s.includes(".")) assert.ok(!new RegExp(`(?<![\\d.])${s.replace(".", "\\.")}(?![\\d])`).test(a), `value ${s} for a tank coordinate appears in the encoded state`);
  }
  assert.equal(a.includes('"tick"'), false);
});

test("encodeState reflects egocentric facts", () => {
  const { o } = sampleObs();
  const s = encodeState(o) as any;
  assert.equal(s.you.hp, o.self.hp);
  assert.equal(s.enemy.hp, o.enemy.hp);
  assert.equal(s.enemy.line_of_sight, o.enemy.lineOfSight);
  assert.equal(s.enemy.motion, o.enemy.motion);
  assert.equal(typeof s.rules, "string");
});

test("buildQuestions is deterministic, coordinate-free, and keeps criteria/levels fixed", () => {
  const { w, o } = sampleObs();
  const q = buildQuestions(o);
  assert.equal(JSON.stringify(q), JSON.stringify(buildQuestions(o)));
  assert.equal(JSON.stringify(q), JSON.stringify(buildQuestions(observe(w, 0))));
  assert.deepEqual(Object.keys(q).sort(), ["drive", "fire", "turret"]);
  assert.equal(q.drive.type, "choice");
  assert.equal(q.turret.type, "score");
  assert.equal(q.fire.type, "noul");
  if (q.drive.type === "choice") assert.deepEqual(Object.keys(q.drive.criteria), [...DRIVE_CMDS]);
  if (q.turret.type === "score") assert.deepEqual(q.turret.criteria, TURRET_LEVELS);
  for (const k of allKeys(q)) assert.ok(!/^(x|y|pos|position|coords?)$/i.test(k));
  const text = JSON.stringify(q);
  for (const t of w.tanks) for (const v of [t.x, t.y]) {
    const s = (Math.round(v * 10) / 10).toFixed(1);
    assert.ok(!new RegExp(`(?<![\\d.])${s.replace(".", "\\.")}(?!\\d)`).test(text) || s === String(Math.round(o.enemy.distanceM * 10) / 10), `tank coordinate ${s} appears in questions`);
  }
  for (const v of Object.values(q)) assert.ok(v.instructions.length > 0);
});

test("buildQuestions: only instruction text depends on the observation; criteria stay identical", () => {
  const { o } = sampleObs();
  const o2 = structuredClone(o);
  o2.enemy.bearingFromHullDeg = -77; o2.enemy.aimOffsetDeg = 33; o2.enemy.distanceM = 4.4; o2.enemy.shotClear = !o.enemy.shotClear;
  const a = buildQuestions(o), b = buildQuestions(o2);
  assert.notEqual(a.drive.instructions, b.drive.instructions);
  assert.notEqual(a.turret.instructions, b.turret.instructions);
  assert.notEqual(a.fire.instructions, b.fire.instructions);
  for (const k of ["drive", "turret"]) assert.deepEqual((a[k] as any).criteria, (b[k] as any).criteria);
  // sign sanity: a right-side enemy is described as right, a left-side one as left
  o2.enemy.bearingFromHullDeg = 40; assert.match(buildQuestions(o2).drive.instructions, /40° right/);
  o2.enemy.bearingFromHullDeg = -40; assert.match(buildQuestions(o2).drive.instructions, /40° left/);
});
