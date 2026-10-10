// Playback clock. The playhead is a fractional tick; the canvas reads it every animation frame and React
// components subscribe to a coarse snapshot (integer tick + flags) via useSyncExternalStore.
import { useSyncExternalStore } from "react";
import { TICK_HZ } from "../../sim/tuning.ts";

export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
/** Seconds the world stays frozen after the final tick so the last explosion can play out. */
export const EPILOGUE_S = 1.8;

export type PlayerSnap = {
  tick: number;
  playing: boolean;
  speed: number;
  slowmo: boolean;
  ghosts: boolean;
  /** Slow-mo currently engaged (factor < 1). */
  slowActive: boolean;
  /** Playhead is at or past the final tick. */
  ended: boolean;
};

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Auto slow-mo envelope around a hit (seconds of game time): ease in from -0.6 s, hold -0.35..+0.7 s, ease out by +1.05 s. */
function slowWeight(dtS: number): number {
  if (dtS < -0.6 || dtS > 1.05) return 0;
  if (dtS < -0.35) return smooth((dtS + 0.6) / 0.25);
  if (dtS <= 0.7) return 1;
  return 1 - smooth((dtS - 0.7) / 0.35);
}

export const SLOWMO_MIN = 0.28;

export class Player {
  playhead = 0;
  playing = false;
  speed = 1;
  slowmo = true;
  ghosts = true;
  readonly endTick: number;
  readonly playEnd: number;
  private readonly slowTicks: number[];
  private raf = 0;
  private last = 0;
  private frameFns = new Set<(playhead: number) => void>();
  private subs = new Set<() => void>();
  private snapshot: PlayerSnap;

  constructor(endTick: number, slowTicks: number[]) {
    this.endTick = endTick;
    this.playEnd = endTick + EPILOGUE_S * TICK_HZ;
    this.slowTicks = slowTicks.slice().sort((a, b) => a - b);
    this.snapshot = this.makeSnap();
  }

  /** Playback rate multiplier from auto slow-mo at a playhead position (1 = none). */
  slowFactor(ph = this.playhead): number {
    if (!this.slowmo) return 1;
    let w = 0;
    for (const t of this.slowTicks) {
      const d = (ph - t) / TICK_HZ;
      if (d < -1) break;
      w = Math.max(w, slowWeight(d));
    }
    const f = 1 - (1 - SLOWMO_MIN) * w;
    // The world is frozen after the final tick: let the last explosion breathe, but don't drag.
    return ph > this.endTick ? Math.max(f, 0.5) : f;
  }

  private makeSnap(): PlayerSnap {
    return {
      tick: Math.floor(Math.min(this.playhead, this.endTick)),
      playing: this.playing,
      speed: this.speed,
      slowmo: this.slowmo,
      ghosts: this.ghosts,
      slowActive: this.slowFactor() < 0.9,
      ended: this.playhead >= this.endTick,
    };
  }

  private emit(): void {
    for (const f of this.frameFns) f(this.playhead);
    const n = this.makeSnap();
    const o = this.snapshot;
    if (n.tick !== o.tick || n.playing !== o.playing || n.speed !== o.speed || n.slowmo !== o.slowmo || n.ghosts !== o.ghosts || n.slowActive !== o.slowActive || n.ended !== o.ended) {
      this.snapshot = n;
      for (const s of this.subs) s();
    }
  }

  private loop = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const rate = TICK_HZ * this.speed * this.slowFactor();
    this.playhead = Math.min(this.playEnd, this.playhead + dt * rate);
    if (this.playhead >= this.playEnd) this.playing = false;
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(this.loop);
  };

  play(): void {
    if (this.playing) return;
    if (this.playhead >= this.endTick) this.playhead = 0;
    this.playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(tick: number): void {
    this.playhead = Math.max(0, Math.min(this.endTick, tick));
    this.emit();
  }

  /** Step whole ticks (pauses playback). */
  step(n: number): void {
    this.pause();
    const base = n > 0 ? Math.floor(this.playhead + 1e-6) : Math.ceil(this.playhead - 1e-6);
    this.seek(base + n);
  }

  setSpeed(s: number): void { this.speed = s; this.emit(); }
  setSlowmo(on: boolean): void { this.slowmo = on; this.emit(); }
  setGhosts(on: boolean): void { this.ghosts = on; this.emit(); }

  /** Called with the fractional playhead on every animation frame (and on seeks). */
  onFrame(fn: (playhead: number) => void): () => void {
    this.frameFns.add(fn);
    return () => this.frameFns.delete(fn);
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  };

  getSnapshot = () => this.snapshot;

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.playing = false;
    this.frameFns.clear();
    this.subs.clear();
  }
}

export function usePlayer(p: Player): PlayerSnap {
  return useSyncExternalStore(p.subscribe, p.getSnapshot);
}
