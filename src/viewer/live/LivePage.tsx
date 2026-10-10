import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { COMMUNITY_RUN_ID } from "../../api/contract.ts";
import { MAPS } from "../../sim/maps.ts";
import { MapThumb } from "../browser/MapThumb.tsx";
import { getCommunitySummary, liveUrlFor } from "../lib/api.ts";
import { conditionLabel } from "../lib/format.ts";
import { poolMatchHref, replaceHash } from "../lib/router.ts";
import { MatchStage } from "../match/MatchView.tsx";
import { usePlayer } from "../replay/player.ts";
import { Finale } from "./Finale.tsx";
import { readBefore, readLaunch, saveBefore, type Launch } from "./launch.ts";
import { LiveSession, type LiveSnap } from "./session.ts";

export function LivePage({ matchId }: { matchId: string }) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const launch = useMemo(() => readLaunch(matchId), [matchId]);

  useEffect(() => {
    const s = new LiveSession(matchId, launch?.liveUrl ?? liveUrlFor(matchId));
    s.start();
    setSession(s);
    return () => s.dispose();
  }, [matchId, launch]);

  // A shared link skipped the run flow: take the "before" snapshot of the pool results now.
  useEffect(() => {
    if (readBefore(matchId)) return;
    let alive = true;
    getCommunitySummary().then((sum) => { if (alive && !readBefore(matchId)) saveBefore(matchId, sum); }, () => { /* context will show without deltas */ });
    return () => { alive = false; };
  }, [matchId]);

  if (!session) return <Lobby phase="connecting" position={null} launch={launch} reconnecting={false} />;
  return <LiveView session={session} launch={launch} />;
}

function LiveView({ session, launch }: { session: LiveSession; launch: Launch | null }) {
  const s = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // A finished match whose stream is gone: open its replay instead.
  useEffect(() => {
    if (s.phase === "finished-elsewhere" && s.entry) {
      const t = setTimeout(() => { location.replace(poolMatchHref(s.entry!.matchId)); }, 700);
      return () => clearTimeout(t);
    }
  }, [s.phase, s.entry]);

  if (s.phase === "finished-elsewhere") {
    return (
      <div className="page-state">
        <div className="spinner" />
        <h2>This match has finished</h2>
        <p>Opening its replay…</p>
      </div>
    );
  }
  if (s.phase === "error" && !s.model) return <LiveError message={s.error} />;
  if (!s.model) return <Lobby phase={s.phase} position={s.queuePosition} launch={launch} reconnecting={s.reconnecting} />;
  return <LiveMatch session={session} s={s} />;
}

// ---------------------------------------------------------------- waiting room

