// Tournament scheduler: maps × seeds × side swaps × latency conditions, run through a bounded pool with a budget cap.
// Resumable: matches whose log already contains a result are skipped.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMatch, type Budget } from "./engine.ts";
import { conditionName, parseLatency, type LatencyMode } from "./latency.ts";
import { parseLog, type DecisionRec, type HeaderRec, type ResultRec } from "./log.ts";
import { makeAgent, RUNS_DIR } from "./registry.ts";
import type { Agent } from "../agents/types.ts";

export type TournamentConfig = {
  runId: string;
  agents: [string, string];
  maps: string[];
  seeds: number[];
  /** "fixed:<ms>", "scaled:<factor>", or "swap:<factor>" (each agent plays with the other's measured latency distribution × factor) */
  conditions: string[];
  budgetUsd: number;
  concurrency: number;
  estMatchCostUsd?: number;
};

type Job = { matchId: string; map: string; seed: number; condition: string; order: [string, string] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readResult(file: string): { header: HeaderRec; result: ResultRec; decisions: DecisionRec[] } | null {
  if (!existsSync(file)) return null;
  const recs = parseLog(readFileSync(file, "utf8"));
  const result = recs.find((r) => r.k === "result") as ResultRec | undefined;
  if (!result || result.reason === "aborted") return null;
  return { header: recs[0] as HeaderRec, result, decisions: recs.filter((r) => r.k === "decision") as DecisionRec[] };
}

export async function runTournament(cfg: TournamentConfig) {
  const dir = join(RUNS_DIR, cfg.runId);
  const mdir = join(dir, "matches");
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ ...cfg, startedAt: new Date().toISOString() }, null, 1));

  // Condition order matters: swap conditions need latency traces from scaled runs, so they run last.
  const conds = [...cfg.conditions].sort((x, y) => Number(x.startsWith("swap")) - Number(y.startsWith("swap")));
  const jobs: Job[] = [];
  for (const condition of conds)
    for (const map of cfg.maps)
      for (const seed of cfg.seeds)
        for (const order of [cfg.agents, [cfg.agents[1], cfg.agents[0]]] as [string, string][]) {
          jobs.push({ matchId: `${condition.replace(":", "-")}__${map}__s${seed}__${order[0]}-v-${order[1]}`, map, seed, condition, order });
        }

  const budget: Budget = { spent: 0, hardCap: cfg.budgetUsd };
  const est = cfg.estMatchCostUsd ?? 0.03;
  const traces = new Map<string, number[]>(); // agent spec -> real latencies (ms) from scaled matches
  const addTraces = (h: HeaderRec, ds: DecisionRec[]) => {
    if (h.latency.mode !== "scaled") return;
    for (const d of ds) if (!d.error) {
      const id = h.agents[d.slot].id;
      (traces.get(id) ?? traces.set(id, []).get(id)!).push(d.realMs);
    }
  };

  let done = 0, skipped = 0, failed = 0, inflight = 0;
  const pendingSwap: Job[] = [];
  const t0 = Date.now();
  const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s $${budget.spent.toFixed(4)}] ${s}`);

  // Resume: count prior results and their spend.
  for (const j of jobs) {
    const prev = readResult(join(mdir, `${j.matchId}.jsonl`));
    if (prev) {
      skipped++;
      budget.spent += prev.result.stats[0].cost + prev.result.stats[1].cost;
      addTraces(prev.header, prev.decisions);
    }
  }
  if (skipped) log(`resuming: ${skipped} matches already complete`);

  const queue = jobs.filter((j) => !existsSync(join(mdir, `${j.matchId}.jsonl`)) || !readResult(join(mdir, `${j.matchId}.jsonl`)));
  log(`${queue.length} matches to run, concurrency ${cfg.concurrency}, budget $${cfg.budgetUsd}`);

  const runJob = async (j: Job) => {
    let latency: LatencyMode;
    let condName: string;
    if (j.condition.startsWith("swap")) {
      const factor = Number(j.condition.split(":")[1] ?? 1);
      const [a, b] = j.order.map((s) => makeAgent(s).info.id);
      const ta = traces.get(b) ?? [], tb = traces.get(a) ?? [];
      if (ta.length < 50 || tb.length < 50) throw new Error(`not enough latency samples for swap (${ta.length}/${tb.length})`);
      latency = { mode: "resampled", traces: [ta.map((x) => x * factor), tb.map((x) => x * factor)], label: `swap-${factor}` };
      condName = `swap-${factor}`;
    } else {
      latency = parseLatency(j.condition);
      condName = conditionName(latency);
    }
    const agents = [makeAgent(j.order[0], j.seed), makeAgent(j.order[1], j.seed + 1)] as [Agent, Agent];
    const file = join(mdir, `${j.matchId}.jsonl`);
    writeFileSync(file, "");
    const { records, result } = await runMatch(
      { runId: cfg.runId, matchId: j.matchId, map: j.map, seed: j.seed, latency, condition: condName, agents },
      { budget, onRecord: (r) => appendFileSync(file, JSON.stringify(r) + "\n") },
    );
    if (result.reason !== "aborted") {
      // Keep resampled trace arrays out of the log header bloat: rewrite header with summary only.
      if (latency.mode === "resampled") {
        const lines = readFileSync(file, "utf8").split("\n");
        const h = JSON.parse(lines[0]);
        h.latency = { mode: "resampled", label: latency.label, samples: [latency.traces[0].length, latency.traces[1].length], medianMs: latency.traces.map((t) => [...t].sort((x, y) => x - y)[Math.floor(t.length / 2)]) };
        lines[0] = JSON.stringify(h);
        writeFileSync(file, lines.join("\n"));
      }
      addTraces(records[0] as HeaderRec, records.filter((r) => r.k === "decision") as DecisionRec[]);
    }
    const w = result.winner === null ? "draw" : j.order[result.winner];
    log(`${j.matchId}: ${w} (${result.reason}, ${(result.ticks / 30).toFixed(1)}s, hp ${result.hp.join("-")}, $${(result.stats[0].cost + result.stats[1].cost).toFixed(4)})`);
  };

  const worker = async () => {
    while (true) {
      const j = queue.shift() ?? pendingSwap.shift();
      if (!j) return;
      if (budget.spent + est * (inflight + 1) > budget.hardCap) { log(`budget reached, stopping (${queue.length + 1} matches not run)`); queue.length = 0; return; }
      // Swap jobs wait until all scaled jobs have finished so traces are complete.
      if (j.condition.startsWith("swap") && queue.some((q) => !q.condition.startsWith("swap"))) { queue.push(j); await sleep(500); continue; }
      if (j.condition.startsWith("swap") && inflightNonSwap > 0) { queue.unshift(j); await sleep(1000); continue; }
      inflight++;
      const isSwap = j.condition.startsWith("swap");
      if (!isSwap) inflightNonSwap++;
      try { await runJob(j); done++; }
      catch (e) { failed++; log(`FAILED ${j.matchId}: ${(e as Error).message}`); }
      finally { inflight--; if (!isSwap) inflightNonSwap--; }
    }
  };
  let inflightNonSwap = 0;

  // Warm both models before starting.
  for (const s of cfg.agents) await makeAgent(s).warmup?.();
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ ...cfg, finishedAt: new Date().toISOString(), done, skipped, failed, spentUsd: budget.spent }, null, 1));
  log(`finished: ${done} run, ${skipped} resumed, ${failed} failed`);
}
