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
    // Last, so the Worker's stored entry (rowToEntry: ..., highlights, version, origin) serializes identically.
    version: `${h.sim}:${h.protocol}`,
  };
}

// ---------- Digests ----------
//
// Every run summary is built from per-match digests: a small JSON per match holding the counts and sums needed for
// RunSummary. The Node CLI (summarizeRun) and the Worker (community summary, digests stored in D1) share this one code
// path: digestMatch -> addDigest (fold into a SummaryAcc) -> finalizeSummary. The accumulator is plain JSON, so it can
// be cached and extended incrementally as matches finish.
//
// Latency percentiles (latencyMs.p50/p90, effLatencyMs.p50) are histogram-derived: nearest-rank over 25 ms bins
// (HIST_BIN_MS), linearly interpolated inside the bin and clamped to the observed min/max, rounded to whole ms. They
// are accurate to about one bin (25 ms) and exact when all values are equal (e.g. fixed 250 ms). Means are exact.

/** Latency histogram with exact count/sum/min/max. `counts[i]` covers [i*25, (i+1)*25) ms; the last bin (index
 * HIST_CAP_MS/HIST_BIN_MS) holds everything >= HIST_CAP_MS. Trailing zero bins are omitted. */
export type Hist = { counts: number[]; n: number; sum: number; min: number; max: number };
const HIST_LAST = HIST_CAP_MS / HIST_BIN_MS;

export type SlotDigest = {
  agent: { id: string; label: string; model?: string };
  // From the result stats (as reported by the engine).
  decisions: number;
  errors: number;
  fizzles: number;
  damageTaken: number;
  cost: number;
  firstHitTick: number | null;
  // From events and decisions.
  shots: number;
  hits: number;
  selfHits: number;
  real: Hist; // real latency of non-error decisions
  eff: Hist; // effective (game-time) latency of non-error decisions
  drive: Record<string, number>; // decisions with an action, per drive command
  fireN: number[]; // shots per FIRE_BINS bin (shots whose deciding decision had detail)
  fireHit: number[]; // of which hit the enemy
};

export type MatchDigest = {
  v: 1;
  runId: string;
  matchId: string;
  condition: string;
  map: string;
  sim: string;
  protocol: string;
  tickHz: number;
  ticks: number;
  winner: 0 | 1 | null;
  slots: [SlotDigest, SlotDigest];
};

type AgentAcc = {
  matches: number; wins: number; losses: number; draws: number;
  decisions: number; errors: number; shots: number; hits: number; selfHits: number; fizzles: number; damageTaken: number;
  cost: number; seconds: number; firstHitSum: number; firstHitN: number;
  real: Hist; eff: Hist; drive: Record<string, number>; fireN: number[]; fireHit: number[];
};

/** Mergeable run accumulator (plain JSON). */
export type SummaryAcc = {
  v: 1;
  matches: number;
  sim: string;
  protocol: string;
  totalCostUsd: number;
  agents: { id: string; label: string; model?: string }[]; // first-appearance order
  conditions: Record<string, { matches: number; draws: number; byAgent: Record<string, AgentAcc> }>;
  maps: Record<string, { matches: number; draws: number; wins: Record<string, number> }>;
};

export const emptyHist = (): Hist => ({ counts: [], n: 0, sum: 0, min: 0, max: 0 });

function histAdd(h: Hist, ms: number): void {
  const i = Math.min(HIST_LAST, Math.max(0, Math.floor(ms / HIST_BIN_MS)));
  while (h.counts.length <= i) h.counts.push(0);
  h.counts[i]++;
  h.min = h.n ? Math.min(h.min, ms) : ms;
  h.max = h.n ? Math.max(h.max, ms) : ms;
  h.n++;
  h.sum += ms;
}

function histMerge(into: Hist, h: Hist): void {
  if (!h.n) return;
  while (into.counts.length < h.counts.length) into.counts.push(0);
  h.counts.forEach((c, i) => (into.counts[i] += c));
  into.min = into.n ? Math.min(into.min, h.min) : h.min;
  into.max = into.n ? Math.max(into.max, h.max) : h.max;
  into.n += h.n;
  into.sum += h.sum;
}

/** Histogram-derived percentile (see the note above). Same nearest-rank rule as percentile(). */
export function histPercentile(h: Hist, q: number): number {
  if (!h.n) return 0;
  const r = Math.min(h.n, Math.max(1, Math.ceil(q * h.n)));
  let cum = 0;
  for (let i = 0; i < h.counts.length; i++) {
    const c = h.counts[i];
    if (!c) continue;
    if (cum + c >= r) {
      const lo = i * HIST_BIN_MS;
      const hi = i >= HIST_LAST ? Math.max(lo, h.max) : lo + HIST_BIN_MS;
      const v = lo + (hi - lo) * ((r - cum - 0.5) / c);
      return Math.round(Math.min(h.max, Math.max(h.min, v)));
    }
    cum += c;
  }
  return h.max;
}

