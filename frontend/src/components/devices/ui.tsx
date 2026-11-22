'use client';

/**
 * Shared UI for the device pages (NinjaOne-style): data table with sorting, column picker, CSV export,
 * paging and search; sparkline; dropdown menu with submenus; modal; relative dates; loader hook.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import { ghost } from './shared';

// ── Dates ────────────────────────────────────────────────────

const TZ = 'Europe/Amsterdam';
const DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

/** "vandaag om 11:20", "gisteren om 09:02", "afgelopen maandag om 14:00", else "3 nov 2026 14:00". */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso);
  const time = t.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const dayKey = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: TZ });
  const now = new Date();
  const diffDays = Math.round((new Date(dayKey(now)).getTime() - new Date(dayKey(t)).getTime()) / 86400e3);
  if (diffDays === 0) return `vandaag om ${time}`;
  if (diffDays === 1) return `gisteren om ${time}`;
  if (diffDays === -1) return `morgen om ${time}`;
  if (diffDays > 1 && diffDays < 7) return `afgelopen ${DAYS[t.getDay()]} om ${time}`;
  return `${t.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ })} ${time}`;
}
export const tzLabel = 'Europe/Amsterdam';
export const fmtBytes = (n: number | null | undefined) => {
  if (n == null || Number.isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};
export const fmtRate = (bytesPerSec: number) => `${fmtBytes(bytesPerSec * 8).replace('B', 'b')}/s`;

// ── Loader ───────────────────────────────────────────────────

/** Loads on mount and when deps change; at = time of the last successful load. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const enabled = opts.enabled ?? true;
  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setData(await fn()); setAt(Date.now()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { if (enabled) void load(); }, [load, enabled]);
  return { data, setData, err, busy, load, at };
}

/** "Vernieuwd zojuist" + Vernieuwen button; re-renders every 30 s so the age stays current. */
export function Refreshed({ at, busy, onRefresh }: { at: number | null; busy?: boolean; onRefresh?: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  const s = at ? Math.round((Date.now() - at) / 1000) : null;
  const age = s == null ? '' : s < 60 ? '< 1 min geleden' : s < 3600 ? `${Math.round(s / 60)} min geleden` : `${Math.round(s / 3600)} uur geleden`;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-(--muted)">
      {busy ? 'Vernieuwen…' : age ? `Vernieuwd ${age}` : ''}
      {onRefresh && <button className="text-(--accent) hover:underline disabled:opacity-50" disabled={busy} onClick={onRefresh}>Vernieuwen</button>}
    </span>
  );
}

// ── Layout bits ──────────────────────────────────────────────

export function Card({ title, right, children, className }: { title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-card border border-(--border) bg-(--input) p-4 space-y-3 min-w-0', className)}>
      {(title || right) && (
        <div className="flex flex-wrap items-center gap-2">
          {title && <h3 className="text-sm font-medium text-(--text) basis-full sm:basis-0 sm:flex-1 min-w-0">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** Two-column key/value grid; empty values are skipped. */
export function KV({ rows, cols = 1 }: { rows: Array<[string, React.ReactNode]>; cols?: 1 | 2 }) {
  return (
    <div className={clsx('grid gap-x-4 gap-y-1 text-xs', cols === 2 ? 'grid-cols-[auto_1fr] md:grid-cols-[auto_1fr_auto_1fr]' : 'grid-cols-[auto_1fr]')}>
      {rows.filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => (
        <div key={k} className="contents"><span className="text-(--muted)">{k}</span><span className="text-(--text) min-w-0 break-words">{v}</span></div>
      ))}
    </div>
  );
}

/** Vertical sub navigation (Details, Tools); horizontal on small screens. */
export function SubNav<T extends string>({ items, value, onChange }: { items: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  return (
    <nav className="flex md:flex-col gap-1 overflow-x-auto md:w-48 shrink-0">
      {items.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          className={clsx('text-left text-sm px-3 py-1.5 rounded-lg whitespace-nowrap', value === k ? 'bg-(--accent)/15 text-(--text) font-medium' : 'text-(--muted) hover:text-(--text) hover:bg-(--border)/40')}>
          {l}
        </button>
      ))}
    </nav>
  );
}

export function Chips<T extends string>({ items, value, onChange }: { items: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto max-w-full [scrollbar-width:none]">
      {items.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          className={clsx('shrink-0 whitespace-nowrap text-xs px-3 py-1.5 rounded-full border', value === k ? 'bg-(--accent-strong) border-(--accent) text-white' : 'border-(--border) text-(--muted) hover:text-(--text)')}>{l}</button>
      ))}
    </div>
  );
}

export const inputCls = 'bg-(--input) border border-(--border) rounded-lg px-3 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent)';

export const Pulse = ({ text = 'Bezig…' }: { text?: string }) => (
  <span className="text-xs text-(--muted) inline-flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" />{text}</span>
);

export const ErrorText = ({ err }: { err?: string | null }) => (err ? <p className="text-xs text-red-400 whitespace-pre-wrap break-words">{err}</p> : null);

export function OutputBox({ text, bad }: { text: string; bad?: boolean }) {
  return (
    <pre className={clsx('text-xs whitespace-pre-wrap break-words rounded-lg border p-3 max-h-80 overflow-auto font-mono',
      bad ? 'bg-red-500/5 border-red-500/30 text-red-400' : 'bg-(--bg) border-(--border) text-(--text)')}>{text}</pre>
  );
}

// ── Sparkline ────────────────────────────────────────────────

/** Small line chart, values 0..max (default 100). Optional second series (dashed). */
export function Sparkline({ values, values2, max, height = 36, className }: { values: number[]; values2?: number[]; max?: number; height?: number; className?: string }) {
  const w = 120;
  const top = max ?? Math.max(1, ...values, ...(values2 ?? []));
  const path = (v: number[]) => (v.length < 2 ? '' : v.map((x, i) => `${i === 0 ? 'M' : 'L'}${((i / (v.length - 1)) * w).toFixed(1)},${(height - 2 - (Math.min(x, top) / top) * (height - 4)).toFixed(1)}`).join(' '));
  const p1 = path(values);
  if (values.length < 2) {
    return (
      <div className={clsx('w-full flex items-center justify-center', className)} style={{ height }} aria-label="Meten">
        <span className="typing-dots"><i /><i /><i /></span>
      </div>
    );
  }
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={clsx('w-full', className)} style={{ height }}>
      {p1 && <path d={`${p1} L${w},${height} L0,${height} Z`} fill="currentColor" className="text-(--accent)" opacity={0.12} />}
      {p1 && <path d={p1} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-(--accent)" vectorEffect="non-scaling-stroke" />}
      {values2 && values2.length > 1 && <path d={path(values2)} fill="none" stroke="currentColor" strokeWidth={1.25} strokeDasharray="3 2" className="text-(--muted)" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

// ── Menu with submenus ───────────────────────────────────────

export interface MenuItem { label: string; detail?: string; onClick?: () => void; items?: MenuItem[]; disabled?: boolean; danger?: boolean }

export function Menu({ label, items, disabled, align = 'left', buttonClass, caret = true, title }: { label: React.ReactNode; items: MenuItem[]; disabled?: boolean; align?: 'left' | 'right'; buttonClass?: string; caret?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [sub, setSub] = useState<number | null>(null);
  const [subSide, setSubSide] = useState<'left' | 'right'>(align === 'right' ? 'left' : 'right');
  const subEl = useRef<HTMLDivElement>(null);
  // Submenu opens on the side with room: preferred side first, otherwise the other one.
  const openSub = (i: number | null, el?: HTMLElement | null) => {
    if (i !== null && el) {
      const r = el.getBoundingClientRect(); const need = 240;
      const right = window.innerWidth - r.right - 8, left = r.left - 8;
      const pref = align === 'right' ? 'left' : 'right';
      const fits = (side: 'left' | 'right') => (side === 'right' ? right : left) >= need;
      setSubSide(fits(pref) ? pref : fits(pref === 'right' ? 'left' : 'right') ? (pref === 'right' ? 'left' : 'right') : (right >= left ? 'right' : 'left'));
    }
    setSub(i);
  };
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number; maxH: number; up?: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // After render: keep the list inside the viewport (its real width can exceed the estimate).
  useLayoutEffect(() => {
    const el = pop.current; if (!el || !pos) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) { el.style.right = '8px'; el.style.left = 'auto'; }
    else if (r.left < 8) { el.style.left = '8px'; el.style.right = 'auto'; }
  }, [pos]);
  // Submenu: shift up when it would run past the bottom of the screen.
  useLayoutEffect(() => {
    const el = subEl.current; if (!el || window.innerWidth < 640) return;
    el.style.top = ''; el.style.left = ''; el.style.right = ''; el.style.margin = '';
    let r = el.getBoundingClientRect();
    // No room on either side (narrow window): slide it over the menu, inside the viewport.
    if (r.left < 8 || r.right > window.innerWidth - 8) {
      const p = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
      if (p) {
        const L = Math.min(Math.max(8, r.left), window.innerWidth - 8 - r.width);
        el.style.margin = '0'; el.style.right = 'auto'; el.style.left = `${L - p.left}px`;
        el.style.top = '28px';
        r = el.getBoundingClientRect();
      }
    }
    const over = r.bottom - (window.innerHeight - 8);
    if (over > 0) el.style.top = `${(parseFloat(el.style.top) || -4) - over}px`;
  }, [sub, subSide]);
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null);
  // play the exit animation (140ms) before unmounting
  const close = useCallback(() => { setSub(null); setClosing(true); if (closeT.current) clearTimeout(closeT.current); closeT.current = setTimeout(() => { setOpen(false); setClosing(false); }, 140); }, []);
  useEffect(() => () => { if (closeT.current) clearTimeout(closeT.current); }, []);
  // The list is portalled to <body> with fixed coordinates: cards in this theme carry backdrop-filter,
  // which makes each one its own stacking context, so an absolute dropdown would slide under the next card.
  const place = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 240 && above > below;
    const horiz = align === 'right'
      ? { right: Math.min(Math.max(8, window.innerWidth - r.right), Math.max(8, window.innerWidth - 232)) }
      : { left: Math.max(8, Math.min(r.left, window.innerWidth - 232)) };
    setPos({ ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }), ...horiz, maxH: Math.max(160, (up ? above : below) - 4), up });
  }, [align]);
  useEffect(() => {
    if (!open || closing) return;
    place();
    const h = (e: MouseEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !pop.current?.contains(t)) close(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const s = (e: Event) => { if (!pop.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    window.addEventListener('resize', place); window.addEventListener('scroll', s, true);
    return () => {
      document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k);
      window.removeEventListener('resize', place); window.removeEventListener('scroll', s, true);
    };
  }, [open, closing, place, close]);
  const pick = (it: MenuItem) => { if (it.disabled || it.items) return; close(); it.onClick?.(); };
  return (
    <div ref={ref} className="relative">
      <button className={buttonClass ?? ghost} disabled={disabled} title={title} aria-label={title} onClick={() => (open && !closing ? close() : (closeT.current && clearTimeout(closeT.current), setClosing(false), setOpen(true)))}>
        <span className="inline-flex items-center gap-1.5">{label}{caret && <svg className="w-3 h-3 opacity-60" viewBox="0 0 12 12" fill="currentColor"><path d="M2 4l4 4 4-4z" /></svg>}</span>
      </button>
      {open && pos && createPortal(
        <div ref={pop} data-state={closing ? 'closed' : 'open'} data-up={pos.up ? 'true' : undefined}
          className="glass-menu glass-menu-anim fixed z-[90] min-w-56 max-w-[calc(100vw-16px)] rounded-xl p-1 text-sm"
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right, transformOrigin: `${align === 'right' ? 'right' : 'left'} ${pos.up ? 'bottom' : 'top'}` }}>
          {items.map((it, i) => (
            <div key={it.label} className="relative" onMouseEnter={(e) => openSub(it.items ? i : null, e.currentTarget)}>
              <button disabled={it.disabled} onClick={(e) => (it.items ? openSub(sub === i ? null : i, e.currentTarget) : pick(it))}
                data-active={it.items && sub === i ? 'true' : undefined}
                className={clsx('glass-menu-item w-full text-left px-3 py-2 flex items-center gap-2 disabled:opacity-40', it.danger ? 'text-red-400' : 'text-(--text)')}>
                <span className="flex-1 min-w-0"><span className="block">{it.label}</span>{it.detail && <span className="block text-xs text-(--muted)">{it.detail}</span>}</span>
                {it.items && <svg className={clsx('w-3 h-3 opacity-60 transition-transform duration-150', sub === i && 'max-sm:rotate-90')} viewBox="0 0 12 12" fill="currentColor"><path d="M4 2l4 4-4 4z" /></svg>}
              </button>
              {it.items && sub === i && (
                <div ref={subEl} className={clsx('glass-menu glass-sub-anim absolute z-10 -top-1 min-w-56 max-w-[min(20rem,calc(100vw-16px))] rounded-xl p-1 max-h-[70vh] overflow-y-auto max-sm:static max-sm:p-0 max-sm:pl-3',
                  subSide === 'left' ? 'right-full mr-1.5 origin-top-right' : 'left-full ml-1.5 origin-top-left')} style={{ ['--sub-from' as string]: subSide === 'left' ? '6px' : '-6px' } as React.CSSProperties}>
                  {it.items.map((s) => (
                    <button key={s.label} disabled={s.disabled} onClick={() => pick(s)}
                      className={clsx('glass-menu-item w-full text-left px-3 py-2 disabled:opacity-40', s.danger ? 'text-red-400' : 'text-(--text)')}>
                      <span className="block">{s.label}</span>{s.detail && <span className="block text-xs text-(--muted)">{s.detail}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>, document.body)}
    </div>
  );
}

/** Row action menu ("..."), opens on click. */
export function RowMenu({ items }: { items: MenuItem[] }) {
  return <Menu label={<span className="px-0.5">...</span>} items={items} align="right" buttonClass="text-xs px-2 py-1 rounded-md text-(--muted) hover:text-(--text) hover:bg-(--border)/50" />;
}

// ── Modal ────────────────────────────────────────────────────

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  // portalled: a backdrop-filter ancestor would otherwise become the containing block of "fixed"
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={clsx('w-full rounded-card border border-(--border) shadow-2xl flex flex-col max-h-[90vh]', wide ? 'max-w-3xl' : 'max-w-lg')} style={{ background: 'var(--g-bg-base, var(--input))' }}>
        <div className="flex items-center gap-2 px-5 py-3 border-b border-(--border)">
          <h2 className="text-base font-semibold text-(--text) flex-1">{title}</h2>
          <button className="text-(--muted) hover:text-(--text) text-lg leading-none px-1" onClick={onClose} aria-label="Sluiten">x</button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-3 text-sm">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-(--border) flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-(--muted)">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-(--muted)">{hint}</span>}
    </label>
  );
}

// ── Data table ───────────────────────────────────────────────

export interface Col<T> {
  key: string; label: string;
  /** value for sorting, search and CSV */
  value: (r: T) => string | number | null | undefined;
  render?: (r: T) => React.ReactNode;
  align?: 'right'; width?: string; hidden?: boolean;
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel (nl) friendly CSV: semicolons, BOM. */
export function exportCsv<T>(name: string, cols: Col<T>[], rows: T[]) {
  const lines = [cols.map((c) => csvCell(c.label)).join(';'), ...rows.map((r) => cols.map((c) => csvCell(c.value(r))).join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * Sortable table with search, column picker (kept per table in localStorage), CSV export, paging
 * ("1 - 25 van 216") and an optional row action column.
 */
export function DataTable<T>({ id, cols, rows, rowKey, actions, toolbar, pageSize = 25, search = true, empty = 'Geen gegevens.', onRowClick, initialSort, exportName, maxHeight }: {
  id: string; cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string; actions?: (r: T) => React.ReactNode; toolbar?: React.ReactNode;
  pageSize?: number; search?: boolean; empty?: string; onRowClick?: (r: T) => void; initialSort?: { key: string; dir: 1 | -1 }; exportName?: string; maxHeight?: string;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(initialSort ?? null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(pageSize);
  const storeKey = `dt-cols:${id}`;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(cols.filter((c) => c.hidden).map((c) => c.key)));
  useEffect(() => { try { const v = localStorage.getItem(storeKey); if (v) setHidden(new Set(JSON.parse(v) as string[])); } catch { /* ignore */ } }, [storeKey]);
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); try { localStorage.setItem(storeKey, JSON.stringify([...n])); } catch { /* ignore */ } return n; });
  const [picker, setPicker] = useState(false);
  const visible = cols.filter((c) => !hidden.has(c.key));

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = needle ? rows.filter((x) => cols.some((c) => String(c.value(x) ?? '').toLowerCase().includes(needle))) : rows;
    if (sort) {
      const c = cols.find((x) => x.key === sort.key);
      if (c) r = [...r].sort((a, b) => {
        const va = c.value(a); const vb = c.value(b);
        if (va == null || va === '') return 1;
        if (vb == null || vb === '') return -1;
        return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'nl', { numeric: true })) * sort.dir;
      });
    }
    return r;
  }, [rows, cols, q, sort]);
  useEffect(() => { setPage(0); }, [q, rows.length]);
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const cur = Math.min(page, pages - 1);
  const slice = filtered.slice(cur * size, cur * size + size);
  const grid = [...visible.map((c) => c.width ?? 'minmax(6rem,1fr)'), ...(actions ? ['auto'] : [])].join(' ');

  return (
    <div className="space-y-2 min-w-0">
      <div className="relative z-20 flex flex-wrap items-center gap-2">
        {search && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken" className={clsx(inputCls, 'w-full sm:w-56')} />}
        {toolbar}
        <div className="flex-1" />
        <div className="relative hidden md:block">
          <button className={ghost} onClick={() => setPicker((p) => !p)}>Kolommen</button>
          {picker && (
            <div className="glass-menu glass-menu-anim absolute right-0 z-40 mt-1 w-56 rounded-xl p-1.5 space-y-0.5 text-sm max-h-80 overflow-y-auto origin-top-right"
              onMouseLeave={() => setPicker(false)}>
              {cols.map((c) => (
                <label key={c.key} className="glass-menu-item flex items-center gap-2 px-2 py-1.5 cursor-pointer">
                  <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggle(c.key)} />{c.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <button className={ghost} disabled={!filtered.length} onClick={() => exportCsv(exportName ?? id, visible, filtered)}>Exporteren</button>
      </div>
      {/* phones: every row a small card (first column as title, the rest underneath) */}
      <div className="md:hidden space-y-2">
        {!slice.length && <p className="px-1 py-3 text-xs text-(--muted)">{q ? 'Niets gevonden.' : empty}</p>}
        {slice.map((r) => {
          const [head, ...rest] = visible;
          return (
            <div key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={clsx('rounded-xl border border-(--border) px-3 py-2.5 text-xs', onRowClick && 'cursor-pointer active:bg-(--border)/30')}
              style={{ background: 'color-mix(in srgb, var(--g-bg-base) 70%, transparent)' }}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0 text-sm font-medium text-(--text) break-words">{head ? (head.render ? head.render(r) : String(head.value(r) ?? '')) : null}</div>
                {actions && <div className="shrink-0" onClick={(e) => e.stopPropagation()}>{actions(r)}</div>}
              </div>
              {rest.length > 0 && (
                <div className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  {rest.map((c) => {
                    const v = c.render ? c.render(r) : String(c.value(r) ?? '');
                    if (v === '' || v === null || v === undefined) return null;
                    return [
                      <span key={c.key + ':l'} className="text-(--muted)">{c.label}</span>,
                      <span key={c.key + ':v'} className="min-w-0 truncate text-(--text)">{v}</span>,
                    ];
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="hidden md:block rounded-xl border border-(--border) bg-(--input) overflow-x-auto text-xs">
        <div className="min-w-max">
          <div className="grid gap-3 px-4 py-2 text-[11px] uppercase tracking-wide text-(--muted) border-b border-(--border)" style={{ gridTemplateColumns: grid }}>
            {visible.map((c) => (
              <button key={c.key} className={clsx('text-left uppercase tracking-wide hover:text-(--text) truncate', c.align === 'right' && 'text-right')}
                onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}>
                {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
              </button>
            ))}
            {actions && <span />}
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: maxHeight ?? '65vh' }}>
            {!slice.length && <p className="px-4 py-3 text-(--muted)">{q ? 'Niets gevonden.' : empty}</p>}
            {slice.map((r) => (
              <div key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={clsx('group grid gap-3 px-4 py-1.5 border-b border-(--border) last:border-0 items-center hover:bg-(--border)/30', onRowClick && 'cursor-pointer')}
                style={{ gridTemplateColumns: grid }}>
                {visible.map((c) => (
                  <span key={c.key} className={clsx('min-w-0 truncate', c.align === 'right' && 'text-right tabular-nums')} title={String(c.value(r) ?? '')}>
                    {c.render ? c.render(r) : String(c.value(r) ?? '')}
                  </span>
                ))}
                {actions && <span className="justify-self-end" onClick={(e) => e.stopPropagation()}>{actions(r)}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-(--muted)">
          <span>{cur * size + 1} - {Math.min(filtered.length, cur * size + size)} van {filtered.length}</span>
          <div className="flex-1" />
          <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} className="bg-(--input) border border-(--border) rounded-md px-1.5 py-1 text-(--text)">
            {[10, 25, 50, 100, 500].map((n) => <option key={n} value={n}>{n} per pagina</option>)}
          </select>
          <button className="px-2 py-1 rounded-md border border-(--border) disabled:opacity-40" disabled={cur === 0} onClick={() => setPage(cur - 1)}>Vorige</button>
          <span>{cur + 1} / {pages}</span>
          <button className="px-2 py-1 rounded-md border border-(--border) disabled:opacity-40" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Volgende</button>
        </div>
      )}
    </div>
  );
}

/** PowerShell single-quoted string. */
export const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** POSIX single-quoted string. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ── Icon buttons (NinjaOne-style) ────────────────────────────

export const iconBtn = 'inline-flex items-center justify-center w-9 h-9 rounded-lg border border-(--border) bg-(--bg) text-(--text) hover:bg-(--border) disabled:opacity-40 disabled:pointer-events-none transition-colors';
export const iconBtnPrimary = 'inline-flex items-center justify-center w-9 h-9 rounded-control bg-(--accent-strong) text-white hover:brightness-95 disabled:opacity-40 disabled:pointer-events-none';

const ICONS: Record<string, React.ReactNode> = {
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  play: <path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  note: <><path d="M5 4h10l4 4v12H5z" /><path d="M15 4v4h4M8 12h8M8 16h5" /></>,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  refresh: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  mouse: <><rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 7v4" /></>,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  keys: <><rect x="3" y="8" width="5" height="8" rx="1.5" /><rect x="10" y="8" width="5" height="8" rx="1.5" /><rect x="17" y="8" width="4" height="8" rx="1.5" /></>,
  touchpad: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 15h18M12 15v4" /></>,
  finger: <path d="M9 11V5a1.5 1.5 0 0 1 3 0v6M12 10V8.5a1.5 1.5 0 0 1 3 0V11M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 15.5a1.5 1.5 0 0 1 2.5-1.6L9 16" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  gauge: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-6" /></>,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  fullscreen: <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />,
  clipboard: <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4h6v3H9zM9 12h6M9 16h4" /></>,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5V14M12 17h.01" /></>,
};

export function Icon({ name, className = 'w-[18px] h-[18px]' }: { name: keyof typeof ICONS | string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name] ?? null}
    </svg>
  );
}
