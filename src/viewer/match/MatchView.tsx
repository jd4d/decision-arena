import { useEffect, useMemo, useState } from "react";
import { MAPS } from "../../sim/maps.ts";
import { ArenaCanvas } from "../arena/ArenaCanvas.tsx";
import { loadIndex, loadLog, NotFound, useAsync } from "../lib/data.ts";
import { clock, conditionLabel } from "../lib/format.ts";
import { matchHref, replaceHash, resultsHref } from "../lib/router.ts";
import { distinctColors, isDevRun, shortLabel, type TeamColor } from "../lib/theme.ts";
import { buildModel, type MatchModel } from "../replay/model.ts";
import { Player, SPEEDS } from "../replay/player.ts";
import { BrainPanel } from "./BrainPanel.tsx";
import { Scoreboard } from "./Scoreboard.tsx";
import { jumpTarget, Timeline } from "./Timeline.tsx";

type Props = { runId: string; matchId: string; t: number | null };

export function MatchView({ runId, matchId, t }: Props) {
  const state = useAsync(async () => {
    let file = `matches/${runId}/${matchId}.jsonl`;
    try {
      const idx = await loadIndex();
      const e = idx.matches.find((m) => m.runId === runId && m.matchId === matchId);
      if (e) file = e.file;
    } catch { /* fall back to the conventional path */ }
    const recs = await loadLog(file);
    try {
      return buildModel(recs);
    } catch (e) {
      const header = recs.find((r) => r.k === "header");
      const why = (e as Error).message;
      throw new Error(
        header && header.k === "header" && /unknown map/.test(why)
          ? `This log uses the map “${header.map}”, which no longer exists in the bundled simulation. It was recorded with ${header.sim}; re-run the match to watch it.`
          : `Could not re-simulate this log: ${why}`,
      );
    }
  }, [runId, matchId]);

  if (state.status === "loading") return <div className="page-state"><div className="spinner" />Re-simulating match…</div>;
  if (state.status === "error") {
    return (
      <div className="page-state page-state--error">
        <h2>{state.error instanceof NotFound ? "Match not found" : "Can’t play this match"}</h2>
        <p>{state.error instanceof NotFound ? `No log for ${runId} / ${matchId} in public/data.` : state.error.message}</p>
        <a className="btn" href="#/">← Back to matches</a>
      </div>
    );
  }
  return <MatchStage key={`${runId}/${matchId}`} model={state.data} runId={runId} matchId={matchId} t={t} />;
}

