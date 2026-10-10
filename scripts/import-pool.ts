// Prepare locally run matches for import into the single public pool (seed data).
// Includes every runs/<run>/matches/*.jsonl that is: current SIM_VERSION and PROTOCOL_VERSION, Jev vs Microsoft (model agents),
// a public condition, and not aborted. Writes .import/pool/<id>.jsonl (log copies for R2) and .import/pool/rows.sql
// (D1 inserts with origin 't1-local' = "run locally"), plus a SQL tail that resets the summary fold so the pool is re-summarized.
// Imported rows carry cost 0: the site didn't pay for them, so they don't count against BUDGET_USD.
// Per-match cost statistics still come from each log's digest.
// Usage: node scripts/import-t1.ts
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLog, type HeaderRec, type LogRec } from "../src/runner/log.ts";
import { digestMatch, indexEntry, toMatch } from "../src/analysis/aggregate.ts";
import { hashString } from "../src/sim/rng.ts";
import { SIM_VERSION } from "../src/sim/tuning.ts";
import { PROTOCOL_VERSION } from "../src/protocol/v1.ts";
import { PUBLIC_CONDITIONS } from "../src/api/contract.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, ".import", "pool");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const q = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const ids = new Set<string>();
const rows: string[] = [];
const counts: Record<string, number> = {};
const files: [string, string][] = [];
for (const run of readdirSync(join(root, "runs"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  let names: string[] = [];
  try { names = readdirSync(join(root, "runs", run, "matches")); } catch { continue; }
  for (const f of names.filter((f) => f.endsWith(".jsonl")).sort()) files.push([run, join(root, "runs", run, "matches", f)]);
}
for (const [runId, path] of files) {
  const text = readFileSync(path, "utf8");
  let recs: LogRec[];
  try { recs = parseLog(text); } catch { continue; }
  const m = toMatch(recs);
  if (!m || m.result.reason === "aborted") continue;
  const h = recs[0] as HeaderRec;
  if (h.sim !== SIM_VERSION || h.protocol !== PROTOCOL_VERSION) continue;
  if (!Object.hasOwn(PUBLIC_CONDITIONS, h.condition)) continue;
  if (h.agents.map((a) => a.id).sort().join() !== "jev,msd1") continue;
  counts[`${runId} ${h.condition}`] = (counts[`${runId} ${h.condition}`] ?? 0) + 1;
  // Stable, MATCH_ID_RE-safe id: "t1" + base36 hash of the original match id.
  const id = `${runId}${hashString(h.matchId).toString(36).padStart(7, "0")}${hashString(h.matchId + "#").toString(36).slice(0, 4)}`.replace(/[^a-z0-9]/g, "");
  if (ids.has(id)) throw new Error(`id collision ${id}`);
  ids.add(id);
  const e = indexEntry(m);
  const created = Date.parse(h.createdAt);
  writeFileSync(join(out, `${id}.jsonl`), text);
  rows.push(
    `INSERT OR REPLACE INTO matches (id, created_at, finished_at, status, map, condition, seed, agents, winner, reason, ticks, hp, highlights, cost, extra_cost, sim, protocol, digest, folded, origin) VALUES (` +
      [
        q(id), q(created), q(created + m.result.wallMs), q("done"), q(h.map), q(h.condition), q(h.seed),
        q(JSON.stringify(h.agents.map((a) => ({ id: a.id, label: a.label, model: a.model })))),
        q(m.result.winner), q(m.result.reason), q(m.result.ticks), q(JSON.stringify(m.result.hp)), q(JSON.stringify(e.highlights)),
        q(0), q(0), q(h.sim), q(h.protocol), q(JSON.stringify(digestMatch(m))), q(0), q("t1-local"),
      ].join(", ") +
      ");",
  );
}
// Re-summarize the whole pool from scratch (run right after a deploy, which restarts the Lobby and drops its in-memory accumulator).
rows.push("UPDATE matches SET folded = 0;", "DELETE FROM summary_cache;");
writeFileSync(join(out, "rows.sql"), rows.join("\n") + "\n");
console.log(counts);
console.log(`${ids.size} matches prepared in ${out}`);
