import { angleTo, deg, dist, pointInRect, rayCircle, rayRect, wrapAngle, type Rect, type Vec } from "./math.ts";
import * as T from "./tuning.ts";
import { DRIVE_CMDS, type Action, type DriveCmd, type World } from "./types.ts";
import { moveShell, setOrders, solids, step, turretAngle } from "./world.ts";

/** World-frame pose of a tank (p2+). Metres; headings in degrees 0-360, 0 = +x, 90 = +y (clockwise, y points down). */
export type Pose = { x: number; y: number; hullHeadingDeg: number; turretHeadingDeg: number; vx: number; vy: number };

/** What a shell fired along a given angle would do if both tanks stayed still (shell-shell clashes ignored). */
export type ShotTrace = { result: "direct" | "bank" | "self" | "miss"; timeS: number };

/**
 * Numeric observation. The egocentric fields (angles in degrees, positive = to the right) are what p1 encodes;
 * the world-frame fields (pose, world, shells, shot traces) were added for p2. p1 ignores them.
 */
export type Observation = {
  tick: number;
  timeLeftS: number;
  self: {
    hp: number; reloadS: number; shellsInFlight: number; orders: Action; pose: Pose;
    /** sim-3: what is left of the current step, in degrees (drive = a turn in place). */
    stepLeft: { drive: number; turretDeg: number };
  };
  enemy: {
    pose: Pose;
    reloadS: number;
    shellsInFlight: number;
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
  /** A shell fired now along the turret, traced with the real shell physics. */
  shotNow: ShotTrace;
  /** Smallest turret turn (degrees, positive = right) after which a one-bounce shot would hit; null if none. */
  bankTurnDeg: number | null;
  world: { widthM: number; heightM: number; walls: Rect[] };
  shells: { owner: "enemy" | "self"; x: number; y: number; headingDeg: number; bouncesLeft: number }[];
  /**
   * Shells already in flight, played forward with the real sim for DODGE_HORIZON_S under each drive order (enemy keeps
   * its orders, nobody fires). Seconds until a shell hits you, or null if none does. null overall when no shells fly.
   */
  dodge: { keepCourseHitS: number | null; hitS: Record<DriveCmd, number | null> } | null;
};

export const DODGE_HORIZON_S = 2;

/** Seconds until a shell already in flight hits `slot` if it drives `drive` (null = keep current orders). */
function shellHitTime(w: World, slot: 0 | 1, drive: DriveCmd | null): number | null {
  const c: World = structuredClone(w);
  const me = c.tanks[slot];
  if (drive !== null) setOrders(c, slot, { drive, turret: 0, fire: false });
  else { me.orders = { ...me.orders, fire: false }; }
  for (const t of c.tanks) t.fireLatch = false;
  const existing = new Set(c.shells.map((s) => s.id));
  const t0 = c.tick;
  for (let i = 0; i < DODGE_HORIZON_S * T.TICK_HZ && !c.over; i++) {
    step(c);
    for (const e of c.events) if (e.type === "hit" && e.victim === slot && existing.has(e.shell)) return (c.tick - t0) / T.TICK_HZ;
  }
  return null;
}

function dodgeCheck(w: World, slot: 0 | 1): Observation["dodge"] {
  if (w.shells.length === 0) return null;
  const hitS = {} as Record<DriveCmd, number | null>;
  for (const d of DRIVE_CMDS) hitS[d] = shellHitTime(w, slot, d);
  return { keepCourseHitS: shellHitTime(w, slot, null), hitS };
}

const BANK_SEARCH_STEP_DEG = 1;
const heading360 = (rad: number) => ((deg(rad) % 360) + 360) % 360;

/**
 * Where the turret will point once its current step finishes. A decision is observed on the tick the previous one lands,
 * before that turret step has moved, and the step always finishes before the next answer can land, so every turret fact
 * is reported for the settled aim. sim-2 has no steps (stepLeft.turret is always 0), so this is the current aim there.
 */
export function settledAim(t: World["tanks"][number]): number {
  return wrapAngle(turretAngle(t) + t.stepLeft.turret);
}

function pose(t: World["tanks"][number]): Pose {
  return { x: t.x, y: t.y, hullHeadingDeg: heading360(t.heading), turretHeadingDeg: heading360(settledAim(t)), vx: t.moved.dx / T.DT, vy: t.moved.dy / T.DT };
}

/** Trace a shell fired by `slot` along world angle `ang`, with both tanks frozen. Uses the sim's own shell step. */
export function traceShot(w: World, slot: 0 | 1, ang: number, rects = solids(w)): ShotTrace {
  const me = w.tanks[slot], en = w.tanks[slot === 0 ? 1 : 0];
  const s = { x: me.x + Math.cos(ang) * T.MUZZLE_OFFSET, y: me.y + Math.sin(ang) * T.MUZZLE_OFFSET, vx: Math.cos(ang) * T.SHELL_SPEED, vy: Math.sin(ang) * T.SHELL_SPEED, bounces: 0 };
  if (rects.some((r) => pointInRect(s, r, T.SHELL_RADIUS))) return { result: "miss", timeS: 0 }; // would fizzle
  const reach = T.TANK_RADIUS + T.SHELL_RADIUS, sdt = T.DT / T.SHELL_SUBSTEPS;
  for (let i = 0; i < T.SHELL_LIFETIME_TICKS * T.SHELL_SUBSTEPS; i++) {
    if (moveShell(s, rects, sdt) === "wall") {
      if (s.bounces > T.SHELL_MAX_BOUNCES) return { result: "miss", timeS: (i + 1) * sdt };
      continue;
    }
    if (Math.hypot(en.x - s.x, en.y - s.y) < reach) return { result: s.bounces === 0 ? "direct" : "bank", timeS: (i + 1) * sdt };
    if (s.bounces > 0 && Math.hypot(me.x - s.x, me.y - s.y) < reach) return { result: "self", timeS: (i + 1) * sdt };
  }
  return { result: "miss", timeS: T.SHELL_LIFETIME_TICKS * T.DT };
}

/** Smallest turret turn that lines up a one-bounce hit, searching outward from the current aim in both directions. */
function nearestBank(w: World, slot: 0 | 1, rects: Rect[]): number | null {
  const ta = settledAim(w.tanks[slot]);
  for (let d = 0; d <= 180; d += BANK_SEARCH_STEP_DEG) {
    for (const sign of d === 0 ? [1] : [-1, 1]) {
      if (traceShot(w, slot, ta + ((sign * d) * Math.PI) / 180, rects).result === "bank") return sign * d;
    }
  }
  return null;
}

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
  const ta = settledAim(me);
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
  const rects = solids(w);

  return {
    tick: w.tick,
    timeLeftS: (T.ROUND_TICKS - w.tick) / T.TICK_HZ,
    self: {
      hp: me.hp,
      reloadS: me.reload / T.TICK_HZ,
      shellsInFlight: w.shells.filter((s) => s.owner === slot).length,
      orders: { ...me.orders },
      pose: pose(me),
      stepLeft: {
        drive: deg(me.stepLeft.drive),
        turretDeg: deg(me.stepLeft.turret),
      },
    },
    enemy: {
      pose: pose(en),
      reloadS: en.reload / T.TICK_HZ,
      shellsInFlight: w.shells.filter((s) => s.owner !== slot).length,
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
    shotNow: traceShot(w, slot, ta, rects),
    bankTurnDeg: nearestBank(w, slot, rects),
    world: { widthM: T.ARENA_W, heightM: T.ARENA_H, walls: w.walls.map((r) => ({ ...r })) },
    dodge: dodgeCheck(w, slot),
    shells: w.shells.map((s) => ({
      owner: s.owner === slot ? "self" : "enemy",
      x: s.x, y: s.y,
      headingDeg: heading360(Math.atan2(s.vy, s.vx)),
      bouncesLeft: Math.max(0, T.SHELL_MAX_BOUNCES - s.bounces),
    })),
  };
}
