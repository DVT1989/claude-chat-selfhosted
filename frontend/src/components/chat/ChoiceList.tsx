'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { Message } from '@/types';

/** Choice lists in answers: a ```keuze block becomes a card with checkboxes (modus: meer) or buttons (modus: een). */

export interface ChoiceItem { n: number; label: string; hint?: string; pre: boolean; group: string }
export interface ChoiceSpec { title: string; mode: 'meer' | 'een'; items: ChoiceItem[]; groups: string[] }

export function parseChoice(src: string): ChoiceSpec {
  let title = '';
  let mode: 'meer' | 'een' = 'meer';
  let group = '';
  const items: ChoiceItem[] = [];
  const groups: string[] = [];
  const seen = new Set<number>();
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^titel\s*:\s*(.+)$/i.exec(line);
    if (m) { title = m[1].trim(); continue; }
    m = /^modus\s*:\s*(\w+)/i.exec(line);
    if (m) { mode = /^(een|1|enkel)/i.test(m[1]) ? 'een' : 'meer'; continue; }
    m = /^##\s*(.+)$/.exec(line);
    if (m) { group = m[1].trim(); if (!groups.includes(group)) groups.push(group); continue; }
    m = /^(\d+)\s*(\*)?\s*\|\s*([^|]+?)\s*(?:\|\s*(.*))?$/.exec(line);
    if (m && items.length < 60) {
      const n = Number(m[1]);
      if (seen.has(n)) continue;
      seen.add(n);
      items.push({ n, label: m[3], hint: m[4]?.trim() || undefined, pre: !!m[2], group });
    }
  }
  return { title, mode, items, groups };
}

interface Ctx { messages: Message[] }
export const ChoiceCtx = createContext<Ctx | null>(null);
export const ChoiceMsgCtx = createContext<string | null>(null);
/** set by the streaming bubble: the text so far (an unclosed keuze block is still being written) */
export const ChoiceLiveCtx = createContext<string | null>(null);

export const CHOICE_EVENT = 'agent-continue';

type Locked = { kind: 'chosen'; nums: Set<number>; labels: string[] } | { kind: 'text' } | null;

function deriveLocked(spec: ChoiceSpec, msgId: string | null, messages: Message[] | undefined): Locked {
  if (!msgId || !messages) return null;
  const i = messages.findIndex((m) => m.id === msgId);
  if (i < 0) return null;
  for (let j = i + 1; j < messages.length; j++) {
    const m = messages[j];
    if (m.role !== 'user') continue;
    if (m.metadata?.auto) continue;
    const t = m.content;
    if (spec.mode === 'een') {
      const g = /^Gekozen: (.+)$/m.exec(t);
      if (g) {
        const it = spec.items.find((x) => x.label === g[1].trim());
        if (it) return { kind: 'chosen', nums: new Set([it.n]), labels: [it.label] };
      }
    } else {
      const head = /^(Gekozen bij|Niets gekozen bij) "(.*)"/.exec(t);
      if (head && head[2] === spec.title) {
        const nums = new Set<number>();
        if (head[1] === 'Gekozen bij') for (const l of t.split('\n')) { const k = /^(\d+)\./.exec(l); if (k) nums.add(Number(k[1])); }
        return { kind: 'chosen', nums, labels: [] };
      }
    }
    return { kind: 'text' };
  }
  return null;
}

export function buildChoiceMessage(spec: ChoiceSpec, nums: number[]): string {
  const total = spec.items.length;
  if (spec.mode === 'een') return `Gekozen: ${spec.items.find((x) => x.n === nums[0])?.label ?? ''}`;
  if (!nums.length) return `Niets gekozen bij "${spec.title}"`;
  const chosen = spec.items.filter((x) => nums.includes(x.n));
  const rest = spec.items.filter((x) => !nums.includes(x.n));
  let out = `Gekozen bij "${spec.title}" (${chosen.length} van ${total}):\n` + chosen.map((x) => `${x.n}. ${x.label}`).join('\n');
  if (rest.length) out += `\nNiet gekozen: ${rest.map((x) => x.n).join(', ')}`;
  return out;
}

