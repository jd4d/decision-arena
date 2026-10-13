// Controlled latency A/B between two protocol versions: the same frozen game states are encoded with each protocol and
// sent to each model, with the protocol order randomised per state so network drift hits both arms equally.
// Real model calls (about $0.00005 each). Writes per-call rows to --out (JSONL; no keys or headers are stored).
// Usage: node scripts/protocol-latency.ts [--arms p1,p2] [--states 60] [--repeats 2] [--concurrency 4] [--out /tmp/protocol-latency.jsonl]
import { writeFileSync } from "node:fs";
import { postDecision } from "../src/agents/model.ts";
import { MODELS, toDecisionResult, warmupBody, type ModelKey } from "../src/agents/models.ts";
import { scriptedBot } from "../src/agents/bots.ts";
import * as P1 from "../src/protocol/v1.ts";
import * as P2 from "../src/protocol/v2.ts";
import { observe, type Observation } from "../src/sim/observe.ts";
import { MAP_IDS } from "../src/sim/maps.ts";
import { rng } from "../src/sim/rng.ts";
import { createWorld, setOrders, step } from "../src/sim/world.ts";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const N_STATES = Number(arg("states", "60"));
const REPEATS = Number(arg("repeats", "2"));
const CONCURRENCY = Number(arg("concurrency", "4"));
const OUT = arg("out", "/tmp/protocol-latency.jsonl");

const PROTOCOLS = { p1: P1, p2: P2 } as const;
type ProtoKey = keyof typeof PROTOCOLS;
const ARMS = arg("arms", "p1,p2").split(",") as ProtoKey[];
if (ARMS.length !== 2 || !ARMS.every((a) => a in PROTOCOLS)) throw new Error(`--arms needs two of ${Object.keys(PROTOCOLS).join(",")}`);

/** Mid-fight states from scripted-bot games across every map, sampled every ~1.5 s for both sides. */
async function sampleStates(n: number): Promise<{ id: string; o: Observation }[]> {
  const out: { id: string; o: Observation }[] = [];
  for (let seed = 1; out.length < n; seed++) {
    const map = MAP_IDS[seed % MAP_IDS.length];
    const w = createWorld(map, seed);
    const bots = [scriptedBot({ seed }), scriptedBot({ seed: seed + 100 })];
    while (!w.over && out.length < n) {
      if (w.tick % 8 === 0) for (const s of [0, 1] as const) {
        const o = observe(w, s);
        const d = await bots[s].decide(o);
        if (d.action) setOrders(w, s, d.action);
        if (w.tick > 0 && w.tick % 45 === 0) out.push({ id: `${map}/${seed}/t${w.tick}/s${s}`, o });
      }
      step(w);
    }
  }
  return out.slice(0, n);
}

type Row = { state: string; model: ModelKey; protocol: ProtoKey; repeat: number; bytes: number; ms: number; tokensIn?: number; tokensOut?: number; cost?: number; error?: string; fireP?: number; drive?: string; turret?: number };

async function main() {
  const states = await sampleStates(N_STATES);
  const r = rng(12345);
  const jobs: (() => Promise<Row[]>)[] = [];
  for (const { id, o } of states) for (let rep = 0; rep < REPEATS; rep++) for (const model of Object.keys(MODELS) as ModelKey[]) {
    const order: ProtoKey[] = r() < 0.5 ? [ARMS[0], ARMS[1]] : [ARMS[1], ARMS[0]];
    // The two protocols for one (state, model, repeat) run back to back, so they see the same network conditions.
    jobs.push(async () => {
      const rows: Row[] = [];
      for (const protocol of order) {
        const P = PROTOCOLS[protocol];
        const body = { model: MODELS[model].model, state: P.encodeState(o), questions: P.buildQuestions(o) };
        const raw = await postDecision(body);
        const d = toDecisionResult(raw, o);
        rows.push({
          state: id, model, protocol, repeat: rep, bytes: JSON.stringify(body).length, ms: raw.ms,
          tokensIn: d.tokens?.in, tokensOut: d.tokens?.out, cost: d.cost, error: d.error,
          fireP: d.detail?.fireP, drive: d.action?.drive, turret: d.action?.turret,
        });
      }
      return rows;
    });
  }
  // Shuffle job order so models and states interleave over time.
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }

  for (const m of Object.values(MODELS)) { await postDecision(warmupBody(m.model)); await postDecision(warmupBody(m.model)); }

  const rows: Row[] = [];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      rows.push(...(await job()));
      if (++done % 20 === 0) process.stderr.write(`${done}/${jobs.length}\n`);
    }
  }));
  writeFileSync(OUT, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(`wrote ${rows.length} rows to ${OUT}`);
}

await main();
