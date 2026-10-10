import { angleTo, deg, dist, rayCircle, rayRect, wrapAngle, type Vec } from "./math.ts";
import * as T from "./tuning.ts";
import type { Action, World } from "./types.ts";
import { solids, turretAngle } from "./world.ts";

/** Numeric, egocentric observation. Angles in degrees, positive = to the right. */
export type Observation = {
  tick: number;
  timeLeftS: number;
  self: { hp: number; reloadS: number; shellsInFlight: number; orders: Action };
  enemy: {
    hp: number;
    distanceM: number;
    lineOfSight: boolean;
    bearingFromHullDeg: number; // where the enemy is relative to your hull front
    aimOffsetDeg: number; // where the enemy is relative to your turret
    shotClear: boolean; // a shell fired now along the turret would hit the enemy before any wall
    motion: "stationary" | "approaching" | "retreating" | "moving left" | "moving right";
  };
  threats: { owner: "enemy" | "self"; distanceM: number; bearingFromHullDeg: number; etaS: number }[];
  wallsM: { ahead: number; behind: number; left: number; right: number };
};

const WALL_CAP = 10;

function castWalls(w: World, o: Vec, ang: number): number {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let best = Infinity;
  for (const r of solids(w)) best = Math.min(best, rayRect(o, dx, dy, r));
  return Math.min(WALL_CAP, Math.max(0, best - T.TANK_RADIUS));
}

export function lineOfSight(w: World, a: Vec, b: Vec): boolean {
  const d = dist(a, b);
  if (d < 1e-6) return true;
  const dx = (b.x - a.x) / d, dy = (b.y - a.y) / d;
  return !w.walls.some((r) => rayRect(a, dx, dy, r) < d);
}

export function observe(w: World, slot: 0 | 1): Observation {
  const me = w.tanks[slot];
  const en = w.tanks[slot === 0 ? 1 : 0];
  const toEnemy = angleTo(me, en);
  const d = dist(me, en);

  // Turret ray: does it hit the enemy before a wall?
  const ta = turretAngle(me);
  const tdx = Math.cos(ta), tdy = Math.sin(ta);
  const tHit = rayCircle(me, tdx, tdy, en, T.TANK_RADIUS + T.SHELL_RADIUS);
  let tWall = Infinity;
  for (const r of solids(w)) tWall = Math.min(tWall, rayRect(me, tdx, tdy, r));

  // Enemy motion relative to the line between tanks.
  const mv = en.moved;
  const speed = Math.hypot(mv.dx, mv.dy) / T.DT;
  let motion: Observation["enemy"]["motion"] = "stationary";
  if (speed > 0.3) {
    const ux = (en.x - me.x) / (d || 1), uy = (en.y - me.y) / (d || 1);
    const radial = (mv.dx * ux + mv.dy * uy) / T.DT;
    const lateral = (mv.dx * -uy + mv.dy * ux) / T.DT; // positive = clockwise around me = moving to my right as I face it
    if (Math.abs(radial) >= Math.abs(lateral)) motion = radial < 0 ? "approaching" : "retreating";
    else motion = lateral > 0 ? "moving right" : "moving left";
  }

  // Threats: shells whose straight path passes within reach of me in the next 2 s.
  const threats: Observation["threats"] = [];
  for (const s of w.shells) {
    if (s.owner === slot && s.bounces === 0) continue;
    const rx = me.x - s.x, ry = me.y - s.y;
    const v2 = s.vx * s.vx + s.vy * s.vy;
    const tClosest = (rx * s.vx + ry * s.vy) / v2;
    if (tClosest < 0 || tClosest > 2) continue;
    const cx = s.x + s.vx * tClosest - me.x, cy = s.y + s.vy * tClosest - me.y;
    if (Math.hypot(cx, cy) > T.TANK_RADIUS + 1.0) continue;
    threats.push({
      owner: s.owner === slot ? "self" : "enemy",
      distanceM: Math.hypot(rx, ry),
      bearingFromHullDeg: deg(wrapAngle(angleTo(me, s) - me.heading)),
      etaS: tClosest,
    });
  }
  threats.sort((x, y) => x.etaS - y.etaS);

  return {
    tick: w.tick,
    timeLeftS: (T.ROUND_TICKS - w.tick) / T.TICK_HZ,
    self: {
      hp: me.hp,
      reloadS: me.reload / T.TICK_HZ,
      shellsInFlight: w.shells.filter((s) => s.owner === slot).length,
      orders: { ...me.orders },
    },
    enemy: {
      hp: en.hp,
      distanceM: d,
      lineOfSight: lineOfSight(w, me, en),
      bearingFromHullDeg: deg(wrapAngle(toEnemy - me.heading)),
      aimOffsetDeg: deg(wrapAngle(toEnemy - ta)),
      shotClear: tHit < tWall,
      motion,
    },
    threats: threats.slice(0, 2),
    wallsM: {
      ahead: castWalls(w, me, me.heading),
      behind: castWalls(w, me, me.heading + Math.PI),
      left: castWalls(w, me, me.heading - Math.PI / 2),
      right: castWalls(w, me, me.heading + Math.PI / 2),
    },
  };
}
