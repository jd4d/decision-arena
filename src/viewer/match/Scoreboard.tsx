import { countApplied, frameAt, latestApplied, type MatchModel } from "../replay/model.ts";
import { usePlayer, type Player } from "../replay/player.ts";
import { clock, conditionLabel } from "../lib/format.ts";
import type { TeamColor } from "../lib/theme.ts";
import { teamStyle } from "./BrainPanel.tsx";

type Props = { model: MatchModel; player: Player; colors: [TeamColor, TeamColor]; labels: [string, string] };

export function Scoreboard({ model, player, colors, labels }: Props) {
  const snap = usePlayer(player);
  const tick = snap.tick;
  const hz = model.header.tickHz;
  const f = frameAt(model, tick);
  const remaining = (model.header.roundTicks - tick) / hz;
  const maxHp = Math.max(model.frames[0].tanks[0].hp, model.frames[0].tanks[1].hp);

  const side = (slot: 0 | 1) => {
    const list = model.decisions[slot];
    const win = Math.min(tick, 2 * hz);
    const dps = win > 0 ? countApplied(list, tick - win, tick) / (win / hz) : 0;
    let shots = 0, hits = 0;
    for (const mk of model.markers) {
      if (mk.tick > tick) break;
      if (mk.kind === "fire" && mk.slot === slot) shots++;
      if (mk.kind === "hit" && mk.slot === slot) hits++;
    }
    const last = latestApplied(list, tick);
    const hp = f.tanks[slot].hp;
    const agent = model.header.agents.find((a) => a.slot === slot);
    return (
      <div className={`score__team score__team--${slot === 0 ? "left" : "right"} ${hp <= 0 ? "is-down" : ""}`} style={teamStyle(colors[slot])}>
        <div className="score__id">
          <div className="score__name">{labels[slot]}</div>
          <div className="score__sub">{agent?.model ?? agent?.id}</div>
        </div>
        <div className="score__hp" aria-label={`HP ${hp} of ${maxHp}`}>
          {Array.from({ length: maxHp }, (_, i) => (
            <span key={i} className={`score__pip ${i < hp ? "is-on" : ""}`} />
          ))}
        </div>
        <div className="score__stats">
          <span><b>{dps.toFixed(1)}</b> dec/s</span>
          <span><b>{last ? last.realMs : "—"}</b> ms</span>
          <span><b>{hits}/{shots}</b> hits</span>
        </div>
      </div>
    );
  };

  return (
    <div className="score">
      {side(0)}
      <div className="score__clock">
        <div className="score__time">{clock(remaining)}</div>
        <div className="score__cond">
          <span className={`score__live ${snap.playing ? "is-on" : ""}`} /> Replay · {conditionLabel(model.header.condition)}
        </div>
      </div>
      {side(1)}
    </div>
  );
}
