'use client';

/**
 * Meekijken / Overnemen: full-screen viewer for a remote session. The backend relays frames from the
 * agent as a binary HTTP stream (u32 length + message); each frame carries changed rectangles as JPEG.
 * Input (mouse, keyboard, typed text) goes back in small batches.
 * Touch: touchpad mode (finger moves a cursor, tap = click, long press = right click, double tap and
 * drag = drag) or direct mode (tap where you want to click); two fingers scroll, pinch zooms.
 * Phone keyboard: a hidden textarea catches typed text; a key bar adds Esc, Tab, modifiers, arrows, F-keys.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Device, ghost, primary, scopeHeaders } from './shared';
import { Icon, Menu, MenuItem } from './ui';
import { ClaudePanel, createClaudeCursor, ClaudeCursor } from './RemoteClaude';
import { useAuthStore } from '@/lib/store';
import ClaudeLogo from '../ClaudeLogo';

type Phase = 'starting' | 'live' | 'ended' | 'error';
type Ev = { t: 'm' | 'd' | 'u' | 'w' | 'k' | 'text'; x?: number; y?: number; b?: number; dx?: number; dy?: number; c?: string; down?: boolean; s?: string };

const QUALITY: Record<string, { label: string; quality: number; scale: 1 | 2 }> = {
  low: { label: 'Snel', quality: 35, scale: 2 },
  normal: { label: 'Normaal', quality: 55, scale: 1 },
  high: { label: 'Scherp', quality: 80, scale: 1 },
};

/** Growing byte buffer for the length-prefixed stream. */
class ByteQueue {
  private buf = new Uint8Array(1 << 20);
  private start = 0;
  private end = 0;
  push(chunk: Uint8Array) {
    if (this.end + chunk.length > this.buf.length) {
      const live = this.end - this.start;
      if (live + chunk.length <= this.buf.length) this.buf.copyWithin(0, this.start, this.end);
      else {
        const next = new Uint8Array(Math.max(this.buf.length * 2, (live + chunk.length) * 2));
        next.set(this.buf.subarray(this.start, this.end));
        this.buf = next;
      }
      this.start = 0; this.end = live;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }
  next(): Uint8Array | null {
    if (this.end - this.start < 4) return null;
    const len = new DataView(this.buf.buffer, this.start, 4).getUint32(0, true);
    if (this.end - this.start < 4 + len) return null;
    const msg = this.buf.slice(this.start + 4, this.start + 4 + len);
    this.start += 4 + len;
    if (this.start === this.end) { this.start = 0; this.end = 0; }
    return msg;
  }
}

const base = (id: string) => `/api/devices/remote/${id}`;

type Mod = 'ctrl' | 'alt' | 'shift' | 'meta';
const MOD_CODE: Record<Mod, string> = { ctrl: 'ControlLeft', alt: 'AltLeft', shift: 'ShiftLeft', meta: 'MetaLeft' };
const KEY_CODE: Record<string, string> = {
  Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`])),
};
const BAR: Array<[string, string]> = [
  ['Esc', 'Escape'], ['Tab', 'Tab'], ['Enter', 'Enter'], ['Del', 'Delete'], ['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight'],
  ['Home', 'Home'], ['End', 'End'], ['PgUp', 'PageUp'], ['PgDn', 'PageDown'],
  ...Array.from({ length: 12 }, (_, i): [string, string] => [`F${i + 1}`, `F${i + 1}`]),
];
const SENTINEL = '  ';
const charCode = (ch: string): string | null => {
  if (/^[a-z]$/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
  if (ch === ' ') return 'Space';
  return null;
};
const HINT_KEY = 'cc:rd-touch-hint';
interface PwInfo { host: string | null; accounts: Array<{ id: string; username: string }>; offer: { host: string; username: string; kind: 'new' | 'update' } | null; choose: boolean }
type PwBanner = { kind: 'offer'; host: string; username: string; update: boolean } | { kind: 'choose'; host: string; accounts: PwInfo['accounts'] };

export function RemoteDesktop({ d, onClose }: { d: Device; onClose: () => void }) {
  const isMac = d.os === 'darwin';
  const isNas = d.os === 'nasbrowser';
  const [nas, setNas] = useState<{ tabs: Array<{ id: string; title: string; url: string; active: boolean }>; canBack: boolean; canForward: boolean; loading: boolean; pw?: PwInfo }>({ tabs: [], canBack: false, canForward: false, loading: false });
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const pwLast = useRef<PwBanner | null>(null);
  // a Windows/Linux keyboard on a Mac: Ctrl+C/V/... must arrive as Cmd+C/V/..., the Win key is Cmd too
  const ctrlIsCmd = isMac && !(typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform));
  const physCode = (c: string) => (ctrlIsCmd && (c === 'ControlLeft' || c === 'ControlRight') ? 'MetaLeft' : c);
  const [phase, setPhase] = useState<Phase>('starting');
  const [msg, setMsg] = useState('Verbinden…');
  const [control, setControl] = useState(true);
  const [oneToOne, setOneToOne] = useState(false);
  const [quality, setQuality] = useState<keyof typeof QUALITY>('normal');
  const [stats, setStats] = useState({ fps: 0, kbps: 0 });
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [touch, setTouch] = useState(false);
  const [touchMode, setTouchMode] = useState<'touchpad' | 'direct'>('touchpad');
  const [zoomed, setZoomed] = useState(false);
  const [kbd, setKbd] = useState(false);
  const [keysBar, setKeysBar] = useState(false);
  const [mods, setMods] = useState<Mod[]>([]);
  const [hint, setHint] = useState(false);
  const [compact, setCompact] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const [editing, setEditing] = useState(false);
  const lastTapAt = useRef(0);
  // the link to the PC dropped for a moment (server says stalled / live)
  const [stalled, setStalled] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // like on the PC itself: your name next to the cursor while you work (blue), Claude's when Claude works
  const myName = (useAuthStore((s) => s.user?.name) ?? '').trim().split(/\s+/)[0] || 'Jij';
  // desktop: your own pointer drawn by the app (blue arrow + your name), right under the mouse, no lag
  const localCur = useRef<HTMLDivElement>(null);
  const localPill = useRef<HTMLSpanElement>(null);
  const localHover = useRef(false);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // phones: the PC cursor turns blue while you work it
  const remoteArrow = useRef<SVGPathElement>(null);
  const blueTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [claudeRun, setClaudeRun] = useState(false);
  const [claudeRecent, setClaudeRecent] = useState(false);
  const [claudeEver, setClaudeEver] = useState(true);
  useEffect(() => { if (claudeOpen) setClaudeEver(true); }, [claudeOpen]);
  const claudeLayer = useRef<HTMLDivElement>(null);
  const ccur = useRef<ClaudeCursor | null>(null);
  const claudeBusy = useRef(false);
  const claudeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const claudeRunRef = useRef(false);
  claudeRunRef.current = claudeRun;
  const autoKbd = useRef(false);
  const editingRef = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const kbdInput = useRef<HTMLTextAreaElement>(null);
  const sid = useRef<string | null>(null);
  const queue = useRef<Ev[]>([]);
  const textKeys = useRef<Set<string>>(new Set());
  const pressed = useRef<Set<string>>(new Set());
  const counters = useRef({ frames: 0, bytes: 0 });
  const scaleRef = useRef(1);
  const dims = useRef({ W: 16, H: 9 });
  const view = useRef({ z: 1, x: 0, y: 0, base: 1, vw: 1, vh: 1 });
  const remoteCur = useRef({ x: 32768, y: 32768 });
  const localCurAt = useRef(0);
  const controlRef = useRef(control);
  controlRef.current = control;
  const modeRef = useRef(touchMode);
  modeRef.current = touchMode;
  const modsRef = useRef(mods);
  modsRef.current = mods;

  const post = useCallback((body: Record<string, unknown>) => {
    if (!sid.current) return Promise.resolve();
    return fetch(`${base(d.id)}/s/${sid.current}/input`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(() => undefined).catch(() => undefined);
  }, [d.id]);

  // ── View: fit, zoom and pan (refs + direct style writes, no re-render per touch move) ──
  const showCursor = (nx: number, ny: number) => {
    const c = cursor.current;
    if (!c) return;
    c.style.display = 'block';
    c.style.left = `${(nx / 65535) * 100}%`;
    c.style.top = `${(ny / 65535) * 100}%`;
  };
  const apply = useCallback(() => {
    const v = view.current, st = stage.current;
    if (!st) return;
    const { W, H } = dims.current;
    const sw = W * v.base * v.z, sh = H * v.base * v.z;
    v.x = sw <= v.vw ? (v.vw - sw) / 2 : Math.min(0, Math.max(v.vw - sw, v.x));
    v.y = sh <= v.vh ? (v.vh - sh) / 2 : Math.min(0, Math.max(v.vh - sh, v.y));
    st.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    viewport.current?.style.setProperty('--rd-img-bottom', `${v.y + sh}px`);
    if (cursor.current) cursor.current.style.transform = `translate(-1px, -1px) scale(${1 / v.z})`;
  }, []);
  const layout = useCallback(() => {
    const vp = viewport.current, st = stage.current;
    if (!vp || !st) return;
    const v = view.current;
    const { W, H } = dims.current;
    v.vw = vp.clientWidth || 1; v.vh = vp.clientHeight || 1;
    v.base = Math.min(v.vw / W, v.vh / H);
    st.style.width = `${W * v.base}px`;
    st.style.height = `${H * v.base}px`;
    apply();
  }, [apply]);
  const maxZoom = () => Math.max(4, 2 / view.current.base);
  const zoomAt = useCallback((z2: number, fx: number, fy: number) => {
    const v = view.current;
    z2 = Math.min(Math.max(4, 2 / v.base), Math.max(1, z2));
    v.x = fx - (fx - v.x) * (z2 / v.z);
    v.y = fy - (fy - v.y) * (z2 / v.z);
    v.z = z2;
    apply();
    setZoomed(z2 > 1.01);
  }, [apply]);
  const resetZoom = () => { view.current.z = 1; apply(); setZoomed(false); setOneToOne(false); };

  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const ro = new ResizeObserver(() => layout());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [layout]);

  // phone keyboard: keep the viewer above it (iOS shrinks only the visual viewport)
  useEffect(() => {
    const vv = window.visualViewport;
    const el = root.current;
    if (!vv || !el) return;
    const fitVV = () => { el.style.height = `${vv.height}px`; el.style.top = `${vv.offsetTop}px`; };
    fitVV();
    vv.addEventListener('resize', fitVV);
    vv.addEventListener('scroll', fitVV);
    return () => { vv.removeEventListener('resize', fitVV); vv.removeEventListener('scroll', fitVV); };
  }, []);

  useEffect(() => {
    const coarse = window.matchMedia('(pointer: coarse)');
    const narrow = window.matchMedia('(max-width: 639px)');
    const por = window.matchMedia('(orientation: portrait)');
    const upd = () => { setCompact(coarse.matches || narrow.matches); setPortrait(por.matches); };
    upd();
    [coarse, narrow, por].forEach((m) => m.addEventListener('change', upd));
    return () => [coarse, narrow, por].forEach((m) => m.removeEventListener('change', upd));
  }, []);

  useEffect(() => {
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      setTouch(true);
      if (!localStorage.getItem(HINT_KEY)) setHint(true);
    }
  }, []);

  // A text field got focus on the device right after a tap: open the phone keyboard (and close it again
  // when focus leaves the field, if we opened it). Android allows this within the tap's user activation.
  const onEditing = useRef<(v: boolean) => void>(() => undefined);
  onEditing.current = (v: boolean) => {
    setEditing(v);
    const el = kbdInput.current;
    if (!el || !touch || !controlRef.current) return;
    if (v && Date.now() - lastTapAt.current < 3000 && document.activeElement !== el) { autoKbd.current = true; el.focus({ preventScroll: true }); }
    if (!v && autoKbd.current && document.activeElement === el) { autoKbd.current = false; el.blur(); }
  };

  useEffect(() => {
    const host = claudeLayer.current;
    if (!host) return;
    const c = createClaudeCursor(host);
    c.setLabel(!window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(max-width: 639px)').matches);
    ccur.current = c;
    return () => { c.destroy(); ccur.current = null; };
  }, []);

  // Claude acts on the device (announced by the backend before it happens): move its cursor, light the edge.
  const claudeQuiet = useCallback(() => {
    clearTimeout(claudeTimer.current);
    claudeTimer.current = setTimeout(() => {
      if (claudeRunRef.current) return;
      claudeBusy.current = false; setClaudeRecent(false); ccur.current?.end();
    }, 4000);
  }, []);
  const onClaude = useRef<(e: { t: string; x?: number; y?: number }) => void>(() => undefined);
  onClaude.current = (e) => {
    claudeBusy.current = true; setClaudeRecent(true);
    if (cursor.current) cursor.current.style.display = 'none';
    const c = ccur.current;
    if (c) {
      if ((e.t === 'move' || e.t === 'click') && e.x !== undefined && e.y !== undefined) {
        const v = view.current, { W, H } = dims.current;
        const px = v.x + (e.x / 65535) * W * v.base * v.z, py = v.y + (e.y / 65535) * H * v.base * v.z;
        if (e.t === 'move') c.move(px, py); else c.click();
      } else c.work();
    }
    claudeQuiet();
  };
  useEffect(() => {
    if (claudeRun) { claudeBusy.current = true; ccur.current?.start(); clearTimeout(claudeTimer.current); }
    else claudeQuiet();
  }, [claudeRun, claudeQuiet]);

  // ── Session + stream ────────────────────────────────────────
  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    const q = QUALITY.normal;
    // Phones drop the connection when the app goes to the background ("Load failed"): reconnect by
    // itself, to the same session or, when that ended meanwhile, to a fresh one.
    const visible = () => document.visibilityState === 'visible';
    const pause = (ms: number) => new Promise<void>((res) => {
      const done = () => { clearTimeout(t); document.removeEventListener('visibilitychange', onVis); res(); };
      const onVis = () => { if (visible()) done(); };
      const t = setTimeout(() => { if (visible()) done(); }, ms);
      document.addEventListener('visibilitychange', onVis);
    });
    (async () => {
      let attempt = 0;
      while (alive) {
        let endReason = '';
        try {
          if (!sid.current) {
            const r = await fetch(`${base(d.id)}/start`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...scopeHeaders() }, body: JSON.stringify({ quality: q.quality, scale: q.scale }), signal: ac.signal });
            const j = await r.json().catch(() => ({}));
            // the server refused (offline, too old, not allowed): show it, no retry loop
            if (!r.ok) { if (alive) { setPhase('error'); setMsg((j as { error?: string }).error ?? `HTTP ${r.status}`); } return; }
            sid.current = (j as { sid: string }).sid;
            setMsg('Wachten op beeld…');
          }
          const s = await fetch(`${base(d.id)}/s/${sid.current}/stream`, { credentials: 'include', cache: 'no-store', signal: ac.signal });
          // the session ended while we were away: start a new one
          if (s.status === 404) { sid.current = null; continue; }
          if (!s.ok || !s.body) throw new Error(`Stream: HTTP ${s.status}`);
          const reader = s.body.getReader();
          const bq = new ByteQueue();
          for (;;) {
            const { value, done } = await reader.read();
            if (done || !alive) break;
            bq.push(value);
            for (let m = bq.next(); m; m = bq.next()) {
              if (!m.length) continue; // keep-alive
              if (m[0] === 123) {
                const st = JSON.parse(new TextDecoder().decode(m)) as { status: string; reason?: string };
                if (st.status === 'ended') endReason = st.reason ?? 'beëindigd';
                if (st.status === 'stalled') setStalled(true);
                if (st.status === 'live') setStalled(false);
                if (st.status === 'tabs') setNas(st as unknown as typeof nas);
                if (st.status === 'cursor' && canvas.current) canvas.current.style.cursor = /^[a-z-]+$/.test(String((st as { c?: string }).c)) ? String((st as { c?: string }).c) : 'default';
                if (st.status === 'claude') onClaude.current(st as unknown as { t: string; x?: number; y?: number });
                continue;
              }
              attempt = 0;
              await drawFrame(m);
            }
          }
          // ended on purpose by the server (stopped, pc shut down): show why and stop
          if (endReason) { if (alive) { setPhase('ended'); setMsg(`Sessie beëindigd: ${endReason}`); } return; }
        } catch (e) {
          if (!alive || (e as Error).name === 'AbortError') return;
        }
        if (!alive) return;
        // connection dropped: keep the last picture, say we are reconnecting, try again when visible
        attempt++;
        setStalled(false);
        setPhase((p) => (p === 'live' ? 'live' : 'starting'));
        setReconnecting(true);
        await pause(Math.min(800 * attempt, 5000));
        setReconnecting(false);
      }
    })();

    async function drawFrame(m: Uint8Array) {
      const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
      const w = dv.getUint16(2, true), h = dv.getUint16(4, true), scale = dv.getUint16(6, true);
      const cx = dv.getInt32(8, true), cy = dv.getInt32(12, true), n = dv.getUint16(16, true);
      const cv = canvas.current;
      if (!cv) return;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; dims.current = { W: w, H: h }; setSize({ w, h }); layout(); }
      scaleRef.current = scale;
      let off = 18;
      const rects: Array<{ x: number; y: number; blob: Blob }> = [];
      for (let i = 0; i < n; i++) {
        const x = dv.getUint16(off, true), y = dv.getUint16(off + 2, true), len = dv.getUint32(off + 8, true);
        rects.push({ x, y, blob: new Blob([m.slice(off + 12, off + 12 + len) as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }) });
        off += 12 + len;
      }
      const bitmaps = await Promise.all(rects.map((r) => createImageBitmap(r.blob).catch(() => null)));
      const ctx = cv.getContext('2d');
      bitmaps.forEach((b, i) => { if (b && ctx) { ctx.drawImage(b, rects[i].x, rects[i].y); b.close(); } });
      const ed = (m[1] & 2) !== 0;
      if (ed !== editingRef.current) { editingRef.current = ed; onEditing.current(ed); }
      if (cx >= 0) remoteCur.current = { x: (cx / w) * 65535, y: (cy / h) * 65535 };
      // while the touchpad drives the cursor, our own position is shown (the remote one lags behind)
      if (claudeBusy.current || localHover.current) { if (cursor.current) cursor.current.style.display = 'none'; }
      else if (Date.now() - localCurAt.current > 1000) {
        if (cx < 0) { if (cursor.current) cursor.current.style.display = 'none'; }
        else showCursor(remoteCur.current.x, remoteCur.current.y);
      }
      counters.current.frames++; counters.current.bytes += m.length;
      setPhase((p) => (p === 'live' ? p : 'live'));
    }

    return () => {
      alive = false;
      ac.abort();
      if (sid.current) void fetch(`${base(d.id)}/s/${sid.current}`, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => undefined);
    };
  }, [d.id, layout]);

  // stats once a second
  useEffect(() => {
    const t = setInterval(() => {
      const c = counters.current;
      setStats({ fps: c.frames, kbps: Math.round(c.bytes / 1024) });
      c.frames = 0; c.bytes = 0;
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // input batches
  useEffect(() => {
    const t = setInterval(() => {
      if (!queue.current.length) return;
      const events = queue.current.splice(0, 500);
      void post({ events });
    }, 30);
    return () => clearInterval(t);
  }, [post]);

  /** You took over: Claude's cursor goes, your own cursor with your name shows (as on the PC). */
  const userActed = () => {
    if (claudeBusy.current) {
      claudeBusy.current = false;
      setClaudeRecent(false);
      clearTimeout(claudeTimer.current);
      ccur.current?.end();
    }
    const a = remoteArrow.current;
    if (a && !localHover.current) {
      a.setAttribute('fill', '#2563EB');
      clearTimeout(blueTimer.current);
      blueTimer.current = setTimeout(() => a.setAttribute('fill', 'white'), 3000);
    }
  };
  /** Desktop: move your own pointer (blue arrow); your name shows while you move and fades after 2.5 s. */
  const moveLocal = (e: React.PointerEvent) => {
    const el = localCur.current, vp = viewport.current;
    if (!el || !vp) return;
    if (!controlRef.current) { leaveLocal(); return; }
    const r = vp.getBoundingClientRect();
    el.style.display = 'block';
    el.style.transform = `translate3d(${e.clientX - r.left}px, ${e.clientY - r.top}px, 0)`;
    localHover.current = true;
    if (cursor.current) cursor.current.style.display = 'none';
    const p = localPill.current;
    if (p) {
      p.style.opacity = '1';
      clearTimeout(nameTimer.current);
      nameTimer.current = setTimeout(() => { p.style.opacity = '0'; }, 2500);
    }
  };
  const leaveLocal = () => {
    localHover.current = false;
    if (localCur.current) localCur.current.style.display = 'none';
  };
  const push = useCallback((ev: Ev) => {
    if (!controlRef.current || !sid.current) return;
    userActed();
    const q = queue.current;
    if (ev.t === 'm' && q.length && q[q.length - 1].t === 'm') q[q.length - 1] = ev; else q.push(ev);
  }, []);
  const click = useCallback((b: number, x: number, y: number) => {
    push({ t: 'm', x, y }); push({ t: 'd', b, x, y }); push({ t: 'u', b, x, y });
  }, [push]);

  const norm = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    const x = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 65535);
    const y = Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 65535);
    return { x, y };
  };

  // ── Keys ────────────────────────────────────────────────────
  const sendKey = useCallback((code: string, extra: Mod[] = []) => {
    const m = [...new Set([...modsRef.current, ...extra])];
    m.forEach((k) => push({ t: 'k', c: MOD_CODE[k], down: true }));
    push({ t: 'k', c: code, down: true });
    push({ t: 'k', c: code, down: false });
    m.reverse().forEach((k) => push({ t: 'k', c: MOD_CODE[k], down: false }));
    if (modsRef.current.length) { modsRef.current = []; setMods([]); }
  }, [push]);
  const sendText = useCallback((s: string) => {
    if (!s) return;
    if (modsRef.current.length && s.length === 1 && charCode(s)) { sendKey(charCode(s)!); return; }
    for (let i = 0; i < s.length; i += 2000) push({ t: 'text', s: s.slice(i, i + 2000) });
  }, [push, sendKey]);
  const toggleMod = (m: Mod) => setMods((x) => (x.includes(m) ? x.filter((y) => y !== m) : [...x, m]));

  // hidden textarea for the phone keyboard: diff against a sentinel, so autocorrect/IME input also works
  useEffect(() => {
    const el = kbdInput.current;
    if (!el) return;
    let composing = false;
    const reset = () => { el.value = SENTINEL; el.setSelectionRange(SENTINEL.length, SENTINEL.length); };
    const flush = () => {
      const v = el.value;
      if (v === SENTINEL) return;
      if (v.length < SENTINEL.length) { for (let i = 0; i < SENTINEL.length - v.length; i++) sendKey('Backspace'); }
      else if (v.startsWith(SENTINEL)) {
        const add = v.slice(SENTINEL.length);
        add.split(/(\n)/).forEach((part) => { if (part === '\n') sendKey('Enter'); else sendText(part); });
      }
      reset();
    };
    const onInput = () => { if (!composing) flush(); };
    const onCS = () => { composing = true; };
    const onCE = () => { composing = false; flush(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const hw: Mod[] = [];
      if (e.ctrlKey) hw.push(ctrlIsCmd ? 'meta' : 'ctrl');
      if (e.altKey) hw.push('alt');
      if (e.metaKey) hw.push('meta');
      const special = KEY_CODE[e.key];
      if (special) { e.preventDefault(); sendKey(special, e.shiftKey ? [...hw, 'shift'] : hw); return; }
      if (hw.length && e.code) { e.preventDefault(); sendKey(e.code, e.shiftKey ? [...hw, 'shift'] : hw); }
    };
    const onFocus = () => { reset(); setKbd(true); setKeysBar(true); };
    const onBlur = () => setKbd(false);
    reset();
    el.addEventListener('input', onInput);
    el.addEventListener('compositionstart', onCS);
    el.addEventListener('compositionend', onCE);
    el.addEventListener('keydown', onKey);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('input', onInput); el.removeEventListener('compositionstart', onCS); el.removeEventListener('compositionend', onCE);
      el.removeEventListener('keydown', onKey); el.removeEventListener('focus', onFocus); el.removeEventListener('blur', onBlur);
    };
  }, [sendKey, sendText]);

  // physical keyboard while the viewer has focus
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const skip = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest?.('[data-rd-toolbar],[data-rd-kbd]');
    const down = (e: KeyboardEvent) => {
      if (!controlRef.current || skip(e) || !e.code) return;
      e.preventDefault();
      // NAS browser: printable keys go as text, so any keyboard layout types the right character
      if (isNas && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { textKeys.current.add(e.code); push({ t: 'text', s: e.key }); return; }
      const c = physCode(e.code);
      pressed.current.add(c);
      push({ t: 'k', c, down: true });
    };
    const up = (e: KeyboardEvent) => {
      if (!controlRef.current || skip(e) || !e.code) return;
      e.preventDefault();
      if (textKeys.current.delete(e.code)) return;
      const c = physCode(e.code);
      pressed.current.delete(c);
      push({ t: 'k', c, down: false });
    };
    const release = () => { for (const c of pressed.current) push({ t: 'k', c, down: false }); pressed.current.clear(); };
    el.addEventListener('keydown', down);
    el.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => { el.removeEventListener('keydown', down); el.removeEventListener('keyup', up); window.removeEventListener('blur', release); };
  }, [push, isNas]);

  useEffect(() => { root.current?.focus(); }, []);

  // ── Mouse wheel ─────────────────────────────────────────────
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const acc = { x: 0, y: 0 };
    const h = (e: WheelEvent) => {
      e.preventDefault();
      if (!controlRef.current) return;
      const f = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1.2;
      acc.x += e.deltaX * f; acc.y += e.deltaY * f;
      const dx = Math.trunc(acc.x), dy = Math.trunc(acc.y);
      if (Math.abs(dy) >= 30 || Math.abs(dx) >= 30) {
        push({ t: 'w', dx: Math.max(-1200, Math.min(1200, dx)), dy: Math.max(-1200, Math.min(1200, dy)) });
        acc.x -= dx; acc.y -= dy;
      }
    };
    vp.addEventListener('wheel', h, { passive: false });
    return () => vp.removeEventListener('wheel', h);
  }, [push]);

  // ── Touch gestures ──────────────────────────────────────────
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    type P = { x: number; y: number; sx: number; sy: number };
    const pts = new Map<number, P>();
    let g: {
      kind: 'one' | 'two' | 'pinch' | 'scroll' | 'done'; t0: number; moved: boolean; long: boolean; drag: boolean; dragStarted: boolean;
      lp?: ReturnType<typeof setTimeout>; dist: number; mid: { x: number; y: number }; startDist: number; startMid: { x: number; y: number };
    } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    const tp = { x: 32768, y: 32768 };
    const acc = { y: 0, x: 0 };
    const two = () => { const [a, b] = [...pts.values()]; return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; };
    const vpPoint = (x: number, y: number) => { const r = vp.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; };
    const moveTp = (dx: number, dy: number) => {
      const r = canvas.current!.getBoundingClientRect();
      tp.x = Math.min(65535, Math.max(0, tp.x + (dx / r.width) * 65535));
      tp.y = Math.min(65535, Math.max(0, tp.y + (dy / r.height) * 65535));
      localCurAt.current = Date.now();
      showCursor(tp.x, tp.y);
      push({ t: 'm', x: Math.round(tp.x), y: Math.round(tp.y) });
      // keep the cursor in sight when zoomed in
      const v = view.current;
      if (v.z > 1.01) {
        const { W, H } = dims.current;
        const cx = v.x + (tp.x / 65535) * W * v.base * v.z, cy = v.y + (tp.y / 65535) * H * v.base * v.z, mg = 40;
        if (cx < mg) v.x += mg - cx; else if (cx > v.vw - mg) v.x -= cx - (v.vw - mg);
        if (cy < mg) v.y += mg - cy; else if (cy > v.vh - mg) v.y -= cy - (v.vh - mg);
        apply();
      }
    };
    const at = (p: { clientX: number; clientY: number }) => (modeRef.current === 'touchpad' ? { x: Math.round(tp.x), y: Math.round(tp.y) } : norm(p));

    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault();
      setTouch(true);
      vp.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      if (pts.size === 1) {
        if (Date.now() - localCurAt.current > 1500) { tp.x = remoteCur.current.x; tp.y = remoteCur.current.y; }
        const now = Date.now();
        const dbl = modeRef.current === 'touchpad' && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
        g = { kind: 'one', t0: now, moved: false, long: false, drag: dbl, dragStarted: false, dist: 1, mid: { x: 0, y: 0 }, startDist: 1, startMid: { x: 0, y: 0 } };
        if (dbl) push({ t: 'd', b: 0, x: Math.round(tp.x), y: Math.round(tp.y) });
        if (modeRef.current === 'direct' && controlRef.current && view.current.z <= 1.01) push({ t: 'm', ...norm(e) });
        const ev = { clientX: e.clientX, clientY: e.clientY };
        g.lp = setTimeout(() => {
          if (!g || g.kind !== 'one' || g.moved || g.drag || pts.size !== 1) return;
          g.long = true;
          navigator.vibrate?.(15);
          const p = at(ev);
          click(2, p.x, p.y);
        }, 550);
      } else if (pts.size === 2 && g) {
        if (g.lp) clearTimeout(g.lp);
        if (g.kind === 'one' && (g.drag || g.dragStarted)) { const p = at(e); push({ t: 'u', b: 0, ...p }); }
        const t = two();
        g = { ...g, kind: 'two', t0: Date.now(), moved: false, drag: false, dragStarted: false, dist: t.dist, mid: t.mid, startDist: t.dist, startMid: t.mid };
        acc.x = 0; acc.y = 0;
      }
    };

    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (e.pointerType !== 'touch' || !p || !g) return;
      e.preventDefault();
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (g.kind === 'one') {
        if (!g.moved && Math.hypot(p.x - p.sx, p.y - p.sy) > 8) { g.moved = true; if (g.lp) clearTimeout(g.lp); }
        if (!g.moved || g.long) return;
        const v = view.current;
        if (!controlRef.current || (modeRef.current === 'direct' && v.z > 1.01)) { v.x += dx; v.y += dy; apply(); return; }
        if (modeRef.current === 'touchpad') { moveTp(dx, dy); return; }
        if (!g.dragStarted) { g.dragStarted = true; push({ t: 'd', b: 0, ...norm({ clientX: p.sx, clientY: p.sy }) }); }
        push({ t: 'm', ...norm(e) });
        return;
      }
      if (pts.size < 2 || g.kind === 'done') return;
      const t = two();
      if (g.kind === 'two') {
        if (Math.abs(t.dist / g.startDist - 1) > 0.12) g.kind = 'pinch';
        else if (Math.hypot(t.mid.x - g.startMid.x, t.mid.y - g.startMid.y) > 10) g.kind = 'scroll';
        g.moved = g.kind !== 'two';
      }
      if (g.kind === 'pinch') {
        const f = vpPoint(t.mid.x, t.mid.y);
        const v = view.current;
        v.x += t.mid.x - g.mid.x; v.y += t.mid.y - g.mid.y;
        zoomAt(v.z * (t.dist / g.dist), f.x, f.y);
      } else if (g.kind === 'scroll') {
        acc.y += -(t.mid.y - g.mid.y) * 3; acc.x += -(t.mid.x - g.mid.x) * 3;
        const sy = Math.trunc(acc.y / 40) * 40, sx = Math.trunc(acc.x / 40) * 40;
        if (sy || sx) { push({ t: 'w', dx: sx, dy: sy }); acc.y -= sy; acc.x -= sx; }
      }
      g.dist = t.dist; g.mid = t.mid;
    };

    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
      const p = pts.get(e.pointerId)!;
      pts.delete(e.pointerId);
      if (!g) return;
      const cancel = e.type === 'pointercancel';
      if (g.kind === 'one') {
        if (g.lp) clearTimeout(g.lp);
        if (g.drag) { push({ t: 'u', b: 0, x: Math.round(tp.x), y: Math.round(tp.y) }); lastTapAt.current = Date.now(); }
        else if (g.dragStarted) push({ t: 'u', b: 0, ...norm(e) });
        else if (!cancel && !g.moved && !g.long && Date.now() - g.t0 < 300) {
          const q = at({ clientX: p.sx, clientY: p.sy });
          click(0, q.x, q.y);
          lastTapAt.current = Date.now();
          // tapping into a field that already has focus: open the keyboard right away (works on iOS too)
          if (editingRef.current && controlRef.current && kbdInput.current && document.activeElement !== kbdInput.current) {
            autoKbd.current = true; kbdInput.current.focus({ preventScroll: true });
          }
          lastTap = { t: Date.now(), x: e.clientX, y: e.clientY };
        }
        g = null;
        return;
      }
      if (g.kind === 'two' && !cancel && !g.moved && Date.now() - g.t0 < 350) {
        const q = modeRef.current === 'touchpad' ? { x: Math.round(tp.x), y: Math.round(tp.y) } : norm({ clientX: g.mid.x, clientY: g.mid.y });
        click(2, q.x, q.y);
      }
      g = pts.size ? { ...g, kind: 'done' } : null;
    };

    vp.addEventListener('pointerdown', down, { passive: false });
    vp.addEventListener('pointermove', move, { passive: false });
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
    return () => {
      vp.removeEventListener('pointerdown', down); vp.removeEventListener('pointermove', move);
      vp.removeEventListener('pointerup', up); vp.removeEventListener('pointercancel', up);
    };
  }, [apply, zoomAt, push, click]);

  // ── Mouse and pen: direct ───────────────────────────────────
  const mouseMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    moveLocal(e);
    if (oneToOne) {
      // 1:1 is bigger than the window: the view follows the mouse
      const v = view.current, r = viewport.current!.getBoundingClientRect();
      const { W, H } = dims.current;
      v.x = -(W * v.base * v.z - v.vw) * ((e.clientX - r.left) / r.width);
      v.y = -(H * v.base * v.z - v.vh) * ((e.clientY - r.top) / r.height);
      apply();
    }
    push({ t: 'm', ...norm(e) });
  };
  const btn = (e: React.PointerEvent) => (e.button === 1 ? 1 : e.button === 2 ? 2 : 0);

  function toggleOneToOne() {
    const v = view.current;
    if (oneToOne) { resetZoom(); return; }
    v.z = Math.max(1, 1 / v.base);
    apply();
    setOneToOne(true);
    setZoomed(v.z > 1.01);
  }

  function changeQuality(k: keyof typeof QUALITY) {
    setQuality(k);
    void post({ quality: QUALITY[k].quality, scale: QUALITY[k].scale, key: true });
  }

  async function sas() {
    if (!sid.current) return;
    setBusy('sas');
    const r = await fetch(`${base(d.id)}/s/${sid.current}/sas`, { method: 'POST', credentials: 'include' }).catch(() => null);
    if (!r?.ok) alert(((await r?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? 'Ctrl+Alt+Del mislukt');
    setBusy('');
  }

  function typeText() {
    if (!text) return;
    for (let i = 0; i < text.length; i += 2000) queue.current.push({ t: 'text', s: text.slice(i, i + 2000) });
    setText(''); setTyping(false);
    root.current?.focus();
  }

  function toggleKeyboard() {
    const el = kbdInput.current;
    if (!el) return;
    autoKbd.current = false;
    if (document.activeElement === el) { el.blur(); return; }
    el.focus({ preventScroll: true });
  }

  async function fullscreen() {
    const el = root.current as (HTMLDivElement & { requestFullscreen?: () => Promise<void> }) | null;
    if (!el) return;
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => undefined); return; }
    await el.requestFullscreen?.().catch(() => undefined);
    await (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.().catch(() => undefined);
  }

  const title = d.display_name || d.name;
  const live = phase === 'live';
  const ib = 'inline-flex items-center justify-center w-9 h-9 rounded-[10px] text-(--text) hover:bg-[color-mix(in_srgb,var(--text)_9%,transparent)] disabled:opacity-40 disabled:pointer-events-none';
  const ibOn = 'bg-[color-mix(in_srgb,var(--text)_16%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_16%,transparent)]';
  const qualityItems: MenuItem[] = Object.entries(QUALITY).map(([k, v]) => ({
    label: `${v.label}${quality === k ? ' (actief)' : ''}`, detail: k === 'low' ? 'Halve resolutie, voor 4G' : k === 'high' ? 'Meer data' : undefined, disabled: !live, onClick: () => changeQuality(k as keyof typeof QUALITY),
  }));
  const more: MenuItem[] = [
    ...(isMac || isNas ? [] : [{ label: 'Ctrl+Alt+Del', disabled: !live || busy === 'sas', onClick: () => void sas() }]),
    { label: 'Tekst plakken', detail: 'Bijvoorbeeld een wachtwoord uit je kluis', disabled: !live || !control, onClick: () => setTyping(true) },
    ...(compact ? [{ label: keysBar ? 'Toetsenbalk verbergen' : 'Toetsenbalk', detail: isMac ? 'Esc, Tab, Cmd, Option, pijltjes, F-toetsen' : 'Esc, Tab, Ctrl, Alt, Win, pijltjes, F-toetsen', disabled: !control, onClick: () => setKeysBar((k) => !k) }] : []),
    { label: 'Kwaliteit', items: qualityItems },
    ...(touch ? [{ label: 'Uitleg gebaren', onClick: () => setHint(true) }] : []),
    { label: oneToOne ? 'Passend maken' : 'Ware grootte', onClick: toggleOneToOne },
    ...(zoomed ? [{ label: 'Zoom herstellen', onClick: resetZoom }] : []),
    { label: 'Volledig scherm', onClick: () => void fullscreen() },
  ];
  const stState = phase === 'starting' ? 'starting' : phase !== 'live' ? 'ended' : stalled || reconnecting ? 'stalled' : (claudeRun || claudeRecent) ? 'claude' : control ? 'control' : 'live';
  const stLabel = { starting: 'Verbinden', ended: 'Gestopt', stalled: 'Opnieuw verbinden', claude: 'Claude bestuurt', control: 'Jij bestuurt', live: 'Meekijken' }[stState];
  const pil = (mini: boolean) => (
    <span key={stState} className={clsx('rd-pil', mini && 'mini')} data-st={stState} role="status">
      {stState === 'claude' ? <ClaudeLogo className="w-3.5 h-3.5 shrink-0 rd-spin" /> : <span className={clsx('rd-dot', stState === 'starting' && 'pulse')} />}
      {mini && stState !== 'claude' && <span className="truncate max-w-[10rem]">{title} · {stLabel}</span>}
      {mini && stState === 'claude' && <span>{stLabel}</span>}
      {!mini && stLabel}
    </span>
  );
  const nasCmd = (body: Record<string, unknown>) => {
    if (!sid.current) return;
    void fetch(`${base(d.id)}/s/${sid.current}/browser`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...scopeHeaders() }, body: JSON.stringify(body) }).catch(() => undefined);
  };
  const nasPw = (body: Record<string, unknown>) => {
    if (!sid.current) return;
    void fetch(`${base(d.id)}/s/${sid.current}/pw`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...scopeHeaders() }, body: JSON.stringify(body) }).catch(() => undefined);
    root.current?.focus();
  };
  const activeTab = nas.tabs.find((t) => t.active);
  // password bar: stays rendered (last content) while it fades out
  const pwInfo = nas.pw;
  const pwNow: PwBanner | null = pwInfo?.offer ? { kind: 'offer', host: pwInfo.offer.host, username: pwInfo.offer.username, update: pwInfo.offer.kind === 'update' }
    : pwInfo?.choose && pwInfo.host ? { kind: 'choose', host: pwInfo.host, accounts: pwInfo.accounts } : null;
  if (pwNow) pwLast.current = pwNow;
  const pwShow = pwNow ?? pwLast.current;
  const pwOpen = !!pwNow;
  const pwItems: MenuItem[] = pwInfo?.accounts.length
    ? pwInfo.accounts.map((a) => ({ label: a.username, detail: 'Invullen', onClick: () => nasPw({ action: 'fill', id: a.id }) }))
    : [{ label: 'Geen opgeslagen accounts', detail: pwInfo?.host ?? 'Open een inlogpagina', disabled: true }];
  const nasBar = isNas && (
    <div data-rd-toolbar className="nas-bar shrink-0 border-b border-white/10" style={{ background: 'var(--g-bg-base, #111)', paddingTop: compact ? 'calc(env(safe-area-inset-top, 0px) + 15px)' : undefined }}>
      <div className="nas-pw" data-open={pwOpen ? '1' : '0'} aria-hidden={!pwOpen} role="region" aria-label="Wachtwoordmanager">
        <div className="nas-pw-in">
          {pwShow && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 py-2 border-b border-white/10 bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]">
              <Icon name="key" className="w-[18px] h-[18px] shrink-0 text-(--accent)" />
              {pwShow.kind === 'offer' ? (
                <>
                  <span className="min-w-0 flex-1 basis-48 text-[13px] text-(--text) truncate">
                    {pwShow.update ? 'Wachtwoord bijwerken' : 'Wachtwoord opslaan'} voor <b className="font-semibold">{pwShow.host}</b>?
                    <span className="text-(--muted)"> {pwShow.username}</span>
                  </span>
                  <div className="flex items-center gap-1.5 max-sm:w-full">
                    <button tabIndex={pwOpen ? 0 : -1} className={clsx(primary, 'h-9 !px-3 text-[13px] max-sm:flex-1')} onClick={() => nasPw({ action: 'save' })}>{pwShow.update ? 'Bijwerken' : 'Opslaan'}</button>
                    <button tabIndex={pwOpen ? 0 : -1} className={clsx(ghost, 'h-9 !px-3 text-[13px] max-sm:flex-1')} onClick={() => nasPw({ action: 'never' })}>Nooit</button>
                    <button tabIndex={pwOpen ? 0 : -1} className={clsx(ib, 'shrink-0')} onClick={() => nasPw({ action: 'dismiss' })} title="Niet nu" aria-label="Niet nu"><Icon name="close" /></button>
                  </div>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 basis-40 text-[13px] text-(--text) truncate">Account kiezen voor <b className="font-semibold">{pwShow.host}</b></span>
                  <div className="flex flex-wrap items-center gap-1.5 max-sm:w-full">
                    {pwShow.accounts.map((a) => (
                      <button key={a.id} tabIndex={pwOpen ? 0 : -1} className={clsx(ghost, 'h-9 !px-3 text-[13px] max-w-[14rem] truncate max-sm:flex-1')} onClick={() => nasPw({ action: 'fill', id: a.id })}>{a.username}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button className={ib} disabled={!live || !nas.canBack} onClick={() => nasCmd({ cmd: 'back' })} title="Terug" aria-label="Terug"><svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg></button>
        <button className={ib} disabled={!live || !nas.canForward} onClick={() => nasCmd({ cmd: 'forward' })} title="Vooruit" aria-label="Vooruit"><svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg></button>
        <button className={ib} disabled={!live} onClick={() => nasCmd({ cmd: nas.loading ? 'stop' : 'reload' })} title={nas.loading ? 'Stoppen' : 'Herladen'} aria-label={nas.loading ? 'Stoppen' : 'Herladen'}>{nas.loading ? <Icon name="close" /> : <Icon name="refresh" />}</button>
        <form className="flex-1 min-w-0 relative" onSubmit={(e) => { e.preventDefault(); const v = (urlDraft ?? '').trim(); if (v) nasCmd({ cmd: 'navigate', url: v }); setUrlDraft(null); (document.activeElement as HTMLElement | null)?.blur(); root.current?.focus(); }}>
          <input value={urlDraft ?? activeTab?.url ?? ''} disabled={!live} onChange={(e) => setUrlDraft(e.target.value)} onFocus={(e) => e.currentTarget.select()} onBlur={() => setUrlDraft(null)}
            inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="Zoek of typ een adres" aria-label="Adres"
            className="w-full h-10 sm:h-9 rounded-[10px] px-3 text-[13px] text-(--text) bg-(--input) border border-(--border) outline-none focus:border-(--accent) transition-colors" />
        </form>
        <Menu label={<span className="relative inline-flex"><Icon name="key" />{!!pwInfo?.accounts.length && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-(--accent)" aria-hidden />}</span>} caret={false} title="Wachtwoorden" items={pwItems} align="right" buttonClass={ib} disabled={!live} />
      </div>
      <div className="relative h-[2px] overflow-hidden" aria-hidden>{nas.loading && <span className="nas-load absolute inset-y-0 left-0 w-1/3 bg-(--accent)" />}</div>
      <div className="flex items-end gap-1 px-2 pt-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Tabbladen">
        {nas.tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.active} className={clsx('group flex items-center shrink-0 min-w-28 max-w-44 h-8 rounded-t-lg border border-b-0 text-xs transition-[background-color,opacity] duration-150 ease-out', t.active ? 'bg-(--input) border-(--border) text-(--text)' : 'border-transparent text-(--muted) opacity-70 hover:opacity-100 hover:bg-white/5')}>
            <button className="min-w-0 flex-1 text-left truncate pl-2.5 pr-1 h-full" onClick={() => nasCmd({ cmd: 'tab-focus', id: t.id })}>{t.title || t.url || 'Nieuw tabblad'}</button>
            <button className={clsx('w-7 h-7 sm:w-6 sm:h-6 mr-0.5 rounded-md flex items-center justify-center shrink-0 text-(--muted)', !t.active && 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100', 'hover:bg-white/10 hover:text-(--text)')}
              onClick={() => nasCmd({ cmd: 'tab-close', id: t.id })} aria-label="Tabblad sluiten"><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
          </div>
        ))}
        <button className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-(--muted) hover:text-(--text) hover:bg-white/5 transition-colors" disabled={!live} onClick={() => nasCmd({ cmd: 'tab-new' })} aria-label="Nieuw tabblad"><Icon name="plus" className="w-[18px] h-[18px]" /></button>
      </div>
    </div>
  );
  const sep = <span className="w-px h-5 bg-(--border) mx-2 shrink-0" aria-hidden />;

  // bottom bar item on phones: icon with a small label, 44 px high
  const Tab = ({ icon, glyph, label, on, tone, onClick, disabled }: { icon?: string; glyph?: React.ReactNode; label: string; on?: boolean; tone?: 'claude'; onClick: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled} aria-label={label}
      className={clsx('relative flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 h-[52px] rounded-xl text-[11px] font-semibold disabled:opacity-40',
        tone === 'claude' ? (on ? 'text-[#D97757] [html[data-theme=light]_&]:text-[#9a4426]' : 'text-[#D97757]')
          : on ? 'text-[#7aa2ff] [html[data-theme=light]_&]:text-[#1d4ed8]' : 'text-(--muted)')}>
      {on && <span className="absolute inset-y-[2px] inset-x-1 rounded-xl bg-[color-mix(in_srgb,currentColor_14%,transparent)]" aria-hidden />}
      <span className="relative">{glyph ?? <Icon name={icon!} className="w-[22px] h-[22px]" />}</span>
      <span className="relative truncate max-w-full">{label}</span>
    </button>
  );

  return createPortal(
    <div ref={root} tabIndex={-1} className="fixed left-0 right-0 top-0 h-dvh z-[70] flex flex-col bg-black outline-none overflow-clip" onContextMenu={(e) => e.preventDefault()}>
      {compact && nasBar}
      {!compact && (
        <div data-rd-toolbar className="flex items-center gap-1 px-2 py-1.5 border-b border-white/10 text-sm" style={{ background: 'var(--g-bg-base, #111)' }}>
          {pil(false)}
          <span className="font-semibold text-(--text) truncate min-w-0 max-w-[16rem] mx-2.5">{title}</span>
          <span className="hidden md:inline text-xs text-(--muted) truncate ml-2.5 tabular-nums">
            {live ? `${size ? `${size.w * scaleRef.current}x${size.h * scaleRef.current} \u00b7 ` : ''}${stats.fps} fps \u00b7 ${stats.kbps} kB/s` : msg}
          </span>
          <div className="flex-1" />
          <div className={clsx('rd-seg', control && 'bed')} role="group" aria-label="Modus">
            <span className="rd-seg-thumb" aria-hidden />
            <button aria-pressed={!control} onClick={() => setControl(false)} title="Alleen kijken" aria-label="Alleen kijken"><Icon name="eye" className="w-[17px] h-[17px]" /><span className="hidden lg:inline">Kijken</span></button>
            <button aria-pressed={control} onClick={() => { setControl(true); root.current?.focus(); }} title="Bedienen" aria-label="Bedienen"><Icon name="mouse" className="w-[17px] h-[17px]" /><span className="hidden lg:inline">Bedienen</span></button>
          </div>
          {sep}
          <div className="flex items-center gap-0.5">
            <button className={clsx(ib, keysBar && ibOn)} disabled={!control} onClick={() => setKeysBar((k) => !k)} title="Toetsen" aria-label="Toetsen"><Icon name="keyboard" /></button>
            <button className={ib} disabled={!live || !control} onClick={() => setTyping(true)} title="Tekst plakken" aria-label="Tekst plakken"><Icon name="clipboard" /></button>
            {!isMac && !isNas && <button className={ib} disabled={!live || busy === 'sas'} onClick={() => void sas()} title="Ctrl+Alt+Del" aria-label="Ctrl+Alt+Del"><Icon name="lock" /></button>}
          </div>
          {sep}
          <div className="flex items-center gap-0.5">
            <Menu label={<Icon name="gauge" />} caret={false} title="Kwaliteit" items={qualityItems} align="right" buttonClass={ib} />
            <button className={clsx(ib, oneToOne && ibOn)} onClick={toggleOneToOne} title={oneToOne ? 'Passend maken' : 'Ware grootte'} aria-label="Ware grootte"><span className="rd-badge11">1:1</span></button>
            <button className={ib} onClick={() => void fullscreen()} title="Volledig scherm" aria-label="Volledig scherm"><Icon name="fullscreen" /></button>
          </div>
          {sep}
          <button className={clsx('inline-flex items-center justify-center gap-2 h-9 rounded-[10px] text-[13px] font-semibold text-(--text) w-9 md:w-auto md:pl-2.5 md:pr-3 border', claudeOpen ? 'bg-[color-mix(in_srgb,#D97757_16%,transparent)] border-[color-mix(in_srgb,#D97757_50%,transparent)]' : 'border-transparent hover:bg-[color-mix(in_srgb,var(--text)_9%,transparent)]')}
            onClick={() => setClaudeOpen((o) => !o)} title="Vraag Claude" aria-label="Vraag Claude" aria-pressed={claudeOpen}><ClaudeLogo className="w-[18px] h-[18px] shrink-0" /><span className="hidden md:inline">Claude</span></button>
          {sep}
          <button className={clsx(ib, 'hover:bg-red-500/80 hover:text-white')} onClick={onClose} title="Sluiten" aria-label="Sluiten"><Icon name="close" /></button>
        </div>
      )}
      {!compact && nasBar}

      <div className="flex-1 min-h-0 flex relative">
      <div ref={viewport} className="flex-1 min-w-0 relative overflow-hidden touch-none select-none">
        <div ref={stage} className="absolute left-0 top-0 origin-top-left leading-[0]" style={{ willChange: 'transform' }}>
          <canvas ref={canvas} width={16} height={9} className={clsx('block w-full h-full', !control ? 'cursor-not-allowed' : !isNas && 'cursor-none')}
            style={isNas && !control ? { cursor: 'not-allowed' } : undefined}
            onPointerMove={mouseMove}
            onPointerLeave={leaveLocal}
            onPointerDown={(e) => { if (e.pointerType === 'touch') return; root.current?.focus(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); push({ t: 'd', b: btn(e), ...norm(e) }); }}
            onPointerUp={(e) => { if (e.pointerType === 'touch') return; push({ t: 'u', b: btn(e), ...norm(e) }); }} />
          <div ref={cursor} className="absolute pointer-events-none hidden origin-top-left">
            <svg width="14" height="20" viewBox="0 0 14 20"><path ref={remoteArrow} d="M1 1v15l4-4 3 7 2-1-3-7h6z" fill="white" stroke="black" strokeWidth="1.2" strokeLinejoin="round" style={{ transition: 'fill .2s ease' }} /></svg>
          </div>
        </div>

        <div ref={claudeLayer} className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 7 }} />
        {/* your own pointer on the desktop: same style as Claude's, in blue with your name */}
        <div ref={localCur} className="absolute left-0 top-0 pointer-events-none" style={{ zIndex: 9, display: 'none', willChange: 'transform' }} aria-hidden>
          <svg width="24" height="24" viewBox="0 0 24 24" style={{ display: isNas ? 'none' : undefined, position: 'absolute', left: -3, top: -2, overflow: 'visible', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.35))' }}>
            <path d="M3.5 2.2 19.6 11.1c.8.4.7 1.6-.2 1.8l-6.4 1.6-3 5.9c-.4.8-1.6.7-1.8-.2L2.2 3.6c-.2-.9.6-1.7 1.3-1.4Z" fill="#2563EB" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <span ref={localPill} className="absolute whitespace-nowrap rounded-full px-2 text-white"
            style={{ left: 18, top: 20, background: '#2563EB', font: '600 11px/16px system-ui, Segoe UI, sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.25)', opacity: 0, transition: 'opacity .3s ease' }}>{myName}</span>
        </div>
        <div className={clsx('rd-glow', (claudeRun || claudeRecent) && 'aan')} aria-hidden>
          <div className="cr-gloed"><div className="cr-ring"><i /></div></div><div className="cr-ring"><i /></div>
        </div>
        {compact && (
          <div className="absolute pointer-events-none max-w-[70%]"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 14px)', left: 'calc(env(safe-area-inset-left, 0px) + 10px)' }}>{pil(true)}</div>
        )}
        {zoomed && (
          <button className="absolute right-2 top-2 rounded-full px-3 py-1.5 text-xs text-white bg-black/55 border border-white/15"
            style={compact ? { top: 'calc(env(safe-area-inset-top, 0px) + 14px)', right: 'calc(env(safe-area-inset-right, 0px) + 10px)' } : undefined} onClick={resetZoom}>Zoom herstellen</button>
        )}
        {compact && portrait && live && size && size.w > size.h && !zoomed && (
          <p className="absolute inset-x-0 text-center text-xs pointer-events-none" style={{ top: 'calc(var(--rd-img-bottom, 100%) + 12px)', color: '#8a8496' }}>Kantel je telefoon voor een groter beeld, of knijp om te zoomen</p>
        )}
        {live && (stalled || reconnecting) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-4" style={{ background: 'rgba(0,0,0,.35)' }}>
            <div className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-zinc-100 bg-black/75 border border-white/10">
              <span className="typing-dots"><i /><i /><i /></span>
              {reconnecting ? "Opnieuw verbinden…" : "Verbinding met de pc valt weg, opnieuw verbinden…"}
            </div>
          </div>
        )}
        {!live && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-4">
            <div className="rounded-xl px-4 py-3 text-sm text-zinc-200 bg-black/70 border border-white/10 max-w-md text-center pointer-events-auto">
              <p>{msg}</p>
              {(phase === 'ended' || phase === 'error') && <button className={clsx(primary, 'mt-3')} onClick={onClose}>Sluiten</button>}
            </div>
          </div>
        )}
        {hint && live && (
          <div className="absolute inset-x-3 sm:left-auto sm:w-96 rounded-xl p-3 text-xs text-zinc-200 bg-black/85 border border-white/15 space-y-1.5 leading-normal" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 56px)' }}>
            <p className="font-medium text-sm text-white">Bedienen met aanraken</p>
            <p>Touchpad: sleep om de muis te bewegen, tik om te klikken, dubbeltik voor dubbelklik, dubbeltik en sleep om te slepen.</p>
            <p>Lang drukken of tikken met twee vingers: rechtsklik. Twee vingers slepen: scrollen. Knijpen: zoomen.</p>
            <p>Tik je in een tekstveld, dan opent je toetsenbord vanzelf. Anders via Toetsenbord onderin.</p>
            <p>Liever tikken waar je wilt klikken? Zet Muis op Direct.</p>
            <div className="flex justify-end pt-1">
              <button className={primary} onClick={() => { setHint(false); localStorage.setItem(HINT_KEY, '1'); }}>Begrepen</button>
            </div>
          </div>
        )}
      </div>

      {claudeEver && (
        <div className={compact ? 'contents' : clsx('rd-side', claudeOpen && 'open')}>
          <ClaudePanel d={d} compact={compact} open={claudeOpen} onClose={() => setClaudeOpen(false)} onStreaming={setClaudeRun} onActivity={() => { claudeBusy.current = true; setClaudeRecent(true); claudeQuiet(); }} />
        </div>
      )}
      </div>

      {(keysBar || kbd) && control && (
        <div data-rd-kbd className="flex items-center gap-1 px-1.5 py-1.5 overflow-x-auto border-t border-white/10 shrink-0" style={{ background: 'var(--g-bg-base, #111)' }}
          onPointerDown={(e) => e.preventDefault() /* keep the phone keyboard open */}>
          {(['ctrl', 'alt', 'shift', 'meta'] as Mod[]).map((m) => (
            <button key={m} onClick={() => toggleMod(m)}
              className={clsx('shrink-0 min-w-11 h-9 px-2.5 rounded-md text-xs border', mods.includes(m) ? 'bg-(--accent-strong) text-white border-transparent' : 'border-(--border) text-(--text)')}>
              {m === 'ctrl' ? (isMac ? 'Control' : 'Ctrl') : m === 'alt' ? (isMac ? 'Option' : 'Alt') : m === 'shift' ? 'Shift' : isMac ? 'Cmd' : 'Win'}
            </button>
          ))}
          <span className="w-px h-5 bg-white/15 shrink-0 mx-0.5" />
          {BAR.map(([l, c]) => (
            <button key={c} onClick={() => sendKey(c)} className="shrink-0 min-w-11 h-9 px-2.5 rounded-md text-xs border border-(--border) text-(--text)">{l}</button>
          ))}
          {mods.length > 0 && <button onClick={() => sendKey(MOD_CODE[mods[mods.length - 1]], mods.slice(0, -1))} className="shrink-0 h-9 px-2.5 rounded-md text-xs border border-(--border) text-(--muted)">Alleen {mods.map((m) => (m === 'meta' ? (isMac ? 'Cmd' : 'Win') : m === 'alt' && isMac ? 'Option' : m[0].toUpperCase() + m.slice(1))).join('+')}</button>}
        </div>
      )}

      {compact && (
        <div data-rd-toolbar className="flex items-stretch gap-1 px-1.5 pt-1 border-t border-white/10 shrink-0"
          style={{ background: 'var(--g-bg-base, #111)', paddingBottom: kbd ? 4 : 'max(4px, env(safe-area-inset-bottom))' }}
          onPointerDown={(e) => { if (kbd) e.preventDefault(); /* keep the keyboard open while using the bar */ }}>
          <Tab icon="close" label="Sluiten" onClick={onClose} />
          <Tab icon={control ? 'mouse' : 'eye'} label={control ? 'Bedienen' : 'Kijken'} on={control} onClick={() => setControl((c) => !c)} />
          <Tab icon="keyboard" label="Toetsen" on={kbd} disabled={!live || !control} onClick={toggleKeyboard} />
          <Tab icon={touchMode === 'touchpad' ? 'touchpad' : 'finger'} label={touchMode === 'touchpad' ? 'Touchpad' : 'Direct'} disabled={!control}
            onClick={() => setTouchMode((m) => (m === 'touchpad' ? 'direct' : 'touchpad'))} />
          <Tab glyph={<ClaudeLogo className="w-[22px] h-[22px]" />} label="Claude" tone="claude" on={claudeOpen} onClick={() => setClaudeOpen((o) => !o)} />
          <div className="flex-1 min-w-0 flex">
            <Menu label={<span className="flex flex-col items-center gap-0.5"><Icon name="more" className="w-[22px] h-[22px]" /><span className="text-[11px] font-semibold">Meer</span></span>} caret={false} title="Meer" items={more} align="right"
              buttonClass="w-full h-[52px] flex items-center justify-center rounded-xl text-(--muted)" />
          </div>
        </div>
      )}

      <textarea ref={kbdInput} data-rd-kbd aria-label="Toetsenbord" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
        className="fixed left-0 bottom-0 w-px h-px opacity-0 -z-10 text-base" />

      {typing && (
        <div data-rd-toolbar className="absolute inset-0 z-10 flex items-start justify-center p-4 pt-16 bg-black/50" onPointerDown={(e) => { if (e.target === e.currentTarget) setTyping(false); }}>
          <div className="w-full max-w-sm rounded-xl border border-(--border) shadow-xl p-3 space-y-2" style={{ background: 'var(--g-bg-base, #111)' }}>
            <p className="text-sm text-(--text)">Tekst plakken op {title}</p>
            <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Plak hier tekst of een wachtwoord" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); typeText(); } if (e.key === 'Escape') setTyping(false); }}
              className="w-full rounded-lg border border-(--border) bg-(--bg) px-2 py-1.5 text-base sm:text-sm text-(--text) outline-none font-mono" />
            <div className="flex justify-end gap-2">
              <button className={ghost} onClick={() => setTyping(false)}>Annuleren</button>
              <button className={primary} disabled={!text} onClick={typeText}>Typen</button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
