// Home page featured replay: score the newest pool entries for how watchable they are, keep the best few, and pick one
// deterministically per 5-minute bucket, so everyone loading the page in the same 5 minutes sees the same replay and it
// rotates by itself afterwards. Pure: no I/O and no clock (callers pass `now`).
import type { MatchIndexEntry } from "../../analysis/schema.ts";

export const FEATURE_BUCKET_MS = 300_000;
/** How many of the best-scoring entries the bucket picks from. */
export const FEATURE_TOP = 10;
/** How many of the newest pool entries are considered. */
export const FEATURE_POOL = 100;

const HIGHLIGHT_SCORE: Record<string, number> = {
  comeback: 3,
  "last-second": 3,
  "shell clash": 1.5,
  "self-hit": 1.5,
  flawless: 1,
  "timeout draw": -2,
};

/** Watchability of one entry. `rank` is its position in the newest-first list of `count` entries (0 = newest). */
export function featureScore(e: MatchIndexEntry, rank: number, count: number): number {
  let s = e.winner === null ? -3 : 3; // a decisive match has a payoff
  for (const h of e.highlights) s += HIGHLIGHT_SCORE[h] ?? 0;
  const d = e.durationS;
  if (d >= 8 && d <= 45) s += 2; // long enough to follow, short enough to finish while watching
  else if (d < 8) s -= 3 * (1 - d / 8) + 1; // over before anything happens
  else s -= 1;
  if (e.reason === "time") s -= 2; // ran the clock out
  if (e.origin === "web") s += 2; // a match someone just ran from the site
  s += count > 1 ? 1.5 * (1 - rank / (count - 1)) : 1.5; // recency
  return s;
}

/** The best `top` entries by score; ties keep the newer entry first. */
export function rankFeatured(entries: readonly MatchIndexEntry[], top = FEATURE_TOP): MatchIndexEntry[] {
  return entries
    .map((e, rank) => ({ e, rank, score: featureScore(e, rank, entries.length) }))
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, top)
    .map((x) => x.e);
}

export const featureBucket = (now: number) => Math.floor(now / FEATURE_BUCKET_MS);

/** 32-bit integer hash (murmur3 finalizer), so consecutive buckets land on unrelated indexes. */
export function hash32(n: number): number {
  let h = n | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export type FeaturedPick = {
  entry: MatchIndexEntry;
  /** The ranked shortlist, rotated so the pick comes first (later entries are fallbacks if its log fails to load). */
  candidates: MatchIndexEntry[];
  bucket: number;
};

/** The featured entry for the 5-minute bucket containing `now`, or null for an empty list. */
export function pickFeatured(entries: readonly MatchIndexEntry[], now: number): FeaturedPick | null {
  const top = rankFeatured(entries.slice(0, FEATURE_POOL));
  if (!top.length) return null;
  const bucket = featureBucket(now);
  const i = hash32(bucket) % top.length;
  const candidates = [...top.slice(i), ...top.slice(0, i)];
  return { entry: candidates[0], candidates, bucket };
}
