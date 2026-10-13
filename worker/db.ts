// D1 access for community matches and the cached community summary.
import { COMMUNITY_RUN_ID } from "../src/api/contract.ts";
import { addDigest, emptyAcc, finalizeSummary, type MatchDigest, type SummaryAcc } from "../src/analysis/aggregate.ts";
import type { MatchIndexEntry, RunSummary } from "../src/analysis/schema.ts";
import { MODELS } from "../src/agents/models.ts";
import { CURRENT_PROTOCOL } from "../src/protocol/v2.ts";
import { SIM_VERSION, TICK_HZ } from "../src/sim/tuning.ts";

export type MatchRow = {
  id: string;
  created_at: number;
  finished_at: number;
  status: "done" | "aborted" | "failed";
  map: string;
  condition: string;
  seed: number;
  agents: string; // JSON [{id,label,model}]
  winner: number | null;
  reason: string | null;
  ticks: number;
  hp: string | null;
  highlights: string | null;
  cost: number;
  extra_cost: number;
  sim: string;
  protocol: string;
  digest: string | null;
  origin?: "web" | "t1-local";
};

const LIST_COLS = "id, finished_at, map, condition, seed, agents, winner, reason, ticks, hp, highlights, origin, sim, protocol";

export const logPath = (id: string) => `/api/matches/${id}/log`;

export function rowToEntry(r: Pick<MatchRow, "id" | "map" | "condition" | "seed" | "agents" | "winner" | "reason" | "ticks" | "hp" | "highlights" | "origin" | "sim" | "protocol">): MatchIndexEntry {
  const agents = JSON.parse(r.agents) as { id: string; label: string }[];
  return {
    runId: COMMUNITY_RUN_ID,
    matchId: r.id,
    file: logPath(r.id),
    condition: r.condition,
    map: r.map,
    seed: r.seed,
    agents: [agents[0].id, agents[1].id],
    labels: [agents[0].label, agents[1].label],
    winner: r.winner === 0 || r.winner === 1 ? r.winner : null,
    reason: r.reason ?? "",
    durationS: r.ticks / TICK_HZ,
    hp: r.hp ? JSON.parse(r.hp) : [0, 0],
    highlights: r.highlights ? JSON.parse(r.highlights) : [],
    version: `${r.sim}:${r.protocol}`,
    origin: r.origin === "t1-local" ? "t1-local" : "web",
  };
}

export async function insertMatch(db: D1Database, r: MatchRow): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO matches (id, created_at, finished_at, status, map, condition, seed, agents, winner, reason, ticks, hp, highlights, cost, extra_cost, sim, protocol, digest, folded)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 0)`,
    )
    .bind(r.id, r.created_at, r.finished_at, r.status, r.map, r.condition, r.seed, r.agents, r.winner, r.reason, r.ticks, r.hp, r.highlights, r.cost, r.extra_cost, r.sim, r.protocol, r.digest)
    .run();
}

export async function getEntry(db: D1Database, id: string): Promise<MatchIndexEntry | null> {
  const r = await db.prepare(`SELECT ${LIST_COLS} FROM matches WHERE id = ?1 AND status = 'done'`).bind(id).first<MatchRow>();
  return r ? rowToEntry(r) : null;
}

// Cursor: base64url("<finished_at>.<id>") of the last row on the previous page.
export const encodeCursor = (finishedAt: number, id: string) => btoa(`${finishedAt}.${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function decodeCursor(c: string): { finishedAt: number; id: string } | null {
  try {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(c)) return null;
    const m = /^(\d{1,16})\.([a-z0-9]{8,32})$/.exec(atob(c.replace(/-/g, "+").replace(/_/g, "/")));
    return m ? { finishedAt: Number(m[1]), id: m[2] } : null;
  } catch {
    return null;
  }
}

/** Finished matches, newest first; `version` ("<sim>:<protocol>") restricts the list to one version. */
export async function listMatches(db: D1Database, limit: number, cursor: { finishedAt: number; id: string } | null, version?: string) {
  const where = [`status = 'done'`];
  const args: (string | number)[] = [];
  const arg = (v: string | number) => { args.push(v); return `?${args.length}`; };
  if (cursor) { const f = arg(cursor.finishedAt), i = arg(cursor.id); where.push(`(finished_at < ${f} OR (finished_at = ${f} AND id < ${i}))`); }
  if (version) { const [sim, protocol] = version.split(":"); where.push(`sim = ${arg(sim)} AND protocol = ${arg(protocol)}`); }
  const q = db.prepare(`SELECT ${LIST_COLS} FROM matches WHERE ${where.join(" AND ")} ORDER BY finished_at DESC, id DESC LIMIT ${arg(limit + 1)}`).bind(...args);
  const { results } = await q.all<MatchRow>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return { matches: page.map(rowToEntry), nextCursor: results.length > limit && last ? encodeCursor(last.finished_at, last.id) : null };
}

/** Total recorded community spend (log cost + warm-ups) and number of finished matches. */
export async function spendAndCount(db: D1Database): Promise<{ usd: number; done: number }> {
  const r = await db.prepare(`SELECT COALESCE(SUM(cost + extra_cost), 0) AS usd, COALESCE(SUM(status = 'done'), 0) AS done FROM matches`).first<{ usd: number; done: number }>();
  return { usd: Number(r?.usd ?? 0), done: Number(r?.done ?? 0) };
}

