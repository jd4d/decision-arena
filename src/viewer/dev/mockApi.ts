// DEVELOPMENT ONLY: an in-browser stand-in for the Worker API (src/api/contract.ts). It serves one pool built from
// the local match logs in runs/<run>/matches/ (gitignored, written by the runner): every complete model-vs-model match
// recorded with the current sim and protocol, tagged origin "t1-local" like the imported seed matches. The summary is
// computed with the same digest code the Worker uses (src/analysis/aggregate.ts). It is loaded only through
// `transport()` in lib/api.ts behind `import.meta.env.DEV`, so production builds cannot include or enable it.
//
// Live matches replay a pool log over a fake socket with the engine's real pacing (src/runner/engine.ts): game time
// runs with the wall clock while answers are in flight, but never past the earliest tick an unanswered decision could
// land. Scaled conditions therefore stream at about real time; fixed latency slows when a model is slower than the
// fixed delay. Every match is queued for 2 s first. A reconnect gets the full backlog, as the real server does.
// A finished mock match joins the pool with origin "web".
//
// URL switches (dev only): ?mock=1 force the mock · ?mock=0 never use it
//   &mockState=broke   out of credit (status says so, POST answers budget_exhausted)
//   &mockState=busy    POST answers busy
//   &mockState=empty   no matches in the pool yet
//   &mockDrop=1        drop the first live connection a third of the way in (tests reconnects)
//   &mockSpeed=N       run the fake engine N× faster
//   &mockQueueMs=N     how long each match waits in the queue (default 2000)
//   &mockQueuePos=N    starting place in line (default 2)
import { COMMUNITY_RUN_ID, DEFAULT_PUBLIC_CONDITION, DEFAULT_PUBLIC_DECODER, PUBLIC_CONDITIONS, PUBLIC_DECODERS, type ApiError, type CreateMatchRequest, type LiveMessage, type StatusResponse, type VersionsResponse } from "../../api/contract.ts";
import { MODELS } from "../../agents/models.ts";
import { digestMatch, indexEntry, mergeDigests, toMatch, type MatchDigest } from "../../analysis/aggregate.ts";
import type { MatchIndexEntry, RunSummary } from "../../analysis/schema.ts";
import { CURRENT_PROTOCOL } from "../../protocol/v2.ts";
import { ERROR_MIN_MS, msToTicks } from "../../runner/latency.ts";
import { parseLog, type DecisionRec, type HeaderRec, type LogRec, type ResultRec } from "../../runner/log.ts";
import { MAP_IDS } from "../../sim/maps.ts";
import { SIM_VERSION, TICK_HZ } from "../../sim/tuning.ts";
import type { SocketLike, Transport } from "../lib/api.ts";

if (!import.meta.env.DEV) throw new Error("The mock API is development-only.");

/** Local logs, keyed by path from the project root (e.g. "/runs/t1/matches/<match>.jsonl"); loaded on demand. */
const LOGS = import.meta.glob<string>("/runs/*/matches/*.jsonl", { query: "?raw", import: "default" });

const q = new URLSearchParams(location.search);
const STATE = q.get("mockState") as "broke" | "busy" | "empty" | null;
const DROP = q.get("mockDrop") === "1";
const SPEED = Math.max(0.1, Number(q.get("mockSpeed") ?? 1) || 1);
const QUEUE_MS_RAW = Number(q.get("mockQueueMs") ?? 2000);
const QUEUE_MS = (Number.isFinite(QUEUE_MS_RAW) ? Math.max(0, QUEUE_MS_RAW) : 2000) / SPEED;
const QUEUE_POS = Math.max(1, Number(q.get("mockQueuePos") ?? 2) || 2); // starting place in line
const STORE = "decision-arena:mock:pool";

