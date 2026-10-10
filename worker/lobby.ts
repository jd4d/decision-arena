// Lobby: singleton Durable Object. Site-wide concurrency cap with a FIFO queue, live counts, budget gate and the
// community-summary fold. No per-IP or per-user limits (deliberate).
import { DurableObject } from "cloudflare:workers";
import type { StatusResponse } from "../src/api/contract.ts";
import type { SummaryAcc } from "../src/analysis/aggregate.ts";
import { emptyAcc } from "../src/analysis/aggregate.ts";
import { foldPending, readAcc, spendAndCount } from "./db.ts";
import { numVar, roomStub, type Env, type RoomSpec } from "./env.ts";

type LobbyState = { live: Record<string, number>; queue: string[] }; // live: matchId -> startedAt (ms)

export type AdmitResult = { ok: true; position: number } | { ok: false; error: "budget_exhausted" | "busy"; message: string };

const CHECK_TTL_MS = 60_000;
const STALE_LIVE_MS = 16 * 60_000; // longer than any match can run (DO alarm wall limit is 15 min)
const SWEEP_MS = 60_000;
const MIN_CREDIT_USD = 0.5;

export class Lobby extends DurableObject<Env> {
  private st?: LobbyState;
  private chain: Promise<unknown> = Promise.resolve();
  private spend?: { usd: number; done: number; at: number };
  private credit?: { remaining: number | null; at: number };
  private acc?: SummaryAcc;

  private get maxConcurrent() { return Math.floor(numVar(this.env.MAX_CONCURRENT, 8)); }
  private get maxQueue() { return Math.floor(numVar(this.env.MAX_QUEUE, 50)); }
  private get budgetUsd() { return numVar(this.env.BUDGET_USD, 95); }

