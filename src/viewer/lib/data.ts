// Match logs come from the API (`GET /api/matches/<id>/log`, contract: src/api/contract.ts), cached per page load.
import { useEffect, useState } from "react";
import { parseLog, type LogRec } from "../../runner/log.ts";
import { apiFetch } from "./api.ts";

const cache = new Map<string, Promise<LogRec[]>>();

export class NotFound extends Error {}

export const logPath = (matchId: string) => `/api/matches/${encodeURIComponent(matchId)}/log`;

/** A finished match's log, parsed. Rejects with NotFound when the pool has no finished match with this id. */
export function loadLog(matchId: string): Promise<LogRec[]> {
  let p = cache.get(matchId);
  if (!p) {
    p = apiFetch(logPath(matchId), { cache: "no-store" }).then(async (r) => {
      if (r.status === 404) throw new NotFound(`${matchId} not found`);
      if (!r.ok) throw new Error(`Match log: HTTP ${r.status}`);
      const text = await r.text();
      // A dev server without the Worker answers unknown paths with index.html.
      if (/^\s*<!doctype html/i.test(text)) throw new NotFound(`${matchId} not found`);
      return parseLog(text) as LogRec[];
    });
    p.catch(() => cache.delete(matchId));
    cache.set(matchId, p);
  }
  return p;
}

/** Seed the log cache (a live view already holds every record, so "watch again" needs no download). */
export function primeLog(matchId: string, recs: LogRec[]): void {
  cache.set(matchId, Promise.resolve(recs));
}

export type Async<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: Error };

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fn().then(
      (data) => live && setState({ status: "ready", data }),
      (error: Error) => live && setState({ status: "error", error }),
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