type Stored = { added: { entry: MatchIndexEntry; source: string }[]; live: { id: string; source: string; createdAt: number; dropped?: boolean }[] };
const store: Stored = (() => {
  try { return { added: [], live: [], ...JSON.parse(sessionStorage.getItem(STORE) ?? "{}") }; } catch { return { added: [], live: [] }; }
})();
const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(store)); } catch { /* ignore */ } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const netDelay = () => sleep(90 + Math.random() * 160);
function hash36(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (error: ApiError["error"], message: string, status: number) => json({ error, message } satisfies ApiError, status);

// ---------------------------------------------------------------- the pool, from local logs

/** One pool match: its list entry, its summary digest and the local log it comes from. */
type Item = { entry: MatchIndexEntry; digest: MatchDigest; source: string; createdAt: number };
type Base = {
  /** Every usable local log, whether or not it is shown in the pool (mock matches replay these). */
  sources: Item[];
  /** Every usable model match of any version (mock live matches pick from here by the requested answer method). */
  all: Item[];
  seeds: Item[];
  added: Item[];
  byId: Map<string, Item>;
};
let baseP: Promise<Base> | null = null;

const poolEntry = (e: MatchIndexEntry, id: string, origin: MatchIndexEntry["origin"]): MatchIndexEntry =>
  ({ ...e, runId: COMMUNITY_RUN_ID, matchId: id, file: `/api/matches/${id}/log`, origin });

function base(): Promise<Base> {
  baseP ??= (async () => {
    const t0 = performance.now();
    const parsed = await Promise.all(Object.keys(LOGS).sort().map(async (source): Promise<(Item & { bots: boolean; current: boolean }) | null> => {
      try {
        const m = toMatch(parseLog(await LOGS[source]()));
        // Every version is listed (as the Worker does); summaries are per version and mock live matches replay the current one.
        if (!m) return null;
        const id = `s${hash36(source)}`;
        return {
          entry: poolEntry(indexEntry(m), id, "t1-local"),
          digest: digestMatch(m),
          source,
          createdAt: Date.parse(m.header.createdAt) || 0,
          bots: m.header.agents.some((a) => a.kind !== "model"),
          current: m.header.sim === SIM_VERSION && m.header.protocol === CURRENT_PROTOCOL,
        };
      } catch {
        return null;
      }
    }));
    const usable = parsed.filter((x) => x !== null);
    // Bot matches are dev fixtures, not entrants: use them only when no model matches are on disk.
    const models = usable.filter((x) => !x.bots);
    const all: Item[] = (models.length ? models : usable).sort((a, b) => b.createdAt - a.createdAt || a.entry.matchId.localeCompare(b.entry.matchId));
    // Mock live matches replay current-version logs only.
    const sources = all.filter((x) => (x as Item & { current: boolean }).current);
    const bySource = new Map(all.map((x) => [x.source, x]));
    const added: Item[] = [];
    for (const a of store.added) {
      const src = bySource.get(a.source);
      if (src) added.push({ ...src, entry: a.entry });
    }
    const seeds = STATE === "empty" ? [] : all;
    const byId = new Map([...seeds, ...added].map((x) => [x.entry.matchId, x]));
    console.info(`[mock API] pool of ${seeds.length} local + ${added.length} mock matches from ${Object.keys(LOGS).length} logs in runs/ (${Math.round(performance.now() - t0)} ms)`);
    return { sources, all, seeds, added, byId };
  })();
  return baseP;
}

/** Newest first, as the Worker lists them. */
const pool = (b: Base): Item[] => [...[...b.added].reverse(), ...b.seeds];

const CURRENT_VERSION = `${SIM_VERSION}:${CURRENT_PROTOCOL}`;
const versionOf = (d: MatchDigest) => `${d.sim}:${d.protocol}`;

function summarize(b: Base, version = CURRENT_VERSION): RunSummary {
  const items = pool(b).filter((x) => versionOf(x.digest) === version);
  const s = mergeDigests(COMMUNITY_RUN_ID, items.map((x) => x.digest), new Date().toISOString());
  if (items.length) return s;
  // Like the Worker's empty summary: that version and the lineup, no conditions.
  const [sim, protocol] = version.split(":");
  return { ...s, sim, protocol, agents: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, model: m.model })) };
}

