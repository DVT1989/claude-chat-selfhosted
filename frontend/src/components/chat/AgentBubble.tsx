'use client';

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AgentGlow } from './AgentGlow';
import { glowColor } from './agentGlowUtils';
import clsx from 'clsx';
import { agentsApi, type AgentDef } from '@/lib/api';
import { MarkdownBlock } from './MessageBubble';
import { LimitIcon, limitTime, nogText, useTick } from './LimitNotice';

// ── The user's agents, loaded once and shared by every bubble ──
let cache: AgentDef[] | null = null;
let loading: Promise<AgentDef[]> | null = null;
const listeners = new Set<(a: AgentDef[]) => void>();

function load(): Promise<AgentDef[]> {
  loading ??= agentsApi.list().then((r) => { cache = r.agents; listeners.forEach((l) => l(r.agents)); return r.agents; })
    .catch(() => {
      // failed (network, a restart): try again shortly, so live bubbles still get their colour and photo
      loading = null;
      setTimeout(() => { if (!cache && listeners.size) void load(); }, 3000);
      return cache ?? [];
    });
  return loading;
}

/** Call after a change on the settings page so open chats show the new name or photo. */
export function setAgentsCache(list: AgentDef[]): void {
  cache = list; loading = Promise.resolve(list);
  listeners.forEach((l) => l(list));
}

export function useAgents(): AgentDef[] {
  const [list, setList] = useState<AgentDef[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setList);
    // loaded between this render and the effect: the listener came too late for that notice
    if (cache) setList(cache);
    void load();
    return () => { listeners.delete(setList); };
  }, []);
  return list;
}

/**
 * An agent by what the stream or history gives: its id, its slug (with or without "agent-") or its name.
 * Live events and older messages do not always carry the database id, so the colour must not depend on it.
 */
export function findAgent(list: AgentDef[], id?: string, name?: string): AgentDef | undefined {
  const low = (s?: string) => (s ?? '').trim().toLowerCase();
  const i = low(id); const n = low(name);
  const bare = (s: string) => s.replace(/^agent-/, '');
  return (i ? list.find((a) => a.id === id) ?? list.find((a) => low(a.slug) === i || bare(low(a.slug)) === bare(i)) : undefined)
    ?? (n ? list.find((a) => low(a.name) === n || bare(low(a.slug)) === n.replace(/\s+/g, '-')) : undefined)
    ?? (i ? list.find((a) => low(a.name) === bare(i).replace(/-/g, ' ')) : undefined);
}

/**
 * The agent's own words, without Claude Code's wrapping: the tools line, the "[Subagent hand-back]"
 * preamble, the indent it puts before every report line, and the trailing agentId/usage bookkeeping.
 */
export function cleanAgentReport(text: string): string {
  let t = text.replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/g, '')
    .replace(/<usage>[\s\S]*?<\/usage>/g, '').replace(/\n*agentId: [\s\S]*$/, '');
  const hand = t.indexOf('[Subagent hand-back]');
  if (hand >= 0) {
    const follows = t.indexOf('The report follows:', hand);
    t = follows >= 0 ? t.slice(follows + 'The report follows:'.length) : t.slice(t.indexOf('\n', hand) + 1);
  }
  const lines = t.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(cut, l.match(/^[ \t]*/)![0].length))).join('\n').trim();
}

/** Initials from the name: first letters of the first two words, or the first two letters. */
export function agentInitials(name: string): string {
  const words = name.trim().split(/[\s\-_.]+/).filter(Boolean);
  if (!words.length) return '?';
  const s = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return s.toUpperCase();
}

export function AgentAvatar({ name, avatar, color, className = 'w-8 h-8 text-xs' }: { name: string; avatar?: string | null; color?: string; className?: string }) {
  if (avatar) {
    return (
      <span className={clsx(className, 'rounded-full shrink-0 overflow-hidden block')}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatar} alt="" className="w-full h-full object-cover" />
      </span>
    );
  }
  return (
    <span className={clsx(className, 'rounded-full shrink-0 flex items-center justify-center font-semibold text-white')}
      style={{ backgroundColor: color ?? '#6366f1' }}>
      {agentInitials(name)}
    </span>
  );
}

