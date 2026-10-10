// Hand-rolled charts (no chart library). Each measures its container and draws in CSS pixels so text stays crisp,
// and each renders an explicit empty state when the data is sparse.
//
// Data marks never depend on an entrance animation to become visible: main-thread (SVG) CSS animations can stall at
// their first keyframe in a throttled or occluded browser window, which hid every bar and dot. SVG marks are static;
// the win-rate rows are HTML, whose transform animations run on the compositor; and useSettleAnimations() finishes
// anything still pending after a short delay or when the page is hidden.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { AgentConditionStats, Interval } from "../../analysis/schema.ts";
import { conditionDetail, conditionLabel, driveLabel, pct } from "../lib/format.ts";
import { useSize } from "../lib/useSize.ts";
import type { TeamColor } from "../lib/theme.ts";

export type AgentMeta = { id: string; label: string; color: TeamColor };

export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export function ChartEmpty({ children }: { children: ReactNode }) {
  return <div className="chart-empty">{children}</div>;
}

/** Jump every finite animation under `ref` to its end state after `ms`, or immediately when the page is hidden. */
export function useSettleAnimations(ref: RefObject<HTMLElement | null>, ms = 2200) {
  useEffect(() => {
    const settle = () => {
      const el = ref.current;
      if (!el?.getAnimations) return;
      for (const a of el.getAnimations({ subtree: true })) {
        const end = a.effect?.getComputedTiming().endTime;
        if (a.playState !== "finished" && typeof end === "number" && Number.isFinite(end)) {
          try { a.finish(); } catch { /* ignore */ }
        }
      }
    };
    if (document.visibilityState !== "visible") settle();
    const t = setTimeout(settle, ms);
    const onVis = () => { if (document.visibilityState !== "visible") settle(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", onVis); };
  }, [ref, ms]);
}

const pctNum = (x: number) => String(Math.round(x * 100));

// ---------------------------------------------------------------- win rate with CI (HTML rows)

type WinRow = { condition: string; matches: number; draws: number; byAgent: Record<string, AgentConditionStats> };

/** Draw share at which a row's draw count is called out (the win-rate CI then rests on few decisive matches). */
const MANY_DRAWS = 0.2;

export function WinRateChart({ rows, agents, metric }: { rows: WinRow[]; agents: AgentMeta[]; metric: "winRate" | "scoreRate" }) {
  if (!rows.length) return <ChartEmpty>No finished matches yet.</ChartEmpty>;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const name = metric === "winRate" ? "Win rate" : "Score rate";
  return (
    <div className="wr" role="figure" aria-label={`${name} by latency condition with 95% confidence intervals`}>
      <div className="wr__row wr__row--axis" aria-hidden>
        <div />
        <div className="wr__plot">
          {ticks.map((t) => <span key={t} className="wr__tick" style={{ left: `${t * 100}%` }}>{pctNum(t)}%</span>)}
        </div>
        <div className="wr__vals wr__vals--head"><span title={name}>Rate</span><span>95% CI</span><span>W–L–D</span></div>
      </div>
      {rows.map((r, ri) => {
        const detail = conditionDetail(r.condition);
        const share = r.matches ? r.draws / r.matches : 0;
        const many = share >= MANY_DRAWS;
        return (
          <div key={r.condition} className={`wr__row ${many ? "has-draws" : ""}`} style={{ "--d": `${ri * 70}ms` } as CSSProperties}>
            <div className="wr__label">
              <div className="wr__cond"><b>{conditionLabel(r.condition)}</b>{detail && <span>: {detail}</span>}</div>
              <div className="wr__meta">
                <span>{r.matches} match{r.matches === 1 ? "" : "es"}</span>
                <span className={`wr__draws ${many ? "is-many" : ""} ${r.draws ? "" : "is-none"}`} title={`${r.draws} of ${r.matches} matches drawn (${pct(share, 1)})`}>
                  <b>{r.draws}</b> draw{r.draws === 1 ? "" : "s"}{many ? ` · ${pct(share)}` : ""}
                </span>
              </div>
              {many && (
                <div className="wr__hint">
                  {metric === "winRate"
                    ? `Win rate uses only the ${r.matches - r.draws} decisive matches. Score rate counts draws as ½.`
                    : "Score rate counts each draw as ½ a win for both agents."}
                </div>
              )}
            </div>
            <div className="wr__plot">
              {ticks.map((t) => <i key={t} className={t === 0.5 ? "wr__ref" : "wr__grid"} style={{ left: `${t * 100}%` }} />)}
              {agents.map((a, ai) => {
                const st = r.byAgent[a.id];
                const n = st ? (metric === "winRate" ? st.wins + st.losses : st.matches) : 0;
                const iv = st?.[metric];
                const style = { "--team": a.color.main, "--team-rgb": a.color.rgb.join(","), "--d2": `${ri * 70 + ai * 50}ms` } as CSSProperties;
                if (!st || !iv || n === 0) {
                  return <div key={a.id} className="wr__lane wr__lane--none" style={style}>{a.label}: {st ? "no decisive matches" : "not in this condition"}</div>;
                }
                const span = Math.max(1e-6, iv.hi - iv.lo);
                return (
                  <div key={a.id} className="wr__lane" style={style}
                    title={`${a.label} · ${conditionLabel(r.condition)}: ${name.toLowerCase()} ${pct(iv.p, 1)} (95% CI ${pct(iv.lo, 1)}–${pct(iv.hi, 1)}) · ${st.wins}W ${st.losses}L ${st.draws}D`}>
                    <span className="wr__ci" style={{ left: `${iv.lo * 100}%`, width: `${span * 100}%`, transformOrigin: `${((iv.p - iv.lo) / span) * 100}% 50%` }} />
                    <span className="wr__dot" style={{ left: `${iv.p * 100}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="wr__vals">
              {agents.map((a) => {
                const st = r.byAgent[a.id];
                const iv = st?.[metric];
                const n = st ? (metric === "winRate" ? st.wins + st.losses : st.matches) : 0;
                return (
                  <div key={a.id} className="wr__val" style={{ "--team": a.color.main } as CSSProperties}>
                    <b>{st && iv && n ? pct(iv.p) : "—"}</b>
                    <span>{st && iv && n ? `${pctNum(iv.lo)}–${pctNum(iv.hi)}` : ""}</span>
                    <em>{st ? `${st.wins}–${st.losses}–${st.draws}` : ""}</em>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- latency histogram

export function LatencyHistogram({ data, agents }: { data: Record<string, { binMs: number; counts: number[] }>; agents: AgentMeta[] }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => agents.map((a) => {
    const h = data[a.id];
    if (!h || !h.counts.length || !(h.binMs > 0)) return null;
    const total = h.counts.reduce((s, c) => s + c, 0);
    if (!total) return null;
    // The last bin is the overflow bin (everything at or beyond its start).
    const q = (f: number) => {
      let acc = 0;
      for (let i = 0; i < h.counts.length; i++) {
        const before = acc;
        acc += h.counts[i];
        if (acc >= total * f) return (i + (total * f - before) / h.counts[i]) * h.binMs;
      }
      return h.counts.length * h.binMs;
    };
    let acc = 0, tailBin = h.counts.length - 1;
    for (let i = 0; i < h.counts.length; i++) { acc += h.counts[i]; if (acc >= total * 0.995) { tailBin = i; break; } }
    return { a, binMs: h.binMs, share: h.counts.map((c) => c / total), total, p50: q(0.5), p90: q(0.9), tailEndMs: (tailBin + 1) * h.binMs, overflowMs: (h.counts.length - 1) * h.binMs };
  }), [data, agents]);
  const live = series.filter((s): s is NonNullable<typeof s> => !!s);
  if (!live.length) return <ChartEmpty>No latency data yet.</ChartEmpty>;
  const binMs = live[0].binMs;
  const nAll = Math.max(...live.map((s) => s.share.length));

  // Visible range: from the first populated 100 ms below the bulk to the 99.5th percentile plus headroom.
  let firstBin = 0;
  while (firstBin < nAll - 1 && live.every((s) => (s.share[firstBin] ?? 0) < 0.002)) firstBin++;
  const loMs = Math.floor((firstBin * binMs) / 100) * 100;
  const capMs = Math.min(...live.map((s) => s.overflowMs));
  const hiMs = Math.max(loMs + 300, Math.min(capMs, Math.ceil(Math.max(...live.map((s) => s.tailEndMs)) / 100) * 100 + 100));
  const b0 = Math.round(loMs / binMs), b1 = Math.round(hiMs / binMs); // bins [b0, b1)
  const outside = live.map((s) => {
    let below = 0, above = 0;
    s.share.forEach((v, i) => { if (i < b0) below += v; else if (i >= b1) above += v; });
    return { below, above };
  });

  const maxShare = Math.max(1e-6, ...live.map((s) => Math.max(...s.share.slice(b0, b1))));
  const yStep = niceStep(maxShare, 4);
  const yMax = Math.ceil(maxShare / yStep) * yStep;
  const H = 250, m = { l: 40, r: 12, t: 24, b: 28 };
  const pw = Math.max(100, w - m.l - m.r), ph = H - m.t - m.b;
  const x = (msv: number) => m.l + ((msv - loMs) / (hiMs - loMs)) * pw;
  const y = (s: number) => m.t + ph - (s / yMax) * ph;
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += yStep) yTicks.push(+v.toFixed(6));
  const xTicks: number[] = [];
  const xStep = pw / ((hiMs - loMs) / 100) < 44 ? 200 : 100;
  for (let v = Math.ceil(loMs / xStep) * xStep; v <= hiMs; v += xStep) xTicks.push(v);
  const bw = x(binMs) - x(0);

  return (
    <div ref={ref} className="chart">
      <div className="legend legend--stats">
        {live.map((s, i) => (
          <span key={s.a.id} style={{ "--team": s.a.color.main } as CSSProperties}>
            <i style={{ background: s.a.color.main }} />
            <b>{s.a.label}</b> p50 {Math.round(s.p50)} · p90 {Math.round(s.p90)} ms
            {outside[i].above >= 0.0005 && <em> · {pct(outside[i].above, 1)} over {hiMs} ms</em>}
            {outside[i].below >= 0.0005 && <em> · {pct(outside[i].below, 1)} under {loMs} ms</em>}
          </span>
        ))}
      </div>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={`Real decision latency distribution per agent, ${loMs}–${hiMs} ms`}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const b = b0 + Math.floor(((e.clientX - r.left - m.l) / pw) * (b1 - b0));
            setHover(b >= b0 && b < b1 ? b : null);
          }}
          onMouseLeave={() => setHover(null)}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} className="axis-grid" />
              <text x={m.l - 6} y={y(t) + 3} textAnchor="end" className="axis-label">{Math.round(t * 100)}%</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={m.t + ph} y2={m.t + ph + 4} className="axis-line" />
              <text x={x(t)} y={H - 8} textAnchor="middle" className="axis-label">{t} ms</text>
            </g>
          ))}
          {live.map((s) => {
            let d = "";
            for (let i = b0; i < b1; i++) {
              const v = s.share[i] ?? 0;
              d += `${i === b0 ? "M" : "L"}${x(i * binMs)},${y(v)}H${x((i + 1) * binMs)}`;
            }
            return (
              <g key={s.a.id} className="hist" style={{ "--team": s.a.color.main } as CSSProperties}>
                {Array.from({ length: b1 - b0 }, (_, k) => {
                  const i = b0 + k, v = s.share[i] ?? 0;
                  return v > 0 ? <rect key={i} x={x(i * binMs) + 0.5} y={y(v)} width={Math.max(0.5, bw - 1)} height={m.t + ph - y(v)} className="hist__bar" /> : null;
                })}
                <path d={d} className="hist__line" />
              </g>
            );
          })}
          {live.map((s, si) => s.p50 >= loMs && s.p50 <= hiMs && (
            <g key={s.a.id} className="hist__q" style={{ "--team": s.a.color.main } as CSSProperties}>
              <line x1={x(s.p50)} x2={x(s.p50)} y1={m.t - 4} y2={m.t + ph} className="hist__p50" />
              <text x={x(s.p50) + (si % 2 ? 5 : -5)} y={m.t - 8} textAnchor={si % 2 ? "start" : "end"} className="hist__qt">p50 {Math.round(s.p50)}</text>
            </g>
          ))}
          <line x1={m.l} x2={m.l + pw} y1={m.t + ph} y2={m.t + ph} className="axis-line" />
          {hover !== null && (
            <g className="hover" pointerEvents="none">
              <rect x={x(hover * binMs)} y={m.t} width={Math.max(1, bw)} height={ph} className="hover__band" />
              <g transform={`translate(${Math.min(x((hover + 1) * binMs) + 10, m.l + pw - 170)} ${m.t + 8})`}>
                <rect width="166" height={24 + live.length * 16} rx="6" className="tip__bg" />
                <text x="10" y="17" className="tip__h">{hover * binMs}–{(hover + 1) * binMs} ms</text>
                {live.map((s, i) => (
                  <text key={s.a.id} x="10" y={34 + i * 16} className="tip__row" style={{ fill: s.a.color.main }}>
                    {s.a.label.split(" ")[0]} {pct(s.share[hover] ?? 0, 1)} · {Math.round((s.share[hover] ?? 0) * s.total)}
                  </text>
                ))}
              </g>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

function niceStep(max: number, count: number): number {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
}

// ---------------------------------------------------------------- fire calibration

/** Bins with fewer shots than this are hidden (their hit rate is noise). */
const CAL_MIN_N = 5;

function binRange(label: string): [number, number] | null {
  const lt = /^<\s*([\d.]+)$/.exec(label.trim());
  if (lt) return [0, Number(lt[1])];
  const mm = /([\d.]+)\s*[-–]\s*([\d.]+)/.exec(label);
  return mm ? [Number(mm[1]), Number(mm[2])] : null;
}

export function CalibrationChart({ bins, agents }: { bins: Record<string, { bin: string; n: number; hitRate: number }[]>; agents: AgentMeta[] }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const pts = useMemo(() => agents.flatMap((a, ai) => (bins[a.id] ?? []).flatMap((b) => {
    const r = binRange(b.bin);
    if (!r || b.n < CAL_MIN_N) return [];
    const hits = Math.round(b.hitRate * b.n);
    return [{ key: `${a.id}/${b.bin}`, a, ai, b, lo: r[0], hi: r[1], mid: (r[0] + r[1]) / 2, iv: wilson(hits, b.n), hits }];
  })), [bins, agents]);
  const hidden = useMemo(() => agents.reduce((t, a) => t + (bins[a.id] ?? []).filter((b) => b.n > 0 && (b.n < CAL_MIN_N || !binRange(b.bin))).reduce((s, b) => s + b.n, 0), 0), [bins, agents]);
  if (!pts.length) {
    return <ChartEmpty>{hidden ? `Only ${hidden} shots fall in probability bins, too few to plot.` : "No shots with fire probabilities yet. Bots don’t report probabilities."}</ChartEmpty>;
  }
  const xLo = Math.min(...pts.map((p) => p.lo)) >= 0.5 ? 0.5 : 0;
  const xHi = 1;
  const edges = [...new Set(pts.flatMap((p) => [p.lo, p.hi]))].filter((e) => e >= xLo && e <= xHi).sort((a, b) => a - b);
  const H = 260, m = { l: 40, r: 14, t: 12, b: 30 };
  const pw = Math.max(100, w - m.l - m.r), ph = H - m.t - m.b;
  const x = (v: number) => m.l + ((v - xLo) / (xHi - xLo)) * pw;
  const y = (v: number) => m.t + ph - v * ph;
  const maxN = Math.max(...pts.map((p) => p.b.n));
  const rOf = (n: number) => 3 + 10 * Math.sqrt(n / maxN);
  const minGap = Math.min(...edges.slice(1).map((e, i) => x(e) - x(edges[i])), pw);
  const off = (ai: number) => (ai - (agents.length - 1) / 2) * Math.min(12, minGap * 0.18);
  const hp = pts.find((p) => p.key === hover) ?? null;
  return (
    <div ref={ref} className="chart">
      <div className="legend legend--stats">
        {agents.filter((a) => pts.some((p) => p.a.id === a.id)).map((a) => (
          <span key={a.id} style={{ "--team": a.color.main } as CSSProperties}><i style={{ background: a.color.main, borderRadius: "50%" }} /><b>{a.label}</b></span>
        ))}
        <span className="legend__note">dot area = shots · whiskers = 95% CI{hidden ? ` · ${hidden} shot${hidden === 1 ? "" : "s"} in bins under ${CAL_MIN_N} hidden` : ""}</span>
      </div>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label="Fire calibration: hit rate of shots by the fire probability of the deciding call" onMouseLeave={() => setHover(null)}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} className="axis-grid" />
              <text x={m.l - 6} y={y(t) + 3} textAnchor="end" className="axis-label">{Math.round(t * 100)}%</text>
            </g>
          ))}
          {edges.map((e) => (
            <g key={e}>
              <line x1={x(e)} x2={x(e)} y1={m.t} y2={m.t + ph} className="axis-grid" />
              <text x={x(e)} y={H - 12} textAnchor="middle" className="axis-label">{e.toFixed(1)}</text>
            </g>
          ))}
          <line x1={x(xLo)} y1={y(xLo)} x2={x(xHi)} y2={y(xHi)} className="cal__ref" />
          {(() => {
            const t = xLo + (xHi - xLo) * 0.8, lx = x(t), ly = y(t);
            const deg = (Math.atan2(y(xHi) - y(xLo), x(xHi) - x(xLo)) * 180) / Math.PI;
            return <text x={lx} y={ly - 6} textAnchor="middle" className="cal__ref-t" transform={`rotate(${deg} ${lx} ${ly})`}>hit rate = P(fire)</text>;
          })()}
          <text x={m.l + pw} y={H - 0.5} textAnchor="end" className="axis-label axis-label--dim">P(fire) of the deciding call</text>
          {agents.map((a, ai) => {
            const mine = pts.filter((p) => p.a.id === a.id).sort((p, q) => p.mid - q.mid);
            if (!mine.length) return null;
            const line = mine.map((p, k) => `${k ? "L" : "M"}${x(p.mid) + off(ai)},${y(p.b.hitRate)}`).join("");
            return (
              <g key={a.id} className="cal" style={{ "--team": a.color.main } as CSSProperties}>
                {mine.length > 1 && <path d={line} className="cal__line" />}
                {mine.map((p) => {
                  const cx = x(p.mid) + off(ai);
                  return (
                    <g key={p.key} className={`cal__pt ${hover === p.key ? "is-on" : ""}`} onMouseEnter={() => setHover(p.key)}>
                      <line x1={cx} x2={cx} y1={y(p.iv.lo)} y2={y(p.iv.hi)} className="cal__ci" />
                      <line x1={cx - 3} x2={cx + 3} y1={y(p.iv.lo)} y2={y(p.iv.lo)} className="cal__ci" />
                      <line x1={cx - 3} x2={cx + 3} y1={y(p.iv.hi)} y2={y(p.iv.hi)} className="cal__ci" />
                      <circle cx={cx} cy={y(p.b.hitRate)} r={rOf(p.b.n)} className="cal__back" />
                      <circle cx={cx} cy={y(p.b.hitRate)} r={rOf(p.b.n)} className="cal__dot" />
                      <circle cx={cx} cy={y(p.b.hitRate)} r={Math.max(12, rOf(p.b.n) + 4)} className="cal__hit" />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {hp && (() => {
            const cx = x(hp.mid) + off(hp.ai), cy = y(hp.b.hitRate);
            const tw = 196, th = 58;
            const tx = cx + 16 + tw > m.l + pw ? cx - 16 - tw : cx + 16;
            const ty = Math.min(Math.max(m.t, cy - th / 2), m.t + ph - th);
            return (
              <g transform={`translate(${tx} ${ty})`} pointerEvents="none">
                <rect width={tw} height={th} rx="6" className="tip__bg" />
                <text x="10" y="17" className="tip__h" style={{ fill: hp.a.color.main }}>{hp.a.label}</text>
                <text x="10" y="33" className="tip__row" style={{ fill: "var(--text)" }}>P(fire) {hp.b.bin}: {hp.hits}/{hp.b.n} hit</text>
                <text x="10" y="48" className="tip__row" style={{ fill: "var(--muted)" }}>{pct(hp.b.hitRate, 1)} · 95% CI {pct(hp.iv.lo)}–{pct(hp.iv.hi)}</text>
              </g>
            );
          })()}
        </svg>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- maps

export function MapBars({ maps, agents, mapName }: { maps: { map: string; matches: number; winsByAgent: Record<string, number>; draws: number }[]; agents: AgentMeta[]; mapName: (id: string) => string }) {
  if (!maps.length) return <ChartEmpty>No maps played yet.</ChartEmpty>;
  return (
    <div className="mapbars">
      {maps.map((mp, mi) => {
        const segs = [
          ...agents.slice(0, 1).map((a) => ({ key: a.id, n: mp.winsByAgent[a.id] ?? 0, color: a.color.main, label: `${a.label} wins` })),
          { key: "draw", n: mp.draws, color: "rgba(160,175,195,0.35)", label: "Draws" },
          ...agents.slice(1).map((a) => ({ key: a.id, n: mp.winsByAgent[a.id] ?? 0, color: a.color.main, label: `${a.label} wins` })),
        ];
        const total = Math.max(1, segs.reduce((s, x) => s + x.n, 0));
        return (
          <div className="mapbars__row" key={mp.map} style={{ "--d": `${mi * 80}ms` } as CSSProperties}>
            <div className="mapbars__label"><b>{mapName(mp.map)}</b><span>{mp.matches}</span></div>
            <div className="mapbars__bar">
              {segs.map((s) => s.n > 0 && (
                <span key={s.key} style={{ flexGrow: s.n, background: s.color }} title={`${s.label}: ${s.n} (${pct(s.n / total)})`}>
                  {s.n / total > 0.12 ? s.n : ""}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- drive mix

const DRIVE_COLORS: Record<string, string> = {
  forward: "#5eead4", forward_left: "#7dd3fc", forward_right: "#a5b4fc", reverse: "#f9a8d4", turn_left: "#fcd34d", turn_right: "#fdba74", stop: "#94a3b8",
};

export function DriveMix({ mix, agents }: { mix: Record<string, Record<string, number>>; agents: AgentMeta[] }) {
  const rows = agents.filter((a) => mix[a.id] && Object.values(mix[a.id]).some((v) => v > 0));
  if (!rows.length) return <ChartEmpty>No drive decisions recorded.</ChartEmpty>;
  const cmds = Object.keys(DRIVE_COLORS);
  return (
    <div className="drivemix">
      {rows.map((a) => (
        <div key={a.id} className="drivemix__row">
          <div className="drivemix__label" style={{ color: a.color.main }}>{a.label}</div>
          <div className="drivemix__bar">
            {cmds.map((c) => {
              const v = mix[a.id][c] ?? 0;
              return v > 0 ? <span key={c} style={{ flexGrow: v, background: DRIVE_COLORS[c] }} title={`${driveLabel(c)}: ${pct(v, 1)}`}>{v > 0.09 ? pct(v) : ""}</span> : null;
            })}
          </div>
        </div>
      ))}
      <div className="legend">
        {cmds.map((c) => <span key={c}><i style={{ background: DRIVE_COLORS[c] }} />{driveLabel(c)}</span>)}
      </div>
    </div>
  );
}
