// Match log format (JSONL, one record per line). The viewer and analysis depend on this; bump LOG_VERSION on breaking changes.
import type { AgentInfo } from "../agents/types.ts";
import type { Action, SimEvent } from "../sim/types.ts";
import type { LatencyMode } from "./latency.ts";

export const LOG_VERSION = 1;

export type HeaderRec = {
  k: "header";
  v: number;
  runId: string;
  matchId: string;
  condition: string; // e.g. "scaled-1", "fixed-250"
  createdAt: string;
  sim: string;
  protocol: string;
  map: string;
  seed: number;
  tickHz: number;
  roundTicks: number;
  latency: LatencyMode;
  agents: (AgentInfo & { slot: 0 | 1 })[];
};

export type DecisionRec = {
  k: "decision";
  slot: 0 | 1;
  n: number; // per-slot sequence number
  issueTick: number; // observation taken at this tick (before stepping)
  applyTick: number; // orders applied at this tick (before stepping)
  realMs: number;
  effMs: number;
  action: Action | null;
  detail?: { driveP: Record<string, number>; turretP: Record<string, number>; fireP: number };
  cost?: number;
  tokens?: { in: number; out: number };
  provider?: string;
  error?: string;
};

export type EventRec = { k: "event" } & SimEvent;
export type CheckRec = { k: "check"; t: number; sum: string };

export type SlotStats = {
  decisions: number;
  errors: number;
  shots: number;
  fizzles: number;
  hits: number; // hits on the enemy
  selfHits: number;
  damageTaken: number;
  cost: number;
  latencyMs: { p50: number; p90: number; mean: number; max: number };
  firstHitTick: number | null;
};

export type ResultRec = {
  k: "result";
  winner: 0 | 1 | null;
  reason: "destroyed" | "time" | "mutual" | "aborted";
  ticks: number;
  hp: [number, number];
  stats: [SlotStats, SlotStats];
  wallMs: number;
};

export type LogRec = HeaderRec | DecisionRec | EventRec | CheckRec | ResultRec;

export function parseLog(text: string): LogRec[] {
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
