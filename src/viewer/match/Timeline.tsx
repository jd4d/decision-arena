import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import type { MatchModel, Marker } from "../replay/model.ts";
import { SPEEDS, usePlayer, type Player } from "../replay/player.ts";
import { clock } from "../lib/format.ts";
import { rgba, type TeamColor } from "../lib/theme.ts";

type Props = { model: MatchModel; player: Player; colors: [TeamColor, TeamColor]; live?: boolean };

const KEY_MARKERS = new Set(["hit", "self", "clash", "end", "fizzle"]);
const JUMP_KINDS = new Set(["hit", "self", "clash", "end"]);

export function jumpTarget(model: MatchModel, tick: number, dir: 1 | -1): number | null {
  const lead = model.header.tickHz; // land 1 s before the event so slow-mo can ramp in
  const ts = model.markers.filter((m) => JUMP_KINDS.has(m.kind)).map((m) => Math.max(0, m.tick - lead));
  if (dir > 0) return ts.find((t) => t > tick + 2) ?? null;
  const prev = ts.filter((t) => t < tick - 2);
  return prev.length ? prev[prev.length - 1] : null;
}

export function Timeline({ model, player, colors, live = false }: Props) {
  const snap = usePlayer(player);
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ wasPlaying: boolean } | null>(null);
  const [hover, setHover] = useState<{ x: number; tick: number; marker: Marker | null } | null>(null);
  const [help, setHelp] = useState(false);
  // Live: the track spans the whole round and fills like a video buffer as the stream arrives.
  const end = live ? Math.max(1, model.header.roundTicks, snap.end) : Math.max(1, model.endTick);
  const avail = snap.end;
  const hz = model.header.tickHz;

  // Playhead follows the fractional clock every frame without React renders.
  useEffect(() => {
    const upd = (ph: number) => {
      const p = `${(Math.min(ph, end) / end) * 100}%`;
      if (headRef.current) headRef.current.style.left = p;
      if (fillRef.current) fillRef.current.style.width = p;
      if (timeRef.current) timeRef.current.textContent = clock(Math.min(ph, end) / hz);
    };
    upd(player.playhead);
    return player.onFrame(upd);
  }, [player, end, hz]);

  // Latency waveform: one bar per decision spanning issue → apply, height ∝ real latency.
  useEffect(() => {
    const cv = waveRef.current;
    if (!cv) return;
    const draw = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      const g = cv.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = r.width, H = r.height, mid = H / 2;
      g.clearRect(0, 0, W, H);
      const all = [...model.decisions[0], ...model.decisions[1]].map((d) => d.realMs).sort((a, b) => a - b);
      const cap = Math.max(300, all[Math.floor(all.length * 0.98)] ?? 300);
      for (const slot of [0, 1] as const) {
        const dir = slot === 0 ? -1 : 1;
        for (const d of model.decisions[slot]) {
          if (d.issueTick > end) continue;
          const x0 = (d.issueTick / end) * W;
          const x1 = (Math.min(end, d.applyTick) / end) * W;
          const hgt = Math.min(1, d.realMs / cap) * (mid - 3);
          g.fillStyle = d.error ? "rgba(255,77,94,0.9)" : rgba(colors[slot], 0.42);
          const y = dir < 0 ? mid - hgt : mid;
          g.fillRect(x0, y, Math.max(0.6, x1 - x0 - 0.4), d.error ? mid - 3 : hgt);
        }
      }
      for (const mk of model.markers) {
        if (mk.kind !== "fire" || mk.slot === null) continue;
        const x = (mk.tick / end) * W;
        g.fillStyle = colors[mk.slot].bright;
        if (mk.slot === 0) g.fillRect(x - 0.75, 0, 1.5, 4);
        else g.fillRect(x - 0.75, H - 4, 1.5, 4);
      }
      g.fillStyle = "rgba(255,255,255,0.14)";
      g.fillRect(0, mid - 0.5, W, 1);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [model, colors, end, avail]);

  const tickAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * end;
  };
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { wasPlaying: player.playing };
    player.pause();
    player.seek(tickAt(e.clientX));
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const tick = tickAt(e.clientX);
    if (drag.current) player.seek(tick);
    const r = trackRef.current!.getBoundingClientRect();
    const near = model.markers
      .filter((m) => KEY_MARKERS.has(m.kind))
      .map((m) => ({ m, dx: Math.abs((m.tick / end) * r.width - (e.clientX - r.left)) }))
      .filter((o) => o.dx < 7)
      .sort((a, b) => a.dx - b.dx)[0];
    setHover({ x: e.clientX - r.left, tick, marker: near?.m ?? null });
  };
  const onUp = () => {
    if (drag.current?.wasPlaying) player.play();
    drag.current = null;
  };

  const markers = model.markers.filter((m) => KEY_MARKERS.has(m.kind));
  const prev = jumpTarget(model, snap.tick, -1);
  const next = jumpTarget(model, snap.tick, 1);

  return (
    <div className="timeline">
      <div className="timeline__controls">
        <div className="transport">
          <IconBtn label="Previous event ([)" disabled={prev === null} onClick={() => prev !== null && player.seek(prev)}>
            <path d="M4 3v10M13 3 6 8l7 5z" />
          </IconBtn>
          <IconBtn label="Back one tick (,)" onClick={() => player.step(-1)}>
            <path d="M11 3 5 8l6 5" fill="none" />
          </IconBtn>
          <button className="transport__play" onClick={() => player.toggle()} aria-label={snap.playing ? "Pause (space)" : "Play (space)"} title={snap.playing ? "Pause (space)" : "Play (space)"}>
            {snap.playing ? (
              <svg viewBox="0 0 16 16" aria-hidden><rect x="3.5" y="2.5" width="3" height="11" rx="1" /><rect x="9.5" y="2.5" width="3" height="11" rx="1" /></svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" /></svg>
            )}
          </button>
          <IconBtn label="Forward one tick (.)" onClick={() => player.step(1)}>
            <path d="m5 3 6 5-6 5" fill="none" />
          </IconBtn>
          <IconBtn label="Next event (])" disabled={next === null} onClick={() => next !== null && player.seek(next)}>
            <path d="M12 3v10M3 3l7 5-7 5z" />
          </IconBtn>
        </div>
        <div className="timeline__time">
          <span ref={timeRef}>0:00.0</span>
          <span className="timeline__dur"> / {clock(end / hz)}</span>
          <span className="timeline__tick">tick {snap.tick}</span>
        </div>
        <div className="timeline__right">
          {snap.live ? (
            snap.behind ? (
              <button className="golive" onClick={() => player.goLive()} title="Jump to the live edge (End)">
                <span className="golive__dot" /> Go live
              </button>
            ) : (
              <span className="golive is-live" title="Playing just behind the live stream">
                <span className="golive__dot" /> Live
              </span>
            )
          ) : (
            <div className="seg" role="radiogroup" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button key={s} role="radio" aria-checked={snap.speed === s} className={snap.speed === s ? "is-on" : ""} onClick={() => player.setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
          )}
          <Toggle on={snap.slowmo} onClick={() => player.setSlowmo(!snap.slowmo)} label="Auto slow-mo" hint="S" />
          <Toggle on={snap.ghosts} onClick={() => player.setGhosts(!snap.ghosts)} label="Ghosts" hint="G" />
          <div className="help">
            <button className="help__btn" onClick={() => setHelp((h) => !h)} aria-expanded={help} aria-label="Keyboard shortcuts">?</button>
            {help && (
              <div className="help__pop" onMouseLeave={() => setHelp(false)}>
                <h5>Keyboard</h5>
                <dl>
                  <dt>Space</dt><dd>Play / pause</dd>
                  <dt>← →</dt><dd>Seek 1 s (Shift: 5 s)</dd>
                  <dt>, .</dt><dd>Step one tick</dd>
                  <dt>[ ]</dt><dd>Previous / next event</dd>
                  {live ? <><dt>End</dt><dd>Jump to live</dd></> : <><dt>↑ ↓</dt><dd>Faster / slower</dd></>}
                  <dt>S · G</dt><dd>Slow-mo · ghosts</dd>
                  <dt>Home End</dt><dd>Start / end</dd>
                </dl>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="track" ref={trackRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => !drag.current && setHover(null)}>
        <div className="track__markers">
          {markers.map((m, i) => (
            <button
              key={i}
              className={`mk mk--${m.kind}`}
              style={{ left: `${(m.tick / end) * 100}%`, ...(m.slot !== null && m.kind !== "end" ? { color: colors[m.slot].main } : {}) }}
              title={`${clock(m.tick / hz)} · ${m.label}`}
              aria-label={`${clock(m.tick / hz)} ${m.label}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => { player.seek(Math.max(0, m.tick - hz)); player.play(); }}
            >
              <MarkerGlyph kind={m.kind} />
            </button>
          ))}
        </div>
        <div className="track__wave">
          {live && <div className="track__buffer" style={{ width: `${(Math.min(avail, end) / end) * 100}%` }} />}
          <canvas ref={waveRef} />
          <div className="track__fill" ref={fillRef} />
          <span className="track__lane track__lane--a" style={{ color: colors[0].main }}>latency</span>
        </div>
        <div className="track__head" ref={headRef}><span /></div>
        {hover && (
          <div className="track__tip" style={{ left: hover.x }}>
            <b>{clock((hover.marker?.tick ?? hover.tick) / hz)}</b>
            {hover.marker && <span>{hover.marker.label}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button className="icon-btn" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" aria-hidden fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">{children}</svg>
    </button>
  );
}

function Toggle({ on, onClick, label, hint }: { on: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button className={`toggle ${on ? "is-on" : ""}`} onClick={onClick} aria-pressed={on} title={`${label} (${hint})`}>
      <span className="toggle__sw" />
      {label}
    </button>
  );
}

function MarkerGlyph({ kind }: { kind: string }) {
  if (kind === "end") return <svg viewBox="0 0 12 14" aria-hidden><path d="M2 13V1.5M2 2h8l-2 2.5L10 7H2" fill="currentColor" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
  if (kind === "clash") return <svg viewBox="0 0 12 12" aria-hidden><path d="M6 0.8 7.3 4.7 11.2 6 7.3 7.3 6 11.2 4.7 7.3 0.8 6 4.7 4.7z" fill="currentColor" /></svg>;
  if (kind === "self") return <svg viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="5" fill="currentColor" /><path d="M6 3v3.6M6 8.4v.4" stroke="#06080c" strokeWidth="1.6" strokeLinecap="round" /></svg>;
  if (kind === "fizzle") return <svg viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="2.4" fill="currentColor" opacity=".7" /></svg>;
  return <svg viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="4.2" fill="currentColor" /><circle cx="6" cy="6" r="5.6" fill="none" stroke="currentColor" strokeOpacity=".4" /></svg>;
}
