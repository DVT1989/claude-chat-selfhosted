'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';
import clsx from 'clsx';
import { useChatStore } from '@/lib/store';
import { conversations as convApi } from '@/lib/api';
import ConvAvatar from '@/components/ConvAvatar';
import { NavIcons } from '@/components/navItems';

/** WhatsApp-style time: 20:28 today, Gisteren, weekday this week, otherwise the date */
function timeLabel(iso: string): string {
  const d = new Date(iso);
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const DAY = 86_400_000;
  if (d >= startOfToday) return format(d, 'HH:mm');
  if (d.getTime() >= startOfToday.getTime() - DAY) return 'Gisteren';
  // short weekday plus time ("wo 18:00"): the full name ("woensdag") did not fit the time column
  if (d.getTime() >= startOfToday.getTime() - 6 * DAY) return format(d, 'EEEEEE HH:mm', { locale: nl });
  return format(d, 'dd-MM-yy');
}

/**
 * The conversation list: header with "Chats" and a new-conversation button, search, rows.
 * variant "pane": the desktop column next to the rail. variant "page": the phone's Chats screen.
 */
export default function ConversationList({ variant }: { variant: 'pane' | 'page' }) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { conversations, addConversation, removeConversation } = useChatStore();
  const [search, setSearch] = useState('');
  // the staggered entrance only when the list first appears, not while searching
  const [entered, setEntered] = useState(false);
  useEffect(() => { const t = setTimeout(() => setEntered(true), 900); return () => clearTimeout(t); }, []);
  const activeId = pathname.split('/')[2];

  async function newConversation() {
    try {
      const res = await convApi.create({ title: 'Nieuw gesprek' });
      addConversation(res.conversation);
      router.push(`/chat/${res.conversation.id}`);
    } catch { /* ignore */ }
  }

  async function deleteConversation(e: React.SyntheticEvent | null, id: string, title: string) {
    e?.preventDefault();
    e?.stopPropagation();
    if (!confirm(`Gesprek "${title}" verwijderen?`)) return;
    try {
      await convApi.delete(id);
      removeConversation(id);
      if (pathname === `/chat/${id}`) router.push('/chat');
    } catch { /* ignore */ }
  }

  // Phones have no hover (the trash icon): hold a row to delete it; right-click does the same on desktop
  const press = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });
  function startPress(id: string, title: string) {
    press.current.fired = false;
    press.current.timer = window.setTimeout(() => {
      press.current.fired = true;
      navigator.vibrate?.(12);
      void deleteConversation(null, id, title);
    }, 550);
  }
  function cancelPress() {
    if (press.current.timer) window.clearTimeout(press.current.timer);
    press.current.timer = null;
  }

  const needle = search.trim().toLowerCase();
  const matches = (c: (typeof conversations)[number]) => !needle || c.title.toLowerCase().includes(needle) || (c.last_message?.preview ?? '').toLowerCase().includes(needle);
  const visible = conversations.filter(matches);

  return (
    <section aria-label="Gesprekken" className={clsx('flex flex-col h-full min-h-0', variant === 'pane' ? 'wa-pane w-[340px] shrink-0' : 'w-full')}>
      <div className="flex items-center justify-between gap-2 pl-4 pr-3 pb-3" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)' }}>
        <h1 className="font-bold text-(--text) text-[22px] tracking-tight">Chats</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => void newConversation()} title="Nieuw gesprek" aria-label="Nieuw gesprek"
            className="wa-new w-10 h-10 shrink-0 rounded-full flex items-center justify-center">
            {NavIcons.plus('w-5 h-5')}
          </button>
        </div>
      </div>

      <div className="px-4 pb-2">
        <label className="wa-search flex items-center gap-3 w-full px-4 h-10 text-sm text-(--text) cursor-text">
          <span className="text-(--muted)">{NavIcons.search('w-4 h-4')}</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Zoeken…"
            aria-label="Gesprekken zoeken"
            autoComplete="off"
            className="w-full bg-transparent text-sm text-(--text) placeholder:text-(--muted) focus:outline-none"
          />
        </label>
      </div>

      <div className="wa-list flex-1 overflow-y-auto overscroll-contain">
        <div className={clsx('conv-row', visible.length > 0 && 'conv-row-hidden')}>
          <div>
            <p className="text-(--muted) text-xs text-center py-8 px-4">
              {needle ? 'Niets gevonden.' : 'Geen gesprekken. Tik op + om te starten.'}
            </p>
          </div>
        </div>
        {conversations.map((conv, i) => {
          const last = conv.last_message;
          const hidden = !matches(conv);
          return (
            // all rows stay in the list: a search folds the others away and opens them again smoothly
            <div key={conv.id} className={clsx('conv-row', hidden && 'conv-row-hidden')} inert={hidden || undefined}>
            <div>
            {/* rows slide in one after another when the list first appears (first screenful only) */}
            <div className={clsx('group relative', !entered && 'wa-row-in')} style={{ '--i': Math.min(i, 14) } as React.CSSProperties}>
              <Link
                href={`/chat/${conv.id}`}
                title={`${conv.title} · ${formatDistanceToNow(new Date(conv.updated_at), { addSuffix: true, locale: nl })}`}
                className={clsx('wa-row flex items-center gap-3 pl-4', variant === 'pane' && activeId === conv.id && 'wa-row-on')}
                onTouchStart={() => startPress(conv.id, conv.title)}
                onTouchMove={cancelPress}
                onTouchEnd={cancelPress}
                onContextMenu={(e) => { cancelPress(); void deleteConversation(e, conv.id, conv.title); }}
                onClick={(e) => { if (press.current.fired) { e.preventDefault(); press.current.fired = false; } }}
              >
                <ConvAvatar id={conv.id} title={conv.title} />
                {/* Fixed time column, so every title and preview ends at the same x */}
                <span className="wa-row-text flex-1 min-w-0 self-stretch grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto] content-center gap-x-2 gap-y-0.5 pr-4">
                  <span className="truncate text-[15px] leading-5 text-(--text)">{conv.title}</span>
                  <span className="text-right text-xs leading-5 text-(--muted) whitespace-nowrap shrink-0 min-w-[3.4rem] tabular-nums">{timeLabel(conv.updated_at)}</span>
                  <span className="col-span-2 block truncate text-[13.5px] leading-5 text-(--muted) [@media(hover:hover)]:group-hover:pr-8">
                    {last
                      ? <>{last.role === 'user' && <span>Jij: </span>}{last.preview || 'Gebruikte tools'}</>
                      : 'Nog geen berichten'}
                  </span>
                </span>
              </Link>
              <button
                onClick={(e) => void deleteConversation(e, conv.id, conv.title)}
                title="Verwijderen"
                aria-label={`${conv.title} verwijderen`}
                className="absolute right-2 bottom-2.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity
                           w-7 h-7 flex items-center justify-center rounded-lg text-(--muted) hover:text-red-400 hover:bg-red-500/10"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
            </div>
            </div>
          );
        })}
        {variant === 'page' && visible.length > 0 && (
          <p className="text-[11.5px] text-(--muted) text-center py-4 px-6">Houd een gesprek ingedrukt om het te verwijderen.</p>
        )}
      </div>
    </section>
  );
}
