// The p2 results, one summary per answer method (version "<sim>:p2-<decoder>"). Versions are never merged into one
// summary; pages that show "all p2 matches" pool the per-agent records here instead.
import { PUBLIC_DECODERS, type PublicDecoder } from "../../api/contract.ts";
import type { RunSummary } from "../../analysis/schema.ts";
import { CURRENT_PROTOCOL } from "../../protocol/v2.ts";
import { SIM_VERSION } from "../../sim/tuning.ts";
import { getCommunitySummary, getVersions } from "./api.ts";
import { versionLabel } from "./format.ts";
import { agentRecord, totalMatches, wilson } from "./summary.ts";

export type VersionPool = { id: string; label: string; s: RunSummary };

/** Every current-sim p2 version with results (one per answer method), with its summary. Falls back to the live one. */
export async function p2Pools(): Promise<VersionPool[]> {
  const v = await getVersions().catch(() => null);
  const ids = (v?.versions ?? []).filter((x) => x.sim === SIM_VERSION && x.protocol.startsWith("p2-")).map((x) => x.id);
  const order = (id: string) => { const k = Object.keys(PUBLIC_DECODERS).indexOf(id.split(":")[1].slice(3)); return k < 0 ? 99 : k; };
  const want = ids.length ? ids.sort((x, y) => order(x) - order(y)) : [`${SIM_VERSION}:${CURRENT_PROTOCOL}`];
  const out = await Promise.all(want.map(async (id): Promise<VersionPool | null> => {
    const s = await getCommunitySummary(id).catch(() => null);
    const key = id.split(":")[1].slice(3) as PublicDecoder;
    return s ? { id, label: (PUBLIC_DECODERS[key]?.label as string | undefined) ?? versionLabel(id), s } : null;
  }));
  return out.filter((x): x is VersionPool => !!x && totalMatches(x.s) > 0);
}

/** The p1 results (first methodology, read-only history), if the pool has any. */
export async function p1Pool(): Promise<VersionPool | null> {
  const v = await getVersions().catch(() => null);
  const id = (v?.versions ?? []).find((x) => x.protocol === "p1")?.id;
  if (!id) return null;
  const s = await getCommunitySummary(id).catch(() => null);
  return s && totalMatches(s) > 0 ? { id, label: "Original rules", s } : null;
}

/** One agent's record pooled across several versions (wins ÷ decisive matches; median latency weighted by matches). */
export function pooledRecord(pools: VersionPool[], agentId: string, condition?: string) {
  const rs = pools.map((p) => agentRecord(p.s, agentId, condition));
  const wins = rs.reduce((t, r) => t + r.wins, 0), losses = rs.reduce((t, r) => t + r.losses, 0), draws = rs.reduce((t, r) => t + r.draws, 0);
  const m = rs.filter((r) => Number.isFinite(r.p50) && r.matches > 0);
  const p50 = m.length ? m.reduce((t, r) => t + r.p50 * r.matches, 0) / m.reduce((t, r) => t + r.matches, 0) : NaN;
  return { wins, losses, draws, p50, winRate: wins + losses > 0 ? wilson(wins, wins + losses) : null };
}

