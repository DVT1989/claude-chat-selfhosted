'use client';

import PushBell from './PushBell';
import ChromePanelButton from './ChromePanelButton';
import { Fragment, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, KeyboardEvent } from 'react';
import { useChatStore, useAuthStore } from '@/lib/store';
import { conversations as convApi, type QueuedMessage } from '@/lib/api';
import MessageBubble, { SmoothHeight, StreamingBubble, ToolCallBlock, linkResumes } from './MessageBubble';
import { AgentBubble, type AgentStep, type AgentWait, useAgents, findAgent, deriveChain } from './AgentBubble';
import { DelegationCard, type DelegationEvent } from './DelegationCard';
import MentionMenu, { mentionAt, matchAgents, splitMentions } from './MentionMenu';
import ConvAvatar from '@/components/ConvAvatar';
import UsageMeter, { USAGE_REFRESH_EVENT } from '@/components/UsageMeter';
import LiveStatus from './LiveStatus';
import { LimitNotice, type LimitStatus } from './LimitNotice';
import type { Message } from '@/types';
import { attachments as attachmentsApi, models as modelsApi } from '@/lib/api';
import type { Attachment, ModelOption } from '@/types';
import clsx from 'clsx';
import { useTranslations } from '@/lib/i18n';

const MAX_INPUT_CHARS = 50000;

interface RateLimitBanner {
  resetAt: Date | null;
  message: string;
  lastMessage: string;
  status: LimitStatus | 'dismissed';
  /** when this state began (resumed: the moment the run continued) */
  at?: Date;
  /** run (runSeqRef) in which the notice appeared: a later run's 'done' clears a leftover */
  run?: number;
  /** new per state change, so a short-lived state only removes itself */
  key?: number;
}

function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('rate limit') || lower.includes('ratelimit') ||
    lower.includes('usage limit') || lower.includes('usage exceeded') ||
    lower.includes('too many requests') || lower.includes('quota') ||
    lower.includes('overloaded') || lower.includes('credit') ||
    lower.includes('429')
  );
}


interface ToolCall {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  result?: string;
  isError?: boolean;
}

interface Props {
  conversationId: string;
  initialMessages: Message[];
  /** Embedded elsewhere (admin prompt): fixed title, no sidebar toggle, extra header controls. */
  titleOverride?: string;
  headerExtra?: React.ReactNode;
}

