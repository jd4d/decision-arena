// decisionarena.ai Worker: /api/* (contract: src/api/contract.ts). Everything else is Workers Static Assets
// (the Vite build, SPA fallback; curated benchmark data under /data/*).
import { DEFAULT_PUBLIC_CONDITION, PUBLIC_CONDITIONS, type ApiError, type CreateMatchRequest, type CreateMatchResponse, type PublicCondition } from "../src/api/contract.ts";
import { MODELS } from "../src/agents/models.ts";
import { MAP_IDS } from "../src/sim/maps.ts";
import { decodeCursor, emptyCommunitySummary, getEntry, listMatches, readSummary } from "./db.ts";
import { lobbyStub, logKey, MATCH_ID_RE, roomStub, type Env, type RoomSpec } from "./env.ts";

export { Lobby } from "./lobby.ts";
export { MatchRoom } from "./match-room.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const fail = (status: number, error: ApiError["error"], message: string) => json({ error, message } satisfies ApiError, status);

const randomU32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
/** Time-ordered, URL-safe match id: base36 ms timestamp + 8 random base36 chars. */
const newMatchId = () => Date.now().toString(36) + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("");

async function createMatch(req: Request, env: Env): Promise<Response> {
  if (!(req.headers.get("Content-Type") ?? "").toLowerCase().includes("application/json")) return fail(415, "bad_request", "Send JSON (Content-Type: application/json).");
  const text = await req.text();
  if (text.length > 1024) return fail(413, "bad_request", "Request body too large.");
  let body: Partial<CreateMatchRequest>;
  try { body = JSON.parse(text); } catch { return fail(400, "bad_request", "Body is not valid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_request", "Body must be a JSON object.");
  const { map } = body;
  const condition = body.condition ?? DEFAULT_PUBLIC_CONDITION;
  if (typeof map !== "string" || (map !== "random" && !MAP_IDS.includes(map))) return fail(400, "bad_request", `map must be "random" or one of: ${MAP_IDS.join(", ")}.`);
  if (typeof condition !== "string" || !Object.hasOwn(PUBLIC_CONDITIONS, condition)) return fail(400, "bad_request", `condition must be one of: ${Object.keys(PUBLIC_CONDITIONS).join(", ")}.`);

  const keys = Object.keys(MODELS);
  const order = (randomU32() & 1 ? [keys[0], keys[1]] : [keys[1], keys[0]]) as [string, string];
  const spec: RoomSpec = {
    matchId: newMatchId(),
    map: map === "random" ? MAP_IDS[randomU32() % MAP_IDS.length] : map,
    seed: randomU32(),
    condition: condition as PublicCondition,
    order,
    createdAt: Date.now(),
  };
  const r = await lobbyStub(env).admit(spec);
  if (!r.ok) return fail(503, r.error, r.message);
  return json({ matchId: spec.matchId, liveUrl: `/api/matches/${spec.matchId}/live`, queuePosition: r.position } satisfies CreateMatchResponse, 201);
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(2); // after "/api"
  const method = req.method;
  const only = (m: string) => (method === m || (m === "GET" && method === "HEAD") ? null : fail(405, "bad_request", `Use ${m}.`));

  if (parts[0] === "status" && parts.length === 1) return only("GET") ?? json(await lobbyStub(env).status());

  if (parts[0] === "summary" && parts[1] === "community" && parts.length === 2) {
    const bad = only("GET");
    if (bad) return bad;
    let s = await readSummary(env.DB);
    if (!s) {
      await lobbyStub(env).refreshSummary();
      s = (await readSummary(env.DB)) ?? emptyCommunitySummary(new Date().toISOString());
    }
    return json(s); // no-store: it changes whenever a match finishes
  }

  if (parts[0] === "matches") {
    if (parts.length === 1) {
      if (method === "POST") return createMatch(req, env);
      const bad = only("GET");
      if (bad) return bad;
      const lim = url.searchParams.get("limit");
      const limit = lim === null ? 50 : Number(lim);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, "bad_request", "limit must be an integer from 1 to 100.");
      const c = url.searchParams.get("cursor");
      const cursor = c ? decodeCursor(c) : null;
      if (c && !cursor) return fail(400, "bad_request", "Invalid cursor.");
      return json(await listMatches(env.DB, limit, cursor));
    }
    const id = parts[1];
    if (!MATCH_ID_RE.test(id)) return fail(404, "bad_request", "Unknown match.");
    if (parts.length === 2) {
      const bad = only("GET");
      if (bad) return bad;
      const e = await getEntry(env.DB, id);
      return e ? json(e, 200, { "Cache-Control": "public, max-age=3600" }) : fail(404, "bad_request", "Unknown or unfinished match.");
    }
    if (parts.length === 3 && parts[2] === "log") {
      const bad = only("GET");
      if (bad) return bad;
      if (!(await getEntry(env.DB, id))) return fail(404, "bad_request", "Unknown or unfinished match.");
      const obj = await env.LOGS.get(logKey(id));
      if (!obj) return fail(404, "bad_request", "Log not found.");
      return new Response(method === "HEAD" ? null : obj.body, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable", ETag: obj.httpEtag },
      });
    }
    if (parts.length === 3 && parts[2] === "live") {
      if (method !== "GET") return fail(405, "bad_request", "Use GET with a WebSocket upgrade.");
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail(426, "bad_request", "Expected a WebSocket upgrade.");
      return roomStub(env, id).fetch(req);
    }
  }
  return fail(404, "bad_request", "No such API route.");
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await route(req, env);
      } catch (e) {
        console.error("api error", url.pathname, (e as Error).stack ?? e);
        return fail(500, "internal", "Something went wrong on our side.");
      }
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
