# Decision Arena

A real-time tank duel where structured decision models drive the tanks. It measures both how well each model controls a tank and how much its response time costs it.

The two models are Jev 1.13 (TypeSafe) and Microsoft Decision 1. Both are called through the same OpenRouter decisions endpoint, receive identical state and questions, play the same maps and seeds, and swap sides between matches.

## How it works

- **Simulation (`src/sim`):** pure, seeded, 30 Hz and deterministic. Replays are re-simulated from the logged decisions.
- **Protocol (`src/protocol`):** the only channel between the game and a model. It is versioned and identical for every model.
- **Latency (`src/runner`):** each model's measured response time is converted into game time. A decision made at tick T applies at T plus its latency, and the tank keeps its previous orders in the meantime.
  - Conditions: real latency, scaled game speed, fixed equal latency (decision quality only), and swapped latency.
- **Analysis (`src/analysis`):** win rates with Wilson 95% intervals, latency, accuracy, calibration and cost.
- **Viewer (`src/viewer`):** React and Canvas. Replays show ghosts of the enemy as each model last saw it, ping meters, and probability bars.
- **Public site (`worker/`):** one Cloudflare Worker serves the viewer and `/api/*` (contract: `src/api/contract.ts`). Each visitor match runs in its own Durable Object, always placed in region `enam` so every match calls OpenRouter from the same place. A singleton lobby Durable Object enforces a site-wide concurrency cap with a FIFO queue and a budget gate. D1 holds the match index and per-match digests, R2 holds the logs. Community matches are a separate pool from the curated benchmark (`t1`, served as static files under `/data/`).

## Run locally

```sh
pnpm install
export OPENROUTER_API_KEY=...   # needed only for model matches; bots are free
node src/runner/cli.ts match --a jev --b msd1 --map pillars --seed 1 --latency scaled:1
node src/runner/cli.ts tournament --config tournaments/t1.json
pnpm analyze --runs t1 && pnpm dev
pnpm test
```

Model matches cost real money (about $0.002–0.004 each). Runs have a hard budget cap.

### Local site (Worker + viewer)

```sh
pnpm dev:vars        # writes .dev.vars (gitignored) with the key from ~/.pi/agent/auth.json; never prints it
pnpm dev             # applies local D1 migrations, then Vite + the Worker, Durable Objects, D1 and R2 in workerd
pnpm live:smoke --base http://localhost:5173 --n 1   # one real match end to end (~$0.003)
pnpm dev:vars MAX_CONCURRENT=1                      # local overrides go in .dev.vars too (restart pnpm dev)
```

Local D1, R2 and Durable Object state lives in `.wrangler/state` (gitignored).

## Deploy

One-time setup on the Cloudflare account (the D1 id is already in `wrangler.jsonc`):

1. Subscribe the account to the **Workers Paid** plan.
2. Log in: `npx wrangler login`.
3. Add the `decisionarena.ai` zone to the account (its DNS must be on Cloudflare for the custom domain).
4. D1: `npx wrangler d1 create decision-arena --location enam`, then paste the printed `database_id` into `wrangler.jsonc`.
5. R2: enable R2 in the dashboard, then `npx wrangler r2 bucket create decision-arena-logs --location enam` (the name is in `wrangler.jsonc`).
6. Migrations: `pnpm db:migrate:remote`.
7. Key: create a **dedicated OpenRouter key with a credit limit** (about $100). That limit is the real budget cap; the Worker also stops accepting matches when recorded spend reaches `BUDGET_USD` (95) or the key's `limit_remaining` drops below $0.50. Then `npx wrangler secret put OPENROUTER_API_KEY` and paste it (if wrangler offers to create the `decision-arena` Worker, accept).
8. Benchmark data: `pnpm analyze --runs t1` (needs `runs/t1` locally; `public/data/` is gitignored). It ships as static assets under `/data/`.
9. Deploy: `pnpm cf:deploy` (build, `pnpm deploy:check` secret scan, `wrangler deploy`). The custom domain `decisionarena.ai` comes from `routes` in `wrangler.jsonc` and is attached on deploy.
10. Verify: open `https://decisionarena.ai/api/status`, then `pnpm live:smoke --base https://decisionarena.ai`.

Later deploys are step 8 (if the benchmark changed) and step 9. A deploy restarts Durable Objects and drops matches in progress, so deploy when `/api/status` shows `liveMatches: 0`. `MAX_CONCURRENT`, `MAX_QUEUE` and `BUDGET_USD` are `vars` in `wrangler.jsonc`.
