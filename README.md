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
