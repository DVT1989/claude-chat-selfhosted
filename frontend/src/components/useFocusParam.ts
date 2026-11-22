'use client';

import { useEffect, useRef } from 'react';

/**
 * Deep link from the Swarm: ?focus=<id> scrolls to the element with data-focus-id=<id> once the
 * list has loaded and lets it light up briefly.
 */
export function useFocusParam(ready: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get('focus');
    if (!id) return;
    done.current = true;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      el.classList.add('focus-flash');
      window.setTimeout(() => el.classList.remove('focus-flash'), 2600);
    }, 120);
    return () => window.clearTimeout(t);
  }, [ready]);
}
