-- Where a community match was played: 'web' (run from the site on Cloudflare) or 't1-local'
-- (a real-latency match from the offline benchmark t1, run from Jesse's Mac and imported).
ALTER TABLE matches ADD COLUMN origin TEXT NOT NULL DEFAULT 'web';
