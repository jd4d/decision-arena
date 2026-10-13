import { PUBLIC_CONDITIONS, type PublicCondition } from "../../api/contract.ts";

export const pct = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(digits)}%`;

export const num = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(digits);

export const ms = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${Math.round(x)} ms`);

export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (x === 0) return "$0";
  if (x < 0.01) return `$${x.toFixed(5)}`;
  return `$${x.toFixed(x < 1 ? 4 : 2)}`;
}

/** m:ss.t */
export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const titleCase = (s: string) => s.replace(/(^|[\s_-])(\w)/g, (_, a: string, b: string) => `${a === "_" ? " " : a}${b.toUpperCase()}`);

export const driveLabel = (d: string) => d.replace("_", " ");

/** Short human condition name. The public rules use their contract labels ("scaled-1" -> "Real latency",
 *  "fixed-250" -> "Equal latency (250 ms)"); anything else (older logs) is derived from its id. */
export function conditionLabel(c: string): string {
  if (c in PUBLIC_CONDITIONS) return PUBLIC_CONDITIONS[c as PublicCondition].label;
  const [kind, v] = c.split("-");
  if (kind === "scaled") return v === "1" ? "Real latency" : `Game ×${v} speed`;
  if (kind === "fixed") return `Equal latency (${v} ms)`;
  if (kind === "swap") return v === "1" ? "Swapped latency" : `Swapped latency ×${v}`;
  if (kind === "resampled") return `Resampled · ${c.slice(10)}`;
  return c;
}

/** What a condition isolates, when that isn't obvious from its name ("" otherwise). */
export function conditionDetail(c: string): string {
  const kind = c.split("-")[0];
  if (kind === "fixed") return "decision quality only";
  if (kind === "swap") return "each model plays at the other’s speed";
  return "";
}

/** Full label: "Equal latency (250 ms): decision quality only". */
export const conditionFull = (c: string) => {
  const d = conditionDetail(c);
  return d ? `${conditionLabel(c)}: ${d}` : conditionLabel(c);
};

/** Display order: equal-latency controls, then scaled by multiplier, resampled, swapped, anything else. */
export function compareConditions(a: string, b: string): number {
  const rank = (c: string): [number, number] => {
    const [kind, v] = c.split("-");
    const n = Number(v);
    const k = ({ fixed: 0, scaled: 1, resampled: 2, swap: 3 } as Record<string, number>)[kind] ?? 4;
    return [k, Number.isFinite(n) ? n : 0];
  };
  const [ka, va] = rank(a), [kb, vb] = rank(b);
  return ka - kb || va - vb || a.localeCompare(b);
}

/** One plain line on what a condition means for the match (the contract blurb for the public rules). */
export function conditionBlurb(c: string): string {
  if (c in PUBLIC_CONDITIONS) return PUBLIC_CONDITIONS[c as PublicCondition].blurb;
  const [kind, v] = c.split("-");
  if (kind === "fixed") return `Every decision lands exactly ${v} ms after it was asked for, so only the quality of the choices differs.`;
  if (kind === "scaled") return `Response time counts ${v}× in game time.`;
  if (kind === "swap") return "Each model plays at the other model’s speed.";
  return "";
}

export const reasonLabel = (r: string) =>
  r === "destroyed" ? "Tank destroyed" : r === "mutual" ? "Mutual destruction" : r === "time" ? "Time up" : r === "aborted" ? "Match aborted" : titleCase(r);

/** Signed percentage-point change, e.g. "+1.4 pts". */
export function ptsDelta(d: number): string {
  const v = d * 100;
  if (Math.abs(v) < 0.05) return "±0 pts";
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} pts`;
}

/** Provenance tag for a pool match: seed matches (imported from the local t1 runs) are marked; site matches aren't. */
/** Human label for a results version ("sim-3:p2-draw" -> "p2 · weighted draw"). Unknown protocols show as-is. */
const DECODER_NAMES: Record<string, string> = { draw: "weighted draw", scaled: "confidence-scaled" };
export function versionLabel(version: string): string {
  const protocol = version.split(":")[1] ?? version;
  const [p, decoder] = protocol.split("-");
  if (decoder) return `${p} · ${DECODER_NAMES[decoder] ?? decoder}`;
  return p === "p1" ? "p1 · first version" : p;
}

export const originTag = (origin: string | undefined) => (origin === "t1-local" ? "seed" : null);
export const ORIGIN_NOTE = "Seed match from the local seed tournament, played locally rather than from this site";
