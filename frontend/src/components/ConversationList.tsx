'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { format, formatDistanceToNow } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import type { Locale } from 'date-fns';
import { useLocale, useTranslations } from '@/lib/i18n';
import clsx from 'clsx';
import { useChatStore } from '@/lib/store';
import { conversations as convApi, projectsApi } from '@/lib/api';
import ConvAvatar from '@/components/ConvAvatar';
import { NavIcons } from '@/components/navItems';
import AvatarStack from '@/components/AvatarStack';
import ShareDialog from '@/components/ShareDialog';
import ProjectDialog, { ProjectTile, projectColor } from '@/components/ProjectDialog';
import type { Project } from '@/types';

/** WhatsApp-style time: 20:28 today, Gisteren, weekday this week, otherwise the date */
function timeLabel(iso: string, yesterday: string, loc: Locale): string {
  const d = new Date(iso);
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const DAY = 86_400_000;
  if (d >= startOfToday) return format(d, 'HH:mm');
  if (d.getTime() >= startOfToday.getTime() - DAY) return yesterday;
  // short weekday plus time ("wo 18:00"): the full name ("woensdag") did not fit the time column
  if (d.getTime() >= startOfToday.getTime() - 6 * DAY) return format(d, 'EEEEEE HH:mm', { locale: loc });
  return format(d, 'dd-MM-yy');
}

/**
 * The conversation list: header with "Chats" and a new-conversation button, search, rows.
 * variant "pane": the desktop column next to the rail. variant "page": the phone's Chats screen.
 */
