// Screen coordinates: x right, y down. Angle 0 = +x; positive angles rotate clockwise on screen,
// so a positive relative angle means "to the right" from the tank's point of view.
export type Vec = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const TAU = Math.PI * 2;

export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

export const deg = (rad: number) => (rad * 180) / Math.PI;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
export const angleTo = (from: Vec, to: Vec) => Math.atan2(to.y - from.y, to.x - from.x);

export function pointInRect(p: Vec, r: Rect, pad = 0): boolean {
  return p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad;
}

/** Push a circle out of a rect. Returns true if a collision was resolved. */
export function pushCircleOutOfRect(c: Vec, radius: number, r: Rect): boolean {
  const nx = clamp(c.x, r.x, r.x + r.w);
  const ny = clamp(c.y, r.y, r.y + r.h);
  let dx = c.x - nx;
  let dy = c.y - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= radius * radius) return false;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    c.x = nx + (dx / d) * radius;
    c.y = ny + (dy / d) * radius;
    return true;
  }
  // Center inside rect: push out along the shallowest axis.
  const left = c.x - r.x, right = r.x + r.w - c.x, top = c.y - r.y, bottom = r.y + r.h - c.y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) c.x = r.x - radius;
  else if (m === right) c.x = r.x + r.w + radius;
  else if (m === top) c.y = r.y - radius;
  else c.y = r.y + r.h + radius;
  return true;
}

/** Distance along a ray (origin, unit dir) to a rect, or Infinity. Slab method. */
export function rayRect(o: Vec, dx: number, dy: number, r: Rect): number {
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-12) {
    if (o.x <= r.x || o.x >= r.x + r.w) return Infinity;
  } else {
    let t1 = (r.x - o.x) / dx, t2 = (r.x + r.w - o.x) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dy) < 1e-12) {
    if (o.y <= r.y || o.y >= r.y + r.h) return Infinity;
  } else {
    let t1 = (r.y - o.y) / dy, t2 = (r.y + r.h - o.y) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  }
  if (tmax < Math.max(tmin, 0)) return Infinity;
  return tmin >= 0 ? tmin : 0;
}

/** Distance along a ray to a circle, or Infinity. */
export function rayCircle(o: Vec, dx: number, dy: number, c: Vec, radius: number): number {
  const fx = o.x - c.x, fy = o.y - c.y;
  const b = fx * dx + fy * dy;
  const cc = fx * fx + fy * fy - radius * radius;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  if (t >= 0) return t;
  return cc <= 0 ? 0 : Infinity;
}
