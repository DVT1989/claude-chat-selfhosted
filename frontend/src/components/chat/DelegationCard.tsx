'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { conversations as convApi, delegationsApi, type DelegationStatus, type DelegationView } from '@/lib/api';
import { DelegationWatch } from './DelegationWatch';
import { AgentAvatar, findAgent, stepLabel, useAgents, useElapsed } from './AgentBubble';
import { LimitIcon, nogText, useTick } from './LimitNotice';
import { AgentGlow } from './AgentGlow';
import { glowColor } from './agentGlowUtils';

/** The card event as stored in the parent's answer (services/delegations.ts cardEvent). */
export interface DelegationEvent {
  type: 'delegation'; delegationId: string; conversationId: string; title: string;
  agentId?: string | null; agentName?: string; status?: DelegationStatus; summary?: string; at?: string; finishedAt?: string;
}

const LABEL: Record<DelegationStatus, string> = {
  queued: 'In de rij', running: 'Bezig', done: 'Klaar', failed: 'Mislukt', interrupted: 'Onderbroken',
};
const OPEN = new Set<DelegationStatus>(['queued', 'running', 'interrupted']);

/** Status of one delegation: from the event first, then polled (every 3 s while running, 10 s while waiting). */
function useDelegation(ev: DelegationEvent): [DelegationView | null, () => void] {
  const [d, setD] = useState<DelegationView | null>(null);
  // a run started or ended in the workplace (seen while watching): fetch now and poll again
  const [bump, setBump] = useState(0);
  const refresh = useCallback(() => setBump((n) => n + 1), []);
  const status = d?.status ?? ev.status ?? 'queued';
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try { const r = await delegationsApi.get(ev.delegationId); if (alive.current) setD(r.delegation); } catch { /* next round */ }
      }
    };
    void tick();
    if (!OPEN.has(status)) return;
    const loop = () => { timer = setTimeout(async () => { await tick(); loop(); }, status === 'running' ? 3000 : 10_000); };
    loop();
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [ev.delegationId, status, bump]);
  return [d, refresh];
}

/** Small screens get a bottom sheet instead of the inline fold. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setNarrow(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={clsx('dg-chev w-4 h-4', open && 'is-open')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
);

/**
 * Steering the agent from the card: a message to its workplace, as in a normal chat. The queue sends it
 * at once when the agent is idle and right after the current answer when it is busy. "Doorgeven aan"
 * asks the agent to hand the task to a colleague.
 */