const ACTIVITY: Record<string, string> = {
  Bash: 'voert een commando uit', Read: 'leest een bestand', Write: 'schrijft een bestand', Edit: 'past een bestand aan',
  Grep: 'zoekt in bestanden', Glob: 'zoekt bestanden', WebSearch: 'zoekt op internet', WebFetch: 'opent een webpagina',
  text: 'denkt na', Agent: 'schakelt een helper in', Task: 'schakelt een helper in',
};
const VERB: Record<string, string> = {
  Bash: 'Commando', Read: 'Leest', Write: 'Schrijft', Edit: 'Past aan', NotebookEdit: 'Past aan', Grep: 'Zoekt', Glob: 'Zoekt',
  WebSearch: 'Zoekt online', WebFetch: 'Opent', text: 'Denkt', Agent: 'Helper', Task: 'Helper', TodoWrite: 'Plant',
};
const NO_VERB = new Set(['background']);

function continueText(name: string, task?: string): string {
  return `${name} werd onderbroken${task ? ` tijdens "${task}"` : ''}. Laat ${name} verder gaan waar het stopte: kijk eerst wat er al gedaan is en maak het dan af.`;
}
/** Ask the open chat to continue an interrupted agent (ChatWindow listens and sends it as a message). */
export function continueAgent(name: string, task?: string): void {
  window.dispatchEvent(new CustomEvent('agent-continue', { detail: { text: continueText(name, task) } }));
}
/** Inside a workplace card: "Verder" goes to that workplace, not to the chat around the card. */
export const AgentContinueContext = createContext<((text: string) => void) | null>(null);

export interface AgentStep { tool: string; detail: string; at: number }

export function stepLabel(s: AgentStep): string {
  if (NO_VERB.has(s.tool)) return s.detail;
  const verb = VERB[s.tool] ?? s.tool;
  return s.detail ? `${verb}: ${s.detail}` : (ACTIVITY[s.tool] ?? `gebruikt ${s.tool}`);
}

export function useElapsed(since?: number, running = true): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since, running]);
  if (!since) return '';
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

// ── UI #27 (design Designer): agents visibly talking to each other ──
// "Builder vraagt Designer" runs via the main Claude: Builder's report ends with "Vraag aan Designer: ...", then Designer gets a bubble,
// then Builder again (SendMessage). The link is derived here from the report text; no extra data needed.

export interface AgentAsk { name: string; text: string }

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** "Vraag aan Designer: ..." / "Overdracht aan Helpdesk: ..." in a report (bullets and bold allowed). */
export function findAsk(report: string, names: string[]): (AgentAsk & { line: string }) | undefined {
  const alt = names.length ? [...names].sort((a, b) => b.length - a.length).map(escapeRe).join('|') : '[\\p{L}][\\p{L}\\d-]*';
  const re = new RegExp(`^[ \\t>*_\\-•]*(?:\\*\\*)?(?:Vraag|Overdracht) aan (${alt})(?:\\*\\*)?[ \\t]*[:：](?:\\*\\*)?[ \\t]*(.*)$`, 'imu');
  const m = report.match(re);
  if (!m) return undefined;
  const name = names.find((n) => n.toLowerCase() === m[1].toLowerCase()) ?? m[1];
  return { name, text: m[2].replace(/\*\*/g, '').trim(), line: m[0] };
}

export interface ChainInput {
  agentId: string; agentName: string;
  /** undefined while the agent works */
  content?: string; isError?: boolean;
  /** no main text between this bubble and the previous agent bubble (the rail may run) */
  adjacentPrev: boolean;
}

export interface ChainInfo {
  askedTo?: AgentAsk & { line: string; answered: boolean };
  /** this bubble answers a question of that agent ("Designer → Builder") */
  answerTo?: string;
  /** this bubble is the follow-up after that agent answered */
  followUpOf?: string;
  railUp: boolean; railDown: boolean;
  /** clamp the report to this many lines (0 = open) */
  clamp: 0 | 3 | 6;
}

/** Per agent bubble (in order): who asked whom, follow-ups, rails between adjacent chain bubbles, clamping. */
export function deriveChain(items: ChainInput[], names: string[]): ChainInfo[] {
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const asks = items.map((it) => (it.content && !it.isError ? findAsk(cleanAgentReport(it.content), names) : undefined));
  const out: ChainInfo[] = items.map((it, i) => {
    const ask = asks[i];
    const answered = !!ask && items.some((x, j) => j > i && same(x.agentName, ask.name) && x.content !== undefined);
    const prev = items[i - 1];
    const answerTo = prev && same(asks[i - 1]?.name, it.agentName) ? prev.agentName : undefined;
    const two = items[i - 2];
    const followUpOf = two && two.agentId === it.agentId && same(asks[i - 2]?.name, prev?.agentName) ? prev.agentName : undefined;
    return { askedTo: ask ? { ...ask, answered } : undefined, answerTo, followUpOf, railUp: false, railDown: false, clamp: 0 };
  });
  // rails: only between adjacent bubbles that belong together
  for (let i = 1; i < items.length; i++) {
    if (items[i].adjacentPrev && (out[i].answerTo || out[i].followUpOf)) { out[i].railUp = true; out[i - 1].railDown = true; }
  }
  // calm in long chains: from 6 bubbles on only the last two stay open; long reports always clamp
  let start = 0;
  for (let i = 1; i <= items.length; i++) {
    if (i < items.length && out[i].railUp) continue;
    const len = i - start;
    for (let k = start; k < i; k++) {
      const lines = (items[k].content ?? '').split('\n').length;
      out[k].clamp = len >= 6 && k < i - 2 ? 3 : lines > 8 ? 6 : 0;
    }
    start = i;
  }
  return out;
}

