import test from "node:test";
import assert from "node:assert/strict";
import { MAPS } from "../src/sim/maps.ts";
import * as T from "../src/sim/tuning.ts";
import { checksum, createWorld, setOrders, step } from "../src/sim/world.ts";
import { observe, lineOfSight } from "../src/sim/observe.ts";
import { rng } from "../src/sim/rng.ts";
import { wrapAngle, type Rect } from "../src/sim/math.ts";
import { DRIVE_CMDS, type Shell, type World } from "../src/sim/types.ts";

const EPS = 1e-6;
const mapIds = Object.keys(MAPS);

/** Empty-arena world with tanks placed explicitly. */
function blank(): World {
  const w = createWorld(mapIds[0], 1);
  w.walls = [];
  w.tanks[0].x = 3; w.tanks[0].y = 3; w.tanks[0].heading = 0;
  w.tanks[1].x = T.ARENA_W - 3; w.tanks[1].y = T.ARENA_H - 3; w.tanks[1].heading = Math.PI;
  return w;
}
function shell(w: World, o: Partial<Shell>): Shell {
  const s: Shell = { id: w.nextShellId++, owner: 0, x: 0, y: 0, vx: 0, vy: 0, bounces: 0, age: 0, ...o };
  w.shells.push(s);
  return s;
}
function circleOverlapsRect(x: number, y: number, r: number, k: Rect): boolean {
  const nx = Math.max(k.x, Math.min(x, k.x + k.w)), ny = Math.max(k.y, Math.min(y, k.y + k.h));
  return Math.hypot(x - nx, y - ny) < r - EPS;
}
const mirrorRect = (r: Rect): Rect => ({ x: T.ARENA_W - r.x - r.w, y: T.ARENA_H - r.y - r.h, w: r.w, h: r.h });
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- Fairness / symmetry ----------

test("every map is point-symmetric around the arena center", () => {
  for (const [id, map] of Object.entries(MAPS)) {
    for (const r of map.walls) {
      const m = mirrorRect(r);
      assert.ok(map.walls.some((k) => near(k.x, m.x) && near(k.y, m.y) && near(k.w, m.w) && near(k.h, m.h)), `${id}: wall ${JSON.stringify(r)} has no mirror`);
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= T.ARENA_W && r.y + r.h <= T.ARENA_H, `${id}: wall out of arena`);
    }
    assert.ok(id in MAPS && map.id === id);
  }
});

test("createWorld spawns mirror each other and never overlap walls", () => {
  for (const id of mapIds) {
    for (let seed = 0; seed < 60; seed++) {
      const w = createWorld(id, seed);
      const [a, b] = w.tanks;
      assert.ok(near(a.x + b.x, T.ARENA_W) && near(a.y + b.y, T.ARENA_H), `${id}/${seed}: positions not mirrored`);
      assert.ok(near(Math.abs(wrapAngle(b.heading - a.heading)), Math.PI), `${id}/${seed}: headings not opposite`);
      assert.equal(a.hp, b.hp);
      assert.equal(a.reload, b.reload);
      for (const t of w.tanks) {
        assert.ok(t.x >= T.TANK_RADIUS && t.x <= T.ARENA_W - T.TANK_RADIUS && t.y >= T.TANK_RADIUS && t.y <= T.ARENA_H - T.TANK_RADIUS);
        for (const r of w.walls) assert.ok(!circleOverlapsRect(t.x, t.y, T.TANK_RADIUS, r), `${id}/${seed}: slot ${t.slot} spawns in wall`);
      }
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 2 * T.TANK_RADIUS);
    }
  }
});

test("createWorld rejects unknown maps", () => {
  assert.throws(() => createWorld("no-such-map", 1), /unknown map/);
});

