'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useLocale, useTranslations } from '@/lib/i18n';
import { projectsApi } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import UserAvatar from '@/components/UserAvatar';
import ClaudeLogo from '@/components/ClaudeLogo';
import { NavIcons } from '@/components/navItems';
import type { Project, ProjectMember, ProjectAgent, ProjectMemoryItem, ProjectEvent } from '@/types';

const PALETTE = ['#A78BFA', '#F472B6', '#FBBF24', '#22D3EE', '#FB7185', '#F59E6B', '#C8A27A', '#60A5FA'];
const TOPICS = ['klant', 'afspraak', 'technisch', 'algemeen'] as const;
type Tab = 'members' | 'agents' | 'memory' | 'connectors' | 'history';
type Filter = 'all' | 'members' | 'agents' | 'memory' | 'connectors';

type Cand = { id: string; name: string; avatar: string | null };
type Conn = { id: string; name: string; type: string; shared: boolean; mine?: boolean; by?: string | null };

const FILTER_OF = (a: string): Filter => (a.startsWith('member.') || a.startsWith('project.') ? 'members' : a.startsWith('agent.') ? 'agents' : a.startsWith('memory.') ? 'memory' : 'connectors');
const MARK = ['\u0001', '\u0002', '\u0003'];


/** Side panel (380 px) on desktop, bottom sheet on a phone: members, adding people, shared connectors, leaving */
export default function ShareDialog({ project, onClose, onChanged, onLeft }: {
  project: Project;
  onClose: () => void;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const t = useTranslations('share');
  const { locale } = useLocale();
  const me = useAuthStore((s) => s.user?.id);
  const [shown, setShown] = useState(false);
  const [members, setMembers] = useState<ProjectMember[]>(project.members ?? []);
  const [q, setQ] = useState('');
  const [cands, setCands] = useState<Cand[]>([]);
  const [conns, setConns] = useState<Conn[]>([]);
  const [tab, setTab] = useState<Tab>('members');
  const [agents, setAgents] = useState<ProjectAgent[]>([]);
  const [mem, setMem] = useState<ProjectMemoryItem[]>([]);
  const [draft, setDraft] = useState('');
  const [draftTopic, setDraftTopic] = useState<string>('algemeen');
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [confirmBox, setConfirmBox] = useState<'leave' | 'delete' | null>(null);
  const [err, setErr] = useState('');
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [histLoaded, setHistLoaded] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const last = members.length <= 1;

  const load = useCallback(async () => {
    try { setMembers((await projectsApi.members(project.id)).members); } catch { /* ignore */ }
    try { setConns((await projectsApi.connectors(project.id)).connectors); } catch { /* ignore */ }
    try { setAgents((await projectsApi.agents(project.id)).agents); } catch { /* ignore */ }
    try { setMem((await projectsApi.memory(project.id)).memories); } catch { /* ignore */ }
  }, [project.id]);

  const loadHistory = useCallback(async (before?: string) => {
    try {
      const r = await projectsApi.events(project.id, before);
      setEvents((l) => (before ? [...l, ...r.events] : r.events));
      setNext(r.next);
    } catch { /* ignore */ }
    setHistLoaded(true);
  }, [project.id]);

  function close() { setShown(false); setTimeout(onClose, 240); }

  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    void load();
    return () => { cancelAnimationFrame(r); window.removeEventListener('keydown', k); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const h = setTimeout(() => { projectsApi.candidates(project.id, q).then((r) => setCands(r.users)).catch(() => setCands([])); }, 180);
    return () => clearTimeout(h);
  }, [q, project.id, members.length]);

  useEffect(() => { tabRefs.current[tab]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); if (tab === 'history') void loadHistory(); }, [tab, loadHistory]);
  useEffect(() => { setConfirmBox(null); setErr(''); }, [tab]);

  async function add(id: string) {
    try { await projectsApi.addMember(project.id, id); setQ(''); await load(); onChanged(); } catch { /* ignore */ }
  }
  async function remove(m: ProjectMember) {
    if (!confirm(t('confirmRemove', { name: m.name }))) return;
    try { await projectsApi.removeMember(project.id, m.id); onChanged(); await load(); } catch { /* ignore */ }
  }
  async function leave() {
    setErr('');
    try { await projectsApi.removeMember(project.id, me!); onChanged(); onLeft(); close(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  async function wipe() {
    setErr('');
    try { await projectsApi.delete(project.id); onChanged(); onLeft(); close(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  async function toggleConn(c: Conn) {
    const next = conns.map((x) => (x.id === c.id ? { ...x, shared: !x.shared } : x));
    setConns(next);
    try { await projectsApi.setConnectors(project.id, next.filter((x) => x.shared && x.mine !== false).map((x) => x.id)); } catch { void load(); }
  }
  async function pickColor(m: ProjectMember, c: string) {
    try { setMembers((await projectsApi.setColor(project.id, m.id, c)).members); onChanged(); } catch { /* taken */ }
  }
  async function saveAgent(a: ProjectAgent, patch: Partial<{ in_project: boolean; user_ids: string[]; account_mode: 'user' | 'owner'; fallback: boolean }>) {
    const n = { ...a, ...patch };
    setAgents((l) => l.map((x) => (x.id === a.id ? n : x)));
    try {
      const r = await projectsApi.setAgent(project.id, a.id, { inProject: n.in_project, userIds: n.user_ids, accountMode: n.account_mode, fallback: n.fallback });
      setAgents(r.agents);
    } catch { void load(); }
  }
  async function addMem() {
    const c = draft.trim(); if (!c) return;
    try { setMem((await projectsApi.addMemory(project.id, { content: c, topic: draftTopic })).memories); setDraft(''); } catch { /* ignore */ }
  }
  async function saveMem(m: ProjectMemoryItem) {
    try { setMem((await projectsApi.updateMemory(project.id, m.id, { content: editText.trim() })).memories); setEditId(null); } catch { /* ignore */ }
  }
  async function pinMem(m: ProjectMemoryItem) {
    try { setMem((await projectsApi.updateMemory(project.id, m.id, { pinned: !m.pinned })).memories); } catch { /* ignore */ }
  }
  async function delMem(m: ProjectMemoryItem) {
    if (!confirm(t('memoryConfirmDelete'))) return;
    try { setMem((await projectsApi.deleteMemory(project.id, m.id)).memories); } catch { /* ignore */ }
  }
  async function more() {
    if (!next || moreBusy) return;
    setMoreBusy(true); await loadHistory(next); setMoreBusy(false);
  }

  const takenBy = (c: string, self: string) => members.find((x) => x.id !== self && x.color?.toUpperCase() === c);
  const tabs: Tab[] = ['members', 'agents', 'memory', 'connectors', 'history'];
  const tabLabel = { members: t('tabMembers'), agents: t('tabAgents'), memory: t('tabMemory'), connectors: t('tabConnectors'), history: t('tabHistory') };

  function dayLabel(iso: string) {
    const d = new Date(iso); const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return t('today');
    if (d.toDateString() === y.toDateString()) return t('yesterday');
    return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short' }).format(d).replace(/^./, (c) => c.toUpperCase());
  }
  function evText(e: ProjectEvent) {
    const key = 'ev_' + e.action.replace('.', '_');
    const mode = e.details?.accountMode === 'owner' ? t('modeHolder') : t('modeRequester');
    const raw = e.action in { 'project.update': 1, 'member.add': 1, 'member.remove': 1, 'member.leave': 1, 'member.color': 1, 'agent.add': 1, 'agent.remove': 1, 'agent.users': 1, 'agent.account': 1, 'memory.add': 1, 'memory.update': 1, 'memory.pin': 1, 'memory.delete': 1, 'connector.share': 1, 'connector.unshare': 1 }
      ? t(key, { who: MARK[0], target: MARK[1], mode: MARK[2] }) : t('ev_other', { who: MARK[0], action: e.action });
    const who = e.user_name ?? (e.details?.via === 'claude' ? t('claude') : t('someone'));
    return raw.split(/([\u0001\u0002\u0003])/).map((p, i) => {
      if (p === MARK[0]) return <b key={i}>{who}</b>;
      if (p === MARK[1]) return e.action.startsWith('memory.') ? null : <b key={i}>{e.target ?? ''}</b>;
      if (p === MARK[2]) return mode;
      return p;
    });
  }
  const shownEvents = events.filter((e) => filter === 'all' || FILTER_OF(e.action) === filter);
  const filters: Filter[] = ['all', 'members', 'agents', 'memory', 'connectors'];
  const fLabel = { all: t('fAll'), members: t('fMembers'), agents: t('fAgents'), memory: t('fMemory'), connectors: t('fConnectors') };

  const leaveBlock = (
    <div className="mt-5">
      {last ? (
        <>
          <button className="sp-btn-out" disabled>{t('leave')}</button>
          <p className="sp-note">{t('lastMemberNote')}</p>
          <button className="sp-btn-out sp-btn-danger" onClick={() => setConfirmBox(confirmBox === 'delete' ? null : 'delete')}>{t('deleteProject')}</button>
        </>
      ) : (
        <button className="sp-btn-out" onClick={() => setConfirmBox(confirmBox === 'leave' ? null : 'leave')}>{t('leaveProject')}</button>
      )}
      <div className={clsx('sp-confirm', confirmBox && 'sp-confirm-on', confirmBox === 'delete' && 'sp-confirm-danger')} aria-hidden={!confirmBox}>
        <div>
          <p className="sp-confirm-text">{confirmBox === 'delete' || (last && !confirmBox) ? t('deleteWarn') : t('leaveConfirm')}</p>
          {err && <p className="sp-confirm-text" role="alert">{err}</p>}
          <div className="flex gap-2 mt-2">
            <button className="sp-btn-sm" tabIndex={confirmBox ? 0 : -1} onClick={() => setConfirmBox(null)}>{t('cancel')}</button>
            <button className="sp-btn-sm sp-btn-sm-danger" tabIndex={confirmBox ? 0 : -1} onClick={() => void (confirmBox === 'delete' ? wipe() : leave())}>{confirmBox === 'delete' ? t('deleteYes') : t('leaveYes')}</button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(
    <div className={clsx('sp-root', shown && 'sp-on')} role="dialog" aria-modal="true" aria-label={t('title')}>
      <div className="sp-backdrop" onClick={close} />
      <aside className="sp-panel">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-[17px] font-semibold text-(--text) flex-1 truncate">{t('title')}</h2>
          <button onClick={close} className="pv-icon-btn" aria-label={t('close')} title={t('close')}><span className="inline-block rotate-45">{NavIcons.plus('w-5 h-5')}</span></button>
        </div>
        <div className="sp-tabs" role="tablist">
          {tabs.map((k) => <button key={k} ref={(el) => { tabRefs.current[k] = el; }} role="tab" aria-selected={tab === k} className={clsx('sp-tab', tab === k && 'sp-tab-on')} onClick={() => setTab(k)}>{tabLabel[k]}</button>)}
        </div>
        <div key={tab} className="sp-pane">
        {tab === 'members' && <>
        <p className="text-xs text-(--muted) mb-3">{t('hint')}</p>

        <span className="pd-label">{t('members')}</span>
        <ul className="sp-list">
          {members.map((m) => (
            <li key={m.id} className="sp-row">
              <span className="sp-ava" style={{ '--pc': m.color ?? 'transparent' } as React.CSSProperties}><UserAvatar size="md" user={{ avatar: m.avatar, name: m.name, email: m.id }} /></span>
              <span className="min-w-0 flex-1 truncate text-[14px] text-(--text)">{m.name}{m.id === me && <span className="text-(--muted)"> ({t('you')})</span>}{last && m.id === me && <span className="block text-xs text-(--muted)">{t('lastMember')}</span>}</span>
              {m.id !== me && <button className="sp-x" onClick={() => void remove(m)}>{t('remove')}</button>}
            </li>
          ))}
        </ul>

        <label className="block mt-4">
          <span className="pd-label">{t('add')}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchPlaceholder')} className="pd-input" />
        </label>
        {cands.length > 0 && (
          <ul className="sp-list">
            {cands.map((c) => (
              <li key={c.id} className="sp-row">
                <UserAvatar size="md" user={{ avatar: c.avatar, name: c.name, email: c.id }} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-(--text)">{c.name}</span>
                <button className="pd-btn pd-btn-primary" style={{ height: 32 }} onClick={() => void add(c.id)}>{t('addBtn')}</button>
              </li>
            ))}
          </ul>
        )}

        {members.length > 0 && (
          <div className="mt-4">
            <span className="pd-label">{t('color')}</span>
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-2 py-1">
                {members.length > 1 && <span className="text-xs text-(--muted) w-20 truncate">{m.name}</span>}
                <div className="sp-swatches">
                  {PALETTE.map((c) => {
                    const o = takenBy(c, m.id);
                    return <button key={c} className={clsx('sp-swatch', m.color?.toUpperCase() === c && 'sp-swatch-on')} style={{ background: c }} disabled={!!o} aria-label={o ? t('colorTaken', { name: o.name }) : c} title={o ? t('colorTaken', { name: o.name }) : c} onClick={() => void pickColor(m, c)} />;
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {leaveBlock}
        </>}

        {tab === 'agents' && <>
          {agents.length === 0 && <p className="text-sm text-(--muted)">{t('agentsEmpty')}</p>}
          <ul className="sp-list">
            {agents.map((a) => (
              <li key={a.id} className="sp-agent">
                <div className="flex items-center gap-2">
                  <span className="sp-dot" style={{ background: a.color ?? 'var(--muted)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-(--text)">{a.name}</span>
                    {a.in_project && a.owner_name && <span className="block truncate text-xs text-(--muted)">{t('addedBy', { name: a.owner_name })}</span>}
                  </span>
                  <button role="switch" aria-checked={a.in_project} aria-label={t('agentIn')} onClick={() => void saveAgent(a, { in_project: !a.in_project })} className={clsx('sp-sw', a.in_project && 'sp-sw-on')}><i /></button>
                </div>
                {a.in_project && (
                  <div className="sp-agent-body">
                    <span className="pd-label">{t('agentUsers')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {members.map((m) => {
                        const on = a.user_ids.includes(m.id);
                        return (
                          <button key={m.id} aria-pressed={on} onClick={() => void saveAgent(a, { user_ids: on ? a.user_ids.filter((x) => x !== m.id) : [...a.user_ids, m.id] })}
                            className={clsx('sp-chip', on ? 'sp-chip-on' : 'sp-chip-off')} style={{ '--pc': m.color ?? 'var(--muted)' } as React.CSSProperties}>{m.name}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="sp-note">{t('agentsHint')}</p>
        </>}

        {tab === 'memory' && <>
          <p className="text-xs text-(--muted) mb-2">{t('memoryHint')}</p>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('memoryPlaceholder')} className="pd-input" rows={2} />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {TOPICS.map((k) => <button key={k} className={clsx('sp-chip', draftTopic === k && 'sp-chip-on')} aria-pressed={draftTopic === k} onClick={() => setDraftTopic(k)}>{t('topic' + k[0].toUpperCase() + k.slice(1))}</button>)}
            <button className="pd-btn pd-btn-primary ml-auto" style={{ height: 32 }} disabled={!draft.trim()} onClick={() => void addMem()}>{t('memoryAdd')}</button>
          </div>
          {mem.length === 0 && <p className="text-sm text-(--muted) mt-3">{t('memoryEmpty')}</p>}
          <ul className="sp-list">
            {mem.map((m) => (
              <li key={m.id} className={clsx('sp-mem', 'sp-mem-' + ((TOPICS as readonly string[]).includes(m.topic) ? m.topic : 'algemeen'))}>
                {editId === m.id ? (
                  <>
                    <textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="pd-input" rows={3} />
                    <div className="flex gap-2 mt-1"><button className="pd-btn pd-btn-primary" style={{ height: 30 }} onClick={() => void saveMem(m)}>{t('memorySave')}</button><button className="sp-x" onClick={() => setEditId(null)}>{t('memoryCancel')}</button></div>
                  </>
                ) : (
                  <>
                    <p className="text-[14px] text-(--text) whitespace-pre-wrap break-words">{m.content}</p>
                    <div className="sp-mem-meta">
                      <span className="sp-tag">{(TOPICS as readonly string[]).includes(m.topic) ? t('topic' + m.topic[0].toUpperCase() + m.topic.slice(1)) : m.topic}</span>
                      <span>{m.added_via === 'claude' ? t('byClaude') : t('byPerson', { name: m.added_by_name ?? '?' })}</span>
                      <span className="flex-1" />
                      <button className="sp-x" onClick={() => void pinMem(m)}>{m.pinned ? t('memoryUnpin') : t('memoryPin')}</button>
                      <button className="sp-x" onClick={() => { setEditId(m.id); setEditText(m.content); }}>{t('memoryEdit')}</button>
                      <button className="sp-x" onClick={() => void delMem(m)}>{t('memoryDelete')}</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="sp-note">{t('memoryFile')}</p>
        </>}

        {tab === 'connectors' && <>
        {conns.length > 0 && (
          <div className="mt-1">
            <span className="pd-label">{t('connectors')}</span>
            <p className="text-xs text-(--muted) mb-1">{t('connectorsHint')}</p>
            <ul className="sp-list">
              {conns.map((c) => (
                <li key={c.id} className="sp-row">
                  <span className="min-w-0 flex-1 truncate text-[14px] text-(--text)">{c.name} <span className="text-(--muted) text-xs">{c.type}{c.mine === false && c.by ? ' · ' + t('connectorBy', { name: c.by }) : ''}</span></span>
                  <button role="switch" aria-checked={c.shared} disabled={c.mine === false} onClick={() => void toggleConn(c)} className={clsx('sp-sw', c.shared && 'sp-sw-on')}><i /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {conns.length === 0 && <p className="text-sm text-(--muted)">{t('connectorsReadonly')}</p>}
        </>}

        {tab === 'history' && <>
          <div className="sp-filters" role="group">
            {filters.map((f) => <button key={f} className={clsx('sp-fchip', filter === f && 'sp-fchip-on')} aria-pressed={filter === f} onClick={() => setFilter(f)}>{fLabel[f]}</button>)}
          </div>
          {histLoaded && shownEvents.length === 0 && (
            <div className="sp-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              <p>{t('historyEmpty')}</p>
            </div>
          )}
          <ul className="sp-list">
            {shownEvents.map((e, i) => {
              const day = dayLabel(e.created_at);
              const head = i === 0 || dayLabel(shownEvents[i - 1].created_at) !== day;
              const claude = !e.user_id;
              const quote = e.action.startsWith('memory.') ? (e.target ?? '') : '';
              return (
                <li key={e.id} className="sp-ev-wrap">
                  {head && <div className="sp-day">{day}</div>}
                  <div className="sp-ev">
                    {claude
                      ? <span className="sp-ev-ava sp-ev-claude"><ClaudeLogo className="w-[70%] h-[70%]" /></span>
                      : <span className="sp-ev-ava"><UserAvatar size="sm" user={{ avatar: e.user_avatar, name: e.user_name, email: e.user_id ?? '' }} /></span>}
                    <div className="min-w-0 flex-1">
                      <p className="sp-ev-text">
                        {evText(e)}
                        {e.action === 'member.color' && typeof e.details?.color === 'string' && <i className="sp-ev-dot" style={{ background: e.details.color }} />}
                      </p>
                      {quote && <p className="sp-ev-quote">{quote}</p>}
                    </div>
                    <time className="sp-ev-time" dateTime={e.created_at} title={new Date(e.created_at).toLocaleString(locale)}>{new Date(e.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</time>
                  </div>
                </li>
              );
            })}
          </ul>
          {next && <button className="sp-btn-out mt-3" disabled={moreBusy} onClick={() => void more()}>{t('more')}</button>}
        </>}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
