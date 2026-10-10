import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MatchModel } from "../replay/model.ts";
import { usePlayer, type Player } from "../replay/player.ts";
import type { TeamColor } from "../lib/theme.ts";
import { drawScene, makeView, renderStatic, VIEW_ASPECT, type View } from "./render.ts";

type Props = {
  model: MatchModel;
  player: Player;
  colors: [TeamColor, TeamColor];
  tags: [string, string];
  labels: [string, string];
  /** Show the built-in end-of-match card (replays). */
  endCard?: boolean;
  /** Live stream running: show the LIVE chip and a "models thinking" hint while waiting at the edge. */
  live?: boolean;
  overlay?: ReactNode;
};

export function ArenaCanvas({ model, player, colors, tags, labels, endCard = true, live = false, overlay }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snap = usePlayer(player);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    let view: View | null = null;
    let layer: HTMLCanvasElement | null = null;
    const draw = (ph: number) => {
      if (view && layer) drawScene(ctx, view, { model, colors, tags, ghosts: player.ghosts, layer }, ph);
    };
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      // Largest arena-aspect box that fits the wrapper.
      let w = Math.floor(r.width), h = Math.floor(w / VIEW_ASPECT);
      if (h > r.height) { h = Math.floor(r.height); w = Math.floor(h * VIEW_ASPECT); }
      w = Math.max(160, w); h = Math.max(100, h);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      view = makeView(w, h, dpr);
      layer = renderStatic(view, model.walls);
      draw(player.playhead);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    const off = player.onFrame(draw);
    return () => { ro.disconnect(); off(); };
  }, [model, player, colors, tags]);

  const end = model.endEvent;
  const showEnd = endCard && snap.ended && !snap.playing;
  // Waiting at the stream edge is normal (the engine pauses while models think); only say so if it lasts.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!live || !snap.starved) { setStalled(false); return; }
    const t = setTimeout(() => setStalled(true), 900);
    return () => clearTimeout(t);
  }, [live, snap.starved]);
  return (
    <div className="arena" ref={wrapRef}>
      <div className={`arena__stage ${snap.slowActive && snap.playing ? "is-slow" : ""}`}>
        <canvas ref={canvasRef} className="arena__canvas" aria-label="Match replay arena" />
        <div className={`arena__chip arena__chip--slowmo ${snap.slowActive && snap.playing ? "is-on" : ""}`}>
          <span className="dot" /> Slow-mo
        </div>
        {live && (
          <div className="arena__live" aria-live="polite">
            <span className="arena__live-pill"><span className="dot" />Live</span>
            <span className={`arena__live-wait ${stalled ? "is-on" : ""}`}>Waiting for the models…</span>
          </div>
        )}
        {snap.ghosts && (
          <div className="arena__legend">
            <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden><rect x="1" y="1" width="14" height="10" rx="3" fill="none" stroke="currentColor" strokeDasharray="2.5 2" /></svg>
            Ghost = enemy as each model last saw it
          </div>
        )}
        {showEnd && (
          <div className="arena__end" key={String(snap.ended)}>
            <div className="arena__end-kicker">{end ? reasonText(end.reason) : model.result?.reason === "aborted" ? "Match aborted" : "End of log"}</div>
            {end && end.winner !== null ? (
              <div className="arena__end-title" style={{ color: colors[end.winner].main }}>{labels[end.winner]} wins</div>
            ) : (
              <div className="arena__end-title">Draw</div>
            )}
            <button className="btn btn--ghost" onClick={() => { player.seek(0); player.play(); }}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Watch again
            </button>
          </div>
        )}
        {overlay}
      </div>
    </div>
  );
}

export function reasonText(r: string): string {
  if (r === "destroyed") return "Tank destroyed";
  if (r === "mutual") return "Mutual destruction";
  if (r === "time") return "Time up";
  return r;
}
