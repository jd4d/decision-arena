import { MAPS } from "./maps.ts";
import { clamp, pointInRect, pushCircleOutOfRect, wrapAngle, type Rect } from "./math.ts";
import { hashString, rng } from "./rng.ts";
import * as T from "./tuning.ts";
import { IDLE_ACTION, type Action, type Shell, type SimEvent, type Tank, type World } from "./types.ts";

const BOUNDS: Rect[] = [
  { x: -1, y: -1, w: T.ARENA_W + 2, h: 1 },
  { x: -1, y: T.ARENA_H, w: T.ARENA_W + 2, h: 1 },
  { x: -1, y: 0, w: 1, h: T.ARENA_H },
  { x: T.ARENA_W, y: 0, w: 1, h: T.ARENA_H },
];

export function solids(w: World): Rect[] {
  return w.walls.concat(BOUNDS);
}

function makeTank(slot: 0 | 1, x: number, y: number, heading: number): Tank {
  return { slot, x, y, heading, turretRel: 0, hp: T.TANK_HP, reload: T.RELOAD_TICKS, orders: { ...IDLE_ACTION }, fireLatch: false, moved: { dx: 0, dy: 0 }, stepLeft: { drive: 0, turret: 0 } };
}

/** `sim` picks the rules version (default: current). Replays pass the version recorded in the log header. */
export function createWorld(mapId: string, seed: number, sim: string = T.SIM_VERSION): World {
  const map = MAPS[mapId];
  if (!map) throw new Error(`unknown map ${mapId}`);
  if (!(T.SIM_VERSIONS as readonly string[]).includes(sim)) throw new Error(`unsupported sim version ${sim}`);
  const r = rng(seed ^ hashString(mapId));
  const y0 = 5.5 + r() * 9;
  const h0 = (r() - 0.5) * 0.6; // slight random initial facing, mirrored for fairness
  return {
    sim: sim as T.SimVersion,
    tick: 0,
    mapId,
    walls: map.walls.map((w) => ({ ...w })),
    tanks: [makeTank(0, 3, y0, h0), makeTank(1, T.ARENA_W - 3, T.ARENA_H - y0, wrapAngle(Math.PI + h0))],
    shells: [],
    nextShellId: 1,
    events: [],
    over: false,
    winner: null,
  };
}

export function setOrders(w: World, slot: 0 | 1, action: Action): void {
  const t = w.tanks[slot];
  t.orders = { drive: action.drive, turret: clamp(action.turret, -1, 1), fire: action.fire };
  if (action.throttle !== undefined && w.sim !== "sim-2") t.orders.throttle = clamp(action.throttle, 0, 1);
  t.fireLatch = action.fire;
  if (w.sim !== "sim-2") t.stepLeft = { drive: driveStepped(w, t.orders.drive) ? T.HULL_TURN_STEP * (t.orders.throttle ?? 1) : 0, turret: t.orders.turret * T.TURRET_STEP_MAX };
}

/** Whether a drive order is a fixed step: turning in place in sim-3; nothing in sim-2. */
function driveStepped(w: World, cmd: Action["drive"]): boolean {
  return w.sim !== "sim-2" && (cmd === "turn_left" || cmd === "turn_right");
}

function driveParams(cmd: Action["drive"]): [speed: number, turn: number] {
  switch (cmd) {
    case "forward": return [T.TANK_SPEED, 0];
    case "forward_left": return [T.TANK_ARC_SPEED, -T.HULL_ARC_TURN_RATE];
    case "forward_right": return [T.TANK_ARC_SPEED, T.HULL_ARC_TURN_RATE];
    case "reverse": return [-T.TANK_REVERSE_SPEED, 0];
    case "turn_left": return [0, -T.HULL_TURN_RATE];
    case "turn_right": return [0, T.HULL_TURN_RATE];
    default: return [0, 0];
  }
}

export function turretAngle(t: Tank): number {
  return wrapAngle(t.heading + t.turretRel);
}

/**
 * One shell substep: move, or reflect off a wall (counting the bounce) and stay put. Shared by step() and the
 * observation's shot trace so predicted bounces match real ones exactly.
 */
