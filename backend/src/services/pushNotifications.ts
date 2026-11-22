import webpush from 'web-push';
import { query } from '../db';

const PUBLIC = process.env.VAPID_PUBLIC_KEY ?? '';
const PRIVATE = process.env.VAPID_PRIVATE_KEY ?? '';
const SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com';

if (PUBLIC && PRIVATE) {
  webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  /** Buttons on the notification (where the platform supports them; iOS ignores them) */
  actions?: Array<{ action: string; title: string }>;
  /** POSTed by the service worker when an action button is tapped (same-origin, with the login cookie) */
  actionUrl?: string;
}

// ── Presence: which app windows are on screen ──
// Clients report visibility (heartbeat while visible, beacon when hidden). Push is only sent
// when no window is visible, so the service worker can always show it (iOS revokes
// subscriptions that receive pushes without a notification).
const PRESENCE_TTL_MS = 90_000;
// userId -> clientId -> last visible at + the push endpoint of that device (when it has one)
const presence = new Map<string, Map<string, { at: number; endpoint: string | null }>>();

export function markPresence(userId: string, clientId: string, visible: boolean, endpoint: string | null = null): void {
  let clients = presence.get(userId);
  if (visible) {
    if (!clients) presence.set(userId, clients = new Map());
    clients.set(clientId, { at: Date.now(), endpoint });
  } else if (clients) {
    clients.delete(clientId);
    if (!clients.size) presence.delete(userId);
  }
}

export function hasVisibleClient(userId: string): boolean {
  const clients = presence.get(userId);
  if (!clients) return false;
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.at < PRESENCE_TTL_MS) return true;
    clients.delete(id);
  }
  return false;
}

/** Push endpoints of devices that have the app on screen right now: they do not need a push. */
function visibleEndpoints(userId: string): Set<string> {
  const out = new Set<string>();
  const now = Date.now();
  for (const c of presence.get(userId)?.values() ?? []) if (c.endpoint && now - c.at < PRESENCE_TTL_MS) out.add(c.endpoint);
  return out;
}

export function getVapidPublicKey(): string {
  return PUBLIC;
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** onlyAway: skip the devices that have the app on screen (a laptop with the app open does not block the phone). */
export async function sendPushToUser(userId: string, payload: PushPayload, opts: { onlyAway?: boolean } = {}): Promise<void> {
  if (!PUBLIC || !PRIVATE) return;

  const subs = await query<SubRow>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',

[userId],
  );
  if (opts.onlyAway) {
    const skip = visibleEndpoints(userId);
    subs.rows = subs.rows.filter((s) => !skip.has(s.endpoint));
  }

  if (subs.rows.length === 0) return;

  const json = JSON.stringify(payload);
  await Promise.allSettled(subs.rows.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json,
        { TTL: 600 },
      );
      await query('UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1', [s.id]);
    } catch (err: unknown) {
      const e = err as { statusCode?: number };

// 404 / 410: subscription expired or revoked → delete
      if (e.statusCode === 404 || e.statusCode === 410) {
        await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
      } else {
        console.error('[push] send failed:', err);
      }
    }
  }));
}
