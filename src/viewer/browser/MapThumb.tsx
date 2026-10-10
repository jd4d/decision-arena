import { MAPS } from "../../sim/maps.ts";
import { ARENA_H, ARENA_W } from "../../sim/tuning.ts";
import { createWorld } from "../../sim/world.ts";

function spawns(map: string, seed: number) {
  try {
    return createWorld(map, seed).tanks.map((t) => ({ x: t.x, y: t.y, h: t.heading }));
  } catch {
    return null;
  }
}

/** Tiny SVG plan of a map's walls, with the seeded spawn points when given. */
export function MapThumb({ map, seed, colors, className = "" }: { map: string; seed?: number; colors?: [string, string]; className?: string }) {
  const def = MAPS[map];
  const sp = def && seed !== undefined && colors ? spawns(map, seed) : null;
  return (
    <svg className={`mapthumb ${className}`} viewBox={`-0.6 -0.6 ${ARENA_W + 1.2} ${ARENA_H + 1.2}`} aria-label={def ? `${def.name} map` : `unknown map ${map}`} role="img">
      <rect x="0" y="0" width={ARENA_W} height={ARENA_H} rx="0.4" className="mapthumb__floor" />
      {Array.from({ length: Math.floor(ARENA_W / 4) - 1 }, (_, i) => (
        <line key={`x${i}`} x1={(i + 1) * 4} x2={(i + 1) * 4} y1="0" y2={ARENA_H} className="mapthumb__grid" />
      ))}
      {Array.from({ length: Math.floor(ARENA_H / 4) - 1 }, (_, i) => (
        <line key={`y${i}`} y1={(i + 1) * 4} y2={(i + 1) * 4} x1="0" x2={ARENA_W} className="mapthumb__grid" />
      ))}
      {sp?.map((t, i) => (
        <g key={`s${i}`} transform={`translate(${t.x} ${t.y}) rotate(${(t.h * 180) / Math.PI})`} className="mapthumb__spawn" style={{ color: colors![i] }}>
          <circle r="1.6" fill="currentColor" opacity="0.18" />
          <circle r="0.8" fill="currentColor" />
          <path d="M0.4 0H1.9" stroke="currentColor" strokeWidth="0.35" strokeLinecap="round" />
        </g>
      ))}
      {def ? def.walls.map((w, i) => <rect key={i} x={w.x} y={w.y} width={w.w} height={w.h} className="mapthumb__wall" />) : (
        <text x={ARENA_W / 2} y={ARENA_H / 2 + 1.2} textAnchor="middle" className="mapthumb__unknown">?</text>
      )}
    </svg>
  );
}
