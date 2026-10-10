// Data contract between analysis (writer) and viewer (reader). Everything the viewer loads lives under public/data/.
//   public/data/index.json                       -> DataIndex
//   public/data/summary/<runId>.json             -> RunSummary
//   public/data/matches/<runId>/<matchId>.jsonl  -> match log (see src/runner/log.ts)

export type Interval = { p: number; lo: number; hi: number }; // Wilson 95% CI

export type MatchIndexEntry = {
  runId: string;
  matchId: string;
  file: string; // path relative to public/data, e.g. "matches/<runId>/<matchId>.jsonl"
  condition: string;
  map: string;
  seed: number;
  agents: [string, string]; // agent ids by slot
  labels: [string, string];
  winner: 0 | 1 | null;
  reason: string;
  durationS: number;
  hp: [number, number];
  highlights: string[]; // e.g. "self-hit", "comeback", "shell clash", "last-second kill"
  /** Community pool only: "web" = run from the site (Cloudflare, eastern North America); "t1-local" = imported real-latency match from benchmark t1 (run locally). */
  origin?: "web" | "t1-local";
};

export type DataIndex = {
  generatedAt: string;
  runs: { runId: string; summaryFile: string; matches: number; conditions: string[] }[];
  matches: MatchIndexEntry[];
};

export type AgentConditionStats = {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: Interval; // wins / decisive matches
  scoreRate: Interval; // (wins + 0.5 draws) / matches
  decisions: number;
  decisionsPerS: number;
  latencyMs: { p50: number; p90: number; mean: number };
  effLatencyMs: { p50: number; mean: number };
  errors: number;
  errorRate: number;
  shots: number;
  hits: number;
  accuracy: number;
  selfHits: number;
  fizzles: number;
  damageTaken: number;
  costPerMatch: number;
  costPerDecision: number;
  meanFirstHitS: number | null;
  driveMix: Record<string, number>; // share of decisions per drive command
  fireCalibration: { bin: string; n: number; hitRate: number }[]; // P(fire) at decision that triggered a shot vs whether that shot hit
};

export type RunSummary = {
  runId: string;
  generatedAt: string;
  sim: string;
  protocol: string;
  agents: { id: string; label: string; model?: string }[];
  totalCostUsd: number;
  conditions: {
    condition: string;
    matches: number;
    draws: number;
    byAgent: Record<string, AgentConditionStats>;
  }[];
  maps: { map: string; matches: number; winsByAgent: Record<string, number>; draws: number }[];
  latencyHistogram: Record<string, { binMs: number; counts: number[] }>; // per agent, real latency, 25 ms bins
};
