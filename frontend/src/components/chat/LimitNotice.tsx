'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';

/**
 * UI #26 (design Designer): one notice for the usage limit.
 * Live: a small card under the answer (prompt, scheduled, switched, resumed, cancelled). The short-lived
 * states hold for a few seconds, then the card shrinks into a compact line and leaves.
 * History: compact muted lines (LimitLine), no yellow frame.
 */

export type LimitStatus = 'prompt' | 'scheduled' | 'switched' | 'resumed' | 'cancelled';

/** 24-hour time in the viewer's time zone, like the bubble times. */
export function limitTime(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** For a moment still to come: the time, "morgen 09:00" or a short date when not today. */
export function limitWhen(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  const t = limitTime(date);
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === now.toDateString()) return t;
  if (date.toDateString() === tomorrow.toDateString()) return `morgen ${t}`;
  return `${date.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
}

/** "Over 12 min", "Over 1 u 5 min", "Over minder dan een minuut". */
export function untilText(target: Date | null, now: number): string {
  if (!target) return '';
  const min = Math.ceil((target.getTime() - now) / 60_000);
  if (min <= 1) return 'Over minder dan een minuut';
  if (min < 60) return `Over ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `Over ${h} u ${m} min` : `Over ${h} u`;
}

/** "nog 12 min", "nog 1 u 5 min", "nog minder dan een minuut". */
export function nogText(target: Date | null, now: number): string {
  return untilText(target, now).replace(/^Over/, 'nog');
}

/** Ticks every 30 s while `on`, for the countdown. */
export function useTick(on: boolean, ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

/** How long a state stays as a card before it shrinks (ms); undefined = stays until something changes it. */
const HOLD: Partial<Record<LimitStatus, number>> = { switched: 3500, resumed: 3000, cancelled: 6000 };
const COLLAPSE_MS = 240;
const LINE_MS = 1200;

export const LimitIcon = {
  warn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
    </svg>
  ),
  swap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 13l4 4L19 7" />
    </svg>
  ),
  off: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" /><path d="m9 9 6 6m0-6-6 6" />
    </svg>
  ),
};

