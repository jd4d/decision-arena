-- Community matches (one row per finished match; running/queued state lives in the Durable Objects).
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,          -- ms epoch, when the match was requested
  finished_at INTEGER NOT NULL,         -- ms epoch, listing order (newest first)
  status TEXT NOT NULL,                 -- 'done' | 'aborted' | 'failed'; only 'done' is listed and summarized
  map TEXT NOT NULL,
  condition TEXT NOT NULL,              -- PublicCondition, e.g. 'scaled-1'
  seed INTEGER NOT NULL,
  agents TEXT NOT NULL,                 -- JSON [{id,label,model}] by slot
  winner INTEGER,                       -- 0 | 1 | NULL (draw or unfinished)
  reason TEXT,
  ticks INTEGER NOT NULL DEFAULT 0,
  hp TEXT,                              -- JSON [hp0, hp1]
  highlights TEXT,                      -- JSON string[]
  cost REAL NOT NULL DEFAULT 0,         -- model spend recorded in the log (USD)
  extra_cost REAL NOT NULL DEFAULT 0,   -- warm-up calls and other spend outside the log (USD)
  sim TEXT NOT NULL,
  protocol TEXT NOT NULL,
  digest TEXT,                          -- JSON MatchDigest (src/analysis/aggregate.ts), NULL unless status = 'done'
  folded INTEGER NOT NULL DEFAULT 0     -- 1 once the digest is merged into summary_cache
);
CREATE INDEX matches_list ON matches (status, finished_at DESC, id DESC);
CREATE INDEX matches_unfolded ON matches (folded, status);

-- Cached community summary: the mergeable accumulator plus the finalized RunSummary served by the API.
CREATE TABLE summary_cache (
  run_id TEXT PRIMARY KEY,
  matches INTEGER NOT NULL,
  acc TEXT NOT NULL,                    -- JSON SummaryAcc
  summary TEXT NOT NULL,                -- JSON RunSummary
  updated_at INTEGER NOT NULL
);
