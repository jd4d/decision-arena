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

// ---------------------------------------------------------------- the pool's story in a sentence

/** "Jev 1.13" -> "Jev", "Microsoft Decision 1" -> "Microsoft". */
export const shortName = (label: string) => label.trim().split(/\s+/)[0] || label;

/** Median-latency gap (ms) below which neither model is called faster. */
const SPEED_GAP_MS = 20;

export type Lead = { id: string; label: string; rate: Interval; clear: boolean };

/** The agent that wins more than half of the decisive matches (null if none, or no decisive matches). `clear` means
 *  the 95% interval excludes 50%. */
export function leader(s: RunSummary | null | undefined, agents: { id: string; label: string }[], condition?: string): Lead | null {
  for (const a of agents) {
    const r = agentRecord(s, a.id, condition).winRate;
    if (r && r.p > 0.5) return { id: a.id, label: a.label, rate: r, clear: r.lo > 0.5 };
  }
  return null;
}

export type PoolStory = {
  /** The equal-latency control condition in the pool, if any (e.g. "fixed-250"). */
  control: string | null;
  /** Who wins with latency equalised: the better decision maker. */
  decisions: Lead | null;
  /** Who wins at real latency. */
  real: Lead | null;
  /** Median real response time per agent (real latency, else every condition). */
  p50: Record<string, number>;
  faster: { id: string; label: string; gapMs: number } | null;
  /** E.g. "Microsoft makes better decisions; Jev reacts faster" (null when the pool has no data). */
  tagline: string | null;
};

/** What the pool says, computed from its summary: decision quality from the equal-latency control, speed from the
 *  measured medians, and the real-latency result. */
export function poolStory(s: RunSummary | null | undefined, agents: { id: string; label: string }[]): PoolStory {
  const conds = (s?.conditions ?? []).filter((c) => c.matches > 0).map((c) => c.condition);
  const control = conds.includes("fixed-250") ? "fixed-250" : conds.find((c) => c.startsWith("fixed-")) ?? null;
  const decisions = control ? leader(s, agents, control) : null;
  const real = conds.includes("scaled-1") ? leader(s, agents, "scaled-1") : null;
  const p50: Record<string, number> = {};
  for (const a of agents) {
    const atReal = agentRecord(s, a.id, "scaled-1").p50;
    p50[a.id] = Number.isFinite(atReal) ? atReal : agentRecord(s, a.id).p50;
  }
  let faster: PoolStory["faster"] = null;
  if (agents.length === 2 && agents.every((a) => Number.isFinite(p50[a.id]))) {
    const [x, y] = [...agents].sort((a, b) => p50[a.id] - p50[b.id]);
    const gapMs = p50[y.id] - p50[x.id];
    if (gapMs >= SPEED_GAP_MS) faster = { id: x.id, label: x.label, gapMs };
  }
  const parts: string[] = [];
  if (control) parts.push(decisions?.clear ? `${shortName(decisions.label)} makes better decisions` : "decisions are too close to call");
  if (agents.some((a) => Number.isFinite(p50[a.id]))) {
    if (faster && decisions?.clear && faster.id === decisions.id) parts[0] += " and reacts faster";
    else parts.push(faster ? `${shortName(faster.label)} reacts faster` : "both react about as fast");
  }
  const tagline = conds.length && parts.length ? parts.join("; ").replace(/^./, (c) => c.toUpperCase()) : null;
  return { control, decisions, real, p50, faster, tagline };
}
