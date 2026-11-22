'use client';

import { useEffect, useRef, useState } from 'react';
import ClaudeLogo from '@/components/ClaudeLogo';

/**
 * Planned restarts (selfupdate): the backend announces a countdown over SSE (server-restart, relayed by
 * Sidebar as a window event). We show it at the bottom, then wait until the new process answers
 * (/api/health with a different bootId, and the frontend serving pages again) and reload the page.
 * Unplanned restarts: when the SSE stream reconnects with a different bootId we reload as well.
 * Drafts survive the reload (ChatWindow keeps them in localStorage).
 */

interface Notice { at: number; services: string[] }
type Phase = 'idle' | 'countdown' | 'waiting' | 'slow';

const POLL_MS = 1500;
const SLOW_AFTER_MS = 45_000;
const SETTLE_MS = 1500;

async function backendBoot(): Promise<string | null> {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok) return null;
    return ((await r.json()) as { bootId?: string }).bootId ?? null;
  } catch { return null; }
}

/** Build id of the frontend that answers now; null while it is down. */
async function frontendBuild(): Promise<string | null> {
  try {
    const r = await fetch(`/build-id?_r=${Date.now()}`, { cache: 'no-store', redirect: 'manual' });
    return r.ok ? (await r.text()).trim() || null : null;
  } catch { return null; }
}

async function frontendUp(): Promise<boolean> {
  // "/" answers with a 307 to /login (no auth cookie); do not follow it, any non-5xx answer means Next is up
  try {
    const r = await fetch(`/?_r=${Date.now()}`, { method: 'HEAD', cache: 'no-store', redirect: 'manual' });
    return r.type === 'opaqueredirect' || (r.status > 0 && r.status < 500);
  } catch { return false; }
}

const RELOADED = 'cc:reloaded';
/** Reload after a restart; the new page fades the same loader out instead of popping in. */
function reloadNow() {
  try { sessionStorage.setItem(RELOADED, String(Date.now())); } catch { /* ignore */ }
  window.location.reload();
}

export default function RestartWatcher() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [now, setNow] = useState(() => Date.now());
  const boot = useRef<string | null>(null);
  const build = useRef<string | null>(null);
  const announcedAt = useRef(0);
  const planned = useRef(false);
  // just reloaded by us: keep the loader up for a moment and fade it out (like a splash screen)
  const [back, setBack] = useState<'' | 'on' | 'out'>('');
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let t = 0;
    try { t = Number(sessionStorage.getItem(RELOADED)) || 0; sessionStorage.removeItem(RELOADED); } catch { /* ignore */ }
    if (!t || Date.now() - t > 60_000) return;
    setBack('on');
    const a = setTimeout(() => setBack('out'), 650);
    const b = setTimeout(() => setBack(''), 1100);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  const active = phase !== 'idle';
  useEffect(() => {
    if (!active) { setShown(false); return; }
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, [active]);

  // Remember which process we talk to; a new one after a reconnect means a restart happened.
  useEffect(() => {
    void backendBoot().then((b) => { if (b && !boot.current) boot.current = b; });
    void frontendBuild().then((b) => { if (b && !build.current) build.current = b; });
    const onHello = (e: Event) => {
      const id = (e as CustomEvent<{ bootId?: string }>).detail?.bootId;
      if (!id) return;
      // During a planned restart the poller decides (frontend may not be up yet)
      if (boot.current && boot.current !== id && !planned.current) { reloadNow(); return; }
      boot.current = id;
    };
    const onRestart = (e: Event) => {
      const d = (e as CustomEvent<Notice>).detail;
      if (!d || typeof d.at !== 'number') return;
      // replayed notice for a restart that already happened before this page loaded: nothing to wait for
      if (d.at <= performance.timeOrigin + 2000) return;
      announcedAt.current = Date.now();
      planned.current = true;
      setNotice({ at: d.at, services: Array.isArray(d.services) && d.services.length ? d.services : ['backend'] });
      setPhase(d.at > Date.now() ? 'countdown' : 'waiting');
    };
    window.addEventListener('cc:hello', onHello);
    window.addEventListener('cc:server-restart', onRestart);
    return () => {
      window.removeEventListener('cc:hello', onHello);
      window.removeEventListener('cc:server-restart', onRestart);
    };
  }, []);

  // Countdown tick
  useEffect(() => {
    if (phase !== 'countdown' || !notice) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= notice.at) setPhase('waiting');
    }, 250);
    return () => clearInterval(t);
  }, [phase, notice]);

  // Wait for the new containers, then reload
  useEffect(() => {
    if ((phase !== 'waiting' && phase !== 'slow') || !notice) return;
    const needBackend = notice.services.includes('backend');
    const needFrontend = notice.services.includes('frontend');
    const oldBoot = boot.current;
    const start = Date.now();
    let seenDown = false;
    let okCount = 0;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let ready = true;
      if (needBackend) {
        const b = await backendBoot();
        if (!b) seenDown = true;
        // No known old id: accept any answer after the backend was seen down
        ready = !!b && (oldBoot ? b !== oldBoot : seenDown);
      }
      if (ready && needFrontend) {
        // a new build id means the new frontend answers (the swap is often too quick to see it down)
        const b = await frontendBuild();
        if (!b) seenDown = true;
        ready = !!b && (build.current ? b !== build.current || Date.now() - start > 60_000 : seenDown || Date.now() - start > 45_000);
      } else if (ready && !needBackend) {
        const up = await frontendUp();
        if (!up) seenDown = true;
        // nginx only: done once it went down and came back, or after 45 s if we missed the gap
        ready = up && (seenDown || Date.now() - start > 45_000);
      }
      if (!alive) return;
      // reload only when it answered twice in a row, then give it a moment more:
      // a reload right away often hit parts that were not ready yet (a red "failed" at the top)
      okCount = ready ? okCount + 1 : 0;
      if (okCount >= 2) { setTimeout(() => { if (alive) reloadNow(); }, SETTLE_MS); return; }
      if (Date.now() - announcedAt.current > SLOW_AFTER_MS) setPhase('slow');
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 1000);
    return () => { alive = false; clearTimeout(timer); };
  }, [phase, notice]);

  if (back && (phase === 'idle' || !notice)) {
    return (
      <div className={`cc-loader on ${back === 'out' ? 'out' : ''}`} aria-live="polite">
        <div className="tile"><ClaudeLogo /></div>
        <p className="label">Weer verbonden</p>
      </div>
    );
  }
  if (phase === 'idle' || !notice) return null;

  const what = notice.services.includes('backend') ? 'De server herstart' : 'De app wordt bijgewerkt';
  const left = Math.max(0, notice.at - now);
  const secs = Math.ceil(left / 1000);

  return (
    <div className={`cc-loader ${shown ? 'on' : ''}`} role="status" aria-live="polite">
      <div className="tile"><ClaudeLogo /></div>
      <p className="label">
        {phase === 'countdown' && <>{what}<small>Herladen over {secs} s</small></>}
        {phase === 'waiting' && <>{what}<small>Opnieuw verbinden…</small></>}
        {phase === 'slow' && <>Dit duurt langer dan verwacht<small>De server is nog niet terug</small></>}
      </p>
      {phase === 'slow' && (
        <button type="button" onClick={() => reloadNow()} className="text-sm px-4 py-2 rounded-control bg-(--accent-strong) text-white">Verversen</button>
      )}
    </div>
  );
}
