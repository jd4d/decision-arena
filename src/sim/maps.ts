import { ARENA_H, ARENA_W } from "./tuning.ts";
import type { Rect } from "./math.ts";

export type MapDef = { id: string; name: string; walls: Rect[] };

/** Point-symmetric around the arena center so neither spawn side has an advantage. */
function mirror(half: Rect[]): Rect[] {
  const out: Rect[] = [];
  const key = (r: Rect) => `${r.x.toFixed(3)},${r.y.toFixed(3)},${r.w},${r.h}`;
  const seen = new Set<string>();
  for (const r of half) {
    for (const w of [r, { x: ARENA_W - r.x - r.w, y: ARENA_H - r.y - r.h, w: r.w, h: r.h }]) {
      if (!seen.has(key(w))) { seen.add(key(w)); out.push(w); }
    }
  }
  return out;
}

// Spawns mirror through the arena center, so nothing may sit on the center: tanks start with line of sight.
export const MAPS: Record<string, MapDef> = {
  open: { id: "open", name: "Open Field", walls: [] },
  pillars: {
    id: "pillars",
    name: "Pillars",
    walls: mirror([
      { x: 9, y: 4, w: 2, h: 2 },
      { x: 9, y: 14, w: 2, h: 2 },
    ]),
  },
  crossfire: {
    id: "crossfire",
    name: "Crossfire",
    walls: mirror([
      { x: 7, y: 2, w: 1.2, h: 4.5 },
      { x: 7, y: 13.5, w: 1.2, h: 4.5 },
      { x: 13.5, y: 4.5, w: 5, h: 1 },
    ]),
  },
};

export const MAP_IDS = Object.keys(MAPS);