test("mirror-equivalent orders keep the world point-symmetric", () => {
  for (const id of mapIds) {
    for (const seed of [1, 2, 3]) {
      const w = createWorld(id, seed);
      const r = rng(seed * 101);
      const wasFired = [false, false];
      for (let i = 0; i < 400 && !w.over; i++) {
        if (i % 12 === 0) {
          const act = { drive: DRIVE_CMDS[Math.floor(r() * DRIVE_CMDS.length)], turret: r() * 2 - 1, fire: r() < 0.5 };
          setOrders(w, 0, act);
          setOrders(w, 1, act);
        }
        step(w);
        for (const e of w.events) if (e.type === "fire") wasFired[e.slot] = true;
        const [a, b] = w.tanks;
        const ctx = `${id}/${seed} tick ${w.tick}`;
        assert.ok(near(a.x + b.x, T.ARENA_W, 1e-5) && near(a.y + b.y, T.ARENA_H, 1e-5), `${ctx}: tank positions diverge`);
        assert.ok(near(Math.abs(wrapAngle(b.heading - a.heading)), Math.PI, 1e-5) || near(Math.abs(wrapAngle(b.heading - a.heading)), Math.PI - 2 * Math.PI, 1e-5), `${ctx}: headings diverge`);
        assert.ok(near(a.turretRel, b.turretRel, 1e-5), `${ctx}: turrets diverge`);
        assert.equal(a.hp, b.hp, `${ctx}: hp diverges`);
        assert.equal(a.reload, b.reload, `${ctx}: reload diverges`);
        const s0 = w.shells.filter((s) => s.owner === 0), s1 = w.shells.filter((s) => s.owner === 1);
        assert.equal(s0.length, s1.length, `${ctx}: shell counts diverge`);
        s0.forEach((s, k) => assert.ok(near(s.x + s1[k].x, T.ARENA_W, 1e-5) && near(s.y + s1[k].y, T.ARENA_H, 1e-5), `${ctx}: shells diverge`));
      }
      assert.ok(wasFired[0] && wasFired[1], `${id}/${seed}: expected both tanks to fire during symmetry run`);
    }
  }
});

// ---------- Determinism of the sim ----------

test("identical map/seed/orders give identical checksums; different seed differs", () => {
  const run = (id: string, seed: number) => {
    const w = createWorld(id, seed);
    const r = rng(99);
    const sums: string[] = [];
    for (let i = 0; i < 300; i++) {
      if (i % 9 === 0) setOrders(w, (i / 9) % 2 as 0 | 1, { drive: DRIVE_CMDS[Math.floor(r() * 7)], turret: r() * 2 - 1, fire: r() < 0.5 });
      step(w);
      sums.push(checksum(w));
    }
    return sums;
  };
  for (const id of mapIds) {
    assert.deepEqual(run(id, 5), run(id, 5));
    assert.notDeepEqual(run(id, 5), run(id, 6));
  }
});

// ---------- Physics ----------

test("random-drive fuzz: tanks never end a tick inside walls or out of bounds", () => {
  for (const id of mapIds) {
    for (let seed = 0; seed < 25; seed++) {
      const w = createWorld(id, seed);
      const r = rng(seed + 1000);
      for (let i = 0; i < 400 && !w.over; i++) {
        if (i % 5 === 0) for (const slot of [0, 1] as const) setOrders(w, slot, { drive: DRIVE_CMDS[Math.floor(r() * 7)], turret: r() * 2 - 1, fire: r() < 0.3 });
        step(w);
        for (const t of w.tanks) {
          const ctx = `${id}/${seed} tick ${w.tick} slot ${t.slot} at (${t.x.toFixed(3)},${t.y.toFixed(3)})`;
          assert.ok(t.x >= T.TANK_RADIUS - EPS && t.x <= T.ARENA_W - T.TANK_RADIUS + EPS, `${ctx}: x out of bounds`);
          assert.ok(t.y >= T.TANK_RADIUS - EPS && t.y <= T.ARENA_H - T.TANK_RADIUS + EPS, `${ctx}: y out of bounds`);
          for (const k of w.walls) assert.ok(!circleOverlapsRect(t.x, t.y, T.TANK_RADIUS, k), `${ctx}: inside wall ${JSON.stringify(k)}`);
        }
      }
    }
  }
});

test("tank-tank collision keeps tanks separated", () => {
  const w = blank();
  w.tanks[0].x = 14; w.tanks[0].y = 10; w.tanks[0].heading = 0;
  w.tanks[1].x = 18; w.tanks[1].y = 10; w.tanks[1].heading = Math.PI;
  setOrders(w, 0, { drive: "forward", turret: 0, fire: false });
  setOrders(w, 1, { drive: "forward", turret: 0, fire: false });
  for (let i = 0; i < 90; i++) {
    step(w);
    assert.ok(Math.hypot(w.tanks[0].x - w.tanks[1].x, w.tanks[0].y - w.tanks[1].y) >= 2 * T.TANK_RADIUS - 1e-6);
  }
});

