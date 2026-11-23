import { EventEmitter } from 'events';
import { chownSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { getUserHomeDir, getValidAccessToken } from './claudeCode';
import { createUsageReader, type UsageRecord } from './usageCache';

/**
 * Several Claude subscriptions per user. Account 1 is the login in the user's home
 * (~/.claude.json); extra accounts keep only their own login in ~/.accounts/<slot>/.claude.json.
 * Every run uses the user's home (so all conversations and --resume are shared) and only the
 * access token of the chosen account (CLAUDE_CODE_OAUTH_TOKEN). Before each run the account with
 * room is picked: account 1 while it is under SWITCH_AT percent, otherwise the next one.
 */

export const SWITCH_AT = 95;
const USAGE_TTL_MS = 60_000;
const CLAUDE_UID = 1001;
const CLAUDE_GID = 1001;

export interface UsageWindow { pct: number; resetAt: string | null }
export interface AnthropicUsage {
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  /** the latest fetch failed (or is old): this is the last good reading, taken at fetchedAt */
  stale?: boolean;
  fetchedAt?: string;
}
export interface ClaudeAccount { slot: number; dir: string; email: string | null; plan: string | null }

/** Emits ('switch', conversationId, message) when a run uses another account than the run before it. */
export const accountEvents = new EventEmitter();

/** Map the OAuth usage response (five_hour / seven_day windows) to session + weekly percentages. */
export function parseOauthUsage(data: unknown): AnthropicUsage | null {
  const d = data as Record<string, { utilization?: unknown; resets_at?: unknown } | null> | null;
  if (!d || typeof d !== 'object') return null;
  const win = (w: { utilization?: unknown; resets_at?: unknown } | null | undefined): UsageWindow | null =>
    w && typeof w.utilization === 'number'
      ? { pct: Math.max(0, Math.min(100, w.utilization)), resetAt: typeof w.resets_at === 'string' ? w.resets_at : null }
      : null;
  const session = win(d.five_hour);
  const weekly = win(d.seven_day);
  return session || weekly ? { session, weekly } : null;
}

export function accountsRoot(userId: string): string {
  return join(getUserHomeDir(userId), '.accounts');
}

export function accountDir(userId: string, slot: number): string {
  return slot === 0 ? getUserHomeDir(userId) : join(accountsRoot(userId), String(slot));
}

function readLogin(dir: string): { token: string | null; email: string | null; plan: string | null } {
  try {
    const c = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { accessToken?: string; emailAddress?: string | null; subscriptionType?: string | null };
    };
    return { token: c.oauthAccount?.accessToken ?? null, email: c.oauthAccount?.emailAddress ?? null, plan: c.oauthAccount?.subscriptionType ?? null };
  } catch {
    return { token: null, email: null, plan: null };
  }
}

/** Accounts with a login, account 1 first. */
export function listAccounts(userId: string): ClaudeAccount[] {
  const slots = [0];
  const root = accountsRoot(userId);
  if (existsSync(root)) {
    for (const name of readdirSync(root)) if (/^[1-9]\d*$/.test(name)) slots.push(Number(name));
  }
  return slots.sort((a, b) => a - b)
    .map((slot) => ({ slot, dir: accountDir(userId, slot), ...readLogin(accountDir(userId, slot)) }))
    .filter((a) => a.token)
    .map(({ slot, dir, email, plan }) => ({ slot, dir, email, plan }));
}

/** First free slot for a new account. */
export function nextSlot(userId: string): number {
  const used = new Set(listAccounts(userId).map((a) => a.slot));
  let s = 1;
  while (used.has(s)) s++;
  return s;
}

/** Create the folder for an extra account's login (inside the user's own home). */
export function ensureAccountDir(userId: string, slot: number): string {
  const dir = accountDir(userId, slot);
  if (slot > 0 && !existsSync(dir)) {
    const root = accountsRoot(userId);
    if (!existsSync(root)) { mkdirSync(root, { mode: 0o700 }); chownSync(root, CLAUDE_UID, CLAUDE_GID); }
    mkdirSync(dir, { mode: 0o700 });
    chownSync(dir, CLAUDE_UID, CLAUDE_GID);
  }
  return dir;
}

/** Remove an extra account's login. Account 1 is removed with the normal logout. */
export function removeAccount(userId: string, slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 1) return false;
  const dir = accountDir(userId, slot);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  void usageReader.drop(dir);
  limitedUntil.delete(dir);
  limitedAt.delete(dir);
  return true;
}

export function accountLabel(a: { slot: number; email: string | null }): string {
  return a.email ? `account ${a.slot + 1} (${a.email})` : `account ${a.slot + 1}`;
}

