import { memo, useState, type CSSProperties } from "react";
import type { DecisionRec } from "../../runner/log.ts";
import { TURRET_LEVELS as P1_TURRET_LEVELS, TURRET_VALUES } from "../../protocol/v1.ts";
import { TURRET_LEVELS as P2_TURRET_LEVELS } from "../../protocol/v2.ts";
import { TURRET_STEP_MAX } from "../../sim/tuning.ts";
import { DRIVE_CMDS } from "../../sim/types.ts";
import { latestApplied, pendingView, type MatchModel, type PendingView } from "../replay/model.ts";
import { usePlayer, type Player } from "../replay/player.ts";
import { driveLabel, usd } from "../lib/format.ts";
import type { TeamColor } from "../lib/theme.ts";

export const DRIVE_ICON: Record<string, string> = {
  forward: "↑", forward_left: "↖", forward_right: "↗", reverse: "↓", turn_left: "↺", turn_right: "↻", stop: "■",
};

export function teamStyle(c: TeamColor): CSSProperties {
  return { "--team": c.main, "--team-bright": c.bright, "--team-deep": c.deep, "--team-rgb": c.rgb.join(",") } as CSSProperties;
}

type Props = { model: MatchModel; player: Player; slot: 0 | 1; color: TeamColor };

export function BrainPanel({ model, player, slot, color }: Props) {
  const snap = usePlayer(player);
  const list = model.decisions[slot];
  const d = latestApplied(list, snap.tick);
  const pending = pendingView(model, slot, snap.tick);
  const agent = model.header.agents.find((a) => a.slot === slot) ?? model.header.agents[slot];
  const hz = model.header.tickHz;
  // Phones: the probability detail collapses so the arena stays the focus (the toggle is hidden on wider screens).
  const [open, setOpen] = useState(false);
  return (
    <aside className={`brain brain--${slot === 0 ? "left" : "right"} ${open ? "" : "is-collapsed"}`} style={teamStyle(color)} aria-label={`${agent.label} decision panel`}>
      <header className="brain__head">
        <button className="brain__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Less" : "Probabilities"}
          <svg viewBox="0 0 12 12" aria-hidden><path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="brain__kicker">
          <span className="brain__swatch" />
          {agent.kind === "model" ? "Decision model" : "Dev bot"} · slot {slot}
        </div>
        <h2 className="brain__name">{agent.label}</h2>
        <div className="brain__model">{agent.model ?? agent.id}</div>
      </header>
      <PendingRow pending={pending} tick={snap.tick} hz={hz} />
      <DecisionView d={d} list={list} stepped={model.header.sim !== "sim-2"} />
    </aside>
  );
}

function PendingRow({ pending, tick, hz }: { pending: PendingView | null; tick: number; hz: number }) {
  if (!pending) {
    return (
      <div className="brain__pending is-idle">
        <span className="brain__pulse" /> Idle — no decision in flight
      </div>
    );
  }
  const span = pending.applyTick === null ? null : Math.max(1, pending.applyTick - pending.issueTick);
  const done = span === null ? tick - pending.issueTick : Math.min(span, tick - pending.issueTick);
  return (
    <div className="brain__pending" title="The model is deciding based on the game state at its issue tick; the enemy ghost in the arena shows that state.">
      <span className="brain__pulse is-live" />
      <span>
        Thinking · state is <b>{((tick - pending.issueTick) / hz).toFixed(2)} s</b> old
      </span>
      <span className="brain__ticks">
        {span === null ? `${done} ticks` : `${done}/${span}`}
      </span>
    </div>
  );
}

/** sim-2 turret orders are a rate (% of full speed); sim-3 orders are a step (degrees). Logs key turret probabilities by label. */
const turretAmount = (v: number, stepped: boolean) =>
  stepped ? `${Math.round((Math.abs(v) * TURRET_STEP_MAX * 180) / Math.PI)}°` : `${Math.round(Math.abs(v) * 100)}%`;

function turretSummary(v: number, stepped: boolean): string {
  if (Math.abs(v) < 0.03) return "hold";
  return `${v > 0 ? "right" : "left"} ${turretAmount(v, stepped)}`;
}

function turretArrow(v: number, stepped: boolean): string {
  if (Math.abs(v) < 0.03) return "hold";
  return `${v > 0 ? "→" : "←"} ${turretAmount(v, stepped)}`;
}

/** Fractional column index of a turret rate on the (non-uniform) level scale. */
function turretIndex(v: number): number {
  const vs = TURRET_VALUES;
  if (v <= vs[0]) return 0;
  for (let i = 0; i < vs.length - 1; i++) if (v <= vs[i + 1]) return i + (v - vs[i]) / (vs[i + 1] - vs[i]);
  return vs.length - 1;
}

