// Decision-model agent over OpenRouter's /api/alpha/decisions with a shared keep-alive pool.
import https from "node:https";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Observation } from "../sim/observe.ts";
import type { Agent, DecisionResult } from "./types.ts";
import { DECISION_TIMEOUT_MS, decisionBody, httpError, MODELS, toDecisionResult, warmupBody, type ModelKey, type RawResponse } from "./models.ts";

export { MODELS, type ModelKey };

let cachedKey: string | undefined;
function apiKey(): string {
  if (cachedKey) return cachedKey;
  cachedKey = process.env.OPENROUTER_API_KEY || JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"))?.openrouter?.key;
  if (!cachedKey) throw new Error("No OpenRouter key (OPENROUTER_API_KEY or ~/.pi/agent/auth.json openrouter.key)");
  return cachedKey;
}

const pool = new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 10_000 });

export function postDecision(body: unknown, timeoutMs = DECISION_TIMEOUT_MS): Promise<RawResponse> {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/alpha/decisions",
        method: "POST",
        agent: pool,
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json: any = {};
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode ?? 0, json, ms: performance.now() - t0, error: httpError(res.statusCode ?? 0, json, data) });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", (e) => resolve({ status: 0, json: {}, ms: performance.now() - t0, error: e.message }));
    req.end(payload);
  });
}

export function modelAgent(key: ModelKey): Agent {
  const { model, label } = MODELS[key];
  return {
    info: { id: key, label, kind: "model", model },
    async warmup() {
      await postDecision(warmupBody(model));
    },
    async decide(o: Observation): Promise<DecisionResult> {
      return toDecisionResult(await postDecision(decisionBody(model, o)));
    },
  };
}
