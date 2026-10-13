import type { Observation } from "../sim/observe.ts";
import type { Action } from "../sim/types.ts";

export type DecisionResult = {
  action: Action | null; // null = no usable decision (error); previous orders continue
  realMs: number; // wall-clock time the decision took
  detail?: { driveP: Record<string, number>; turretP: Record<string, number>; fireP: number };
  cost?: number;
  tokens?: { in: number; out: number };
  provider?: string;
  modelServed?: string;
  error?: string;
};

export type AgentInfo = { id: string; label: string; kind: "model" | "bot"; model?: string; /** protocol label this agent decodes with (model agents) */ protocol?: string };

export interface Agent {
  info: AgentInfo;
  decide(obs: Observation): Promise<DecisionResult>;
  warmup?(): Promise<void>;
}
