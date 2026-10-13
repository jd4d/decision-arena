// End-to-end smoke test against a running local Worker (`pnpm dev`): creates matches via POST /api/matches, watches
// each over the live WebSocket, re-simulates the streamed log (checksums), and checks the stored entry, log and
// community summary. Real model calls: each match costs about $0.003.
// Usage: node scripts/live-smoke.ts [--base http://localhost:5173] [--n 1] [--map random] [--condition scaled-1] [--late-ms 0]
import type { CreateMatchResponse, LiveMessage, MatchListResponse, StatusResponse } from "../src/api/contract.ts";
import type { MatchIndexEntry, RunSummary } from "../src/analysis/schema.ts";
import { parseLog, type HeaderRec, type LogRec } from "../src/runner/log.ts";
import { createReplay } from "../src/runner/replay.ts";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const base = arg("base", "http://localhost:5173");
const n = Number(arg("n", "1"));
const map = arg("map", "random");
const condition = arg("condition", "scaled-1");
const lateMs = Number(arg("late-ms", "0"));

const getJson = async <T>(path: string): Promise<T> => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

type Watch = { id: string; queuedPositions: number[]; batches: number; maxGapMs: number; header?: HeaderRec; recs: LogRec[]; done?: Extract<LiveMessage, { type: "done" }>; error?: string; t0: number; firstHeaderMs?: number; doneMs?: number; lastTick: number; tickRegress: boolean };

function watch(c: CreateMatchResponse): Promise<Watch> {
  const w: Watch = { id: c.matchId, queuedPositions: [], batches: 0, maxGapMs: 0, recs: [], t0: Date.now(), lastTick: -1, tickRegress: false };
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + c.liveUrl);
    let last = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as LiveMessage;
      const now = Date.now();
      if (m.type === "queued") w.queuedPositions.push(m.position);
      else if (m.type === "header") { w.header = m.header; w.firstHeaderMs = now - w.t0; }
      else if (m.type === "batch") {
        if (w.batches > 0) w.maxGapMs = Math.max(w.maxGapMs, now - last);
        last = now;
        w.batches++;
        w.recs.push(...m.recs);
        if (m.tick < w.lastTick) w.tickRegress = true;
        w.lastTick = m.tick;
      } else if (m.type === "done") { w.done = m; w.doneMs = now - w.t0; }
      else if (m.type === "error") w.error = m.message;
    };
    ws.onclose = () => resolve(w);
    ws.onerror = () => { w.error ??= "websocket error"; };
  });
}

async function create(): Promise<CreateMatchResponse> {
  const r = await fetch(base + "/api/matches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ map, condition }) });
  const body = await r.json();
  if (r.status !== 201) throw new Error(`POST /api/matches: HTTP ${r.status} ${JSON.stringify(body)}`);
  return body as CreateMatchResponse;
}

const before = await getJson<StatusResponse>("/api/status");
// The summary only covers the current sim/protocol version, while status counts every done match, so compare summary to summary.
const summaryTotal = (s: RunSummary) => s.conditions.reduce((a, c) => a + c.matches, 0);
const summaryBefore = summaryTotal(await getJson<RunSummary>("/api/summary/community"));
console.log("status before:", JSON.stringify(before));
const created: CreateMatchResponse[] = [];
for (let i = 0; i < n; i++) created.push(await create());
console.log("created:", created.map((c) => `${c.matchId} (queue ${c.queuePosition})`).join(", "));
const mid = await getJson<StatusResponse>("/api/status");
console.log("status after create:", JSON.stringify(mid));
if (lateMs) await new Promise((r) => setTimeout(r, lateMs));
const results = await Promise.all(created.map(watch));

let ok = true;
const check = (cond: boolean, msg: string) => { if (!cond) { ok = false; console.log("  FAIL:", msg); } };
for (const w of results) {
  console.log(`\nmatch ${w.id}: queued ${JSON.stringify(w.queuedPositions)}, header at ${w.firstHeaderMs} ms, ${w.batches} batches (max gap ${w.maxGapMs} ms), ${w.recs.length} recs, done at ${w.doneMs} ms`);
  if (w.error) { ok = false; console.log("  error:", w.error); continue; }
  check(!!w.header && !!w.done, "header and done received");
  if (!w.header || !w.done) continue;
  const { result, entry } = w.done;
  const cost = result.stats[0].cost + result.stats[1].cost;
  console.log(`  ${entry.labels[0]} vs ${entry.labels[1]} on ${entry.map} (${entry.condition}, seed ${entry.seed}): winner ${result.winner === null ? "draw" : entry.labels[result.winner]} by ${result.reason} in ${entry.durationS.toFixed(1)} s, hp ${result.hp.join("-")}, cost $${cost.toFixed(4)}, p50 ${result.stats.map((s) => s.latencyMs.p50).join("/")} ms, errors ${result.stats.map((s) => s.errors).join("/")}`);
  check(!w.tickRegress, "batch ticks never go backwards");
  check(w.lastTick === result.ticks, `last batch tick ${w.lastTick} == result ticks ${result.ticks}`);
  const streamed: LogRec[] = [w.header, ...w.recs, result];
  const rp = createReplay(streamed);
  while (rp.advance());
  check(rp.mismatches.length === 0 && rp.world.tick === result.ticks, `streamed log replays with matching checksums (${rp.mismatches.length} mismatches)`);
  const stored = await getJson<MatchIndexEntry>(`/api/matches/${w.id}`);
  check(JSON.stringify(stored) === JSON.stringify(entry), "GET /api/matches/:id equals the done entry");
  check(entry.file === `/api/matches/${w.id}/log` && entry.runId === "community", "entry file/runId");
  const logText = await (await fetch(base + entry.file)).text();
  const log = parseLog(logText);
  check(log.length === streamed.length, `stored log has ${log.length} records, streamed ${streamed.length}`);
  check(JSON.stringify(log.slice(1, -1)) === JSON.stringify(w.recs), "stored log body equals the streamed records");
}

const list = await getJson<MatchListResponse>("/api/matches?limit=5");
console.log(`\nlist (newest first): ${list.matches.map((m) => m.matchId).join(", ")}  nextCursor=${list.nextCursor ? "yes" : "null"}`);
const sum = await getJson<RunSummary>("/api/summary/community");
const total = summaryTotal(sum);
console.log(`summary: ${total} matches, $${sum.totalCostUsd.toFixed(4)}, conditions ${sum.conditions.map((c) => `${c.condition}:${c.matches}`).join(" ")}`);
const after = await getJson<StatusResponse>("/api/status");
console.log("status after:", JSON.stringify(after));
const finished = results.filter((w) => w.done).length;
check(total >= summaryBefore + finished, "summary includes the new matches");
console.log(ok ? "\nSMOKE OK" : "\nSMOKE FAILED");
process.exit(ok ? 0 : 1);
