import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, setOrders, step, turretAngle } from "../src/sim/world.ts";
import { DODGE_HORIZON_S, observe } from "../src/sim/observe.ts";
import { wrapAngle } from "../src/sim/math.ts";
import { DRIVE_CMDS, type Action, type DriveCmd, type World } from "../src/sim/types.ts";
import { MAP_IDS } from "../src/sim/maps.ts";
import { rng } from "../src/sim/rng.ts";
import * as T from "../src/sim/tuning.ts";
import * as P2 from "../src/protocol/v2.ts";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const order = (o: Partial<Action>): Action => ({ drive: "stop", turret: 0, fire: false, ...o });
const run = (w: World, n: number) => { for (let i = 0; i < n; i++) step(w); };

function blank(): World {
  const w = createWorld("open", 1);
  Object.assign(w.tanks[0], { x: 16, y: 10, heading: 0, turretRel: 0 });
  Object.assign(w.tanks[1], { x: 30, y: 2, heading: Math.PI, turretRel: 0 });
  return w;
}

test("sim-3 is current and p2 describes it", () => {
  assert.equal(T.SIM_VERSION, "sim-3");
  assert.equal(P2.PROTOCOL_VERSION, "p2");
  assert.equal(P2.PROTOCOL_SIM, T.SIM_VERSION);
});

test("sim-3 driving is continuous until replaced", () => {
  for (const [drive, speed] of [["forward", T.TANK_SPEED], ["reverse", -T.TANK_REVERSE_SPEED]] as const) {
    const w = blank();
    w.tanks[0].x = 10;
    setOrders(w, 0, order({ drive }));
    run(w, 30);
    assert.ok(near(w.tanks[0].x - 10, speed, 1e-6), `${drive}: 1 s of driving`);
    assert.equal(w.tanks[0].orders.drive, drive, "still driving");
  }
  const w = blank();
  setOrders(w, 0, order({ drive: "forward_left" }));
  run(w, 30);
  assert.ok(near(wrapAngle(w.tanks[0].heading), wrapAngle(-T.HULL_ARC_TURN_RATE), 1e-6), "arcs keep turning");
});

test("sim-3 turning in place is one 30° step, then the hull stops", () => {
  const w = blank();
  setOrders(w, 0, order({ drive: "turn_right" }));
  run(w, 60);
  assert.ok(near(w.tanks[0].heading, T.HULL_TURN_STEP, 1e-9));
  assert.equal(w.tanks[0].orders.drive, "stop");
});

test("sim-3 turret is stabilised: hull turns do not move the aim, turret steps do", () => {
  const w = blank();
  w.tanks[0].turretRel = 0.4;
  const aim0 = turretAngle(w.tanks[0]);
  setOrders(w, 0, order({ drive: "forward_right" }));
  run(w, 45);
  assert.ok(Math.abs(w.tanks[0].heading) > 1, "hull turned a lot");
  assert.ok(near(wrapAngle(turretAngle(w.tanks[0]) - aim0), 0, 1e-9), "aim unchanged on the map");
  setOrders(w, 0, order({ drive: "turn_left", turret: 1 }));
  run(w, 30);
  assert.ok(near(wrapAngle(turretAngle(w.tanks[0]) - aim0), T.TURRET_STEP_MAX, 1e-9), "turret step is relative to the map");
});