function versions(b: Base): VersionsResponse {
  const by = new Map<string, { n: number; t: number }>();
  for (const x of pool(b)) { const v = versionOf(x.digest), e = by.get(v) ?? { n: 0, t: 0 }; e.n++; e.t = Math.max(e.t, x.createdAt); by.set(v, e); }
  // Local runs/ also holds a few tiny dev experiments; only list real pools (the Worker has no such leftovers).
  const list = [...by.entries()].filter(([id, e]) => e.n >= 10 || id === CURRENT_VERSION).sort((a, c) => c[1].t - a[1].t).map(([id, e]) => { const [sim, protocol] = id.split(":"); return { id, sim, protocol, matches: e.n }; });
  return { current: CURRENT_VERSION, versions: list };
}

async function logText(b: Base, id: string): Promise<string | null> {
  const item = b.byId.get(id);
  const load = item && LOGS[item.source];
  if (!item || !load) return null;
  const text = await load();
  if (item.entry.origin !== "web") return text; // imported seed logs are stored as recorded
  return parseLog(text).map((r) => JSON.stringify(r.k === "header" ? { ...r, runId: COMMUNITY_RUN_ID, matchId: id } : r)).join("\n") + "\n";
}

// ---------------------------------------------------------------- fake engine timeline

type Timeline = {
  header: HeaderRec;
  recs: LogRec[]; // decision/event/check records in emission order
  avail: number[]; // per rec: first batch tick that may carry it
  wallAt: number[]; // ms after engine start when tick T has been simulated
  decisions: [DecisionRec[], DecisionRec[]];
  result: ResultRec;
  endTick: number;
  doneMs: number;
};

const timelines = new Map<string, Promise<Timeline>>();

function buildTimeline(all: LogRec[], id: string): Timeline {
  const header = { ...(all.find((r) => r.k === "header") as HeaderRec), runId: COMMUNITY_RUN_ID, matchId: id, createdAt: new Date().toISOString() };
  const result = all.find((r) => r.k === "result") as ResultRec;
  const recs = all.filter((r) => r.k === "decision" || r.k === "event" || r.k === "check");
  const avail = recs.map((r) => (r.k === "decision" ? r.applyTick : r.k === "check" ? r.t : r.k === "event" ? r.t : 0));
  for (let i = 1; i < avail.length; i++) avail[i] = Math.max(avail[i], avail[i - 1]);
  const decisions: [DecisionRec[], DecisionRec[]] = [[], []];
  for (const r of recs) if (r.k === "decision") decisions[r.slot].push(r);
  for (const d of decisions) d.sort((a, b) => a.n - b.n);
  // Engine loop: apply, issue, wait until no unanswered decision could land on this tick, step.
  const endTick = result.ticks;
  const lat = header.latency;
  const answerAt = (p: { d: DecisionRec; at: number }) => p.at + (p.d.error ? Math.max(p.d.realMs, ERROR_MIN_MS) : p.d.realMs);
  /** Wall time after which tick t can be simulated with p still in flight. */
  const clearAt = (p: { d: DecisionRec; at: number }, t: number) => {
    if (lat.mode === "scaled" && lat.factor > 0) return Math.min(answerAt(p), p.at + ((t - p.d.issueTick) * 1000) / (TICK_HZ * lat.factor));
    if (lat.mode === "fixed" && t < p.d.issueTick + msToTicks(lat.ms)) return -Infinity;
    return answerAt(p);
  };
  const wallAt = [0];
  const idx = [0, 0];
  const pending: ({ d: DecisionRec; at: number } | null)[] = [null, null];
  let wall = 0;
  for (let t = 0; t < endTick; t++) {
    for (const s of [0, 1] as const) {
      const p = pending[s];
      if (p && p.d.applyTick === t) { wall = Math.max(wall, answerAt(p)); pending[s] = null; } // applying needs the answer
    }
    for (const s of [0, 1] as const) {
      const next = decisions[s][idx[s]];
      if (!pending[s] && next && next.issueTick === t) { pending[s] = { d: next, at: wall }; idx[s]++; }
    }
    for (const p of pending) if (p) wall = Math.max(wall, clearAt(p, t));
    wall += 0.3; // simulation cost per tick
    wallAt.push(wall);
  }
  return { header, recs, avail, wallAt, decisions, result, endTick, doneMs: wall + 250 };
}

