// Small read-side helpers over RunSummary: per-agent records, pooled over conditions, and "what changed".
import type { AgentConditionStats, Interval, MatchIndexEntry, RunSummary } from "../../analysis/schema.ts";

export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export type AgentRecord = {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  /** Wins ÷ decisive matches, or null when there are none. */
  winRate: Interval | null;
  p50: number;
  costPerMatch: number;
};

/** An agent's record in one condition, or pooled over every condition when `condition` is omitted. */
export function agentRecord(s: RunSummary | null | undefined, agentId: string, condition?: string): AgentRecord {
  const rows = (s?.conditions ?? [])
    .filter((c) => condition === undefined || c.condition === condition)
    .map((c) => c.byAgent[agentId])
    .filter((x): x is AgentConditionStats => !!x);
  const sum = (f: (r: AgentConditionStats) => number) => rows.reduce((t, r) => t + f(r), 0);
  const wins = sum((r) => r.wins), losses = sum((r) => r.losses), draws = sum((r) => r.draws), matches = sum((r) => r.matches);
  const decisions = sum((r) => r.decisions);
  return {
    matches, wins, losses, draws,
    winRate: wins + losses > 0 ? wilson(wins, wins + losses) : null,
    p50: decisions ? sum((r) => r.latencyMs.p50 * r.decisions) / decisions : NaN,
    costPerMatch: matches ? sum((r) => r.costPerMatch * r.matches) / matches : NaN,
  };
}

export const totalMatches = (s: RunSummary | null | undefined, condition?: string) =>
  (s?.conditions ?? []).filter((c) => condition === undefined || c.condition === condition).reduce((t, c) => t + c.matches, 0);

const emptyStats = (): AgentConditionStats => ({
  matches: 0, wins: 0, losses: 0, draws: 0, winRate: { p: 0, lo: 0, hi: 1 }, scoreRate: { p: 0, lo: 0, hi: 1 },
  decisions: 0, decisionsPerS: 0, latencyMs: { p50: 0, p90: 0, mean: 0 }, effLatencyMs: { p50: 0, mean: 0 }, errors: 0, errorRate: 0,
  shots: 0, hits: 0, accuracy: 0, selfHits: 0, fizzles: 0, damageTaken: 0, costPerMatch: 0, costPerDecision: 0, meanFirstHitS: null,
  driveMix: {}, fireCalibration: [],
});

/** Count one more finished match into a summary's records (used when the server summary hasn't caught up yet). */
export function withMatch(s: RunSummary, e: MatchIndexEntry): RunSummary {
  const out: RunSummary = structuredClone(s);
  let c = out.conditions.find((x) => x.condition === e.condition);
  if (!c) {
    c = { condition: e.condition, matches: 0, draws: 0, byAgent: {} };
    out.conditions.push(c);
  }
  c.matches++;
  if (e.winner === null) c.draws++;
  e.agents.forEach((id, slot) => {
    const st = (c.byAgent[id] ??= emptyStats());
    st.matches++;
    if (e.winner === null) st.draws++;
    else if (e.winner === slot) st.wins++;
    else st.losses++;
    st.winRate = wilson(st.wins, st.wins + st.losses);
    st.scoreRate = wilson(st.wins + 0.5 * st.draws, st.matches);
    if (!out.agents.some((a) => a.id === id)) out.agents.push({ id, label: e.labels[slot] });
  });
  let m = out.maps.find((x) => x.map === e.map);
  if (!m) {
    m = { map: e.map, matches: 0, winsByAgent: {}, draws: 0 };
    out.maps.push(m);
  }
  m.matches++;
  if (e.winner === null) m.draws++;
  else m.winsByAgent[e.agents[e.winner]] = (m.winsByAgent[e.agents[e.winner]] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------- labels

/** "Jev 1.13" -> "Jev", "Microsoft Decision 1" -> "Microsoft". */
export const shortName = (label: string) => label.trim().split(/\s+/)[0] || label;

