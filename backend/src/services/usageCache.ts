import type { AnthropicUsage } from './claudeAccounts';

/**
 * Subscription usage per account dir that never forgets a good reading. The OAuth usage endpoint
 * fails now and then (right after a restart, a 429, a time-out, a token in use); the composer bar
 * then showed nothing until the next message. Now a failed fetch returns the last good reading with
 * stale: true and its fetchedAt. The last good reading is also kept in redis, so it survives a restart.
 */

export interface UsageRecord { value: AnthropicUsage; at: number }
export interface UsageStore {
  get(dir: string): Promise<UsageRecord | null>;
  set(dir: string, rec: UsageRecord): Promise<void>;
  del(dir: string): Promise<void>;
}
export type FetchResult = { ok: true; value: AnthropicUsage | null } | { ok: false; status?: number };

export interface UsageReaderDeps {
  fetchUsage(dir: string): Promise<FetchResult>;
  store: UsageStore;
  now?: () => number;
  /** how long a good reading is used before it is fetched again */
  ttlMs?: number;
}

/** Retry sooner after a failure; after a 429 wait longer (the endpoint asks us to back off). */
export const FAIL_RETRY_MS = 20_000;
export const RATE_LIMIT_RETRY_MS = 120_000;
export const FRESH_GAP_MS = 10_000;

function bare(u: AnthropicUsage): AnthropicUsage {
  return { session: u.session, weekly: u.weekly };
}

export function createUsageReader(deps: UsageReaderDeps) {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 60_000;
  /** what to answer until `until` (a fresh reading or the stale fallback after a failure) */
  const answer = new Map<string, { until: number; at: number; rateLimited: boolean; value: AnthropicUsage | null }>();
  const lastGood = new Map<string, UsageRecord>();
  const inflight = new Map<string, Promise<AnthropicUsage | null>>();

  const mark = (rec: UsageRecord, stale: boolean): AnthropicUsage =>
    ({ ...bare(rec.value), stale, fetchedAt: new Date(rec.at).toISOString() });

  async function good(dir: string): Promise<UsageRecord | null> {
    const hit = lastGood.get(dir);
    if (hit) return hit;
    const stored = await deps.store.get(dir).catch(() => null);
    if (stored && stored.value && typeof stored.at === 'number') { lastGood.set(dir, stored); return stored; }
    return null;
  }

  async function refresh(dir: string): Promise<AnthropicUsage | null> {
    let r: FetchResult;
    try { r = await deps.fetchUsage(dir); } catch { r = { ok: false }; }
    const t = now();
    if (r.ok && r.value) {
      const rec: UsageRecord = { value: bare(r.value), at: t };
      lastGood.set(dir, rec);
      await deps.store.set(dir, rec).catch(() => undefined);
      const v = mark(rec, false);
      answer.set(dir, { until: t + ttl, at: t, rateLimited: false, value: v });
      return v;
    }
    const prev = await good(dir);
    const v = prev ? mark(prev, true) : null;
    const rateLimited = !r.ok && r.status === 429;
    answer.set(dir, { until: t + (rateLimited ? RATE_LIMIT_RETRY_MS : FAIL_RETRY_MS), at: t, rateLimited, value: v });
    return v;
  }

  function start(dir: string): Promise<AnthropicUsage | null> {
    let job = inflight.get(dir);
    if (!job) {
      job = refresh(dir).finally(() => inflight.delete(dir));
      inflight.set(dir, job);
    }
    return job;
  }

  /**
   * Usage of one account. Default: waits for a fresh fetch when the cached answer is old (falls back
   * to the last good reading with stale: true). swr: answer at once with the last known reading and
   * refresh in the background (for display only; only waits when nothing is known at all).
   * fresh: right after an answer, fetch again unless the last fetch is under FRESH_GAP_MS old or a
   * 429 asked us to back off.
   */
  async function read(dir: string, opts: { swr?: boolean; fresh?: boolean } = {}): Promise<AnthropicUsage | null> {
    const hit = answer.get(dir);
    if (hit && now() < hit.until && (!opts.fresh || hit.rateLimited || now() - hit.at < FRESH_GAP_MS)) return hit.value;
    if (opts.fresh) return start(dir);
    const job = start(dir);
    if (opts.swr) {
      // old means: the last fetch failed, or the reading is older than a few refresh rounds
      const old = (at: number) => now() - at > 3 * ttl;
      if (hit?.value) return { ...hit.value, stale: !!hit.value.stale || old(Date.parse(hit.value.fetchedAt ?? '') || 0) };
      const prev = await good(dir);
      if (prev) { job.catch(() => undefined); return mark(prev, old(prev.at)); }
    }
    return job;
  }

  return {
    read,
    /** the next read fetches fresh (after a limit hit); the last good reading stays as fallback */
    invalidate(dir: string) { answer.delete(dir); },
    /** account removed: forget everything */
    async drop(dir: string) { answer.delete(dir); lastGood.delete(dir); await deps.store.del(dir).catch(() => undefined); },
  };
}
