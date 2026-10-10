import type { Rect } from "./math.ts";

export const DRIVE_CMDS = ["forward", "forward_left", "forward_right", "reverse", "turn_left", "turn_right", "stop"] as const;
export type DriveCmd = (typeof DRIVE_CMDS)[number];

/** Orders a tank follows until replaced. turret is a rotation rate in [-1, 1] (positive = clockwise/right). */
export type Action = { drive: DriveCmd; turret: number; fire: boolean };

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