test("shells bounce at most SHELL_MAX_BOUNCES times, then expire", () => {
  const w = blank();
  // Small closed box so the shell hits walls quickly; tanks are outside.
  w.walls = [
    { x: 13, y: 7, w: 1, h: 6 }, { x: 18, y: 7, w: 1, h: 6 },
    { x: 13, y: 7, w: 6, h: 1 }, { x: 13, y: 12, w: 6, h: 1 },
  ];
  const s = shell(w, { owner: 0, x: 16, y: 10, vx: T.SHELL_SPEED, vy: T.SHELL_SPEED * 0.4 });
  const sid = s.id;
  let bounces = 0, expired = false;
  for (let i = 0; i < T.SHELL_LIFETIME_TICKS + 2 && !expired; i++) {
    step(w);
    for (const e of w.events) {
      if (e.type === "bounce" && e.shell === sid) bounces++;
      if (e.type === "expire" && e.shell === sid) expired = true;
    }
    const live = w.shells.find((q) => q.id === sid);
    if (live) assert.ok(live.bounces <= T.SHELL_MAX_BOUNCES, "live shell exceeded max bounces");
  }
  assert.ok(expired, "shell never expired");
  assert.ok(bounces <= T.SHELL_MAX_BOUNCES);
  assert.equal(bounces, T.SHELL_MAX_BOUNCES, "boxed shell should use all of its bounces before expiring");
  assert.equal(w.shells.find((q) => q.id === sid), undefined);
});

test("shells expire by lifetime in open space", () => {
  const w = blank();
  shell(w, { owner: 0, x: 16, y: 10, vx: 0, vy: 0 });
  let ex = 0;
  for (let i = 0; i < T.SHELL_LIFETIME_TICKS; i++) { step(w); ex += w.events.filter((e) => e.type === "expire").length; }
  assert.equal(ex, 1);
  assert.equal(w.shells.length, 0);
});

test("a fresh shell cannot hit its owner, a bounced one can", () => {
  for (const [bounces, expectHit] of [[0, false], [1, true]] as const) {
    const w = blank();
    w.tanks[0].x = 16; w.tanks[0].y = 10;
    shell(w, { owner: 0, x: 16.3, y: 10, vx: T.SHELL_SPEED, vy: 0, bounces });
    step(w);
    const hits = w.events.filter((e) => e.type === "hit");
    assert.equal(hits.length, expectHit ? 1 : 0, `bounces=${bounces}`);
    if (expectHit) {
      const h = hits[0];
      assert.ok(h.type === "hit" && h.self && h.victim === 0 && h.hpAfter === T.TANK_HP - 1);
    }
  }
});

test("firing straight at a near wall: shell bounces back and hits its owner (not before the bounce)", { skip: T.SHELL_MAX_BOUNCES < 1 && "needs SHELL_MAX_BOUNCES>=1" }, () => {
  const w = blank();
  const t = w.tanks[0];
  t.x = 16; t.y = 10; t.heading = 0; t.turretRel = 0; t.reload = 0;
  w.walls = [{ x: 16 + T.MUZZLE_OFFSET + 1, y: 5, w: 1, h: 10 }];
  setOrders(w, 0, { drive: "stop", turret: 0, fire: true });
  const seen: string[] = [];
  for (let i = 0; i < 60; i++) {
    step(w);
    for (const e of w.events) seen.push(e.type + (e.type === "hit" ? (e.self ? ":self" : ":other") : ""));
    if (seen.includes("hit:self")) break;
  }
  assert.deepEqual(seen.filter((s) => s !== "end"), ["fire", "bounce", "hit:self"]);
  assert.equal(t.hp, T.TANK_HP - 1);
});

test("two shells colliding emit a clash and both disappear", () => {
  const w = blank();
  const a = shell(w, { owner: 0, x: 10, y: 10, vx: T.SHELL_SPEED, vy: 0 });
  const b = shell(w, { owner: 1, x: 12, y: 10, vx: -T.SHELL_SPEED, vy: 0 });
  let clash: { shells: [number, number] } | undefined;
  for (let i = 0; i < 10 && !clash; i++) {
    step(w);
    clash = w.events.find((e) => e.type === "clash") as typeof clash;
  }
  assert.ok(clash);
  assert.deepEqual([...clash.shells].sort(), [a.id, b.id].sort());
  assert.equal(w.shells.length, 0);
});

