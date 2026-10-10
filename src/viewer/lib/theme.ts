// Visual identity: per-model team colours. Known models get fixed colours everywhere (cards, arena, charts);
// bots and unknown agents draw from a secondary palette, and a mirror match never shares a colour.

export type TeamColor = { main: string; bright: string; deep: string; rgb: [number, number, number] };

function team(main: string, bright: string, deep: string): TeamColor {
  return { main, bright, deep, rgb: hexRgb(main) };
}

const MODEL_COLORS: { test: RegExp; color: TeamColor }[] = [
  { test: /jev/i, color: team("#38d9f5", "#a8f1ff", "#0b5f73") },
  { test: /msd|microsoft/i, color: team("#ff9d3c", "#ffd29e", "#7a3d06") },
];

const OTHER: TeamColor[] = [
  team("#b48cff", "#e1d0ff", "#4a2a85"),
  team("#ff6fae", "#ffc2dc", "#7d1d47"),
  team("#9be15d", "#d6f7b8", "#3c6a12"),
  team("#f5d547", "#fbedaa", "#6e5b07"),
  team("#6ea8ff", "#c5dcff", "#1d3f7a"),
];

const ALT: TeamColor = team("#e8eef6", "#ffffff", "#4a5566");

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Colour for an agent id in isolation. */
export function agentColor(id: string): TeamColor {
  for (const m of MODEL_COLORS) if (m.test.test(id)) return m.color;
  return OTHER[hash(id) % OTHER.length];
}

/** Colours for a list of agents that must be mutually distinct (e.g. both slots of a match, or a run's agents). */
export function distinctColors(ids: string[]): TeamColor[] {
  const out: TeamColor[] = [];
  for (const id of ids) {
    let c = agentColor(id);
    if (out.includes(c)) c = [...OTHER, ALT].find((o) => !out.includes(o)) ?? ALT;
    out.push(c);
  }
  return out;
}

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(c: TeamColor | [number, number, number] | string, a: number): string {
  const [r, g, b] = typeof c === "string" ? hexRgb(c) : Array.isArray(c) ? c : c.rgb;
  return `rgba(${r},${g},${b},${a})`;
}

const SHORT: Record<string, string> = { jev: "JEV", msd1: "MSFT" };

/** Compact, uppercase tag for in-arena labels. */
export function shortLabel(id: string, label: string): string {
  if (SHORT[id]) return SHORT[id];
  return label.replace(/\bbot\b/i, "").replace(/[()]/g, "").replace(/\s+ms\b/, "ms").replace(/\s+/g, " ").trim().toUpperCase();
}

/** Runs produced from dev/pilot logs (same rule as the analysis exporter). */
export const isDevRun = (runId: string) => /^(dev-|adhoc-)/.test(runId);
