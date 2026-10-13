// Protocol p2 (for sim-3), full information: the map, both tanks' positions, headings, velocities and reload, every
// shell in flight, a bounce-aware shot trace, and the p1 egocentric facts. Driving is continuous until replaced, turning
// in place is one 30° step, the turret moves in fixed steps and is stabilised. The drive question carries a dodge fact
// computed with the real sim (which drive orders a shell already in flight would hit), and "ahead" means within half a
// turn step. Every action is drawn from the model's own probabilities (see decode).
// Identical for every model. p1 (v1.ts) is frozen.
// Any change to wording, fields, questions or decoding must bump PROTOCOL_VERSION (and become a new file).
import type { Observation, Pose, ShotTrace } from "../sim/observe.ts";
import * as T from "../sim/tuning.ts";
import type { Action, DriveCmd } from "../sim/types.ts";
import { DRIVE_CMDS } from "../sim/types.ts";
import { TURRET_VALUES, type Answers, type Decoded, type Question } from "./v1.ts";
import { DODGE_HORIZON_S } from "../sim/observe.ts";
import { hashString, rng } from "../sim/rng.ts";

export { TURRET_VALUES, type Answer, type Answers, type Decoded, type Question } from "./v1.ts";

export const PROTOCOL_VERSION = "p2";

/**
 * Decoder variants under test (same state and questions, different answer-to-action rule). Each logs its own protocol
 * label ("p2-draw", "p2-scaled") so results stay separate and filterable. See decode().
 */
export const DECODERS = ["draw", "scaled"] as const;
export type Decoder = (typeof DECODERS)[number];
export const DEFAULT_DECODER: Decoder = "draw";
export const protocolLabel = (d: Decoder) => `${PROTOCOL_VERSION}-${d}`;
/** The protocol label of the live pool (what the site runs and summarizes by default). */
export const CURRENT_PROTOCOL = protocolLabel(DEFAULT_DECODER);
/** Confidence-scaled decoder: fire only when the fire probability reaches this bar (Jesse, 2026-10-13). */
export const SCALED_FIRE_BAR = 0.6;
/** Which sim version this protocol's wording describes. */
export const PROTOCOL_SIM = "sim-3";

const r1 = (x: number) => Math.round(x * 10) / 10;
const deg = (rad: number) => Math.round((rad * 180) / Math.PI);
const TURN_STEP_DEG = deg(T.HULL_TURN_STEP);
/** The enemy counts as "ahead" within half a turn step, so no model is asked to align closer than one turn can. */
const AHEAD_DEG = TURN_STEP_DEG / 2;

/** Turret levels are fixed step sizes (p1's values as fractions of the largest step), labelled in degrees. */
export const TURRET_LEVELS = TURRET_VALUES.map((v) => (v === 0 ? "hold" : `${deg(Math.abs(v) * T.TURRET_STEP_MAX)}° ${v < 0 ? "left" : "right"}`));
const HOLD = TURRET_VALUES.indexOf(0);

