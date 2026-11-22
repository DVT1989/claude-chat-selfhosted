import type { Response } from 'express';

// ── Per-conversation pub/sub broker for SSE events ──────────────────────────
//
// Why this exists:
//   The original /:id/stream handler tied the Claude task lifecycle to the HTTP
//   request lifecycle: closing the browser tab killed the spawned Claude CLI.
//   Only the requester saw events — other tabs viewing the same conversation
//   saw nothing live, and a refresh during streaming lost all in-flight state.
//
// What this fixes:
//   • Tasks live in `activeTasks` keyed by conversationId, owning their own
//     AbortController. The HTTP request never aborts the task on close.
//   • Subscribers (multiple SSE responses) live in `subscribers`. Every
//     `publish` fans out to all of them.
//   • Late subscribers can request a replay of the event history so they see
//     the partial stream so far.
//   • After a task ends, history is retained for `HISTORY_TTL_MS` so that a
//     subscriber that connects within that window still gets the final `done`.

export type SseEvent = { event: string; data: unknown; id?: string };

export interface ActiveTask {
  abort: () => void;
  history: SseEvent[];
  startedAt: number;
  /** Oldest events were dropped (MAX_HISTORY): a replay is not the full answer. */
  truncated?: boolean;
  /** Per-run event counter: SSE id `<run>:<n>` lets clients drop events they already applied. */
  runId?: string;
  seq?: number;
}

const subscribers = new Map<string, Set<Response>>();
const activeTasks = new Map<string, ActiveTask>();
// Retained histories keyed by conversationId — populated on endActiveTask, cleared after TTL.
const lingeringHistories = new Map<string, { history: SseEvent[]; truncated?: boolean; clearTimer: NodeJS.Timeout }>();

const MAX_HISTORY = 5000;
const HISTORY_TTL_MS = 30_000;

