// Runtime-neutral pieces of the decision-model agent, shared by the Node agent (model.ts, node:https keep-alive pool)
// and the Worker agent (model-fetch.ts, fetch). Both must build identical requests and decode identically (fairness).
import type { Observation } from "../sim/observe.ts";
import { buildQuestions, decode, drawSeed, encodeState, type Answers, type Decoder } from "../protocol/v2.ts";
import type { DecisionResult } from "./types.ts";

export const MODELS = {
  jev: { model: "typesafe/jev-1.13", label: "Jev 1.13" },
  msd1: { model: "microsoft/microsoft-decision-1", label: "Microsoft Decision 1" },
} as const;
export type ModelKey = keyof typeof MODELS;

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DECISION_TIMEOUT_MS = 4000;

/** Raw HTTP outcome of one decisions call. `ms` covers request start to full body read. */
export type RawResponse = { status: number; json: any; ms: number; error?: string };

export const decisionBody = (model: string, o: Observation) => ({ model, state: encodeState(o), questions: buildQuestions(o) });
export const warmupBody = (model: string) => ({ model, state: { ping: true }, questions: { ok: { type: "noul", instructions: "Is ping true?" } } });

/** Map a raw response to a DecisionResult; an HTTP/transport error or undecodable answer yields action null. */
export function toDecisionResult(r: RawResponse, o: Observation, decoder?: Decoder): DecisionResult {
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
    const d = decode(r.json.answers as Answers, drawSeed(o), decoder);
    return { ...base, action: d.action, detail: d.detail };
  } catch (e) {
    return { ...base, error: `decode: ${(e as Error).message}` };
  }
}

/** HTTP error text in the same shape for both transports. */
export const httpError = (status: number, json: any, text: string) =>
  status >= 400 ? `${status}: ${json?.error?.message ?? text.slice(0, 160)}` : undefined;