const limitedUntil = new Map<string, number>();
/** when each lock was set, so a fresh usage reading can lift it (see lockHolds) */
const limitedAt = new Map<string, number>();
const lastSlot = new Map<string, number>();

/** Last good reading per account dir in redis (survives a restart). Loaded lazily: tests run without redis. */
const USAGE_KEY = (dir: string) => `usage:last:${dir}`;
const usageReader = createUsageReader({
  ttlMs: USAGE_TTL_MS,
  async fetchUsage(dir) {
    // no forRun: getValidAccessToken leaves the token alone while runs use this account
    const token = await getValidAccessToken(dir);
    if (!token) return { ok: false };
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, value: parseOauthUsage(await res.json()) };
  },
  store: {
    async get(dir) {
      const { redis } = await import('../redis');
      const raw = await redis.get(USAGE_KEY(dir));
      return raw ? (JSON.parse(raw) as UsageRecord) : null;
    },
    async set(dir, rec) {
      const { redis } = await import('../redis');
      await redis.set(USAGE_KEY(dir), JSON.stringify(rec), 'EX', 14 * 24 * 3600);
    },
    async del(dir) {
      const { redis } = await import('../redis');
      await redis.del(USAGE_KEY(dir));
    },
  },
});

/**
 * Subscription usage of one account (same source as Claude Code's own /usage), cached a minute.
 * A failed fetch returns the last good reading (stale: true, fetchedAt). swr: for display, answer
 * at once with the last known reading and refresh in the background. fresh: fetch again now (after an answer).
 */
export function accountUsage(dir: string, opts: { swr?: boolean; fresh?: boolean } = {}): Promise<AnthropicUsage | null> {
  return usageReader.read(dir, opts);
}

/** A run on this account hit its limit: skip it until the reset (or 30 minutes when unknown). */
export function markLimited(dir: string, resetAt: string | null): void {
  const t = resetAt ? Date.parse(resetAt) : NaN;
  limitedUntil.set(dir, Number.isFinite(t) && t > Date.now() ? t : Date.now() + 30 * 60_000);
  limitedAt.set(dir, Date.now());
  usageReader.invalidate(dir);
}

/** How long a lock holds regardless of what the usage API says (it can lag right after the hit). */
export const LOCK_MIN_MS = 2 * 60_000;

/**
 * Pure (tested): does a limit lock still hold? It ends at its reset time, but also earlier when a
 * usage reading taken after the lock shows room again: the subscription was reset or topped up
 * (the CLI's reset time is then stale).
 */
export function lockHolds(lock: { until: number; at: number } | null, usage: AnthropicUsage | null, now = Date.now()): boolean {
  if (!lock || lock.until <= now) return false;
  if (now - lock.at < LOCK_MIN_MS || !usage) return true;
  return load(usage) >= SWITCH_AT;
}

/** The lock of one account after looking at its fresh usage; a lifted lock is forgotten. */
function lockFor(dir: string, usage: AnthropicUsage | null): number {
  const until = limitedUntil.get(dir) ?? 0;
  if (!until) return 0;
  const at = limitedAt.get(dir) ?? 0;
  if (lockHolds({ until, at }, readingAfter(usage, at))) return until;
  limitedUntil.delete(dir);
  limitedAt.delete(dir);
  return 0;
}

/** Pure (tested): only a reading taken after `at` may lift a lock; a stale one from before it may not. */
export function readingAfter(usage: AnthropicUsage | null, at: number): AnthropicUsage | null {
  if (!usage) return null;
  const t = usage.fetchedAt ? Date.parse(usage.fetchedAt) : NaN;
  return Number.isFinite(t) && t > at ? usage : null;
}

export function load(u: AnthropicUsage | null): number {
  return Math.max(u?.session?.pct ?? 0, u?.weekly?.pct ?? 0);
}

/**
 * Pure choice (tested): the first account that is not limited and under SWITCH_AT; when none
 * is, the least-used one that is not limited; when all are limited, the one that frees up first.
 */
export function chooseAccount<T extends { slot: number }>(accounts: Array<T & { load: number; limitedUntil: number }>, now = Date.now()): T & { load: number; limitedUntil: number } {
  const free = accounts.filter((a) => a.limitedUntil <= now);
  const roomy = free.find((a) => a.load < SWITCH_AT);
  if (roomy) return roomy;
  if (free.length) return free.reduce((best, a) => (a.load < best.load ? a : best));
  return accounts.reduce((best, a) => (a.limitedUntil < best.limitedUntil ? a : best));
}

export interface PickedAccount {
  slot: number;
  dir: string;
  token: string | null;
  /** set when this run uses another account than the previous run of this user */
  switched: { message: string } | null;
}