function SteerBar({ conversationId, agentName, title, busy, queued, onSent, left }: {
  conversationId: string; agentName: string; title: string; busy: boolean; queued: number; onSent: () => void;
  /** links on the left of the single foot line (Inklappen) */
  left?: React.ReactNode;
}) {
  const agents = useAgents();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState('');
  const others = agents.filter((x) => x.is_active !== false && x.name !== agentName);
  const send = async (message: string) => {
    if (!message.trim() || sending) return;
    setSending(true); setNote('');
    try {
      await convApi.enqueue(conversationId, message.trim());
      setText(''); setNote(busy ? 'In de wachtrij, gaat mee na de huidige stap' : 'Verstuurd');
      onSent();
    } catch (e) { setNote((e as Error).message || 'Versturen lukte niet'); }
    finally { setSending(false); }
  };
  return (
    <div className="dg-steer">
      <form className="dg-steer-row" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea value={text} rows={1} placeholder={`Stuur ${agentName} bij`} aria-label={`Bericht aan ${agentName}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }} />
        <button type="submit" className="dg-send" disabled={!text.trim() || sending} aria-label="Versturen">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
        </button>
      </form>
      <div className="dg-steer-foot">
        {left}
        <span className="dg-steer-note truncate" aria-live="polite">
          {note || (queued ? `${queued} ${queued === 1 ? 'bericht' : 'berichten'} in de wachtrij` : '')}
        </span>
        <div className="relative ml-auto shrink-0">
          <button type="button" className="dg-handoff" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} disabled={!others.length}>
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12h14m-5-5 5 5-5 5" /><path d="M4 5v14" /></svg>
            Doorgeven aan
          </button>
          {menu && (
            <div className="dg-menu" role="menu">
              {others.map((o) => (
                <button key={o.id} type="button" role="menuitem" className="dg-menu-item" style={{ '--ag': o.color } as React.CSSProperties}
                  onClick={() => { setMenu(false); void send(`Geef deze taak door aan ${o.name}: ${title}`); }}>
                  <AgentAvatar name={o.name} avatar={o.avatar} color={o.color} className="w-5 h-5 text-[9px]" />
                  {o.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mobile: the workplace in a bottom sheet over the chat (slides up, backdrop fades; Escape or tap closes). */
function Sheet({ onClose, head, children }: { onClose: () => void; head: React.ReactNode; children: React.ReactNode }) {
  const [out, setOut] = useState(false);
  const close = useCallback(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setOut(true); setTimeout(onClose, reduce ? 0 : 240);
  }, [onClose]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prev; };
  }, [close]);
  return createPortal(
    <div className={clsx('dg-sheet-wrap', out && 'is-out')}>
      <button type="button" className="dg-sheet-backdrop" aria-label="Sluiten" onClick={close} />
      <div className="dg-sheet" role="dialog" aria-modal="true">
        <div className="dg-sheet-grip" aria-hidden />
        <div className="dg-sheet-head">
          <div className="min-w-0 flex-1">{head}</div>
          <button type="button" className="dg-sheet-x" onClick={close} aria-label="Sluiten">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function StatusPill({ status, position, color, wait }: { status: DelegationStatus; position?: number; color: string; wait?: DelegationView['wait'] }) {
  const until = wait?.resumeAt ? new Date(wait.resumeAt) : null;
  const now = useTick(status === 'interrupted' && wait?.reason === 'limit' && !!until);
  const icon = status === 'done' ? LimitIcon.check : status === 'interrupted' ? LimitIcon.clock : status === 'failed' ? LimitIcon.warn : null;
  return (
    <span key={status} className={clsx('dg-pill', `is-${status}`)} style={{ '--ag': color } as React.CSSProperties}>
      {status === 'running' && <span className="dg-dot" aria-hidden />}
      {status === 'queued' && <span className="dg-dot is-still" aria-hidden />}
      {icon && <span className="w-3 h-3 shrink-0 [&>svg]:w-full [&>svg]:h-full">{icon}</span>}
      {status === 'interrupted' && wait?.reason === 'limit' && until && until.getTime() > now ? `Wacht op reset, ${nogText(until, now)}`
        : status === 'interrupted' && (wait?.reason === 'restart' || (wait?.reason === 'limit' && until)) ? 'Hervat zo'
        : LABEL[status]}{status === 'queued' && position ? ` · ${position}e` : ''}
    </span>
  );
}

/** sRGB relative luminance of #rrggbb (WCAG). */
function lum(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.2;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function mixBlack(hex: string, black: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - black)).toString(16).padStart(2, '0')).join('');
}
/**
 * A legible initial on an agent colour (review Designer #35): a light colour (teal) gets a dark letter in its own hue,
 * a darker one (purple) a white letter on a fill darkened until white reaches 4.5:1.
 */
export function initialColors(color: string): { bg: string; fg: string } {
  if (!/^#?[0-9a-f]{6}$/i.test(color.trim())) return { bg: color, fg: '#fff' };
  const c = color.startsWith('#') ? color : `#${color}`;
  if (lum(c) > 0.3) return { bg: c, fg: mixBlack(c, 0.8) };
  let bg = c;
  for (let k = 0.05; 1.05 / (lum(bg) + 0.05) < 4.5 && k < 0.6; k += 0.05) bg = mixBlack(c, k);
  return { bg, fg: '#fff' };
}

/** The small face in the card: the photo, or a plain disc (pair in the head) or one initial (step line). */
function Face({ name, avatar, color, size, initial, top }: { name: string; avatar?: string | null; color: string; size: 16 | 18; initial?: boolean; top?: boolean }) {
  const ic = initialColors(color);
  return (
    <span className={clsx('dg-face', top && 'is-top')} style={{ width: size, height: size, background: avatar ? undefined : initial ? ic.bg : color, color: ic.fg }} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {avatar ? <img src={avatar} alt="" /> : initial ? name.trim().charAt(0).toUpperCase() : null}
    </span>
  );
}

function duration(from?: string | null, to?: string | null): string {
  const a = from ? Date.parse(from) : NaN, b = to ? Date.parse(to) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const m = Math.round((b - a) / 60_000);
  return m < 1 ? 'in minder dan een minuut' : m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} u ${m % 60} min`;
}

/**
 * An agent working in its own workplace, as a card in the conversation that handed the work over.
 * Same colour and avatar logic as AgentBubble; live step with a timer, watching folds open in the card
 * (the workplace is not opened as a conversation of its own), and the summary when it is done.
 * `?delegation=<id>` in the URL (a push) opens this card and scrolls it into view.
 */
export function DelegationCard({ ev }: { ev: DelegationEvent }) {
  const agents = useAgents();
  const [d, refresh] = useDelegation(ev);
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState(0);
  const rowRef = useRef<HTMLDivElement>(null);
  // a push for this delegation (?delegation=<id>): open the card and bring it into view, once
  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.get('delegation') !== ev.delegationId) return;
    setOpen(true);
    u.searchParams.delete('delegation');
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
    // after the chat has landed at the bottom
    const t = setTimeout(() => rowRef.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), 500);
    return () => clearTimeout(t);
  }, [ev.delegationId]);
  const a = findAgent(agents, d?.agent.id ?? ev.agentId ?? undefined, d?.agent.name ?? ev.agentName);
  const name = a?.name ?? d?.agent.name ?? ev.agentName ?? 'Agent';
  const color = a?.color ?? d?.agent.color ?? '#6366f1';
  const status: DelegationStatus = d?.status ?? ev.status ?? 'queued';
  const title = d?.title ?? ev.title;
  const summary = d?.summary ?? ev.summary ?? null;
  const running = status === 'running';
  // from the first start of the delegation (started_at), not from the current run: a follow-up round or a
  // remount after navigating would otherwise start the timer at 0 again
  // a new round after it was done (steered from the card): from the start of that run
  const since = d?.finishedAt ? d?.live?.runStartedAt : ((d?.startedAt ? Date.parse(d.startedAt) : undefined) ?? d?.live?.runStartedAt);
  const elapsed = useElapsed(running ? since : undefined, running);
  const step = d?.live?.step;
  const steps = d?.live?.steps ?? 0;
  const convId = d?.conversationId ?? ev.conversationId;
  const inline = open && !narrow;
  const took = status === 'done' || status === 'failed' ? duration(d?.startedAt ?? ev.at, d?.finishedAt ?? ev.finishedAt) : '';
  // an agent it asked (Vraag aan Designer) works along: "Builder + Designer", and the step says who is at it
  const crew = (d?.crew ?? []).map((m) => {
    const x = findAgent(agents, m.id ?? undefined, m.name);
    return { key: m.id ?? m.name, name: x?.name ?? m.name, avatar: x?.avatar, color: x?.color ?? '#6366f1' };
  });
  const team = crew.length > 1 ? crew : null;
  // while it runs the card glows in the colour of this agent (mixed and circling for every crew member in a team)
  const glowMembers = team ?? [{ key: a?.id ?? ev.agentId ?? name, color: a?.color ?? d?.agent.color }];
  const act = team && d?.live?.active ? findAgent(agents, d.live.active.id ?? undefined, d.live.active.name) : undefined;
  const actor = team && d?.live?.active ? { name: act?.name ?? d.live.active.name, avatar: act?.avatar, color: act?.color ?? '#6366f1' } : null;

  const head = (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 min-w-0">
        {team ? (
          <span key={team.length} className="dg-crew-faces dg-crew shrink-0" aria-hidden>
            {team.map((m) => <Face key={m.key} name={m.name} avatar={m.avatar} color={m.color} size={16} top={!!actor && m.name === actor.name} />)}
          </span>
        ) : (
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="ag-name text-[13px] font-semibold shrink-0">{name}</span>
            <span className="text-[11px] text-(--muted) truncate">eigen werkplek</span>
          </div>
        )}
        <StatusPill status={status} position={d?.position} color={color} wait={d?.wait} />
      </div>
      {team && (
        <p key={`n${team.length}`} className="dg-crew-names mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0 min-w-0">
          <span className="sr-only">{team.map((m) => m.name).join(' en ')}</span>
          {team.map((m, i) => (
            <span key={m.key} className="whitespace-nowrap" aria-hidden>
              <span className="ag-name text-[13px] font-semibold" style={{ '--ag': m.color } as React.CSSProperties}>{m.name}</span>
              {i < team.length - 1 && <span className="dg-crew-plus">+</span>}
            </span>
          ))}
        </p>
      )}
      <p className="text-sm text-(--text) font-medium leading-snug mt-0.5 break-words">{title}</p>
    </div>
  );
  const liveLine = (
    <div className="dg-live text-xs text-(--muted)">
      <div className="flex items-center gap-2 min-w-0">
        <span className="typing-dots shrink-0" aria-hidden><i /><i /><i /></span>
        {actor && (
          <span key={actor.name} className="dg-actor shrink-0" style={{ '--ag': actor.color } as React.CSSProperties}>
            <Face name={actor.name} avatar={actor.avatar} color={actor.color} size={18} initial />
            <span className="ag-name font-semibold">{actor.name}</span>
          </span>
        )}
        <span key={step ? `${step.tool}-${step.at}` : 'start'} className="agent-step-now truncate">
          {step && step.tool !== 'start' ? stepLabel(step) : actor ? 'begint' : `${name} begint`}
        </span>
      </div>
      <div className="dg-meta flex items-center gap-3 mt-1">
        {elapsed && <span>bezig {elapsed}</span>}
        {steps > 0 && <span>{steps} {steps === 1 ? 'stap' : 'stappen'}</span>}
      </div>
    </div>
  );
  const watch = (left: React.ReactNode) => (
    <>
      <DelegationWatch conversationId={convId} onRun={refresh} onQueue={setQueued} />
      <SteerBar conversationId={convId} agentName={name} title={title} busy={running || status === 'queued'} queued={queued} onSent={refresh} left={left} />
    </>
  );
  const toggleLink = (
    <button type="button" className="dg-open" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      {open ? 'Inklappen' : 'Meekijken'}
      <Chevron open={inline} />
    </button>
  );

  return (
    <div ref={rowRef} className="ag-row msg-in flex justify-start items-start gap-2 px-4 md:px-6 py-1.5" style={{ '--ag': color } as React.CSSProperties}>
      <AgentAvatar name={name} avatar={a?.avatar} color={color} className="w-8 h-8 text-xs mt-0.5 relative z-[1]" />
      <div className={clsx('dg-card min-w-0 w-full max-w-[85%] md:max-w-[75%]', `is-${status}`, open && 'is-watching')}
        role="group" aria-label={`${team ? team.map((m) => m.name).join(' en ') : name}: ${title}, ${LABEL[status]}${actor ? `, ${actor.name} is bezig` : ''}`}>
        <AgentGlow colors={running ? glowMembers.map((m) => glowColor(m.color)) : []} />
        {/* the header opens the workplace inside the chat (a bottom sheet on a phone) */}
        <button type="button" className="dg-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}
          title={open ? 'Inklappen' : 'Meekijken'}>
          {head}
        </button>

        {/* live: what it does right now and for how long */}
        <div className={clsx('dg-fold', running && 'is-open')}>
          <div>{liveLine}</div>
        </div>

        <div className={clsx('dg-fold', (status === 'queued' || status === 'interrupted') && !inline && 'is-open')}>
          <div>
            <p className="dg-live text-xs text-(--muted)">
              {status === 'queued'
                ? 'Start vanzelf zodra er ruimte is (hooguit 3 tegelijk, abonnement onder 80%).'
                : 'Gaat vanzelf verder na de limiet of herstart. Je kunt ook zelf bijsturen.'}
            </p>
          </div>
        </div>

        {/* afterwards: the summary (open, the report itself is in the workplace view) */}
        <div className={clsx('dg-fold', !!summary && (status === 'done' || status === 'failed') && !inline && 'is-open')}>
          <div>
            <p className={clsx('dg-summary text-sm leading-relaxed', status === 'failed' ? 'text-(--bad)' : 'text-(--text)')}>{summary}</p>
          </div>
        </div>

        {/* desktop: the workplace folds open in the card */}
        <div className={clsx('dg-fold', inline && 'is-open')}>
          <div>{inline && <div className="dg-panel">{watch(<div className="dg-links">{toggleLink}</div>)}</div>}</div>
        </div>

        {/* one foot line; open on desktop it sits under the steering field instead */}
        {!inline && (
          <div className="dg-foot">
            <div className="dg-links">{toggleLink}</div>
            {took && <span className="text-[11px] text-(--muted) ml-auto">{status === 'done' ? 'klaar' : 'gestopt'} {took}</span>}
          </div>
        )}
      </div>
      {open && narrow && (
        <Sheet onClose={() => setOpen(false)} head={<div style={{ '--ag': color } as React.CSSProperties} className="flex items-start gap-2">
          <AgentAvatar name={name} avatar={a?.avatar} color={color} className="w-8 h-8 text-xs shrink-0" />
          <div className="min-w-0 flex-1">{head}{running && liveLine}</div>
        </div>}>
          <div className="dg-sheet-body" style={{ '--ag': color } as React.CSSProperties}>{watch(null)}</div>
        </Sheet>
      )}
    </div>
  );
}

/** Delegation events in a stored or live answer. */
export function delegationEvents(events: Array<{ type: string }> | null | undefined): DelegationEvent[] {
  return (events ?? []).filter((e): e is DelegationEvent => e.type === 'delegation' && typeof (e as DelegationEvent).delegationId === 'string');
}
