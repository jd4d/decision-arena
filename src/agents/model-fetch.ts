// Decision-model agent over fetch (Cloudflare Workers / Durable Objects). Same endpoint, request body and decoding as
// the Node agent (model.ts) via models.ts; only the transport differs. The key is passed in, never read from disk.
// Latency: performance.now() around fetch + body read. In Workers the clock only advances across I/O, which is
// exactly what this measures.
import type { Observation } from "../sim/observe.ts";
import type { Agent, DecisionResult } from "./types.ts";
import { DEFAULT_DECODER, protocolLabel, type Decoder } from "../protocol/v2.ts";
import { DECISION_TIMEOUT_MS, DECISIONS_URL, decisionBody, httpError, MODELS, toDecisionResult, warmupBody, type ModelKey, type RawResponse } from "./models.ts";

export async function postDecisionFetch(apiKey: string, body: unknown, timeoutMs = DECISION_TIMEOUT_MS): Promise<RawResponse> {
  const payload = JSON.stringify(body);
  const t0 = performance.now();
  try {
    const res = await fetch(DECISIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let json: any = {};
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, ms, error: httpError(res.status, json, text) };
  } catch (e) {
    const err = e as Error;
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { status: 0, json: {}, ms: performance.now() - t0, error: timedOut ? `timeout after ${timeoutMs}ms` : (err?.message ?? String(e)) };
  }
}

export type WarmResult = { ms: number; cost: number; error?: string };
export type FetchModelAgent = Agent & { warm(): Promise<WarmResult> };

export function fetchModelAgent(key: ModelKey, apiKey: string, timeoutMs = DECISION_TIMEOUT_MS, decoder: Decoder = DEFAULT_DECODER): FetchModelAgent {
  const { model, label } = MODELS[key];
  const warm = async (): Promise<WarmResult> => {
    const r = await postDecisionFetch(apiKey, warmupBody(model), timeoutMs);
    return { ms: r.ms, cost: Number(r.json?.usage?.cost ?? 0) || 0, error: r.error };
  };
  return {
    info: { id: key, label, kind: "model", model, protocol: protocolLabel(decoder) },
    warm,
    async warmup() {
      const r = await warm();
      if (r.error) throw new Error(r.error);
    },
    async decide(o: Observation): Promise<DecisionResult> {
      return toDecisionResult(await postDecisionFetch(apiKey, decisionBody(model, o), timeoutMs), o, decoder);
    },
  };
}
