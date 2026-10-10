import { rng } from "../sim/rng.ts";
import { TICK_HZ } from "../sim/tuning.ts";

/**
 * How real response time becomes game time.
 * - scaled: measured latency × factor (1 = real time, 2 = a game running twice as fast)
 * - fixed: every decision takes exactly `ms` of game time, regardless of real speed (isolates decision quality)
 * - resampled: each slot's latency is drawn from a recorded distribution (e.g. give each model the other's speed)
 */
export type LatencyMode =
  | { mode: "scaled"; factor: number }
  | { mode: "fixed"; ms: number }
  | { mode: "resampled"; traces: [number[], number[]]; label?: string };

export const ERROR_MIN_MS = 200; // an errored decision costs at least this much game time

export function makeLatencyFn(mode: LatencyMode, seed: number): (slot: 0 | 1, realMs: number, errored: boolean) => number {
  const r = rng(seed ^ 0x9e3779b9);
  return (slot, realMs, errored) => {
    let ms: number;
    if (mode.mode === "scaled") ms = realMs * mode.factor;
    else if (mode.mode === "fixed") ms = mode.ms;
    else {
      const tr = mode.traces[slot];
      ms = tr.length ? tr[Math.floor(r() * tr.length)] : realMs;
    }
    return errored ? Math.max(ms, ERROR_MIN_MS) : ms;
  };
}

export const msToTicks = (ms: number) => Math.max(1, Math.ceil((ms * TICK_HZ) / 1000));

export function conditionName(mode: LatencyMode): string {
  if (mode.mode === "scaled") return `scaled-${mode.factor}`;
  if (mode.mode === "fixed") return `fixed-${mode.ms}`;
  return `resampled-${mode.label ?? "custom"}`;
}

export function parseLatency(spec: string): LatencyMode {
  const [kind, v] = spec.split(":");
  if (kind === "scaled") return { mode: "scaled", factor: Number(v ?? 1) };
  if (kind === "fixed") return { mode: "fixed", ms: Number(v ?? 250) };
  throw new Error(`latency spec must be scaled:<factor> or fixed:<ms> (resampled is built by the tournament): ${spec}`);
}
