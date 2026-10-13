// HTTP/WebSocket contract between the Cloudflare Worker (worker/) and the viewer (src/viewer/).
// Both sides import these types. Changing a shape means updating both sides in the same change.
import type { DataIndex, MatchIndexEntry, RunSummary } from "../analysis/schema.ts";
import type { HeaderRec, LogRec, ResultRec } from "../runner/log.ts";

/**
 * Latency rules a visitor may pick (default: real latency, preselected so a casual visitor never has to choose).
 * Two rules: real latency (the arena as intended) and equal latency (speed removed, so only decisions differ).
 * Imported benchmark matches and community matches form one pool.
 * Sides and seed are always randomized server-side.
 */
export const PUBLIC_CONDITIONS = {
  "scaled-1": { latency: "scaled:1", label: "Real latency", blurb: "Each model's actual response time. The game keeps running while it thinks." },
  "fixed-250": { latency: "fixed:250", label: "Equal latency (250 ms)", blurb: "Both models get exactly 250 ms per decision, so speed doesn't matter: only the choices do." },
} as const;
export const DEFAULT_PUBLIC_CONDITION = "scaled-1" satisfies keyof typeof PUBLIC_CONDITIONS;
export type PublicCondition = keyof typeof PUBLIC_CONDITIONS;

/**
 * Answer methods (p2 decoders) a visitor may pick: how a model's probabilities become its tank's action. Keys match
 * DECODERS in src/protocol/v2.ts (a test checks this); each is logged and summarized as its own version ("p2-<key>").
 */
export const PUBLIC_DECODERS = {
  draw: { label: "Weighted draw", blurb: "Each action is drawn from the model's probabilities: an option given 70% happens 70% of the time. Hedging costs." },
  scaled: { label: "Confidence-scaled", blurb: "The model's top option, scaled by its confidence: 60% sure drives at 60% speed. Hedging plays timidly." },
} as const;
export const DEFAULT_PUBLIC_DECODER = "draw" satisfies keyof typeof PUBLIC_DECODERS;
export type PublicDecoder = keyof typeof PUBLIC_DECODERS;

/** All matches (imported benchmark seed + community) live in one pool under this runId. */
export const COMMUNITY_RUN_ID = "community";

// POST /api/matches
export type CreateMatchRequest = { map: string | "random"; condition?: PublicCondition; decoder?: PublicDecoder };
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
// GET /api/summary/community[?version=<sim>:<protocol>] -> RunSummary over all finished community matches of that
//                                                         version (default: the current one). Versions are never merged.
export type CommunitySummaryResponse = RunSummary;
// GET /api/summary/versions     -> every version with results, newest first, and which one is current
export type SummaryVersion = { id: string; sim: string; protocol: string; matches: number };
export type VersionsResponse = { current: string; versions: SummaryVersion[] };

// One pool: every match (imported benchmark seed matches with origin "t1-local", and site matches with origin "web")
// is listed by /api/matches and summarized by /api/summary/community. MatchIndexEntry.file is "/api/matches/<id>/log".
// The static /data/ export is no longer used by the site.
export type { DataIndex, MatchIndexEntry, RunSummary };