export default function ConversationList({ variant }: { variant: 'pane' | 'page' }) {
  const router = useRouter();
  const t = useTranslations('conversations');
  const loc = useLocale().locale === 'nl' ? nl : enUS;
  const pathname = usePathname() ?? '';
  const { conversations, addConversation, removeConversation, updateConversation, projects, setProjects, listTab, openProjectId, setListView } = useChatStore();
  const [search, setSearch] = useState('');
  // the staggered entrance only when the list first appears, not while searching
  const [entered, setEntered] = useState(false);
  useEffect(() => { const t = setTimeout(() => setEntered(true), 900); return () => clearTimeout(t); }, []);
  const activeId = pathname.split('/')[2];
  const [plusOpen, setPlusOpen] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'edit' | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; view: 'main' | 'move' } | null>(null);
  const plusRef = useRef<HTMLDivElement>(null);

  // the open project stays rendered while the pane slides back, so it does not blank out mid-animation
  const [shareOpen, setShareOpen] = useState(false);
  const [unread, setUnread] = useState<{ conversations: Record<string, number>; projects: Record<string, number> }>({ conversations: {}, projects: {} });
  const openProject = projects.find((p) => p.id === openProjectId) ?? null;
  const lastOpen = useRef<Project | null>(null);
  if (openProject) lastOpen.current = openProject;
  const shownProject = openProject ?? lastOpen.current;
  useEffect(() => {
    // a project that no longer exists (deleted elsewhere): back to the overview
    if (openProjectId && projects.length > 0 && !openProject) setListView('projects', null);
  }, [openProjectId, openProject, projects.length, setListView]);

  useEffect(() => {
    if (!plusOpen && !menu) return;
    const down = (e: MouseEvent) => {
      if (plusOpen && !plusRef.current?.contains(e.target as Node)) setPlusOpen(false);
      if (menu && !(e.target as HTMLElement).closest?.('[data-chat-menu]')) setMenu(null);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPlusOpen(false); setMenu(null); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [plusOpen, menu]);

  async function refreshProjects() {
    try { setProjects((await projectsApi.list()).projects); } catch { /* ignore */ }
  }

  async function newConversation(projectId?: string) {
    setPlusOpen(false);
    try {
      const res = await convApi.create({ title: 'Nieuw gesprek', ...(projectId ? { projectId } : {}) });
      addConversation(res.conversation);
      if (projectId) void refreshProjects();
      router.push(`/chat/${res.conversation.id}`);
    } catch { /* ignore */ }
  }

  async function moveConversation(id: string, projectId: string | null) {
    setMenu(null);
    try {
      await convApi.update(id, { projectId });
      updateConversation(id, { project_id: projectId });
      void refreshProjects();
    } catch { /* ignore */ }
  }

  async function deleteConversation(e: React.SyntheticEvent | null, id: string, title: string) {
    e?.preventDefault();
    e?.stopPropagation();
    if (!confirm(t('confirmDelete', { title }))) return;
    try {
      await convApi.delete(id);
      removeConversation(id);
      if (pathname === `/chat/${id}`) router.push('/chat');
    } catch { /* ignore */ }
  }

  // Phones have no hover (the ... button): hold a row for its menu; right-click does the same on desktop
  const press = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });
  function startPress(id: string, x: number, y: number) {
    press.current.fired = false;
    press.current.timer = window.setTimeout(() => {
      press.current.fired = true;
      navigator.vibrate?.(12);
      setMenu({ id, x, y, view: 'main' });
    }, 550);
  }
  function cancelPress() {
    if (press.current.timer) window.clearTimeout(press.current.timer);
    press.current.timer = null;
  }

  // unread messages of other members (shared projects): reload whenever the chat list changes
  useEffect(() => {
    if (!projects.some((p) => p.shared)) { setUnread((u) => (Object.keys(u.projects).length ? { conversations: {}, projects: {} } : u)); return; }
    const load = () => projectsApi.unread().then((r) => setUnread(r as unknown as { conversations: Record<string, number>; projects: Record<string, number> })).catch(() => {});
    void load();
    window.addEventListener('cc:read', load);
    return () => window.removeEventListener('cc:read', load);
  }, [projects, conversations]);

  const totalUnread = Object.values(unread.projects).reduce((a, b) => a + b, 0);
  const needle = search.trim().toLowerCase();
  const matches = (c: (typeof conversations)[number]) => !c.project_id && (!needle || c.title.toLowerCase().includes(needle) || (c.last_message?.preview ?? '').toLowerCase().includes(needle));
  const visible = conversations.filter(matches);
  const projectMatches = (p: Project) => !needle || p.name.toLowerCase().includes(needle);
  const projectVisible = projects.filter(projectMatches);
  const projectChats = conversations.filter((c) => c.project_id === shownProject?.id);
  const projectById = (id?: string | null) => projects.find((p) => p.id === id);
  const menuConv = menu ? conversations.find((c) => c.id === menu.id) : null;

  function openMenuFromButton(e: React.MouseEvent<HTMLElement>, id: string) {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu(menu?.id === id ? null : { id, x: r.right, y: r.bottom + 4, view: 'main' });
  }

  function chatRow(conv: (typeof conversations)[number], i: number, folded: boolean) {
    const last = conv.last_message;
    const proj = projectById(conv.project_id);
    return (
      // all rows stay in the list: a search folds the others away and opens them again smoothly
      <div key={conv.id} className={clsx('conv-row', folded && 'conv-row-hidden')} inert={folded || undefined}>
      <div>
      {/* rows slide in one after another when the list first appears (first screenful only) */}
      <div className={clsx('group relative', !entered && 'wa-row-in')} style={{ '--i': Math.min(i, 14) } as React.CSSProperties}>
        <Link
          href={`/chat/${conv.id}`}
          title={`${conv.title} · ${formatDistanceToNow(new Date(conv.updated_at), { addSuffix: true, locale: loc })}`}
          className={clsx('wa-row flex items-center gap-3 pl-4', variant === 'pane' && activeId === conv.id && 'wa-row-on')}
          onTouchStart={(e) => startPress(conv.id, e.touches[0]?.clientX ?? 0, e.touches[0]?.clientY ?? 0)}
          onTouchMove={cancelPress}
          onTouchEnd={cancelPress}
          onContextMenu={(e) => { e.preventDefault(); cancelPress(); setMenu({ id: conv.id, x: e.clientX, y: e.clientY, view: 'main' }); }}
          onClick={(e) => { if (press.current.fired) { e.preventDefault(); press.current.fired = false; } }}
        >
          <ConvAvatar id={conv.id} title={conv.title} />
          {/* Fixed time column, so every title and preview ends at the same x */}
          <span className="wa-row-text flex-1 min-w-0 self-stretch grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto] content-center gap-x-2 gap-y-0.5 pr-4">
            <span className="truncate text-[15px] leading-5 text-(--text)">{conv.title}{unread.conversations[conv.id] > 0 && activeId !== conv.id && <span className="unread-badge ml-2" aria-label={t('unreadCount', { n: unread.conversations[conv.id] })}>{unread.conversations[conv.id]}</span>}</span>
            <span className="text-right text-xs leading-5 text-(--muted) whitespace-nowrap shrink-0 min-w-[3.4rem] tabular-nums">{timeLabel(conv.updated_at, t('yesterday'), loc)}</span>
            <span className="col-span-2 flex items-center gap-1.5 min-w-0 text-[13.5px] leading-5 text-(--muted) [@media(hover:hover)]:group-hover:pr-8">
              {proj && <span className="proj-chip shrink-0" title={proj.name} style={{ '--pc': projectColor(proj.color) } as React.CSSProperties}>{NavIcons.folder('w-3 h-3')}</span>}
              <span className="truncate">
                {last
                  ? <>{last.role === 'user' && <span>{t('you')}</span>}{last.preview || t('usedTools')}</>
                  : t('noMessages')}
              </span>
            </span>
          </span>
        </Link>
        <button
          onClick={(e) => openMenuFromButton(e, conv.id)}
          title={t('moreFor', { title: conv.title })}
          aria-label={t('moreFor', { title: conv.title })}
          aria-haspopup="menu"
          className="absolute right-2 bottom-2.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity
                     w-7 h-7 flex items-center justify-center rounded-lg text-(--muted) hover:text-(--text) hover:bg-(--card-bg)"
        >
          {NavIcons.dots('w-4 h-4')}
        </button>
      </div>
      </div>
      </div>
    );
  }

  const countLabel = (n: number) => (n === 1 ? t('chatCountOne') : t('chatCount', { n }));
  const inProject = !!openProjectId;

  return (
    <section aria-label={t('list')} className={clsx('flex flex-col h-full min-h-0 overflow-hidden', variant === 'pane' ? 'wa-pane w-[340px] shrink-0' : 'w-full')}>
      <div className="pv-viewport flex-1 min-h-0 relative overflow-hidden">
        <div className={clsx('pv-track', inProject && 'pv-open')}>

          {/* ── pane 1: Chats / Projecten ── */}
          <div className="pv-pane" inert={inProject || undefined} aria-hidden={inProject || undefined}>
            <div className="flex items-center justify-between gap-2 pl-4 pr-3 pb-3" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)' }}>
              <h1 className="font-bold text-(--text) text-[22px] tracking-tight">{t('title')}</h1>
              <div className="flex items-center gap-2">
                <div ref={plusRef} className="relative">
                  <button onClick={() => setPlusOpen((o) => !o)} title={t('menuNew')} aria-label={t('menuNew')} aria-haspopup="menu" aria-expanded={plusOpen}
                    className={clsx('wa-new w-10 h-10 shrink-0 rounded-full flex items-center justify-center', plusOpen && 'wa-new-open')}>
                    {NavIcons.plus('w-5 h-5')}
                  </button>
                  <div role="menu" className={clsx('pm-pop', plusOpen && 'pm-pop-on')} inert={!plusOpen || undefined}>
                    <button role="menuitem" className="pm-item" onClick={() => void newConversation()}>
                      {NavIcons.chat('w-[18px] h-[18px]')}<span>{t('newChat')}</span>
                    </button>
                    <button role="menuitem" className="pm-item" onClick={() => { setPlusOpen(false); setDialog('new'); }}>
                      {NavIcons.folder('w-[18px] h-[18px]')}<span>{t('newProject')}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-4 pb-2.5">
              <div className="seg" role="tablist" aria-label={t('segmentLabel')}>
                <span aria-hidden className="seg-ind" style={{ transform: `translateX(${listTab === 'projects' ? 100 : 0}%)` }} />
                <button role="tab" aria-selected={listTab === 'chats'} className={clsx('seg-btn', listTab === 'chats' && 'seg-btn-on')} onClick={() => setListView('chats')}>{t('chats')}</button>
                <button role="tab" aria-selected={listTab === 'projects'} className={clsx('seg-btn', listTab === 'projects' && 'seg-btn-on')} onClick={() => setListView('projects')}>{t('projects')}{totalUnread > 0 && listTab !== 'projects' && <span className="unread-badge ml-1.5" aria-label={t('projectsUnread')}>{totalUnread}</span>}</button>
              </div>
            </div>

            <div className="px-4 pb-2">
              <label className="wa-search flex items-center gap-3 w-full px-4 h-10 text-sm text-(--text) cursor-text">
                <span className="text-(--muted)">{NavIcons.search('w-4 h-4')}</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={listTab === 'projects' ? t('searchProjects') : t('search')}
                  aria-label={t('searchLabel')}
                  autoComplete="off"
                  className="w-full bg-transparent text-sm text-(--text) placeholder:text-(--muted) focus:outline-none"
                />
              </label>
            </div>

            {listTab === 'chats' ? (
              <div key="chats" className="wa-list flex-1 overflow-y-auto overscroll-contain pv-fade">
                <div className={clsx('conv-row', visible.length > 0 && 'conv-row-hidden')}>
                  <div>
                    <p className="text-(--muted) text-xs text-center py-8 px-4">
                      {needle ? t('nothingFound') : t('empty')}
                    </p>
                  </div>
                </div>
                {conversations.map((conv, i) => chatRow(conv, i, !matches(conv)))}
                {variant === 'page' && visible.length > 0 && (
                  <p className="text-[11.5px] text-(--muted) text-center py-4 px-6">{t('holdToDelete')}</p>
                )}
              </div>
            ) : (
              <div key="projects" className="wa-list flex-1 overflow-y-auto overscroll-contain px-3 pt-1 pb-4 pv-fade">
                {projectVisible.length === 0 && (
                  <div className="text-center py-8 px-4">
                    <span className="proj-empty-ic">{NavIcons.folder('w-6 h-6')}</span>
                    <p className="text-(--muted) text-[13px] leading-5 mt-3">{needle ? t('projectNothingFound') : t('noProjects')}</p>
                    {!needle && <button className="pd-btn pd-btn-primary mt-4 mx-auto" onClick={() => setDialog('new')}>{t('createProject')}</button>}
                  </div>
                )}
                {projectVisible.map((p, i) => (
                  <button key={p.id} onClick={() => { setSearch(''); setListView('projects', p.id); }}
                    className={clsx('proj-card', !entered && 'wa-row-in')} style={{ '--i': Math.min(i, 14), '--pc': projectColor(p.color) } as React.CSSProperties}>
                    <ProjectTile color={p.color} size={44} />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-[15px] font-medium leading-5 text-(--text)">{p.name}</span>
                      <span className="block truncate text-[13px] leading-5 text-(--muted)">
                        {p.chat_count > 0
                          ? <>{countLabel(p.chat_count)}{p.last_activity && <> · {t('lastActivity', { time: timeLabel(p.last_activity, t('yesterday'), loc) })}</>}</>
                          : t('noChatsYet')}
                      </span>
                    </span>
                    {unread.projects[p.id] > 0 && <span className="unread-badge" aria-label={t('unreadCount', { n: unread.projects[p.id] })}>{unread.projects[p.id]}</span>}
                    {p.members && <AvatarStack members={p.members} />}
                    <span className="text-(--muted) rotate-180">{NavIcons.back('w-4 h-4')}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── pane 2: the open project ── */}
          <div className="pv-pane" inert={!inProject || undefined} aria-hidden={!inProject || undefined}>
            {shownProject && (
              <>
                <div className="flex items-center gap-1.5 pl-2 pr-3 pb-3" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 14px)' }}>
                  <button onClick={() => setListView('projects', null)} aria-label={t('back')} title={t('back')} className="pv-icon-btn">
                    {NavIcons.back('w-5 h-5')}
                  </button>
                  <ProjectTile color={shownProject.color} size={32} />
                  <div className="min-w-0 flex-1 pl-1">
                    <h1 className="truncate font-bold text-(--text) text-[19px] leading-6 tracking-tight">{shownProject.name}</h1>
                    <p className="truncate text-xs leading-4 text-(--muted)">{countLabel(projectChats.length)}</p>
                  </div>
                  {shownProject.members && <AvatarStack members={shownProject.members} className="mr-1" />}
                  <button onClick={() => setShareOpen(true)} aria-label={t('share')} title={t('share')} className="pv-icon-btn">
                    {NavIcons.users('w-5 h-5')}
                  </button>
                  <button onClick={() => setDialog('edit')} aria-label={t('projectSettings')} title={t('projectSettings')} className="pv-icon-btn">
                    {NavIcons.gear('w-5 h-5')}
                  </button>
                  <button onClick={() => void newConversation(shownProject.id)} title={t('newChatInProject')} aria-label={t('newChatInProject')}
                    className="wa-new w-10 h-10 shrink-0 rounded-full flex items-center justify-center">
                    {NavIcons.plus('w-5 h-5')}
                  </button>
                </div>
                <div className="wa-list flex-1 overflow-y-auto overscroll-contain">
                  {projectChats.length === 0
                    ? <p className="text-(--muted) text-[13px] leading-5 text-center py-10 px-6">{t('emptyProject')}</p>
                    : projectChats.map((conv, i) => chatRow(conv, i, false))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* chat menu: popover on desktop, bottom sheet on phones */}
      {menu && menuConv && createPortal(
        <div className="cm-root">
          <div className="cm-backdrop" onMouseDown={() => setMenu(null)} />
          <div data-chat-menu role="menu" className="cm"
            style={{ '--x': `${Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 248)}px`, '--y': `${Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 300)}px` } as React.CSSProperties}>
            <p className="cm-title truncate">{menuConv.title}</p>
            {menu.view === 'main' ? (
              <>
                <button role="menuitem" className="pm-item" onClick={() => setMenu({ ...menu, view: 'move' })}>
                  {NavIcons.folder('w-[18px] h-[18px]')}<span className="flex-1 text-left">{t('moveToProject')}</span>
                  <span className="rotate-180 text-(--muted)">{NavIcons.back('w-4 h-4')}</span>
                </button>
                <button role="menuitem" className="pm-item pm-item-danger" onClick={(e) => { setMenu(null); void deleteConversation(e, menuConv.id, menuConv.title); }}>
                  {NavIcons.trash('w-[18px] h-[18px]')}<span>{t('delete')}</span>
                </button>
              </>
            ) : (
              <>
                <button role="menuitem" className="pm-item pm-item-sub" onClick={() => setMenu({ ...menu, view: 'main' })}>
                  {NavIcons.back('w-[18px] h-[18px]')}<span>{t('moveToProject')}</span>
                </button>
                <div className="cm-scroll">
                  {menuConv.project_id && (
                    <button role="menuitem" className="pm-item" onClick={() => void moveConversation(menuConv.id, null)}>
                      {NavIcons.chat('w-[18px] h-[18px]')}<span>{t('removeFromProject')}</span>
                    </button>
                  )}
                  {projects.length === 0 && <p className="text-(--muted) text-[13px] px-3 py-3">{t('noProjectYet')}</p>}
                  {projects.map((p) => (
                    <button key={p.id} role="menuitemradio" aria-checked={menuConv.project_id === p.id} disabled={menuConv.project_id === p.id}
                      className="pm-item" onClick={() => void moveConversation(menuConv.id, p.id)}>
                      <ProjectTile color={p.color} size={24} /><span className="flex-1 text-left truncate">{p.name}</span>
                      {menuConv.project_id === p.id && <span className="text-(--accent)">{NavIcons.check('w-4 h-4')}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {shareOpen && shownProject && (
        <ShareDialog project={shownProject} onClose={() => setShareOpen(false)} onChanged={() => void refreshProjects()}
          onLeft={() => { setListView('projects', null); void refreshProjects(); void convApi.list().then((r) => useChatStore.getState().setConversations(r.conversations)).catch(() => {}); }} />
      )}

      {dialog && (
        <ProjectDialog
          project={dialog === 'edit' ? shownProject : null}
          onClose={() => setDialog(null)}
          onSaved={(p) => {
            void refreshProjects();
            if (dialog === 'new') { setListView('projects', p.id); }
          }}
          onDeleted={() => { setListView('projects', null); void refreshProjects(); void convApi.list().then((r) => useChatStore.getState().setConversations(r.conversations)).catch(() => {}); }}
        />
      )}
    </section>
  );
}