test("p2 drive question: ahead within 15°, no dead-ahead requirement", () => {
  const w = blank();
  const o = observe(w, 0);
  o.enemy.bearingFromHullDeg = 12;
  assert.match(P2.buildQuestions(o).drive.instructions, /^The enemy is ahead of your hull \(within 15°\)/);
  o.enemy.bearingFromHullDeg = -40;
  assert.match(P2.buildQuestions(o).drive.instructions, /^The enemy is 40° left of your hull's front/);
  assert.match(P2.buildQuestions(o).drive.instructions, /No shells are in flight\./);
});

/** A shell flying straight at tank 0 from 5 m to its left (west), fired by the enemy. */
function incoming(): World {
  const w = blank();
  w.tanks[0].heading = -Math.PI / 2; // facing north, so the shell comes from its left
  w.shells.push({ id: 99, owner: 1, x: 11, y: 10, vx: T.SHELL_SPEED, vy: 0, bounces: 0, age: 0 });
  w.nextShellId = 100;
  return w;
}

test("dodge check: a shell on course is reported, and driving out of its path is listed as safe", () => {
  const o = observe(incoming(), 0);
  assert.ok(o.dodge);
  assert.ok(o.dodge.keepCourseHitS !== null && o.dodge.keepCourseHitS < 0.5);
  assert.notEqual(o.dodge.hitS.stop, null, "staying put gets hit");
  assert.equal(o.dodge.hitS.forward, null, "driving north out of the path is safe");
  const q = P2.buildQuestions(o).drive.instructions;
  assert.match(q, /A shell will hit you in 0\.\d s if you keep your current course; .*forward.* would avoid it\./);
  assert.equal((P2.encodeState(o) as any).shell_danger, P2.dodgeText(o));
});

test("dodge claims match what the real sim then does (random states, bounces included)", () => {
  let checked = 0, threatened = 0, saved = 0;
  for (const map of MAP_IDS) for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 7 + map.length);
    const w = createWorld(map, seed);
    for (const t of w.tanks) { t.x = 2 + r() * (T.ARENA_W - 4); t.y = 2 + r() * (T.ARENA_H - 4); t.heading = r() * 6.28; }
    step(w);
    // Shells from random spots aimed roughly at tank 0, some via walls.
    for (let i = 0; i < 3; i++) {
      const sx = 1 + r() * (T.ARENA_W - 2), sy = 1 + r() * (T.ARENA_H - 2);
      const a = Math.atan2(w.tanks[0].y - sy, w.tanks[0].x - sx) + (r() - 0.5) * 0.6;
      w.shells.push({ id: 1000 + i, owner: 1, x: sx, y: sy, vx: Math.cos(a) * T.SHELL_SPEED, vy: Math.sin(a) * T.SHELL_SPEED, bounces: r() < 0.3 ? 1 : 0, age: 0 });
    }
    w.nextShellId = 2000;
    const o = observe(w, 0);
    if (!o.dodge) continue;
    if (o.dodge.keepCourseHitS !== null) threatened++;
    for (const d of DRIVE_CMDS as readonly DriveCmd[]) {
      const c: World = structuredClone(w);
      setOrders(c, 0, order({ drive: d }));
      c.tanks[1].fireLatch = false;
      let hitAt: number | null = null;
      for (let i = 0; i < DODGE_HORIZON_S * T.TICK_HZ && !c.over && hitAt === null; i++) {
        step(c);
        for (const e of c.events) if (e.type === "hit" && e.victim === 0 && e.shell >= 1000 && e.shell < 2000) hitAt = (i + 1) / T.TICK_HZ;
      }
      assert.equal(o.dodge.hitS[d], hitAt, `${map}/${seed} ${d}`);
      checked++;
    }
    if (o.dodge.keepCourseHitS !== null && DRIVE_CMDS.some((d) => o.dodge!.hitS[d] === null)) saved++;
  }
  assert.ok(checked > 1000, `checked ${checked}`);
  assert.ok(threatened > 20, `only ${threatened} threatened states`);
  assert.ok(saved > 5, `only ${saved} states with a dodge available`);
});

test("replays rebuild the world with the logged sim version; unknown versions are rejected", async () => {
  const { createReplay } = await import("../src/runner/replay.ts");
  const header = { k: "header", sim: "sim-2", map: "open", seed: 3 } as any;
  assert.equal(createReplay([header]).world.sim, "sim-2");
  assert.equal(createReplay([{ ...header, sim: "sim-3" }]).world.sim, "sim-3");
  assert.throws(() => createWorld("open", 1, "sim-4"), /unsupported sim version/);
});

test("turret steps are exact and do not stack", () => {
  const w = blank();
  setOrders(w, 0, order({ turret: 0.5 }));
  run(w, 2);
  setOrders(w, 0, order({ turret: 0.5 }));
  run(w, 30);
  const turned = wrapAngle(turretAngle(w.tanks[0]));
  assert.ok(turned > 0.5 * T.TURRET_STEP_MAX && turned < 1.5 * T.TURRET_STEP_MAX + 1e-9, "the second order replaces what was left of the first");
  assert.equal(w.tanks[0].orders.turret, 0);
});