function timeline(b: Base, id: string): Promise<Timeline> {
  let p = timelines.get(id);
  if (!p) {
    p = (async () => {
      const source = store.live.find((l) => l.id === id)?.source ?? b.byId.get(id)?.source;
      const load = source ? LOGS[source] : undefined;
      if (!load) throw new Error("unknown match");
      return buildTimeline(parseLog(await load()), id);
    })();
    timelines.set(id, p);
  }
  return p;
}

function finish(b: Base, id: string): void {
  if (b.byId.has(id)) return;
  const live = store.live.find((l) => l.id === id);
  const src = live && b.all.find((x) => x.source === live.source);
  if (!live || !src) return;
  const item: Item = { ...src, entry: poolEntry(src.entry, id, "web"), createdAt: Date.now() };
  store.added.push({ entry: item.entry, source: src.source });
  store.live = store.live.filter((l) => l.id !== id);
  b.added.push(item);
  b.byId.set(id, item);
  save();
}

// ---------------------------------------------------------------- fake socket

class MockSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  private closed = false;
  private timer = 0;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => void this.run(), 140 + Math.random() * 120);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
  }

  private send(m: LiveMessage): void {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(m) });
  }

  private fail(code: number): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.onerror?.();
    this.onclose?.({ code });
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    const id = decodeURIComponent(/\/api\/matches\/([^/]+)\/live/.exec(this.url)?.[1] ?? "");
    const b = await base();
    const live = store.live.find((l) => l.id === id);
    if (!live) return this.fail(1006); // unknown or long finished: the real server refuses the upgrade
    this.onopen?.();
    let tl: Timeline | null = null;
    let lastQueue = -1, headerSent = false, sentTick = -1, sentIdx = 0;
    const step = async () => {
      if (this.closed) return;
      const el = Date.now() - live.createdAt;
      if (el < QUEUE_MS) {
        // Like the real lobby: count down, then position 0 while the models warm up.
        const pos = el >= QUEUE_MS * 0.85 ? 0 : Math.max(1, QUEUE_POS - Math.floor((el / (QUEUE_MS * 0.85)) * QUEUE_POS));
        if (pos !== lastQueue) { lastQueue = pos; this.send({ type: "queued", position: pos }); }
      } else {
        tl ??= await timeline(b, id);
        if (this.closed) return;
        if (!headerSent) { headerSent = true; this.send({ type: "header", header: tl.header }); }
        const engineMs = (el - QUEUE_MS) * SPEED;
        let T = sentTick;
        while (T + 1 <= tl.endTick && tl.wallAt[T + 1] <= engineMs) T++;
        if (DROP && !live.dropped && T > tl.endTick / 3) {
          live.dropped = true;
          save();
          return this.fail(1006);
        }
        if (T > sentTick) {
          const from = sentIdx;
          while (sentIdx < tl.recs.length && tl.avail[sentIdx] <= T) sentIdx++;
          const infl = ([0, 1] as const).map((s) => {
            const d = tl!.decisions[s].find((x) => x.issueTick < T && x.applyTick > T);
            return d ? { issueTick: d.issueTick } : null;
          }) as [{ issueTick: number } | null, { issueTick: number } | null];
          sentTick = T;
          this.send({ type: "batch", recs: tl.recs.slice(from, sentIdx), tick: T, inflight: T >= tl.endTick ? [null, null] : infl });
        }
        if (engineMs >= tl.doneMs && sentTick >= tl.endTick) {
          finish(b, id);
          const entry = b.byId.get(id)!.entry;
          this.send({ type: "done", result: tl.result, entry });
          this.closed = true;
          this.onclose?.({ code: 1000 });
          return;
        }
      }
      this.timer = window.setTimeout(() => void step(), 100);
    };
    void step();
  }
}

// ---------------------------------------------------------------- fake fetch