export function LimitNotice({ status, resetAt, at, canSchedule, scheduleLoading, onSchedule, onCancel, onDismiss, onGone }: {
  status: LimitStatus;
  /** the moment it continues (scheduled) or the reset time (prompt) */
  resetAt: Date | null;
  /** when this state began (resumed: the moment the run continued) */
  at?: Date;
  canSchedule?: boolean;
  scheduleLoading?: boolean;
  onSchedule?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
  /** the short-lived states call this once they have left */
  onGone?: () => void;
}) {
  const [phase, setPhase] = useState<'card' | 'line' | 'out'>('card');
  useEffect(() => {
    setPhase('card');
    const hold = HOLD[status];
    if (hold === undefined) return;
    const t1 = setTimeout(() => setPhase('line'), hold);
    const t2 = setTimeout(() => setPhase('out'), hold + COLLAPSE_MS + LINE_MS);
    const t3 = setTimeout(() => onGone?.(), hold + COLLAPSE_MS + LINE_MS + COLLAPSE_MS + 40);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const now = useTick(status === 'scheduled');

  const tone = status === 'prompt' || status === 'scheduled' ? 'warn' : status === 'cancelled' ? 'muted' : 'ok';
  const icon = status === 'prompt' ? LimitIcon.warn : status === 'scheduled' ? LimitIcon.clock
    : status === 'switched' ? LimitIcon.swap : status === 'resumed' ? LimitIcon.check : LimitIcon.off;
  const t = limitWhen(resetAt);
  const title = status === 'prompt' ? `Gebruikslimiet bereikt${t ? `, reset om ${t}` : ''}`
    : status === 'scheduled' ? `Wacht op de limiet. ${t ? `Gaat om ${t} vanzelf verder` : 'Gaat vanzelf verder'}`
    : status === 'switched' ? 'Gewisseld naar je andere account. Het werk loopt door.'
    : status === 'resumed' ? `Hervat om ${limitTime(at ?? new Date())}`
    : 'Automatisch hervatten geannuleerd';

  return (
    <div className="limit-notice msg-in mx-4 md:mx-6 my-2" data-tone={tone} data-phase={phase}>
      <div className="ln-outer"><div className="min-h-0">
        <div className="ln-card">
          <div className="flex items-start gap-3">
            <span className="ln-icon">{icon}</span>
            <div className="flex-1 min-w-0" role="status" aria-live="polite">
              <p className="ln-title">{title}</p>
              {(status === 'prompt' || status === 'scheduled') && (
                <div className="ln-more"><div className="min-h-0">
                  {status === 'prompt' ? (
                    <p className="ln-sub">{t ? 'Wil je dat ik dan automatisch verder ga?' : 'Probeer het later opnieuw.'}</p>
                  ) : (
                    <p className="ln-sub">
                      {resetAt && <span aria-hidden>{untilText(resetAt, now)}. </span>}
                      Eerder als een account weer ruimte heeft.
                    </p>
                  )}
                  {status === 'prompt' && canSchedule && (
                    <div className="flex gap-2 mt-2.5">
                      <button type="button" onClick={onSchedule} disabled={scheduleLoading} className="ln-btn ln-btn-main">
                        {scheduleLoading ? 'Inplannen…' : 'Ja, plan in'}
                      </button>
                      <button type="button" onClick={onDismiss} className="ln-btn">Nee</button>
                    </div>
                  )}
                </div></div>
              )}
            </div>
            {status === 'scheduled' && (
              <button type="button" onClick={onCancel} className={clsx('ln-btn shrink-0', phase !== 'card' && 'invisible')}>Annuleren</button>
            )}
            {status === 'prompt' && (
              <button type="button" onClick={onDismiss} title="Sluiten" aria-label="Sluiten" className="ln-close shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
        </div>
      </div></div>
    </div>
  );
}

/** A compact muted line in the history, in the style of the "automatically continued" pill. */
export function LimitLine({ icon, children }: { icon: keyof typeof LimitIcon; children: React.ReactNode }) {
  return (
    <div className="flex justify-center px-3 py-1.5">
      <span className="limit-line inline-flex items-center gap-1.5 text-xs text-(--muted) px-3 py-1 rounded-full border border-(--border)"
        style={{ background: 'color-mix(in srgb, var(--g-bg-base) 80%, transparent)' }}>
        <span className="w-3.5 h-3.5 shrink-0 [&>svg]:w-full [&>svg]:h-full">{LimitIcon[icon]}</span>
        {children}
      </span>
    </div>
  );
}

export type LimitEvent =
  | { type: 'rate_limited'; resetAt: string | null; message?: string; at?: string }
  | { type: 'limit_note'; kind: 'switched'; at?: string }
  | { type: 'limit_note'; kind: 'owner_full'; owner?: string; at?: string };

/** The history line for a stored limit event. */
export function LimitEventLine({ ev }: { ev: LimitEvent }) {
  if (ev.type === 'limit_note' && ev.kind === 'owner_full') {
    return <LimitLine icon="swap">{`Account van ${ev.owner ?? 'de eigenaar'} is vol, deze werkplek draait op je eigen account`}</LimitLine>;
  }
  if (ev.type === 'limit_note') {
    const t = limitTime(ev.at);
    return <LimitLine icon="swap">{t ? `Gewisseld om ${t}` : 'Gewisseld naar je andere account'}</LimitLine>;
  }
  const hit = limitTime(ev.at);
  const on = limitTime(ev.resetAt);
  return <LimitLine icon="clock">{hit ? `Limiet bereikt om ${hit}` : `Gebruikslimiet bereikt${on ? ` · verder om ${on}` : ''}`}</LimitLine>;
}
