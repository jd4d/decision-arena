// HTTP/WebSocket contract between the Cloudflare Worker (worker/) and the viewer (src/viewer/).
// Both sides import these types. Changing a shape means updating both sides in the same change.
import type { DataIndex, MatchIndexEntry, RunSummary } from "../analysis/schema.ts";
import type { HeaderRec, LogRec, ResultRec } from "../runner/log.ts";

/**
 * Latency rules a visitor may pick (default: real latency, preselected so a casual visitor never has to choose).
 * These are the same six conditions as benchmark t1, so imported benchmark matches and community matches form one pool.
 * Sides and seed are always randomized server-side.
 * - "swap:<f>" = each model plays with the OTHER model's real latency distribution (sampled from the pool's recorded
 *   latency histograms), isolating speed from decision quality.
 */
export const PUBLIC_CONDITIONS = {
  "scaled-1": { latency: "scaled:1", label: "Real latency", blurb: "Each model's actual response time. The game keeps running while it thinks." },
  "fixed-250": { latency: "fixed:250", label: "Equal latency (250 ms)", blurb: "Both models get exactly 250 ms per decision, so speed doesn't matter: only the choices do." },
  "swap-1": { latency: "swap:1", label: "Swapped latency", blurb: "Each model plays at the other model's speed. Fast thinker, slow reflexes, and vice versa." },
  "scaled-0.5": { latency: "scaled:0.5", label: "Slow game (×0.5)", blurb: "Response time counts half as much, so there's more time to react." },
  "scaled-2": { latency: "scaled:2", label: "Fast game (×2)", blurb: "Response time counts double, so speed matters more." },
  "scaled-4": { latency: "scaled:4", label: "Frantic game (×4)", blurb: "Response time counts four times. Mostly chaos and draws." },
} as const;
export const DEFAULT_PUBLIC_CONDITION = "scaled-1" satisfies keyof typeof PUBLIC_CONDITIONS;
export type PublicCondition = keyof typeof PUBLIC_CONDITIONS;

/** All matches (imported benchmark seed + community) live in one pool under this runId. */
export const COMMUNITY_RUN_ID = "community";

// POST /api/matches
export type CreateMatchRequest = { map: string | "random"; condition?: PublicCondition };
export type CreateMatchResponse = { matchId: string; liveUrl: string; queuePosition: number };
export type ApiError = { error: "budget_exhausted" | "bad_request" | "busy" | "internal"; message: string };

// GET /api/status
export type StatusResponse = {
  acceptingMatches: boolean;
  liveMatches: number;
  queued: number;
  maxConcurrent: number;
  communityMatches: number;
  spentUsd: number; // community spend recorded in D1
  creditRemainingUsd: number | null; // from OpenRouter /api/v1/key limit_remaining, if available
};

// GET /api/matches/:id/live  (WebSocket upgrade). Server -> client messages, JSON text frames.
// A client joining late first receives the full backlog (header + all records so far) as one "batch".
export type LiveMessage =
  | { type: "queued"; position: number }
  | { type: "header"; header: HeaderRec }
  | {
      type: "batch";
      recs: LogRec[]; // decision/event/check records, in emission order
      tick: number; // engine has simulated through this tick: every decision applying at <= tick is already sent
      inflight: [{ issueTick: number } | null, { issueTick: number } | null]; // pending decision per slot (for ping meters/ghosts)
    }
  | { type: "done"; result: ResultRec; entry: MatchIndexEntry }
  | { type: "error"; message: string };

// GET /api/matches?limit=50&cursor=<opaque>  -> community matches, newest first
export type MatchListResponse = { matches: MatchIndexEntry[]; nextCursor: string | null };

// GET /api/matches/:id          -> MatchIndexEntry (404 if unknown or still running)
// GET /api/matches/:id/log      -> match log JSONL (text/plain), finished matches only
// GET /api/summary/community    -> RunSummary aggregated over all finished community matches
export type CommunitySummaryResponse = RunSummary;

// One pool: every match (imported benchmark seed matches with origin "t1-local", and site matches with origin "web")
// is listed by /api/matches and summarized by /api/summary/community. MatchIndexEntry.file is "/api/matches/<id>/log".
// The static /data/ export is no longer used by the site.
export type { DataIndex, MatchIndexEntry, RunSummary };
