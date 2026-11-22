'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A highlight that glides from the old active item to the new one (rail, tab bar, settings tabs).
 * Finds the active item inside the container ([aria-current="page"]) and returns the position for
 * an absolutely positioned indicator, measured with offsetTop/offsetLeft so it also follows items
 * inside a scrolling strip. The first placement does not animate (no flying in from 0,0).
 */
export function useNavIndicator<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number; ready: boolean; animate: boolean } | null>(null);
  const placed = useRef(false);

  const measure = useCallback(() => {
    const root = ref.current;
    const el = root?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!root || !el) { setBox(null); placed.current = false; return; }
    // offsets relative to the container; subtract the scroll of any scrolling wrapper in between
    let x = 0, y = 0;
    let n: HTMLElement | null = el;
    while (n && n !== root) {
      x += n.offsetLeft; y += n.offsetTop;
      const parent: HTMLElement | null = n.offsetParent as HTMLElement | null;
      let p: HTMLElement | null = n.parentElement;
      while (p && p !== parent && p !== root) { x -= p.scrollLeft; y -= p.scrollTop; p = p.parentElement; }
      n = parent && root.contains(parent) ? parent : null;
    }
    setBox({ x, y, w: el.offsetWidth, h: el.offsetHeight, ready: true, animate: placed.current });
    placed.current = true;
  }, []);

  useLayoutEffect(() => { measure(); }, [dep, measure]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(root);
    const onScroll = () => measure();
    root.addEventListener('scroll', onScroll, true);
    return () => { ro.disconnect(); root.removeEventListener('scroll', onScroll, true); };
  }, [measure]);

  return { ref, box };
}