test("turret facts assume the pending turret step is complete (no double turns)", () => {
  for (const turret of [1, -0.5, 0.2, -1]) for (let seed = 1; seed <= 10; seed++) {
    const w = createWorld(MAP_IDS[seed % MAP_IDS.length], seed);
    Object.assign(w.tanks[1], { x: 26, y: 6 + seed });
    Object.assign(w.tanks[0], { x: 6, y: 4 + seed, heading: seed, turretRel: -seed });
    step(w); // settle spawns
    setOrders(w, 1, order({}));
    setOrders(w, 0, order({ turret }));
    const atLanding = observe(w, 0); // the engine observes here, before the step has moved
    run(w, 8); // > the 5 ticks a 20° step takes; nothing else moves
    const settled = observe(w, 0);
    assert.equal(w.tanks[0].stepLeft.turret, 0);
    assert.ok(near(atLanding.enemy.aimOffsetDeg, settled.enemy.aimOffsetDeg, 1e-6), `aim ${turret}/${seed}`);
    assert.equal(atLanding.shotNow.result, settled.shotNow.result);
    assert.equal(atLanding.bankTurnDeg, settled.bankTurnDeg);
    assert.ok(near(atLanding.self.pose.turretHeadingDeg, settled.self.pose.turretHeadingDeg, 1e-6));
    assert.equal(P2.buildQuestions(atLanding).turret.instructions, P2.buildQuestions(settled).turret.instructions);
    const noReload = (t: string) => t.replace(/your reload is .*?\. /, ""); // time passes between the two observations
    assert.equal(noReload(P2.buildQuestions(atLanding).fire.instructions), noReload(P2.buildQuestions(settled).fire.instructions));
  }
});

test("p2 rules say turret facts assume the step is done; current_course no longer describes the turret", () => {
  const w = blank();
  setOrders(w, 0, order({ drive: "forward", turret: 1 }));
  const s = P2.encodeState(observe(w, 0)) as any;
  assert.match(s.rules, /already assumes your current turret step is complete/);
  assert.equal(s.you.current_course, "driving forward");
});

const answers = (drive: Record<string, number>, turret: Record<string, number>, fire: number) => ({
  drive: { type: "choice" as const, choice: "", probabilities: drive },
  turret: { type: "score" as const, score: 3, probabilities: turret },
  fire: { type: "noul" as const, noul: fire },
});

test("p2 decoding draws each action from the model's own probabilities", () => {
  const ans = answers({ forward: 0.6, turn_left: 0.3, reverse: 0.1 }, { "10° left": 0.7, hold: 0.2, "20° right": 0.1 }, 0.25);
  const N = 20000, cnt: Record<string, number> = {};
  let fired = 0;
  for (let s = 0; s < N; s++) {
    const a = P2.decode(ans, s).action;
    cnt[`d:${a.drive}`] = (cnt[`d:${a.drive}`] ?? 0) + 1;
    cnt[`t:${a.turret}`] = (cnt[`t:${a.turret}`] ?? 0) + 1;
    if (a.fire) fired++;
  }
  const f = (k: string) => (cnt[k] ?? 0) / N;
  for (const [k, p] of [["d:forward", 0.6], ["d:turn_left", 0.3], ["d:reverse", 0.1], ["t:-0.5", 0.7], ["t:0", 0.2], ["t:1", 0.1]] as const) assert.ok(Math.abs(f(k) - p) < 0.015, `${k}: ${f(k)} vs ${p}`);
  assert.ok(Math.abs(fired / N - 0.25) < 0.015, `fire ${fired / N}`);
  for (const never of ["d:stop", "d:forward_left", "t:0.2", "t:-1"]) assert.equal(cnt[never] ?? 0, 0, `${never} has zero probability`);
});