const RULES =
  "Real-time top-down tank duel, you vs one enemy tank. Goal: destroy the enemy before time runs out. Each hit removes 1 HP; 0 HP loses. " +
  "When time runs out, more HP wins and equal HP is a draw. " +
  `Map: the arena is ${T.ARENA_W} m wide (x) by ${T.ARENA_H} m tall (y) with walls all round, plus the interior walls listed in arena.walls (rectangles given by their x and y ranges). ` +
  "Positions are metres from the top-left corner and y increases downward. Headings are degrees: 0° points toward +x, 90° toward +y, 180° toward -x, 270° toward -y, so a larger heading is a turn to the right. " +
  `Shells fly straight from your turret at ${T.SHELL_SPEED} m/s and bounce off walls exactly once (angle in equals angle out). ` +
  `A shell is destroyed when it touches a wall for the second time, hits a tank, touches another shell, or after ${T.SHELL_LIFETIME_TICKS / T.TICK_HZ} s. ` +
  "A shell that has already bounced can hit either tank, including the one that fired it, so banked shots can hit an enemy behind cover but can also come back at you. " +
  `You can have at most ${T.MAX_SHELLS_PER_TANK} shells in flight and reloading takes ${(T.RELOAD_TICKS / T.TICK_HZ).toFixed(1)} s. ` +
  `Hull: forward ${T.TANK_SPEED} m/s (${T.TANK_ARC_SPEED} m/s while curving, turning ${deg(T.HULL_ARC_TURN_RATE)}°/s), reverse ${T.TANK_REVERSE_SPEED} m/s. ` +
  "Driving orders (forward, curves, reverse, stop) keep executing until your next decision lands. " +
  `Rotating in place is a single ${TURN_STEP_DEG}° step, after which the hull stops. Turret orders are single steps (sizes in the options), after which the turret holds. ` +
  "A turret step always finishes before your next decision lands, so every turret direction, heading and shot check you are given already assumes your current turret step is complete. " +
  "Your turret is stabilised: it keeps pointing the same way on the map while your hull turns, so only turret orders change your aim. " +
  "A new decision replaces your current orders. The game keeps running while you think. A moving tank is harder to hit, and a shell in flight can be dodged.";

const DRIVE_CRITERIA: Record<DriveCmd, string> = {
  forward: "Drive straight forward (keeps going until your next decision)",
  forward_left: "Drive forward while curving left",
  forward_right: "Drive forward while curving right",
  reverse: "Back up straight (keeps going until your next decision)",
  turn_left: `Stop and rotate the hull ${TURN_STEP_DEG}° left in place`,
  turn_right: `Stop and rotate the hull ${TURN_STEP_DEG}° right in place`,
  stop: "Stop the hull",
};

const side = (d: number, near = 2) => (Math.abs(d) < near ? "dead ahead" : `${Math.round(Math.abs(d))}° ${d > 0 ? "right" : "left"}`);
const hullSide = (d: number) => (Math.abs(d) < AHEAD_DEG ? `ahead of your hull (within ${AHEAD_DEG}°)` : `${Math.round(Math.abs(d))}° ${d > 0 ? "right" : "left"} of your hull's front`);

const s1 = (x: number) => x.toFixed(1);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** One sentence about shells already in flight, from the sim's own playout of each drive order. */
export function dodgeText(o: Observation): string {
  const d = o.dodge;
  if (!d) return "No shells are in flight.";
  const hit = DRIVE_CMDS.filter((c) => d.hitS[c] !== null), safe = DRIVE_CMDS.filter((c) => d.hitS[c] === null);
  if (d.keepCourseHitS !== null) {
    return `A shell will hit you in ${s1(d.keepCourseHitS)} s if you keep your current course; ` +
      (safe.length ? `${list(safe)} would avoid it.` : "no drive order avoids it.");
  }
  if (hit.length === 0) return `No shell in flight will hit you in the next ${DODGE_HORIZON_S} s.`;
  return `No shell hits you on your current course, but ${list(hit)} would drive you into one.`;
}
const reloadText = (s: number) => (s <= 0 ? "ready to fire" : `ready in ${s.toFixed(1)}s`);

const COURSE: Record<DriveCmd, string> = {
  forward: "driving forward", forward_left: "curving left", forward_right: "curving right", reverse: "reversing",
  turn_left: "rotating left in place", turn_right: "rotating right in place", stop: "stopped",
};

/**
 * Current hull course, e.g. "driving forward" or "rotating left in place, 12° to go". The turret is not described:
 * all turret facts already assume its current step is complete (see settledAim in observe.ts).
 */
function describeCourse(o: Action, left: Observation["self"]["stepLeft"]): string {
  return o.drive === "turn_left" || o.drive === "turn_right" ? `${COURSE[o.drive]}, ${Math.round(left.drive)}° to go` : COURSE[o.drive];
}

