// Pure (browser-safe) re-simulation of a match log. Used by the viewer and by tests.
import { checksum, createWorld, setOrders, step } from "../sim/world.ts";
import type { World } from "../sim/types.ts";
import type { CheckRec, DecisionRec, HeaderRec, LogRec, ResultRec } from "./log.ts";

export type Replay = {
  header: HeaderRec;
  result: ResultRec | undefined;
  decisions: DecisionRec[];
  /** decisions applied at a given tick */
  appliedAt: Map<number, DecisionRec[]>;
  checks: Map<number, string>;
  world: World;
  /** Advance one tick (apply decisions landing at the current tick, then step). Returns false when over. */
  advance(): boolean;
  /** Restart from tick 0. */
  reset(): void;
  /** Re-simulate to `tick` (resets if going backwards). */
  seek(tick: number): void;
  /** Checksum mismatches seen so far. */
  mismatches: { t: number; expected: string; got: string }[];
};

export function createReplay(records: LogRec[]): Replay {
  const header = records.find((r) => r.k === "header") as HeaderRec | undefined;
  if (!header) throw new Error("log has no header");
  const decisions = records.filter((r) => r.k === "decision") as DecisionRec[];
  const result = records.find((r) => r.k === "result") as ResultRec | undefined;
  const appliedAt = new Map<number, DecisionRec[]>();
  for (const d of decisions) (appliedAt.get(d.applyTick) ?? appliedAt.set(d.applyTick, []).get(d.applyTick)!).push(d);
  const checks = new Map((records.filter((r) => r.k === "check") as CheckRec[]).map((c) => [c.t, c.sum]));

  const rp: Replay = {
    header, result, decisions, appliedAt, checks,
    world: createWorld(header.map, header.seed),
    mismatches: [],
    advance() {
      const w = rp.world;
      if (w.over) return false;
      for (const d of appliedAt.get(w.tick) ?? []) if (d.action) setOrders(w, d.slot, d.action);
      step(w);
      const exp = checks.get(w.tick);
      if (exp !== undefined) {
        const got = checksum(w);
        if (got !== exp) rp.mismatches.push({ t: w.tick, expected: exp, got });
      }
      return !w.over;
    },
    reset() {
      rp.world = createWorld(header.map, header.seed);
    },
    seek(tick: number) {
      if (tick < rp.world.tick) rp.reset();
      while (rp.world.tick < tick && rp.advance());
    },
  };
  return rp;
}