test("reload is enforced between shots", () => {
  const w = blank();
  w.tanks[0].heading = -Math.PI / 2; // fire up at the nearby wall; tank 1 is far away
  const fireTicks: number[] = [];
  for (let i = 0; i < T.RELOAD_TICKS * 3 + 5; i++) {
    setOrders(w, 0, { drive: "stop", turret: 0, fire: true });
    step(w);
    for (const e of w.events) if (e.type === "fire" && e.slot === 0) fireTicks.push(e.t);
  }
  assert.equal(fireTicks[0], T.RELOAD_TICKS, "first shot only after initial reload");
  for (let i = 1; i < fireTicks.length; i++) assert.ok(fireTicks[i] - fireTicks[i - 1] >= T.RELOAD_TICKS);
  assert.ok(fireTicks.length >= 2);
});

test("MAX_SHELLS_PER_TANK is enforced, and the fire order waits until a slot frees", () => {
  const w = blank();
  w.tanks[0].reload = 0;
  for (let i = 0; i < T.MAX_SHELLS_PER_TANK; i++) shell(w, { owner: 0, x: 8 + 3 * i, y: 12, vx: 0, vy: 0 });
  setOrders(w, 0, { drive: "stop", turret: 0, fire: true });
  let fired = -1;
  for (let i = 0; i < T.SHELL_LIFETIME_TICKS + 5; i++) {
    step(w);
    const f = w.events.find((e) => e.type === "fire");
    if (f) { fired = w.tick; break; }
    assert.ok(w.shells.filter((s) => s.owner === 0).length <= T.MAX_SHELLS_PER_TANK);
  }
  assert.ok(fired >= T.SHELL_LIFETIME_TICKS, `fired at ${fired}, before blockers expired`);
});

test("a muzzle inside a wall fizzles", () => {
  const w = blank();
  const t = w.tanks[0];
  t.x = 16; t.y = 10; t.heading = 0; t.reload = 0;
  w.walls = [{ x: 16 + T.TANK_RADIUS + 0.02, y: 8, w: 3, h: 4 }]; // touching distance: tank not pushed, muzzle buried
  setOrders(w, 0, { drive: "stop", turret: 0, fire: true });
  step(w);
  assert.equal(w.events.filter((e) => e.type === "fizzle").length, 1);
  assert.equal(w.events.filter((e) => e.type === "fire").length, 0);
  assert.equal(w.shells.length, 0);
  assert.equal(t.reload, T.RELOAD_TICKS);
  assert.equal(t.fireLatch, false);
});

test("the round ends at ROUND_TICKS with the HP-based winner", () => {
  for (const [hp0, hp1, winner] of [[3, 2, 0], [1, 3, 1], [2, 2, null]] as const) {
    const w = blank();
    w.tanks[0].hp = hp0; w.tanks[1].hp = hp1;
    w.tick = T.ROUND_TICKS - 2;
    step(w);
    assert.equal(w.over, false);
    step(w);
    assert.equal(w.over, true);
    assert.equal(w.tick, T.ROUND_TICKS);
    assert.equal(w.winner, winner);
    const end = w.events.find((e) => e.type === "end");
    assert.ok(end && end.type === "end" && end.reason === "time" && end.winner === winner);
    step(w); // stepping a finished world is a no-op
    assert.equal(w.tick, T.ROUND_TICKS);
  }
});

test("destroying a tank ends the round immediately; simultaneous kills are mutual", () => {
  for (const [hp0, hp1, winner, reason] of [[3, 1, 0, "destroyed"], [1, 1, null, "mutual"]] as const) {
    const w = blank();
    w.tanks[0].x = 10; w.tanks[0].y = 10; w.tanks[1].x = 20; w.tanks[1].y = 10;
    w.tanks[0].hp = hp0; w.tanks[1].hp = hp1;
    // shell passing through tank 1 (owner 0); for the mutual case also one through tank 0 (owner 1)
    shell(w, { owner: 0, x: 19.9, y: 10, vx: T.SHELL_SPEED, vy: 0 });
    if (reason === "mutual") shell(w, { owner: 1, x: 9.9, y: 10.0, vx: -T.SHELL_SPEED, vy: 0 });
    step(w);
    assert.ok(w.over, reason);
    assert.equal(w.winner, winner);
    const end = w.events.find((e) => e.type === "end");
    assert.ok(end && end.type === "end" && end.reason === reason);
  }
});

// ---------- Observation ----------