// ── Activity panel shown during streaming ────────────────────
function ActivityPanel({ tools }: { tools: ToolCall[] }) {
  const tr = useTranslations('chat');
  const [open, setOpen] = useState(true);
  const runningCount = tools.filter(t => t.result === undefined).length;
  const doneCount = tools.filter(t => t.result !== undefined).length;
  const isRunning = runningCount > 0;

  return (
    <div className="w-full rounded-xl border border-(--border) overflow-hidden text-xs act-in">
      {/* Panel header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-(--input) hover:bg-(--border) transition-colors text-left"
      >
        {isRunning ? (
          <span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse shrink-0" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
        )}
        <span className="text-(--text) font-medium">{tr('activity')}</span>
        <span className="text-(--muted)">
          {tools.length === 1 ? tr('tool') : tr('tools', { n: tools.length })}
          {isRunning && tools.length > 1 && tr('toolsDone', { done: doneCount, n: tools.length })}
        </span>
        {/* Arrow: ► when collapsed, ▼ when open */}
        <svg className={clsx('w-3 h-3 text-(--muted) ml-auto shrink-0 transition-transform', !open && '-rotate-90')}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Tool list */}
      {/* collapses and opens smoothly; every new tool line slides in below the previous one */}
      <div className={clsx('act-rows', !open && 'closed')}>
        <div>
          <div className="border-t border-(--border)">
            {tools.map((tool, i) => (
              <div key={tool.toolUseId} className="act-row">
                <div>
                  <div className={clsx(i > 0 && 'border-t border-(--border)/60')}>
                    <SmoothHeight>
                      <ToolCallBlock
                        toolName={tool.toolName}
                        toolInput={tool.toolInput}
                        result={tool.result}
                        isError={tool.isError}
                        running={tool.result === undefined}
                        flat
                      />
                    </SmoothHeight>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The message still streaming on the server, only if it is the latest one (older flagged rows are orphans). */
function livePartial(msgs: Message[]): Message | undefined {
  const last = msgs[msgs.length - 1];
  return last?.role === 'assistant' && last.metadata?.streaming === true ? last : undefined;
}

/** Stored assistant content is a JSON event list; the streaming bubble only shows its text parts. */
/** Real start of an agent bubble: the server time on agent_start (at, or t0 in older saved events), else now. */
function startOf(e: Record<string, unknown>): number {
  for (const v of [e.at, e.t0]) {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return Math.min(t, Date.now());
  }
  return Date.now();
}

interface LiveAgent {
  toolUseId: string; agentId: string; agentName: string; task?: string;
  at: number; activity?: string; content?: string; isError?: boolean;
  steps?: AgentStep[]; startedAt?: number;
  /** UI #27: a SendMessage follow-up (at = ISO time it started), Claude Code's agentId, and a limit stop */
  resumed?: boolean; resumedIso?: string; ccAgentId?: string; wait?: AgentWait;
}

function partialText(content: string): string {
  if (!content.startsWith('[')) return content;
  try {
    const arr = JSON.parse(content) as Array<{ type?: string; text?: string }>;
    if (Array.isArray(arr)) return arr.filter(e => e?.type === 'text' && e.text).map(e => e.text).join('\n\n');
  } catch { /* not JSON, show as is */ }
  return content;
}

/** Highest SSE id (<run>:<n>) stored in a saved partial: live events up to it are already in that text. */
function partialLastId(content: string): { run: string; n: number } | null {
  if (!content.startsWith('[')) return null;
  try {
    const arr = JSON.parse(content) as Array<{ sid?: string }>;
    let best: { run: string; n: number } | null = null;
    for (const e of Array.isArray(arr) ? arr : []) {
      if (typeof e?.sid !== 'string') continue;
      const i = e.sid.lastIndexOf(':');
      const run = e.sid.slice(0, i);
      const n = Number(e.sid.slice(i + 1));
      if (run && Number.isFinite(n) && (!best || n > best.n)) best = { run, n };
    }
    return best;
  } catch { return null; }
}

// ── Main chat window ─────────────────────────────────────────
// Horizontal space a textarea reserves for text beyond its CSS padding and border (sum of both sides).
// Measured with an offscreen probe: the narrowest width at which a known unbreakable run still fits on one
// line, minus the run's own width. Cached per font, since only the font changes the outcome.
const insetCache = new Map<string, number>();
function textareaInset(cs: CSSStyleDeclaration): number {
  const key = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily} ${cs.letterSpacing}`;
  const hit = insetCache.get(key);
  if (hit !== undefined) return hit;
  const font = { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, letterSpacing: cs.letterSpacing, lineHeight: cs.lineHeight };
  const hide = { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none' };
  const RUN = 'MMMMMMMMMMMM';
  const span = document.createElement('span');
  Object.assign(span.style, font, hide, { whiteSpace: 'pre' });
  span.textContent = RUN;
  const probe = document.createElement('textarea');
  Object.assign(probe.style, font, hide, { boxSizing: 'content-box', padding: '0', border: '0', margin: '0', overflow: 'hidden', resize: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', height: '0', minHeight: '0', maxHeight: 'none' });
  probe.rows = 1;
  probe.tabIndex = -1;
  document.body.append(span, probe);
  let inset = 0;
  try {
    const w = span.getBoundingClientRect().width;
    probe.value = 'M';
    probe.style.width = `${Math.ceil(w) + 60}px`;
    const oneLine = probe.scrollHeight;
    probe.value = RUN;
    const fits = (px: number) => { probe.style.width = `${px}px`; return probe.scrollHeight <= oneLine; };
    let lo = Math.floor(w) - 1, hi = Math.ceil(w) + 40;
    if (oneLine > 0 && fits(hi) && !fits(lo)) {
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) hi = mid; else lo = mid; }
      inset = Math.max(0, Math.min(20, hi - Math.ceil(w)));
    }
  } finally { span.remove(); probe.remove(); }
  insetCache.set(key, inset);
  return inset;
}

export default function ChatWindow({ conversationId, initialMessages, titleOverride, headerExtra }: Props) {
  const tr = useTranslations('chat');
  // Use a stable selector to avoid re-renders when unrelated store slices change
  // (e.g. conversations list updating from sidebar poll)
  const messages_map    = useChatStore(s => s.messages);
  const setMessages     = useChatStore(s => s.setMessages);
  const addMessage      = useChatStore(s => s.addMessage);
  // live state of THIS conversation only (keyed by id, so another chat's run never shows here)
  const streamingMessage = useChatStore(s => s.streams[conversationId]?.text ?? '');
  const isStreaming     = useChatStore(s => !!s.streams[conversationId]?.on);
  const setStreaming    = (on: boolean) => useChatStore.getState().setStream(conversationId, { on });
  const clearStreamingMessage = () => useChatStore.getState().setStream(conversationId, { text: '' });
  const liveOf = () => useChatStore.getState().streams[conversationId] ?? { on: false, text: '' };
  const updateConversation = useChatStore(s => s.updateConversation);
  const title          = useChatStore(s => s.conversations.find(c => c.id === conversationId)?.title ?? '');
  const addSessionCost = useChatStore(s => s.addSessionCost);
  const addSessionTokens = useChatStore(s => s.addSessionTokens);
  const refreshConversationId = useChatStore(s => s.refreshConversationId);
  const setRefreshConversationId = useChatStore(s => s.setRefreshConversationId);
  const allMessages = messages_map;

  // Unsent text survives navigating away: kept per conversation in localStorage
  const [input, setInputRaw] = useState('');
  const draftKey = `draft:${conversationId}`;
  function setInput(v: string) {
    setInputRaw(v);
    try { if (v) localStorage.setItem(draftKey, v); else localStorage.removeItem(draftKey); } catch { /* storage full or blocked */ }
  }
  useEffect(() => {
    try { setInputRaw(localStorage.getItem(draftKey) ?? ''); } catch { setInputRaw(''); }
  }, [draftKey]);
  // @agent suggestions: follow the caret, filter while typing
  const agentList = useAgents();
  const [caret, setCaret] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionClosed, setMentionClosed] = useState<number | null>(null);
  const mentionTok = mentionAt(input, caret);
  const mentionList = mentionTok ? matchAgents(agentList, mentionTok.q) : [];
  const mentionOpen = !!mentionTok && mentionList.length > 0 && mentionClosed !== mentionTok.start;
  // chosen @names glow in the composer: a mirror of the text sits behind the (transparent) textarea
  const agentNames = agentList.filter((a) => a.is_active).map((a) => a.name);
  const composerParts = splitMentions(input, agentNames);
  const hasMention = composerParts.some((p) => p.mention);
  const mirrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setMentionIdx(0); }, [mentionTok?.q, mentionTok?.start]);
  useEffect(() => { if (!mentionTok) setMentionClosed(null); }, [mentionTok]);
  function pickMention(a: { name: string }) {
    if (!mentionTok) return;
    const before = input.slice(0, mentionTok.start) + '@' + a.name + ' ';
    setInput(before + input.slice(caret).replace(/^\S*\s?/, ''));
    setCaret(before.length);
    pendingCaret.current = before.length;
  }
  // put the caret right after the inserted name in the same commit (a later frame would pull it
  // back over letters typed in the meantime)
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current; const pos = pendingCaret.current;
    if (el && pos != null) { pendingCaret.current = null; el.focus(); el.setSelectionRange(pos, pos); }
  }, [input]);
  const [convAttachments, setConvAttachments] = useState<Attachment[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [systemDefaultModel, setSystemDefaultModel] = useState<string>('sonnet');
  const userDefaultModel = useAuthStore(s => s.user?.default_model ?? null);
  const prefs = useAuthStore(s => s.user?.preferences ?? null);
  const spellOn = prefs?.spellcheck !== false;
  const spellLang = prefs?.spell_lang && prefs.spell_lang !== 'auto' ? prefs.spell_lang : undefined;
  const effectiveDefault = userDefaultModel || systemDefaultModel;
  const [convModel, setConvModel] = useState<string>('');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<{ title: string; detail?: string; retry?: boolean } | null>(null);
  const [activeTools, setActiveTools] = useState<ToolCall[]>([]);
  // the user's own agents working in the running answer; at = where in the live text their turn started
  const [liveAgents, setLiveAgents] = useState<LiveAgent[]>([]);
  // delegations placed in the answer being written (their card polls its own status)
  const [liveDelegations, setLiveDelegations] = useState<DelegationEvent[]>([]);
  const [thinkingText, setThinkingText] = useState('');
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [rateLimitBanner, setRateLimitBanner] = useState<RateLimitBanner | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const lastMessageRef = useRef<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const kbUp = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const sentAttachmentsRef = useRef<Map<string, typeof convAttachments>>(new Map());
  const scrollerRef = useRef<HTMLDivElement>(null);
  // UI #25: width of the scroller's scrollbar (0 with overlay scrollbars). Header and composer add it to their
  // right padding, so their edges line up with the bubbles inside the scroller.
  const [sbw, setSbw] = useState(0);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setSbw(Math.max(0, el.offsetWidth - el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Follow new output only while the user is at the bottom; scrolling up to read stops it
  const stickRef = useRef(true);
  // Bumped on every server-side run start, so a finished fetch does not wipe a newer run's state
  const runSeqRef = useRef(0);
  // Text of the running answer, one entry per event id (<run>:<n>). The same event can arrive more
  // than once (send stream, live subscription, replays after a reconnect); keyed like this it can
  // never show twice, whatever the order. Events without id are kept in arrival order.
  const textParts = useRef<Map<string, string>>(new Map());
  const thinkParts = useRef<Map<string, string>>(new Map());
  const anonSeq = useRef(0);
  const orderOf = (k: string) => { const n = Number(k.slice(k.lastIndexOf(':') + 1)); return Number.isFinite(n) && k.includes(':') ? n : 1e9 + Number(k.slice(5)); };
  const joined = (m: Map<string, string>, sep: string) => [...m.entries()].sort((a, b) => orderOf(a[0]) - orderOf(b[0])).map(([, t]) => t).join(sep);
  const showText = () => useChatStore.getState().setStream(conversationId, { text: joined(textParts.current, '\n\n') });
  const addPart = (m: Map<string, string>, id: string | undefined, t: string): boolean => {
    const k = id ?? `anon-${anonSeq.current++}`;
    if (m.has(k)) return false;
    m.set(k, t);
    return true;
  };
  const resetText = () => { textParts.current.clear(); thinkParts.current.clear(); anonSeq.current = 0; clearStreamingMessage(); };
  /** Show the saved partial of a running answer: its text events keep their ids, so live ones line up. */
  const seedPartial = (content: string | undefined) => {
    resetText();
    if (!content) return;
    if (content.startsWith('[')) {
      try {
        const arr = JSON.parse(content) as Array<{ type?: string; text?: string; sid?: string }>;
        if (Array.isArray(arr)) {
          const seeded: LiveAgent[] = [];
          const cards: DelegationEvent[] = [];
          for (const e of arr as Array<Record<string, unknown>>) {
            if (e?.type === 'delegation' && typeof e.delegationId === 'string') { cards.push(e as unknown as DelegationEvent); continue; }
            if (e?.type === 'text' && e.text) addPart(textParts.current, e.sid as string | undefined, e.text as string);
            else if (e?.type === 'agent_start') seeded.push({ toolUseId: String(e.toolUseId), agentId: String(e.agentId), agentName: String(e.agentName ?? ''), task: e.task as string | undefined, at: joined(textParts.current, '\n\n').length,
              steps: [], startedAt: startOf(e),
              resumed: e.resumed === true, resumedIso: e.resumed === true && typeof e.at === 'string' ? e.at : undefined, ccAgentId: typeof e.ccAgentId === 'string' ? e.ccAgentId : undefined });
            else if (e?.type === 'agent_result') { const a = seeded.find((x) => x.toolUseId === e.toolUseId); if (a) { a.content = String(e.content ?? ''); a.isError = e.isError === true; } }
            else if (e?.type === 'agent_interrupted') { const a = seeded.find((x) => x.toolUseId === e.toolUseId); if (a) a.wait = { reason: e.reason === 'restart' ? 'restart' : 'limit', resumeAt: typeof e.resumeAt === 'string' ? e.resumeAt : undefined, at: typeof e.at === 'string' ? e.at : undefined }; }
          }
          setLiveAgents(seeded);
          setLiveDelegations(cards);
          showText();
          return;
        }
      } catch { /* not JSON */ }
    }
    addPart(textParts.current, undefined, partialText(content));
    showText();
  };
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // Live status: shown while no text is arriving (tool running, thinking, waiting)
  const lastTextAt = useRef(0);
  const [quiet, setQuiet] = useState(true);

  const messages = allMessages[conversationId] ?? initialMessages;

  useEffect(() => {
    setMessages(conversationId, initialMessages);
    // If a message is mid-stream on the server (metadata.streaming === true),
    // seed the streaming buffer with its current content so the user sees
    // a continuous stream — the partial message itself is filtered out of
    // the rendered list to avoid duplicate bubbles, and the EventSource
    // subscription appends new deltas seamlessly.
    const partial = livePartial(initialMessages);
    if (partial) {
      seedPartial(partial.content);
      setStreaming(true);
    }
  }, [conversationId]);

  // Opening a conversation lands at the bottom at once (no scroll ride from the top, and the
  // existing messages do not animate in); after that new messages glide into view.
  const landed = useRef(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    landed.current = false;
    stickRef.current = true;
    setSettled(false);
    const t = setTimeout(() => setSettled(true), 600);
    return () => clearTimeout(t);
  }, [conversationId]);
  // Scrolls only the message list (scrollIntoView also moved the page on iOS, pushing the composer away)
  // Glide only when a new message arrives; text that streams in and refreshes stay pinned to the
  // bottom without an animation (a smooth scroll per chunk looked like the chat kept reloading).
  const lastCount = useRef(0);
  const [swapId, setSwapId] = useState<string | null>(null);
  // the message just sent: slides up out of the composer like iMessage
  const [sentId, setSentId] = useState<string | null>(null);
  // Keep the list pinned to the bottom while content grows (smooth heights animate after the state change)
  useEffect(() => {
    const el = scrollerRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => { if (stickRef.current) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [conversationId]);
  useEffect(() => {
    const el = scrollerRef.current;
    const grew = messages.length > lastCount.current;
    lastCount.current = messages.length;
    if (!el || !stickRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: landed.current && grew ? 'smooth' : 'auto' });
    if (messages.length) landed.current = true;
  }, [messages, streamingMessage, activeTools, queued.length]);
  function onScroll() {
    const el = scrollerRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  useEffect(() => {
    if (streamingMessage) { lastTextAt.current = Date.now(); setQuiet(false); }
  }, [streamingMessage]);
  // the running tool, held at least 1s on screen so short commands are readable
  const runningTool = [...activeTools].reverse().find(t => t.result === undefined) ?? null;
  const [shownTool, setShownTool] = useState<ToolCall | null>(null);
  const shownAt = useRef(0);
  useEffect(() => {
    if (runningTool) { setShownTool(runningTool); shownAt.current = Date.now(); return; }
    const wait = Math.max(0, 1000 - (Date.now() - shownAt.current));
    const t = setTimeout(() => setShownTool(null), wait);
    return () => clearTimeout(t);
  }, [runningTool?.toolUseId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isStreaming) { setQuiet(true); return; }
    const t = setInterval(() => setQuiet(Date.now() - lastTextAt.current > 1200), 400);
    return () => clearInterval(t);
  }, [isStreaming]);

  // Queue of messages waiting for the current answer
  useEffect(() => {
    setQueued([]);
    convApi.queue(conversationId).then(r => setQueued(r.items)).catch(() => {});
  }, [conversationId]);

  // Back in the app (PWA from background, other tab): the run went on server-side, catch up
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible' || abortRef.current) return;
      convApi.get(conversationId).then(({ messages: fresh }) => {
        if (!fresh) return;
        setMessages(conversationId, fresh);
        setError(e => (e?.title === 'Verbinding weggevallen' ? null : e));
        const partial = livePartial(fresh);
        if (partial) {
          seedPartial(partial.content);
          setStreaming(true);
        } else if (liveOf().on) {
          resetText();
          setActiveTools([]); setLiveAgents([]); setLiveDelegations([]);
          setThinkingText('');
          setStreaming(false);
        }
      }).catch(() => {});
      convApi.queue(conversationId).then(r => setQueued(r.items)).catch(() => {});
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // "Verder" on an interrupted agent bubble: send the follow-up as a normal message
  const sendRef = useRef<(t: string) => void>(() => {});
  sendRef.current = (t: string) => { void sendMessage(t); };
  useEffect(() => {
    const onContinue = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (text) sendRef.current(text);
    };
    window.addEventListener('agent-continue', onContinue);
    return () => window.removeEventListener('agent-continue', onContinue);
  }, []);

  // Auto-resize textarea. A layout effect, before the send flight below measures: the composer must
  // already be back to one line, or the landing spot moves down mid-flight.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [input]);

  // The @name mirror must wrap exactly like the textarea. Copy the computed text metrics (on touch screens
  // the iOS rule makes the field 16px instead of 15px, so fixed classes drifted a line) and size it to the
  // textarea's content box without scrollbar (clientWidth), then follow its scroll position.
  useLayoutEffect(() => {
    const ta = textareaRef.current, mi = mirrorRef.current;
    if (!ta || !mi) return;
    // G: the mirror reaches G px past the textarea on every side (padding G more), so the soft glow of a
    // name on the first line or at the edge is not cut off square
    const G = 8;
    const sync = () => {
      const cs = getComputedStyle(ta);
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize',
        'fontKerning', 'textRendering', 'fontVariantLigatures', 'fontFeatureSettings', 'overflowWrap', 'wordBreak', 'whiteSpace'] as const) {
        (mi.style as unknown as Record<string, string>)[k] = cs[k] as string;
      }
      // Some engines (older iOS WebKit) inset textarea text a few px beyond the CSS padding, others don't.
      // Guessing per platform put the glow a word off either way, so measure the real inset once per font.
      const inset = textareaInset(cs) / 2;
      for (const k of ['paddingTop', 'paddingBottom'] as const) mi.style[k] = `${(parseFloat(cs[k]) || 0) + G}px`;
      for (const k of ['paddingRight', 'paddingLeft'] as const) mi.style[k] = `${(parseFloat(cs[k]) || 0) + G + inset}px`;
      mi.style.width = `${ta.clientWidth + 2 * G}px`;
      mi.style.height = `${ta.clientHeight + 2 * G}px`;
      mi.style.top = `${ta.offsetTop + ta.clientTop - G}px`;
      mi.style.left = `${ta.offsetLeft + ta.clientLeft - G}px`;
      mi.scrollTop = ta.scrollTop;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(ta);
    return () => ro.disconnect();
  }, [input, hasMention]);

  // Reload messages when a background scheduled resume completes for this conversation
  useEffect(() => {
    if (refreshConversationId !== conversationId) return;
    setRefreshConversationId(null);
    convApi.get(conversationId).then(({ messages: fresh }) => {
      if (fresh) {
        setMessages(conversationId, fresh);
        const partial = livePartial(fresh);
        if (partial) {
          seedPartial(partial.content);
          setStreaming(true);
        }
      }
      setRateLimitBanner(null);
    }).catch(() => {});
  }, [refreshConversationId]);

  // Check for existing scheduled resume on mount / conversation change
  useEffect(() => {
    convApi.getScheduledResume(conversationId).then(({ scheduledFor, agentsOnly }) => {
      // only interrupted agents wait: their bubbles show it, the conversation itself has no limit notice
      if (scheduledFor && !agentsOnly) {
        setRateLimitBanner({
          resetAt: new Date(scheduledFor),
          message: '',
          lastMessage: '',
          status: 'scheduled',
          run: runSeqRef.current,
          key: Date.now(),
        });
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Load attachments when conversation changes
  useEffect(() => {
    setConvAttachments([]);
    attachmentsApi.list(conversationId).then(setConvAttachments).catch(() => {});
  }, [conversationId]);

  // Load available models once
  useEffect(() => {
    modelsApi.list().then(({ models, default: def }) => {
      setAvailableModels(models);
      setSystemDefaultModel(def);
    }).catch(() => {});
  }, []);

  // Load conversation model when conversation changes
  useEffect(() => {
    convApi.get(conversationId).then(({ conversation }) => {
      const m = conversation?.model ?? '';
      // Treat legacy default 'claude-opus-4-5' as unset → use user/system default
      setConvModel(m && m !== 'claude-opus-4-5' ? m : '');
    }).catch(() => {});
  }, [conversationId]);

  // Close model dropdown on outside click
  useEffect(() => {
    if (!modelMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [modelMenuOpen]);

  async function changeModel(modelId: string) {
    setModelMenuOpen(false);
    const newVal = modelId === '__default__' ? '' : modelId;
    setConvModel(newVal);
    try {
      await convApi.update(conversationId, { model: newVal || effectiveDefault });
    } catch { /* ignore */ }
  }

  function classifyError(err: unknown): { title: string; detail?: string } {
    if (err instanceof Error) {
      const msg = err.message;
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Load failed')) {
        return { title: tr('noConnection'), detail: tr('noConnectionDetail') };
      }
      if (msg.includes('503') || msg.includes('502')) {
        return { title: tr('serverDown'), detail: tr('serverDownDetail', { code: msg.match(/\d{3}/)?.[0] ?? '' }) };
      }
      if (msg.includes('401') || msg.includes('Unauthorized')) {
        return { title: tr('notLoggedIn'), detail: tr('notLoggedInDetail') };
      }
      if (msg.includes('422') || msg.includes('Authenticeer') || msg.includes('Koppel eerst')) {
        return { title: tr('claudeNotLinked'), detail: msg };
      }
      if (msg.includes('404')) {
        return { title: tr('convNotFound'), detail: tr('convNotFoundDetail') };
      }
      return { title: msg };
    }
    return { title: tr('unknownError'), detail: String(err) };
  }

  async function handleScheduleResume() {
    if (!rateLimitBanner?.resetAt || !rateLimitBanner.lastMessage) return;
    setScheduleLoading(true);
    try {
      await convApi.scheduleResume(conversationId, rateLimitBanner.lastMessage, rateLimitBanner.resetAt.toISOString());
      setRateLimitBanner(b => b ? { ...b, status: 'scheduled', run: runSeqRef.current, key: Date.now() } : null);
    } catch {
      // ignore — banner stays as prompt so user can retry
    } finally {
      setScheduleLoading(false);
    }
  }

  async function handleCancelSchedule() {
    try {
      await convApi.cancelScheduledResume(conversationId);
    } catch { /* ignore */ }
    setRateLimitBanner(b => (b ? { ...b, status: 'cancelled', at: new Date(), key: Date.now() } : null));
  }

  // UI #26: the planned continuation has started (first stream event while waiting): show "Hervat om" briefly
  const markResumed = () => setRateLimitBanner(b => b?.status === 'scheduled'
    ? { ...b, status: 'resumed', at: new Date(), key: Date.now() } : b);

  // The planned continuation can start out of sight (other window, after a restart, page in the background):
  // while the notice waits, ask the backend now and then; once nothing is planned any more it was picked up.
  const waitingForResume = rateLimitBanner?.status === 'scheduled';
  useEffect(() => {
    if (!waitingForResume) return;
    let stopped = false;
    const check = () => {
      convApi.getScheduledResume(conversationId).then(({ scheduledFor }) => {
        if (!stopped && !scheduledFor) markResumed();
      }).catch(() => {});
    };
    const t = setInterval(check, 15_000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForResume, conversationId]);

  // Shared event applier — used by both the local fetch reader-loop and the
  // EventSource live-subscribe stream so transitions stay identical.
  const applyStreamEvent = useCallback(async (eventType: string, data: Record<string, unknown>, id?: string) => {
    switch (eventType) {
      case 'run_start': {
        // A queued message (or another window) started a new answer: show its question
        runSeqRef.current += 1;
        setActiveTools([]); setLiveAgents([]); setLiveDelegations([]);
        setThinkingText('');
        resetText();
        setStreaming(true);
        try {
          const refreshed = await convApi.get(conversationId);
          setMessages(conversationId, refreshed.messages ?? []);
        } catch { /* ignore */ }
        break;
      }

      // Replays after a (re)subscribe: every event keeps its id, so replayed parts are simply skipped
      case 'replay_start':
      case 'replay_end':
        break;

      case 'thinking':
        markResumed();
        if (typeof data.thinking === 'string' && addPart(thinkParts.current, id, data.thinking)) setThinkingText(joined(thinkParts.current, ''));
        break;

      case 'text':
        markResumed();
        if (typeof data.text === 'string' && addPart(textParts.current, id, data.text)) showText();
        break;

      case 'delegation': {
        // an agent got its own workplace: its card appears under the answer right away
        const ev = data as unknown as DelegationEvent;
        if (typeof ev.delegationId === 'string') {
          setLiveDelegations((prev) => prev.some((d) => d.delegationId === ev.delegationId)
            ? prev.map((d) => (d.delegationId === ev.delegationId ? { ...d, ...ev } : d)) : [...prev, ev]);
        }
        break;
      }

      case 'tool_use':
        markResumed();
        setActiveTools((prev) => {
          const id = (data.toolUseId as string) ?? '';
          // Idempotent: don't re-add if EventSource and reader-loop both deliver same id
          if (id && prev.some(t => t.toolUseId === id)) return prev;
          return [
            ...prev,
            {
              toolUseId: id,
              toolName: (data.toolName as string) ?? 'tool',
              toolInput: data.toolInput,
            },
          ];
        });
        break;

      case 'agent_start': {
        markResumed();
        const at = liveOf().text.length;
        setLiveAgents((prev) => prev.some((a) => a.toolUseId === data.toolUseId) ? prev : [...prev, {
          toolUseId: String(data.toolUseId), agentId: String(data.agentId), agentName: String(data.agentName ?? ''),
          task: typeof data.task === 'string' ? data.task : undefined, at, steps: [], startedAt: startOf(data),
          resumed: data.resumed === true, resumedIso: data.resumed === true && typeof data.at === 'string' ? data.at : undefined, ccAgentId: typeof data.ccAgentId === 'string' ? data.ccAgentId : undefined,
        }]);
        break;
      }
      // UI #27: an agent stopped by the limit: its bubble waits (the server planned the follow-up)
      case 'agent_interrupted':
        setLiveAgents((prev) => prev.map((a) => a.toolUseId === data.toolUseId
          ? { ...a, wait: { reason: data.reason === 'restart' ? 'restart' : 'limit', resumeAt: typeof data.resumeAt === 'string' ? data.resumeAt : undefined, at: typeof data.at === 'string' ? data.at : undefined } } : a));
        break;
      case 'agent_activity':
        setLiveAgents((prev) => prev.map((a) => {
          if (a.toolUseId !== data.toolUseId) return a;
          const step: AgentStep = { tool: String(data.toolName ?? ''), detail: typeof data.detail === 'string' ? data.detail : '', at: typeof data.at === 'number' ? data.at : Date.now() };
          return { ...a, activity: step.tool, steps: [...(a.steps ?? []), step].slice(-40) };
        }));
        break;
      case 'agent_result':
        setLiveAgents((prev) => prev.map((a) => a.toolUseId === data.toolUseId ? { ...a, content: String(data.content ?? ''), isError: data.isError === true } : a));
        break;

      case 'tool_result':
        setActiveTools((prev) =>
          prev.map((t) =>
            t.toolUseId === (data.toolUseId as string)
              ? { ...t, result: data.content as string, isError: data.isError as boolean }
              : t,
          ),
        );
        break;

      case 'done': {
        // the usage bar under the composer refreshes right after every finished answer
        window.dispatchEvent(new Event(USAGE_REFRESH_EVENT));
        // Only the originator tab counts session cost/tokens — peer tabs
        // receiving the same `done` via EventSource must not double-count.
        if (abortRef.current) {
          const cost = (data.costUsd as number) || 0;
          if (cost) addSessionCost(cost);
          addSessionTokens(
            (data.inputTokens as number) || 0,
            (data.outputTokens as number) || 0,
          );
        }

        try {
          const refreshed = await convApi.get(conversationId);
          const msgsWithAtts = (refreshed.messages ?? []).map(msg => {
            if (msg.role === 'user') {
              const atts = sentAttachmentsRef.current.get(msg.content);
              if (atts) return { ...msg, attachments: atts };
            }
            return msg;
          });
          setMessages(conversationId, msgsWithAtts);
          // the saved answer takes the place of the live bubble: cross-fade it instead of popping in
          const lastAnswer = [...msgsWithAtts].reverse().find(m => m.role === 'assistant');
          if (lastAnswer) setSwapId(lastAnswer.id);
          updateConversation(conversationId, { updated_at: new Date().toISOString() });
        } catch { /* ignore refresh failure */ }
        setActiveTools([]); setLiveAgents([]); setLiveDelegations([]);
        setThinkingText('');
        // UI #26: a finished run leaves no stale notice. A wait planned in THIS run stays (it is still to come);
        // the short-lived states (switched, resumed, cancelled) finish their own hold and leave by themselves.
        setRateLimitBanner(b => {
          if (!b) return b;
          if (b.status === 'switched' || b.status === 'resumed' || b.status === 'cancelled') return b;
          if ((b.status === 'scheduled' || b.status === 'prompt') && b.run === runSeqRef.current) return b;
          return null;
        });
        // Idempotent: clearing streaming flag here means EventSource path
        // (peer tab) stops the local indicators; the reader-loop's finally
        // will run the same cleanup again — harmless.
        resetText();
        setStreaming(false);
        break;
      }

      // the run went on with another account: a short green note instead of a limit notice
      case 'account_switch':
        setRateLimitBanner({ resetAt: null, message: '', lastMessage: '', status: 'switched', at: new Date(), run: runSeqRef.current, key: Date.now() });
        break;

      case 'rate_limited': {
        // every account is full: the server schedules the resume itself (resume_scheduled follows)
        const resetAt = typeof data.resetAt === 'string' ? new Date(data.resetAt) : null;
        setRateLimitBanner({
          resetAt,
          message: typeof data.message === 'string' ? data.message : '',
          lastMessage: lastMessageRef.current,
          status: 'scheduled',
          run: runSeqRef.current,
          key: Date.now(),
        });
        break;
      }

      case 'resume_scheduled': {
        const at = typeof data.at === 'string' ? new Date(data.at) : null;
        setRateLimitBanner(b => ({
          resetAt: at ?? b?.resetAt ?? null, // the moment it continues (first account with room), not one account's reset
          message: b?.message ?? '',
          lastMessage: b?.lastMessage ?? lastMessageRef.current,
          status: 'scheduled',
          run: runSeqRef.current,
          key: b?.status === 'scheduled' ? b.key : Date.now(),
        }));
        break;
      }

      case 'error': {
        const msg = typeof data.message === 'string' ? data.message : tr('unknownError');
        if (isRateLimitError(msg)) {
          setRateLimitBanner({
            resetAt: null,
            message: msg,
            lastMessage: lastMessageRef.current,
            status: 'prompt',
            run: runSeqRef.current,
            key: Date.now(),
          });
        } else {
          setError({ ...classifyError(new Error(msg)), retry: true });
        }
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Live-subscribe to this conversation's stream so a parallel tab (or this
  // tab during a backend-resumed run) receives partial updates.
  useEffect(() => {
    if (!conversationId) return;
    const es = new EventSource(`/api/conversations/${conversationId}/stream`, { withCredentials: true });

    const handle = (eventType: string) => (e: MessageEvent) => {
      // If THIS tab is currently the originator, the reader loop is already
      // applying every event — skip to avoid double application.
      if (abortRef.current) return;
      try {
        const data = JSON.parse(e.data) as Record<string, unknown>;
        // Mark this tab as observing an in-flight stream so the streaming
        // UI (StreamingBubble, activity panel) actually renders the chunks
        // that applyStreamEvent feeds in. The 'done' branch will clear it.
        if (eventType !== 'done' && eventType !== 'error') {
          // Use a fresh getState read to avoid stale closure
          if (!liveOf().on) setStreaming(true);
        }
        void applyStreamEvent(eventType, data, e.lastEventId || undefined);
      } catch { /* skip malformed */ }
    };

    const onText = handle('text');
    const onThinking = handle('thinking');
    const onToolUse = handle('tool_use');
    const onToolResult = handle('tool_result');
    const onAgentStart = handle('agent_start');
    const onAgentActivity = handle('agent_activity');
    const onAgentResult = handle('agent_result');
    const onAgentInterrupted = handle('agent_interrupted');
    const onRateLimited = handle('rate_limited');
    const onAccountSwitch = handle('account_switch');
    const onResumeScheduled = handle('resume_scheduled');
    const onErrEvt = handle('error');
    const onDone = handle('done');
    const onRunStart = handle('run_start');
    const onReplayStart = handle('replay_start');
    const onReplayEnd = handle('replay_end');
    // card updates also arrive when no answer runs here (the delegation finished later): refresh the stored card
    const onDelegation = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as DelegationEvent;
        if (liveOf().on) { void applyStreamEvent('delegation', ev as unknown as Record<string, unknown>); return; }
        void convApi.get(conversationId).then((r) => setMessages(conversationId, r.messages ?? [])).catch(() => {});
      } catch { /* skip */ }
    };
    // Queue updates count for every window, also the one that sent the message
    const onQueue = (e: MessageEvent) => {
      try { setQueued((JSON.parse(e.data) as { items: QueuedMessage[] }).items ?? []); } catch { /* skip */ }
    };

    es.addEventListener('text', onText as EventListener);
    es.addEventListener('thinking', onThinking as EventListener);
    es.addEventListener('tool_use', onToolUse as EventListener);
    es.addEventListener('tool_result', onToolResult as EventListener);
    es.addEventListener('agent_start', onAgentStart as EventListener);
    es.addEventListener('agent_activity', onAgentActivity as EventListener);
    es.addEventListener('agent_result', onAgentResult as EventListener);
    es.addEventListener('agent_interrupted', onAgentInterrupted as EventListener);
    es.addEventListener('rate_limited', onRateLimited as EventListener);
    es.addEventListener('account_switch', onAccountSwitch as EventListener);
    es.addEventListener('resume_scheduled', onResumeScheduled as EventListener);
    es.addEventListener('error', onErrEvt as EventListener);
    es.addEventListener('done', onDone as EventListener);
    es.addEventListener('run_start', onRunStart as EventListener);
    es.addEventListener('replay_start', onReplayStart as EventListener);
    es.addEventListener('replay_end', onReplayEnd as EventListener);
    es.addEventListener('queue', onQueue as EventListener);
    es.addEventListener('delegation', onDelegation as EventListener);

    // Browser auto-reconnects on transport-level errors — no manual action.
    es.onerror = () => { /* noop */ };

    return () => {
      es.removeEventListener('text', onText as EventListener);
      es.removeEventListener('thinking', onThinking as EventListener);
      es.removeEventListener('tool_use', onToolUse as EventListener);
      es.removeEventListener('tool_result', onToolResult as EventListener);
      es.removeEventListener('agent_start', onAgentStart as EventListener);
      es.removeEventListener('agent_activity', onAgentActivity as EventListener);
      es.removeEventListener('agent_result', onAgentResult as EventListener);
      es.removeEventListener('agent_interrupted', onAgentInterrupted as EventListener);
      es.removeEventListener('rate_limited', onRateLimited as EventListener);
      es.removeEventListener('account_switch', onAccountSwitch as EventListener);
      es.removeEventListener('resume_scheduled', onResumeScheduled as EventListener);
      es.removeEventListener('error', onErrEvt as EventListener);
      es.removeEventListener('done', onDone as EventListener);
      es.removeEventListener('delegation', onDelegation as EventListener);
      es.removeEventListener('run_start', onRunStart as EventListener);
      es.removeEventListener('replay_start', onReplayStart as EventListener);
      es.removeEventListener('replay_end', onReplayEnd as EventListener);
      es.removeEventListener('queue', onQueue as EventListener);
      es.close();
    };
  }, [conversationId, applyStreamEvent]);

  /**
   * iMessage-style send: a copy of the new bubble rises from where the text was typed and moves to its
   * place on the right. Started in a layout effect, right after the bubble is in the DOM and before the
   * first paint: the real bubble is hidden from its first frame (msg-flying), so it never flashes at its
   * place first. Three layers: track follows the real bubble if the list still moves (scroll, typing
   * dots), up and sideways have their own timing. Transform and opacity run on the compositor.
   */
  function flyToBubble(key: string, from: DOMRect, finish: () => void): () => void {
    const bubble = document.querySelector<HTMLElement>(`[data-key="${key}"] .wa-bubble`);
    if (!bubble) { finish(); return () => {}; }
    const to = bubble.getBoundingClientRect();
    const track = document.createElement('div');
    Object.assign(track.style, {
      position: 'fixed', left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`,
      zIndex: '60', pointerEvents: 'none', contain: 'layout style',
    });
    const outer = document.createElement('div');
    Object.assign(outer.style, { width: '100%', height: '100%', willChange: 'transform, opacity' });
    const ghost = bubble.cloneNode(true) as HTMLElement;
    // the bubble's max-width is a share of its row; here it must be exactly the measured size
    Object.assign(ghost.style, {
      margin: '0', width: '100%', height: '100%', maxWidth: 'none', minWidth: '0', boxSizing: 'border-box',
      transformOrigin: 'top left', transition: 'none', animation: 'none', willChange: 'transform', visibility: 'visible',
    });
    outer.appendChild(ghost);
    track.appendChild(outer);
    document.body.appendChild(track);
    // start at the top left of the text field, as wide as the field allows
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = Math.min(1, Math.max(0.55, from.width / Math.max(1, to.width)));
    const up = outer.animate([
      { transform: `translateY(${dy}px)`, opacity: 0.5 },
      { transform: 'translateY(0)', opacity: 1 },
    ], { duration: 430, easing: 'cubic-bezier(.2, .85, .3, 1.04)' });
    ghost.animate([
      { transform: `translateX(${dx}px) scaleX(${sx})` },
      { transform: 'translateX(0) scaleX(1)' },
    ], { duration: 430, easing: 'cubic-bezier(.6, 0, .2, 1)' });
    // follow the real bubble: only writes when it actually moved or changed size
    let raf = 0, lx = 0, ly = 0, lw = to.width, lh = to.height;
    const follow = () => {
      const r = bubble.getBoundingClientRect();
      const nx = r.left - to.left, ny = r.top - to.top;
      if (nx !== lx || ny !== ly) { lx = nx; ly = ny; track.style.transform = `translate(${nx}px, ${ny}px)`; }
      if (r.width !== lw || r.height !== lh) { lw = r.width; lh = r.height; track.style.width = `${lw}px`; track.style.height = `${lh}px`; }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      bubble.style.visibility = 'visible'; // at once, in the same frame the copy goes
      track.remove();
      finish();
    };
    up.onfinish = done; up.oncancel = done;
    const t = setTimeout(done, 900);
    return () => { clearTimeout(t); done(); };
  }
  // the bubble that is flying in (hidden in the list until it lands) and where it started
  const [flyId, setFlyId] = useState<string | null>(null);
  const flyFrom = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const from = flyFrom.current;
    if (!flyId || !from) return;
    flyFrom.current = null;
    // pin the list to the bottom now, not a frame later: otherwise the landing spot jumps mid-flight
    const sc = scrollerRef.current;
    if (sc && stickRef.current) sc.scrollTop = sc.scrollHeight;
    return flyToBubble(flyId, from, () => setFlyId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyId]);

  async function sendMessage(retryText?: string) {
    const typed = (retryText ?? input).trim();
    // an image without text is fine: give Claude a short prompt
    const text = typed || (!retryText && convAttachments.length ? 'Zie bijlage.' : '');
    if (!text) return;
    if (text.length > MAX_INPUT_CHARS) return;
    stickRef.current = true;

    // Claude is busy: queue it on the server, it runs after the current answer (also with the app closed)
    if (isStreaming) {
      if (!retryText) setInput('');
      const queuedAtts = [...convAttachments];
      setConvAttachments([]);
      try {
        const r = await convApi.enqueue(conversationId, text, queuedAtts.map(a => a.id));
        setQueued(r.items);
      } catch (err) {
        setError(classifyError(err));
        if (!retryText) setInput(typed);
        setConvAttachments(queuedAtts);
      }
      return;
    }

    // where the text sat in the composer: the sent bubble flies up from there (like iMessage)
    const fromRect = !retryText ? textareaRef.current?.getBoundingClientRect() ?? null : null;
    if (!retryText) setInput('');
    lastMessageRef.current = text;
    setError(null);
    setRateLimitBanner(null);
    setActiveTools([]); setLiveAgents([]); setLiveDelegations([]);
    setThinkingText('');
    setThinkingExpanded(false);
    resetText();
    setStreaming(true);

    // Attachments go with this message and leave the composer
    const sentAtts = [...convAttachments];
    if (sentAtts.length > 0) sentAttachmentsRef.current.set(text, sentAtts);
    setConvAttachments([]);

    const tempUserMsg: Message = {
      id: `temp-${Date.now()}`,
      conversation_id: conversationId,
      role: 'user',
      content: text,
      token_count: 0,
      created_at: new Date().toISOString(),
      attachments: sentAtts.length > 0 ? sentAtts : undefined,
    };
    addMessage(conversationId, tempUserMsg);
    setSentId(tempUserMsg.id);
    if (fromRect && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      flyFrom.current = fromRect;
      setFlyId(tempUserMsg.id);
    }
    const seqAtStart = runSeqRef.current;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let refused = false; // the server did not accept the message (e.g. Claude not linked)
    let stillRunning = false; // connection lost (app in background) but the server keeps going

    try {
      const url = `/api/conversations/${conversationId}/stream`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, attachments: sentAtts.map(a => a.id) }),
      });

      if (!res.ok) {
        refused = true;
        let detail = `HTTP ${res.status}`;
        try { const body = await res.json() as { error?: string }; if (body.error) detail = body.error; } catch { /* ignore */ }
        throw new Error(detail);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const lines = part.split('\n');
          let eventType = '';
          let dataStr = '';
          let evId: string | undefined;

          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            if (line.startsWith('data: ')) dataStr = line.slice(6);
            if (line.startsWith('id: ')) evId = line.slice(4).trim();
          }

          // SSE comment (ping) — skip
          if (!dataStr) continue;

          try {
            const data = JSON.parse(dataStr) as Record<string, unknown>;
            await applyStreamEvent(eventType, data, evId);
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        if (refused) {
          // The server did not take the message: show why, give the text back, offer a retry
          setError({ ...classifyError(err), retry: true });
          if (!retryText) setInput(text);
          setConvAttachments(sentAtts);
        } else {
          // Only this window's connection dropped (app in background, network switch). The server
          // has the question and keeps going: catch up instead of offering to send it again.
          stillRunning = true;
          void resync();
        }
      }
    } finally {
      const newerRun = runSeqRef.current !== seqAtStart;
      abortRef.current = null;
      if (!stillRunning && !newerRun) {
        setStreaming(false);
        resetText();
        setActiveTools([]); setLiveAgents([]); setLiveDelegations([]);
        setThinkingText('');
      }
    }
  }

  /** Upload one or more files (picker, paste, drop); also while Claude is busy. */
  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    setUploadingFile(true);
    try {
      for (const f of files) {
        // pasted screenshots are all called "image.png"; give them a readable name
        const named = /^image\.(png|jpe?g|gif|webp)$/i.test(f.name)
          ? new File([f], `afbeelding-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${f.name.split('.').pop()}`, { type: f.type })
          : f;
        const att = await attachmentsApi.upload(conversationId, named);
        setConvAttachments(prev => [...prev, att]);
      }
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setUploadingFile(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    await uploadFiles(files);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return; // plain text: normal paste
    e.preventDefault();
    void uploadFiles(files);
  }

  const [dragOver, setDragOver] = useState(false);
  const uploadFilesRef = useRef(uploadFiles);
  uploadFilesRef.current = uploadFiles;

  // Drop anywhere in the window (not only on the composer); otherwise the browser
  // opens the dropped image itself. Also accepts images dragged from a web page (URL only).
  useEffect(() => {
    let depth = 0;
    const isFileDrag = (e: DragEvent) => {
      const t = Array.from(e.dataTransfer?.types ?? []);
      return t.includes('Files') || t.includes('text/uri-list');
    };
    const onEnter = (e: DragEvent) => { if (!isFileDrag(e)) return; e.preventDefault(); depth++; setDragOver(true); };
    const onOver = (e: DragEvent) => { if (!isFileDrag(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const onLeave = (e: DragEvent) => { if (!isFileDrag(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragOver(false); };
    const onDrop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0; setDragOver(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const files = Array.from(dt.files ?? []);
      if (files.length) { void uploadFilesRef.current(files); return; }
      // image dragged from a web page: only a URL comes along
      const html = dt.getData('text/html');
      const src = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || dt.getData('text/uri-list').split(/\r?\n/).find(l => l && !l.startsWith('#'));
      if (!src) return;
      try {
        const r = await fetch(src);
        if (!r.ok) throw new Error(String(r.status));
        const blob = await r.blob();
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '');
        const base = decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() || '').replace(/[^\w.-]/g, '') || `afbeelding.${ext}`;
        void uploadFilesRef.current([new File([blob], /\.\w{2,5}$/.test(base) ? base : `${base}.${ext}`, { type: blob.type })]);
      } catch {
        setError({ title: 'Dit plaatje kan ik niet ophalen', detail: 'De site blokkeert dat. Sla het eerst op, of kopieer en plak het.' });
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  async function removeAttachment(id: string) {
    try {
      await attachmentsApi.delete(conversationId, id);
      setConvAttachments(prev => prev.filter(a => a.id !== id));
    } catch { /* ignore */ }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionList.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionList.length) % mentionList.length); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickMention(mentionList[Math.min(mentionIdx, mentionList.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionClosed(mentionTok!.start); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.length <= MAX_INPUT_CHARS) sendMessage();
    }
  }

  /** Catches up with the server after a dropped connection; retries while the network comes back. */
  async function resync() {
    for (const wait of [0, 1500, 4000, 10000]) {
      if (wait) await new Promise(r => setTimeout(r, wait));
      try {
        const fresh = (await convApi.get(conversationId)).messages ?? [];
        setMessages(conversationId, fresh);
        const partial = livePartial(fresh);
        if (partial) {
          // still running: the live subscription delivers the rest
          seedPartial(partial.content);
          setStreaming(true);
        } else {
          resetText();
          setActiveTools([]); setLiveAgents([]); setLiveDelegations([]);
          setThinkingText('');
          setStreaming(false);
        }
        convApi.queue(conversationId).then(r => setQueued(r.items)).catch(() => {});
        return;
      } catch { /* network not back yet */ }
    }
    // Still offline: stop the spinner; coming back to the app syncs again
    setStreaming(false);
    setError({ title: tr('connectionLost'), detail: tr('connectionLostDetail') });
  }

  // Stops Claude on the server; waiting messages stay in the queue until you send again
  function stopStreaming() {
    void convApi.stop(conversationId).catch(() => {});
    abortRef.current?.abort();
  }

  async function sendQueuedNow(qid: string) {
    try { setQueued((await convApi.sendNow(conversationId, qid)).items); } catch (err) { setError(classifyError(err)); }
  }

  async function removeQueued(qid: string) {
    try { setQueued((await convApi.dequeue(conversationId, qid)).items); } catch { /* ignore */ }
  }

  // UI #27: resumes across messages, and the live agents as a chain (who asked whom)
  const storedLinks = useMemo(() => linkResumes(messages), [messages]);
  const liveSorted = [...liveAgents].sort((a, b) => a.at - b.at);
  // a resumed run that is live now: the cut-off bubble in the history shows "hervat om" instead of red + Verder
  const agentLinks = useMemo(() => {
    let links = storedLinks.links;
    for (const a of liveAgents) {
      const prev = a.resumed && a.resumedIso ? storedLinks.last.get(a.ccAgentId ?? a.agentId) : undefined;
      if (!prev?.cut || links.get(prev.toolUseId)?.resumedAt) continue;
      if (links === storedLinks.links) links = new Map(links);
      links.set(prev.toolUseId, { ...links.get(prev.toolUseId), resumedAt: a.resumedIso });
    }
    return { links, last: storedLinks.last };
  }, [storedLinks, liveAgents]);
  const liveChain = deriveChain(liveSorted.map((a, i) => ({
    agentId: a.agentId, agentName: a.agentName, content: a.content, isError: a.isError,
    adjacentPrev: i > 0 && !streamingMessage.slice(liveSorted[i - 1].at, a.at).trim(),
  })), agentList.map((x) => x.name));
  // one pulse at a time: the agent at work, else the newest waiting clock or open question
  const livePulse = (() => {
    for (let i = liveSorted.length - 1; i >= 0; i--) if (liveSorted[i].content === undefined && !liveSorted[i].wait) return i;
    for (let i = liveSorted.length - 1; i >= 0; i--) {
      const x = liveSorted[i];
      if ((x.content === undefined && x.wait) || (liveChain[i]?.askedTo && !liveChain[i].askedTo!.answered)) return i;
    }
    return -1;
  })();

  return (
    <div className="flex flex-col h-full relative" style={{ '--sbw': `${sbw}px` } as React.CSSProperties}>
      {/* Title bar, like the Claude app (desktop; mobile has its own top bar) */}
      {/* UI #19: header, bubbles and composer share one column (1000px, centred), so their left edges line up */}
      <div className={clsx('hidden md:flex', 'wa-chat-head shrink-0 h-14 items-center px-6 md:pr-[calc(1.5rem+var(--sbw,0px))]')}>
        <div className="w-full max-w-[1000px] mx-auto flex items-center gap-3 min-w-0">
          <ConvAvatar id={conversationId} title={titleOverride ?? (title || tr('untitled'))} className="w-9 h-9 text-[13px]" />
          <span className="flex-1 truncate text-[15px] font-medium text-(--text)" title={titleOverride ?? title}>{titleOverride ?? (title || tr('untitled'))}</span>
          <PushBell conversationId={conversationId} />
          {headerExtra}
        </div>
      </div>

      {/* Messages — flex-1 fills space between header and input; only this div scrolls */}
      <div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]" style={{ WebkitOverflowScrolling: 'touch' }}>
        {/* rows carry their own px-6 side padding (1.5rem), so the column is 1000px + 3rem wide */}
        <div role="log" aria-live="polite" aria-label={tr('messages')} className={clsx('w-full max-w-[calc(1000px+3rem)] mx-auto py-3', !settled && 'msgs-static')}>
        {messages.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-4 px-4">
            <h1 className="text-3xl md:text-4xl font-semibold text-(--text) text-center">
              {tr('welcome')}
            </h1>
            <p className="text-(--muted) text-base text-center max-w-md">
              {tr('welcomeSub')}
            </p>
          </div>
        )}

        {messages
          .filter(msg => msg !== livePartial(messages))
          .map((msg) => (
            <MessageBubble key={msg.clientKey ?? msg.id} message={msg} still={msg.id === swapId} sent={msg.id === sentId || (!!msg.clientKey && msg.clientKey === sentId)} flying={!!flyId && (msg.id === flyId || msg.clientKey === flyId)}
              agentLinks={agentLinks.links} calm={!isStreaming} />
          ))}

        {/* Thinking block during streaming */}
        {isStreaming && thinkingText && (
          <div className="flex gap-3 px-4 py-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0
                            bg-(--input) text-(--accent) border border-(--border) text-xs font-semibold">
              AI
            </div>
            <div className="flex-1 rounded-lg border border-(--border) overflow-hidden text-xs">
              <button
                onClick={() => setThinkingExpanded(e => !e)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-(--input) hover:bg-(--border) transition-colors text-left"
              >
                <span className="w-2 h-2 rounded-full bg-(--muted) animate-pulse shrink-0" />
                <span className="text-(--muted) italic">{tr('thinking')}</span>
                {/* Arrow: ► when collapsed, ▼ when open */}
                <svg className={clsx('w-3 h-3 text-(--muted) ml-auto shrink-0 transition-transform', !thinkingExpanded && '-rotate-90')}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {thinkingExpanded && (
                <div className="px-3 py-2 bg-(--bg) text-(--muted) text-xs whitespace-pre-wrap font-mono max-h-48 overflow-y-auto leading-relaxed">
                  {thinkingText}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Unified activity panel — all tool calls during streaming */}
        {isStreaming && activeTools.length > 0 && (
          <div className="flex justify-start px-4 md:px-6 py-1.5">
            <div className="w-full min-w-0 max-w-[92%] md:max-w-[80%]">
              <ActivityPanel tools={activeTools} />
            </div>
          </div>
        )}

        {/* nothing written yet: a typing bubble that grows into the answer */}
        {isStreaming && liveAgents.length === 0 && <StreamingBubble text={streamingMessage} typing={!activeTools.length && !thinkingText} />}
        {/* agents at work: the live text split around their turns, each turn in its own bubble */}
        {isStreaming && liveAgents.length > 0 && liveSorted.map((a, i, list) => (
          <Fragment key={a.toolUseId}>
            <StreamingBubble text={streamingMessage.slice(i === 0 ? 0 : list[i - 1].at, a.at)} />
            <AgentBubble agentId={a.agentId} agentName={a.agentName} task={a.task} content={a.content} isError={a.isError} activity={a.activity} steps={a.steps} startedAt={a.startedAt}
              chain={liveChain[i]} nextAgentId={list[i + 1]?.agentId} nextAgentName={list[i + 1]?.agentName} wait={a.content === undefined ? a.wait : undefined}
              resumedFrom={a.resumed && a.resumedIso && agentLinks.last.get(a.ccAgentId ?? a.agentId)?.cut ? a.resumedIso : undefined}
              pulse={i === livePulse} />
            {i === list.length - 1 && <StreamingBubble text={streamingMessage.slice(a.at)} typing={list.every((x) => x.content !== undefined) && !activeTools.some((t) => t.result === undefined)} />}
          </Fragment>
        ))}
        {isStreaming && liveDelegations.map((ev) => <DelegationCard key={ev.delegationId} ev={ev} />)}
        {isStreaming && (quiet || shownTool) && (streamingMessage.trim() || shownTool || activeTools.length > 0 || thinkingText) && <LiveStatus tool={shownTool} />}

        {/* UI #26: limit notice (prompt, scheduled, switched, resumed, cancelled) */}
        {rateLimitBanner && rateLimitBanner.status !== 'dismissed' && (
          <LimitNotice
            key={rateLimitBanner.key}
            status={rateLimitBanner.status as LimitStatus}
            resetAt={rateLimitBanner.resetAt}
            at={rateLimitBanner.at}
            canSchedule={!!rateLimitBanner.resetAt && !!rateLimitBanner.lastMessage}
            scheduleLoading={scheduleLoading}
            onSchedule={() => void handleScheduleResume()}
            onCancel={() => void handleCancelSchedule()}
            onDismiss={() => setRateLimitBanner(null)}
            onGone={() => { const k = rateLimitBanner.key; setRateLimitBanner(b => (b && b.key === k ? null : b)); }}
          />
        )}

        {error && (
          <div className="mx-4 my-2 bg-red-500/10 border border-red-500/30 rounded-xl text-sm overflow-hidden">
            <div className="flex items-start gap-3 px-4 py-3">
              <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5"
                fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-red-400">{error.title}</p>
                {error.detail && (
                  <p className="text-xs mt-0.5 wrap-break-word text-red-400/70">{error.detail}</p>
                )}
              </div>
              <button
                onClick={() => setError(null)}
                className="text-red-400/60 hover:text-red-400 transition-colors shrink-0"
                title="Sluiten"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {error.retry && lastMessageRef.current && (
              <div className="px-4 pb-3">
                <button
                  onClick={() => { setError(null); sendMessage(lastMessageRef.current); }}
                  className="flex items-center gap-1.5 text-xs bg-red-500/20 hover:bg-red-500/30
                             text-red-400 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {tr('retry')}
                </button>
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
        </div>{/* end max-w-3xl */}
      </div>

      {/* Input — shrink-0 keeps this always visible; pb-safe clears the iOS home indicator */}
      <div className="composer-wrap relative z-20 shrink-0 px-4 pt-3 pb-3 md:px-6 md:pt-4 md:pb-4 pr-[calc(1rem+var(--sbw,0px))] md:pr-[calc(1.5rem+var(--sbw,0px))]">
        <div className="w-full max-w-[1000px] mx-auto">
        {queued.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {queued.map((q, i) => (
              <div key={q.id} className="flex items-center gap-2 bg-(--input) border border-dashed border-(--border) rounded-xl pl-3 pr-1.5 py-1.5 text-sm">
                <span className="text-[11px] text-(--muted) tabular-nums shrink-0">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate text-(--text)" title={q.content}>{q.content}</span>
                <button type="button" onClick={() => void sendQueuedNow(q.id)}
                  className="h-7 px-2 flex items-center gap-1 rounded-lg text-xs text-(--accent) hover:bg-(--border) transition-colors shrink-0"
                  title={tr('sendNow')}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 19V5m0 0l-6 6m6-6l6 6" /></svg>
                  {tr('now')}
                </button>
                <button type="button" onClick={() => void removeQueued(q.id)}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-(--muted) hover:text-red-400 hover:bg-(--border) transition-colors shrink-0"
                  title={tr('removeQueued')}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {convAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 pt-1.5">
            {convAttachments.map(att => att.mime_type.startsWith('image/') ? (
              <div key={att.id} className="relative group/att">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/conversations/${conversationId}/attachments/${att.id}/content`} alt={att.original_name}
                  className="h-16 w-16 rounded-lg object-cover border border-(--border)" />
                <button onClick={() => removeAttachment(att.id)} title="Verwijderen"
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-900/90 text-white flex items-center justify-center border border-white/20 hover:bg-red-500">
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            ) : (
              <div key={att.id} className="flex items-center gap-1.5 bg-(--input) border border-(--border) rounded-lg px-2 py-1 text-xs text-(--text) self-center">
                <svg className="w-3 h-3 text-(--accent) shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                <span className="max-w-[120px] truncate">{att.original_name}</span>
                <button onClick={() => removeAttachment(att.id)} className="text-(--muted) hover:text-red-400 transition-colors ml-0.5 shrink-0" title="Verwijderen">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={clsx(
          'relative bg-(--input) rounded-(--radius-composer) border px-3 pt-3 pb-2 md:px-4',
          dragOver && 'ring-2 ring-(--accent)/60',
          'shadow-(--shadow-composer) transition-[border-color,box-shadow] duration-200',
          'focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_16%,transparent),var(--shadow-composer)]',
          input.length > MAX_INPUT_CHARS
            ? 'border-red-400/40 focus-within:border-red-400/60'
            : 'border-(--border) focus-within:border-(--accent)/70',
        )}>
          <MentionMenu open={mentionOpen} list={mentionList} q={mentionTok?.q ?? ''} active={Math.min(mentionIdx, Math.max(0, mentionList.length - 1))}
            onPick={pickMention} onHover={setMentionIdx} />
          <div className="relative">
          {hasMention && (
            <div ref={mirrorRef} aria-hidden
              className="composer-mirror absolute left-0 top-0 w-full h-full box-border px-1 text-[15px] leading-relaxed whitespace-pre-wrap break-words overflow-hidden pointer-events-none text-transparent">
              {(() => { const seen: Record<string, number> = {}; return composerParts.map((p, i) => p.mention
                ? <span key={`${p.mention}-${(seen[p.mention] = (seen[p.mention] ?? 0) + 1)}`} className="mention-glow"
                    style={{ '--ag': findAgent(agentList, undefined, p.mention)?.color ?? undefined } as React.CSSProperties}>{p.text}</span>
                : <span key={`t${i}`}>{p.text}</span>); })()}
              {'\u200b'}
            </div>
          )}
          <textarea
            ref={textareaRef}
            aria-label={tr('messageLabel')}
            value={input}
            onChange={(e) => { setInput(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setMentionClosed(mentionTok?.start ?? null)}
            onFocus={() => setMentionClosed(null)}
            onKeyDown={handleKeyDown}
            onScroll={(e) => { if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop; }}
            onPaste={handlePaste}
            placeholder={isStreaming ? tr('placeholderQueue') : tr('placeholder')}
            rows={1}
            spellCheck={spellOn}
            lang={spellOn ? spellLang : undefined}
            autoCorrect={spellOn ? 'on' : 'off'}
            className="relative block w-full px-1 bg-transparent text-(--text) text-[15px] placeholder-(--muted) resize-none outline-none leading-relaxed min-h-[28px] max-h-[200px]"
          />
          </div>
          {/* Bottom row, like the Claude app: attach left; model + send right */}
          <div className="flex items-center gap-1 mt-1.5">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingFile}
            className="hit-44 w-8 h-8 flex items-center justify-center rounded-lg text-(--muted) hover:text-(--text) hover:bg-(--border) transition-colors shrink-0 disabled:opacity-50"
            title={tr('attach')}
            aria-label={tr('attach')}
          >
            {uploadingFile ? (
              <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
              </svg>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,.pdf,.txt,.md,.csv,.json,.xml,.js,.ts,.py,.html,.css,.log,.ps1,.sh,.yml,.yaml"
            onChange={handleFileUpload}
          />
            <div className="flex-1" />
          {/* naast Versturen: dit gesprek in het Chrome-zijpaneel openen (alleen als de extensie gekoppeld is) */}
          <ChromePanelButton conversationId={conversationId} />
          {isStreaming && (
            <button
              onClick={stopStreaming}
              className="hit-44 relative w-8 h-8 flex items-center justify-center rounded-full text-(--text) hover:bg-(--border) active:scale-95 transition-[background-color,transform] duration-150 shrink-0"
              title="Stoppen"
              aria-label="Stoppen"
            >
              {/* busy: spinning ring in the accent colour, the square in the middle stops */}
              <svg className="absolute inset-0 w-8 h-8 animate-spin [animation-duration:1.1s]" viewBox="0 0 32 32" fill="none" aria-hidden>
                <circle cx="16" cy="16" r="13" stroke="currentColor" strokeOpacity=".18" strokeWidth="2.5" />
                <path d="M16 3a13 13 0 0 1 13 13" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" /></svg>
            </button>
          )}
          {(!isStreaming || input.trim() || convAttachments.length > 0) && (
            <button
              // keep the keyboard up while sending (like iMessage): closing it mid-flight resized the
              // whole app every frame and moved the bubble's landing spot
              onPointerDown={() => { kbUp.current = document.activeElement === textareaRef.current; }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { void sendMessage(); if (kbUp.current) textareaRef.current?.focus({ preventScroll: true }); }}
              disabled={(!input.trim() && !convAttachments.length) || input.length > MAX_INPUT_CHARS}
              className={clsx(
                'hit-44 w-8 h-8 flex items-center justify-center rounded-full transition-[filter,transform,background-color] duration-150 shrink-0 active:scale-95',
                (input.trim() || convAttachments.length > 0) && input.length <= MAX_INPUT_CHARS
                  ? 'bg-(--accent-strong) text-white hover:brightness-95'
                  : 'bg-(--border) text-(--muted) cursor-not-allowed',
              )}
              title={input.length > MAX_INPUT_CHARS ? tr('tooLong') : isStreaming ? tr('queue') : tr('send')}
              aria-label={isStreaming ? tr('queue') : tr('send')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 19V5m0 0l-6 6m6-6l6 6" />
              </svg>
            </button>
          )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 mt-1.5 pl-2 pr-1">
          <UsageMeter />
          <div className="relative shrink-0" ref={modelMenuRef}>
            <button
              type="button"
              onClick={() => setModelMenuOpen(o => !o)}
              className="flex items-center gap-1 px-2 h-8 rounded-lg text-xs text-(--muted) hover:text-(--text) hover:bg-(--border)/60 transition-colors"
              title={tr('modelTitle')}
            >
              <span className="max-w-[9rem] truncate">
                {(() => {
                  const cur = convModel || effectiveDefault;
                  const found = availableModels.find(m => m.id === cur);
                  return found ? found.label : cur;
                })()}
              </span>
              <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {modelMenuOpen && (
              <div data-up="true" className="glass-menu glass-menu-anim origin-bottom-right absolute right-0 bottom-full mb-2 w-72 rounded-card p-1 z-50 overflow-hidden max-h-[60vh] overflow-y-auto">
                <button
                  onClick={() => changeModel('__default__')}
                  className={`w-full text-left px-3 py-2.5 glass-menu-item text-xs border-b border-(--border) ${convModel === '' ? 'bg-(--lg-sel)' : ''}`}
                >
                  <div className="font-medium text-(--text)">Standaard ({effectiveDefault})</div>
                  <div className="text-(--muted) text-[11px] mt-0.5">{tr('modelDefaultHint')}</div>
                </button>
                {availableModels.filter(m => m.category === 'alias').map(m => (
                  <button key={m.id} onClick={() => changeModel(m.id)}
                    className={`w-full text-left px-3 py-2.5 glass-menu-item text-xs ${convModel === m.id ? 'bg-(--lg-sel)' : ''}`}>
                    <div className="font-medium text-(--text)">{m.label}</div>
                    <div className="text-(--muted) text-[11px] mt-0.5">{m.description}</div>
                  </button>
                ))}
                {availableModels.filter(m => m.category === 'full').length > 0 && (
                  <div className="border-t border-(--border)">
                    <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-(--muted)">{tr('specificVersions')}</div>
                    {availableModels.filter(m => m.category === 'full').map(m => (
                      <button key={m.id} onClick={() => changeModel(m.id)}
                        className={`w-full text-left px-3 py-2 glass-menu-item text-xs ${convModel === m.id ? 'bg-(--lg-sel)' : ''}`}>
                        <div className="text-(--text)">{m.label}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {input.length >= MAX_INPUT_CHARS * 0.9 && (
          <div
            className={clsx(
              'mt-1 px-1 text-[11px] flex justify-end gap-1 tabular-nums select-none',
              input.length > MAX_INPUT_CHARS
                ? 'text-red-400'
                : input.length >= MAX_INPUT_CHARS * 0.9
                  ? 'text-yellow-400'
                  : 'text-(--muted)',
            )}
          >
            <span>
              {input.length.toLocaleString('nl-NL')}/{MAX_INPUT_CHARS.toLocaleString('nl-NL')}
            </span>
            {input.length > MAX_INPUT_CHARS && (
              <span>— {(input.length - MAX_INPUT_CHARS).toLocaleString('nl-NL')} te veel</span>
            )}
          </div>
        )}
        </div>{/* end max-w-3xl */}
      </div>
    </div>
  );
}
