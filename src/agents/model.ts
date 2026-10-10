// Decision-model agent over OpenRouter's /api/alpha/decisions with a shared keep-alive pool.
import https from "node:https";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Observation } from "../sim/observe.ts";
import { buildQuestions, decode, encodeState, type Answers } from "../protocol/v1.ts";
import type { Agent, DecisionResult } from "./types.ts";

export const MODELS = {
  jev: { model: "typesafe/jev-1.13", label: "Jev 1.13" },
  msd1: { model: "microsoft/microsoft-decision-1", label: "Microsoft Decision 1" },
} as const;
export type ModelKey = keyof typeof MODELS;

let cachedKey: string | undefined;
function apiKey(): string {
  if (cachedKey) return cachedKey;
  cachedKey = process.env.OPENROUTER_API_KEY || JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"))?.openrouter?.key;
  if (!cachedKey) throw new Error("No OpenRouter key (OPENROUTER_API_KEY or ~/.pi/agent/auth.json openrouter.key)");
  return cachedKey;
}

const pool = new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 10_000 });

type RawResponse = { status: number; json: any; ms: number; error?: string };

export function postDecision(body: unknown, timeoutMs = 4000): Promise<RawResponse> {
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
          resolve({ status: res.statusCode ?? 0, json, ms: performance.now() - t0, error: (res.statusCode ?? 0) >= 400 ? `${res.statusCode}: ${json?.error?.message ?? data.slice(0, 160)}` : undefined });
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
      await postDecision({ model, state: { ping: true }, questions: { ok: { type: "noul", instructions: "Is ping true?" } } });
    },
    async decide(o: Observation): Promise<DecisionResult> {
      const r = await postDecision({ model, state: encodeState(o), questions: buildQuestions(o) });
      const base: DecisionResult = {
        action: null,
        realMs: r.ms,
        cost: r.json?.usage?.cost,
        tokens: r.json?.usage ? { in: r.json.usage.input_tokens, out: r.json.usage.output_tokens } : undefined,
        provider: r.json?.provider,
        modelServed: r.json?.model,
      };
      if (r.error) return { ...base, error: r.error };
      try {
        const d = decode(r.json.answers as Answers);
        return { ...base, action: d.action, detail: d.detail };
      } catch (e) {
        return { ...base, error: `decode: ${(e as Error).message}` };
      }
    },
  };
}
