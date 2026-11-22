'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { conversations as convApi } from '@/lib/api';
import type { Message } from '@/types';
import MessageBubble, { linkResumes } from './MessageBubble';
import { AgentContinueContext, type AgentStep } from './AgentBubble';

/** One stream event in the shape a stored answer has (MessageBubble renders it). */
type LiveEvent = Record<string, unknown> & { type: string };

/**
 * Looking over an agent's shoulder, inside the card: the messages of its workplace and, while it runs,
 * the live answer (steps, agent bubbles, report) from the workplace's own stream. Same components as a
 * normal chat (MessageBubble with AgentBubble and the chain), nothing rebuilt. Subscribed only while
 * mounted, so only while the card is open.
 */
export function DelegationWatch({ conversationId, onRun, onQueue }: {
  conversationId: string;
  /** a run started or ended in the workplace: the card refreshes its status */
  onRun?: () => void;
  onQueue?: (n: number) => void;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [live, setLive] = useState<LiveEvent[]>([]);
  const [liveOn, setLiveOn] = useState(false);
  // live steps per agent turn (agent_activity is not stored): Builder and an agent it asked, each in its own bubble
  const [agentLive, setAgentLive] = useState<Map<string, { steps: AgentStep[]; activity?: string }>>(() => new Map());
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onRunRef = useRef(onRun); onRunRef.current = onRun;
  const onQueueRef = useRef(onQueue); onQueueRef.current = onQueue;

  const load = useCallback(async () => {
    try {
      const r = await convApi.get(conversationId);
      // the handed-over task itself is the card's title; the workplace starts with what the agent did
      setMessages((r.messages ?? []).filter((m, i) => !(i === 0 && m.role === 'user' && m.metadata?.auto === 'delegation')));
    } catch { setMessages((m) => m ?? []); }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const es = new EventSource(`/api/conversations/${conversationId}/stream`, { withCredentials: true });
    const seen = new Set<string>();
    const reset = () => { setLive([]); setAgentLive(new Map()); seen.clear(); };
    // the saved answer first, then the live part goes away (no flash of the older partial)
    const end = () => { void load().then(() => { setLiveOn(false); reset(); }); onRunRef.current?.(); };
    const on = (type: string) => (e: MessageEvent) => {
      if (e.lastEventId) { if (seen.has(e.lastEventId)) return; seen.add(e.lastEventId); }
      let data: Record<string, unknown>;
      try { data = JSON.parse(e.data) as Record<string, unknown>; } catch { return; }
      if (type === 'done' || type === 'error') return end();
      if (type === 'queue') { onQueueRef.current?.(Array.isArray(data.items) ? data.items.length : 0); return; }
      if (type === 'run_start') { reset(); setLiveOn(true); void load(); onRunRef.current?.(); return; }
      // a (re)subscribe replays the whole run: start over, the ids line it up with the saved partial
      if (type === 'replay_start') { reset(); return; }
      if (type === 'replay_end') return;
      setLiveOn(true);
      if (type === 'agent_activity') {
        const id = String(data.toolUseId ?? '');
        const step: AgentStep = { tool: String(data.toolName ?? ''), detail: typeof data.detail === 'string' ? data.detail : '', at: typeof data.at === 'number' ? data.at : Date.now() };
        setAgentLive((prev) => {
          const cur = prev.get(id);
          const next = new Map(prev);
          next.set(id, { activity: step.tool, steps: [...(cur?.steps ?? []), step].slice(-40) });
          return next;
        });
        return;
      }
      const ev: LiveEvent = { ...data, type, ...(e.lastEventId ? { sid: e.lastEventId } : {}) };
      setLive((prev) => {
        if (type === 'tool_use' && prev.some((x) => x.type === 'tool_use' && x.toolUseId === data.toolUseId)) return prev;
        if (type === 'agent_start' && prev.some((x) => x.type === 'agent_start' && x.toolUseId === data.toolUseId)) return prev;
        return [...prev, ev];
      });
    };
    const types = ['text', 'tool_use', 'tool_result', 'agent_start', 'agent_activity', 'agent_result', 'agent_interrupted', 'run_start', 'replay_start', 'replay_end', 'done', 'error', 'queue'];
    const handlers = types.map((t) => [t, on(t)] as const);
    for (const [t, h] of handlers) es.addEventListener(t, h as EventListener);
    return () => { for (const [t, h] of handlers) es.removeEventListener(t, h as EventListener); es.close(); };
  }, [conversationId, load]);

  // the answer being written is saved as it goes (metadata.streaming): shown once, as the live answer
  const partial = useMemo(() => {
    const last = messages?.[messages.length - 1];
    return last?.role === 'assistant' && last.metadata?.streaming === true ? last : null;
  }, [messages]);
  const merged = useMemo(() => {
    if (!liveOn) return [] as LiveEvent[];
    let base: LiveEvent[] = [];
    if (partial?.content.startsWith('[')) { try { const arr = JSON.parse(partial.content); if (Array.isArray(arr)) base = arr as LiveEvent[]; } catch { /* plain text */ } }
    const sids = new Set(base.map((e) => e.sid).filter(Boolean));
    return [...base, ...live.filter((e) => !e.sid || !sids.has(e.sid))];
  }, [liveOn, partial, live]);
  const shown = useMemo(() => (liveOn && partial ? (messages ?? []).filter((m) => m !== partial) : messages ?? []), [messages, liveOn, partial]);

  // follow the newest part, unless the user scrolled up to read
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, merged, agentLive]);

  const { links } = useMemo(() => linkResumes(shown), [shown]);
  const liveMsg: Message | null = liveOn && merged.length ? {
    id: `live-${conversationId}`, conversation_id: conversationId, role: 'assistant', token_count: 0,
    created_at: partial?.created_at ?? new Date().toISOString(), content: JSON.stringify(merged), metadata: { streaming: true },
  } : null;
  // "Verder" on an interrupted agent in here goes to this workplace
  const sendContinue = useCallback((text: string) => { void convApi.enqueue(conversationId, text).then(() => onRunRef.current?.()).catch(() => { /* the card shows the status */ }); }, [conversationId]);

  return (
    <AgentContinueContext.Provider value={sendContinue}>
      <div ref={scroller} className="dg-watch" onScroll={(e) => {
        const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {messages === null ? (
          <p className="dg-watch-note">Werkplek laden</p>
        ) : (
          <>
            {!shown.length && !liveMsg && <p className="dg-watch-note">Nog niets te zien. De agent begint zo.</p>}
            {shown.map((m) => <MessageBubble key={m.id} message={m} agentLinks={links} calm={!liveOn} />)}
            {liveMsg && <MessageBubble key="live" message={liveMsg} calm={false} agentLinks={links} agentLive={agentLive} />}
            {liveOn && !merged.some((x) => (x.type === 'text' && String(x.text ?? '').trim()) || x.type === 'agent_start') && (
              <div className="dg-watch-note flex items-center gap-2" aria-live="polite">
                <span className="typing-dots" aria-hidden><i /><i /><i /></span>
                Aan het werk
              </div>
            )}
          </>
        )}
      </div>
    </AgentContinueContext.Provider>
  );
}
