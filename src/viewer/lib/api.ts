// Client for the Worker API (contract: src/api/contract.ts).
// In development only, a mock transport can stand in for the Worker (src/viewer/dev/mockApi.ts): it is used with
// `?mock=1`, or automatically when /api is unreachable. The mock is behind `import.meta.env.DEV`, so production
// builds drop it entirely and always talk to the real API.
import { useEffect, useState } from "react";
import type {
  ApiError, CommunitySummaryResponse, VersionsResponse, CreateMatchRequest, CreateMatchResponse, MatchIndexEntry, MatchListResponse, StatusResponse,
} from "../../api/contract.ts";

/** The subset of WebSocket the live view uses (the dev mock implements the same shape). */
export type SocketLike = {
  /** WebSocket semantics: 0 connecting, 1 open, 2 closing, 3 closed. */
  readonly readyState?: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  close(code?: number, reason?: string): void;
};

export type Transport = {
  kind: "real" | "mock";
  fetch(path: string, init?: RequestInit): Promise<Response>;
  socket(url: string): SocketLike;
};

const realTransport: Transport = {
  kind: "real",
  fetch: (path, init) => fetch(path, init),
  socket: (url) => {
    const u = new URL(url, location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(u) as unknown as SocketLike;
  },
};

let transportP: Promise<Transport> | null = null;

async function apiReachable(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch("/api/status", { signal: ctl.signal, cache: "no-store" });
    return r.ok && (r.headers.get("content-type") ?? "").includes("json");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function transport(): Promise<Transport> {
  if (!transportP) {
    transportP = (async () => {
      if (import.meta.env.DEV) {
        const flag = new URLSearchParams(location.search).get("mock");
        if (flag !== "0" && (flag !== null || !(await apiReachable()))) {
          const { createMockTransport } = await import("../dev/mockApi.ts");
          return createMockTransport();
        }
      }
      return realTransport;
    })();
  }
  return transportP;
}

/** Resolves to "mock" only in development builds with the mock active. */
export function useTransportKind(): Transport["kind"] | null {
  const [kind, setKind] = useState<Transport["kind"] | null>(null);
  useEffect(() => { transport().then((t) => setKind(t.kind)); }, []);
  return kind;
}

export const apiFetch = async (path: string, init?: RequestInit) => (await transport()).fetch(path, init);

export class ApiFailure extends Error {
  readonly code: ApiError["error"] | "network" | "not_found" | "http";
  readonly status: number;
  constructor(code: ApiFailure["code"], message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await apiFetch(path, { cache: "no-store", ...init });
  } catch (e) {
    throw new ApiFailure("network", `Can’t reach the arena (${(e as Error).message}).`);
  }
  const type = r.headers.get("content-type") ?? "";
  if (!r.ok) {
    if (type.includes("json")) {
      const body = (await r.json().catch(() => null)) as Partial<ApiError> | null;
      if (body?.error) throw new ApiFailure(body.error, body.message ?? body.error, r.status);
    }
    if (r.status === 404) throw new ApiFailure("not_found", "Not found", 404);
    throw new ApiFailure("http", `The arena answered HTTP ${r.status}.`, r.status);
  }
  if (!type.includes("json")) throw new ApiFailure("network", "The arena API isn’t available here.", r.status);
  return r.json() as Promise<T>;
}

export const getStatus = () => call<StatusResponse>("/api/status");

export const createMatch = (req: CreateMatchRequest) =>
  call<CreateMatchResponse>("/api/matches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });

export const listMatches = (cursor: string | null, limit = 50, version?: string) =>
  call<MatchListResponse>(`/api/matches?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${version ? `&version=${encodeURIComponent(version)}` : ""}`);

export const getMatchEntry = (id: string) => call<MatchIndexEntry>(`/api/matches/${encodeURIComponent(id)}`);

export const getCommunitySummary = (version?: string) =>
  call<CommunitySummaryResponse>(`/api/summary/community${version ? `?version=${encodeURIComponent(version)}` : ""}`);

export const getVersions = () => call<VersionsResponse>("/api/summary/versions");

/** Contract path of a match's live socket (used when the create response isn't at hand, e.g. a shared link). */
export const liveUrlFor = (id: string) => `/api/matches/${encodeURIComponent(id)}/live`;

export async function openLive(url: string): Promise<SocketLike> {
  return (await transport()).socket(url);
}

/** Close without noise: a socket still connecting is closed as soon as it opens (closing it earlier logs a browser warning). */
export function closeSocket(s: SocketLike, code = 1000, reason = ""): void {
  s.onmessage = null;
  s.onclose = null;
  s.onerror = null;
  if (s.readyState === 0) s.onopen = () => s.close(code, reason);
  else s.close(code, reason);
}

/** Load /api/status once when the page opens (no polling: it refreshes on reload or navigation). */
export function useStatus(): { status: StatusResponse | null; error: ApiFailure | null } {
  const [state, setState] = useState<{ status: StatusResponse | null; error: ApiFailure | null }>({ status: null, error: null });
  useEffect(() => {
    let live = true;
    getStatus()
      .then((s) => { if (live) setState({ status: s, error: null }); })
      .catch((e) => { if (live) setState((o) => ({ status: o.status, error: e as ApiFailure })); });
    return () => { live = false; };
  }, []);
  return state;
}
