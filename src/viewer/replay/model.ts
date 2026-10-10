// Match model for the viewer: one forward re-simulation of the log via createReplay(), cached per tick.
// The per-tick cache is the "keyframe cache": seeking, ghosts (past enemy positions), trails and effects all
// read from it in O(1), and a full 60 s match re-simulates in a few milliseconds. Live matches use the same
// builder incrementally: the model's arrays grow in place as stream batches arrive.
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

/** Pending decision per slot as reported by a live stream: only its issue tick is known until it lands. */
export type Inflight = [{ issueTick: number } | null, { issueTick: number } | null];

export type LiveInfo = {
  /** Pending decisions at the stream edge (`MatchModel.endTick`). */
  inflight: Inflight;
  /** The stream has ended: frames run to the final tick and `result` is set. */
  complete: boolean;
};

export type MatchModel = {
  header: HeaderRec;
  result: ResultRec | undefined;
  walls: Rect[];
  frames: Frame[];
  /** Last simulated tick (frames.length - 1). Grows while a live match streams. */
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
  /** Set while the model is being built from a live stream. */
  live: LiveInfo | null;
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

/**
 * Incremental re-simulation. A finished log is fed in one go; a live stream feeds records batch by batch and
 * advances to the tick the engine has confirmed. Decisions and checks are de-duplicated, so a reconnect that
 * resends the whole backlog is harmless.
 */
export class ModelBuilder {
  readonly model: MatchModel;
  private readonly rp: Replay;
  private readonly seen = new Set<string>();
  private readonly labels: string[];

  constructor(header: HeaderRec, live: boolean) {
    this.rp = createReplay([header]); // throws on unknown maps
    this.labels = header.agents.map((a) => a.label);
    this.model = {
      header,
      result: undefined,
      walls: this.rp.world.walls,
      frames: [snap(this.rp.world, undefined)],
      endTick: 0,
      decisions: [[], []],
      markers: [],
      hits: [],
      slowTicks: [],
      mismatches: this.rp.mismatches,
      simVersion: { log: header.sim, viewer: SIM_VERSION, stale: header.sim !== SIM_VERSION },
      endEvent: null,
      live: live ? { inflight: [null, null], complete: false } : null,
    };
  }

  /** Add records (any order within a batch; decisions must arrive before the tick they apply at is simulated). */
  add(recs: LogRec[]): void {
    for (const r of recs) {
      if (r.k === "decision") {
        const key = `${r.slot}:${r.n}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        const at = this.rp.appliedAt.get(r.applyTick);
        if (at) at.push(r);
        else this.rp.appliedAt.set(r.applyTick, [r]);
        const list = this.model.decisions[r.slot];
        list.push(r);
        // Streams deliver in order; keep the per-slot list sorted regardless.
        for (let i = list.length - 1; i > 0 && (list[i - 1].issueTick > r.issueTick || (list[i - 1].issueTick === r.issueTick && list[i - 1].n > r.n)); i--) {
          [list[i - 1], list[i]] = [list[i], list[i - 1]];
        }
      } else if (r.k === "check") this.rp.checks.set(r.t, r.sum);
      else if (r.k === "result") this.model.result = r;
    }
  }

  /** Simulate forward to `tick` (or until the world ends / the recorded result tick). Returns true if frames were added. */
  advanceTo(tick: number): boolean {
    const m = this.model;
    const stopAt = Math.min(tick, m.result ? m.result.ticks : Infinity);
    const before = m.frames.length;
    while (!this.rp.world.over && this.rp.world.tick < stopAt && m.frames.length < 200_000) {
      this.rp.advance();
      const f = snap(this.rp.world, m.frames[m.frames.length - 1]);
      m.frames.push(f);
      this.collect(f);
    }
    m.endTick = m.frames.length - 1;
    return m.frames.length > before;
  }

  /** The stream is over: no more records will arrive. */
  finish(): void {
    if (this.model.result) this.advanceTo(this.model.result.ticks);
    if (this.model.live) this.model.live = { inflight: [null, null], complete: true };
  }

  private collect(f: Frame): void {
    const m = this.model, labels = this.labels;
    for (const e of f.events) {
      if (e.type === "hit") {
        m.hits.push(e);
        m.slowTicks.push(e.t);
        m.markers.push(
          e.self
            ? { tick: e.t, kind: "self", slot: e.victim, label: `Own goal · ${labels[e.victim]} hit itself (HP ${e.hpAfter})` }
            : { tick: e.t, kind: "hit", slot: e.owner, label: `${labels[e.owner]} hits ${labels[e.victim]} (HP ${e.hpAfter})` },
        );
      } else if (e.type === "clash") m.markers.push({ tick: e.t, kind: "clash", slot: null, label: "Shell clash" });
      else if (e.type === "fizzle") m.markers.push({ tick: e.t, kind: "fizzle", slot: e.slot, label: `${labels[e.slot]} fizzled (muzzle blocked)` });
      else if (e.type === "fire") m.markers.push({ tick: e.t, kind: "fire", slot: e.slot, label: `${labels[e.slot]} fires` });
      else if (e.type === "end") {
        m.endEvent = e;
        const who = e.winner === null ? "Draw" : `${labels[e.winner]} wins`;
        m.markers.push({ tick: e.t, kind: "end", slot: e.winner, label: `${who} · ${e.reason}` });
      }
    }
  }
}

export function buildModel(records: LogRec[]): MatchModel {
  const header = records.find((r) => r.k === "header") as HeaderRec | undefined;
  if (!header) throw new Error("log has no header");
  const b = new ModelBuilder(header, false);
  b.add(records);
  b.advanceTo(Infinity);
  return b.model;
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

/** What the viewer knows about the decision in flight for `slot` at `tick`. While streaming, the newest decision
 *  is known only by its issue tick (`applyTick`/`realMs` null) until it lands. */
export type PendingView = { issueTick: number; applyTick: number | null; realMs: number | null; effMs: number | null; error?: string };

export function pendingView(m: MatchModel, slot: 0 | 1, tick: number): PendingView | null {
  const d = pendingAt(m.decisions[slot], tick);
  if (d) return { issueTick: d.issueTick, applyTick: d.applyTick, realMs: d.realMs, effMs: d.effMs, error: d.error };
  const inf = m.live?.inflight[slot];
  if (inf && inf.issueTick <= tick) return { issueTick: inf.issueTick, applyTick: null, realMs: null, effMs: null };
  return null;
}

/** Decisions landing in (from, to]. */
export function countApplied(list: DecisionRec[], from: number, to: number): number {
  return lastAtOrBefore(list, to, (d) => d.applyTick) - lastAtOrBefore(list, from, (d) => d.applyTick);
}

export function frameAt(m: MatchModel, tick: number): Frame {
  return m.frames[Math.max(0, Math.min(m.endTick, Math.floor(tick)))];
}