  /** Run mutations one at a time: awaits on D1/fetch/RPC would otherwise let calls interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private async state(): Promise<LobbyState> {
    if (!this.st) this.st = (await this.ctx.storage.get<LobbyState>("state")) ?? { live: {}, queue: [] };
    return this.st;
  }
  private async save(): Promise<void> {
    await this.ctx.storage.put("state", this.st!);
    const busy = Object.keys(this.st!.live).length || this.st!.queue.length;
    if (busy && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  // ---------- budget gate ----------

  private async spendInfo(force = false) {
    if (force || !this.spend || Date.now() - this.spend.at > CHECK_TTL_MS) {
      try { this.spend = { ...(await spendAndCount(this.env.DB)), at: Date.now() }; }
      catch (e) { console.error("spend query failed", (e as Error).message); this.spend ??= { usd: 0, done: 0, at: 0 }; }
    }
    return this.spend;
  }

  /** OpenRouter key limit_remaining (null if the key has no limit or the check failed). Cached ~60 s. */
  private async creditRemaining(): Promise<number | null> {
    if (this.credit && Date.now() - this.credit.at < CHECK_TTL_MS) return this.credit.remaining;
    let remaining: number | null = this.credit?.remaining ?? null;
    const key = this.env.OPENROUTER_API_KEY;
    if (key) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const j = (await r.json()) as { data?: { limit_remaining?: number | null } };
          const v = j?.data?.limit_remaining;
          remaining = typeof v === "number" && Number.isFinite(v) ? v : null;
        } else console.error("OpenRouter key check: HTTP", r.status);
      } catch (e) {
        console.error("OpenRouter key check failed", (e as Error).message);
      }
    }
    this.credit = { remaining, at: Date.now() };
    return remaining;
  }

  private async budgetOk(): Promise<{ ok: boolean; spentUsd: number; creditRemainingUsd: number | null; done: number }> {
    const [s, credit] = await Promise.all([this.spendInfo(), this.creditRemaining()]);
    const ok = s.usd < this.budgetUsd && (credit === null || credit >= MIN_CREDIT_USD);
    return { ok, spentUsd: s.usd, creditRemainingUsd: credit, done: s.done };
  }

  // ---------- RPC ----------

  /** Admit a new match: start it now (position 0) or queue it (position >= 1). */
  admit(spec: RoomSpec): Promise<AdmitResult> {
    return this.serial(async () => {
      const b = await this.budgetOk();
      if (!b.ok) return { ok: false, error: "budget_exhausted", message: "The arena's model budget is used up. Thanks for playing!" } as const;
      await this.pump(); // drain anything left queued while capacity exists
      const st = await this.state();
      if (Object.keys(st.live).length < this.maxConcurrent && !st.queue.length) {
        st.live[spec.matchId] = Date.now();
        await this.save();
        await roomStub(this.env, spec.matchId).init(spec, 0);
        return { ok: true, position: 0 } as const;
      }
      if (st.queue.length >= this.maxQueue) return { ok: false, error: "busy", message: "The arena queue is full. Please try again in a minute." } as const;
      st.queue.push(spec.matchId);
      await this.save();
      await roomStub(this.env, spec.matchId).init(spec, st.queue.length);
      return { ok: true, position: st.queue.length } as const;
    });
  }

  /** A match ended (any outcome): free its slot, account spend, fold its digest into the summary, start the next. */
  finish(matchId: string, costUsd: number): Promise<void> {
    return this.serial(async () => {
      const st = await this.state();
      delete st.live[matchId];
      st.queue = st.queue.filter((id) => id !== matchId);
      await this.save();
      if (this.spend) this.spend.usd += costUsd;
      try {
        this.acc ??= (await readAcc(this.env.DB)) ?? emptyAcc();
        const r = await foldPending(this.env.DB, this.acc);
        this.acc = r.acc;
        if (this.spend) this.spend.done = Math.max(this.spend.done, r.acc.matches);
      } catch (e) {
        this.acc = undefined; // reload from D1 next time; unfolded rows are caught up then
        console.error("summary fold failed", (e as Error).message);
      }
      await this.pump();
    });
  }

  /** Rebuild/refresh the cached summary (used when the cache row is missing). */
  refreshSummary(): Promise<void> {
    return this.serial(async () => {
      this.acc ??= (await readAcc(this.env.DB)) ?? emptyAcc();
      this.acc = (await foldPending(this.env.DB, this.acc)).acc;
    });
  }

  async status(): Promise<StatusResponse> {
    const st = await this.state();
    const b = await this.budgetOk();
    return {
      acceptingMatches: b.ok,
      liveMatches: Object.keys(st.live).length,
      queued: st.queue.length,
      maxConcurrent: this.maxConcurrent,
      communityMatches: b.done,
      spentUsd: Math.round(b.spentUsd * 1e6) / 1e6,
      creditRemainingUsd: b.creditRemainingUsd,
    };
  }

  /** Periodic sweep: drop live entries whose room never reported back, then start queued matches. */
  async alarm(): Promise<void> {
    await this.serial(async () => {
      const st = await this.state();
      const now = Date.now();
      for (const [id, t] of Object.entries(st.live)) if (now - t > STALE_LIVE_MS) { console.error("dropping stale live match", id); delete st.live[id]; }
      await this.pump();
      await this.ctx.storage.put("state", st);
      if (Object.keys(st.live).length || st.queue.length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
    });
  }

  /** Start queued matches while there is capacity, and tell the rest their new positions. Call inside serial(). */
  private async pump(): Promise<void> {
    const st = await this.state();
    if (!st.queue.length) return;
    let budgetOk = true;
    if (Object.keys(st.live).length < this.maxConcurrent) budgetOk = (await this.budgetOk()).ok;
    while (st.queue.length && Object.keys(st.live).length < this.maxConcurrent) {
      const id = st.queue.shift()!;
      if (!budgetOk) {
        await this.save();
        await roomStub(this.env, id).cancel("The arena's model budget is used up.").catch(() => {});
        continue;
      }
      st.live[id] = Date.now();
      await this.save();
      try { await roomStub(this.env, id).start(); }
      catch (e) { console.error("start failed", id, (e as Error).message); delete st.live[id]; await this.save(); }
    }
    await Promise.all(st.queue.map((id, i) => roomStub(this.env, id).setQueuePosition(i + 1).catch(() => {})));
  }
}
