/**
 * Claude Code Service Worker
 * Strategy:
 *  - Static assets (_next/static): cache-first with background refresh
 *  - API calls (/api/): network-only (SSE streaming must not be cached)
 *  - Pages: network-first, fall back to cache for offline shell
 *
 * v4: auto-refresh assets when new SW activates
 */

const CACHE = 'claude-code-v12';

const PRECACHE = [
  '/manifest.json',
  '/favicon.svg',
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ── Message: force clear cache (called periodically from app) ─
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (e.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});

// ── Fetch ────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);


// Never intercept non-GET or cross-origin requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;


// API calls (including SSE streams): always network
  if (url.pathname.startsWith('/api/')) return;


// Next.js static chunks: cache-first + background revalidate
  if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request).then(res => {
          cache.put(request, res.clone());
          return res;
        });
        return cached ?? networkPromise;
      }),
    );
    return;
  }


// Pages and other assets: network-first, cache fallback
  e.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      })
      .catch(() => caches.match(request)),
  );
});


// ── Push event ──────────────────────────────────────────────
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let data = { title: 'Claude Chat', body: 'Bericht', url: '/chat', tag: 'default' };
    try {
      if (e.data) data = { ...data, ...e.data.json() };
    } catch (_) { /* fallback */ }


// Always show: the server only pushes when no app window is visible. Skipping the
// notification here makes iOS revoke the subscription after a few silent pushes.
    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: data.tag,
      data: { url: data.url, actionUrl: data.actionUrl },
      // buttons (e.g. "Uitvoeren" under a task's proposal) where the platform supports them
      ...(Array.isArray(data.actions) && data.actions.length ? { actions: data.actions.slice(0, 2) } : {}),
      requireInteraction: false,
    });
  })());
});

// ── Notification click — focus existing window or open new ──
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/chat';
  e.waitUntil((async () => {
    // an action button: run it (same origin, with the login cookie), then open the conversation to watch
    if (e.action && e.notification.data?.actionUrl) {
      try { await fetch(e.notification.data.actionUrl, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) { /* the chat still shows the button */ }
    }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) { await w.focus(); if ('navigate' in w) await w.navigate(targetUrl); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
