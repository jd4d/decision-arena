// Development fixtures. Not leaderboard entrants.
import type { Observation } from "../sim/observe.ts";
import { rng } from "../sim/rng.ts";
import { clamp } from "../sim/math.ts";
import { DRIVE_CMDS, type Action } from "../sim/types.ts";
import type { Agent, DecisionResult } from "./types.ts";

/** Aims the turret proportionally, fires when the shot is clear, strafes and dodges. thinkMs is reported as its latency. */
export function scriptedBot(opts: { thinkMs?: number; seed?: number; aimGain?: number } = {}): Agent {
  const thinkMs = opts.thinkMs ?? 200;
  const r = rng(opts.seed ?? 7);
  const gain = opts.aimGain ?? 1 / 30;
  return {
    info: { id: `scripted-${thinkMs}ms`, label: `Scripted bot (${thinkMs} ms)`, kind: "bot" },
    async decide(o: Observation): Promise<DecisionResult> {
      const e = o.enemy;
      let drive: Action["drive"] = "stop";
      const threat = o.threats.find((t) => t.etaS < 1);
      if (threat) drive = threat.bearingFromHullDeg > 0 ? "forward_left" : "forward_right";
      else if (!e.lineOfSight) drive = r() < 0.4 ? (r() < 0.5 ? "forward_left" : "forward_right") : Math.abs(e.bearingFromHullDeg) > 25 ? (e.bearingFromHullDeg > 0 ? "turn_right" : "turn_left") : "forward";
      else if (e.distanceM > 12) drive = Math.abs(e.bearingFromHullDeg) > 25 ? (e.bearingFromHullDeg > 0 ? "turn_right" : "turn_left") : "forward";
      else drive = r() < 0.5 ? "forward_left" : "forward_right";
      if (o.wallsM.ahead < 0.6 && drive.startsWith("forward")) drive = "reverse";
      const turret = clamp(e.aimOffsetDeg * gain, -1, 1);
      const fire = e.shotClear && Math.abs(e.aimOffsetDeg) < 6;
      return { action: { drive, turret, fire }, realMs: thinkMs };
    },
  };
}

export function randomBot(opts: { thinkMs?: number; seed?: number } = {}): Agent {
  const thinkMs = opts.thinkMs ?? 200;
  const r = rng(opts.seed ?? 11);
  return {
    info: { id: `random-${thinkMs}ms`, label: `Random bot (${thinkMs} ms)`, kind: "bot" },
    async decide(): Promise<DecisionResult> {
      return {
        action: { drive: DRIVE_CMDS[Math.floor(r() * DRIVE_CMDS.length)], turret: r() * 2 - 1, fire: r() < 0.3 },
        realMs: thinkMs,
      };
    },
  };
}
