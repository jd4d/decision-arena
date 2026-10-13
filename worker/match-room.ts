// MatchRoom: one Durable Object per match (always created with locationHint "enam"). Runs the shared engine
// (src/runner/engine.ts) from an alarm, independent of any client connection, against the real models over fetch,
// and streams the log to every connected WebSocket (hibernation API). On finish: log -> R2, row -> D1,
// lobby.finish (slot + summary fold), then "done".
import { DurableObject } from "cloudflare:workers";
import { COMMUNITY_RUN_ID, PUBLIC_CONDITIONS, type LiveMessage, type PublicCondition } from "../src/api/contract.ts";
import { digestMatch, indexEntry, toMatch } from "../src/analysis/aggregate.ts";
import type { MatchIndexEntry } from "../src/analysis/schema.ts";
import { fetchModelAgent, type FetchModelAgent } from "../src/agents/model-fetch.ts";
import type { ModelKey } from "../src/agents/models.ts";
import { runMatch, type TickInfo } from "../src/runner/engine.ts";
import { parseLatency, type LatencyMode } from "../src/runner/latency.ts";
import { parseLog, type HeaderRec, type LogRec, type ResultRec } from "../src/runner/log.ts";
import { DEFAULT_DECODER, DECODERS, protocolLabel, type Decoder } from "../src/protocol/v2.ts";
import { SIM_VERSION } from "../src/sim/tuning.ts";
import { insertMatch, logPath, type MatchRow } from "./db.ts";
import { lobbyStub, logKey, MATCH_CAP_USD, type Env, type RoomSpec } from "./env.ts";

type Phase = "queued" | "starting" | "running" | "done" | "failed";
/** The spec's answer method; specs stored before answer methods existed use the default. */
const decoderOf = (spec: RoomSpec): Decoder => ((DECODERS as readonly string[]).includes(spec.decoder ?? "") ? (spec.decoder as Decoder) : DEFAULT_DECODER);

type RoomState = { spec: RoomSpec; phase: Phase; position: number; entry?: MatchIndexEntry; result?: ResultRec; error?: string };

const FLUSH_MS = 100;
const FLUSH_TICKS = 3;
// Microsoft is slow on its first call after idling: warm both models (same calls for both) for at least 2 rounds,
// and a 3rd if either was still slow in round 2.
const WARM_ROUNDS = 3;
const WARM_OK_MS = 400;

export class MatchRoom extends DurableObject<Env> {
  private rs?: RoomState | null;
  // Live stream state (in memory while the match runs; reloaded from R2 for late joiners after eviction).
  private header: HeaderRec | null = null;
  private stream: LogRec[] = []; // decision/event/check records in emission order
  private sent = 0; // stream[0..sent) has been broadcast
  private tick = 0;
  private sentTick = 0;
  private inflight: TickInfo["inflight"] = [null, null];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async load(): Promise<RoomState | null> {
    if (this.rs === undefined) this.rs = (await this.ctx.storage.get<RoomState>("room")) ?? null;
    return this.rs;
  }
  private async put(rs: RoomState): Promise<void> {
    this.rs = rs;
    await this.ctx.storage.put("room", rs);
  }