test("p2 decoding: certainty always acts, zero never does, and the draw is reproducible", () => {
  for (let s = 0; s < 500; s++) {
    const sure = P2.decode(answers({ turn_right: 1 }, { "4° left": 1 }, 1), s).action;
    assert.deepEqual(sure, { drive: "turn_right", turret: -0.2, fire: true });
    assert.equal(P2.decode(answers({ stop: 1 }, { "3": 1 }, 0), s).action.fire, false);
  }
  const ans = answers({ forward: 0.5, reverse: 0.5 }, { "0": 0.5, "6": 0.5 }, 0.5);
  for (let s = 0; s < 50; s++) assert.deepEqual(P2.decode(ans, s), P2.decode(ans, s));
  // Unusable answers fall back to staying still; labels and indices are the same levels.
  assert.deepEqual(P2.decode(answers({ warp: 1 }, { bogus: 1 }, -1), 7).action, { drive: "stop", turret: 0, fire: false });
  assert.equal(P2.decode(answers({ stop: 1 }, { "6": 1 }, 0), 1).action.turret, P2.decode(answers({ stop: 1 }, { "20° right": 1 }, 0), 1).action.turret);
  assert.throws(() => P2.decode({}, 1), /malformed/);
});

test("p2 draw seed depends on the state, not on the model", () => {
  const w = blank();
  const a = P2.drawSeed(observe(w, 0)), b = P2.drawSeed(observe(w, 1));
  assert.equal(a, P2.drawSeed(observe(w, 0)));
  assert.notEqual(a, b, "the two tanks draw independently");
  step(w);
  assert.notEqual(P2.drawSeed(observe(w, 0)), a, "a new tick draws afresh");
});

test("scaled decoder: top option, scaled by its probability; fire at the bar; deterministic", () => {
  const a = P2.decode(answers({ forward: 0.6, turn_left: 0.3, reverse: 0.1 }, { "10° left": 0.7, hold: 0.3 }, 0.59), 1, "scaled").action;
  assert.equal(a.drive, "forward");
  assert.ok(near(a.throttle!, 0.6));
  assert.ok(near(a.turret, -0.5 * 0.7));
  assert.equal(a.fire, false);
  assert.equal(P2.decode(answers({ stop: 1 }, { hold: 1 }, P2.SCALED_FIRE_BAR), 1, "scaled").action.fire, true);
  for (let s = 0; s < 20; s++) assert.deepEqual(P2.decode(answers({ forward: 0.5, reverse: 0.5 }, { "0": 0.5, "6": 0.5 }, 0.5), s, "scaled").action, { drive: "forward", throttle: 0.5, turret: -0.5, fire: false });
  assert.deepEqual(P2.decode(answers({ warp: 1 }, { bogus: 1 }, 0), 1, "scaled").action, { drive: "stop", throttle: 1, turret: 0, fire: false });
});

test("throttle scales driving speed and the turn-in-place step (sim-3), and is ignored by sim-2", () => {
  const w = blank(); w.tanks[0].x = 10;
  setOrders(w, 0, { drive: "forward", turret: 0, fire: false, throttle: 0.5 });
  run(w, 30);
  assert.ok(near(w.tanks[0].x - 10, T.TANK_SPEED * 0.5, 1e-6));
  const w2 = blank();
  setOrders(w2, 0, { drive: "turn_right", turret: 0, fire: false, throttle: 0.4 });
  run(w2, 30);
  assert.ok(near(w2.tanks[0].heading, T.HULL_TURN_STEP * 0.4, 1e-9));
  const w3 = createWorld("open", 1, "sim-2"); w3.tanks[0].x = 10; w3.tanks[0].heading = 0;
  setOrders(w3, 0, { drive: "forward", turret: 0, fire: false, throttle: 0.5 });
  run(w3, 30);
  assert.ok(near(w3.tanks[0].x - 10, T.TANK_SPEED, 1e-6));
});

test("protocol labels: p2-draw is live; model agents carry their decoder's label", async () => {
  assert.equal(P2.CURRENT_PROTOCOL, "p2-draw");
  assert.equal(P2.protocolLabel("scaled"), "p2-scaled");
  const { modelAgent } = await import("../src/agents/model.ts");
  assert.equal(modelAgent("jev").info.protocol, "p2-draw");
  assert.equal(modelAgent("msd1", "scaled").info.protocol, "p2-scaled");
});

test("the site's answer methods are exactly the protocol's decoders", async () => {
  const { PUBLIC_DECODERS, DEFAULT_PUBLIC_DECODER } = await import("../src/api/contract.ts");
  assert.deepEqual(Object.keys(PUBLIC_DECODERS).sort(), [...P2.DECODERS].sort());
  assert.equal(DEFAULT_PUBLIC_DECODER, P2.DEFAULT_DECODER);
});
