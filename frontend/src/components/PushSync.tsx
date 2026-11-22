'use client';

import { useEffect } from 'react';
import { push as pushApi } from '@/lib/api';
import { syncDevicePush } from '@/lib/pushClient';

const HEARTBEAT_MS = 60_000;

/** Tells the server whether this window is on screen (push only when away) and keeps the device subscribed. */
export default function PushSync() {
  useEffect(() => {
    let clientId = '';
    try { clientId = sessionStorage.getItem('push-client-id') ?? ''; } catch { /* ignore */ }
    if (!clientId) {
      clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try { sessionStorage.setItem('push-client-id', clientId); } catch { /* ignore */ }
    }

    // the device's push endpoint tells the server which subscription belongs to this screen
    let endpoint: string | null = null;
    const send = (visible: boolean) => { void pushApi.presence(clientId, visible, endpoint).catch(() => {}); };
    void navigator.serviceWorker?.ready.then((r) => r.pushManager?.getSubscription()).then((s) => { endpoint = s?.endpoint ?? null; if (endpoint) report(); }).catch(() => {});
    const report = () => send(document.visibilityState === 'visible');
    const leave = () => send(false);
    report();
    const beat = setInterval(() => { if (document.visibilityState === 'visible') report(); }, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', leave);

    void syncDevicePush().catch(() => {});

    return () => {
      clearInterval(beat);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  return null;
}
