// Dev fixture: builds public/data/ from local runs/ logs so the viewer can be developed without a tournament.
// Output follows src/analysis/schema.ts and is labelled with `devFixture` so the UI marks it as dev data.
// The stats are computed from the logs by src/analysis/aggregate.ts (no invented numbers).
//
// Prefer `pnpm analyze --include-dev`, which writes the same contract. This script refuses to overwrite a real
// (non-fixture) export unless --force is given.
//
// Usage: node src/viewer/dev/make-fixture.ts [--runs dev-bots,dev-smoke] [--force]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLog } from "../../runner/log.ts";
import { indexEntry, summarizeRun, toMatch, type Match } from "../../analysis/aggregate.ts";
import type { DataIndex, MatchIndexEntry } from "../../analysis/schema.ts";

const NOTE = "Built by src/viewer/dev/make-fixture.ts from local dev logs for viewer development. Not benchmark results.";

const root = join(import.meta.dirname, "..", "..", "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const ri = args.indexOf("--runs");
const runIds = ri >= 0 ? (args[ri + 1] ?? "").split(",").filter(Boolean) : ["dev-bots", "dev-smoke"];
const out = join(root, "public", "data");
const indexFile = join(out, "index.json");

if (existsSync(indexFile) && !force) {
  const cur = JSON.parse(readFileSync(indexFile, "utf8")) as { devFixture?: string };
  if (!cur.devFixture) {
    console.error("public/data/index.json holds a real export (no devFixture marker). Re-run with --force to replace it.");
    process.exit(1);
  }
}

rmSync(join(out, "matches"), { recursive: true, force: true });
rmSync(join(out, "summary"), { recursive: true, force: true });
mkdirSync(join(out, "summary"), { recursive: true });

const generatedAt = new Date().toISOString();
const index: DataIndex & { devFixture: string } = { generatedAt, devFixture: NOTE, runs: [], matches: [] };
for (const runId of runIds) {
  const dir = join(root, "runs", runId, "matches");
  if (!existsSync(dir)) { console.warn(`skip ${runId}: no ${dir}`); continue; }
  const matches: Match[] = [];
  const entries: MatchIndexEntry[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const m = toMatch(parseLog(readFileSync(join(dir, f), "utf8")));
    if (!m) continue;
    const e = indexEntry(m);
    e.file = `matches/${runId}/${f}`;
    mkdirSync(join(out, "matches", runId), { recursive: true });
    copyFileSync(join(dir, f), join(out, e.file));
    matches.push(m);
    entries.push(e);
  }
  if (!matches.length) continue;
  const summary = { ...summarizeRun(runId, matches, generatedAt), devFixture: NOTE };
  writeFileSync(join(out, "summary", `${runId}.json`), JSON.stringify(summary, null, 1));
  index.runs.push({ runId, summaryFile: `summary/${runId}.json`, matches: matches.length, conditions: summary.conditions.map((c) => c.condition) });
  index.matches.push(...entries);
}
writeFileSync(indexFile, JSON.stringify(index, null, 1));
console.log(`Dev fixture: ${index.matches.length} matches from ${index.runs.length} run(s) -> public/data/`);
