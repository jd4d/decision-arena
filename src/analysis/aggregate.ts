// Pure aggregation of match logs into the viewer data contract (see schema.ts). No I/O here.
import type { DecisionRec, EventRec, HeaderRec, LogRec, ResultRec } from "../runner/log.ts";
import { TANK_HP } from "../sim/tuning.ts";
import type {
  AgentConditionStats,
  Interval,
  MatchIndexEntry,
  RunSummary,
} from "./schema.ts";

export type Match = { header: HeaderRec; decisions: DecisionRec[]; events: EventRec[]; result: ResultRec };

export const HIST_BIN_MS = 25;
export const HIST_CAP_MS = 1500;
export const FIRE_BINS = ["<0.5", "0.5-0.6", "0.6-0.7", "0.7-0.8", "0.8-0.9", "0.9-1.0"] as const;

/** Split parsed records into a Match; null if incomplete (no header/result) or aborted. */
export function toMatch(recs: LogRec[]): Match | null {
  let header: HeaderRec | undefined;
  let result: ResultRec | undefined;
  const decisions: DecisionRec[] = [];
  const events: EventRec[] = [];
  for (const r of recs) {
    if (r.k === "header") header = r;
    else if (r.k === "result") result = r;
    else if (r.k === "decision") decisions.push(r);
    else if (r.k === "event") events.push(r);
  }
  if (!header || !result || result.reason === "aborted") return null;
  return { header, decisions, events, result };
}