const DecisionView = memo(function DecisionView({ d, list, stepped }: { d: DecisionRec | null; list: DecisionRec[]; stepped: boolean }) {
  const TURRET_LEVELS = stepped ? P2_TURRET_LEVELS : P1_TURRET_LEVELS;
  if (!d) {
    return (
      <div className="brain__body">
        <div className="brain__empty">Waiting for the first decision to land…</div>
      </div>
    );
  }
  const det = d.detail;
  const action = d.action;
  const idx = list.indexOf(d);
  const history = list.slice(Math.max(0, idx - 39), idx + 1);
  return (
    <div className="brain__body" key={d.n === 0 ? "first" : "rest"}>
      <div className="brain__meta-row">
        <span className="brain__dec">Decision #{d.n}</span>
        <span className="brain__dim">
          {d.cost !== undefined ? usd(d.cost) : ""}
          {d.tokens ? ` · ${d.tokens.in}/${d.tokens.out} tok` : ""}
        </span>
      </div>
      <div className="brain__lat">
        <span><i>real</i> {d.realMs}</span>
        <span><i>eff</i> {d.effMs} ms</span>
        <span className="brain__lat-t"><i>t</i> {d.issueTick}→{d.applyTick}</span>
      </div>
      <div className="brain__action">
        <span className="chip chip--team">
          <span aria-hidden>{DRIVE_ICON[action?.drive ?? "stop"]}</span> {action ? driveLabel(action.drive) : "no change"}
        </span>
        <span className="chip">turret {action ? turretArrow(action.turret, stepped) : "—"}</span>
        {action?.fire && <span className="chip chip--fire">FIRE</span>}
      </div>

      {d.error && (
        <div className="brain__error" role="status">
          <b>Decision failed</b>
          <span>{d.error}</span>
          <em>Previous orders kept running.</em>
        </div>
      )}

      {det ? (
        <>
          <section className="brain__section">
            <h4>Drive</h4>
            <ul className="bars">
              {DRIVE_CMDS.map((cmd) => {
                const p = det.driveP[cmd] ?? 0;
                const chosen = action?.drive === cmd;
                return (
                  <li key={cmd} className={`bars__row ${chosen ? "is-chosen" : ""}`}>
                    <span className="bars__icon" aria-hidden>{DRIVE_ICON[cmd]}</span>
                    <span className="bars__label">{driveLabel(cmd)}</span>
                    <span className="bars__track"><span className="bars__fill" style={{ transform: `scaleX(${p})` }} /></span>
                    <span className="bars__val">{Math.round(p * 100)}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="brain__section">
            <h4>
              Turret <span className="brain__dim">{stepped ? "chose" : "expected"} {turretSummary(action?.turret ?? 0, stepped)}</span>
            </h4>
            <div className="turret">
              <div className="turret__cols">
                {TURRET_LEVELS.map((lv) => {
                  const p = det.turretP[lv] ?? 0;
                  return (
                    <div key={lv} className="turret__col" title={`${lv}: ${Math.round(p * 100)}%`}>
                      <span className="turret__bar" style={{ transform: `scaleY(${Math.max(0.015, p)})` }} />
                    </div>
                  );
                })}
                <span className="turret__ev" style={{ left: `${((turretIndex(action?.turret ?? 0) + 0.5) / TURRET_LEVELS.length) * 100}%` }}>
                  <span className="turret__ev-label">{stepped ? "pick" : "EV"}</span>
                </span>
              </div>
              <div className="turret__axis">
                <span>{stepped ? `${turretAmount(1, true)} L` : "hard L"}</span>
                <span>hold</span>
                <span>{stepped ? `${turretAmount(1, true)} R` : "hard R"}</span>
              </div>
            </div>
          </section>

          <section className="brain__section">
            <h4>
              Fire <span className="brain__dim">{stepped ? "fires with probability p" : "fires at p ≥ 0.5"}</span>
            </h4>
            <div className={`fire ${action?.fire ? "is-fire" : ""}`}>
              <span className="fire__track">
                <span className="fire__fill" style={{ transform: `scaleX(${det.fireP})` }} />
                <span className="fire__thresh" />
              </span>
              <span className="fire__val">{Math.round(det.fireP * 100)}%</span>
            </div>
            <FireSpark history={history} />
          </section>
        </>
      ) : (
        !d.error && <div className="brain__note">Bot decision — no probability detail. Showing the chosen orders only.</div>
      )}

    </div>
  );
});

function FireSpark({ history }: { history: DecisionRec[] }) {
  const pts = history.filter((h) => h.detail);
  if (pts.length < 2) return null;
  const W = 100, H = 22;
  const n = 40;
  const x = (i: number) => ((i + n - pts.length) / (n - 1)) * W;
  const y = (p: number) => H - p * H;
  const path = pts.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(h.detail!.fireP).toFixed(2)}`).join("");
  return (
    <svg className="fire__spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Fire probability over the last 40 decisions">
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="fire__spark-mid" />
      <path d={`${path}L${x(pts.length - 1)},${H}L${x(0)},${H}Z`} className="fire__spark-area" />
      <path d={path} className="fire__spark-line" />
      {pts.map((h, i) => (h.action?.fire ? <circle key={h.n} cx={x(i)} cy={y(h.detail!.fireP)} r="1.4" className="fire__spark-dot" /> : null))}
    </svg>
  );
}