function Tick() {
  return (
    <svg className="kz-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export default function ChoiceList({ src }: { src: string }) {
  const ctx = useContext(ChoiceCtx);
  const msgId = useContext(ChoiceMsgCtx);
  const live = useContext(ChoiceLiveCtx);
  const spec = useMemo(() => parseChoice(src), [src]);
  const [over, setOver] = useState<Record<number, boolean>>({});
  const [sent, setSent] = useState<Locked>(null);
  const [radio, setRadio] = useState<number | null>(null);

  // unclosed fence = still streaming (only the last block of the streaming text can be open)
  const open = live !== null && (live.match(/^\s*```/gm) ?? []).length % 2 === 1
    && live.slice(live.lastIndexOf('```keuze') + 8).trim() === src.trim();

  const derived = deriveLocked(spec, msgId, ctx?.messages);
  const locked: Locked = derived ?? sent;
  const inert = open || live !== null || !msgId; // not interactive without a saved message
  const single = spec.mode === 'een';
  const quick = single && spec.items.length <= 8;
  const checked = (it: ChoiceItem) => (over[it.n] ?? it.pre);
  const sel = quick ? [] : single ? (radio != null ? [radio] : spec.items.filter((x) => x.pre).map((x) => x.n)) : spec.items.filter(checked).map((x) => x.n);
  const total = spec.items.length;

  function send(nums: number[]) {
    if (inert || locked) return;
    setSent({ kind: 'chosen', nums: new Set(nums), labels: [] });
    window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: { text: buildChoiceMessage(spec, nums) } }));
  }

  if (!spec.items.length && !open) return <pre className="!mt-2 !mb-2"><code>{src}</code></pre>;

  const isLocked = !!locked;
  const lockedNums = locked?.kind === 'chosen' ? locked.nums : null;
  const on = (it: ChoiceItem) => (lockedNums ? lockedNums.has(it.n) : quick ? false : single ? sel.includes(it.n) : checked(it));
  const multiGroups = spec.groups.length > 1;
  const groupKeys = multiGroups ? spec.groups : [''];
  const noteText = locked?.kind === 'text' ? 'Beantwoord in tekst' : locked?.kind === 'chosen' ? `Verstuurd: ${lockedNums!.size} van ${total}` : '';
  const sentLabel = locked?.kind === 'chosen' && single ? spec.items.find((x) => lockedNums!.has(x.n))?.label : '';

  function setGroup(g: string, v: boolean) {
    setOver((o) => {
      const n = { ...o };
      for (const it of spec.items) if (!multiGroups || it.group === g) n[it.n] = v;
      return n;
    });
  }

  const row = (it: ChoiceItem) => {
    const chosen = on(it);
    const collapsed = isLocked && locked!.kind === 'chosen' && !chosen;
    const dim = locked?.kind === 'text';
    return (
      <div key={it.n} className={clsx('kz-rw', live !== null && 'kz-in', collapsed && 'kz-collapsed')} aria-hidden={collapsed || undefined}>
        <div className="kz-rw-in">
          {quick ? (
            <button type="button" role="radio" aria-checked={chosen} disabled={inert || isLocked}
              className={clsx('kz-quick', chosen && 'kz-on')}
              onClick={() => send([it.n])}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                const sibs = Array.from(e.currentTarget.closest('[role=radiogroup]')?.querySelectorAll<HTMLButtonElement>('button[role=radio]:not(:disabled)') ?? []);
                const k = sibs.indexOf(e.currentTarget);
                const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
                sibs[(k + d + sibs.length) % sibs.length]?.focus();
              }}>
              <span className="kz-radio" aria-hidden />
              <span className="kz-txt"><span className="kz-label kz-label-b">{it.label}</span>{it.hint && <span className="kz-hint">{it.hint}</span>}</span>
            </button>
          ) : (
            <label className={clsx('kz-row', chosen && 'kz-on', dim && 'kz-dim')}>
              <span className={clsx('kz-box', single && 'kz-round')}>
                <input type={single ? 'radio' : 'checkbox'} name={single ? `kz-${msgId}-${spec.title}` : undefined}
                  checked={dim ? false : chosen} disabled={inert || isLocked}
                  onChange={(e) => (single ? setRadio(it.n) : setOver((o) => ({ ...o, [it.n]: e.target.checked })))} />
                {!single && <Tick />}
              </span>
              <span className="kz-txt"><span className="kz-label">{it.label}</span>{it.hint && <span className="kz-hint">{it.hint}</span>}</span>
            </label>
          )}
        </div>
      </div>
    );
  };

  const list = groupKeys.map((g) => {
    const its = spec.items.filter((x) => !multiGroups || x.group === g);
    if (!its.length) return null;
    const cnt = its.filter((x) => on(x)).length;
    const hidden = isLocked && locked!.kind === 'chosen' && cnt === 0;
    return (
      <div key={g} role={multiGroups ? 'group' : undefined} aria-label={multiGroups ? g : undefined} className={clsx('kz-grp kz-rw', hidden && 'kz-collapsed')}>
        <div className="kz-rw-in">
          {multiGroups && (
            <div className="kz-gh">
              <span className="kz-gname">{g}</span>
              <span className="kz-gcount">{cnt} van {its.length}</span>
              {!isLocked && !single && !inert && (
                <button type="button" className="kz-link" onClick={() => setGroup(g, cnt < its.length)}>{cnt < its.length ? 'Alles' : 'Niets'}</button>
              )}
            </div>
          )}
          {its.map(row)}
        </div>
      </div>
    );
  });

  const showFoot = !quick && !isLocked;
  return (
    <div className={clsx('kz-card', isLocked && 'kz-locked')}
      onKeyDown={(e) => { if (showFoot && (e.metaKey || e.ctrlKey) && e.key === 'Enter' && sel.length) { e.preventDefault(); send(sel); } }}>
      <div className="kz-head">
        <span className="kz-title">{spec.title || 'Maak een keuze'}</span>
        {(noteText || sentLabel) && <span className="kz-note">{single ? `Gekozen: ${sentLabel}` : noteText}</span>}
        {!multiGroups && !single && !isLocked && !inert && spec.items.length > 1 && (
          <button type="button" className="kz-link" onClick={() => setGroup('', sel.length < total)}>{sel.length < total ? 'Alles' : 'Niets'}</button>
        )}
      </div>
      <div className="kz-list" role={quick ? 'radiogroup' : undefined} aria-label={quick ? spec.title : undefined}>
        {list}
        {open && <div className="kz-skel" aria-hidden />}
      </div>
      <div className={clsx('kz-footw', !showFoot && 'kz-collapsed')}>
        <div className="kz-rw-in">
          <div className="kz-foot">
            <span className="kz-count" role="status" aria-live="polite">{sel.length ? `${sel.length} van ${total} gekozen` : 'Niets gekozen'}</span>
            {!single && !sel.length && !inert && (
              <button type="button" className="kz-link kz-none" onClick={() => send([])}>Geen van deze</button>
            )}
            <button type="button" className="kz-send" disabled={inert || !sel.length} aria-disabled={inert || !sel.length} onClick={() => send(sel)}>Verstuur keuze</button>
          </div>
        </div>
      </div>
    </div>
  );
}
