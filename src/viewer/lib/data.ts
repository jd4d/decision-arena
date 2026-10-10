// Everything the viewer reads lives under public/data/ (contract: src/analysis/schema.ts).
import { useEffect, useState } from "react";
import type { DataIndex, RunSummary } from "../../analysis/schema.ts";
import { parseLog, type LogRec } from "../../runner/log.ts";

/** Optional marker written by src/viewer/dev/make-fixture.ts. */
export type FixtureMark = { devFixture?: string };

const BASE = `${import.meta.env.BASE_URL}data/`;
const cache = new Map<string, Promise<unknown>>();

export class NotFound extends Error {}

function get<T>(path: string, parse: (text: string) => T): Promise<T> {
  let p = cache.get(path) as Promise<T> | undefined;
  if (!p) {
    p = fetch(BASE + path).then(async (r) => {
      if (r.status === 404) throw new NotFound(`${path} not found`);
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      const text = await r.text();
      // Vite's dev server answers unknown paths with index.html.
      if (/^\s*<!doctype html/i.test(text)) throw new NotFound(`${path} not found`);
      return parse(text);
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

export const loadIndex = () => get("index.json", (t) => JSON.parse(t) as DataIndex & FixtureMark);
export const loadSummary = (file: string) => get(file, (t) => JSON.parse(t) as RunSummary & FixtureMark);
export const loadLog = (file: string) => get(file, (t) => parseLog(t) as LogRec[]);

export type Async<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: Error };

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fn().then(
      (data) => live && setState({ status: "ready", data }),
      (error: Error) => live && setState({ status: "error", error }),
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