function Lobby({ phase, position, launch, reconnecting }: { phase: LiveSnap["phase"]; position: number | null; launch: Launch | null; reconnecting: boolean }) {
  // Position 0 means "out of the queue, warming up the models".
  const queued = phase === "queued" && position !== null && position > 0;
  const warming = phase === "starting" || (phase === "queued" && !queued);
  const title = reconnecting && phase === "connecting" ? "Reaching the arena…" : queued ? "In the queue" : warming ? "Warming up the models" : "Connecting to the arena";
  const map = launch && launch.map !== "random" ? launch.map : null;
  return (
    <div className="lobby">
      <div className="radar" aria-hidden>
        <div className="radar__rings" />
        <div className="radar__sweep" />
        <span className="radar__blip radar__blip--a" />
        <span className="radar__blip radar__blip--b" />
        <div className="radar__core">
          {queued ? (
            <div className="radar__pos" key={position}>
              <small>#</small>{position}
            </div>
          ) : (
            <svg className="radar__mark" viewBox="0 0 32 32">
              <circle cx="16" cy="16" r="9" fill="none" stroke="#38d9f5" strokeWidth="2.4" />
              <path d="M16 2.5v7M16 22.5v7M2.5 16h7M22.5 16h7" stroke="#ff9d3c" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          )}
        </div>
      </div>
      <div className="lobby__copy" aria-live="polite">
        <div className="kicker"><span className="live-dot" /> {queued ? `Queued · #${position} in line` : "Live match"}</div>
        <h1 key={title}>{title}</h1>
        <p>
          {queued
            ? "The arena runs a limited number of matches at once so that rate limits never distort the models’ latency. Your match starts as soon as a slot frees up."
            : "Both models get a warm connection before the first tick, so cold-start latency doesn’t decide the match."}
        </p>
        {launch && (
          <div className="lobby__setup">
            <span className="lobby__map">
              {map ? <MapThumb map={map} /> : <span className="lobby__random">?</span>}
              {map ? MAPS[map]?.name ?? map : "Random map"}
            </span>
            <span className="chip">{conditionLabel(launch.condition)}</span>
            <span className="chip">sides drawn at random</span>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveError({ message }: { message: string | null }) {
  return (
    <div className="page-state page-state--error">
      <h2>This match can’t be shown</h2>
      <p>{!message ? "Something went wrong with the live stream." : /unknown match/i.test(message) ? "There’s no match at this link. It may be mistyped, or the match was never started." : message}</p>
      <div className="page-state__actions">
        <a className="btn btn--primary" href="#/run">Run a new match</a>
        <a className="btn" href="#/matches">Browse matches</a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live match

function LiveMatch({ session, s }: { session: LiveSession; s: LiveSnap }) {
  const player = session.player;
  const snap = usePlayer(player);
  const model = s.model!;
  const [finaleOpen, setFinaleOpen] = useState(true);
  const [flash, setFlash] = useState(false);
  const finished = s.phase === "done" && snap.ended && !snap.playing;

  // A short "match on" flash when the first frames start to play.
  useEffect(() => {
    if (s.phase !== "live") return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1300);
    return () => clearTimeout(t);
  }, [s.phase === "live"]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the stream is over, the replay URL is the permanent home of this match.
  useEffect(() => {
    if (finished && s.entry) document.title = "Match result · Decision Arena AI";
  }, [finished, s.entry]);

  const overlay = (
    <>
      {s.phase === "starting" && (
        <div className="arena__wait">
          <div className="spinner" />
          <b>Warming up the models</b>
          <span>The first decisions are on their way.</span>
        </div>
      )}
      {flash && <div className="arena__go" aria-hidden><span>Match on</span></div>}
      {s.phase === "error" && (
        <div className="arena__wait arena__wait--error" role="alert">
          <b>The match stopped</b>
          <span>{s.error}</span>
          <a className="btn btn--sm" href="#/run">Run another</a>
        </div>
      )}
      {s.phase === "done" && !snap.ended && (
        <button className="arena__skip btn btn--sm" onClick={() => { player.seek(model.endTick); player.play(); }}>
          Skip to result
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M3 3l6 5-6 5zM10 3h2.5v10H10z" fill="currentColor" /></svg>
        </button>
      )}
    </>
  );

  const badges = s.reconnecting ? (
    <span className="badge badge--reconnect" role="status"><span className="spinner spinner--xs" /> Reconnecting…</span>
  ) : null;

  return (
    <>
      <MatchStage model={model} player={player} runId={COMMUNITY_RUN_ID} matchId={session.matchId} mode="live" arenaOverlay={overlay} badges={badges} />
      {/* Portalled: .page animates with a transform, which would make it the containing block of these fixed layers. */}
      {finished && s.result && s.entry && finaleOpen && createPortal(
        <Finale
          model={model}
          result={s.result}
          entry={s.entry}
          before={s.watchedLive ? readBefore(session.matchId) : null}
          onClose={() => setFinaleOpen(false)}
          onRewatch={() => { replaceHash(poolMatchHref(s.entry!.matchId)); dispatchEvent(new HashChangeEvent("hashchange")); }}
        />,
        document.body,
      )}
      {finished && !finaleOpen && createPortal(
        <button className="finale-reopen btn btn--primary" onClick={() => setFinaleOpen(true)} style={{ "--i": 0 } as CSSProperties}>
          Your match in context ↑
        </button>,
        document.body,
      )}
    </>
  );
}
