// One live match: socket lifecycle, reconnects, incremental re-simulation and the playback clock.
//
// Contract (src/api/contract.ts): "batch" frames carry records plus `tick`, the tick the engine has simulated;
// every decision applying at or before it has been sent, so frames up to `tick` are safe to simulate. A
// (re)connecting client first gets the whole backlog. Records are de-duplicated, so resends are harmless.
import type { LiveMessage, MatchIndexEntry } from "../../api/contract.ts";
import type { HeaderRec, LogRec, ResultRec } from "../../runner/log.ts";
import { closeSocket, getMatchEntry, openLive, type SocketLike } from "../lib/api.ts";
import { primeLog } from "../lib/data.ts";
import { ModelBuilder, type MatchModel } from "../replay/model.ts";
import { Player } from "../replay/player.ts";

export type LivePhase =
  | "connecting" // first connection attempt
  | "queued" // waiting for an arena slot
  | "starting" // header received, waiting for the first simulated ticks
  | "live" // frames streaming
  | "done" // stream finished; playback may still be catching up
  | "finished-elsewhere" // the socket is gone but the match exists as a finished replay
  | "error";

export type LiveSnap = {
  phase: LivePhase;
  queuePosition: number | null;
  reconnecting: boolean;
  attempts: number;
  error: string | null;
  header: HeaderRec | null;
  model: MatchModel | null;
  result: ResultRec | null;
  entry: MatchIndexEntry | null;
  /** The stream was watched as it happened (queued, or frames arrived over a real span of time), as opposed to a
   *  late join that received the finished match at once. */
  watchedLive: boolean;
};

const BACKOFF = [600, 1200, 2500, 5000, 8000];

export class LiveSession {
  readonly matchId: string;
  readonly player: Player;
  private readonly url: string;
  private builder: ModelBuilder | null = null;
  /** Every non-header record in emission order (for "watch again" without a download). */
  private readonly records: LogRec[] = [];
  private connRecs = 0;
  private sock: SocketLike | null = null;
  private disposed = false;
  private timer = 0;
  private gotMessage = false;
  private sawQueue = false;
  private firstFrameAt = 0;
  private snap: LiveSnap;
  private subs = new Set<() => void>();

  constructor(matchId: string, url: string) {
    this.matchId = matchId;
    this.url = url;
    this.player = new Player(0, [], { live: true });
    this.snap = { phase: "connecting", queuePosition: null, reconnecting: false, attempts: 0, error: null, header: null, model: null, result: null, entry: null, watchedLive: false };
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<LiveSnap>): void {
    this.snap = { ...this.snap, ...patch };
    for (const s of this.subs) s();
  }

  start(): void {
    void this.connect();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    if (this.sock) closeSocket(this.sock, 1000, "viewer left");
    this.sock = null;
    this.player.dispose();
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    this.connRecs = 0;
    let sock: SocketLike;
    try {
      sock = await openLive(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.disposed) { closeSocket(sock); return; }
    this.sock = sock;
    sock.onopen = () => { if (this.snap.reconnecting) this.set({ reconnecting: false }); };
    sock.onmessage = (ev) => {
      let msg: LiveMessage;
      try { msg = JSON.parse(String(ev.data)) as LiveMessage; } catch { return; }
      this.gotMessage = true;
      if (this.snap.reconnecting || this.snap.attempts) this.set({ reconnecting: false, attempts: 0 });
      this.handle(msg);
    };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      if (this.disposed || this.snap.phase === "done" || this.snap.phase === "error" || this.snap.phase === "finished-elsewhere") return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const attempts = this.snap.attempts + 1;
    this.set({ reconnecting: true, attempts });
    // Never heard from this match: it may be unknown, or long finished (then it's a replay).
    if (!this.gotMessage && attempts >= 3) {
      void this.checkFinished(attempts);
      return;
    }
    this.timer = window.setTimeout(() => void this.connect(), BACKOFF[Math.min(BACKOFF.length - 1, attempts - 1)]);
  }

  private async checkFinished(attempts: number): Promise<void> {
    try {
      const entry = await getMatchEntry(this.matchId);
      if (this.disposed) return;
      this.set({ phase: "finished-elsewhere", entry, reconnecting: false });
    } catch {
      if (this.disposed) return;
      if (attempts >= 5) this.set({ phase: "error", reconnecting: false, error: "This match isn’t running and hasn’t finished. The link may be wrong, or the match may have been cancelled." });
      else this.timer = window.setTimeout(() => void this.connect(), BACKOFF[Math.min(BACKOFF.length - 1, attempts - 1)]);
    }
  }

  private ensureBuilder(h: HeaderRec): void {
    if (this.builder) return;
    try {
      this.builder = new ModelBuilder(h, true);
    } catch (e) {
      this.set({ phase: "error", error: `Can’t simulate this match: ${(e as Error).message}` });
      return;
    }
    this.set({ header: h, model: this.builder.model, phase: this.snap.phase === "live" ? "live" : "starting", queuePosition: null });
  }

  private ingest(recs: LogRec[]): void {
    const fresh: LogRec[] = [];
    for (const r of recs) {
      if (r.k === "header") { this.ensureBuilder(r); continue; }
      // A new connection replays the backlog in the same order: skip what we already hold.
      if (this.connRecs++ < this.records.length) continue;
      this.records.push(r);
      fresh.push(r);
    }
    this.builder?.add(fresh);
  }

  private handle(msg: LiveMessage): void {
    if (this.snap.phase === "error") return;
    if (msg.type === "queued") {
      this.sawQueue = true;
      if (!this.builder) this.set({ phase: "queued", queuePosition: msg.position });
    } else if (msg.type === "header") {
      this.ensureBuilder(msg.header);
    } else if (msg.type === "batch") {
      this.ingest(msg.recs);
      const b = this.builder;
      if (!b) return;
      if (this.snap.phase === "done") return;
      b.advanceTo(msg.tick);
      if (b.model.live) b.model.live.inflight = msg.inflight;
      this.player.pushEdge(b.model.endTick);
      if (this.snap.phase !== "live" && b.model.endTick > 0) {
        this.firstFrameAt = performance.now();
        this.set({ phase: "live" });
        this.player.play();
      }
    } else if (msg.type === "done") {
      const b = this.builder;
      if (!b) {
        this.set({ phase: "error", error: "The match ended before any of it was streamed." });
        return;
      }
      b.add([msg.result]);
      b.finish();
      this.player.completeLive(b.model.endTick);
      if (!this.player.playing) this.player.play();
      primeLog(msg.entry.matchId, [b.model.header, ...this.records.filter((r) => r.k !== "result"), msg.result]);
      const watchedLive = this.sawQueue || (this.firstFrameAt > 0 && performance.now() - this.firstFrameAt > 2500);
      // Joined after the end (the whole match arrived at once): its replay is the better place to watch it.
      const lateJoin = !this.sawQueue && this.firstFrameAt > 0 && performance.now() - this.firstFrameAt < 1500 && this.player.playhead < 2 * b.model.header.tickHz;
      this.set({ phase: lateJoin ? "finished-elsewhere" : "done", result: msg.result, entry: msg.entry, reconnecting: false, watchedLive });
      this.sock?.close(1000, "done");
    } else if (msg.type === "error") {
      this.set({ phase: "error", error: msg.message, reconnecting: false });
      this.sock?.close(1000, "error");
    }
  }
}