function MatchStage({ model, runId, matchId, t }: { model: MatchModel; runId: string; matchId: string; t: number | null }) {
  const [player] = useState(() => new Player(model.endTick, model.slowTicks));
  const agents = model.header.agents;
  const colors = useMemo(() => distinctColors(agents.map((a) => a.id)) as [TeamColor, TeamColor], [agents]);
  const labels = useMemo(() => agents.map((a) => a.label) as [string, string], [agents]);
  const tags = useMemo(() => agents.map((a) => shortLabel(a.id, a.label)) as [string, string], [agents]);
  const [copied, setCopied] = useState(false);

  // Initial position: deep-link tick (paused) or autoplay from the start.
  useEffect(() => {
    let timer = 0;
    if (t !== null) player.seek(t);
    else timer = window.setTimeout(() => player.play(), 650);
    return () => { clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);
  useEffect(() => { if (t !== null) player.seek(t); }, [t, player]);
  useEffect(() => () => player.dispose(), [player]);

  // Keep ?t= in the URL in sync while paused.
  useEffect(() => {
    let timer = 0;
    const sync = () => {
      clearTimeout(timer);
      if (player.playing) return;
      timer = window.setTimeout(() => replaceHash(matchHref(runId, matchId, Math.min(player.playhead, model.endTick))), 250);
    };
    const off = player.subscribe(sync);
    return () => { off(); clearTimeout(timer); };
  }, [player, runId, matchId, model.endTick]);

  // Keyboard shortcuts.
  useEffect(() => {
    const hz = model.header.tickHz;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      // A focused button would also "click" on Space: drop focus so the shortcut acts once.
      if (k === " " && el?.tagName === "BUTTON") el.blur();
      const speedIdx = SPEEDS.indexOf(player.speed as (typeof SPEEDS)[number]);
      let handled = true;
      if (k === " " || k === "k") player.toggle();
      else if (k === "ArrowLeft") player.seek(player.playhead - (e.shiftKey ? 5 : 1) * hz);
      else if (k === "ArrowRight") player.seek(player.playhead + (e.shiftKey ? 5 : 1) * hz);
      else if (k === ",") player.step(-1);
      else if (k === ".") player.step(1);
      else if (k === "ArrowUp") player.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, speedIdx + 1)]);
      else if (k === "ArrowDown") player.setSpeed(SPEEDS[Math.max(0, speedIdx - 1)]);
      else if (k === "Home") player.seek(0);
      else if (k === "End") player.seek(model.endTick);
      else if (k === "s" || k === "S") player.setSlowmo(!player.slowmo);
      else if (k === "g" || k === "G") player.setGhosts(!player.ghosts);
      else if (k === "[" || k === "]") {
        const target = jumpTarget(model, Math.floor(player.playhead), k === "]" ? 1 : -1);
        if (target !== null) player.seek(target);
      } else handled = false;
      if (handled) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [player, model]);

  const h = model.header;
  const mapName = MAPS[h.map]?.name ?? h.map;
  const firstMismatch = model.mismatches[0];
  const copyLink = async () => {
    const url = `${location.origin}${location.pathname}${matchHref(runId, matchId, Math.min(player.playhead, model.endTick))}`;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="match">
      <div className="match__bar">
        <a className="back" href="#/" aria-label="Back to matches">
          <svg viewBox="0 0 16 16" aria-hidden><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </a>
        <div className="match__title">
          <h1>
            <span style={{ color: colors[0].main }}>{labels[0]}</span>
            <span className="vs">vs</span>
            <span style={{ color: colors[1].main }}>{labels[1]}</span>
          </h1>
          <div className="match__chips">
            <span className="chip">{mapName}</span>
            <span className="chip">{conditionLabel(h.condition)}</span>
            <span className="chip">seed {h.seed}</span>
            <a className="chip chip--link" href={resultsHref(runId)}>{runId}{isDevRun(runId) ? " · dev" : ""}</a>
          </div>
        </div>
        <div className="match__badges">
          {(model.mismatches.length > 0 || model.simVersion.stale) && (
            <span className="badge badge--warn" tabIndex={0}>
              <svg viewBox="0 0 16 16" aria-hidden><path d="M8 1.8 15 14H1z" fill="currentColor" /><path d="M8 6v3.6M8 11.6v.3" stroke="#1a1204" strokeWidth="1.6" strokeLinecap="round" /></svg>
              {model.mismatches.length > 0 ? `Replay diverged · ${model.mismatches.length} checksum${model.mismatches.length > 1 ? "s" : ""}` : "Older sim version"}
              <span className="badge__pop">
                {model.mismatches.length > 0 && (
                  <>Re-simulation stopped matching the recorded checksums at {clock(firstMismatch.t / h.tickHz)} (tick {firstMismatch.t}). What you see after that point is not what happened in the match. </>
                )}
                {model.simVersion.stale && <>Recorded with {model.simVersion.log}; this viewer bundles {model.simVersion.viewer}.</>}
              </span>
            </span>
          )}
          <span className="badge" title="Simulation and protocol versions recorded in the log">{h.sim} · {h.protocol}</span>
          <button className="btn btn--ghost btn--sm" onClick={copyLink}>{copied ? "Link copied" : "Copy link at time"}</button>
        </div>
      </div>

      <Scoreboard model={model} player={player} colors={colors} labels={labels} />

      <div className="match__main">
        <BrainPanel model={model} player={player} slot={0} color={colors[0]} />
        <ArenaCanvas model={model} player={player} colors={colors} tags={tags} labels={labels} />
        <BrainPanel model={model} player={player} slot={1} color={colors[1]} />
      </div>

      <Timeline model={model} player={player} colors={colors} />
    </div>
  );
}