export function moveShell(s: { x: number; y: number; vx: number; vy: number; bounces: number }, rects: Rect[], sdt: number): "moved" | "wall" {
  const nx = s.x + s.vx * sdt, ny = s.y + s.vy * sdt;
  const hitRect = rects.find((r) => pointInRect({ x: nx, y: ny }, r, T.SHELL_RADIUS));
  if (!hitRect) { s.x = nx; s.y = ny; return "moved"; }
  const pad = T.SHELL_RADIUS;
  const outX = s.x <= hitRect.x - pad || s.x >= hitRect.x + hitRect.w + pad;
  const outY = s.y <= hitRect.y - pad || s.y >= hitRect.y + hitRect.h + pad;
  if (outX) s.vx = -s.vx;
  if (outY) s.vy = -s.vy;
  if (!outX && !outY) { s.vx = -s.vx; s.vy = -s.vy; }
  s.bounces++;
  return "wall";
}

export function step(w: World): void {
  w.events = [];
  if (w.over) return;
  w.tick++;
  const ev = (e: SimEvent) => w.events.push(e);
  const rects = solids(w);

  // Tanks: drive, collide, turret.
  for (const t of w.tanks) {
    if (t.reload > 0) t.reload--;
    let [speed, turn] = driveParams(t.orders.drive);
    let turretRate = t.orders.turret * T.TURRET_TURN_RATE;
    if (w.sim !== "sim-2") {
      // Fixed steps: run at full rate, clipped to what is left of the step; when a step is used up, that part stops.
      if (!driveStepped(w, t.orders.drive) && t.orders.throttle !== undefined) { speed *= t.orders.throttle; turn *= t.orders.throttle; }
      if (driveStepped(w, t.orders.drive)) {
        const per = Math.abs(turn) * T.DT;
        const f = per > 0 ? Math.min(1, t.stepLeft.drive / per) : 0;
        speed *= f; turn *= f;
        t.stepLeft.drive = Math.max(0, t.stepLeft.drive - per * f);
        if (t.stepLeft.drive <= 1e-9) { t.stepLeft.drive = 0; t.orders.drive = "stop"; }
      }
      const tPer = T.TURRET_TURN_RATE * T.DT;
      const tMove = Math.sign(t.stepLeft.turret) * Math.min(Math.abs(t.stepLeft.turret), tPer);
      turretRate = tMove / T.DT;
      t.stepLeft.turret -= tMove;
      if (Math.abs(t.stepLeft.turret) <= 1e-9) { t.stepLeft.turret = 0; t.orders.turret = 0; }
    }
    const px = t.x, py = t.y;
    t.heading = wrapAngle(t.heading + turn * T.DT);
    t.x += Math.cos(t.heading) * speed * T.DT;
    t.y += Math.sin(t.heading) * speed * T.DT;
    for (let i = 0; i < 2; i++) for (const r of rects) pushCircleOutOfRect(t, T.TANK_RADIUS, r);
    t.moved = { dx: t.x - px, dy: t.y - py };
    // sim-3: the turret is stabilised, so a hull turn is cancelled out of the turret's angle relative to the hull.
    t.turretRel = w.sim === "sim-3" ? wrapAngle(t.turretRel + turretRate * T.DT - turn * T.DT) : wrapAngle(t.turretRel + turretRate * T.DT);
  }
  const [a, b] = w.tanks;
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), minD = T.TANK_RADIUS * 2;
  if (d < minD && d > 1e-9) {
    const push = (minD - d) / 2, ux = dx / d, uy = dy / d;
    a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
    for (const t of w.tanks) for (const r of rects) pushCircleOutOfRect(t, T.TANK_RADIUS, r);
  }

  // Firing.
  for (const t of w.tanks) {
    if (!t.fireLatch || t.reload > 0) continue;
    if (w.shells.filter((s) => s.owner === t.slot).length >= T.MAX_SHELLS_PER_TANK) continue;
    const ang = turretAngle(t);
    const mx = t.x + Math.cos(ang) * T.MUZZLE_OFFSET, my = t.y + Math.sin(ang) * T.MUZZLE_OFFSET;
    t.fireLatch = false;
    t.reload = T.RELOAD_TICKS;
    if (rects.some((r) => pointInRect({ x: mx, y: my }, r, T.SHELL_RADIUS))) {
      ev({ t: w.tick, type: "fizzle", slot: t.slot });
      continue;
    }
    const s: Shell = { id: w.nextShellId++, owner: t.slot, x: mx, y: my, vx: Math.cos(ang) * T.SHELL_SPEED, vy: Math.sin(ang) * T.SHELL_SPEED, bounces: 0, age: 0 };
    w.shells.push(s);
    ev({ t: w.tick, type: "fire", slot: t.slot, shell: s.id });
  }

  // Shells: substepped movement, wall bounces, tank hits, shell clashes.
  const dead = new Set<number>();
  const sdt = T.DT / T.SHELL_SUBSTEPS;
  for (let sub = 0; sub < T.SHELL_SUBSTEPS; sub++) {
    for (const s of w.shells) {
      if (dead.has(s.id)) continue;
      if (moveShell(s, rects, sdt) === "wall") {
        if (s.bounces > T.SHELL_MAX_BOUNCES) {
          dead.add(s.id);
          ev({ t: w.tick, type: "expire", shell: s.id, owner: s.owner });
        } else ev({ t: w.tick, type: "bounce", shell: s.id, owner: s.owner, x: s.x, y: s.y });
        continue; // stay at previous position this substep
      }
      for (const t of w.tanks) {
        if (t.slot === s.owner && s.bounces === 0) continue; // fresh shells can't hit their owner
        if (Math.hypot(t.x - s.x, t.y - s.y) < T.TANK_RADIUS + T.SHELL_RADIUS) {
          t.hp = Math.max(0, t.hp - 1);
          dead.add(s.id);
          ev({ t: w.tick, type: "hit", shell: s.id, owner: s.owner, victim: t.slot, self: t.slot === s.owner, x: s.x, y: s.y, hpAfter: t.hp });
          break;
        }
      }
    }
    for (let i = 0; i < w.shells.length; i++) {
      const p = w.shells[i];
      if (dead.has(p.id)) continue;
      for (let j = i + 1; j < w.shells.length; j++) {
        const q = w.shells[j];
        if (dead.has(q.id)) continue;
        if (Math.hypot(p.x - q.x, p.y - q.y) < T.SHELL_RADIUS * 3) {
          dead.add(p.id); dead.add(q.id);
          ev({ t: w.tick, type: "clash", shells: [p.id, q.id], x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
          break;
        }
      }
    }
  }
  for (const s of w.shells) {
    s.age++;
    if (!dead.has(s.id) && s.age >= T.SHELL_LIFETIME_TICKS) {
      dead.add(s.id);
      ev({ t: w.tick, type: "expire", shell: s.id, owner: s.owner });
    }
  }
  w.shells = w.shells.filter((s) => !dead.has(s.id));

  // Round end.
  const [h0, h1] = [a.hp, b.hp];
  if (h0 <= 0 || h1 <= 0) {
    w.over = true;
    w.winner = h0 <= 0 && h1 <= 0 ? null : h0 <= 0 ? 1 : 0;
    ev({ t: w.tick, type: "end", winner: w.winner, reason: w.winner === null ? "mutual" : "destroyed" });
  } else if (w.tick >= T.ROUND_TICKS) {
    w.over = true;
    w.winner = h0 === h1 ? null : h0 > h1 ? 0 : 1;
    ev({ t: w.tick, type: "end", winner: w.winner, reason: "time" });
  }
}

/** Compact deterministic fingerprint of the world, used to verify replays. */
export function checksum(w: World): string {
  const parts: string[] = [String(w.tick)];
  for (const t of w.tanks) parts.push(t.x.toFixed(5), t.y.toFixed(5), t.heading.toFixed(5), t.turretRel.toFixed(5), String(t.hp), String(t.reload));
  for (const s of w.shells) parts.push(String(s.id), s.x.toFixed(5), s.y.toFixed(5));
  return hashString(parts.join("|")).toString(36);
}
