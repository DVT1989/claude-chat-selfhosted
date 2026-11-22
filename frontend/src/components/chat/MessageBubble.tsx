'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { useState, memo, useLayoutEffect, useRef } from 'react';
import type { Message } from '@/types';
import clsx from 'clsx';
import { format } from 'date-fns';

import { AgentBubble, useAgents, deriveChain, type AgentStep, type AgentWait } from './AgentBubble';
import { splitMentions } from './MentionMenu';
import { tasksApi } from '@/lib/api';
import { LimitEventLine, LimitLine, limitTime, type LimitEvent } from './LimitNotice';
import { DelegationCard, delegationEvents } from './DelegationCard';

import 'highlight.js/styles/github-dark.css';

interface Props {
  message: Message;
  /** the saved answer that just replaced the live bubble: a soft cross-fade instead of popping in again */
  still?: boolean;
  /** the message just sent: slides up out of the composer */
  sent?: boolean;
  /** on its way from the composer: hidden here until the flying copy lands */
  flying?: boolean;
  /** UI #27: resumes of interrupted agents across messages (linkResumes) */
  agentLinks?: AgentLinks;
  /** no live run is moving: a waiting clock in the history may pulse */
  calm?: boolean;
  /** live steps per agent turn (toolUseId), from agent_activity: the busy bubble shows its step and timer */
  agentLive?: Map<string, { steps: AgentStep[]; activity?: string }>;
}

type StoredEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; toolName: string; toolInput: unknown; toolUseId?: string }
  | { type: 'tool_result'; toolUseId?: string; content: string; isError: boolean }
  | { type: 'rate_limited'; resetAt: string | null; message: string; at?: string }
  | { type: 'limit_note'; kind: 'switched'; at?: string }
  | { type: 'agent_start'; toolUseId: string; agentId: string; agentName: string; task?: string; resumed?: boolean; at?: string; ccAgentId?: string }
  | { type: 'agent_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'agent_interrupted'; toolUseId?: string; agentId: string; agentName: string; ccAgentId?: string; reason: 'limit' | 'restart'; at?: string; resumeAt?: string }
  | { type: 'delegation'; delegationId: string; conversationId: string; title: string; agentId?: string | null; agentName?: string };

type Segment =
  | { kind: 'main'; events: StoredEvent[] }
  | { kind: 'agent'; toolUseId: string; agentId: string; agentName: string; task?: string; content?: string; isError?: boolean; at?: string;
      /** no main text between this and the previous agent bubble */
      adjacentPrev: boolean; wait?: AgentWait };

/** An answer with agent turns: main parts and agent bubbles in the order they happened. */
function splitAgents(events: StoredEvent[]): Segment[] {
  const results = new Map<string, StoredEvent & { type: 'agent_result' }>();
  const cuts = new Map<string, StoredEvent & { type: 'agent_interrupted' }>();
  for (const e of events) {
    if (e.type === 'agent_result') results.set(e.toolUseId, e);
    else if (e.type === 'agent_interrupted' && e.toolUseId) cuts.set(e.toolUseId, e);
  }
  const out: Segment[] = [];
  let cur: StoredEvent[] = [];
  const flush = () => {
    if (cur.some((e) => e.type === 'tool_use' || e.type === 'thinking' || (e.type === 'text' && e.text.trim()))) out.push({ kind: 'main', events: cur });
    cur = [];
  };
  for (const e of events) {
    if (e.type === 'agent_start') {
      flush();
      const r = results.get(e.toolUseId);
      const c = cuts.get(e.toolUseId);
      out.push({ kind: 'agent', toolUseId: e.toolUseId, agentId: e.agentId, agentName: e.agentName, task: e.task, at: e.at, content: r?.content ?? (r ? '' : undefined), isError: r?.isError,
        adjacentPrev: out[out.length - 1]?.kind === 'agent', wait: c ? { reason: c.reason, resumeAt: c.resumeAt, at: c.at } : undefined });
    } else if (e.type !== 'agent_result' && e.type !== 'agent_interrupted') cur.push(e);
  }
  flush();
  return out;
}

/** UI #27: per bubble, across messages: when an interrupted agent resumed (old bubble) / that it is a resume (new one). */
export type AgentLinks = Map<string, { resumedAt?: string; resumedFrom?: string }>;
export interface AgentLastState { toolUseId: string; cut: boolean }

/** Walks the stored answers in order. `last` (key ccAgentId or agentId) says whether an agent's latest bubble was cut off. */
export function linkResumes(messages: Message[]): { links: AgentLinks; last: Map<string, AgentLastState> } {
  const links: AgentLinks = new Map();
  const last = new Map<string, AgentLastState>();
  let autoSince = false;
  for (const m of messages) {
    if (m.role === 'user') { if (m.metadata?.auto) autoSince = true; continue; }
    const ev = parseStructured(m.content);
    if (!ev) continue;
    const results = new Map<string, StoredEvent & { type: 'agent_result' }>();
    const cut = new Set<string>();
    for (const e of ev) {
      if (e.type === 'agent_result') results.set(e.toolUseId, e);
      else if (e.type === 'agent_interrupted' && e.toolUseId) cut.add(e.toolUseId);
    }
    for (const e of ev) {
      if (e.type !== 'agent_start') continue;
      const keys = [e.ccAgentId, e.agentId].filter(Boolean) as string[];
      const prev = keys.map((k) => last.get(k)).find(Boolean);
      // resumed with SendMessage (or started again after an automatic follow-up) while its previous bubble was cut off
      if (prev?.cut && (e.resumed || autoSince)) {
        const at = e.at ?? m.created_at;
        links.set(prev.toolUseId, { ...links.get(prev.toolUseId), resumedAt: at });
        links.set(e.toolUseId, { ...links.get(e.toolUseId), resumedFrom: at });
      }
      const r = results.get(e.toolUseId);
      const isCut = cut.has(e.toolUseId) || (!r && !m.metadata?.streaming) || (!!r?.isError && /^onderbroken$/i.test(r.content.trim()));
      for (const k of keys) last.set(k, { toolUseId: e.toolUseId, cut: isCut });
    }
    autoSince = false;
  }
  return { links, last };
}

function parseStructured(content: string): StoredEvent[] | null {
  if (!content.startsWith('[')) return null;
  try {
    const arr = JSON.parse(content) as StoredEvent[];
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0]?.type === 'string') return arr;
  } catch { /* ignore */ }
  return null;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="text-(--muted) hover:text-(--text) transition-colors text-xs px-2 py-1 rounded"
    >
      {copied ? 'Gekopieerd' : 'Kopieer'}
    </button>
  );
}

