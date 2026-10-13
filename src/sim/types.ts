import type { Rect } from "./math.ts";
import type { SimVersion } from "./tuning.ts";

export const DRIVE_CMDS = ["forward", "forward_left", "forward_right", "reverse", "turn_left", "turn_right", "stop"] as const;
export type DriveCmd = (typeof DRIVE_CMDS)[number];

/**
 * Orders a tank follows until replaced. turret is a rotation rate in [-1, 1] (sim-2) or a step fraction (sim-3);
 * positive = clockwise/right. throttle (sim-3, optional, default 1) scales drive speed and arc turning, and the size of a
 * turn-in-place step; only the confidence-scaled decoder sets it.
 */
export type Action = { drive: DriveCmd; turret: number; fire: boolean; throttle?: number };

export const IDLE_ACTION: Action = { drive: "stop", turret: 0, fire: false };

export type Tank = {
  slot: 0 | 1;
  x: number;
  y: number;
  heading: number; // hull angle (rad)
  turretRel: number; // turret angle relative to hull (rad)
  hp: number;
  reload: number; // ticks until able to fire
  orders: Action;
  fireLatch: boolean; // fire order waiting to be executed
  moved: { dx: number; dy: number }; // displacement last tick
  /** sim-3: what is left of the current step. drive = radians of a turn in place; turret = signed radians. */
  stepLeft: { drive: number; turret: number };
};

export type Shell = {
  id: number;
  owner: 0 | 1;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
  age: number;
};

export type SimEvent =
  | { t: number; type: "fire"; slot: 0 | 1; shell: number }
  | { t: number; type: "fizzle"; slot: 0 | 1 }
  | { t: number; type: "bounce"; shell: number; owner: 0 | 1; x: number; y: number }
  | { t: number; type: "hit"; shell: number; owner: 0 | 1; victim: 0 | 1; self: boolean; x: number; y: number; hpAfter: number }
  | { t: number; type: "clash"; shells: [number, number]; x: number; y: number }
  | { t: number; type: "expire"; shell: number; owner: 0 | 1 }
  | { t: number; type: "end"; winner: 0 | 1 | null; reason: "destroyed" | "time" | "mutual" };

export type World = {
  sim: SimVersion;
  tick: number;
  mapId: string;
  walls: Rect[];
  tanks: [Tank, Tank];
  shells: Shell[];
  nextShellId: number;
  events: SimEvent[]; // events emitted during the most recent step
  over: boolean;
  winner: 0 | 1 | null;
};