/** Full-length (HIST_LAST + 1) bin counts for the viewer. */
const denseCounts = (h: Hist) => Array.from({ length: HIST_LAST + 1 }, (_, i) => h.counts[i] ?? 0);

/** Digest one complete match. */
export function digestMatch(m: Match): MatchDigest {
  const h = m.header;
  const shots = fireShots(m);
  const slot = (s: 0 | 1): SlotDigest => {
    const a = h.agents.find((x) => x.slot === s) ?? h.agents[s];
    const st = m.result.stats[s];
    const d: SlotDigest = {
      agent: { id: a.id, label: a.label, ...(a.model ? { model: a.model } : {}) },
      decisions: st.decisions, errors: st.errors, fizzles: st.fizzles, damageTaken: st.damageTaken, cost: st.cost,
      firstHitTick: st.firstHitTick ?? null,
      shots: 0, hits: 0, selfHits: 0,
      real: emptyHist(), eff: emptyHist(), drive: {},
      fireN: FIRE_BINS.map(() => 0), fireHit: FIRE_BINS.map(() => 0),
    };
    for (const e of m.events) {
      if (e.type === "fire" && e.slot === s) d.shots++;
      else if (isHit(e) && e.owner === s) {
        if (e.self) d.selfHits++;
        else d.hits++;
      }
    }
    for (const x of m.decisions) {
      if (x.slot !== s) continue;
      if (!x.error) {
        histAdd(d.real, x.realMs);
        histAdd(d.eff, x.effMs);
      }
      if (x.action) d.drive[x.action.drive] = (d.drive[x.action.drive] ?? 0) + 1;
    }
    for (const x of shots) {
      if (x.slot !== s) continue;
      const i = FIRE_BINS.indexOf(fireBin(x.fireP) as (typeof FIRE_BINS)[number]);
      d.fireN[i]++;
      if (x.hit) d.fireHit[i]++;
    }
    return d;
  };
  return {
    v: 1, runId: h.runId, matchId: h.matchId, condition: h.condition, map: h.map, sim: h.sim, protocol: h.protocol,
    tickHz: h.tickHz || 30, ticks: m.result.ticks, winner: m.result.winner, slots: [slot(0), slot(1)],
  };
}

export const emptyAcc = (): SummaryAcc => ({ v: 1, matches: 0, sim: "", protocol: "", totalCostUsd: 0, agents: [], conditions: {}, maps: {} });

const emptyAgentAcc = (): AgentAcc => ({
  matches: 0, wins: 0, losses: 0, draws: 0, decisions: 0, errors: 0, shots: 0, hits: 0, selfHits: 0, fizzles: 0, damageTaken: 0,
  cost: 0, seconds: 0, firstHitSum: 0, firstHitN: 0, real: emptyHist(), eff: emptyHist(), drive: {},
  fireN: FIRE_BINS.map(() => 0), fireHit: FIRE_BINS.map(() => 0),
});

/** The slot an agent id plays in a digest (first slot if it plays both, matching the original per-agent stats). */
const slotOf = (d: MatchDigest, id: string): 0 | 1 | undefined => (d.slots[0].agent.id === id ? 0 : d.slots[1].agent.id === id ? 1 : undefined);

function addToAgent(a: AgentAcc, d: MatchDigest, slot: 0 | 1): void {
  const s = d.slots[slot];
  a.matches++;
  if (d.winner === null) a.draws++;
  else if (d.winner === slot) a.wins++;
  else a.losses++;
  a.seconds += d.ticks / (d.tickHz || 30);
  a.decisions += s.decisions;
  a.errors += s.errors;
  a.fizzles += s.fizzles;
  a.damageTaken += s.damageTaken;
  a.cost += s.cost;
  a.shots += s.shots;
  a.hits += s.hits;
  a.selfHits += s.selfHits;
  if (s.firstHitTick !== null && s.firstHitTick !== undefined) {
    a.firstHitSum += s.firstHitTick / (d.tickHz || 30);
    a.firstHitN++;
  }
  histMerge(a.real, s.real);
  histMerge(a.eff, s.eff);
  for (const [k, v] of Object.entries(s.drive)) a.drive[k] = (a.drive[k] ?? 0) + v;
  s.fireN.forEach((n, i) => (a.fireN[i] += n));
  s.fireHit.forEach((n, i) => (a.fireHit[i] += n));
}

/** Fold one digest into an accumulator (mutates and returns it). */
export function addDigest(acc: SummaryAcc, d: MatchDigest): SummaryAcc {
  acc.matches++;
  acc.sim = d.sim;
  acc.protocol = d.protocol;
  acc.totalCostUsd += d.slots[0].cost + d.slots[1].cost;
  for (const s of d.slots) if (!acc.agents.some((a) => a.id === s.agent.id)) acc.agents.push({ ...s.agent });
  const c = (acc.conditions[d.condition] ??= { matches: 0, draws: 0, byAgent: {} });
  c.matches++;
  if (d.winner === null) c.draws++;
  const ids = [...new Set(d.slots.map((s) => s.agent.id))];
  for (const id of ids) addToAgent((c.byAgent[id] ??= emptyAgentAcc()), d, slotOf(d, id)!);
  const mp = (acc.maps[d.map] ??= { matches: 0, draws: 0, wins: {} });
  mp.matches++;
  if (d.winner === null) mp.draws++;
  else {
    const id = d.slots[d.winner].agent.id;
    mp.wins[id] = (mp.wins[id] ?? 0) + 1;
  }
  return acc;
}