test("bearingFromHullDeg is positive for an enemy to the right of the hull", () => {
  const w = blank();
  w.tanks[0].x = 10; w.tanks[0].y = 10; w.tanks[0].heading = 0; // facing +x, right-hand side is +y
  w.tanks[1].x = 10; w.tanks[1].y = 16;
  assert.ok(Math.abs(observe(w, 0).enemy.bearingFromHullDeg - 90) < 1e-9);
  w.tanks[1].y = 4;
  assert.ok(Math.abs(observe(w, 0).enemy.bearingFromHullDeg + 90) < 1e-9);
  w.tanks[1].x = 20; w.tanks[1].y = 10;
  assert.ok(Math.abs(observe(w, 0).enemy.bearingFromHullDeg) < 1e-9);
  // hull rotated to face +y (south): enemy at +x is on the left
  w.tanks[0].heading = Math.PI / 2;
  assert.ok(Math.abs(observe(w, 0).enemy.bearingFromHullDeg + 90) < 1e-9);
  // slot symmetry: the enemy sees the same geometry from the other side
  w.tanks[0].heading = 0; w.tanks[1].heading = Math.PI; w.tanks[1].x = 10; w.tanks[1].y = 16;
  assert.ok(Math.abs(observe(w, 1).enemy.bearingFromHullDeg - 90) < 1e-9, "enemy above-left of a west-facing tank is to its right");
});

test("aimOffsetDeg is relative to the turret, not the hull", () => {
  const w = blank();
  w.tanks[0].x = 10; w.tanks[0].y = 10; w.tanks[1].x = 20; w.tanks[1].y = 10; // enemy straight along +x
  w.tanks[0].heading = 0.3; w.tanks[0].turretRel = -0.3; // turret points exactly at enemy
  let o = observe(w, 0).enemy;
  assert.ok(Math.abs(o.aimOffsetDeg) < 1e-9);
  assert.ok(Math.abs(o.bearingFromHullDeg - (-0.3 * 180) / Math.PI) < 1e-9);
  w.tanks[0].heading = 0; w.tanks[0].turretRel = 0.5; // turret points right of the enemy => enemy is to the left of the turret
  o = observe(w, 0).enemy;
  assert.ok(Math.abs(o.aimOffsetDeg + (0.5 * 180) / Math.PI) < 1e-9);
  assert.ok(Math.abs(o.bearingFromHullDeg) < 1e-9);
});

test("shotClear and lineOfSight with and without a wall between", () => {
  const w = blank();
  w.tanks[0].x = 8; w.tanks[0].y = 10; w.tanks[1].x = 24; w.tanks[1].y = 10;
  let o = observe(w, 0).enemy;
  assert.equal(o.shotClear, true);
  assert.equal(o.lineOfSight, true);
  w.walls = [{ x: 15, y: 8, w: 2, h: 4 }];
  o = observe(w, 0).enemy;
  assert.equal(o.shotClear, false);
  assert.equal(o.lineOfSight, false);
  assert.equal(lineOfSight(w, w.tanks[0], w.tanks[1]), false);
  // wall off to the side: clear again
  w.walls = [{ x: 15, y: 14, w: 2, h: 4 }];
  o = observe(w, 0).enemy;
  assert.equal(o.shotClear, true);
  assert.equal(o.lineOfSight, true);
  // turret aimed away: no clear shot, but line of sight remains
  w.tanks[0].turretRel = Math.PI / 2;
  o = observe(w, 0).enemy;
  assert.equal(o.shotClear, false);
  assert.equal(o.lineOfSight, true);
  // slightly off-target beyond tank+shell radius: miss
  w.tanks[0].turretRel = Math.atan2(T.TANK_RADIUS + T.SHELL_RADIUS + 1, 16);
  assert.equal(observe(w, 0).enemy.shotClear, false);
});

test("lineOfSight is symmetric and ignores walls not between the tanks", () => {
  const w = blank();
  w.tanks[0].x = 8; w.tanks[0].y = 10; w.tanks[1].x = 24; w.tanks[1].y = 10;
  w.walls = [{ x: 28, y: 8, w: 2, h: 4 }, { x: 2, y: 8, w: 2, h: 4 }];
  assert.equal(observe(w, 0).enemy.lineOfSight, true);
  assert.equal(observe(w, 1).enemy.lineOfSight, true);
  w.walls = [{ x: 15, y: 9, w: 2, h: 2 }];
  assert.equal(observe(w, 0).enemy.lineOfSight, false);
  assert.equal(observe(w, 1).enemy.lineOfSight, false);
});

