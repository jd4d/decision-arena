// Match model for the viewer: one forward re-simulation of the log via createReplay(), cached per tick.
// The per-tick cache is the "keyframe cache": seeking, ghosts (past enemy positions), trails and effects all
// read from it in O(1), and a full 60 s match re-simulates in a few milliseconds.
import { createReplay, type Replay } from "../../runner/replay.ts";
import type { DecisionRec, HeaderRec, LogRec, ResultRec } from "../../runner/log.ts";
import { wrapAngle, type Rect } from "../../sim/math.ts";
import { SIM_VERSION } from "../../sim/tuning.ts";
import type { DriveCmd, SimEvent, World } from "../../sim/types.ts";

export type TankSnap = {
  x: number;
  y: number;
  heading: number;
  turretRel: number;
  hp: number;
  reload: number;
  drive: DriveCmd;
  /** Cumulative tread travel (m) for animated treads. */
  odoL: number;
  odoR: number;
};
export type ShellSnap = { id: number; owner: 0 | 1; x: number; y: number; bounces: number };
export type Frame = { tick: number; tanks: [TankSnap, TankSnap]; shells: ShellSnap[]; events: SimEvent[] };

export type HitEvent = Extract<SimEvent, { type: "hit" }>;
export type MarkerKind = "hit" | "self" | "clash" | "end" | "fizzle" | "fire";
export type Marker = { tick: number; kind: MarkerKind; slot: 0 | 1 | null; label: string };

export type MatchModel = {
  header: HeaderRec;
  result: ResultRec | undefined;
  walls: Rect[];
  frames: Frame[];
  /** Last simulated tick (frames.length - 1). */
  endTick: number;
  decisions: [DecisionRec[], DecisionRec[]];
  markers: Marker[];
  hits: HitEvent[];
  /** Ticks that trigger automatic slow motion. */
  slowTicks: number[];
  mismatches: Replay["mismatches"];
  /** The log was recorded with a different sim version than the one bundled in this viewer. */
  simVersion: { log: string; viewer: string; stale: boolean };
  endEvent: Extract<SimEvent, { type: "end" }> | null;
};

const TREAD_HALF = 0.55;

function snapTank(w: World, slot: 0 | 1, prev: TankSnap | undefined): TankSnap {
  const t = w.tanks[slot];
  let odoL = 0, odoR = 0;
  if (prev) {
    const fwd = t.moved.dx * Math.cos(t.heading) + t.moved.dy * Math.sin(t.heading);
    const dTh = wrapAngle(t.heading - prev.heading);
    odoL = prev.odoL + fwd + dTh * TREAD_HALF;
    odoR = prev.odoR + fwd - dTh * TREAD_HALF;
  }
  return { x: t.x, y: t.y, heading: t.heading, turretRel: t.turretRel, hp: t.hp, reload: t.reload, drive: t.orders.drive, odoL, odoR };
}

function snap(w: World, prev: Frame | undefined): Frame {
  return {
    tick: w.tick,
    tanks: [snapTank(w, 0, prev?.tanks[0]), snapTank(w, 1, prev?.tanks[1])],
    shells: w.shells.map((s) => ({ id: s.id, owner: s.owner, x: s.x, y: s.y, bounces: s.bounces })),
    events: w.events.slice(),
  };
}

export function buildModel(records: LogRec[]): MatchModel {
  const rp = createReplay(records); // throws on unknown maps / missing header
  const stopAt = rp.result ? rp.result.ticks : Infinity;
  const frames: Frame[] = [snap(rp.world, undefined)];
  while (!rp.world.over && rp.world.tick < stopAt && frames.length < 200_000) {
    rp.advance();
    frames.push(snap(rp.world, frames[frames.length - 1]));
  }

  const decisions: [DecisionRec[], DecisionRec[]] = [[], []];
  for (const d of rp.decisions) decisions[d.slot].push(d);
  for (const list of decisions) list.sort((a, b) => a.issueTick - b.issueTick || a.n - b.n);

  const labels = rp.header.agents.map((a) => a.label);
  const markers: Marker[] = [];
  const hits: HitEvent[] = [];
  let endEvent: MatchModel["endEvent"] = null;
  for (const f of frames) {
    for (const e of f.events) {
      if (e.type === "hit") {
        hits.push(e);
        markers.push(
          e.self
            ? { tick: e.t, kind: "self", slot: e.victim, label: `Own goal · ${labels[e.victim]} hit itself (HP ${e.hpAfter})` }
            : { tick: e.t, kind: "hit", slot: e.owner, label: `${labels[e.owner]} hits ${labels[e.victim]} (HP ${e.hpAfter})` },
        );
      } else if (e.type === "clash") markers.push({ tick: e.t, kind: "clash", slot: null, label: "Shell clash" });
      else if (e.type === "fizzle") markers.push({ tick: e.t, kind: "fizzle", slot: e.slot, label: `${labels[e.slot]} fizzled (muzzle blocked)` });
      else if (e.type === "fire") markers.push({ tick: e.t, kind: "fire", slot: e.slot, label: `${labels[e.slot]} fires` });
      else if (e.type === "end") {
        endEvent = e;
        const who = e.winner === null ? "Draw" : `${labels[e.winner]} wins`;
        markers.push({ tick: e.t, kind: "end", slot: e.winner, label: `${who} · ${e.reason}` });
      }
    }
  }

  return {
    header: rp.header,
    result: rp.result,
    walls: rp.world.walls,
    frames,
    endTick: frames.length - 1,
    decisions,
    markers,
    hits,
    slowTicks: hits.map((h) => h.t),
    mismatches: rp.mismatches,
    simVersion: { log: rp.header.sim, viewer: SIM_VERSION, stale: rp.header.sim !== SIM_VERSION },
    endEvent,
  };
}

/** Index of the last element with key(el) <= tick, or -1. Lists are sorted by issueTick (and so by applyTick). */
function lastAtOrBefore(list: DecisionRec[], tick: number, key: (d: DecisionRec) => number): number {
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) <= tick) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Latest decision applied at or before `tick` (applyTick <= tick). */
export function latestApplied(list: DecisionRec[], tick: number): DecisionRec | null {
  const i = lastAtOrBefore(list, tick, (d) => d.applyTick);
  return i >= 0 ? list[i] : null;
}

/** The decision in flight at `tick`: issueTick <= tick < applyTick. */
export function pendingAt(list: DecisionRec[], tick: number): DecisionRec | null {
  const i = lastAtOrBefore(list, tick, (d) => d.issueTick);
  return i >= 0 && tick < list[i].applyTick ? list[i] : null;
}

/** Decisions landing in (from, to]. */
export function countApplied(list: DecisionRec[], from: number, to: number): number {
  return lastAtOrBefore(list, to, (d) => d.applyTick) - lastAtOrBefore(list, from, (d) => d.applyTick);
}

export function frameAt(m: MatchModel, tick: number): Frame {
  return m.frames[Math.max(0, Math.min(m.endTick, Math.floor(tick)))];
}
