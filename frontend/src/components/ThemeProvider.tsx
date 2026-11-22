'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/lib/store';

const DEFAULT_ACCENT = '#CC785C';

function applyMode(mode: 'light' | 'dark' | 'system') {
  let resolved: 'light' | 'dark';
  if (mode === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    resolved = mode;
  }
  document.documentElement.dataset.theme = resolved;
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themeMode = useAuthStore((s) => s.user?.theme_mode ?? null);
  const accentColor = useAuthStore((s) => s.user?.accent_color ?? null);
  const bgMotion = useAuthStore((s) => s.user?.preferences?.bg_motion);

  useEffect(() => {
    // Use saved mode from store (when logged in) or fallback to localStorage
    const mode = themeMode ?? (typeof window !== 'undefined' ? localStorage.getItem('theme_mode') : null) ?? 'system';
    applyMode(mode as 'light' | 'dark' | 'system');
    if (themeMode) {
      try { localStorage.setItem('theme_mode', themeMode); } catch { /* ignore */ }
    }
    if (mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyMode('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [themeMode]);

  useEffect(() => {
    const accent = accentColor ?? (typeof window !== 'undefined' ? localStorage.getItem('accent_color') : null) ?? DEFAULT_ACCENT;
    document.documentElement.style.setProperty('--accent', accent);
    if (accentColor) {
      try { localStorage.setItem('accent_color', accentColor); } catch { /* ignore */ }
    }
  }, [accentColor]);

  // Moving background orbs: on unless switched off in Profiel, or the device asks for less motion
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('bg_motion') : null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const on = bgMotion ?? (saved !== null ? saved === '1' : !reduce);
    document.documentElement.classList.toggle('bg-motion', on);
    if (bgMotion !== undefined) { try { localStorage.setItem('bg_motion', bgMotion ? '1' : '0'); } catch { /* ignore */ } }
  }, [bgMotion]);

  return <>{children}</>;
}