/** Action row under an answer, like the Claude app: shown on hover (always on touch screens). */
function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="flex gap-0.5 opacity-100 [@media(hover:hover)]:opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150">
      <button
        type="button"
        title={copied ? 'Gekopieerd' : 'Kopiëren'}
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="hit-44 w-6 h-6 flex items-center justify-center rounded-md text-(--muted) hover:text-(--text) hover:bg-(--input) transition-[color,background-color,transform] duration-150 active:scale-95"
      >
        {copied ? (
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" strokeWidth={2} /><path strokeLinecap="round" strokeWidth={2} d="M5 15V6a2 2 0 012-2h9" /></svg>
        )}
      </button>
    </div>
  );
}

const mdComponents = {
  pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
    <div className="relative group">
      <pre {...props} className="!mt-2 !mb-2">
        {children}
      </pre>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton
          text={((children as React.ReactElement<{ children?: string }>)?.props?.children as string) ?? ''}
        />
      </div>
    </div>
  ),
};

export function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={mdComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Mask passwords in shell commands before display */
export function maskPasswords(text: string): string {
  return text
    .replace(/sshpass\s+-p\s+(['"])([^'"]+)\1/g, "sshpass -p '***'")
    .replace(/(-U\s+['"][^%'"]+%)([^'"]+)(['"])/g, '$1***$3')
    .replace(/(lftp\s+-u\s+['"][^,'"]+,)([^'"]+)(['"])/g, '$1***$3')
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g, '$1***')
    .replace(/(Authorization:\s+Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g, '$1***')
    .replace(/echo\s+(['"])[^'"]+\1\s*\|\s*sudo\s+-S/g, "echo '***' | sudo -S")
    .replace(/(PGPASSWORD=)[^\s]+/g, '$1***')
    .replace(/(mysql\s+.*-p)[^\s]+/g, '$1***');
}

/** Extract a human-readable summary of what the tool did */
export function getToolSummary(toolName: string, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;

  if (toolName === 'Bash' || toolName === 'bash') {
    const cmd = (input.command as string) ?? null;
    return cmd ? maskPasswords(cmd) : null;
  }
  if (toolName === 'Write' || toolName === 'Edit') {
    return (input.file_path as string) ?? (input.path as string) ?? null;
  }
  if (toolName === 'Read') {
    return (input.file_path as string) ?? (input.path as string) ?? null;
  }
  if (toolName === 'Glob') {
    return (input.pattern as string) ?? null;
  }
  if (toolName === 'Grep') {
    return (input.pattern as string) ?? null;
  }
  const first = Object.values(input).find(v => typeof v === 'string') as string | undefined;
  return first ? maskPasswords(first) : null;
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-2 rounded-lg border border-(--border) overflow-hidden text-xs">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-(--input) hover:bg-(--border) transition-colors text-left"
      >
        <svg className="w-3 h-3 text-(--muted) shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
        <span className="text-(--muted) italic">Denkproces</span>
        {/* Arrow: ► when collapsed, ▼ when expanded */}
        <svg className={clsx('w-3 h-3 text-(--muted) ml-auto shrink-0 transition-transform', !expanded && '-rotate-90')}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 py-2 bg-(--bg) text-(--muted) text-xs whitespace-pre-wrap font-mono max-h-64 overflow-y-auto leading-relaxed">
          {thinking}
        </div>
      )}
    </div>
  );
}

export function ToolCallBlock({
  toolName,
  toolInput,
  result,
  isError,
  running,
  flat,
}: {
  toolName: string;
  toolInput: unknown;
  result?: string;
  isError?: boolean;
  running?: boolean;
  /** a row inside an activity pill: no box of its own */
  flat?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(toolName, toolInput);
  const maskedResult = result ? maskPasswords(result) : result;
  const hasResult = maskedResult !== undefined && maskedResult.trim() !== '';
  const resultLines = maskedResult?.split('\n') ?? [];
  const isLong = resultLines.length > 8 || (maskedResult?.length ?? 0) > 500;
  const displayResult = expanded ? maskedResult! : resultLines.slice(0, 8).join('\n') + (isLong ? '\n…' : '');

  return (
    <div className={clsx('min-w-0 max-w-full text-xs font-mono', !flat && 'my-1 rounded-lg border border-(--border) overflow-hidden')}>
      {/* Header */}
      <div
        className={clsx(
          'flex items-center gap-2.5 min-w-0',
          flat ? 'px-3 py-2' : 'px-3 py-2 bg-(--input)',
          hasResult && (flat ? 'cursor-pointer hover:bg-(--border) transition-colors' : 'cursor-pointer hover:bg-(--border) transition-colors'),
        )}
        onClick={() => hasResult && setExpanded(e => !e)}
      >
        {/* Status icon */}
        {running ? (
          <span className="w-3 h-3 shrink-0 rounded-full border-[1.5px] border-(--accent)/25 border-t-(--accent) animate-spin" />
        ) : (
          <svg
            className={clsx('w-3 h-3 shrink-0', isError ? 'text-red-400' : 'text-green-400')}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            {isError
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            }
          </svg>
        )}

        <span className="text-(--text) font-semibold font-sans">{toolName}</span>
        {summary && (
          <span className="text-(--muted) truncate flex-1 min-w-0">{summary}</span>
        )}
        {running && (
          <span className="text-(--muted) ml-auto shrink-0 font-sans">bezig</span>
        )}
        {/* Arrow: ► when collapsed, ▼ when expanded — only when there's a result */}
        {hasResult && (
          <svg
            className={clsx('w-3 h-3 text-(--muted) shrink-0 transition-transform', !expanded && '-rotate-90')}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </div>

      {/* Output — only when expanded */}
      {hasResult && expanded && (
        <div className={clsx('px-3 py-2 text-(--muted) whitespace-pre-wrap break-all max-h-96 overflow-y-auto', flat ? 'mx-3 mb-2 rounded-lg bg-(--well)' : 'bg-(--bg)')}>
          {displayResult}
          {isLong && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="block mt-1 text-(--accent) hover:underline text-xs"
            >
              {expanded ? 'Minder tonen' : 'Meer tonen'}
            </button>
          )}
        </div>
      )}

      {/* Preview — first 3 lines when collapsed but result exists */}
      {hasResult && !expanded && (
        <div
          className={clsx('px-3 py-2 text-(--muted) whitespace-pre-wrap break-all cursor-pointer', flat ? 'mx-3 mb-2 rounded-lg bg-(--well)' : 'bg-(--bg)')}
          onClick={() => setExpanded(true)}
        >
          <span className="line-clamp-3 block">{resultLines.slice(0, 3).join('\n')}</span>
          {(resultLines.length > 3 || isLong) && (
            <span className="text-(--accent) hover:underline text-xs mt-1 block">
              {resultLines.length - 3 > 0 ? `+${resultLines.length - 3} regels meer…` : 'Meer tonen…'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface CompletedTool {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  result?: string;
  isError?: boolean;
}

function CompletedActivityPanel({ tools }: { tools: CompletedTool[] }) {
  const [open, setOpen] = useState(false);
  const errorCount = tools.filter(t => t.isError).length;

  return (
    <div className="my-2 rounded-xl border border-(--border) overflow-hidden text-xs">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-(--input) hover:bg-(--border) transition-colors text-left"
      >
        <span className={clsx('w-2 h-2 rounded-full shrink-0', errorCount > 0 ? 'bg-red-400' : 'bg-green-400')} />
        <span className="text-(--text) font-medium">Activiteit</span>
        <span className="text-(--muted)">
          {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
          {errorCount > 0 && ` · ${errorCount} fout`}
        </span>
        <svg
          className={clsx('w-3 h-3 text-(--muted) ml-auto shrink-0 transition-transform', !open && '-rotate-90')}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-(--border) max-h-96 overflow-y-auto">
          {tools.map((tool, i) => (
            <div key={tool.toolUseId} className={clsx(i > 0 && 'border-t border-(--border)/60')}>
              <ToolCallBlock
                toolName={tool.toolName}
                toolInput={tool.toolInput}
                result={tool.result}
                isError={tool.isError}
                flat
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StructuredMessage({ events }: { events: StoredEvent[] }) {
  const resultMap = new Map<string, StoredEvent & { type: 'tool_result' }>();
  for (const ev of events) {
    if (ev.type === 'tool_result' && ev.toolUseId) {
      resultMap.set(ev.toolUseId, ev as StoredEvent & { type: 'tool_result' });
    }
  }

  const items: React.ReactNode[] = [];
  let textBuffer = '';
  let toolBuffer: CompletedTool[] = [];
  let key = 0;

  const flushText = () => {
    if (textBuffer.trim()) {
      items.push(<MarkdownBlock key={key++} text={textBuffer} />);
    }
    textBuffer = '';
  };

  const flushTools = () => {
    if (toolBuffer.length > 0) {
      items.push(<CompletedActivityPanel key={key++} tools={toolBuffer} />);
      toolBuffer = [];
    }
  };

  for (const ev of events) {
    if (ev.type === 'text') {
      flushTools();
      // Add paragraph break between consecutive text events so sentences don't merge
      textBuffer += (textBuffer && !textBuffer.endsWith('\n') ? '\n\n' : '') + ev.text;
    } else if (ev.type === 'thinking') {
      flushTools();
      flushText();
      items.push(<ThinkingBlock key={key++} thinking={ev.thinking} />);
    } else if (ev.type === 'tool_use') {
      flushText();
      const result = ev.toolUseId ? resultMap.get(ev.toolUseId) : undefined;
      toolBuffer.push({
        toolUseId: ev.toolUseId ?? String(key),
        toolName: ev.toolName,
        toolInput: ev.toolInput,
        result: result?.content,
        isError: result?.isError,
      });
    }
    // tool_result rendered within its tool_use — skip standalone
  }
  flushTools();
  flushText();

  return <>{items}</>;
}

/** The user's own text, with @agent mentions glowing like in the composer. */
function UserText({ text }: { text: string }) {
  const names = useAgents().map((a) => a.name);
  const parts = splitMentions(text, names);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((p, i) => p.mention ? <span key={i} className="mention-glow mention-glow-still">{p.text}</span> : <span key={i}>{p.text}</span>)}</>;
}

/** Time at the bottom right of a bubble, like WhatsApp (plus the double tick on own messages). */
function BubbleTime({ iso, own }: { iso?: string; own?: boolean }) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <span className="wa-time">
      {format(d, 'HH:mm')}
      {own && (
        <svg className="w-4 h-3.5 text-(--accent)" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M1 7.5 4.5 11 11 3.5M7.5 11 14.5 3" />
        </svg>
      )}
    </span>
  );
}

/** "Uitvoeren" under a scheduled task's proposal: approves the proposed actions in this conversation. */
function TaskAction({ taskId }: { taskId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [msg, setMsg] = useState('');
  const run = async () => {
    setState('busy'); setMsg('');
    try { const r = await tasksApi.execute(taskId); setState('sent'); setMsg(r.result.message); }
    catch (e) { setState('idle'); setMsg((e as Error).message); }
  };
  return (
    <div className="task-action flex flex-wrap items-center gap-2 px-4 md:px-6 pb-1.5 pl-6 md:pl-8">
      {state === 'sent' ? (
        <span className="text-xs text-(--muted)">{msg || 'Wordt uitgevoerd'}</span>
      ) : (
        <>
          <button type="button" disabled={state === 'busy'} onClick={() => void run()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-60 transition-transform active:scale-95">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M7 4.5v15l12-7.5Z" /></svg>
            {state === 'busy' ? 'Bezig…' : 'Uitvoeren'}
          </button>
          <span className="text-xs text-(--muted)">{msg || 'Voert de voorgestelde acties uit'}</span>
        </>
      )}
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({ message, still, sent, flying, agentLinks, calm = true, agentLive }: Props) {
  const agentNames = useAgents().map((a) => a.name);
  const isUser = message.role === 'user';
  // live messages carry attachments; from the database they come via metadata
  const atts = (message.attachments ?? (message.metadata?.attachments as Message['attachments']) ?? []);
  const parsedAll = !isUser ? parseStructured(message.content) : null;
  // a delegation (agent in its own workplace) is no part of the bubble: its card comes under it
  const delegations = delegationEvents(parsedAll);
  const parsed = delegations.length ? parsedAll!.filter((e) => e.type !== 'delegation') : parsedAll;
  const delegationCards = delegations.length
    ? delegations.map((ev) => <DelegationCard key={ev.delegationId} ev={ev} />)
    : null;
  // UI #26: limit events are no part of the bubble; they become compact muted lines under it
  const limitEvs = (parsed ?? []).filter((e) => e.type === 'rate_limited' || e.type === 'limit_note') as LimitEvent[];
  const structured = parsed && limitEvs.length ? parsed.filter((e) => e.type !== 'rate_limited' && e.type !== 'limit_note') : parsed;
  const limitLines = limitEvs.length
    ? [...limitEvs].sort((a, b) => (a.type === 'limit_note' ? 0 : 1) - (b.type === 'limit_note' ? 0 : 1)).map((e, i) => <LimitEventLine key={`lim${i}`} ev={e} />)
    : null;

  // sent by the app itself (continue after a server restart): a small notice instead of the user's bubble
  const autoLimit = isUser && (message.metadata?.auto === 'limit' || message.content.startsWith('Je werd net onderbroken door een gebruikslimiet.'));
  // UI #26: after the limit the pill reads as the second line of a small timeline ("Limiet bereikt om" above it)
  if (autoLimit) {
    const t = limitTime(message.created_at);
    return <LimitLine icon="check">{t ? `Hervat om ${t}` : 'Automatisch verder na de gebruikslimiet'}</LimitLine>;
  }
  // UI #27: interrupted agents continue by themselves (after the limit or a restart)
  if (isUser && message.metadata?.auto === 'agent') {
    const names = [...message.content.matchAll(/^(.+?) werd onderbroken door/gm)].map((m) => m[1]);
    const t = limitTime(message.created_at);
    const who = names.length ? names.join(' en ') : 'De agent';
    return <LimitLine icon="check">{t ? `${who} hervat om ${t}` : `${who} gaat verder`}</LimitLine>;
  }
  if (isUser && (message.metadata?.auto === 'resume' || message.content.startsWith('De backend is herstart tijdens je vorige antwoord.'))) {
    return (
      <div className="flex justify-center px-3 py-1.5">
        <span className="text-xs text-(--muted) px-3 py-1 rounded-full border border-(--border)" style={{ background: 'color-mix(in srgb, var(--g-bg-base) 80%, transparent)' }}>
          Automatisch verder na een herstart van de server
        </span>
      </div>
    );
  }

  // only cards (a delegation placed while no answer was running)
  if (delegationCards && parsed && !parsed.length) {
    return <div data-key={message.clientKey ?? message.id} className={clsx(still && 'msg-still')}>{delegationCards}</div>;
  }

  // an answer stopped before anything was written: no empty bubble with only a time
  if (!isUser && !message.content.trim() && !atts.length && !message.metadata?.streaming && !message.metadata?.error
    && !(Array.isArray(message.metadata?.tools) && (message.metadata!.tools as unknown[]).length)) return null;

  // a scheduled task ended with a proposal: one tap approves it (gone once used)
  const taskAction = !isUser ? (message.metadata?.task_action as { task_id?: string; used?: boolean } | undefined) : undefined;
  const actionEl = taskAction?.task_id && !taskAction.used ? <TaskAction taskId={taskAction.task_id} /> : null;

  // an answer in which the user's own agents took part: their turns as separate bubbles
  const segments = structured && structured.some((e) => e.type === 'agent_start') ? splitAgents(structured) : null;
  if (segments) {
    const lastMain = segments.map((s) => s.kind).lastIndexOf('main');
    const copyText = structured!.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('\n\n');
    const agentSegs = segments.filter((s): s is Extract<Segment, { kind: 'agent' }> => s.kind === 'agent');
    const lastWait = agentSegs.map((s) => !!s.wait && s.content === undefined && !agentLinks?.get(s.toolUseId)?.resumedAt).lastIndexOf(true);
    const chain = deriveChain(agentSegs.map((s) => ({ agentId: s.agentId, agentName: s.agentName, content: s.content, isError: s.isError, adjacentPrev: s.adjacentPrev })), agentNames);
    return (
      <div data-key={message.clientKey ?? message.id} className={clsx('group/msg', still && 'msg-still')}>
        {segments.map((sg, i) => {
          if (sg.kind === 'agent') {
            const k = agentSegs.indexOf(sg);
            const link = agentLinks?.get(sg.toolUseId);
            const cutOff = sg.content === undefined || (!!sg.isError && /^onderbroken$/i.test((sg.content ?? '').trim()));
            const wait: AgentWait | undefined = !cutOff ? undefined
              : sg.wait ? { ...sg.wait, resumedAt: link?.resumedAt }
              : link?.resumedAt ? { reason: 'restart', resumedAt: link.resumedAt } : undefined;
            const live = message.metadata?.streaming ? agentLive?.get(sg.toolUseId) : undefined;
            const t0 = message.metadata?.streaming && sg.at ? Date.parse(sg.at) : NaN;
            return (
              <AgentBubble key={sg.toolUseId} agentId={sg.agentId} agentName={sg.agentName} task={sg.task}
                activity={live?.activity} steps={live?.steps} startedAt={Number.isFinite(t0) ? Math.min(t0, Date.now()) : undefined}
                content={sg.content ?? (message.metadata?.streaming ? undefined : '')} isError={sg.isError}
                interrupted={sg.content === undefined && !message.metadata?.streaming}
                chain={chain[k]} nextAgentId={agentSegs[k + 1]?.agentId} nextAgentName={agentSegs[k + 1]?.agentName} pulse={calm && !!wait && !wait.resumedAt && k === lastWait} wait={wait}
                settled={!message.metadata?.streaming}
                resumedFrom={link?.resumedFrom} />
            );
          }
          return (
            <div key={i} className="msg-in flex justify-start px-4 md:px-6 py-1.5">
              {/* only the bubble that carries the time reserves room for it; the others (thinking, activity) end flush */}
              <div className={clsx('wa-bubble wa-in min-w-0 max-w-[92%] md:max-w-[80%]', i === lastMain && 'wa-foot')}>
                <div className="wa-body">
                  <StructuredMessage events={sg.events} />
                  {i === lastMain && (
                    <div className="wa-foot-row">
                      <MessageActions text={copyText} />
                      <BubbleTime iso={message.created_at} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {limitLines}
        {delegationCards}
        {actionEl}
      </div>
    );
  }

  // only limit lines, no words (the limit hit before anything was written)
  if (structured && limitLines && !structured.some((e) => e.type === 'tool_use' || e.type === 'thinking' || (e.type === 'text' && e.text.trim()))) {
    return <div data-key={message.clientKey ?? message.id} className={clsx('msg-in', still && 'msg-still')}>{limitLines}{delegationCards}</div>;
  }

  return (<>
    <div data-key={message.clientKey ?? message.id} className={clsx('msg-in group/msg flex px-4 md:px-6 py-1.5', isUser ? 'justify-end' : 'justify-start', still && 'msg-still', sent && 'msg-sent', flying && 'msg-flying')}>
      <div className={clsx('wa-bubble wa-foot', isUser ? 'wa-out max-w-[85%] md:max-w-[65%]' : 'wa-in min-w-0 max-w-[92%] md:max-w-[80%]')}>
        {isUser ? (
          <div className="wa-body">
            {message.metadata?.auto === 'delegation' && (
              <p className="flex items-center gap-1 text-[11px] font-medium text-(--muted) mb-0.5">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h14m-5-5 5 5-5 5" /><path d="M4 5v14" /></svg>
                Gedelegeerde opdracht
              </p>
            )}
            {message.metadata?.auto === 'task' && (
              <p className="flex items-center gap-1 text-[11px] font-medium text-(--muted) mb-0.5">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" /><path d="M20.5 3.5V8H16" /><path d="M12 7.5V12l3 2" /></svg>
                Automatische taak
              </p>
            )}
            <p className="text-(--text) text-[15px] whitespace-pre-wrap leading-relaxed break-words">
              <UserText text={message.content} />
            </p>
            {atts.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {atts.map(att =>
                  att.mime_type.startsWith('image/') ? (
                    <a key={att.id} href={`/api/conversations/${message.conversation_id}/attachments/${att.id}/content`} target="_blank" rel="noreferrer">
                      <img
                        src={`/api/conversations/${message.conversation_id}/attachments/${att.id}/content`}
                        alt={att.original_name}
                        loading="lazy"
                        className="max-h-44 max-w-[240px] rounded-xl object-cover border border-white/10 hover:brightness-110 transition"
                      />
                    </a>
                  ) : (
                    <div key={att.id} className="flex items-center gap-1.5 bg-(--border) rounded-lg px-2 py-1.5 text-xs text-(--muted)">
                      <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span className="max-w-[120px] truncate">{att.original_name}</span>
                    </div>
                  )
                )}
              </div>
            )}
            {/* time sits on the last line, like WhatsApp (space reserved by CSS), not on a line of its own */}
            <div className="wa-foot-row"><BubbleTime iso={message.created_at} own /></div>
          </div>
        ) : (
          <div className="wa-body">
            {structured ? <StructuredMessage events={structured} /> : <MarkdownBlock text={message.content} />}
            <div className="wa-foot-row">
              <MessageActions
                text={structured
                  ? structured.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('\n\n')
                  : message.content}
              />
              <BubbleTime iso={message.created_at} />
            </div>
          </div>
        )}
      </div>
    </div>
    {limitLines}
    {delegationCards}
    {actionEl}
  </>);
});

export default MessageBubble;

/** The answer as it streams in. While waiting, LiveStatus (in ChatWindow) shows what Claude does. */
/** Grows and shrinks its height smoothly with the content (works in Safari too, unlike height: auto transitions). */
export function SmoothHeight({ children, className }: { children: React.ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    o.style.height = `${i.offsetHeight}px`;
    const ro = new ResizeObserver(() => { o.style.height = `${i.offsetHeight}px`; });
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={outer} className={clsx('smooth-h', className)}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

/** The live answer. Before any text it is a typing bubble (three dots, like iMessage) that grows into the answer. */
export function StreamingBubble({ text, typing }: { text: string; typing?: boolean }) {
  const has = !!text.trim();
  if (!has && !typing) return null;
  return (
    <div className="flex justify-start px-4 md:px-6 py-1.5 stream-in">
      <div className={clsx('wa-bubble wa-in min-w-0 max-w-[92%] md:max-w-[80%]', !has && 'typing-bubble')}>
        <SmoothHeight>
          {has ? (
            <div className="prose prose-sm prose-invert max-w-none stream-prose">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeHighlight]}>
                {text}
              </ReactMarkdown>
            </div>
          ) : (
            <span className="typing-dots" aria-label="Claude typt"><i /><i /><i /></span>
          )}
        </SmoothHeight>
      </div>
    </div>
  );
}