  private broadcast(msg: LiveMessage): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch {}
    }
  }
  private closeAll(reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, reason); } catch {}
    }
  }

  // ---------- RPC from the Lobby ----------

  /** Store the spec. position 0 starts now; >= 1 waits for start(). Idempotent. */
  async init(spec: RoomSpec, position: number): Promise<void> {
    if (await this.load()) return;
    await this.put({ spec, phase: position > 0 ? "queued" : "starting", position });
    if (position === 0) await this.ctx.storage.setAlarm(Date.now());
  }

  async start(): Promise<void> {
    const rs = await this.load();
    if (!rs || rs.phase !== "queued") return;
    await this.put({ ...rs, phase: "starting", position: 0 });
    this.broadcast({ type: "queued", position: 0 });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async setQueuePosition(position: number): Promise<void> {
    const rs = await this.load();
    if (!rs || rs.phase !== "queued" || rs.position === position) return;
    await this.put({ ...rs, position });
    this.broadcast({ type: "queued", position });
  }

  async cancel(message: string): Promise<void> {
    const rs = await this.load();
    if (!rs || rs.phase !== "queued") return;
    await this.put({ ...rs, phase: "failed", error: message });
    this.broadcast({ type: "error", message });
    this.closeAll("cancelled");
  }

  // ---------- WebSocket ----------

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const rs = await this.load();
    if (rs?.phase === "done" && !this.header) await this.reloadLog(rs);
    // Flush pending records to existing clients first, so the new client's backlog and the stream don't overlap.
    if (rs?.phase === "running") this.flush();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const send = (m: LiveMessage) => server.send(JSON.stringify(m));
    if (!rs) {
      send({ type: "error", message: "Unknown match" });
      server.close(1000, "unknown match");
    } else if (rs.phase === "queued") send({ type: "queued", position: rs.position });
    else if (rs.phase === "failed") {
      send({ type: "error", message: rs.error ?? "The match failed" });
      server.close(1000, "failed");
    } else if (!this.header) send({ type: "queued", position: 0 }); // warming up the models
    else {
      send({ type: "header", header: this.header });
      const done = rs.phase === "done";
      send({ type: "batch", recs: this.stream.slice(0, done ? this.stream.length : this.sent), tick: done ? (rs.result?.ticks ?? this.tick) : this.sentTick, inflight: done ? [null, null] : this.inflight });
      if (done) {
        if (rs.entry && rs.result) send({ type: "done", result: rs.result, entry: rs.entry });
        else send({ type: "error", message: rs.error ?? "The match was aborted" });
        server.close(1000, "match over");
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {} // clients only listen ("ping" is auto-answered)
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch {}
  }
  async webSocketError(): Promise<void> {}

  private async reloadLog(rs: RoomState): Promise<void> {
    const obj = await this.env.LOGS.get(logKey(rs.spec.matchId));
    if (!obj) return;
    const recs = parseLog(await obj.text());
    this.header = (recs.find((r) => r.k === "header") as HeaderRec | undefined) ?? null;
    this.stream = recs.filter((r) => r.k !== "header" && r.k !== "result");
    this.sent = this.stream.length;
  }

  // ---------- streaming ----------

  private onRecord(r: LogRec): void {
    if (r.k === "header") {
      this.header = r;
      this.broadcast({ type: "header", header: r });
    } else if (r.k !== "result") this.stream.push(r);
  }

  private onTick(t: TickInfo): void {
    this.tick = t.tick;
    this.inflight = t.inflight;
    if (this.tick - this.sentTick >= FLUSH_TICKS) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
  }

  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.sent === this.stream.length && this.tick === this.sentTick) return;
    const recs = this.stream.slice(this.sent);
    this.sent = this.stream.length;
    this.sentTick = this.tick;
    this.broadcast({ type: "batch", recs, tick: this.tick, inflight: this.inflight });
  }

  // ---------- the match ----------

  async alarm(): Promise<void> {
    const rs = await this.load();
    if (!rs) return;
    if (rs.phase === "running") return this.fail(rs, "The match was interrupted.", 0, 0); // a previous run died mid-match
    if (rs.phase !== "starting") return;
    await this.put({ ...rs, phase: "running" });
    try {
      await this.run(rs);
    } catch (e) {
      console.error("match failed", rs.spec.matchId, (e as Error).stack ?? e);
      if (this.rs?.phase === "running") await this.fail(rs, "The match hit a server error.", 0, 0);
    }
  }

  private async run(rs: RoomState): Promise<void> {
    const { spec } = rs;
    const key = this.env.OPENROUTER_API_KEY;
    if (!key) return this.fail(rs, "The server has no model key configured.", 0, 0);
    const agents = spec.order.map((k) => fetchModelAgent(k as ModelKey, key, undefined, decoderOf(spec))) as [FetchModelAgent, FetchModelAgent];

    let extra = 0;
    for (let round = 1; round <= WARM_ROUNDS; round++) {
      const rr = await Promise.all(agents.map((a) => a.warm()));
      extra += rr.reduce((s, r) => s + r.cost, 0);
      console.log(`match ${spec.matchId} warm-up ${round}: ${spec.order.map((k, i) => `${k} ${Math.round(rr[i].ms)} ms${rr[i].error ? ` (${rr[i].error!.slice(0, 60)})` : ""}`).join(", ")}`);
      const bad = rr.find((r) => r.error);
      if (bad && round === WARM_ROUNDS) return this.fail(rs, `A model is unavailable right now (${bad.error!.slice(0, 120)}).`, 0, extra);
      if (round >= 2 && !bad && rr.every((r) => r.ms < WARM_OK_MS)) break;
    }

    const condition = spec.condition as PublicCondition;
    let latency: LatencyMode;
    try { latency = latencyForCondition(condition); }
    catch (e) { return this.fail(rs, (e as Error).message, 0, extra); }
    const { records, result } = await runMatch(
      {
        runId: COMMUNITY_RUN_ID,
        matchId: spec.matchId,
        map: spec.map,
        seed: spec.seed,
        latency,
        condition,
        agents,
      },
      { budget: { spent: 0, hardCap: MATCH_CAP_USD }, onRecord: (r) => this.onRecord(r), onTick: (t) => this.onTick(t) },
    );
    this.flush();

    const cost = result.stats[0].cost + result.stats[1].cost;
    const match = toMatch(records); // null if aborted (cost cap)
    const entry: MatchIndexEntry | undefined = match ? { ...indexEntry(match), file: logPath(spec.matchId), origin: "web" } : undefined;
    const header = records[0] as HeaderRec;
    await this.env.LOGS.put(logKey(spec.matchId), records.map((r) => JSON.stringify(r)).join("\n") + "\n", {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
    const row: MatchRow = {
      id: spec.matchId,
      created_at: spec.createdAt,
      finished_at: Date.now(),
      status: match ? "done" : "aborted",
      map: spec.map,
      condition,
      seed: spec.seed,
      agents: JSON.stringify(header.agents.map((a) => ({ id: a.id, label: a.label, model: a.model }))),
      winner: result.winner,
      reason: result.reason,
      ticks: result.ticks,
      hp: JSON.stringify(result.hp),
      highlights: JSON.stringify(entry?.highlights ?? []),
      cost,
      extra_cost: extra,
      sim: header.sim,
      protocol: header.protocol,
      digest: match ? JSON.stringify(digestMatch(match)) : null,
    };
    await insertMatch(this.env.DB, row);
    await lobbyStub(this.env).finish(spec.matchId, cost + extra).catch((e) => console.error("lobby.finish failed", (e as Error).message));
    await this.put({ ...rs, phase: "done", entry, result, error: match ? undefined : "The match was aborted (cost cap)." });
    if (entry) this.broadcast({ type: "done", result, entry });
    else this.broadcast({ type: "error", message: "The match was aborted (cost cap)." });
    this.closeAll("match over");
  }

  /** Record a failed match, free its slot and tell the clients. */
  private async fail(rs: RoomState, message: string, cost: number, extra: number): Promise<void> {
    await this.put({ ...rs, phase: "failed", error: message });
    try {
      await insertMatch(this.env.DB, {
        id: rs.spec.matchId, created_at: rs.spec.createdAt, finished_at: Date.now(), status: "failed", map: rs.spec.map, condition: rs.spec.condition,
        seed: rs.spec.seed, agents: JSON.stringify(rs.spec.order.map((id) => ({ id }))), winner: null, reason: message, ticks: 0, hp: null, highlights: null,
        cost, extra_cost: extra, sim: SIM_VERSION, protocol: protocolLabel(decoderOf(rs.spec)), digest: null,
      });
    } catch (e) {
      console.error("failed-row insert", (e as Error).message);
    }
    await lobbyStub(this.env).finish(rs.spec.matchId, cost + extra).catch((e) => console.error("lobby.finish failed", (e as Error).message));
    this.broadcast({ type: "error", message });
    this.closeAll("failed");
  }
}

/** Game-time latency rule for a public condition (real or equal latency). */
export function latencyForCondition(condition: PublicCondition): LatencyMode {
  return parseLatency(PUBLIC_CONDITIONS[condition].latency);
}
