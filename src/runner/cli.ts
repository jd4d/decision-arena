// Usage:
//   node src/runner/cli.ts match --a jev --b msd1 --map pillars --seed 1 --latency scaled:1 [--run name]
//   node src/runner/cli.ts tournament --config tournaments/<file>.json [--budget 1.5] [--concurrency 6]
// Agents: jev | msd1 | scripted[:ms] | random[:ms]
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../agents/types.ts";
import { makeAgent, RUNS_DIR } from "./registry.ts";
import { runMatch, type Budget } from "./engine.ts";
import { parseLatency } from "./latency.ts";
import { runTournament, type TournamentConfig } from "./tournament.ts";


function args(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (cmd === "match") {
    const runId = a.run ?? `adhoc-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const seed = Number(a.seed ?? 1);
    const dir = join(RUNS_DIR, runId, "matches");
    mkdirSync(dir, { recursive: true });
    const agents: [Agent, Agent] = [makeAgent(a.a ?? "scripted", seed), makeAgent(a.b ?? "random", seed + 1)];
    for (const ag of agents) await ag.warmup?.();
    const latency = parseLatency(a.latency ?? "scaled:1");
    const matchId = `${a.map ?? "pillars"}-s${seed}-${agents[0].info.id}-v-${agents[1].info.id}`;
    const file = join(dir, `${matchId}.jsonl`);
    writeFileSync(file, "");
    const budget: Budget = { spent: 0, hardCap: Number(a.budget ?? 0.25) };
    const { result } = await runMatch(
      { runId, matchId, map: a.map ?? "pillars", seed, latency, agents },
      { budget, onRecord: (r) => appendFileSync(file, JSON.stringify(r) + "\n") },
    );
    console.log(JSON.stringify({ file, winner: result.winner, reason: result.reason, ticks: result.ticks, hp: result.hp, wallMs: result.wallMs, spent: +budget.spent.toFixed(5), stats: result.stats }, null, 1));
    return;
  }
  if (cmd === "tournament") {
    if (!a.config) throw new Error("--config required");
    const cfg = JSON.parse(readFileSync(a.config, "utf8")) as TournamentConfig;
    if (a.budget) cfg.budgetUsd = Number(a.budget);
    if (a.concurrency) cfg.concurrency = Number(a.concurrency);
    if (a.run) cfg.runId = a.run;
    await runTournament(cfg);
    return;
  }
  console.error("usage: cli.ts match|tournament ...");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