export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { p: 0, lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function fireBin(p: number): string {
  if (p < 0.5) return "<0.5";
  const i = Math.min(4, Math.floor((p - 0.5) * 10 + 1e-9));
  return FIRE_BINS[i + 1];
}

type HitEv = Extract<EventRec, { type: "hit" }>;
const isHit = (e: EventRec): e is HitEv => e.type === "hit";

/** Shots by slot with the fireP of the deciding decision (skips shots without detail) and whether they hit. */
export function fireShots(m: Match): { slot: 0 | 1; fireP: number; hit: boolean }[] {
  const hitShells = new Set<number>();
  for (const e of m.events) if (isHit(e) && !e.self && e.victim !== e.owner) hitShells.add(e.shell);
  const out: { slot: 0 | 1; fireP: number; hit: boolean }[] = [];
  for (const e of m.events) {
    if (e.type !== "fire") continue;
    let best: DecisionRec | undefined;
    for (const d of m.decisions) {
      if (d.slot !== e.slot || d.applyTick > e.t || !d.action?.fire) continue;
      if (!best || d.applyTick >= best.applyTick) best = d;
    }
    if (best?.detail) out.push({ slot: e.slot, fireP: best.detail.fireP, hit: hitShells.has(e.shell) });
  }
  return out;
}

export function highlights(m: Match): string[] {
  const out: string[] = [];
  const hits = m.events.filter(isHit);
  const { winner, reason } = m.result;
  if (hits.some((h) => h.self)) out.push("self-hit");
  if (m.events.some((e) => e.type === "clash")) out.push("shell clash");
  if (winner !== null) {
    const loser = (1 - winner) as 0 | 1;
    const hp: [number, number] = [TANK_HP, TANK_HP];
    let comeback = false;
    for (const h of hits) {
      hp[h.victim] = h.hpAfter;
      if (hp[winner] === 1 && hp[loser] === TANK_HP) comeback = true;
    }
    if (comeback) out.push("comeback");
    const decisive = hits.filter((h) => !h.self && h.owner === winner).at(-1);
    const hz = m.header.tickHz || 30;
    if (reason === "destroyed" && decisive && decisive.t > m.header.roundTicks - 5 * hz) out.push("last-second");
    if (!hits.some((h) => h.victim === winner)) out.push("flawless");
  }
  if (winner === null && reason === "time") out.push("timeout draw");
  return out;
}

export function indexEntry(m: Match): MatchIndexEntry {
  const h = m.header;
  const ag = (s: 0 | 1) => h.agents.find((a) => a.slot === s) ?? h.agents[s];
  return {
    runId: h.runId,
    matchId: h.matchId,
    file: `matches/${h.runId}/${h.matchId}.jsonl`,
    condition: h.condition,
    map: h.map,
    seed: h.seed,
    agents: [ag(0).id, ag(1).id],
    labels: [ag(0).label, ag(1).label],
    winner: m.result.winner,
    reason: m.result.reason,
    durationS: m.result.ticks / (h.tickHz || 30),
    hp: m.result.hp,
    highlights: highlights(m),
  };
}

/** Per-agent stats for one condition, aggregated by agent id across slots. */
export function agentConditionStats(matches: Match[], agentId: string): AgentConditionStats {
  let n = 0, wins = 0, losses = 0, draws = 0;
  let decisions = 0, errors = 0, shots = 0, hits = 0, selfHits = 0, fizzles = 0, damageTaken = 0;
  let totalCost = 0, seconds = 0;
  const real: number[] = [], eff: number[] = [], firstHits: number[] = [], costs: number[] = [];
  const drive: Record<string, number> = {};
  let driveTotal = 0;
  const cal = new Map<string, { n: number; hit: number }>(FIRE_BINS.map((b) => [b, { n: 0, hit: 0 }]));
  for (const m of matches) {
    const slot = m.header.agents.find((a) => a.id === agentId)?.slot;
    if (slot === undefined) continue;
    n++;
    const w = m.result.winner;
    if (w === null) draws++;
    else if (w === slot) wins++;
    else losses++;
    const st = m.result.stats[slot];
    const hz = m.header.tickHz || 30;
    seconds += m.result.ticks / hz;
    decisions += st.decisions;
    errors += st.errors;
    fizzles += st.fizzles;
    damageTaken += st.damageTaken;
    totalCost += st.cost;
    costs.push(st.cost);
    for (const e of m.events) {
      if (e.type === "fire" && e.slot === slot) shots++;
      else if (isHit(e) && e.owner === slot) {
        if (e.self) selfHits++;
        else hits++;
      }
    }
    if (st.firstHitTick !== null && st.firstHitTick !== undefined) firstHits.push(st.firstHitTick / hz);
    for (const d of m.decisions) {
      if (d.slot !== slot) continue;
      if (!d.error) {
        real.push(d.realMs);
        eff.push(d.effMs);
      }
      if (d.action) {
        drive[d.action.drive] = (drive[d.action.drive] ?? 0) + 1;
        driveTotal++;
      }
    }
    for (const s of fireShots(m)) {
      if (s.slot !== slot) continue;
      const b = cal.get(fireBin(s.fireP))!;
      b.n++;
      if (s.hit) b.hit++;
    }
  }
  const driveMix: Record<string, number> = {};
  for (const [k, v] of Object.entries(drive)) driveMix[k] = v / driveTotal;
  return {
    matches: n, wins, losses, draws,
    winRate: wilson(wins, wins + losses),
    scoreRate: wilson(wins + 0.5 * draws, n),
    decisions,
    decisionsPerS: seconds ? decisions / seconds : 0,
    latencyMs: { p50: percentile(real, 0.5), p90: percentile(real, 0.9), mean: mean(real) },
    effLatencyMs: { p50: percentile(eff, 0.5), mean: mean(eff) },
    errors,
    errorRate: decisions ? errors / decisions : 0,
    shots, hits,
    accuracy: shots ? hits / shots : 0,
    selfHits, fizzles, damageTaken,
    costPerMatch: mean(costs),
    costPerDecision: decisions ? totalCost / decisions : 0,
    meanFirstHitS: firstHits.length ? mean(firstHits) : null,
    driveMix,
    fireCalibration: FIRE_BINS.map((b) => ({ bin: b, n: cal.get(b)!.n, hitRate: cal.get(b)!.n ? cal.get(b)!.hit / cal.get(b)!.n : 0 })),
  };
}

export function latencyHistogram(matches: Match[], agentId: string): { binMs: number; counts: number[] } {
  const counts = new Array(HIST_CAP_MS / HIST_BIN_MS + 1).fill(0);
  for (const m of matches) {
    const slot = m.header.agents.find((a) => a.id === agentId)?.slot;
    if (slot === undefined) continue;
    for (const d of m.decisions) {
      if (d.slot !== slot || d.error) continue;
      counts[Math.min(counts.length - 1, Math.floor(d.realMs / HIST_BIN_MS))]++;
    }
  }
  return { binMs: HIST_BIN_MS, counts };
}

export function summarizeRun(runId: string, matches: Match[], generatedAt: string): RunSummary {
  const agents = new Map<string, { id: string; label: string; model?: string }>();
  let sim = "", protocol = "", totalCostUsd = 0;
  for (const m of matches) {
    sim = m.header.sim;
    protocol = m.header.protocol;
    for (const a of m.header.agents) if (!agents.has(a.id)) agents.set(a.id, { id: a.id, label: a.label, ...(a.model ? { model: a.model } : {}) });
    totalCostUsd += m.result.stats[0].cost + m.result.stats[1].cost;
  }
  const conds = [...new Set(matches.map((m) => m.header.condition))].sort();
  const conditions = conds.map((condition) => {
    const ms = matches.filter((m) => m.header.condition === condition);
    const byAgent: Record<string, AgentConditionStats> = {};
    for (const id of agents.keys()) if (ms.some((m) => m.header.agents.some((a) => a.id === id))) byAgent[id] = agentConditionStats(ms, id);
    return { condition, matches: ms.length, draws: ms.filter((m) => m.result.winner === null).length, byAgent };
  });
  const mapIds = [...new Set(matches.map((m) => m.header.map))].sort();
  const maps = mapIds.map((map) => {
    const ms = matches.filter((m) => m.header.map === map);
    const winsByAgent: Record<string, number> = {};
    for (const id of agents.keys()) winsByAgent[id] = 0;
    let draws = 0;
    for (const m of ms) {
      const w = m.result.winner;
      if (w === null) draws++;
      else winsByAgent[m.header.agents.find((a) => a.slot === w)!.id]++;
    }
    return { map, matches: ms.length, winsByAgent, draws };
  });
  const hist: RunSummary["latencyHistogram"] = {};
  for (const id of agents.keys()) hist[id] = latencyHistogram(matches, id);
  return { runId, generatedAt, sim, protocol, agents: [...agents.values()], totalCostUsd, conditions, maps, latencyHistogram: hist };
}

const pad = (s: string, n: number) => s.padEnd(n);
const pct = (i: Interval) => `${(i.p * 100).toFixed(0)}% [${(i.lo * 100).toFixed(0)}-${(i.hi * 100).toFixed(0)}]`;

export function formatReport(s: RunSummary): string {
  const lines = [`Run ${s.runId}  (${s.conditions.reduce((a, c) => a + c.matches, 0)} matches, $${s.totalCostUsd.toFixed(4)})`];
  for (const c of s.conditions) {
    lines.push(`  condition ${c.condition}: ${c.matches} matches, ${c.draws} draws`);
    lines.push("    " + [pad("agent", 14), pad("W/L/D", 8), pad("winRate [95% CI]", 18), pad("p50 ms", 8), pad("acc", 6), "cost/match"].join(" "));
    for (const [id, a] of Object.entries(c.byAgent)) {
      lines.push("    " + [pad(id, 14), pad(`${a.wins}/${a.losses}/${a.draws}`, 8), pad(pct(a.winRate), 18), pad(a.latencyMs.p50.toFixed(0), 8), pad(`${(a.accuracy * 100).toFixed(0)}%`, 6), `$${a.costPerMatch.toFixed(4)}`].join(" "));
    }
  }
  return lines.join("\n");
}