test("enemy motion labels for constructed movements", () => {
  const w = blank();
  w.tanks[0].x = 10; w.tanks[0].y = 10; w.tanks[1].x = 20; w.tanks[1].y = 10;
  const step_ = 0.1; // m per tick, well above the stationary threshold
  const cases: [number, number, string][] = [
    [0, 0, "stationary"],
    [-step_, 0, "approaching"],
    [step_, 0, "retreating"],
    [0, step_, "moving right"], // facing +x, +y is on the right
    [0, -step_, "moving left"],
  ];
  for (const [dx, dy, label] of cases) {
    w.tanks[1].moved = { dx, dy };
    assert.equal(observe(w, 0).enemy.motion, label, `(${dx},${dy})`);
  }
  // From the other side the same physical movement flips sense: enemy moving +y is moving left from slot 1's view.
  w.tanks[1].moved = { dx: 0, dy: 0 };
  w.tanks[0].moved = { dx: 0, dy: step_ };
  assert.equal(observe(w, 1).enemy.motion, "moving left");
});

test("motion label from real simulation: driving at the observer is 'approaching'", () => {
  const w = blank();
  w.tanks[0].x = 6; w.tanks[0].y = 10; w.tanks[0].heading = 0;
  w.tanks[1].x = 26; w.tanks[1].y = 10; w.tanks[1].heading = Math.PI;
  setOrders(w, 1, { drive: "forward", turret: 0, fire: false });
  step(w);
  assert.equal(observe(w, 0).enemy.motion, "approaching");
  setOrders(w, 1, { drive: "reverse", turret: 0, fire: false });
  step(w);
  assert.equal(observe(w, 0).enemy.motion, "retreating");
  setOrders(w, 1, { drive: "stop", turret: 0, fire: false });
  step(w);
  assert.equal(observe(w, 0).enemy.motion, "stationary");
});

test("threats: an incoming enemy shell is reported; harmless shells are not", () => {
  const w = blank();
  w.tanks[0].x = 10; w.tanks[0].y = 10; w.tanks[0].heading = 0;
  w.tanks[1].x = 28; w.tanks[1].y = 18;
  assert.deepEqual(observe(w, 0).threats, []);
  shell(w, { owner: 1, x: 20, y: 10, vx: -T.SHELL_SPEED, vy: 0 }); // heading right at me
  shell(w, { owner: 1, x: 20, y: 3, vx: -T.SHELL_SPEED, vy: 0 }); // passes well wide
  shell(w, { owner: 1, x: 5, y: 10, vx: -T.SHELL_SPEED, vy: 0 }); // moving away
  const th = observe(w, 0).threats;
  assert.equal(th.length, 1);
  assert.equal(th[0].owner, "enemy");
  assert.ok(Math.abs(th[0].distanceM - 10) < 1e-9);
  assert.ok(Math.abs(th[0].etaS - 1) < 1e-9);
  assert.ok(Math.abs(th[0].bearingFromHullDeg) < 1e-9);
  // Same shell seen from the shooter: its own fresh shell is not a threat to it.
  assert.equal(observe(w, 1).threats.filter((t) => t.owner === "self").length, 0);
});

test("threats: own shells count only after a bounce", () => {
  const w = blank();
  w.tanks[0].x = 10; w.tanks[0].y = 10;
  const s = shell(w, { owner: 0, x: 20, y: 10, vx: -T.SHELL_SPEED, vy: 0, bounces: 0 });
  assert.equal(observe(w, 0).threats.length, 0);
  s.bounces = 1;
  const th = observe(w, 0).threats;
  assert.equal(th.length, 1);
  assert.equal(th[0].owner, "self");
});

test("observation basics: timeLeft, orders, reload, shells in flight, wall distances", () => {
  const w = blank();
  w.tanks[0].x = 10; w.tanks[0].y = 10; w.tanks[0].heading = 0;
  const o = observe(w, 0);
  assert.equal(o.tick, 0);
  assert.equal(o.timeLeftS, T.ROUND_TICKS / T.TICK_HZ);
  assert.equal(o.self.hp, T.TANK_HP);
  assert.equal(o.self.reloadS, T.RELOAD_TICKS / T.TICK_HZ);
  assert.equal(o.self.shellsInFlight, 0);
  assert.ok(Math.abs(o.wallsM.behind - Math.min(10, 10 - T.TANK_RADIUS)) < 1e-9);
  assert.ok(Math.abs(o.wallsM.left - Math.min(10, 10 - T.TANK_RADIUS)) < 1e-9); // left of east-facing = -y
  assert.ok(Math.abs(o.wallsM.right - Math.min(10, T.ARENA_H - 10 - T.TANK_RADIUS)) < 1e-9);
  setOrders(w, 0, { drive: "forward", turret: 0.5, fire: false });
  assert.deepEqual(observe(w, 0).self.orders, { drive: "forward", turret: 0.5, fire: false });
});