async function mockFetch(path: string, init?: RequestInit): Promise<Response> {
  await netDelay();
  const b = await base();
  const u = new URL(path, location.origin);
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  const method = (init?.method ?? "GET").toUpperCase();

  if (parts[1] === "status") {
    // Seed matches cost the site nothing; mock site matches are charged at a typical match cost.
    const spent = b.added.length * 0.0029;
    const liveNow = store.live.filter((l) => Date.now() - l.createdAt < 120_000).length;
    return json({
      acceptingMatches: STATE !== "broke",
      liveMatches: liveNow + 1,
      queued: STATE === "busy" ? 6 : 0,
      maxConcurrent: 8,
      communityMatches: pool(b).length,
      spentUsd: spent,
      creditRemainingUsd: STATE === "broke" ? 0 : Math.max(0, 95 - spent),
    } satisfies StatusResponse);
  }
  if (parts[1] === "summary" && parts[2] === "versions") return json(versions(b));
  if (parts[1] === "summary" && parts[2] === "community") return json(summarize(b, u.searchParams.get("version") ?? CURRENT_VERSION));
  if (parts[1] === "matches" && parts.length === 2 && method === "POST") {
    if (STATE === "broke") return apiError("budget_exhausted", "The arena’s OpenRouter credit is used up.", 402);
    if (STATE === "busy") return apiError("busy", "Every arena slot is busy and the queue is full.", 503);
    const req = JSON.parse(String(init?.body ?? "{}")) as CreateMatchRequest;
    const condition = req.condition ?? DEFAULT_PUBLIC_CONDITION;
    if (!(condition in PUBLIC_CONDITIONS) || (req.map !== "random" && !MAP_IDS.includes(req.map))) return apiError("bad_request", "Unknown map or condition.", 400);
    const map = req.map === "random" ? MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)] : req.map;
    const decoder = req.decoder ?? DEFAULT_PUBLIC_DECODER;
    if (!(decoder in PUBLIC_DECODERS)) return apiError("bad_request", "Unknown decoder.", 400);
    const want = `${SIM_VERSION}:p2-${decoder}`;
    const sameRule = b.all.filter((x) => versionOf(x.digest) === want && x.entry.condition === condition);
    const options = sameRule.filter((x) => x.entry.map === map);
    const pick = options.length ? options : sameRule;
    if (!pick.length) return apiError("bad_request", `The mock has no local ${want} log for “${condition}” in runs/.`, 400);
    const src = pick[Math.floor(Math.random() * pick.length)];
    const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    store.live.push({ id, source: src.source, createdAt: Date.now() });
    save();
    return json({ matchId: id, liveUrl: `/api/matches/${id}/live`, queuePosition: 2 });
  }
  if (parts[1] === "matches" && parts.length === 2) {
    const limit = Math.max(1, Math.min(100, Number(u.searchParams.get("limit") ?? 50) || 50));
    const at = Number(u.searchParams.get("cursor") ?? 0) || 0;
    const v = u.searchParams.get("version");
    const all = v ? pool(b).filter((x) => versionOf(x.digest) === v) : pool(b);
    return json({ matches: all.slice(at, at + limit).map((x) => x.entry), nextCursor: at + limit < all.length ? String(at + limit) : null });
  }
  if (parts[1] === "matches" && parts[2] && parts.length === 3) {
    const e = b.byId.get(parts[2])?.entry;
    return e ? json(e) : apiError("bad_request", "Unknown or still running.", 404);
  }
  if (parts[1] === "matches" && parts[2] && parts[3] === "log") {
    if (!b.byId.has(parts[2])) return apiError("bad_request", "Unknown or still running.", 404);
    const text = await logText(b, parts[2]);
    return text ? new Response(text, { headers: { "content-type": "text/plain" } }) : apiError("internal", "Log missing.", 500);
  }
  return apiError("bad_request", `Mock API has no route for ${method} ${u.pathname}`, 404);
}

export function createMockTransport(): Transport {
  return { kind: "mock", fetch: mockFetch, socket: (url) => new MockSocket(url) };
}