function poseFields(p: Pose) {
  return {
    position_m: { x: r1(p.x), y: r1(p.y) },
    hull_heading_deg: Math.round(p.hullHeadingDeg) % 360,
    turret_heading_deg: Math.round(p.turretHeadingDeg) % 360,
    velocity_mps: { x: r1(p.vx) || 0, y: r1(p.vy) || 0 },
  };
}

const SHOT_TEXT: Record<ShotTrace["result"], string> = {
  direct: "would hit the enemy directly",
  bank: "would hit the enemy after one bounce off a wall",
  self: "would bounce back and hit you",
  miss: "would miss",
};

/**
 * Turret question. With a direct line to the enemy it only gives the direct aim. Behind cover it adds the nearest
 * one-bounce bank shot, so a bank shot is an explicit choice in the question rather than a state field that can
 * contradict the direct aim (as an always-on hint did: Microsoft followed it away from the enemy).
 */
export function turretText(o: Observation): string {
  const e = o.enemy;
  const aim = `The enemy is ${side(e.aimOffsetDeg)} of where your turret points (enemy motion: ${e.motion})`;
  if (e.lineOfSight) return `${aim}. How far should your turret turn in its next step?`;
  const d = o.bankTurnDeg;
  const bank = d === null ? "no bank shot is within reach"
    : d === 0 ? "a bank shot off a wall is lined up now"
    : `a bank shot off a wall needs your turret ${Math.abs(d)}° ${d > 0 ? "right" : "left"}`;
  return `${aim}, but a wall blocks the direct line; ${bank}. How far should your turret turn in its next step?`;
}

/** Model-facing state: world frame (map, positions, headings) plus the egocentric facts from p1. */
export function encodeState(o: Observation): Record<string, unknown> {
  const e = o.enemy;
  return {
    rules: RULES,
    time_left_s: Math.round(o.timeLeftS),
    arena: {
      width_m: o.world.widthM,
      height_m: o.world.heightM,
      walls: o.world.walls.map((w) => ({ x_from: r1(w.x), x_to: r1(w.x + w.w), y_from: r1(w.y), y_to: r1(w.y + w.h) })),
    },
    you: {
      hp: o.self.hp,
      ...poseFields(o.self.pose),
      reload: reloadText(o.self.reloadS),
      shells_in_flight: o.self.shellsInFlight,
      current_course: describeCourse(o.self.orders, o.self.stepLeft),
    },
    enemy: {
      hp: e.hp,
      ...poseFields(e.pose),
      reload: reloadText(e.reloadS),
      shells_in_flight: e.shellsInFlight,
      distance_m: r1(e.distanceM),
      line_of_sight: e.lineOfSight,
      direction_from_hull: side(e.bearingFromHullDeg),
      direction_from_turret: side(e.aimOffsetDeg),
      motion: e.motion,
    },
    your_shot: {
      if_fired_now: `${SHOT_TEXT[o.shotNow.result]} (assuming both tanks stay still)`,
    },
    shells:
      o.shells.length === 0
        ? "none"
        : o.shells.map((s) => ({
            from: s.owner === "enemy" ? "enemy" : "you",
            position_m: { x: r1(s.x), y: r1(s.y) },
            heading_deg: Math.round(s.headingDeg) % 360,
            bounces_left: s.bouncesLeft,
          })),
    shell_danger: dodgeText(o),
    walls_distance_m: {
      ahead: r1(o.wallsM.ahead),
      behind: r1(o.wallsM.behind),
      left: r1(o.wallsM.left),
      right: r1(o.wallsM.right),
    },
  };
}

