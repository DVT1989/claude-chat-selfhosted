'use client';

import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import type { Message } from '@/types';

export interface ReplyQuote { id: string; role: string; name: string; text: string }

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Plain-text quote (max 200 chars) of a message, like the server makes it */
export function makeQuote(m: Message): ReplyQuote | null {
  let text = m.content ?? '';
  if (m.role === 'assistant' && text.trimStart().startsWith('[')) {
    try {
      const ev = JSON.parse(text) as Array<{ type?: string; text?: string }>;
      if (Array.isArray(ev)) text = ev.filter((e) => e.type === 'text').map((e) => e.text ?? '').join('\n');
    } catch { /* plain text */ }
  }
  text = text.replace(/```[\s\S]*?```/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\s*+-]+/gm, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  if (!text || m.id.startsWith('temp-')) return null;
  if (text.length > 200) text = text.slice(0, 199).trimEnd() + '…';
  return { id: m.id, role: m.role, name: m.role === 'assistant' ? 'Claude' : 'Jij', text };
}

export function ReplyIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
    </svg>
  );
}

/** Scrolls the message to the middle of the list and flashes its bubble. False when it is not on screen. */
export function jumpToMessage(id: string): boolean {
  const row = document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
  if (!row) return false;
  const quiet = reduced();
  row.scrollIntoView({ block: 'center', behavior: quiet ? 'auto' : 'smooth' });
  if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
  row.focus({ preventScroll: true });
  const bubble = row.querySelector<HTMLElement>('.wa-bubble');
  if (bubble) {
    bubble.classList.remove('reply-flash');
    void bubble.offsetWidth;
    bubble.classList.add('reply-flash');
    window.setTimeout(() => bubble.classList.remove('reply-flash'), 1250);
  }
  return true;
}

const SKIP = 'a,img,pre,table,button,input,textarea,video,[data-noswipe]';

/**
 * Message row: desktop reply button next to the bubble (hover/focus) and swipe-right to reply on touch.
 * The swipe moves the .wa-bubble imperatively (no re-render per pixel).
 */
export function ReplyRow({ onReply, own, className, children, ...rest }: {
  onReply?: () => void; own?: boolean; className?: string; children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  const rowRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const cbRef = useRef(onReply);
  useLayoutEffect(() => { cbRef.current = onReply; });
  const enabled = !!onReply;

  useEffect(() => {
    const row = rowRef.current;
    if (!row || !enabled) return;
    let sx = 0, sy = 0, pid = -1, mode: 'idle' | 'drag' | 'off' = 'idle', armed = false, x = 0;
    let samples: Array<{ t: number; dx: number }> = [];
    const bubble = () => row.querySelector<HTMLElement>('.wa-bubble');
    const paint = (px: number) => {
      const b = bubble(), ic = iconRef.current;
      if (b) { b.style.transition = 'none'; b.style.transform = px ? `translateX(${px}px)` : ''; }
      if (ic) {
        const quiet = reduced();
        const p = quiet ? (px >= 40 ? 1 : 0) : Math.min(1, Math.max(0, (px - 8) / 32));
        ic.style.transition = 'none';
        ic.style.opacity = String(p);
        ic.style.transform = `scale(${quiet ? 1 : 0.6 + 0.4 * p})`;
        ic.dataset.armed = armed ? '1' : '';
      }
    };
    const release = (spring: number) => {
      const b = bubble(), ic = iconRef.current;
      if (b) {
        b.style.transition = spring ? `transform ${spring}ms var(--ease-out)` : 'none';
        b.style.transform = '';
        if (!spring) b.style.removeProperty('transition');
      }
      if (ic) {
        ic.style.transition = reduced() ? 'none' : 'opacity 150ms var(--ease-out), transform 150ms var(--ease-out)';
        ic.style.opacity = '0'; ic.style.transform = 'scale(0.6)'; ic.dataset.armed = '';
      }
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      if ((e.target as Element).closest(SKIP)) { mode = 'off'; return; }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) { mode = 'off'; return; }
      sx = e.clientX; sy = e.clientY; pid = e.pointerId; mode = 'idle'; armed = false; x = 0;
      samples = [{ t: e.timeStamp, dx: 0 }];
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pid || mode === 'off') return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (mode === 'idle') {
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { mode = 'off'; return; }
        if (dx > 10 && dx > 1.5 * Math.abs(dy)) { mode = 'drag'; try { row.setPointerCapture(pid); } catch { /* ignore */ } }
        else return;
      }
      const r = Math.max(0, dx) * 0.55;
      x = r <= 40 ? r : 40 + 60 * (1 - Math.exp(-(r - 40) / 60));
      samples.push({ t: e.timeStamp, dx });
      if (samples.length > 8) samples.shift();
      const now = x >= 56;
      if (now && !armed) {
        armed = true;
        navigator.vibrate?.(10);
        if (!reduced()) iconRef.current?.animate(
          [{ transform: 'scale(1.15)' }, { transform: 'scale(1)' }],
          { duration: 180, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' });
      } else if (!now) armed = false;
      paint(x);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = -1;
      if (mode !== 'drag') { mode = 'idle'; return; }
      mode = 'idle';
      const a = samples[0], z = samples[samples.length - 1];
      const fast = !!a && !!z && z.t > a.t && z.dx >= 24 && (z.dx - a.dx) / (z.t - a.t) > 0.45;
      const hit = e.type === 'pointerup' && (x >= 56 || fast);
      release(hit ? 260 : 200);
      if (hit) cbRef.current?.();
    };
    row.addEventListener('pointerdown', down);
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);
    return () => {
      row.removeEventListener('pointerdown', down); row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', end); row.removeEventListener('pointercancel', end);
    };
  }, [enabled]);

  return (
    <div ref={rowRef} {...rest} className={clsx(className, enabled && 'reply-row relative touch-pan-y')}>
      {enabled && (
        <span ref={iconRef} aria-hidden className="reply-swipe-icon pointer-events-none absolute left-3 top-1/2 -mt-4 w-8 h-8 rounded-full flex items-center justify-center opacity-0" />
      )}
      {enabled && own && <ReplyButton onClick={onReply!} />}
      {children}
      {enabled && !own && <ReplyButton onClick={onReply!} />}
    </div>
  );
}

function ReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Reageer op dit bericht" title="Reageren"
      className="reply-btn hit-44 self-center shrink-0 hidden [@media(hover:hover)]:flex w-7 h-7 mx-1 items-center justify-center rounded-full text-(--muted) hover:text-(--text) hover:bg-(--input) focus-visible:text-(--text)">
      <ReplyIcon />
    </button>
  );
}

/** Quote at the top of a sent bubble: tap jumps to the original message */
export function QuoteInBubble({ quote, own }: { quote: ReplyQuote; own?: boolean }) {
  const [gone, setGone] = useState(false);
  const bar = quote.role === 'assistant' ? 'var(--accent)' : '#6b7bff';
  const style = { background: `color-mix(in srgb, var(--text) ${own ? 10 : 8}%, transparent)`, boxShadow: `inset 3px 0 0 ${bar}` };
  const body = gone ? (
    <span className="block text-[13px]" style={{ color: 'color-mix(in srgb, var(--text) 78%, transparent)' }}>Oorspronkelijk bericht niet beschikbaar</span>
  ) : (<>
    <span className="block text-xs font-semibold text-(--text)">{quote.name}</span>
    <span className="block text-[13px] line-clamp-2 break-words" style={{ color: 'color-mix(in srgb, var(--text) 78%, transparent)' }}>{quote.text}</span>
  </>);
  const cls = 'block w-full text-left mb-1 rounded-md py-1 pr-2 pl-2.5';
  return gone ? <div className={cls} style={style}>{body}</div> : (
    <button type="button" data-noswipe onClick={() => { if (!jumpToMessage(quote.id)) setGone(true); }}
      aria-label={`Ga naar het bericht van ${quote.name}`} className={clsx(cls, 'cursor-pointer')} style={style}>{body}</button>
  );
}

/** Quote above the textarea in the composer; grows and shrinks smoothly */
export function ComposerQuote({ quote, onClear }: { quote: ReplyQuote | null; onClear: () => void }) {
  const [last, setLast] = useState<ReplyQuote | null>(quote);
  useEffect(() => {
    if (quote) { setLast(quote); return; }
    const t = setTimeout(() => setLast(null), 220);
    return () => clearTimeout(t);
  }, [quote]);
  const q = quote ?? last;
  return (
    <div className={clsx('reply-compose grid', quote ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')} aria-hidden={!quote}>
      <div className="overflow-hidden min-h-0">
        {q && (
          <div className="flex items-center gap-2 mb-2 rounded-[10px] py-1.5 pr-1.5 pl-2.5"
            style={{ background: 'color-mix(in srgb, var(--text) 6%, transparent)', boxShadow: 'inset 3px 0 0 var(--accent)' }}>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-(--text)">{q.name}</div>
              <div className="text-[13px] text-(--muted) truncate">{q.text}</div>
            </div>
            <button type="button" tabIndex={quote ? 0 : -1} onClick={onClear} aria-label="Citaat verwijderen"
              className="hit-44 w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-(--muted) hover:text-(--text) hover:bg-(--border) transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
