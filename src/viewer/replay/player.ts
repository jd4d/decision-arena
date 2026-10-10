// Playback clock. The playhead is a fractional tick; the canvas reads it every animation frame and React
// components subscribe to a coarse snapshot (integer tick + flags) via useSyncExternalStore.
//
// Live mode: the playable range grows as stream batches arrive (`pushEdge`). Playback aims to sit a small buffer
// behind the stream edge at 1× game time. The engine streams in bursts and often slower than real time (it waits
// for each model's answer before time can pass), so the rate follows the measured stream rate plus a proportional
// pull towards the buffer target, smoothed, instead of stopping and jumping.
import { useSyncExternalStore } from "react";
import { TICK_HZ } from "../../sim/tuning.ts";

export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
/** Seconds the world stays frozen after the final tick so the last explosion can play out. */
export const EPILOGUE_S = 1.8;
/** Live: target distance behind the stream edge, in seconds of game time. */
export const LIVE_BUFFER_S = 0.6;
/** Live: how far behind the edge counts as "not live" (offers a jump back). */
export const LIVE_BEHIND_S = 3;
const LIVE_MAX_RATE = 1.15; // gentle catch-up after slow-mo or a pause
const LIVE_GAIN = 0.9; // rate change per second of buffer error
const LIVE_SMOOTH_S = 0.35; // time constant of the rate filter
const LIVE_WINDOW_MS = 2500; // stream-rate estimation window

export type PlayerSnap = {
  tick: number;
  playing: boolean;
  speed: number;
  slowmo: boolean;
  ghosts: boolean;
  /** Slow-mo currently engaged (factor < 1). */
  slowActive: boolean;
  /** Playhead is at or past the final tick (never true while a live stream is still running). */
  ended: boolean;
  /** Last playable tick. */
  end: number;
  /** Live stream still running. */
  live: boolean;
  /** Live: playhead is well behind the stream edge. */
  behind: boolean;
  /** Live: waiting at the edge for data. */
  starved: boolean;
};

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Auto slow-mo envelope around a hit (seconds of game time): ease in from -0.6 s, hold -0.35..+0.7 s, ease out by +1.05 s. */
function slowWeight(dtS: number): number {
  if (dtS < -0.6 || dtS > 1.05) return 0;
  if (dtS < -0.35) return smooth((dtS + 0.6) / 0.25);
  if (dtS <= 0.7) return 1;
  return 1 - smooth((dtS - 0.7) / 0.35);
}

export const SLOWMO_MIN = 0.28;

type LiveState = { complete: boolean; factor: number; samples: [number, number][] };

export class Player {
  playhead = 0;
  playing = false;
  speed = 1;
  slowmo = true;
  ghosts = true;
  endTick: number;
  /** Shared with the model (grows while live); sorted ascending. */
  private readonly slowTicks: number[];
  private live: LiveState | null = null;
  private raf = 0;
  private last = 0;
  private frameFns = new Set<(playhead: number) => void>();
  private subs = new Set<() => void>();
  private snapshot: PlayerSnap;

  constructor(endTick: number, slowTicks: number[], opts: { live?: boolean } = {}) {
    this.endTick = endTick;
    this.slowTicks = slowTicks;
    if (opts.live) this.live = { complete: false, factor: 0, samples: [] };
    this.snapshot = this.makeSnap();
  }

  get isLive(): boolean { return !!this.live && !this.live.complete; }
  /** Playback stops here: the stream edge while live, otherwise the final tick plus the epilogue. */
  get playEnd(): number { return this.isLive ? this.endTick : this.endTick + EPILOGUE_S * TICK_HZ; }

  /** Live: more frames are available. */
  pushEdge(endTick: number, now = performance.now()): void {
    this.endTick = endTick;
    const L = this.live;
    if (L) {
      L.samples.push([now, endTick]);
      while (L.samples.length > 2 && now - L.samples[1][0] > LIVE_WINDOW_MS) L.samples.shift();
    }
    this.emit();
  }

  /** Live: the stream has ended; play out to the final tick at normal speed. */
  completeLive(endTick: number): void {
    this.endTick = endTick;
    if (this.live) this.live.complete = true;
    this.emit();
  }

  /** Live: seconds of game time between the playhead and the stream edge. */
  get lead(): number { return (this.endTick - this.playhead) / TICK_HZ; }

  /** Live: jump to just behind the stream edge. */
  goLive(): void {
    this.seek(this.endTick - LIVE_BUFFER_S * TICK_HZ);
    if (this.live) this.live.factor = this.streamRate(performance.now());
    this.play();
  }

  /** Live: measured stream speed in game seconds per wall second (0 when stalled). */
  private streamRate(now: number): number {
    const s = this.live?.samples;
    if (!s || s.length < 2) return 0;
    const [t0, e0] = s[0];
    const span = (now - t0) / 1000;
    return span > 0.25 ? clamp((this.endTick - e0) / TICK_HZ / span, 0, 4) : 0;
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
    const live = this.isLive;
    return {
      tick: Math.floor(Math.min(this.playhead, this.endTick)),
      playing: this.playing,
      speed: this.speed,
      slowmo: this.slowmo,
      ghosts: this.ghosts,
      slowActive: this.slowFactor() < 0.9,
      ended: !live && this.playhead >= this.endTick,
      end: this.endTick,
      live,
      behind: live && this.lead > LIVE_BEHIND_S,
      starved: live && this.playing && this.lead < 0.05,
    };
  }

  private emit(): void {
    for (const f of this.frameFns) f(this.playhead);
    const n = this.makeSnap();
    const o = this.snapshot;
    if (
      n.tick !== o.tick || n.playing !== o.playing || n.speed !== o.speed || n.slowmo !== o.slowmo || n.ghosts !== o.ghosts ||
      n.slowActive !== o.slowActive || n.ended !== o.ended || n.end !== o.end || n.live !== o.live || n.behind !== o.behind || n.starved !== o.starved
    ) {
      this.snapshot = n;
      for (const s of this.subs) s();
    }
  }

  private loop = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    let rate = TICK_HZ * this.speed * this.slowFactor();
    const L = this.live;
    if (L) {
      // Live pacing: follow the stream, pulled towards LIVE_BUFFER_S behind its edge; ease rather than jump.
      const target = L.complete ? 1 : clamp(this.streamRate(now) + (this.lead - LIVE_BUFFER_S) * LIVE_GAIN, 0, LIVE_MAX_RATE);
      L.factor += (target - L.factor) * (1 - Math.exp(-dt / LIVE_SMOOTH_S));
      rate *= L.factor;
    }
    this.playhead = Math.min(this.playEnd, this.playhead + dt * rate);
    // While live, keep the clock running at the edge and wait for more data.
    if (!this.isLive && this.playhead >= this.playEnd) this.playing = false;
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(this.loop);
  };

  play(): void {
    if (this.playing) return;
    if (!this.isLive && this.playhead >= this.endTick) this.playhead = 0;
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
