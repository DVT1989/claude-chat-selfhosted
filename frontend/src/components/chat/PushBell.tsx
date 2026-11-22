'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { conversations as convApi } from '@/lib/api';

// Several bells for one conversation (desktop header and phone top bar) stay in step
const EV = 'cc:push-on';

/** Bell in the conversation header: push notifications are off by default and switched on per conversation. */
export default function PushBell({ conversationId, className }: { conversationId: string; className?: string }) {
  const [on, setOn] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    convApi.getPush(conversationId).then((r) => { if (alive) setOn(r.on); }).catch(() => undefined);
    const sync = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; on: boolean }>).detail;
      if (d?.id === conversationId) setOn(d.on);
    };
    window.addEventListener(EV, sync);
    return () => { alive = false; window.removeEventListener(EV, sync); };
  }, [conversationId]);

  async function toggle() {
    if (on === null) return;
    const next = !on;
    const tell = (v: boolean) => window.dispatchEvent(new CustomEvent(EV, { detail: { id: conversationId, on: v } }));
    setOn(next); tell(next);
    try { await convApi.setPush(conversationId, next); }
    catch { setOn(!next); tell(!next); }
  }

  const label = on ? 'Meldingen voor dit gesprek staan aan' : 'Meldingen voor dit gesprek staan uit';
  return (
    <button type="button" onClick={() => void toggle()} disabled={on === null} title={`${label} (tik om te wisselen)`} aria-label={label} aria-pressed={!!on}
      className={clsx('w-10 h-10 shrink-0 flex items-center justify-center rounded-full transition-colors hover:bg-(--input) active:bg-(--input) disabled:opacity-40',
        on ? 'text-(--accent)' : 'text-(--muted)', className)}>
      <svg className="w-[21px] h-[21px]" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" fill="none" />
        {!on && <path d="M3 3l18 18" fill="none" />}
      </svg>
    </button>
  );
}
