// What the run flow knows about a match it just started, kept for the live page (survives a reload).
import type { PublicCondition, RunSummary } from "../../api/contract.ts";

export type Launch = {
  liveUrl: string;
  queuePosition: number;
  map: string; // requested map, possibly "random"
  condition: PublicCondition;
  createdAt: number;
  /** Pool summary fetched before the match started (to show how the match moved it). */
  before: RunSummary | null;
};

const key = (id: string) => `decision-arena:launch:${id}`;

export function saveLaunch(id: string, l: Launch): void {
  try { sessionStorage.setItem(key(id), JSON.stringify(l)); } catch { /* storage full or disabled */ }
}

export function readLaunch(id: string): Launch | null {
  try {
    const raw = sessionStorage.getItem(key(id));
    return raw ? (JSON.parse(raw) as Launch) : null;
  } catch {
    return null;
  }
}

export function saveBefore(id: string, before: RunSummary): void {
  const l = readLaunch(id);
  if (l) saveLaunch(id, { ...l, before });
  else try { sessionStorage.setItem(`${key(id)}:before`, JSON.stringify(before)); } catch { /* ignore */ }
}

export function readBefore(id: string): RunSummary | null {
  const l = readLaunch(id);
  if (l?.before) return l.before;
  try {
    const raw = sessionStorage.getItem(`${key(id)}:before`);
    return raw ? (JSON.parse(raw) as RunSummary) : null;
  } catch {
    return null;
  }
}
