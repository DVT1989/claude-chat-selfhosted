'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { usage as usageApi, type AnthropicUsage, type UsageWindow } from '@/lib/api';

const POLL_MS = 45_000;

function resetLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  if (d.getTime() - Date.now() < 24 * 3_600_000) return `reset om ${time}`;
  return `reset ${d.toLocaleDateString('nl-NL', { weekday: 'long' })} ${time}`;
}

function dot(pct: number): string {
  if (pct >= 95) return 'bg-(--bad)';
  if (pct >= 80) return 'bg-(--warn)';
  return 'bg-(--ok)';
}

/** Compact reset for the meter line: "18:00" within a day, otherwise the short weekday ("vr 09:00") */
function resetShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  if (d.getTime() - Date.now() < 24 * 3_600_000) return time;
  return `${d.toLocaleDateString('nl-NL', { weekday: 'short' }).replace('.', '')} ${time}`;
}

/** Counts from the previous value to the new one (~500 ms ease-out) when it moved 1 point or more. */
function useCountUp(target: number): number {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    if (Math.abs(target - start) < 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = target; setV(target); return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 500);
      const cur = start + (target - start) * (1 - Math.pow(1 - k, 3));
      from.current = cur; setV(cur);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

/** text dimming for old data: only label and numbers, the dots keep full colour (contrast, review Designer) */
const DIM = 'opacity-80 dark:opacity-75';

/** always: show the reset on phones too (only the session; the week reset would not fit) */
function Inline({ label, w, always = false, stale = '' }: { label: string; w: UsageWindow; always?: boolean; stale?: string }) {
  const pct = Math.round(w.pct);
  const shownPct = Math.round(useCountUp(pct));
  const short = resetShort(w.resetAt);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={`${label}: ${pct}% gebruikt, ${resetLabel(w.resetAt)}${stale ? ` (laatst bijgewerkt ${stale})` : ''}`}>
      <span className={clsx('w-1.5 h-1.5 rounded-full transition-colors duration-300 motion-reduce:transition-none', dot(w.pct))} aria-hidden />
      <span className={clsx('transition-opacity duration-300 motion-reduce:transition-none', stale && DIM)}>{label}</span>
      <span className={clsx('tabular-nums transition-opacity duration-300 motion-reduce:transition-none', pct >= 80 && 'text-(--text)', stale && DIM)}>{shownPct}%</span>
      {/* the reset is visible, not only in the tooltip (UI #16); not dimmed further when stale */}
      {short && <span className={clsx('tabular-nums', stale ? DIM : 'opacity-80', !always && 'hidden sm:inline')}>· <span className="hidden sm:inline">reset </span>{short}</span>}
    </span>
  );
}

type Shown = { data: AnthropicUsage; acct: { n: number; total: number; email: string | null } | null };

const STORE_KEY = 'cc:usage-meter';
/** older than this counts as not current (dimmed), even when the backend did not flag it */
const OLD_MS = 3 * 60_000;

/** ChatWindow fires this after every finished answer (done event) */
export const USAGE_REFRESH_EVENT = 'cc:usage-refresh';

function readStored(): Shown | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? (JSON.parse(raw) as Shown) : null;
    return v && v.data && (v.data.session || v.data.weekly) ? v : null;
  } catch { return null; }
}

function timeLabel(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return Date.now() - d.getTime() > 20 * 3_600_000 ? `${d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} ${time}` : time;
}

/**
 * Claude subscription usage (current 5-hour session + week) as one line under the chat composer:
 * "● Sessie 44%  ● Week 78%". The dot turns amber at 80% and red at 95%; the tooltip shows the reset.
 * Always visible: the last known values come from localStorage before the first fetch, and a failed
 * fetch keeps them (dimmed, tooltip "laatst bijgewerkt hh:mm"). Refreshes every 45 s, on focus and
 * right after every finished answer.
 */
export default function UsageMeter() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const stored = readStored();
    if (stored) setShown(stored);
    const load = (fresh = false) => usageApi.get(fresh).then((r) => {
      if (!alive) return;
      setNow(Date.now());
      const d = r.anthropic;
      if (!d || (!d.session && !d.weekly)) return; // nothing known: keep what is shown
      const list = r.accounts ?? [];
      const active = list.find((a) => a.active);
      const next: Shown = { data: d, acct: list.length > 1 && active ? { n: active.slot + 1, total: list.length, email: active.email } : null };
      setShown(next);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    }).catch(() => { if (alive) setNow(Date.now()); });
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    const onFocus = () => { void load(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    // the answer's usage reaches the endpoint a moment later: ask fresh shortly after done
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    const onDone = () => { clearTimeout(doneTimer); doneTimer = setTimeout(() => { void load(true); }, 1500); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(USAGE_REFRESH_EVENT, onDone);
    return () => {
      alive = false; clearInterval(t); clearTimeout(doneTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(USAGE_REFRESH_EVENT, onDone);
    };
  }, []);

  // crossfade (200 ms) from the empty line to the first data
  const [skel, setSkel] = useState(true);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setSkel(false), 200);
    return () => clearTimeout(t);
  }, [shown]);

  const empty = (
    <div className={clsx('flex items-center gap-3 min-w-0 overflow-hidden text-xs text-(--muted) transition-opacity duration-200 motion-reduce:transition-none [grid-area:1/1]', shown && 'opacity-0')}
      role="status" aria-label="Claude-gebruik wordt geladen">
      <span className="usage-pulse inline-flex items-center gap-1.5 whitespace-nowrap"><span className="w-1.5 h-1.5 rounded-full bg-(--border)" aria-hidden />Sessie <span className="tabular-nums" aria-hidden>--</span></span>
      <span className="usage-pulse inline-flex items-center gap-1.5 whitespace-nowrap"><span className="w-1.5 h-1.5 rounded-full bg-(--border)" aria-hidden />Week <span className="tabular-nums" aria-hidden>--</span></span>
    </div>
  );

  if (!shown) return <div className="grid min-w-0">{empty}</div>;

  const { data, acct } = shown;
  const fetchedMs = data.fetchedAt ? Date.parse(data.fetchedAt) : NaN;
  const old = !!data.stale || (Number.isFinite(fetchedMs) && now - fetchedMs > OLD_MS);
  const updated = timeLabel(data.fetchedAt);
  const staleLabel = old ? updated : '';

  return (
    <div className="grid min-w-0">
      {skel && empty}
      <div className={clsx('flex items-center gap-3 min-w-0 overflow-hidden text-xs text-(--muted) [grid-area:1/1]', skel && 'animate-[dgFadeIn_200ms_ease_both] motion-reduce:animate-none')}
        role="status"
        aria-label={staleLabel ? `Claude-gebruik, laatst bijgewerkt ${staleLabel}` : 'Claude-gebruik'}
        title={staleLabel ? `Laatst bijgewerkt ${staleLabel}` : undefined}>
        {acct && (
          <span className="px-1.5 py-0.5 rounded-md border border-(--border) text-(--text) tabular-nums whitespace-nowrap"
            title={`Claude-account ${acct.n} van ${acct.total}${acct.email ? ` (${acct.email})` : ''}`}>
            Acc {acct.n}
          </span>
        )}
        {data.session && <Inline label="Sessie" w={data.session} always stale={staleLabel} />}
        {data.weekly && <Inline label="Week" w={data.weekly} stale={staleLabel} />}
        {/* old data is visible without hover too (phones): a small clock with the time of the last reading */}
        {staleLabel && (
          <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap tabular-nums', DIM)}>
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
            </svg>
            {staleLabel}
          </span>
        )}
      </div>
    </div>
  );
}
