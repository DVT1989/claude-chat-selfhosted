/**
 * Background work (learning loop, backfill, memory cleanup, agent training) runs beside the user's
 * chats, not after them. Two rules keep it from getting in the way:
 * - one shared lock: at most one background job at a time over all four kinds;
 * - room: the account the next message would use (chooseAccount) stays under a share of its
 *   subscription (default 80%), so a chat never runs into a limit because of background work.
 * A conversation that is streaming itself is still skipped by the learning loop (getActiveTask).
 */
import { accountsOverview, type AccountOverview } from './claudeAccounts';

export type JobKind = 'leerlus' | 'inhalen' | 'opruimen' | 'training';

const LABEL: Record<JobKind, string> = {
  leerlus: 'de leerlus is bezig', inhalen: 'de inhaalslag is bezig', opruimen: 'het opruimen is bezig', training: 'een training loopt',
};

let holder: JobKind | null = null;

/** Take the lock; null when another job holds it. The returned release is idempotent. */
export function tryAcquire(kind: JobKind): (() => void) | null {
  if (holder) return null;
  holder = kind;
  let done = false;
  return () => { if (!done) { done = true; holder = null; } };
}

/** Who holds the lock right now (null: free). */
export function lockHolder(): JobKind | null { return holder; }

/** Why a job cannot start now because of the lock, in words for the app; null when free. */
export function lockReason(): string | null { return holder ? LABEL[holder] : null; }

/** Run fn under the lock, or return { waiting } when another job holds it. */
export async function withLock<T>(kind: JobKind, fn: () => Promise<T>): Promise<T | { waiting: string }> {
  const release = tryAcquire(kind);
  if (!release) return { waiting: lockReason()! };
  try { return await fn(); } finally { release(); }
}

/** Default share of the subscription background work may go up to. */
export const BACKGROUND_SHARE = 0.8;

/**
 * Pure (tested): is the chosen account (active in the overview) not limited and under `share`
 * of its subscription (the highest of session and week)? No linked account: no room.
 */
export function belowShare(list: Array<Pick<AccountOverview, 'active' | 'limited' | 'usage'>>, share: number, weekCap = WEEK_CAP): boolean {
  const chosen = list.find((a) => a.active) ?? list[0];
  if (!chosen || chosen.limited) return false;
  // the session limit resets every few hours: that is the one to stay under. The week limit only
  // blocks close to the end, otherwise a week at 84% would stop all background work for days.
  const session = chosen.usage?.session?.pct ?? 0;
  const week = chosen.usage?.weekly?.pct ?? 0;
  return session < share * 100 && week < weekCap * 100;
}

/** Week share above which background work stops. */
export const WEEK_CAP = 0.95;

/** Room for background work: the account the next run would use is under `share` of its session (0..1). */
export async function roomBelow(userId: string, share = BACKGROUND_SHARE, weekCap = WEEK_CAP): Promise<boolean> {
  return belowShare(await accountsOverview(userId), share, weekCap);
}

/** for tests */
export function __resetLock(): void { holder = null; }
