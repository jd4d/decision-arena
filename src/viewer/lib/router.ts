// Minimal hash router. Every match lives in one pool (src/api/contract.ts), so there are no per-run pages.
//   #/                              home
//   #/run                           start a match
//   #/live/<matchId>                live match
//   #/matches                       match browser
//   #/match/<runId>/<matchId>?t=N   replay (N = tick); runId is the pool id ("community") in every current link
//   #/results                       results (older "#/results/<runId>" links land here too)
//   #/methodology[/<section>]       how it works
import { useEffect, useState } from "react";
import { COMMUNITY_RUN_ID } from "../../api/contract.ts";

export type Route =
  | { page: "home" }
  | { page: "run" }
  | { page: "live"; matchId: string }
  | { page: "matches" }
  | { page: "match"; runId: string; matchId: string; t: number | null }
  | { page: "results" }
  | { page: "methodology"; section: string | null };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [path, qs = ""] = raw.split("?");
  const query = new URLSearchParams(qs);
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "match" && parts[1] && parts[2]) {
    const t = query.get("t");
    return { page: "match", runId: parts[1], matchId: parts[2], t: t !== null && t !== "" && Number.isFinite(Number(t)) ? Number(t) : null };
  }
  if (parts[0] === "live" && parts[1]) return { page: "live", matchId: parts[1] };
  if (parts[0] === "run") return { page: "run" };
  if (parts[0] === "matches") return { page: "matches" };
  if (parts[0] === "results") return { page: "results" };
  if (parts[0] === "methodology") return { page: "methodology", section: parts[1] ?? null };
  return { page: "home" };
}

export const matchHref = (runId: string, matchId: string, t?: number) =>
  `#/match/${encodeURIComponent(runId)}/${encodeURIComponent(matchId)}${t !== undefined ? `?t=${Math.round(t)}` : ""}`;
/** Replay link for a match in the pool. */
export const poolMatchHref = (matchId: string) => matchHref(COMMUNITY_RUN_ID, matchId);
export const liveHref = (matchId: string) => `#/live/${encodeURIComponent(matchId)}`;
export const RESULTS_HREF = "#/results";
export const MATCHES_HREF = "#/matches";

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Update the URL without adding history or triggering a route change. */
export function replaceHash(hash: string): void {
  if (location.hash === hash) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
}
