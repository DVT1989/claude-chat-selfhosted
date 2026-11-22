import { push as pushApi } from '@/lib/api';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - b64.length % 4) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const OPT_OUT_KEY = 'push-opt-out';
/** Switched off on this device: no silent resubscribe even if other devices are subscribed. */
export function pushOptedOut(): boolean {
  try { return localStorage.getItem(OPT_OUT_KEY) === '1'; } catch { return false; }
}
export function setPushOptOut(off: boolean): void {
  try { if (off) localStorage.setItem(OPT_OUT_KEY, '1'); else localStorage.removeItem(OPT_OUT_KEY); } catch { /* ignore */ }
}

/** Subscribes this device and registers it with the server (upsert). */
export async function subscribeDevice(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await pushApi.vapidKey();
    if (!key) throw new Error('Server niet geconfigureerd voor push');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource });
  }
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await pushApi.subscribe({ endpoint: json.endpoint, keys: json.keys });
}

/**
 * Whether this device really receives pushes. Repairs the case where the device lost its
 * subscription (cache cleared, service worker re-registered) while the server still has one:
 * then it resubscribes silently, permission is already granted.
 */
export async function syncDevicePush(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await subscribeDevice(); return true; }
  if (pushOptedOut()) return false;
  const { enabled } = await pushApi.status();
  if (!enabled) return false;
  await subscribeDevice();
  return true;
}