/** The p2 questions; the drive question adds the dodge fact and uses the wider "ahead". */
export function buildQuestions(o: Observation): Record<string, Question> {
  const e = o.enemy;
  const reload = o.self.reloadS <= 0 ? "ready" : `ready in ${o.self.reloadS.toFixed(1)}s`;
  return {
    drive: {
      type: "choice",
      instructions: `The enemy is ${hullSide(e.bearingFromHullDeg)}, ${r1(e.distanceM)} m away. ${dodgeText(o)} How should your hull drive until your next decision?`,
      criteria: DRIVE_CRITERIA,
    },
    turret: {
      type: "score",
      instructions: turretText(o),
      criteria: TURRET_LEVELS,
    },
    fire: {
      type: "noul",
      instructions: `Your turret is ${Math.round(Math.abs(e.aimOffsetDeg))}° off the enemy, a shot fired now ${SHOT_TEXT[o.shotNow.result]} if both tanks stayed still, and your reload is ${reload}. Should you fire a shell now?`,
    },
  };
}

/**
 * Seed for the decision draws: the tick plus this tank's own pose. The same answers to the same state always decode to
 * the same action (auditable from a log), the seed never depends on which model answered, and the two tanks differ.
 */
export const drawSeed = (o: Observation) =>
  hashString(`${o.tick}|${o.self.pose.x.toFixed(4)}|${o.self.pose.y.toFixed(4)}|${o.self.pose.hullHeadingDeg.toFixed(3)}`);

/** Draw an index with probability proportional to its weight; null when no weight is positive. */
function draw(weights: number[], u: number): number | null {
  const total = weights.reduce((a, w) => a + w, 0);
  if (!(total > 0)) return null;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i] / total; if (u < acc) return i; }
  return weights.findLastIndex((w) => w > 0);
}

/**
 * Decoding. Both variants take the answer at face value (no grouping, averaging or repair):
 * - "draw": every action is drawn from the model's own probabilities. An option given 70% is carried out 70% of the
 *   time; fire with probability p. Seeded (drawSeed), one uniform per question in a fixed order (drive, turret, fire).
 * - "scaled": deterministic. The top option is carried out, scaled by its probability: drive speed (and the size of a
 *   turn-in-place step) times p, turret step times p; fire when p >= SCALED_FIRE_BAR. Ties keep the earlier option.
 */
export function decode(ans: Answers, seed: number, decoder: Decoder = DEFAULT_DECODER): Decoded {
  const drive = ans.drive, turret = ans.turret, fire = ans.fire;
  if (drive?.type !== "choice" || turret?.type !== "score" || fire?.type !== "noul") throw new Error("malformed answers");
  const u = rng(seed);
  const pos = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
  const driveW = DRIVE_CMDS.map((c) => pos(drive.probabilities[c]));

  // Score probabilities may be keyed by index ("0".."6") or by label; normalise to index.
  const tp: Record<string, number> = {};
  const byIdx = new Array<number>(TURRET_VALUES.length).fill(0);
  for (const [k, q] of Object.entries(turret.probabilities)) {
    const idx = /^\d+$/.test(k) ? Number(k) : TURRET_LEVELS.indexOf(k);
    if (idx < 0 || idx >= TURRET_VALUES.length) continue;
    tp[TURRET_LEVELS[idx]] = q;
    byIdx[idx] += pos(q);
  }
  const fireP = Math.min(1, pos(fire.noul));
  const detail = { driveP: drive.probabilities, turretP: tp, fireP: fire.noul };

  if (decoder === "scaled") {
    const top = (w: number[]) => { const t = w.reduce((a, x) => a + x, 0); if (!(t > 0)) return null; let i = 0; for (let k = 1; k < w.length; k++) if (w[k] > w[i]) i = k; return { i, p: w[i] / t }; };
    const d = top(driveW), t = top(byIdx);
    return {
      action: {
        drive: d ? DRIVE_CMDS[d.i] : "stop",
        throttle: d ? d.p : 1,
        turret: t ? TURRET_VALUES[t.i] * t.p : 0,
        fire: fireP >= SCALED_FIRE_BAR,
      },
      detail,
    };
  }

  const di = draw(driveW, u());
  const ti = draw(byIdx, u()) ?? HOLD;
  return { action: { drive: di === null ? "stop" : DRIVE_CMDS[di], turret: TURRET_VALUES[ti], fire: u() < fireP }, detail };
}
