'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { AgentDef } from '@/lib/api';
import { AgentAvatar } from './AgentBubble';

/** The @word right before the caret (at the start or after a space), or null. */
export function mentionAt(text: string, caret: number): { start: number; q: string } | null {
  const m = text.slice(0, caret).match(/(^|\s)@([\p{L}\p{N}_-]*)$/u);
  return m ? { start: caret - m[2].length - 1, q: m[2] } : null;
}

/** Active agents matching what is typed after @: name start first, then a word start, then anywhere. */
export function matchAgents(agents: AgentDef[], q: string): AgentDef[] {
  const s = q.toLowerCase();
  const score = (a: AgentDef) => {
    const n = a.name.toLowerCase();
    if (!s) return 1;
    if (n.startsWith(s)) return 3;
    if (n.split(/\s+/).some((w) => w.startsWith(s))) return 2;
    return n.replace(/\s+/g, '').includes(s) || a.description.toLowerCase().includes(s) ? 1 : 0;
  };
  return agents.filter((a) => a.is_active).map((a) => ({ a, s: score(a) })).filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name)).map((x) => x.a).slice(0, 6);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Split text into plain parts and @mentions of known agents (longest names first, so
 * "@Helpdesk" wins over a shorter name), for highlighting in the composer and in bubbles.
 */
export function splitMentions(text: string, names: string[]): Array<{ text: string; mention?: string }> {
  if (!names.length || !text.includes('@')) return [{ text }];
  const re = new RegExp(`(^|[\\s(])@(${[...names].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
  const out: Array<{ text: string; mention?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index! + m[1].length;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: '@' + m[2], mention: m[2] });
    last = at + 1 + m[2].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function Highlight({ name, q }: { name: string; q: string }) {
  const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{name}</>;
  return <>{name.slice(0, i)}<span className="text-(--accent)">{name.slice(i, i + q.length)}</span>{name.slice(i + q.length)}</>;
}

/**
 * Suggestions above the composer while typing @name. Springs open from the composer, items
 * cascade in, the selection slides between rows, and it fades out again when closed.
 */
export default function MentionMenu({ open, list, q, active, onPick, onHover }: {
  open: boolean; list: AgentDef[]; q: string; active: number; onPick: (a: AgentDef) => void; onHover: (i: number) => void;
}) {
  // stay mounted for the closing animation, with the last list on screen
  const [shown, setShown] = useState(open);
  const last = useRef({ list, q });
  if (open && list.length) last.current = { list, q };
  useEffect(() => {
    if (open) { setShown(true); return; }
    const t = setTimeout(() => setShown(false), 170);
    return () => clearTimeout(t);
  }, [open]);

  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const [pill, setPill] = useState<{ y: number; h: number } | null>(null);
  const items = last.current.list;
  useLayoutEffect(() => {
    const el = rows.current[active];
    if (el) setPill({ y: el.offsetTop, h: el.offsetHeight });
  }, [active, items.length, shown]);

  if (!shown) return null;
  return (
    <div role="listbox" data-state={open ? 'open' : 'closed'}
      className="mention-menu glass-menu absolute left-0 right-0 bottom-full mb-2 z-30 rounded-card border border-(--border) overflow-hidden shadow-(--shadow-composer)"
     >
      <p className="px-3.5 pt-2.5 pb-1 text-[11px] uppercase tracking-wide text-(--muted)">Agents</p>
      <div className="relative pb-1.5">
        {pill && (
          <span aria-hidden className="mention-pill absolute left-1.5 right-1.5 rounded-xl"
            style={{ transform: `translateY(${pill.y}px)`, height: pill.h }} />
        )}
        {items.map((a, i) => (
          <button key={a.id} ref={(el) => { rows.current[i] = el; }} type="button" role="option" aria-selected={i === active}
            onMouseDown={(e) => { e.preventDefault(); onPick(a); }} onMouseEnter={() => onHover(i)}
            className="mention-item relative w-full flex items-center gap-3 px-3.5 py-2 text-left"
            style={{ animationDelay: `${Math.min(i, 5) * 28}ms` }}>
            <AgentAvatar name={a.name} avatar={a.avatar} color={a.color}
              className={clsx('w-8 h-8 text-xs transition-transform duration-200', i === active && 'scale-110')} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium" style={{ color: a.color }}><Highlight name={a.name} q={last.current.q} /></span>
              <span className="block text-xs text-(--muted) truncate">{a.description}</span>
            </span>
            <kbd className={clsx('hidden md:inline text-[11px] text-(--muted) border border-(--border) rounded px-1.5 py-0.5 transition-opacity duration-150', i === active ? 'opacity-100' : 'opacity-0')}>Enter</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}