function finalizeAgent(a: AgentAcc): AgentConditionStats {
  const driveTotal = Object.values(a.drive).reduce((x, y) => x + y, 0);
  const driveMix: Record<string, number> = {};
  for (const [k, v] of Object.entries(a.drive)) driveMix[k] = v / driveTotal;
  return {
    matches: a.matches, wins: a.wins, losses: a.losses, draws: a.draws,
    winRate: wilson(a.wins, a.wins + a.losses),
    scoreRate: wilson(a.wins + 0.5 * a.draws, a.matches),
    decisions: a.decisions,
    decisionsPerS: a.seconds ? a.decisions / a.seconds : 0,
    latencyMs: { p50: histPercentile(a.real, 0.5), p90: histPercentile(a.real, 0.9), mean: a.real.n ? a.real.sum / a.real.n : 0 },
    effLatencyMs: { p50: histPercentile(a.eff, 0.5), mean: a.eff.n ? a.eff.sum / a.eff.n : 0 },
    errors: a.errors,
    errorRate: a.decisions ? a.errors / a.decisions : 0,
    shots: a.shots, hits: a.hits,
    accuracy: a.shots ? a.hits / a.shots : 0,
    selfHits: a.selfHits, fizzles: a.fizzles, damageTaken: a.damageTaken,
    costPerMatch: a.matches ? a.cost / a.matches : 0,
    costPerDecision: a.decisions ? a.cost / a.decisions : 0,
    meanFirstHitS: a.firstHitN ? a.firstHitSum / a.firstHitN : null,
    driveMix,
    fireCalibration: FIRE_BINS.map((bin, i) => ({ bin, n: a.fireN[i], hitRate: a.fireN[i] ? a.fireHit[i] / a.fireN[i] : 0 })),
  };
}

/** Turn an accumulator into the viewer's RunSummary. */
export function finalizeSummary(runId: string, acc: SummaryAcc, generatedAt: string): RunSummary {
  const conditions = Object.keys(acc.conditions).sort().map((condition) => {
    const c = acc.conditions[condition];
    const byAgent: Record<string, AgentConditionStats> = {};
    for (const { id } of acc.agents) if (c.byAgent[id]) byAgent[id] = finalizeAgent(c.byAgent[id]);
    return { condition, matches: c.matches, draws: c.draws, byAgent };
  });
  const maps = Object.keys(acc.maps).sort().map((map) => {
    const m = acc.maps[map];
    const winsByAgent: Record<string, number> = {};
    for (const { id } of acc.agents) winsByAgent[id] = m.wins[id] ?? 0;
    return { map, matches: m.matches, winsByAgent, draws: m.draws };
  });
  const latencyHistogram: RunSummary["latencyHistogram"] = {};
  for (const { id } of acc.agents) {
    const h = emptyHist();
    for (const c of Object.values(acc.conditions)) if (c.byAgent[id]) histMerge(h, c.byAgent[id].real);
    latencyHistogram[id] = { binMs: HIST_BIN_MS, counts: denseCounts(h) };
  }
  return {
    runId, generatedAt, sim: acc.sim, protocol: acc.protocol, agents: acc.agents.map((a) => ({ ...a })),
    totalCostUsd: acc.totalCostUsd, conditions, maps, latencyHistogram,
  };
}

/** Merge per-match digests into a RunSummary. */
export function mergeDigests(runId: string, digests: Iterable<MatchDigest>, generatedAt: string): RunSummary {
  const acc = emptyAcc();
  for (const d of digests) addDigest(acc, d);
  return finalizeSummary(runId, acc, generatedAt);
}

/** Per-agent stats for one condition, aggregated by agent id across slots. */
export function agentConditionStats(matches: Match[], agentId: string): AgentConditionStats {
  const a = emptyAgentAcc();
  for (const m of matches) {
    const d = digestMatch(m);
    const slot = slotOf(d, agentId);
    if (slot !== undefined) addToAgent(a, d, slot);
  }
  return finalizeAgent(a);
}

export function latencyHistogram(matches: Match[], agentId: string): { binMs: number; counts: number[] } {
  const h = emptyHist();
  for (const m of matches) {
    const d = digestMatch(m);
    const slot = slotOf(d, agentId);
    if (slot !== undefined) histMerge(h, d.slots[slot].real);
  }
  return { binMs: HIST_BIN_MS, counts: denseCounts(h) };
}

export function summarizeRun(runId: string, matches: Match[], generatedAt: string): RunSummary {
  return mergeDigests(runId, matches.map(digestMatch), generatedAt);
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