/** How an interrupted agent continues: planned (limit / restart) and, once known, when it resumed. */
export interface AgentWait { reason: 'limit' | 'restart'; resumeAt?: string; resumedAt?: string; at?: string }

/** A short planned pause (token renewed, ~2-3 min) is no usage limit: say so. */
export function isShortWait(w?: AgentWait): boolean {
  if (!w?.resumeAt || !w.at || w.reason !== 'limit') return false;
  const d = Date.parse(w.resumeAt) - Date.parse(w.at);
  return Number.isFinite(d) && d > 0 && d <= 5 * 60_000;
}

/** The report with clamping and "Toon alles" (fade at the bottom while clamped). */
function ClampedReport({ text, lines }: { text: string; lines: 0 | 3 | 6 }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !lines) { setOver(false); return; }
    // cut on a whole line: the bottom of the Nth text line (paragraph and list margins make a fixed
    // N * line-height land halfway a line); the fade covers about the last 1.2 line (CSS --ag-fade)
    const fit = () => {
      el.style.maxHeight = '';
      if (open) { setOver(el.scrollHeight > el.clientHeight + 2); return; }
      const top = el.getBoundingClientRect().top;
      const range = document.createRange(); range.selectNodeContents(el);
      const rows: Array<{ top: number; bottom: number }> = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1 || r.height < 1) continue;
        const row = rows.find((x) => Math.abs(x.top - r.top) < r.height / 2);
        if (row) row.bottom = Math.max(row.bottom, r.bottom); else rows.push({ top: r.top, bottom: r.bottom });
      }
      rows.sort((a, b) => a.top - b.top);
      const lh = parseFloat(getComputedStyle(el.querySelector('p, li') ?? el).lineHeight) || 24;
      el.style.setProperty('--ag-fade', `${Math.round(lh * 1.2)}px`);
      if (rows.length > lines) {
        const row = rows[lines - 1];
        // half the line-height leading below the glyph box, so descenders stay whole
        const cut = Math.ceil(row.bottom - top + Math.max(2, (lh - (row.bottom - row.top)) / 2));
        el.style.maxHeight = `${cut}px`;
      } else if (rows.length) el.style.maxHeight = 'none';
      setOver(el.scrollHeight > el.clientHeight + 2);
    };
    fit();
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines, open]);
  if (!lines) return <MarkdownBlock text={text} />;
  return (
    <>
      <div ref={ref} className={clsx('ag-clamp', !open && 'is-clamped', !open && over && 'has-more')} style={{ '--ag-lines': lines } as React.CSSProperties}>
        <MarkdownBlock text={text} />
      </div>
      {(over || open) && (
        <button type="button" className="ag-more text-[11px] text-(--muted) underline-offset-2 hover:underline mt-1" onClick={() => setOpen((o) => !o)}>
          {open ? 'minder' : 'Toon alles'}
        </button>
      )}
    </>
  );
}

/** The question strip at the bottom of the asking bubble: @mention chip, the question, waiting / answered. */
function AskStrip({ ask, color, avatar, pulse, settled }: { ask: AgentAsk & { answered: boolean }; color: string; avatar?: string | null; pulse: boolean; settled?: boolean }) {
  return (
    <div className="ag-ask mt-2 pt-2 border-t border-(--border)" style={{ '--ag-to': color } as React.CSSProperties}>
      <div className="flex items-center gap-1.5 min-w-0">
        <svg className="w-3.5 h-3.5 shrink-0 text-(--muted)" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12h14m-5-5 5 5-5 5" /></svg>
        <span className="ag-mention">
          {avatar
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={avatar} alt="" className="ag-mention-dot object-cover" />
            : <span className="ag-mention-dot" style={{ backgroundColor: color }}>{agentInitials(ask.name).slice(0, 1)}</span>}
          @{ask.name}
        </span>
        <span key={ask.answered ? 'a' : 'w'} className={clsx('ag-ask-state ml-auto text-[11px] shrink-0 flex items-center gap-1', ask.answered ? 'text-(--ok)' : 'text-(--muted)', !ask.answered && !settled && pulse && 'ag-pulse')}>
          {ask.answered && <span className="w-3 h-3 [&>svg]:w-full [&>svg]:h-full">{LimitIcon.check}</span>}
          {ask.answered ? `beantwoord door ${ask.name}` : settled ? `gevraagd aan ${ask.name}` : `wacht op ${ask.name}`}
        </span>
      </div>
      {ask.text && <p className="text-[13px] text-(--muted) mt-1 line-clamp-3">{ask.text}</p>}
    </div>
  );
}