function formatSse(event: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function getOrCreateSubSet(conversationId: string): Set<Response> {
  let set = subscribers.get(conversationId);
  if (!set) {
    set = new Set<Response>();
    subscribers.set(conversationId, set);
  }
  return set;
}

/**
 * Subscribe an SSE response to receive future events for `conversationId`.
 * If `replayHistory` is true, replays the active task's history (or the
 * lingering history of a recently-ended task) before any new events.
 * Returns an unsubscribe function — safe to call multiple times.
 */
export function subscribe(conversationId: string, res: Response, replayHistory: boolean): () => void {
  // IMPORTANT: add the subscriber to the set BEFORE replaying history, and
  // build the real unsubscribe closure up front. If a write throws mid-replay
  // we MUST NOT short-circuit out with a noop unsubscribe — the caller wires
  // `req.on('close', unsubscribe)` regardless, and a noop would silently
  // orphan a still-alive socket from the subscriber set. Instead we just
  // break out of the replay loop. If the socket really is dead, the next
  // publish() will evict it via its own catch path; if it's only a transient
  // blip, the subscriber stays registered and continues to receive events.
  const set = getOrCreateSubSet(conversationId);
  set.add(res);

  let removed = false;
  const unsubscribe = (): void => {
    if (removed) return;
    removed = true;
    const cur = subscribers.get(conversationId);
    if (cur) {
      cur.delete(res);
      if (cur.size === 0) subscribers.delete(conversationId);
    }
  };

  if (replayHistory) {
    const active = activeTasks.get(conversationId);
    const linger = active ? undefined : lingeringHistories.get(conversationId);
    const history = active?.history ?? linger?.history ?? [];
    // Bracket the replay so a client that already shows part of the answer can reset instead of appending twice.
    const complete = !(active?.truncated ?? linger?.truncated);
    if (history.length && !res.writableEnded) {
      try { res.write(formatSse('replay_start', { complete })); } catch { /* evicted on next publish */ }
    }
    for (const ev of history) {
      if (res.writableEnded) break;
      try {
        res.write(formatSse(ev.event, ev.data, ev.id));
      } catch {
        // Recoverable write blip — abort replay but keep the subscriber
        // registered. publish() will evict on the next failed write if the
        // socket is truly dead, and req.on('close') will still call the
        // real unsubscribe via the closure we return below.
        break;
      }
    }
    if (history.length && !res.writableEnded) {
      try { res.write(formatSse('replay_end', {})); } catch { /* evicted on next publish */ }
    }
  }

  return unsubscribe;
}

/**
 * Publish an event to every subscriber of `conversationId` and append it to
 * the active task's history (so late subscribers can replay). Subscribers
 * whose write fails are removed from the set.
 */
/** Returns the SSE id (`<run>:<n>`) when a task is active, so callers can store it with the event. */
export function publish(conversationId: string, event: string, data: unknown): string | undefined {
  // Append to history if a task is active.
  const active = activeTasks.get(conversationId);
  let id: string | undefined;
  if (active) {
    active.seq = (active.seq ?? 0) + 1;
    id = `${active.runId ?? active.startedAt.toString(36)}:${active.seq}`;
    active.history.push({ event, data, id });
    if (active.history.length > MAX_HISTORY) {
      // Drop oldest, retain the most recent MAX_HISTORY events.
      active.history.splice(0, active.history.length - MAX_HISTORY);
      active.truncated = true;
    }
  }

  const set = subscribers.get(conversationId);
  if (!set || set.size === 0) return id;

  const payload = formatSse(event, data, id);
  // Iterate over a snapshot so deletions during iteration are safe.
  for (const res of [...set]) {
    try {
      if (res.writableEnded) {
        set.delete(res);
        continue;
      }
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
  if (set.size === 0) subscribers.delete(conversationId);
  return id;
}

/**
 * Register a running task for `conversationId`. The provided `abort` function
 * will be called when callers explicitly stop the task.
 * Throws if a task is already active for this conversation — callers should
 * use `getActiveTask` first to detect this and choose to join instead.
 */
export function registerActiveTask(conversationId: string, abort: () => void): () => void {
  if (activeTasks.has(conversationId)) {
    throw new Error(`Task already active for conversation ${conversationId}`);
  }
  // If a previous task's history was lingering, supersede it — the new task
  // will build its own.
  const lingering = lingeringHistories.get(conversationId);
  if (lingering) {
    clearTimeout(lingering.clearTimer);
    lingeringHistories.delete(conversationId);
  }
  activeTasks.set(conversationId, { abort, history: [], startedAt: Date.now(), runId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, seq: 0 });

  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    activeTasks.delete(conversationId);
  };
}

/** Returns the active task for `conversationId`, or null. */
export function getActiveTask(conversationId: string): ActiveTask | null {
  return activeTasks.get(conversationId) ?? null;
}

/**
 * Mark the active task done. Moves its history into `lingeringHistories` for
 * `HISTORY_TTL_MS` so any subscriber that connects within that window can still
 * replay (including the final `done` event), then clears it.
 */
export function endActiveTask(conversationId: string): void {
  const active = activeTasks.get(conversationId);
  if (!active) return;
  activeTasks.delete(conversationId);

  const history = active.history;
  // Replace any prior lingering history (shouldn't normally exist, but be safe).
  const prior = lingeringHistories.get(conversationId);
  if (prior) clearTimeout(prior.clearTimer);

  const clearTimer = setTimeout(() => {
    lingeringHistories.delete(conversationId);
  }, HISTORY_TTL_MS);
  // Don't keep the Node process alive just for this cleanup timer.
  if (typeof clearTimer.unref === 'function') clearTimer.unref();

  lingeringHistories.set(conversationId, { history, truncated: active.truncated, clearTimer });
}

/** Number of Claude runs going on right now (background jobs wait while chats are running). */
export function activeTaskCount(): number {
  return activeTasks.size;
}