// ---------- Community summary cache ----------
// One summary per version ("<sim>:<protocol>"): results from different versions are never merged, and every version stays
// readable so the site can filter between them. Only the Lobby (a singleton, serialized) writes summary_cache. The Lobby
// keeps the CURRENT version's accumulator in memory; other versions (imported experiments, older protocols) are folded
// straight from D1.
export const CURRENT_VERSION = `${SIM_VERSION}:${CURRENT_PROTOCOL}`;
const keyOf = (version: string) => `${COMMUNITY_RUN_ID}:${version}`;
const VERSION_RE = /^[a-z0-9.-]{1,24}:[a-z0-9.-]{1,24}$/;
export const isVersion = (v: string) => VERSION_RE.test(v);

export function emptyCommunitySummary(generatedAt: string, version = CURRENT_VERSION): RunSummary {
  const [sim, protocol] = version.split(":");
  const s = finalizeSummary(COMMUNITY_RUN_ID, emptyAcc(), generatedAt);
  return { ...s, sim, protocol, agents: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, model: m.model })) };
}

export async function readSummary(db: D1Database, version = CURRENT_VERSION): Promise<RunSummary | null> {
  const r = await db.prepare(`SELECT summary FROM summary_cache WHERE run_id = ?1`).bind(keyOf(version)).first<{ summary: string }>();
  return r ? (JSON.parse(r.summary) as RunSummary) : null;
}

/** Every version with a summary, newest first, plus which one is current. */
export async function listVersions(db: D1Database): Promise<{ current: string; versions: { id: string; sim: string; protocol: string; matches: number }[] }> {
  const { results } = await db
    .prepare(`SELECT run_id, matches FROM summary_cache WHERE run_id LIKE ?1 AND matches > 0 ORDER BY updated_at DESC`)
    .bind(`${COMMUNITY_RUN_ID}:%:%`)
    .all<{ run_id: string; matches: number }>();
  const versions = results.map((r) => { const id = r.run_id.slice(COMMUNITY_RUN_ID.length + 1); const [sim, protocol] = id.split(":"); return { id, sim, protocol, matches: r.matches }; });
  return { current: CURRENT_VERSION, versions };
}

export async function readAcc(db: D1Database, version = CURRENT_VERSION): Promise<SummaryAcc | null> {
  const r = await db.prepare(`SELECT acc FROM summary_cache WHERE run_id = ?1`).bind(keyOf(version)).first<{ acc: string }>();
  return r ? (JSON.parse(r.acc) as SummaryAcc) : null;
}

/** Fold unfolded digests of one version into `acc`, persisting acc + summary + folded flags atomically per batch. */
async function foldVersion(db: D1Database, version: string, acc: SummaryAcc): Promise<{ acc: SummaryAcc; folded: number }> {
  const [sim, protocol] = version.split(":");
  let folded = 0;
  for (;;) {
    const { results } = await db
      .prepare(`SELECT id, digest FROM matches WHERE folded = 0 AND status = 'done' AND digest IS NOT NULL AND sim = ?1 AND protocol = ?2 ORDER BY finished_at, id LIMIT 200`)
      .bind(sim, protocol)
      .all<{ id: string; digest: string }>();
    if (!results.length && folded) break;
    const next: SummaryAcc = JSON.parse(JSON.stringify(acc));
    for (const r of results) addDigest(next, JSON.parse(r.digest) as MatchDigest);
    const now = Date.now();
    const summary = next.matches ? finalizeSummary(COMMUNITY_RUN_ID, next, new Date(now).toISOString()) : emptyCommunitySummary(new Date(now).toISOString(), version);
    await db.batch([
      db.prepare(`UPDATE matches SET folded = 1 WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(results.map((r) => r.id))),
      db
        .prepare(`INSERT INTO summary_cache (run_id, matches, acc, summary, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                  ON CONFLICT(run_id) DO UPDATE SET matches = excluded.matches, acc = excluded.acc, summary = excluded.summary, updated_at = excluded.updated_at`)
        .bind(keyOf(version), next.matches, JSON.stringify(next), JSON.stringify(summary), now),
    ]);
    acc = next;
    folded += results.length;
    if (results.length < 200) break;
  }
  return { acc, folded };
}

/**
 * Fold every finished-but-unfolded digest: other versions first (from their D1 accumulators), then the current version
 * into the Lobby's in-memory `acc`. Catches up on anything missed earlier. Returns the current version's new acc.
 */
export async function foldPending(db: D1Database, acc: SummaryAcc): Promise<{ acc: SummaryAcc; folded: number }> {
  const { results: others } = await db
    .prepare(`SELECT DISTINCT sim, protocol FROM matches WHERE folded = 0 AND status = 'done' AND digest IS NOT NULL AND NOT (sim = ?1 AND protocol = ?2)`)
    .bind(SIM_VERSION, CURRENT_PROTOCOL)
    .all<{ sim: string; protocol: string }>();
  let folded = 0;
  for (const o of others) {
    const v = `${o.sim}:${o.protocol}`;
    folded += (await foldVersion(db, v, (await readAcc(db, v)) ?? emptyAcc())).folded;
  }
  const cur = await foldVersion(db, CURRENT_VERSION, acc);
  return { acc: cur.acc, folded: folded + cur.folded };
}
