// Usage: node src/analysis/cli.ts [--runs a,b] [--include-dev]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLog } from "../runner/log.ts";
import { formatReport, indexEntry, summarizeRun, toMatch } from "./aggregate.ts";
import type { DataIndex, MatchIndexEntry } from "./schema.ts";
import type { Match } from "./aggregate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const includeDev = args.includes("--include-dev");
const ri = args.indexOf("--runs");
const only = ri >= 0 ? (args[ri + 1] ?? "").split(",").filter(Boolean) : null;

const runsDir = join(root, "runs");
const outDir = join(root, "public", "data");
const generatedAt = new Date().toISOString();
const isDev = (id: string) => id.startsWith("dev-") || id.startsWith("adhoc-");

const runIds = (existsSync(runsDir) ? readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
  .filter((id) => (only ? only.includes(id) : includeDev || !isDev(id)))
  .sort();

rmSync(join(outDir, "matches"), { recursive: true, force: true });
rmSync(join(outDir, "summary"), { recursive: true, force: true });
mkdirSync(join(outDir, "summary"), { recursive: true });

const index: DataIndex = { generatedAt, runs: [], matches: [] };
for (const runId of runIds) {
  const mdir = join(runsDir, runId, "matches");
  if (!existsSync(mdir)) continue;
  const matches: Match[] = [];
  const entries: MatchIndexEntry[] = [];
  let skipped = 0;
  for (const f of readdirSync(mdir).filter((f) => f.endsWith(".jsonl")).sort()) {
    let m: Match | null = null;
    try { m = toMatch(parseLog(readFileSync(join(mdir, f), "utf8"))); } catch { m = null; }
    if (!m) { skipped++; continue; }
    matches.push(m);
    const e = indexEntry(m);
    e.file = `matches/${runId}/${f}`;
    entries.push(e);
    mkdirSync(join(outDir, "matches", runId), { recursive: true });
    copyFileSync(join(mdir, f), join(outDir, e.file));
  }
  if (!matches.length) { console.log(`Run ${runId}: no complete matches${skipped ? ` (${skipped} skipped)` : ""}`); continue; }
  const summary = summarizeRun(runId, matches, generatedAt);
  writeFileSync(join(outDir, "summary", `${runId}.json`), JSON.stringify(summary, null, 1));
  index.runs.push({ runId, summaryFile: `summary/${runId}.json`, matches: matches.length, conditions: summary.conditions.map((c) => c.condition) });
  index.matches.push(...entries);
  console.log(formatReport(summary) + (skipped ? `\n  (${skipped} incomplete/aborted file(s) excluded)` : "") + "\n");
}
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 1));
console.log(`Exported ${index.matches.length} matches from ${index.runs.length} run(s) to public/data/`);
