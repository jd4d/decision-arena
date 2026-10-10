// Canvas 2D arena renderer. Pure function of (model, fractional playhead): every effect is derived from the
// event's age, so scrubbing, pausing and slow-mo all stay consistent with no particle state to rewind.
import { rayCircle, rayRect, wrapAngle, type Rect } from "../../sim/math.ts";
import { ARENA_H, ARENA_W, MUZZLE_OFFSET, RELOAD_TICKS, SHELL_RADIUS, TANK_RADIUS, TICK_HZ } from "../../sim/tuning.ts";
import type { SimEvent } from "../../sim/types.ts";
import { pendingView, type Frame, type MatchModel, type PendingView, type ShellSnap, type TankSnap } from "../replay/model.ts";
import { rgba, type TeamColor } from "../lib/theme.ts";

export const MARGIN_M = 1.25;
export const VIEW_ASPECT = (ARENA_W + 2 * MARGIN_M) / (ARENA_H + 2 * MARGIN_M);

const UI_FONT = `Inter, "SF Pro Text", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
const MONO_FONT = `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace`;

export type View = { w: number; h: number; dpr: number; s: number; ox: number; oy: number };

export function makeView(w: number, h: number, dpr: number): View {
  const s = Math.min(w / (ARENA_W + 2 * MARGIN_M), h / (ARENA_H + 2 * MARGIN_M));
  return { w, h, dpr, s, ox: (w - ARENA_W * s) / 2, oy: (h - ARENA_H * s) / 2 };
}

export type Scene = {
  model: MatchModel;
  colors: [TeamColor, TeamColor];
  tags: [string, string];
  ghosts: boolean;
  layer: HTMLCanvasElement;
};

type Ctx = CanvasRenderingContext2D;
type Pt = { x: number; y: number };

// ---------- small math helpers ----------
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAng = (a: number, b: number, t: number) => a + wrapAngle(b - a) * t;
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const easeOutBack = (x: number) => {
  const c = 1.9;
  const t = clamp01(x) - 1;
  return 1 + (c + 1) * t * t * t + c * t * t;
};

function h01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
const rnd = (seed: number, i: number) => h01(seed * 7919 + i * 104729 + 17);

/** Distance travelled by a particle with initial speed v and linear drag k after t seconds. */
const dragDist = (v: number, k: number, t: number) => (v * (1 - Math.exp(-k * t))) / k;

function lerpTank(a: TankSnap, b: TankSnap, t: number): TankSnap {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    heading: lerpAng(a.heading, b.heading, t),
    turretRel: lerpAng(a.turretRel, b.turretRel, t),
    hp: t < 0.5 ? a.hp : b.hp,
    reload: b.reload > a.reload ? (t < 0.5 ? a.reload : b.reload) : lerp(a.reload, b.reload, t),
    drive: b.drive,
    odoL: lerp(a.odoL, b.odoL, t),
    odoR: lerp(a.odoR, b.odoR, t),
  };
}

const turretWorld = (t: TankSnap) => t.heading + t.turretRel;
const muzzle = (t: TankSnap): Pt => ({ x: t.x + Math.cos(turretWorld(t)) * MUZZLE_OFFSET, y: t.y + Math.sin(turretWorld(t)) * MUZZLE_OFFSET });

function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// ---------- static layer ----------

export function renderStatic(view: View, walls: Rect[]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(view.w * view.dpr));
  c.height = Math.max(1, Math.round(view.h * view.dpr));
  const g = c.getContext("2d")!;
  const { s, ox, oy, dpr, w, h } = view;
  const px = 1 / s;

  // Out-of-bounds margin: dark with a fine diagonal hatch.
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#05070b";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(120,150,190,0.04)";
  g.lineWidth = 1;
  g.beginPath();
  for (let x = -h; x < w; x += 8) { g.moveTo(x, h); g.lineTo(x + h, 0); }
  g.stroke();

  // Margin ruler: tick every metre, label every 4 m (telemetry feel).
  g.font = `500 9px ${MONO_FONT}`;
  g.fillStyle = "rgba(150,175,210,0.32)";
  g.strokeStyle = "rgba(150,175,210,0.22)";
  g.textAlign = "center";
  g.textBaseline = "bottom";
  for (let x = 0; x <= ARENA_W; x++) {
    const sx = ox + x * s;
    const len = x % 4 === 0 ? 6 : 3;
    g.beginPath(); g.moveTo(sx, oy - 3); g.lineTo(sx, oy - 3 - len); g.stroke();
    if (x % 8 === 0 && s * MARGIN_M > 20) g.fillText(String(x), sx, oy - 11);
  }
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (let y = 0; y <= ARENA_H; y++) {
    const sy = oy + y * s;
    const len = y % 4 === 0 ? 6 : 3;
    g.beginPath(); g.moveTo(ox - 3, sy); g.lineTo(ox - 3 - len, sy); g.stroke();
    if (y % 4 === 0 && s * MARGIN_M > 20) g.fillText(String(y), ox - 12, sy);
  }

  // Corner brackets.
  g.strokeStyle = "rgba(140,195,255,0.55)";
  g.lineWidth = 1.5;
  const bl = Math.min(18, s * 0.9), pad = Math.min(8, s * 0.35);
  const corners: [number, number, number, number][] = [
    [ox - pad, oy - pad, 1, 1], [ox + ARENA_W * s + pad, oy - pad, -1, 1],
    [ox - pad, oy + ARENA_H * s + pad, 1, -1], [ox + ARENA_W * s + pad, oy + ARENA_H * s + pad, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    g.beginPath(); g.moveTo(cx, cy + dy * bl); g.lineTo(cx, cy); g.lineTo(cx + dx * bl, cy); g.stroke();
  }

  // Floor.
  g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
  const fg = g.createRadialGradient(ARENA_W / 2, ARENA_H / 2, 1, ARENA_W / 2, ARENA_H / 2, ARENA_W * 0.62);
  fg.addColorStop(0, "#121c29");
  fg.addColorStop(1, "#080c13");
  g.fillStyle = fg;
  g.fillRect(0, 0, ARENA_W, ARENA_H);

  g.lineWidth = px;
  for (let x = 1; x < ARENA_W; x++) {
    g.strokeStyle = x % 4 === 0 ? "rgba(130,170,220,0.09)" : "rgba(130,170,220,0.04)";
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ARENA_H); g.stroke();
  }
  for (let y = 1; y < ARENA_H; y++) {
    g.strokeStyle = y % 4 === 0 ? "rgba(130,170,220,0.09)" : "rgba(130,170,220,0.04)";
    g.beginPath(); g.moveTo(0, y); g.lineTo(ARENA_W, y); g.stroke();
  }
  // Grid intersections: small crosses every 4 m.
  g.strokeStyle = "rgba(160,200,245,0.16)";
  for (let x = 4; x < ARENA_W; x += 4) for (let y = 4; y < ARENA_H; y += 4) {
    g.beginPath(); g.moveTo(x - 0.18, y); g.lineTo(x + 0.18, y); g.moveTo(x, y - 0.18); g.lineTo(x, y + 0.18); g.stroke();
  }
  // Centre mark.
  g.strokeStyle = "rgba(130,170,220,0.1)";
  g.beginPath(); g.arc(ARENA_W / 2, ARENA_H / 2, 2.6, 0, Math.PI * 2); g.stroke();
  g.setLineDash([0.25, 0.25]);
  g.beginPath(); g.arc(ARENA_W / 2, ARENA_H / 2, 5.2, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);

  // Arena border with glow.
  g.save();
  g.shadowColor = "rgba(90,170,255,0.6)";
  g.shadowBlur = 14 * dpr;
  g.strokeStyle = "rgba(140,195,255,0.6)";
  g.lineWidth = 1.5 * px;
  g.strokeRect(0, 0, ARENA_W, ARENA_H);
  g.restore();

  for (const r of walls) drawWall(g, r, px, dpr);

  // Vignette.
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.45)");
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
  return c;
}

function drawWall(g: Ctx, r: Rect, px: number, dpr: number): void {
  g.save();
  g.shadowColor = "rgba(0,0,0,0.75)";
  g.shadowBlur = 12 * dpr;
  g.shadowOffsetY = 4 * dpr;
  g.fillStyle = "#0b0f16";
  g.fillRect(r.x, r.y, r.w, r.h);
  g.restore();

  const gr = g.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
  gr.addColorStop(0, "#273347");
  gr.addColorStop(1, "#141b27");
  g.fillStyle = gr;
  g.fillRect(r.x, r.y, r.w, r.h);

  g.save();
  g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
  g.strokeStyle = "rgba(255,255,255,0.05)";
  g.lineWidth = 0.05;
  g.beginPath();
  for (let d = -r.h; d < r.w; d += 0.3) { g.moveTo(r.x + d, r.y + r.h); g.lineTo(r.x + d + r.h, r.y); }
  g.stroke();
  g.restore();

  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = px;
  g.strokeRect(r.x + 0.09, r.y + 0.09, r.w - 0.18, r.h - 0.18);
  g.strokeStyle = "rgba(150,200,255,0.38)";
  g.lineWidth = 1.2 * px;
  g.strokeRect(r.x, r.y, r.w, r.h);
}

// ---------- tanks ----------

type TankStyle = { mode: "live" | "ghost" | "dead"; flash: number; recoil: number };

function drawTank(g: Ctx, t: TankSnap, col: TeamColor, st: TankStyle, px: number): void {
  g.save();
  g.translate(t.x, t.y);
  g.rotate(t.heading);
  const ghost = st.mode === "ghost";
  const dead = st.mode === "dead";

  if (ghost) {
    g.setLineDash([0.16, 0.11]);
    g.lineWidth = 1.6 * px;
    g.strokeStyle = rgba(col.bright, 0.95);
    g.fillStyle = rgba(col, 0.16);
    roundRect(g, -0.86, -0.68, 1.72, 1.36, 0.22);
    g.fill(); g.stroke();
    g.rotate(t.turretRel);
    g.beginPath(); g.arc(0, 0, 0.4, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(0.4, 0); g.lineTo(MUZZLE_OFFSET, 0); g.stroke();
    g.restore();
    return;
  }

  // Soft ground shadow.
  g.fillStyle = "rgba(0,0,0,0.45)";
  roundRect(g, -0.82, -0.62, 1.8, 1.42, 0.3);
  g.fill();

  // Treads.
  const treadCol = dead ? "#15181d" : "#0e131a";
  for (const [side, odo] of [[-1, t.odoL], [1, t.odoR]] as const) {
    const y0 = side < 0 ? -0.7 : 0.38;
    g.fillStyle = treadCol;
    roundRect(g, -0.88, y0, 1.76, 0.32, 0.1);
    g.fill();
    g.save();
    g.beginPath(); g.rect(-0.86, y0 + 0.03, 1.72, 0.26); g.clip();
    g.strokeStyle = dead ? "rgba(255,255,255,0.05)" : "rgba(200,220,240,0.16)";
    g.lineWidth = 0.05;
    const off = ((odo % 0.2) + 0.2) % 0.2;
    g.beginPath();
    for (let x = -0.9 + off; x < 0.9; x += 0.2) { g.moveTo(x, y0); g.lineTo(x, y0 + 0.32); }
    g.stroke();
    g.restore();
  }

  // Hull.
  const hg = g.createLinearGradient(0, -0.5, 0, 0.5);
  if (dead) {
    hg.addColorStop(0, "#2a2f37"); hg.addColorStop(1, "#16191e");
  } else {
    hg.addColorStop(0, col.main); hg.addColorStop(1, col.deep);
  }
  g.fillStyle = hg;
  roundRect(g, -0.74, -0.5, 1.52, 1.0, 0.16);
  g.fill();
  g.strokeStyle = dead ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.55)";
  g.lineWidth = 1.2 * px;
  g.stroke();
  // Glacis and engine deck.
  g.strokeStyle = dead ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.28)";
  g.lineWidth = 0.04;
  g.beginPath(); g.moveTo(0.56, -0.42); g.lineTo(0.7, -0.3); g.lineTo(0.7, 0.3); g.lineTo(0.56, 0.42); g.stroke();
  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.beginPath();
  for (let i = 0; i < 4; i++) { g.moveTo(-0.66 + i * 0.07, -0.26); g.lineTo(-0.66 + i * 0.07, 0.26); }
  g.stroke();

  // Turret.
  g.rotate(t.turretRel);
  const bx = 0.18, bl = MUZZLE_OFFSET - 0.06 - st.recoil;
  g.fillStyle = dead ? "#22262c" : "#0d1219";
  g.fillRect(bx, -0.1, bl - bx, 0.2);
  g.fillStyle = dead ? "#30353d" : col.bright;
  g.fillRect(bx, -0.065, bl - bx, 0.13);
  g.fillStyle = dead ? "#1b1e23" : "#0d1219";
  g.fillRect(bl - 0.14, -0.12, 0.16, 0.24);

  const tg = g.createRadialGradient(-0.12, -0.12, 0.05, 0, 0, 0.46);
  if (dead) { tg.addColorStop(0, "#3a3f47"); tg.addColorStop(1, "#1a1d22"); }
  else { tg.addColorStop(0, col.bright); tg.addColorStop(0.55, col.main); tg.addColorStop(1, col.deep); }
  g.fillStyle = tg;
  g.beginPath(); g.arc(0, 0, 0.42, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(0,0,0,0.6)";
  g.lineWidth = 1.2 * px;
  g.stroke();
  g.fillStyle = dead ? "rgba(0,0,0,0.3)" : "rgba(5,10,16,0.45)";
  g.beginPath(); g.arc(-0.12, 0.08, 0.12, 0, Math.PI * 2); g.fill();

  // Damage flash.
  if (st.flash > 0) {
    g.rotate(-t.turretRel);
    g.globalCompositeOperation = "lighter";
    g.fillStyle = `rgba(255,255,255,${0.85 * st.flash})`;
    roundRect(g, -0.9, -0.72, 1.8, 1.44, 0.24);
    g.fill();
  }
  g.restore();
}

// ---------- scene ----------

function screenShake(m: MatchModel, ph: number): Pt {
  let amp = 0;
  for (const h of m.hits) {
    const age = (ph - h.t) / TICK_HZ;
    if (age < 0 || age > 0.7) continue;
    const big = h.hpAfter === 0 ? 1.7 : 1;
    amp += 0.3 * big * Math.exp(-age * 6) * (1 - age / 0.7);
  }
  for (const mk of m.markers) {
    if (mk.kind !== "clash") continue;
    const age = (ph - mk.tick) / TICK_HZ;
    if (age >= 0 && age < 0.35) amp += 0.09 * (1 - age / 0.35);
  }
  if (amp < 1e-3) return { x: 0, y: 0 };
  return {
    x: amp * (Math.sin(ph * 2.31 + 0.7) * 0.6 + Math.sin(ph * 4.17 + 2.1) * 0.4),
    y: amp * (Math.sin(ph * 2.73 + 1.9) * 0.6 + Math.sin(ph * 3.61 + 0.3) * 0.4),
  };
}

function shellPos(f0: Frame, f1: Frame, a: number): { s: ShellSnap; x: number; y: number }[] {
  const out: { s: ShellSnap; x: number; y: number }[] = [];
  const next = new Map(f1.shells.map((s) => [s.id, s]));
  const prevIds = new Set<number>();
  for (const s of f0.shells) {
    prevIds.add(s.id);
    const n = next.get(s.id);
    if (n) { out.push({ s, x: lerp(s.x, n.x, a), y: lerp(s.y, n.y, a) }); continue; }
    if (f1 === f0) { out.push({ s, x: s.x, y: s.y }); continue; }
    // Died during this step: travel to the impact point, if known.
    const ev = f1.events.find((e) => (e.type === "hit" && e.shell === s.id) || (e.type === "clash" && e.shells.includes(s.id)));
    if (ev && (ev.type === "hit" || ev.type === "clash")) { if (a < 0.98) out.push({ s, x: lerp(s.x, ev.x, a), y: lerp(s.y, ev.y, a) }); }
    else if (a < 0.5) out.push({ s, x: s.x, y: s.y });
  }
  if (f1 !== f0) {
    for (const n of f1.shells) {
      if (prevIds.has(n.id)) continue;
      const mz = muzzle(f0.tanks[n.owner]);
      if (a > 0.02) out.push({ s: n, x: lerp(mz.x, n.x, a), y: lerp(mz.y, n.y, a) });
    }
  }
  return out;
}

/** Trail points (newest first) for a shell, walking back through cached frames and inserting bounce points. */
function trailPoints(m: MatchModel, id: number, head: Pt, i0: number, maxLen: number): Pt[] {
  const pts: Pt[] = [head];
  let len = 0;
  let last = head;
  const push = (p: Pt): boolean => {
    const d = Math.hypot(p.x - last.x, p.y - last.y);
    if (len + d > maxLen) {
      const r = (maxLen - len) / (d || 1);
      pts.push({ x: lerp(last.x, p.x, r), y: lerp(last.y, p.y, r) });
      return false;
    }
    len += d;
    pts.push(p);
    last = p;
    return true;
  };
  for (let k = i0; k >= Math.max(0, i0 - 10); k--) {
    if (k < i0) {
      const b = m.frames[k + 1].events.find((e) => e.type === "bounce" && e.shell === id);
      if (b && b.type === "bounce" && !push({ x: b.x, y: b.y })) break;
    }
    const s = m.frames[k].shells.find((q) => q.id === id);
    if (!s || !push(s)) break;
  }
  return pts;
}

function castAim(m: MatchModel, t: TankSnap, enemy: TankSnap): { end: Pt; onTarget: boolean } {
  const ang = turretWorld(t);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const o = muzzle(t);
  let d = Infinity;
  if (dx > 1e-9) d = Math.min(d, (ARENA_W - o.x) / dx); else if (dx < -1e-9) d = Math.min(d, -o.x / dx);
  if (dy > 1e-9) d = Math.min(d, (ARENA_H - o.y) / dy); else if (dy < -1e-9) d = Math.min(d, -o.y / dy);
  for (const r of m.walls) d = Math.min(d, rayRect(o, dx, dy, r));
  const he = rayCircle(o, dx, dy, enemy, TANK_RADIUS + SHELL_RADIUS);
  const onTarget = enemy.hp > 0 && he < d;
  const L = Math.max(0, onTarget ? he : d);
  return { end: { x: o.x + dx * L, y: o.y + dy * L }, onTarget };
}

export function drawScene(g: Ctx, view: View, sc: Scene, ph: number): void {
  const m = sc.model;
  const { dpr, s, ox, oy } = view;
  const px = 1 / s;
  const t = Math.min(ph, m.endTick);
  const i0 = Math.floor(t);
  const a = t - i0;
  const f0 = m.frames[i0];
  const f1 = m.frames[Math.min(i0 + 1, m.endTick)];
  const tanks: [TankSnap, TankSnap] = [lerpTank(f0.tanks[0], f1.tanks[0], a), lerpTank(f0.tanks[1], f1.tanks[1], a)];
  const sh = screenShake(m, ph);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.fillStyle = "#05070b";
  g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  g.drawImage(sc.layer, sh.x * s * dpr, sh.y * s * dpr);
  const world = () => g.setTransform(dpr * s, 0, 0, dpr * s, dpr * (ox + sh.x * s), dpr * (oy + sh.y * s));
  const screen = () => g.setTransform(dpr, 0, 0, dpr, dpr * sh.x * s, dpr * sh.y * s);
  const toScreen = (p: Pt): Pt => ({ x: ox + p.x * s, y: oy + p.y * s });
  world();

  // Scorch decals from hits so far.
  for (const h of m.hits) {
    if (h.t > ph) continue;
    const k = clamp01((ph - h.t) / (0.35 * TICK_HZ));
    const r = h.hpAfter === 0 ? 1.4 : 0.95;
    const sg = g.createRadialGradient(h.x, h.y, 0, h.x, h.y, r);
    sg.addColorStop(0, `rgba(0,0,0,${0.55 * k})`);
    sg.addColorStop(0.6, `rgba(10,6,4,${0.28 * k})`);
    sg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = sg;
    g.beginPath(); g.arc(h.x, h.y, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = `rgba(255,140,60,${0.18 * k})`;
    for (let i = 0; i < 6; i++) {
      const an = rnd(h.shell, i) * Math.PI * 2, rr = 0.25 + rnd(h.shell, i + 9) * 0.6;
      g.beginPath(); g.arc(h.x + Math.cos(an) * rr, h.y + Math.sin(an) * rr, 0.035, 0, Math.PI * 2); g.fill();
    }
  }

  // Tread history: faint path of the last ~3 s.
  for (const slot of [0, 1] as const) {
    const col = sc.colors[slot];
    const n = 90;
    const start = Math.max(0, i0 - n);
    g.lineWidth = 0.09;
    g.lineCap = "round";
    for (let k = start; k < i0; k += 3) {
      const p = m.frames[k].tanks[slot], q = m.frames[Math.min(i0, k + 3)].tanks[slot];
      if (Math.hypot(q.x - p.x, q.y - p.y) < 0.01) continue;
      const age = (i0 - k) / n;
      g.strokeStyle = rgba(col, 0.13 * (1 - age));
      for (const side of [-0.54, 0.54]) {
        const nx = -Math.sin(p.heading) * side, ny = Math.cos(p.heading) * side;
        const mx = -Math.sin(q.heading) * side, my = Math.cos(q.heading) * side;
        g.beginPath(); g.moveTo(p.x + nx, p.y + ny); g.lineTo(q.x + mx, q.y + my); g.stroke();
      }
    }
  }

  const pend = ([0, 1] as const).map((slot) => pendingView(m, slot, i0));

  // Aim lines.
  for (const slot of [0, 1] as const) {
    const me = tanks[slot];
    if (me.hp <= 0) continue;
    const enemy = tanks[slot === 0 ? 1 : 0];
    const { end, onTarget } = castAim(m, me, enemy);
    const o = muzzle(me);
    const col = sc.colors[slot];
    const lg = g.createLinearGradient(o.x, o.y, end.x, end.y);
    lg.addColorStop(0, rgba(col, onTarget ? 0.55 : 0.28));
    lg.addColorStop(1, rgba(col, onTarget ? 0.35 : 0));
    g.strokeStyle = lg;
    g.lineWidth = (onTarget ? 1.6 : 1) * px;
    g.setLineDash(onTarget ? [] : [0.3, 0.22]);
    g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(end.x, end.y); g.stroke();
    g.setLineDash([]);
    if (onTarget) {
      g.strokeStyle = rgba(col, 0.85);
      g.lineWidth = 1.4 * px;
      const r = 0.24;
      g.beginPath(); g.arc(end.x, end.y, r, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(end.x - r * 1.8, end.y); g.lineTo(end.x - r * 1.1, end.y); g.moveTo(end.x + r * 1.1, end.y); g.lineTo(end.x + r * 1.8, end.y); g.stroke();
    }
  }

  // Low-HP smoke and wreck fire (beneath the tank).
  for (const slot of [0, 1] as const) {
    const tk = tanks[slot];
    if (tk.hp > 1) continue;
    const nowS = ph / TICK_HZ;
    const n = tk.hp <= 0 ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const phase = (nowS * (tk.hp <= 0 ? 0.55 : 0.75) + i / n + rnd(slot + 3, i) * 0.3) % 1;
      const dir = rnd(slot + 7, i) * Math.PI * 2;
      const dx = Math.cos(dir) * 0.6 * phase + 0.9 * phase, dy = Math.sin(dir) * 0.6 * phase - 0.5 * phase;
      const r = 0.25 + phase * (tk.hp <= 0 ? 1.1 : 0.7);
      g.fillStyle = `rgba(60,66,76,${(tk.hp <= 0 ? 0.32 : 0.2) * (1 - phase)})`;
      g.beginPath(); g.arc(tk.x + dx, tk.y + dy, r, 0, Math.PI * 2); g.fill();
    }
  }

  // Shells with trails.
  const shells = shellPos(f0, f1, a);
  // After the final tick the world is frozen: fade out shells still in flight.
  const shellAlpha = ph > m.endTick ? clamp01(1 - (ph - m.endTick) / 12) : 1;
  g.globalAlpha = shellAlpha;
  g.lineCap = "round";
  g.globalCompositeOperation = "lighter";
  for (const it of shells) {
    const col = sc.colors[it.s.owner];
    const pts = trailPoints(m, it.s.id, it, i0, 2.4);
    for (let j = 0; j < pts.length - 1; j++) {
      const k = 1 - j / Math.max(1, pts.length - 1);
      g.strokeStyle = rgba(col, 0.5 * k);
      g.lineWidth = SHELL_RADIUS * (0.6 + 1.2 * k);
      g.beginPath(); g.moveTo(pts[j].x, pts[j].y); g.lineTo(pts[j + 1].x, pts[j + 1].y); g.stroke();
    }
    const gl = g.createRadialGradient(it.x, it.y, 0, it.x, it.y, 0.55);
    gl.addColorStop(0, rgba(col.bright, 0.9));
    gl.addColorStop(0.35, rgba(col, 0.35));
    gl.addColorStop(1, rgba(col, 0));
    g.fillStyle = gl;
    g.beginPath(); g.arc(it.x, it.y, 0.55, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = "source-over";
  for (const it of shells) {
    g.fillStyle = "#ffffff";
    g.beginPath(); g.arc(it.x, it.y, SHELL_RADIUS * 0.95, 0, Math.PI * 2); g.fill();
    if (it.s.bounces > 0) {
      g.strokeStyle = rgba(sc.colors[it.s.owner], 0.9);
      g.lineWidth = 1.2 * px;
      g.beginPath(); g.arc(it.x, it.y, SHELL_RADIUS * 1.9, 0, Math.PI * 2); g.stroke();
    }
  }
  g.globalAlpha = 1;

  // Tanks.
  const lastFire: [number, number] = [-1e9, -1e9];
  const lastHit: [number, number] = [-1e9, -1e9];
  for (let k = Math.max(0, i0 - 12); k <= i0; k++) for (const e of m.frames[k].events) {
    if (e.type === "fire") lastFire[e.slot] = e.t;
    if (e.type === "hit") lastHit[e.victim] = e.t;
  }
  for (const slot of [0, 1] as const) {
    const tk = tanks[slot];
    const fireAge = (ph - lastFire[slot]) / TICK_HZ;
    const hitAge = (ph - lastHit[slot]) / TICK_HZ;
    drawTank(g, tk, sc.colors[slot], {
      mode: tk.hp <= 0 ? "dead" : "live",
      flash: hitAge >= 0 && hitAge < 0.16 ? 1 - hitAge / 0.16 : 0,
      recoil: fireAge >= 0 && fireAge < 0.3 ? 0.24 * Math.exp(-fireAge * 14) : 0,
    }, px);
  }

  // Reload rings.
  for (const slot of [0, 1] as const) {
    const tk = tanks[slot];
    if (tk.hp <= 0) continue;
    const col = sc.colors[slot];
    const prog = 1 - clamp01(tk.reload / RELOAD_TICKS);
    const r = TANK_RADIUS + 0.26;
    g.lineWidth = 0.075;
    g.lineCap = "butt";
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.beginPath(); g.arc(tk.x, tk.y, r, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = prog >= 1 ? rgba(col, 0.55) : rgba(col.bright, 0.9);
    g.beginPath(); g.arc(tk.x, tk.y, r, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); g.stroke();
  }

  // Ghosts (above the tanks so they stay visible when close): where the enemy was at the issue tick of each
  // tank's in-flight decision, i.e. the state that model is reacting to.
  if (sc.ghosts) {
    for (const obs of [0, 1] as const) {
      const p = pend[obs];
      if (!p || p.issueTick > m.endTick) continue;
      const enemySlot = obs === 0 ? 1 : 0;
      const seen = m.frames[p.issueTick].tanks[enemySlot];
      const real = tanks[enemySlot];
      if (real.hp <= 0) continue;
      const col = sc.colors[obs];
      const fresh = clamp01(1 - (t - p.issueTick) / 3.5);
      const drift = Math.hypot(real.x - seen.x, real.y - seen.y);
      if (drift > 0.05) {
        g.save();
        g.setLineDash([0.12, 0.12]);
        g.lineWidth = 1.3 * px;
        g.strokeStyle = rgba(col, 0.7);
        g.beginPath(); g.moveTo(seen.x, seen.y); g.lineTo(real.x, real.y); g.stroke();
        g.restore();
      }
      drawTank(g, seen, col, { mode: "ghost", flash: 0, recoil: 0 }, px);
      if (fresh > 0) {
        g.strokeStyle = rgba(col, 0.55 * fresh);
        g.lineWidth = 1.6 * px;
        g.beginPath(); g.arc(seen.x, seen.y, 0.95 + (1 - fresh) * 0.9, 0, Math.PI * 2); g.stroke();
      }
    }
  }

  // Effects.
  const callouts: { kind: "own" | "dmg" | "fizzle" | "clash"; p: Pt; age: number; slot: 0 | 1 | null; hp?: number }[] = [];
  const from = Math.max(0, Math.floor(t) - 70);
  for (let k = from; k <= i0; k++) {
    for (const e of m.frames[k].events) {
      const age = (ph - e.t) / TICK_HZ;
      if (age < 0) continue;
      drawEffect(g, m, sc, e, age, px, callouts);
    }
  }

  // ---------- screen-space HUD ----------
  screen();
  const huds = layoutHuds(g, view, sc, tanks, toScreen);
  for (const slot of [0, 1] as const) drawHud(g, sc, slot, tanks[slot], pend[slot], t, huds[slot]);
  for (const c of callouts) drawCallout(g, view, sc, c, toScreen, c.slot !== null ? huds[c.slot] : null);
  world();
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function drawEffect(
  g: Ctx, m: MatchModel, sc: Scene, e: SimEvent, age: number, px: number,
  callouts: { kind: "own" | "dmg" | "fizzle" | "clash"; p: Pt; age: number; slot: 0 | 1 | null; hp?: number }[],
): void {
  if (e.type === "fire") {
    if (age > 0.5) return;
    const tk = m.frames[e.t].tanks[e.slot];
    const mz = muzzle(tk);
    const ang = turretWorld(tk);
    const col = sc.colors[e.slot];
    if (age < 0.14) {
      const k = 1 - age / 0.14;
      g.save();
      g.translate(mz.x, mz.y);
      g.rotate(ang);
      g.globalCompositeOperation = "lighter";
      const fg = g.createRadialGradient(0.25, 0, 0, 0.25, 0, 0.75);
      fg.addColorStop(0, `rgba(255,255,240,${k})`);
      fg.addColorStop(0.3, rgba(col.bright, 0.7 * k));
      fg.addColorStop(1, rgba(col, 0));
      g.fillStyle = fg;
      g.beginPath(); g.ellipse(0.3, 0, 0.75 * (0.6 + age * 4), 0.3, 0, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    for (let i = 0; i < 4; i++) {
      const k = age / 0.5;
      const sp = 0.6 + rnd(e.shell, i) * 0.9;
      const da = (rnd(e.shell, i + 5) - 0.5) * 1.4;
      const d = dragDist(sp, 4, age);
      g.fillStyle = `rgba(150,160,175,${0.16 * (1 - k)})`;
      g.beginPath(); g.arc(mz.x + Math.cos(ang + da) * d, mz.y + Math.sin(ang + da) * d, 0.12 + k * 0.35, 0, Math.PI * 2); g.fill();
    }
    return;
  }
  if (e.type === "bounce") {
    if (age > 0.4) return;
    const k = age / 0.4;
    g.globalCompositeOperation = "lighter";
    g.strokeStyle = `rgba(255,230,170,${0.6 * (1 - k)})`;
    g.lineWidth = 1.5 * px;
    g.beginPath(); g.arc(e.x, e.y, 0.15 + easeOut(k) * 0.6, 0, Math.PI * 2); g.stroke();
    g.lineCap = "round";
    for (let i = 0; i < 10; i++) {
      const an = rnd(e.shell * 31 + e.t, i) * Math.PI * 2;
      const sp = 3 + rnd(e.shell * 31 + e.t, i + 20) * 7;
      const d = dragDist(sp, 6, age);
      const x = e.x + Math.cos(an) * d, y = e.y + Math.sin(an) * d;
      const tail = 0.14 * (1 - k);
      g.strokeStyle = `rgba(255,${200 + Math.round(rnd(e.shell, i) * 55)},140,${1 - k})`;
      g.lineWidth = 0.05;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - Math.cos(an) * tail, y - Math.sin(an) * tail); g.stroke();
    }
    g.globalCompositeOperation = "source-over";
    return;
  }
  if (e.type === "hit") {
    const big = e.hpAfter === 0 ? 1.6 : 1;
    const dur = 1.1 * big;
    if (age > dur + 0.6) return;
    const vic = sc.colors[e.victim];
    const seed = e.shell * 13 + e.t;
    g.globalCompositeOperation = "lighter";
    if (age < 0.2) {
      const k = 1 - age / 0.2;
      g.fillStyle = `rgba(255,255,255,${0.9 * k})`;
      g.beginPath(); g.arc(e.x, e.y, (0.5 + age * 5) * big, 0, Math.PI * 2); g.fill();
    }
    if (age < 0.55 * big) {
      const k = age / (0.55 * big);
      const r = (0.5 + 1.3 * easeOut(k)) * big;
      const fb = g.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      fb.addColorStop(0, `rgba(255,245,215,${1 - k})`);
      fb.addColorStop(0.35, `rgba(255,160,60,${0.85 * (1 - k)})`);
      fb.addColorStop(1, "rgba(255,60,20,0)");
      g.fillStyle = fb;
      g.beginPath(); g.arc(e.x, e.y, r, 0, Math.PI * 2); g.fill();
    }
    if (age < 0.5) {
      const k = age / 0.5;
      g.strokeStyle = rgba(vic.bright, 0.75 * (1 - k) * (1 - k));
      g.lineWidth = 0.16 * (1 - k) + px;
      g.beginPath(); g.arc(e.x, e.y, (0.4 + 2.4 * easeOut(k)) * (big > 1 ? 1.25 : 1), 0, Math.PI * 2); g.stroke();
    }
    const nDeb = Math.round(22 * big);
    for (let i = 0; i < nDeb; i++) {
      const life = (0.5 + rnd(seed, i) * 0.6) * big;
      if (age > life) continue;
      const k = age / life;
      const an = rnd(seed, i + 40) * Math.PI * 2;
      const sp = 4 + rnd(seed, i + 80) * 9;
      const d = dragDist(sp, 4.5, age);
      const ember = i % 3 === 0;
      g.fillStyle = ember ? `rgba(255,${150 + Math.round(rnd(seed, i) * 90)},70,${1 - k})` : rgba(vic.main, 0.9 * (1 - k));
      const sz = (ember ? 0.05 : 0.07 + rnd(seed, i + 7) * 0.08) * (1 - k * 0.5);
      g.beginPath(); g.arc(e.x + Math.cos(an) * d, e.y + Math.sin(an) * d, sz, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = "source-over";
    for (let i = 0; i < 6; i++) {
      const life = dur + 0.4;
      if (age > life) continue;
      const k = age / life;
      const an = rnd(seed, i + 120) * Math.PI * 2;
      const d = dragDist(1.2 + rnd(seed, i + 130) * 1.5, 2, age);
      g.fillStyle = `rgba(55,60,70,${0.32 * (1 - k) * clamp01(age * 8)})`;
      g.beginPath(); g.arc(e.x + Math.cos(an) * d, e.y + Math.sin(an) * d, (0.3 + k * 1.1) * big, 0, Math.PI * 2); g.fill();
    }
    if (age < 1.1) callouts.push({ kind: "dmg", p: { x: e.x, y: e.y }, age, slot: e.victim, hp: e.hpAfter });
    if (e.self && age < 1.9) {
      const v = m.frames[Math.min(m.endTick, e.t)].tanks[e.victim];
      callouts.push({ kind: "own", p: { x: v.x, y: v.y }, age, slot: e.victim });
    }
    return;
  }
  if (e.type === "clash") {
    if (age > 0.5) return;
    const k = age / 0.5;
    g.globalCompositeOperation = "lighter";
    if (age < 0.12) {
      g.fillStyle = `rgba(255,255,255,${1 - age / 0.12})`;
      g.beginPath(); g.arc(e.x, e.y, 0.35 + age * 4, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = `rgba(220,240,255,${0.9 * (1 - k)})`;
    g.lineWidth = 0.06 * (1 - k) + px;
    g.lineCap = "round";
    for (let i = 0; i < 8; i++) {
      const an = (i / 8) * Math.PI * 2 + rnd(e.t, i) * 0.3;
      const r0 = 0.2 + easeOut(k) * 0.6, r1 = 0.4 + easeOut(k) * (1.2 + (i % 2) * 0.5);
      g.beginPath(); g.moveTo(e.x + Math.cos(an) * r0, e.y + Math.sin(an) * r0); g.lineTo(e.x + Math.cos(an) * r1, e.y + Math.sin(an) * r1); g.stroke();
    }
    g.strokeStyle = `rgba(160,220,255,${0.6 * (1 - k)})`;
    g.beginPath(); g.arc(e.x, e.y, 0.3 + easeOut(k) * 1.6, 0, Math.PI * 2); g.stroke();
    g.globalCompositeOperation = "source-over";
    if (age < 0.9) callouts.push({ kind: "clash", p: { x: e.x, y: e.y }, age, slot: null });
    return;
  }
  if (e.type === "fizzle") {
    if (age > 0.9) return;
    const tk = m.frames[e.t].tanks[e.slot];
    const mz = muzzle(tk);
    const k = age / 0.9;
    for (let i = 0; i < 6; i++) {
      const an = rnd(e.t * 7 + e.slot, i) * Math.PI * 2;
      const d = dragDist(0.8 + rnd(e.t, i + 3) * 0.8, 3, age);
      g.fillStyle = `rgba(185,190,200,${0.42 * (1 - k)})`;
      g.beginPath(); g.arc(mz.x + Math.cos(an) * d, mz.y + Math.sin(an) * d, 0.16 + k * 0.6, 0, Math.PI * 2); g.fill();
    }
    callouts.push({ kind: "fizzle", p: mz, age, slot: e.slot });
  }
}

type HudBox = { x: number; y: number; w: number; h: number; tag: string };

const HUD_H = 32;

function hudBox(g: Ctx, view: View, sc: Scene, slot: 0 | 1, p: Pt, below: boolean): HudBox {
  const tag = sc.tags[slot];
  g.font = `700 10px ${UI_FONT}`;
  if ("letterSpacing" in g) (g as Ctx & { letterSpacing: string }).letterSpacing = "0.08em";
  const nameW = g.measureText(tag).width;
  if ("letterSpacing" in g) (g as Ctx & { letterSpacing: string }).letterSpacing = "0px";
  const w = Math.max(nameW + 8 + 27, 128) + 16;
  const gap = (TANK_RADIUS + 0.42) * view.s;
  let y = below ? p.y + gap : p.y - gap - HUD_H;
  if (y < 4) y = p.y + gap; // flip below near the top edge
  if (y + HUD_H > view.h - 4) y = p.y - gap - HUD_H;
  const x = Math.max(4, Math.min(view.w - w - 4, p.x - w / 2));
  return { x, y, w, h: HUD_H, tag };
}

const overlap = (a: HudBox, b: HudBox, pad = 4) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/** Place both tank HUDs, flipping or nudging them apart when the tanks are close. */
function layoutHuds(g: Ctx, view: View, sc: Scene, tanks: [TankSnap, TankSnap], toScreen: (p: Pt) => Pt): [HudBox, HudBox] {
  const p = [toScreen(tanks[0]), toScreen(tanks[1])];
  const out: [HudBox, HudBox] = [hudBox(g, view, sc, 0, p[0], false), hudBox(g, view, sc, 1, p[1], false)];
  if (!overlap(out[0], out[1])) return out;
  const lower = p[0].y > p[1].y ? 0 : 1;
  out[lower] = hudBox(g, view, sc, lower, p[lower], true);
  if (!overlap(out[0], out[1])) return out;
  // Still colliding (tanks level with each other): push apart horizontally.
  const [l, r] = out[0].x <= out[1].x ? [out[0], out[1]] : [out[1], out[0]];
  const push = (l.x + l.w + 6 - r.x) / 2;
  if (push > 0) {
    l.x = Math.max(4, l.x - push);
    r.x = Math.min(view.w - r.w - 4, r.x + push);
  }
  return out;
}

function drawHud(g: Ctx, sc: Scene, slot: 0 | 1, tk: TankSnap, pend: PendingView | null, t: number, box: HudBox): void {
  const col = sc.colors[slot];
  const dead = tk.hp <= 0;
  const { x, y, w, h, tag } = box;

  g.globalAlpha = dead ? 0.55 : 1;
  g.fillStyle = "rgba(6,9,14,0.8)";
  roundRect(g, x, y, w, h, 6);
  g.fill();
  g.strokeStyle = rgba(col, 0.32);
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = col.main;
  g.fillRect(x, y + 6, 2, h - 12);

  g.font = `700 10px ${UI_FONT}`;
  if ("letterSpacing" in g) (g as Ctx & { letterSpacing: string }).letterSpacing = "0.08em";
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = col.bright;
  g.fillText(tag, x + 8, y + 10);
  if ("letterSpacing" in g) (g as Ctx & { letterSpacing: string }).letterSpacing = "0px";

  // HP pips.
  const maxHp = Math.max(3, sc.model.frames[0].tanks[slot].hp);
  for (let i = 0; i < maxHp; i++) {
    const px0 = x + w - 8 - (maxHp - i) * 7 - (maxHp - 1 - i) * 3 + 3;
    const on = i < tk.hp;
    g.fillStyle = on ? col.main : "rgba(255,255,255,0.08)";
    g.strokeStyle = on ? col.bright : "rgba(255,255,255,0.2)";
    roundRect(g, px0, y + 6, 7, 8, 1.5);
    g.fill();
    if (!on) g.stroke();
  }

  // Ping meter: fills while a decision is in flight.
  const bx = x + 8, by = y + 21, bw = 40, bh = 4;
  g.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(g, bx, by, bw, bh, 2);
  g.fill();
  if (pend && pend.applyTick === null) {
    // Live: the answer hasn't landed yet. Fill asymptotically and count the game time spent thinking.
    const elapsedMs = ((t - pend.issueTick) / TICK_HZ) * 1000;
    const frac = 1 - Math.exp(-elapsedMs / 380);
    const pulse = 0.65 + 0.35 * Math.sin(t * 0.9);
    g.fillStyle = rgba(col, 0.55 + 0.35 * pulse);
    roundRect(g, bx, by, Math.max(2, bw * frac), bh, 2);
    g.fill();
    g.font = `600 10px ${MONO_FONT}`;
    g.fillStyle = "#e6edf5";
    const real = `${Math.round(elapsedMs)}`;
    g.fillText(real, bx + bw + 6, by + 2);
    const rw = g.measureText(real).width;
    g.font = `500 9px ${MONO_FONT}`;
    g.fillStyle = "rgba(170,185,205,0.7)";
    g.fillText("ms · thinking", bx + bw + 8 + rw, by + 2);
  } else if (pend && pend.applyTick !== null) {
    const span = Math.max(1, pend.applyTick - pend.issueTick);
    const frac = clamp01((t - pend.issueTick) / span);
    g.fillStyle = pend.error ? "#ff4d5e" : frac > 0.85 ? col.bright : col.main;
    roundRect(g, bx, by, Math.max(2, bw * frac), bh, 2);
    g.fill();
    g.font = `600 10px ${MONO_FONT}`;
    g.fillStyle = "#e6edf5";
    const real = `${pend.realMs}`;
    g.fillText(real, bx + bw + 6, by + 2);
    const rw = g.measureText(real).width;
    g.font = `500 9px ${MONO_FONT}`;
    g.fillStyle = "rgba(170,185,205,0.7)";
    g.fillText(`ms · eff ${pend.effMs}`, bx + bw + 8 + rw, by + 2);
  } else {
    g.font = `500 9px ${MONO_FONT}`;
    g.fillStyle = "rgba(170,185,205,0.5)";
    g.fillText(dead ? "offline" : "idle", bx + bw + 6, by + 2);
  }
  g.globalAlpha = 1;
}

function drawCallout(
  g: Ctx, view: View, sc: Scene, c: { kind: "own" | "dmg" | "fizzle" | "clash"; p: Pt; age: number; slot: 0 | 1 | null; hp?: number },
  toScreen: (p: Pt) => Pt, hud: HudBox | null,
): void {
  const p = toScreen(c.p);
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (c.kind === "dmg") {
    const k = c.age / 1.1;
    const y = p.y - 10 - easeOut(k) * 26;
    g.globalAlpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
    g.font = `800 15px ${UI_FONT}`;
    g.lineWidth = 3;
    g.strokeStyle = "rgba(0,0,0,0.75)";
    g.strokeText("−1", p.x + 14, y);
    g.fillStyle = "#ff5a5f";
    g.fillText("−1", p.x + 14, y);
    g.globalAlpha = 1;
    return;
  }
  if (c.kind === "fizzle") {
    const k = c.age / 0.9;
    g.globalAlpha = 1 - k;
    g.font = `700 10px ${UI_FONT}`;
    g.fillStyle = "#c3cad5";
    g.fillText("FIZZLE", p.x, p.y - 12 - k * 12);
    g.globalAlpha = 1;
    return;
  }
  if (c.kind === "clash") {
    const k = c.age / 0.9;
    g.globalAlpha = (1 - k) * 0.9;
    g.font = `800 10px ${UI_FONT}`;
    g.fillStyle = "#d9f1ff";
    g.fillText("CLASH", p.x, p.y - 18 - k * 10);
    g.globalAlpha = 1;
    return;
  }
  // OWN GOAL
  const sc0 = c.age < 0.25 ? easeOutBack(c.age / 0.25) : 1;
  const alpha = c.age > 1.4 ? 1 - (c.age - 1.4) / 0.5 : 1;
  // Above the victim's HUD pill (or below everything when there is no room).
  const top = Math.min(hud ? hud.y : p.y, p.y - (TANK_RADIUS + 0.4) * view.s);
  let cy = top - 40;
  if (cy < 26) cy = Math.max(hud ? hud.y + hud.h : p.y, p.y + (TANK_RADIUS + 0.4) * view.s) + 28;
  const cx = Math.max(110, Math.min(view.w - 110, p.x));
  g.save();
  g.translate(cx, cy);
  g.rotate(-0.06);
  g.scale(sc0, sc0);
  g.globalAlpha = clamp01(alpha);
  g.font = `italic 900 26px ${UI_FONT}`;
  if ("letterSpacing" in g) (g as Ctx & { letterSpacing: string }).letterSpacing = "0.04em";
  const tg = g.createLinearGradient(0, -14, 0, 14);
  tg.addColorStop(0, "#ffd166");
  tg.addColorStop(1, "#ff4d5e");
  g.lineWidth = 6;
  g.lineJoin = "round";
  g.strokeStyle = "rgba(8,6,10,0.9)";
  g.strokeText("OWN GOAL!", 0, 0);
  g.fillStyle = tg;
  g.fillText("OWN GOAL!", 0, 0);
  if ("letterSpacing" in g) (g as Ctx & { letterSpacing: string }).letterSpacing = "0px";
  g.font = `700 10px ${UI_FONT}`;
  g.fillStyle = "rgba(255,230,230,0.9)";
  const tag = c.slot !== null ? sc.tags[c.slot] : "";
  g.fillText(`${tag} hit by its own bounced shell`, 0, 20);
  g.restore();
}