/** Account and token for the next run of this user. */
export async function pickAccount(userId: string, allowed: number[] | null = null): Promise<PickedAccount> {
  const home = getUserHomeDir(userId);
  const all = listAccounts(userId);
  // an agent limited to certain accounts (agents.account_slots); none of them linked any more = all
  const only = allowed?.length ? all.filter((a) => allowed.includes(a.slot)) : [];
  const accounts = only.length ? only : all;
  if (only.length === 1) {
    return { slot: only[0].slot, dir: only[0].dir, token: await getValidAccessToken(only[0].dir, { forRun: true }), switched: null };
  }
  if (accounts.length <= 1) {
    return { slot: 0, dir: home, token: await getValidAccessToken(home, { forRun: true }), switched: null };
  }
  const rated = await Promise.all(accounts.map(async (a) => {
    const usage = await accountUsage(a.dir);
    return { ...a, load: load(usage), limitedUntil: lockFor(a.dir, usage) };
  }));
  const chosen = chooseAccount(rated);
  const key = only.length ? `${userId}:${only.map((a) => a.slot).join(',')}` : userId;
  const prev = lastSlot.get(key) ?? accounts[0].slot;
  lastSlot.set(key, chosen.slot);
  let switched: PickedAccount['switched'] = null;
  if (chosen.slot !== prev) {
    const from = rated.find((a) => a.slot === prev);
    const why = from ? (from.limitedUntil > Date.now() ? 'zit aan zijn limiet' : `zit op ${Math.round(from.load)}%`) : 'is niet meer gekoppeld';
    switched = {
      message: chosen.slot === 0
        ? `Terug op ${accountLabel(chosen)}: daar is weer ruimte.`
        : `Even gewisseld naar ${accountLabel(chosen)}: ${from ? accountLabel(from) : 'het vorige account'} ${why}. Het gesprek loopt gewoon door.`,
    };
  }
  return { slot: chosen.slot, dir: chosen.dir, token: await getValidAccessToken(chosen.dir, { forRun: true }), switched };
}

/**
 * Pure (tested by hand): when an account can take a message again, in ms; `now` when it has room.
 * A limit lock holds until its time; a window at SWITCH_AT or more until that window resets.
 */
export function usableAt(usage: AnthropicUsage | null, limitedUntil: number, now = Date.now()): number {
  let at = limitedUntil > now ? limitedUntil : now;
  for (const w of [usage?.session, usage?.weekly]) {
    if (!w || w.pct < SWITCH_AT) continue;
    const r = w.resetAt ? Date.parse(w.resetAt) : NaN;
    if (Number.isFinite(r) && r > at) at = r;
  }
  return at;
}

export interface AccountOverview { slot: number; email: string | null; plan: string | null; usage: AnthropicUsage | null; limited: boolean; active: boolean; usableAt: string | null }

/** All accounts with their usage and which one the next message would use (read-only). */
export async function accountsOverview(userId: string, opts: { swr?: boolean; fresh?: boolean } = {}): Promise<AccountOverview[]> {
  const accounts = listAccounts(userId);
  if (!accounts.length) return [];
  const rated = await Promise.all(accounts.map(async (a) => {
    const usage = await accountUsage(a.dir, opts);
    return { ...a, usage, load: load(usage), limitedUntil: lockFor(a.dir, usage) };
  }));
  const active = chooseAccount(rated).slot;
  const now = Date.now();
  return rated.map((a) => {
    const at = usableAt(a.usage, a.limitedUntil, now);
    return { slot: a.slot, email: a.email, plan: a.plan, usage: a.usage, limited: a.limitedUntil > now, active: a.slot === active, usableAt: at > now ? new Date(at).toISOString() : null };
  });
}

/** The first moment any linked account can take a message again (ms), or null when one has room now. */
export async function earliestRoom(userId: string): Promise<number | null> {
  const list = await accountsOverview(userId);
  if (!list.length || list.some((a) => !a.usableAt)) return null;
  return Math.min(...list.map((a) => Date.parse(a.usableAt!)));
}

/** After a limit hit: is there another linked subscription the answer can continue on? */
/** Clear room on some account (after a manual reset or a new window): a scheduled resume may start early. */
export async function hasRoomNow(userId: string): Promise<boolean> {
  const list = await accountsOverview(userId);
  // same line as the account choice (chooseAccount): an account under SWITCH_AT takes messages
  return list.some((a) => !a.limited && load(a.usage) < SWITCH_AT);
}

export async function hasRoomElsewhere(userId: string): Promise<boolean> {
  const list = await accountsOverview(userId);
  return list.length > 1 && list.some((a) => a.active && !a.limited);
}
