'use client';

import { useEffect } from 'react';

const EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]), textarea, [contenteditable="true"]';

/**
 * iOS does not lay the page out above the on-screen keyboard: depending on the version it shrinks
 * only the visual viewport, or innerHeight too, and shifts the page. This sizes the app to the
 * visible area (--app-h) and sets html.kb-open so the tab bar and bottom padding step aside: the
 * composer then sits right on top of the keyboard.
 *
 * Keyboard = an editable field has focus on a touch device, or the visible height dropped well
 * below the tallest height seen (per orientation). Comparing with innerHeight alone fails on iOS
 * versions that shrink innerHeight as well.
 */
export default function ViewportSync() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (!vv || !touch) return;

    const tallest: Record<string, number> = {};
    const orientation = () => (window.innerWidth > window.innerHeight ? 'l' : 'p');
    let frame = 0;
    let lastKb: boolean | null = null;
    let lastH = '';

    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const o = orientation();
        const h = vv.height;
        if (!tallest[o] || h > tallest[o]) tallest[o] = h;
        const active = document.activeElement;
        const editing = !!active && active.matches(EDITABLE);
        const shrunk = tallest[o] - h > 120;
        const kb = editing || shrunk;
        // only write what changed: anything set on <html> makes the browser restyle the whole page
        if (kb !== lastKb) { lastKb = kb; root.classList.toggle('kb-open', kb); }
        const nh = kb ? `${Math.round(h)}px` : '';
        if (nh !== lastH) {
          lastH = nh;
          if (nh) root.style.setProperty('--app-h', nh); else root.style.removeProperty('--app-h');
        }
        // iOS scrolls the whole page to reveal the field; undo it, the layout already fits
        if (kb && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0);
      });
    };

    // The keyboard animates in: re-measure a few times after focus changes
    const settle = () => { apply(); setTimeout(apply, 150); setTimeout(apply, 400); setTimeout(apply, 800); };

    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      document.removeEventListener('focusin', settle);
      document.removeEventListener('focusout', settle);
      root.classList.remove('kb-open');
      root.style.removeProperty('--app-h');
    };
  }, []);
  return null;
}
