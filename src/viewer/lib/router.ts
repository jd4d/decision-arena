// Minimal hash router.
//   #/                              match browser
//   #/match/<runId>/<matchId>?t=N   replay (N = tick)
//   #/results/<runId>               results page
import { useEffect, useState } from "react";

export type Route =
  | { page: "browser"; query: URLSearchParams }
  | { page: "match"; runId: string; matchId: string; t: number | null }
  | { page: "results"; runId: string | null };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [path, qs = ""] = raw.split("?");
  const query = new URLSearchParams(qs);
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "match" && parts[1] && parts[2]) {
    const t = query.get("t");
    return { page: "match", runId: parts[1], matchId: parts[2], t: t !== null && t !== "" && Number.isFinite(Number(t)) ? Number(t) : null };
  }
  if (parts[0] === "results") return { page: "results", runId: parts[1] ?? null };
  return { page: "browser", query };
}

export const matchHref = (runId: string, matchId: string, t?: number) =>
  `#/match/${encodeURIComponent(runId)}/${encodeURIComponent(matchId)}${t !== undefined ? `?t=${Math.round(t)}` : ""}`;
export const resultsHref = (runId?: string) => (runId ? `#/results/${encodeURIComponent(runId)}` : "#/results");

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