/**
 * One agent's turn in the conversation: its avatar on the left, its name above, like another
 * participant in a group chat. While it works: what it is doing right now, the last steps and a timer,
 * so it is visible that work goes on; all steps can be opened.
 */
export function AgentBubble({ agentId, agentName, task, content, isError, activity, steps, startedAt, interrupted, chain, nextAgentId, nextAgentName, pulse = true, wait, resumedFrom, settled }: {
  agentId: string; agentName: string; task?: string; content?: string; isError?: boolean; activity?: string;
  steps?: AgentStep[]; startedAt?: number; interrupted?: boolean;
  /** UI #27: place in a conversation between agents (deriveChain) */
  chain?: ChainInfo;
  /** the agent of the bubble below in the chain (rail gradient towards its colour) */
  nextAgentId?: string;
  nextAgentName?: string;
  /** may this bubble move (max. one pulse at a time) */
  pulse?: boolean;
  /** stopped by the limit or a restart: waiting, or resumed later */
  wait?: AgentWait;
  /** this bubble continues an interrupted run of the agent (ISO time it resumed) */
  resumedFrom?: string;
  /** the answer around it is finished (history): an unanswered question no longer waits */
  settled?: boolean;
}) {
  const agents = useAgents();
  const sendContinue = useContext(AgentContinueContext);
  const a = findAgent(agents, agentId, agentName);
  const name = a?.name ?? agentName;
  const color = a?.color ?? '#6366f1';
  const busy = content === undefined && !wait;
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(startedAt, busy);
  const list = steps ?? [];
  const current = list[list.length - 1];
  const shown = open ? list.slice(0, -1) : list.slice(-4, -1);
  const askTo = chain?.askedTo ? findAgent(agents, undefined, chain.askedTo.name) : undefined;
  // "Hervat om 14:32" for 4 s when a resumed run starts, then the normal working view
  const resumedMs = resumedFrom ? Date.parse(resumedFrom) : NaN;
  const [showResumed, setShowResumed] = useState(() => busy && Number.isFinite(resumedMs) && Date.now() - resumedMs < 4000);
  useEffect(() => {
    if (!showResumed) return;
    const t = setTimeout(() => setShowResumed(false), Math.max(0, 4000 - (Date.now() - resumedMs)));
    return () => clearTimeout(t);
  }, [showResumed, resumedMs]);
  const waitAt = wait?.resumeAt ? new Date(wait.resumeAt) : null;
  const waiting = !!wait && !wait.resumedAt && !!waitAt && waitAt.getTime() > Date.now() - 5 * 60_000;
  const now = useTick(waiting);
  // the sub line under the name: who talks to whom, follow-ups, resumes
  const subParts: string[] = [];
  if (chain?.askedTo) subParts.push(`${name} → ${chain.askedTo.name}`);
  else if (chain?.answerTo) subParts.push(busy ? `${name} → ${chain.answerTo}${task ? ` · ${task}` : ''}` : `antwoord aan ${chain.answerTo}`);
  else if (chain?.followUpOf) subParts.push(`vervolg na antwoord van ${chain.followUpOf}`);
  if (resumedFrom) subParts.push(`hervat ${limitTime(resumedFrom)}${content !== undefined && !isError ? ' · klaar' : ''}`);
  const sub = subParts.join(' · ');
  const showTask = task && !(chain?.answerTo && busy);
  let report = content !== undefined ? cleanAgentReport(content) : '';
  if (chain?.askedTo) report = report.replace(chain.askedTo.line, '').replace(/\n{3,}/g, '\n\n').trim();
  return (
    <div className={clsx('ag-row msg-in flex justify-start items-start gap-2 px-4 md:px-6', chain && (chain.railUp || chain.railDown) ? 'py-0.5' : 'py-1.5', chain?.railUp && 'rail-up', chain?.railDown && 'rail-down')}
      style={{ '--ag': color, '--ag-next': findAgent(agents, nextAgentId, nextAgentName)?.color ?? color } as React.CSSProperties}>
      <AgentAvatar name={name} avatar={a?.avatar} color={color} className="w-8 h-8 text-xs mt-0.5 relative z-[1]" />
      <div className={clsx('wa-bubble wa-in min-w-0 max-w-[85%] md:max-w-[75%]', busy && !activity && !showResumed && 'typing-bubble')}>
        <AgentGlow colors={busy ? [glowColor(color)] : []} />
        <div className="wa-body">
          <div className={clsx('min-w-0', sub ? 'mb-1.5' : 'mb-1')}>
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="ag-name text-[13px] font-semibold shrink-0">{name}</span>
              {showTask && <span className="text-xs text-(--muted) truncate">{task}</span>}
            </div>
            {sub && <div className="ag-sub text-[11px] text-(--muted) truncate">{sub}</div>}
          </div>
          {busy && showResumed ? (
            <div className="ag-resumed flex items-center gap-1.5 text-sm text-(--ok)">
              <span className="w-4 h-4 [&>svg]:w-full [&>svg]:h-full">{LimitIcon.check}</span>
              Hervat om {limitTime(resumedFrom)}
            </div>
          ) : wait && wait.resumedAt ? (
            <p className="agent-interrupted flex items-center gap-1.5 text-sm text-(--muted)">
              <span className="w-3.5 h-3.5 shrink-0 [&>svg]:w-full [&>svg]:h-full">{LimitIcon.clock}</span>
              Onderbroken door {isShortWait(wait) ? 'een verlopen aanmelding' : wait.reason === 'limit' ? 'limiet' : 'een herstart'}, hervat om {limitTime(wait.resumedAt)}
            </p>
          ) : waiting ? (
            <div className="agent-interrupted text-sm">
              <p className="flex items-center gap-1.5 text-(--text)">
                <span className={clsx('w-4 h-4 shrink-0 text-(--warn) [&>svg]:w-full [&>svg]:h-full', pulse && 'ag-pulse')}>{LimitIcon.clock}</span>
                {isShortWait(wait) ? `Even onderbroken, aanmelding wordt vernieuwd. ${name} gaat om ${limitTime(waitAt)} verder.`
                  : wait!.reason === 'limit' ? `Wacht op reset, ${nogText(waitAt, now)}. ${name} gaat om ${limitTime(waitAt)} verder.` : `Hervat zo. ${name} gaat zo verder.`}
              </p>
            </div>
          ) : busy ? (
            <div className="agent-live text-xs text-(--muted)">
              {shown.length > 0 && (
                <ul className="agent-steps">
                  {shown.map((s, i) => (
                    <li key={`${s.at}-${i}`} className="agent-step done"><span className="agent-step-dot" />{stepLabel(s)}</li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2 min-w-0">
                <span className={clsx('typing-dots shrink-0', !pulse && 'is-still')} aria-label={`${name} is bezig`}><i /><i /><i /></span>
                {current
                  ? <span key={current.at} className="agent-step-now truncate">{stepLabel(current)}</span>
                  : activity && <span>{ACTIVITY[activity] ?? `gebruikt ${activity}`}</span>}
              </div>
              {(elapsed || list.length > 0) && (
                <div className="flex items-center gap-3 mt-1 text-[11px] opacity-80">
                  {elapsed && <span>bezig {elapsed}</span>}
                  {list.length > 0 && <span>{list.length} {list.length === 1 ? 'stap' : 'stappen'}</span>}
                  {list.length > 4 && (
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => setOpen((o) => !o)}>
                      {open ? 'minder' : 'alle stappen'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : wait || interrupted || (isError && /^onderbroken$/i.test((content ?? '').trim())) ? (
            <div className="agent-interrupted flex flex-wrap items-center gap-2 text-sm">
              <span className="text-red-400">Onderbroken voordat {name} klaar was.</span>
              <button type="button" className="agent-continue-btn" onClick={() => (sendContinue ? sendContinue(continueText(name, task)) : continueAgent(name, task))}>Verder</button>
            </div>
          ) : isError ? (
            <p className="text-sm text-red-400 whitespace-pre-wrap">{content || 'De agent gaf een fout.'}</p>
          ) : (
            <ClampedReport text={report || '(geen antwoord)'} lines={chain?.clamp ?? 0} />
          )}
          {chain?.askedTo && content !== undefined && !isError && (
            <AskStrip ask={chain.askedTo} color={askTo?.color ?? '#6366f1'} avatar={askTo?.avatar} pulse={pulse} settled={settled} />
          )}
        </div>
      </div>
    </div>
  );
}
