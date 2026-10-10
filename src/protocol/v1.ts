// Protocol v1: the ONLY channel between the game and a decision model. Identical for every model.
// Any change to wording, fields, questions or decoding must bump PROTOCOL_VERSION.
import type { Observation } from "../sim/observe.ts";
import { DRIVE_CMDS, type Action, type DriveCmd } from "../sim/types.ts";

export const PROTOCOL_VERSION = "p1";

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence?: number; legend?: Record<string, string> };

export type Answers = Record<string, Answer>;

const RULES =
  "Real-time top-down tank duel, you vs one enemy tank. Goal: destroy the enemy before time runs out. Shells bounce off walls once and can hit you after a bounce. " +
  "Each hit removes 1 HP; 0 HP loses. When time runs out, more HP wins and equal HP is a draw. Your turret rotates independently of your hull. " +
  "Your orders keep executing until your next decision arrives, and the game keeps running while you think.";

const DRIVE_CRITERIA: Record<DriveCmd, string> = {
  forward: "Drive straight forward",
  forward_left: "Drive forward while curving left",
  forward_right: "Drive forward while curving right",
  reverse: "Back up",
  turn_left: "Rotate hull left in place",
  turn_right: "Rotate hull right in place",
  stop: "Stop the hull",
};

export const TURRET_LEVELS = ["hard left", "left", "slight left", "hold", "slight right", "right", "hard right"];
export const TURRET_VALUES = [-1, -0.5, -0.2, 0, 0.2, 0.5, 1];

const side = (d: number, near = 2) => (Math.abs(d) < near ? "dead ahead" : `${Math.round(Math.abs(d))}° ${d > 0 ? "right" : "left"}`);
const m = (x: number) => Math.round(x * 10) / 10;

function describeOrders(o: Action): string {
  const turret =
    Math.abs(o.turret) < 0.05 ? "turret holding" : `turret turning ${o.turret > 0 ? "right" : "left"} at ${Math.round(Math.abs(o.turret) * 100)}% speed`;
  return `${o.drive.replace("_", " ")}, ${turret}${o.fire ? ", fire order pending" : ""}`;
}

/** Model-facing state. Plain language, egocentric, no raw coordinates. */
export function encodeState(o: Observation): Record<string, unknown> {
  return {
    rules: RULES,
    time_left_s: Math.round(o.timeLeftS),
    you: {
      hp: o.self.hp,
      reload: o.self.reloadS <= 0 ? "ready to fire" : `ready in ${o.self.reloadS.toFixed(1)}s`,
      your_shells_in_flight: o.self.shellsInFlight,
      current_orders: describeOrders(o.self.orders),
    },
    enemy: {
      hp: o.enemy.hp,
      distance_m: m(o.enemy.distanceM),
      line_of_sight: o.enemy.lineOfSight,
      direction_from_hull: side(o.enemy.bearingFromHullDeg),
      direction_from_turret: side(o.enemy.aimOffsetDeg),
      shot_would_hit_if_enemy_stayed_still: o.enemy.shotClear,
      motion: o.enemy.motion,
    },
    incoming_shells:
      o.threats.length === 0
        ? "none"
        : o.threats.map((t) => ({
            from: t.owner === "enemy" ? "enemy" : "your own bounced shell",
            direction_from_hull: side(t.bearingFromHullDeg, 5),
            distance_m: m(t.distanceM),
            impact_in_s: Math.round(t.etaS * 10) / 10,
          })),
    walls_distance_m: {
      ahead: m(o.wallsM.ahead),
      behind: m(o.wallsM.behind),
      left: m(o.wallsM.left),
      right: m(o.wallsM.right),
    },
  };
}

/**
 * Questions carry the one fact each decision hinges on, so models don't have to pick the right field out of the state.
 * Wording is identical for every model; only the numbers change.
 */
export function buildQuestions(o: Observation): Record<string, Question> {
  const e = o.enemy;
  const reload = o.self.reloadS <= 0 ? "ready" : `ready in ${o.self.reloadS.toFixed(1)}s`;
  return {
    drive: {
      type: "choice",
      instructions: `The enemy is ${side(e.bearingFromHullDeg)} of your hull's front, ${m(e.distanceM)} m away. How should your hull drive until your next decision?`,
      criteria: DRIVE_CRITERIA,
    },
    turret: {
      type: "score",
      instructions: `The enemy is ${side(e.aimOffsetDeg)} of where your turret points (enemy motion: ${e.motion}). How should your turret rotate until your next decision?`,
      criteria: TURRET_LEVELS,
    },
    fire: {
      type: "noul",
      instructions: `Your turret is ${Math.round(Math.abs(e.aimOffsetDeg))}° off the enemy, a shot fired now ${e.shotClear ? "would hit if the enemy stayed still" : "would miss or hit a wall"}, and your reload is ${reload}. Should you fire a shell now?`,
    },
  };
}

export type Decoded = { action: Action; detail: { driveP: Record<string, number>; turretP: Record<string, number>; fireP: number } };

/** Decoding policy (fixed for v1): drive = argmax, turret = expected rotation over the level distribution, fire = p >= 0.5. */
export function decode(ans: Answers): Decoded {
  const drive = ans.drive, turret = ans.turret, fire = ans.fire;
  if (drive?.type !== "choice" || turret?.type !== "score" || fire?.type !== "noul") throw new Error("malformed answers");

  let best: DriveCmd = "stop", bestP = -1;
  for (const [k, p] of Object.entries(drive.probabilities)) {
    if ((DRIVE_CMDS as readonly string[]).includes(k) && p > bestP) { best = k as DriveCmd; bestP = p; }
  }

  // Score probabilities may be keyed by index ("0".."6") or by label; normalise to index.
  const tp: Record<string, number> = {};
  let total = 0, ev = 0;
  for (const [k, p] of Object.entries(turret.probabilities)) {
    const idx = /^\d+$/.test(k) ? Number(k) : TURRET_LEVELS.indexOf(k);
    if (idx < 0 || idx >= TURRET_VALUES.length) continue;
    tp[TURRET_LEVELS[idx]] = p;
    total += p;
    ev += p * TURRET_VALUES[idx];
  }
  const turretRate = total > 0 ? ev / total : 0;

  return {
    action: { drive: best, turret: turretRate, fire: fire.noul >= 0.5 },
    detail: { driveP: drive.probabilities, turretP: tp, fireP: fire.noul },
  };
}
