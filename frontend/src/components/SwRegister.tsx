'use client';

import { useEffect } from 'react';

export default function SwRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let refreshing = false;

    // When a new SW takes control, reload once to pick up fresh assets
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) { refreshing = true; window.location.reload(); }
    });

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // Check for SW updates every 15 minutes
        setInterval(() => registration.update(), 15 * 60 * 1000);

        // Also check when the user returns to the tab after being away
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') registration.update();
        });
      })
      .catch(() => { /* SW is enhancement-only */ });
  }, []);

  return null;
}
