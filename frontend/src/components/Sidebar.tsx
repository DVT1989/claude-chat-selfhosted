'use client';

import { useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import clsx from 'clsx';
import { useChatStore, useAuthStore } from '@/lib/store';
import { conversations as convApi, auth as authApi, projectsApi } from '@/lib/api';
import UserAvatar from '@/components/UserAvatar';
import ConversationList from '@/components/ConversationList';
import { NavIcons, isNavActive, isItemActive, navColor, type NavItem } from '@/components/navItems';
import { useTranslations } from '@/lib/i18n';
import { useNav } from '@/components/useNav';
import { useNavIndicator } from '@/components/useNavIndicator';

/**
 * Desktop navigation, WhatsApp / Outlook style: a narrow icon rail (Chats, Telegram, every
 * settings section) and, on the chat pages, the conversation list next to it.
 * It also keeps the data fresh on every screen size (user, conversation list, live updates);
 * on phones the rail is replaced by MobileTabBar and the list is the /chat page itself.
 */
export default function Sidebar({ withList = true }: { withList?: boolean }) {
  const t = useTranslations('sidebar');
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { setConversations, setProjects, setRefreshConversationId } = useChatStore();
  const { setUser } = useAuthStore();
  const { top, groups } = useNav();
  // gliding marker on the rail's left edge, in the active section's colour
  const { ref: railRef, box: railBox } = useNavIndicator<HTMLElement>(pathname);
  const activeItem = [...top, ...groups.flat()].find((i) => isItemActive(pathname, i));
  const activeColor = activeItem ? (activeItem.color ?? navColor(activeItem.href)) : 'var(--accent)';
  // Rail tooltip: fixed-position (portal) so the scrolling rail and the list pane cannot cover it
  const [tip, setTip] = useState<{ label: string; y: number } | null>(null);
  const tipProps = (label: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ label, y: r.top + r.height / 2 });
    },
    onMouseLeave: () => setTip(null),
  });

  const loadConversations = useCallback(async () => {
    try {
      const res = await convApi.list();
      setConversations(res.conversations);
    } catch { /* ignore */ }
    try {
      const pr = await projectsApi.list();
      setProjects(pr.projects);
    } catch { /* ignore */ }
  }, [setConversations, setProjects]);

  // Keep user store fresh (persist provides instant load; this syncs latest from server)
  useEffect(() => {
    authApi.me().then((res) => setUser((res as { user: import('@/types').User }).user)).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SSE for real-time conversation updates
  useEffect(() => {
    loadConversations();

    // Reconnects by itself: a 502 while the backend restarts closes an EventSource for good.
    // hello / server-restart are passed on to RestartWatcher as window events.
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let first = true;
    const connect = () => {
      if (stopped) return;
      const src = new EventSource('/api/claude-ai/events', { withCredentials: true });
      es = src;
      src.addEventListener('conversation-update', (e: MessageEvent) => {
        loadConversations();
        try {
          const data = JSON.parse(e.data) as { action?: string; conversationId?: string; memberIds?: string[]; userId?: string };
          if (data.action === 'resumed' && data.conversationId) {
            setRefreshConversationId(data.conversationId);
          }
          // a member of a shared project wrote or got an answer: refresh that chat for the others
          const me = useAuthStore.getState().user?.id;
          if (data.action === 'shared' && data.conversationId && me && data.userId !== me && data.memberIds?.includes(me)) {
            setRefreshConversationId(data.conversationId);
            window.dispatchEvent(new CustomEvent('cc:shared', { detail: data }));
          }
        } catch { /* ignore */ }
      });
      src.addEventListener('shared-typing', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data) as { userId?: string; memberIds?: string[] };
          const me = useAuthStore.getState().user?.id;
          if (me && d.userId !== me && d.memberIds?.includes(me)) window.dispatchEvent(new CustomEvent('cc:typing', { detail: d }));
        } catch { /* ignore */ }
      });
      src.addEventListener('hello', (e: MessageEvent) => {
        if (!first) loadConversations();
        first = false;
        try { window.dispatchEvent(new CustomEvent('cc:hello', { detail: JSON.parse(e.data) })); } catch { /* ignore */ }
      });
      // a device came online or went offline: device pages reload their list
      src.addEventListener('devices-changed', () => { window.dispatchEvent(new CustomEvent('cc:devices-changed')); });
      src.addEventListener('server-restart', (e: MessageEvent) => {
        try { window.dispatchEvent(new CustomEvent('cc:server-restart', { detail: JSON.parse(e.data) })); } catch { /* ignore */ }
      });
      src.onerror = () => {
        if (src.readyState === EventSource.CLOSED && !stopped) {
          clearTimeout(retry);
          retry = setTimeout(connect, 3000);
        }
      };
    };
    connect();

    return () => { stopped = true; clearTimeout(retry); es?.close(); };
  }, [loadConversations, setRefreshConversationId]);

  async function handleLogout() {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      router.push('/login');
    }
  }

  function railLink(item: NavItem) {
    const on = isItemActive(pathname, item);
    const icon = item.icon === NavIcons.claude ? NavIcons.claudeWhite : item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-label={item.label}
        aria-current={on ? 'page' : undefined}
        className={clsx('rail-btn', on && 'rail-btn-on')}
        style={{ '--c': item.color ?? navColor(item.href) } as React.CSSProperties}
        {...tipProps(item.label)}
      >
        <span className="rail-tile">{icon('w-6 h-6')}</span>
      </Link>
    );
  }

  return (
    <aside className="hidden md:flex h-full shrink-0">
      {/* Icon rail */}
      <nav ref={railRef} aria-label={t('mainMenu')} className="wa-rail flex flex-col items-center w-[72px] shrink-0 h-full py-2.5">
        {railBox && (
          <span aria-hidden className={clsx('rail-ind', railBox.animate && 'is-anim')}
            style={{ transform: `translateY(${railBox.y + railBox.h / 2 - 11}px)`, background: activeColor }} />
        )}
        <div className="flex flex-col items-center gap-1">
          {top.map((i) => railLink(i))}
        </div>
        <div className="rail-sep" />
        <div className="flex-1 min-h-0 w-full overflow-y-auto rail-scroll flex flex-col items-center gap-1">
          {groups.map((items, gi) => (
            <div key={items[0].href} className="flex flex-col items-center gap-1 w-full">
              {gi > 0 && <div className="rail-sep" />}
              {items.map((i) => railLink(i))}
            </div>
          ))}
        </div>
        <div className="rail-sep" />
        <button onClick={() => void handleLogout()} aria-label={t('logoutTip')} className="rail-btn rail-btn-plain rail-btn-danger" {...tipProps(t('logoutTip'))}>
          <span className="rail-tile">{NavIcons.logout('w-6 h-6')}</span>
        </button>
        <Link
          href="/settings/profiel"
          aria-label={t('profile')}
          className={clsx('rail-avatar mt-1', isNavActive(pathname, '/settings/profiel') && 'rail-avatar-on')}
          {...tipProps(t('profile'))}
        >
          <UserAvatar />
        </Link>
        {tip && createPortal(<div className="rail-tip" role="tooltip" style={{ top: tip.y }}>{tip.label}</div>, document.body)}
      </nav>

      {withList && <ConversationList variant="pane" />}
    </aside>
  );
}
