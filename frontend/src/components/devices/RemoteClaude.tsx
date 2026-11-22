'use client';

/**
 * Claude in the remote desktop viewer: a chat panel that sends questions to a Claude Code run (which
 * looks at the screen and works with mouse and keyboard via /devices/claude/:id/screen and /act), and
 * Claude's own cursor as in AIO Dashboard: fades in at the centre, glides in a soft curve to targets,
 * click ring, spinning ring while it works without the mouse, back to the centre and fade out when done.
 */
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import clsx from 'clsx';
import { conversations as convApi } from '@/lib/api';
import { Device } from './shared';
import ClaudeLogo, { CLAUDE_SPARK_PATH } from '../ClaudeLogo';
import { Icon } from './ui';

export const CLAUDE = '#D97757';
const OUT = 'cubic-bezier(.23,1,.32,1)', INOUT = 'cubic-bezier(.77,0,.175,1)';

export interface ClaudeCursor { start(): void; move(x: number, y: number): number; click(): void; work(): void; end(): void; setLabel(on: boolean): void }

/** Claude's cursor inside `host` (pixel coordinates of host). Transform/opacity only (WAAPI). */
export function createClaudeCursor(host: HTMLElement): ClaudeCursor & { destroy(): void } {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const c = document.createElement('div');
  c.style.cssText = 'position:absolute;left:0;top:0;z-index:8;pointer-events:none;opacity:0;will-change:transform,opacity';
  c.innerHTML = '<b style="position:absolute;left:-3px;top:-2px;width:24px;height:24px;transform-origin:4px 3px"><svg width="24" height="24" viewBox="0 0 24 24" style="overflow:visible;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))"><path d="M3.5 2.2 19.6 11.1c.8.4.7 1.6-.2 1.8l-6.4 1.6-3 5.9c-.4.8-1.6.7-1.8-.2L2.2 3.6c-.2-.9.6-1.7 1.3-1.4Z" fill="' + CLAUDE + '" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></b>'
    + '<i style="position:absolute;left:-14px;top:-14px;width:28px;height:28px;opacity:0;transform:scale(.5);filter:drop-shadow(0 1px 2px rgba(0,0,0,.45)) drop-shadow(0 0 6px rgba(0,0,0,.18))"><svg width="28" height="28" viewBox="0 0 28 28" style="display:block"><circle cx="14" cy="14" r="11" fill="none" stroke="rgba(255,255,255,.9)" stroke-opacity=".28" stroke-width="3.5"/><circle cx="14" cy="14" r="11" fill="none" stroke="' + CLAUDE + '" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="22 47.1"/></svg></i>'
    + '<span style="position:absolute;left:18px;top:20px;width:max-content;display:inline-flex;flex-wrap:nowrap;align-items:center;gap:5px;padding:2px 8px 2px 6px;border-radius:999px;background:#B35536;color:#fff;font:600 11px/16px system-ui,Segoe UI,sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)"><svg width="11" height="11" viewBox="0 0 248 248" fill="#fff" aria-hidden="true" style="flex:none;display:block"><path d="' + CLAUDE_SPARK_PATH + '"/></svg>Claude</span>';
  host.appendChild(c);
  const pijl = c.querySelector('b') as HTMLElement, ring = c.querySelector('i') as HTMLElement, label = c.querySelector('span') as HTMLElement;
  const mid = () => [Math.round(host.clientWidth / 2), Math.round(host.clientHeight / 2)];
  let [x, y] = mid();
  let anim: Animation | null = null, zicht = false, vorm: 'pijl' | 'ring' = 'pijl', draai: Animation | null = null;
  c.style.transform = `translate3d(${x}px,${y}px,0)`;
  const cur = () => { const m = new DOMMatrixReadOnly(getComputedStyle(c).transform); return [m.m41, m.m42]; };
  const fade = (on: boolean, ms: number) => {
    if (zicht === on) return 0;
    zicht = on;
    c.animate([{ opacity: on ? 0 : 1, transform: `${c.style.transform} scale(${on ? 0.85 : 1})` }, { opacity: on ? 1 : 0, transform: `${c.style.transform} scale(${on ? 1 : 0.85})` }], { duration: reduce ? 1 : ms, easing: OUT });
    c.style.opacity = on ? '1' : '0';
    return ms;
  };
  const zetVorm = (v: 'pijl' | 'ring') => {
    if (vorm === v) return 0;
    vorm = v;
    const r = v === 'ring', ms = reduce ? 1 : 220;
    pijl.animate([{ opacity: r ? 1 : 0, transform: `scale(${r ? 1 : 0.6})` }, { opacity: r ? 0 : 1, transform: `scale(${r ? 0.6 : 1})` }], { duration: ms, easing: OUT, fill: 'forwards' });
    ring.animate([{ opacity: r ? 0 : 1, transform: `scale(${r ? 0.5 : 1})` }, { opacity: r ? 1 : 0, transform: `scale(${r ? 1 : 0.5})` }], { duration: ms, easing: OUT, fill: 'forwards' });
    label.animate([{ transform: `translate(${r ? 0 : 2}px,${r ? 0 : -30}px)` }, { transform: `translate(${r ? 2 : 0}px,${r ? -30 : 0}px)` }], { duration: ms, easing: OUT, fill: 'forwards' });
    if (r) { draai?.cancel(); draai = (ring.firstChild as SVGElement).animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], { duration: reduce ? 2400 : 800, iterations: Infinity }); }
    else if (draai) { const d = draai; setTimeout(() => d.cancel(), ms); draai = null; }
    return ms;
  };
  const api = {
    start() {
      if (zicht) return;
      anim?.cancel(); anim = null;
      [x, y] = mid(); c.style.transform = `translate3d(${x}px,${y}px,0)`;
      zetVorm('pijl');
      fade(true, 300);
    },
    move(tx: number, ty: number) {
      const v0 = zetVorm('pijl');
      if (!zicht) api.start();
      const [fx, fy] = anim ? cur() : [x, y];
      anim?.cancel();
      const d = Math.hypot(tx - fx, ty - fy);
      const dur = reduce || d < 2 ? 0 : Math.round(Math.min(650, Math.max(260, 170 + d * 0.42)));
      x = tx; y = ty; c.style.transform = `translate3d(${tx}px,${ty}px,0)`;
      if (!dur) { anim = null; return v0; }
      // quadratic curve with a gentle sideways bend, sampled into keyframes; one easing over the whole path
      const bend = Math.min(60, d * 0.12), nx = -(ty - fy) / d, ny = (tx - fx) / d;
      const cx = (fx + tx) / 2 + nx * bend, cy = (fy + ty) / 2 + ny * bend;
      const k: Keyframe[] = [];
      for (let i = 0; i <= 14; i++) { const t = i / 14, u = 1 - t; k.push({ transform: `translate3d(${u * u * fx + 2 * u * t * cx + t * t * tx}px,${u * u * fy + 2 * u * t * cy + t * t * ty}px,0)` }); }
      anim = c.animate(k, { duration: dur, easing: INOUT });
      anim.onfinish = () => { anim = null; };
      return Math.max(dur, v0);
    },
    click() {
      if (reduce) return;
      pijl.animate([{ transform: 'scale(1)' }, { transform: 'scale(.82)' }, { transform: 'scale(1)' }], { duration: 220, easing: OUT });
      const r = document.createElement('div');
      r.style.cssText = `position:absolute;left:${x - 18}px;top:${y - 18}px;width:36px;height:36px;border-radius:50%;border:2px solid ${CLAUDE};background:${CLAUDE}22;pointer-events:none;z-index:7`;
      host.appendChild(r);
      r.animate([{ transform: 'scale(.35)', opacity: 0.9 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 480, easing: OUT }).onfinish = () => r.remove();
    },
    // working without the mouse (looking, typing, commands): to the centre, the arrow becomes a spinning ring
    work() {
      if (!zicht) api.start();
      const [mx, my] = mid();
      const t = api.move(mx, my);
      setTimeout(() => { if (x === mx && y === my) zetVorm('ring'); }, t);
    },
    end() {
      if (!zicht) return;
      const [mx, my] = mid();
      const t = api.move(mx, my);
      setTimeout(() => { zetVorm('pijl'); fade(false, 320); }, t + 120);
    },
    // phones: only the orange arrow, no name
    setLabel(on: boolean) { label.style.display = on ? 'inline-flex' : 'none'; },
    destroy() { c.remove(); },
  };
  return api;
}

