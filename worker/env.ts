import type { Lobby } from "./lobby.ts";
import type { MatchRoom } from "./match-room.ts";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  LOGS: R2Bucket;
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
  LOBBY: DurableObjectNamespace<Lobby>;
  OPENROUTER_API_KEY?: string; // secret
  MAX_CONCURRENT?: string;
  MAX_QUEUE?: string;
  BUDGET_USD?: string;
  NOINDEX?: string; // "1" on staging: noindex header + disallow-all robots.txt
}

/** Every match room runs in the same region so all matches call OpenRouter from the same place (fairness). */
export const ROOM_LOCATION: DurableObjectLocationHint = "enam";

export const roomStub = (env: Env, matchId: string) => env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(matchId), { locationHint: ROOM_LOCATION });
export const lobbyStub = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName("lobby"), { locationHint: ROOM_LOCATION });

export const numVar = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : dflt;
};

/** Per-match safety cap (USD): a runaway match aborts. Normal matches cost ~$0.003. */
export const MATCH_CAP_USD = 0.05;
export const logKey = (matchId: string) => `community/${matchId}.jsonl`;
export const MATCH_ID_RE = /^[a-z0-9]{8,32}$/;

/** Match spec chosen at creation time (server-side randomness). */
export type RoomSpec = {
  matchId: string;
  map: string;
  seed: number;
  condition: string; // PublicCondition
  order: [string, string]; // model keys by slot
  createdAt: number;
  decoder?: string; // PublicDecoder; missing on specs stored before answer methods existed = the default
};
