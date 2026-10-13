import { join } from "node:path";
import { modelAgent, MODELS, type ModelKey } from "../agents/model.ts";
import type { Decoder } from "../protocol/v2.ts";
import { randomBot, scriptedBot } from "../agents/bots.ts";
import type { Agent } from "../agents/types.ts";

export const RUNS_DIR = join(import.meta.dirname, "../../runs");

/** Agent specs: jev | msd1 | scripted[:ms] | random[:ms]. decoder applies to model agents (default: the live one). */
export function makeAgent(spec: string, seed = 1, decoder?: Decoder): Agent {
  const [kind, arg] = spec.split(":");
  if (kind in MODELS) return modelAgent(kind as ModelKey, decoder);
  if (kind === "scripted") return scriptedBot({ thinkMs: arg ? Number(arg) : 200, seed });
  if (kind === "random") return randomBot({ thinkMs: arg ? Number(arg) : 200, seed });
  throw new Error(`unknown agent ${spec}`);
}