type Item = { role: 'user' | 'claude' | 'error'; text: string };

const toolLabel = (name: string, input: unknown): string => {
  const s = JSON.stringify(input ?? '');
  if (s.includes('/screen')) return 'kijkt naar het scherm';
  if (s.includes('/act')) return s.includes('"type"') || s.includes('"key"') ? 'typt' : 'klikt';
  if (s.includes('/exec')) return 'voert een commando uit';
  if (name === 'Read') return s.includes('.jpg') ? 'bekijkt de schermafbeelding' : 'leest';
  return 'is bezig';
};

/** Chat with Claude about this device; the first question carries the remote-desktop context. */
export function ClaudePanel({ d, compact, open, onClose, onStreaming, onActivity }: {
  d: Device; compact: boolean; open: boolean; onClose: () => void; onStreaming: (on: boolean) => void; onActivity: (label: string) => void;
}) {
  const [conv, setConv] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [act, setAct] = useState('');
  const ac = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [items, act]);
  useEffect(() => { if (!compact && open) field.current?.focus(); }, [compact, open]);
  useEffect(() => () => ac.current?.abort(), []);

  const appendClaude = (t: string) => setItems((x) => {
    const last = x[x.length - 1];
    return last?.role === 'claude' ? [...x.slice(0, -1), { ...last, text: last.text + t }] : [...x, { role: 'claude', text: t }];
  });

  async function ask() {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    setItems((x) => [...x, { role: 'user', text: q }, { role: 'claude', text: '' }]);
    setBusy(true); onStreaming(true); setAct('denkt na');
    const ctrl = new AbortController(); ac.current = ctrl;
    try {
      let id = conv;
      const first = !id;
      if (!id) {
        // a device session: logged under this device's activities, not as a chat in the list
        const r = await convApi.create({ title: `${d.display_name || d.name}: ${q.slice(0, 50)}`, deviceId: d.id });
        id = r.conversation.id; setConv(id);
      }
      // the device instructions go to Claude separately: the chat only shows what you typed
      const context = first
        ? `Op apparaat "${d.name}" (id ${d.id}, Windows). Ik kijk mee in het extern bureaublad en zie jouw cursor live. Werk op het scherm zoals een mens: kijk met /devices/claude/${d.id}/screen en bedien met /act (muis en toetsenbord). Gebruik exec alleen als dat duidelijk sneller of betrouwbaarder is. Houd je antwoorden kort.`
        : undefined;
      const res = await fetch(`/api/conversations/${id}/stream`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: q, context }), signal: ctrl.signal });
      if (!res.ok || !res.body) { const j = await res.json().catch(() => ({})); throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let done = false;
      while (!done) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          let j: Record<string, unknown> = {};
          try { j = data ? JSON.parse(data) : {}; } catch { /* ignore */ }
          if (ev === 'text' && typeof j.text === 'string') { appendClaude(j.text); setAct(''); }
          else if (ev === 'tool_use') { const l = toolLabel(String(j.toolName ?? ''), j.toolInput); setAct(l); onActivity(l); }
          else if (ev === 'tool_result') appendClaude('');
          else if (ev === 'error') { setItems((x) => [...x, { role: 'error', text: String(j.message ?? 'Fout') }]); }
          else if (ev === 'done') { done = true; break; }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setItems((x) => [...x, { role: 'error', text: (e as Error).message }]);
    } finally {
      setBusy(false); onStreaming(false); setAct(''); ac.current = null;
      setItems((x) => (x[x.length - 1]?.role === 'claude' && !x[x.length - 1].text ? x.slice(0, -1) : x));
    }
  }

  async function stop() {
    ac.current?.abort();
    if (conv) await convApi.stop(conv).catch(() => undefined);
  }

  return (
    <div data-rd-toolbar className={clsx('flex flex-col min-h-0 text-sm text-(--text)',
      compact ? clsx('rd-sheet absolute inset-x-0 bottom-0 z-20 max-h-[60%] rounded-t-2xl border-t border-white/15 shadow-2xl', open && 'open') : 'pn w-[360px] border-l border-white/10')}
      style={{ background: 'var(--g-bg-base, #111)' }} aria-hidden={!open} inert={!open}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        {compact && <span className="absolute left-1/2 top-1 -ml-5 w-10 h-1 rounded-full bg-white/20" />}
        <ClaudeLogo className="w-[18px] h-[18px] shrink-0" />
        <span className="font-medium flex-1">Claude</span>
        <button className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-(--border) disabled:opacity-40" disabled={busy || !items.length}
          onClick={() => { setConv(null); setItems([]); }} title="Nieuw gesprek" aria-label="Nieuw gesprek"><Icon name="plus" className="w-4 h-4" /></button>
        <button className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-(--border)" onClick={onClose} title="Paneel sluiten" aria-label="Paneel sluiten"><Icon name="close" className="w-4 h-4" /></button>
      </div>
      <div ref={list} className={clsx('flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3', compact && 'min-h-[6rem]')}>
        {!items.length && (
          <p className="text-(--muted) text-xs leading-relaxed">
            Vraag Claude iets over {d.display_name || d.name}. Hij kijkt mee op het scherm en kan zelf klikken en typen; je ziet zijn oranje cursor. Bijvoorbeeld: &ldquo;Zet Bluetooth uit&rdquo; of &ldquo;Waarom staat de printer offline?&rdquo;
          </p>
        )}
        {items.map((it, i) => (
          it.role === 'user'
            ? <div key={i} className="ml-8 rounded-2xl rounded-br-md px-3 py-2 whitespace-pre-wrap break-words" style={{ background: 'color-mix(in srgb, var(--accent) 22%, var(--g-bg-base))' }}>{it.text}</div>
            : it.role === 'error'
              ? <p key={i} className="text-xs text-red-400">{it.text}</p>
              : it.text
                ? <div key={i} className="prose prose-sm prose-invert max-w-none break-words [&_p]:my-1.5 [&_ul]:my-1.5 [&_pre]:text-xs"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{it.text}</ReactMarkdown></div>
                : null
        ))}
        {busy && (
          <p className="flex items-center gap-2 text-xs text-(--muted)"><ClaudeLogo className="w-3.5 h-3.5 shrink-0 rd-spin6" />Claude {act || 'is bezig'}</p>
        )}
      </div>
      <div className="flex items-end gap-2 px-2 pt-2 border-t border-white/10" style={{ paddingBottom: compact ? 'max(8px, env(safe-area-inset-bottom))' : 8 }}>
        <textarea ref={field} value={input} onChange={(e) => setInput(e.target.value)} rows={1} placeholder="Vraag Claude…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }}
          className="flex-1 resize-none max-h-32 rounded-xl border border-(--border) bg-(--bg) px-3 py-2 text-base sm:text-sm outline-none focus:border-(--claude)" />
        {busy
          ? <button className="shrink-0 w-10 h-10 rounded-xl border border-(--border) inline-flex items-center justify-center hover:bg-(--border)" onClick={() => void stop()} title="Stoppen" aria-label="Stoppen"><span className="w-3 h-3 rounded-sm bg-current" /></button>
          : <button className="shrink-0 w-10 h-10 rounded-xl text-white inline-flex items-center justify-center disabled:opacity-40" style={{ background: CLAUDE }} disabled={!input.trim()} onClick={() => void ask()} title="Versturen" aria-label="Versturen">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </button>}
      </div>
    </div>
  );
}
