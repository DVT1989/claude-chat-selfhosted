/**
 * "Browser (NAS)": a Chromium on the server (headed on Xvfb), one per user, that the user can watch and take over
 * (routes/remote.ts) and that Claude can drive (routes/devices.ts). Playwright only launches and talks CDP;
 * frames come from Page.startScreencast, input goes through Input.dispatch*.
 *
 * - persistent profile per user in /data/browser/<userId> (logins survive a restart; session-only cookies do not)
 * - starts on demand, closes after IDLE_MS without use (viewer present, input, Claude), max 1 per user
 * - /data/browser is root-only (700): Claude chats (uid 1001) cannot read the cookies
 */
import { chromium, type BrowserContext, type Page, type Frame, type CDPSession } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { PW_BINDING, PW_SCRIPT } from './nasPasswordScript';
import * as pwStore from './nasPasswords';

const ROOT = process.env.NAS_BROWSER_DIR || '/data/browser';
export const VIEW_W = 1280;
export const VIEW_H = 800;
const IDLE_MS = 15 * 60_000;
// Headless Chromium is refused by Google sign-in ("browser may not be secure"); a headed Chromium on a
// virtual display (Xvfb) is not. Set NAS_BROWSER_HEADLESS=1 to go back to headless.
const HEADLESS = process.env.NAS_BROWSER_HEADLESS === '1';
const DISPLAY = process.env.NAS_BROWSER_DISPLAY || ':99';
let xvfb: ChildProcess | null = null;

async function ensureDisplay(): Promise<void> {
  const sock = `/tmp/.X11-unix/X${DISPLAY.replace(/^:/, '').split('.')[0]}`;
  if (xvfb && xvfb.exitCode === null && fs.existsSync(sock)) return;
  if (!xvfb || xvfb.exitCode !== null) {
    try { fs.rmSync(`/tmp/.X${DISPLAY.replace(/^:/, '')}-lock`, { force: true }); } catch { /* ignore */ }
    xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', `${VIEW_W}x${VIEW_H + 120}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
    xvfb.on('exit', () => { xvfb = null; });
    xvfb.unref();
  }
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  if (!fs.existsSync(sock)) throw new Error('Xvfb start niet');
}

export interface TabInfo { id: number; title: string; url: string; active: boolean }
export interface PwState {
  /** host of the active page (null for about:/data: pages) */
  host: string | null;
  /** saved accounts for that site: id and user name only, never the password */
  accounts: pwStore.PwAccount[];
  /** a submitted login that can be saved; the password stays on the server */
  offer: { host: string; username: string; kind: 'new' | 'update' } | null;
  /** login field found on a site with several accounts: the viewer asks which one */
  choose: boolean;
}
export interface NasState { tabs: TabInfo[]; canBack: boolean; canForward: boolean; loading: boolean; pw?: PwState }
export interface NasEvent { t: string; x?: number; y?: number; b?: number; dx?: number; dy?: number; c?: string; down?: boolean; s?: string }
export type NasCommand =
  | { cmd: 'back' | 'forward' | 'reload' | 'stop' }
  | { cmd: 'navigate'; url: string }
  | { cmd: 'tab-new'; url?: string }
  | { cmd: 'tab-close' | 'tab-focus'; id: number };
interface Subscriber { frame: (jpeg: Buffer, w: number, h: number) => void; state: (s: NasState) => void; cursor?: (c: string) => void }

const MODS: Record<string, number> = { AltLeft: 1, AltRight: 1, ControlLeft: 2, ControlRight: 2, MetaLeft: 4, MetaRight: 4, ShiftLeft: 8, ShiftRight: 8 };
const NAMED: Record<string, { key: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', vk: 13, text: '\r' }, NumpadEnter: { key: 'Enter', vk: 13, text: '\r' }, Escape: { key: 'Escape', vk: 27 }, Tab: { key: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', vk: 8 }, Delete: { key: 'Delete', vk: 46 }, Space: { key: ' ', vk: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', vk: 37 }, ArrowUp: { key: 'ArrowUp', vk: 38 }, ArrowRight: { key: 'ArrowRight', vk: 39 }, ArrowDown: { key: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', vk: 36 }, End: { key: 'End', vk: 35 }, PageUp: { key: 'PageUp', vk: 33 }, PageDown: { key: 'PageDown', vk: 34 }, Insert: { key: 'Insert', vk: 45 },
  ContextMenu: { key: 'ContextMenu', vk: 93 },
  ControlLeft: { key: 'Control', vk: 17 }, ControlRight: { key: 'Control', vk: 17 }, ShiftLeft: { key: 'Shift', vk: 16 }, ShiftRight: { key: 'Shift', vk: 16 },
  AltLeft: { key: 'Alt', vk: 18 }, AltRight: { key: 'Alt', vk: 18 }, MetaLeft: { key: 'Meta', vk: 91 }, MetaRight: { key: 'Meta', vk: 92 },
  Minus: { key: '-', vk: 189, text: '-' }, Equal: { key: '=', vk: 187, text: '=' }, Comma: { key: ',', vk: 188, text: ',' }, Period: { key: '.', vk: 190, text: '.' },
  Slash: { key: '/', vk: 191, text: '/' }, Semicolon: { key: ';', vk: 186, text: ';' }, Quote: { key: "'", vk: 222, text: "'" }, Backquote: { key: '`', vk: 192, text: '`' },
  BracketLeft: { key: '[', vk: 219, text: '[' }, BracketRight: { key: ']', vk: 221, text: ']' }, Backslash: { key: '\\', vk: 220, text: '\\' },
};
const SHIFT_DIGITS = ')!@#$%^&*(';

function keyInfo(code: string, shift: boolean): { key: string; vk: number; text?: string } | null {
  if (NAMED[code]) return NAMED[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) { const ch = shift ? m[1] : m[1].toLowerCase(); return { key: ch, vk: m[1].charCodeAt(0), text: ch }; }
  m = /^Digit([0-9])$/.exec(code);
  if (m) { const ch = shift ? SHIFT_DIGITS[+m[1]] : m[1]; return { key: ch, vk: 48 + +m[1], text: ch }; }
  m = /^F([1-9]|1[0-2])$/.exec(code);
  if (m) return { key: code, vk: 111 + +m[1] };
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the address bar accepts: a full URL, a host name, or a search. */
export function normalizeUrl(input: string): string {
  const v = input.trim();
  if (!v) return 'about:blank';
  if (/^(https?:|about:|file:|data:)/i.test(v)) return v;
  if (!/\s/.test(v) && /^[^\s/]+\.[a-z]{2,}([/:?#].*)?$/i.test(v)) return `https://${v}`;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(v)) return `http://${v}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(v)}`;
}

/**
 * Like Chrome with "continue where you left off": session cookies (logins without "remember me")
 * survive a browser restart, and a clean exit flag avoids the "restore pages?" bubble.
 */
function keepSessions(dir: string): void {
  const file = path.join(dir, 'Default', 'Preferences');
  try {
    let prefs: Record<string, any> = {};
    try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
    prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 1 };
    prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
    fs.writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
  } catch { /* profile unreadable: start as is */ }
}

export class NasBrowser {
  readonly userId: string;
  lastUse = Date.now();
  private ctx: BrowserContext | null = null;
  private active: Page | null = null;
  private cdp: CDPSession | null = null;
  private ids = new WeakMap<Page, number>();
  private nextId = 1;
  private subs = new Set<Subscriber>();
  private lastFrame: { jpeg: Buffer; w: number; h: number } | null = null;
  private mods = 0;
  private buttons = 0;
  private click = { at: 0, x: 0, y: 0, b: -1, n: 0 };
  private chain: Promise<unknown> = Promise.resolve();
  /** newest mouse move received: older moves still in the queue are skipped (no lagging cursor) */
  private moveGen = 0;
  private cursorAt = 0;
  private cursorTimer: NodeJS.Timeout | null = null;
  private cursorPos = { x: 0, y: 0 };
  private lastCursor = '';
  private stateTimer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private loading = false;
  private titles = new WeakMap<Page, string>();
  private offer: { origin: string; host: string; username: string; password: string; kind: 'new' | 'update'; timer: NodeJS.Timeout } | null = null;
  private choose: { origin: string; at: number } | null = null;
  closed = false;

  constructor(userId: string) { this.userId = userId; }

  get viewers(): number { return this.subs.size; }
  touch(): void { this.lastUse = Date.now(); }

  async launch(): Promise<void> {
    const dir = path.join(ROOT, this.userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // after a container restart Chromium sees the old profile lock of another host name and refuses to start
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ } }
    keepSessions(dir);
    if (!HEADLESS) await ensureDisplay();
    this.ctx = await chromium.launchPersistentContext(dir, {
      headless: HEADLESS,
      env: HEADLESS ? process.env : { ...process.env, DISPLAY },
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: { width: VIEW_W, height: VIEW_H },
      deviceScaleFactor: 1,
      locale: 'nl-NL',
      timezoneId: 'Europe/Amsterdam',
      acceptDownloads: false,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled', '--hide-scrollbars', '--mute-audio', '--disable-features=Translate'],
    });
    // password manager: catch submitted logins, find login fields (see nasPasswordScript.ts)
    await this.ctx.exposeBinding(PW_BINDING, (src, ev) => { void this.onPwEvent(src, ev).catch(() => undefined); });
    await this.ctx.addInitScript(PW_SCRIPT);
    this.ctx.on('page', (p) => { this.watch(p); void this.focus(p); });
    this.ctx.on('close', () => { if (!this.closed) void this.close('browser gesloten'); });
    const first = this.ctx.pages()[0] ?? await this.ctx.newPage();
    for (const p of this.ctx.pages()) this.watch(p);
    await this.focus(first);
    this.poll = setInterval(() => {
      if (this.subs.size) { this.touch(); this.pushState(); }
      else if (Date.now() - this.lastUse > IDLE_MS) void this.close('inactief');
    }, 2_000);
    this.poll.unref();
  }

  private idOf(p: Page): number {
    let id = this.ids.get(p);
    if (!id) { id = this.nextId++; this.ids.set(p, id); }
    return id;
  }

  private watch(p: Page): void {
    this.idOf(p);
    const again = () => { this.pushState(); setTimeout(() => this.pushState(), 800).unref(); };
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) again(); });
    p.on('load', () => { if (p === this.active) this.loading = false; again(); });
    p.on('domcontentloaded', () => again());
    p.on('close', () => {
      const pages = this.ctx?.pages() ?? [];
      if (p === this.active) {
        this.cdp = null; this.active = null;
        const next = pages[pages.length - 1];
        if (next) void this.focus(next);
        else if (!this.closed) void this.ctx?.newPage().catch(() => undefined);
      }
      this.pushState();
    });
  }

  /** Make a page the one that is shown, and restart the screencast on it. */
  private async focus(p: Page): Promise<void> {
    if (this.closed || p.isClosed()) return;
    const old = this.cdp;
    if (old) { try { await old.send('Page.stopScreencast'); } catch { /* page gone */ } try { await old.detach(); } catch { /* gone */ } }
    this.active = p;
    this.lastFrame = null;
    try {
      await p.bringToFront();
      const cdp = await this.ctx!.newCDPSession(p);
      this.cdp = cdp;
      cdp.on('Page.screencastFrame', (ev: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
        void cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
        if (this.cdp !== cdp) return;
        const jpeg = Buffer.from(ev.data, 'base64');
        const w = Math.round(ev.metadata.deviceWidth || VIEW_W), h = Math.round(ev.metadata.deviceHeight || VIEW_H);
        this.lastFrame = { jpeg, w, h };
        for (const s of this.subs) s.frame(jpeg, w, h);
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1 });
    } catch { /* page closed while switching */ }
    this.pushState();
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.add(sub);
    this.touch();
    if (this.lastFrame) sub.frame(this.lastFrame.jpeg, this.lastFrame.w, this.lastFrame.h);
    void this.state().then((s) => sub.state(s));
    return () => { this.subs.delete(sub); this.touch(); };
  }

  /** Send the newest picture again (new viewer, or a viewer that missed frames). */
  resend(): void {
    if (!this.lastFrame) return;
    for (const s of this.subs) s.frame(this.lastFrame.jpeg, this.lastFrame.w, this.lastFrame.h);
  }

  async state(): Promise<NasState> {
    const pages = (this.ctx?.pages() ?? []).filter((p) => !p.isClosed());
    const tabs: TabInfo[] = await Promise.all(pages.map(async (p) => {
      const raw = (await Promise.race([p.title(), sleep(400).then(() => '')]).catch(() => '')) || '';
      if (raw) this.titles.set(p, raw);
      let host = '';
      try { host = new URL(p.url()).hostname.replace(/^www\./, ''); } catch { /* no url */ }
      return { id: this.idOf(p), url: p.url(), title: raw || this.titles.get(p) || host || 'Nieuw tabblad', active: p === this.active };
    }));
    let canBack = false, canForward = false;
    if (this.cdp) {
      try {
        const h = await this.cdp.send('Page.getNavigationHistory') as { currentIndex: number; entries: unknown[] };
        canBack = h.currentIndex > 0; canForward = h.currentIndex < h.entries.length - 1;
      } catch { /* ignore */ }
    }
    return { tabs, canBack, canForward, loading: this.loading, pw: await this.pwState().catch(() => undefined) };
  }

  // ── password manager ───────────────────────────────────────

  private async pwState(): Promise<PwState> {
    const o = this.active ? pwStore.originOf(this.active.url()) : null;
    const accounts = o ? await pwStore.accountsFor(this.userId, o.origin) : [];
    const choose = !!o && !!this.choose && this.choose.origin === o.origin && Date.now() - this.choose.at < 120_000 && accounts.length > 1;
    return {
      host: o?.host ?? null, accounts, choose,
      offer: this.offer ? { host: this.offer.host, username: this.offer.username, kind: this.offer.kind } : null,
    };
  }

  private setOffer(o: { origin: string; host: string; username: string; password: string; kind: 'new' | 'update' } | null): void {
    if (this.offer) clearTimeout(this.offer.timer);
    if (!o) this.offer = null;
    else {
      const timer = setTimeout(() => { if (this.offer?.timer === timer) { this.offer = null; this.pushState(); } }, 180_000);
      timer.unref();
      this.offer = { ...o, timer };
    }
    this.pushState();
  }

  private async onPwEvent(src: { frame: { url(): string }; page: Page }, ev: unknown): Promise<void> {
    if (this.closed || !ev || typeof ev !== 'object') return;
    const e = ev as { type?: string; username?: unknown; password?: unknown; pass?: unknown; user?: unknown; known?: unknown };
    const o = pwStore.originOf(src.frame.url());
    if (!o) return;
    if (e.type === 'login') {
      const username = typeof e.username === 'string' ? e.username.trim() : '';
      const password = typeof e.password === 'string' ? e.password : '';
      if (!username || !password || username.length > 300 || password.length > 1000) return;
      if (await pwStore.isNever(this.userId, o.origin)) return;
      const kind = await pwStore.compare(this.userId, o.origin, username, password);
      if (kind === 'same') return;
      this.setOffer({ origin: o.origin, host: o.host, username, password, kind });
    } else if (e.type === 'fields') {
      const accounts = await pwStore.accountsFor(this.userId, o.origin);
      if (!accounts.length) return;
      const known = typeof e.known === 'string' ? e.known : '';
      const pick = accounts.length === 1 ? accounts[0] : accounts.find((a) => a.username.toLowerCase() === known.toLowerCase());
      if (pick) {
        const sec = await pwStore.secret(this.userId, pick.id);
        if (sec) await this.fillFrame(src.frame as unknown as Frame, sec.username, sec.password);
      } else {
        this.choose = { origin: o.origin, at: Date.now() };
        this.pushState();
      }
    }
  }

  private async fillFrame(f: Frame, username: string, password: string): Promise<{ user: boolean; pass: boolean }> {
    try {
      const r = await f.evaluate(([u, p]) => (window as unknown as { __ccPwFill?: (u: string, p: string) => { user: boolean; pass: boolean } }).__ccPwFill?.(u, p), [username, password]);
      return r ?? { user: false, pass: false };
    } catch { return { user: false, pass: false }; }
  }

  /** Viewer answer to the offer bar. */
  async pwAnswer(action: 'save' | 'never' | 'dismiss'): Promise<void> {
    this.touch();
    const o = this.offer;
    if (!o) return;
    if (action === 'save') await pwStore.save(this.userId, o.origin, o.host, o.username, o.password);
    else if (action === 'never') await pwStore.setNever(this.userId, o.origin);
    this.setOffer(null);
  }

  /** Fill the login fields of the active page with a saved account (all frames of the same origin). Never returns the password. */
  async pwFill(id: string): Promise<{ username: string; filled: { username: boolean; password: boolean } }> {
    this.touch();
    const sec = await pwStore.secret(this.userId, id);
    if (!sec) throw new Error('Account niet gevonden');
    const p = this.active;
    if (!p) throw new Error('Geen open tabblad');
    const cur = pwStore.originOf(p.url());
    if (!cur || cur.origin !== sec.origin) throw new Error('Dit account hoort bij een andere site dan het open tabblad');
    let user = false, pass = false;
    for (const f of p.frames()) {
      if (pwStore.originOf(f.url())?.origin !== sec.origin) continue;
      const r = await this.fillFrame(f, sec.username, sec.password);
      user = user || r.user; pass = pass || r.pass;
    }
    this.choose = null;
    this.pushState();
    return { username: sec.username, filled: { username: user, password: pass } };
  }

  /** Which login fields the active page shows (for Claude): no values. */
  async pwFields(): Promise<{ username: boolean; password: boolean }> {
    const p = this.active;
    const out = { username: false, password: false };
    if (!p) return out;
    for (const f of p.frames()) {
      try {
        const r = await f.evaluate(() => (window as unknown as { __ccPwInfo?: () => { username: boolean; password: boolean } }).__ccPwInfo?.());
        if (r) { out.username = out.username || r.username; out.password = out.password || r.password; }
      } catch { /* frame gone */ }
    }
    return out;
  }

  private pushState(): void {
    if (this.stateTimer || !this.subs.size) return;
    this.stateTimer = setTimeout(async () => {
      this.stateTimer = null;
      const st = await this.state().catch(() => null);
      if (st) for (const s of this.subs) s.state(st);
    }, 150);
  }

  // ── input ──────────────────────────────────────────────────

  /** Events are applied strictly in order, also when they arrive in separate requests. */
  input(events: NasEvent[]): void {
    this.touch();
    const tagged = events.map((e) => (e.t === 'm' ? { e, gen: ++this.moveGen } : { e, gen: 0 }));
    this.chain = this.chain.then(async () => {
      for (const { e, gen } of tagged) {
        // a newer move is already waiting: skip this one, unless a button is held (drag paths stay exact)
        if (gen && gen < this.moveGen && !this.buttons) continue;
        try { await this.one(e); } catch { /* page navigating */ }
      }
    });
  }

  /** Which mouse cursor the page shows at the pointer (hand on links, I-beam on text), throttled. */
  private probeCursor(): void {
    if (this.cursorTimer || !this.subs.size) return;
    const wait = Math.max(0, 80 - (Date.now() - this.cursorAt));
    this.cursorTimer = setTimeout(async () => {
      this.cursorTimer = null;
      this.cursorAt = Date.now();
      const cdp = this.cdp;
      if (!cdp) return;
      const { x, y } = this.cursorPos;
      const expr = `(() => { let el = document.elementFromPoint(${x}, ${y}); let ox = ${x}, oy = ${y};
        for (let i = 0; i < 4 && el && el.tagName === 'IFRAME'; i++) { try { const r = el.getBoundingClientRect(); const d = el.contentDocument; if (!d) break; ox -= r.left; oy -= r.top; el = d.elementFromPoint(ox, oy); } catch { break; } }
        if (!el) return 'default';
        let c = getComputedStyle(el).cursor || 'auto';
        if (c !== 'auto') return c;
        if (el.closest('a[href],button,[role=button],label[for],select,summary')) return el.closest('a[href]') ? 'pointer' : 'default';
        if (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type))) return 'text';
        return 'default'; })()`;
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result?: { value?: unknown } };
        const c = typeof r.result?.value === 'string' ? r.result.value.split(',').pop()!.trim().slice(0, 40) : 'default';
        if (c !== this.lastCursor) { this.lastCursor = c; for (const s of this.subs) s.cursor?.(c); }
      } catch { /* navigating */ }
    }, wait);
  }

  private pos(e: NasEvent): { x: number; y: number } {
    const w = this.lastFrame?.w ?? VIEW_W, h = this.lastFrame?.h ?? VIEW_H;
    return { x: Math.round(((e.x ?? 0) / 65535) * w), y: Math.round(((e.y ?? 0) / 65535) * h) };
  }

  private async one(e: NasEvent): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    const btn = (b?: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');
    const bit = (b?: number) => (b === 2 ? 2 : b === 1 ? 4 : 1);
    if (e.t === 'm') {
      const { x, y } = this.pos(e);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: this.mods, buttons: this.buttons });
      this.cursorPos = { x, y };
      this.probeCursor();
    } else if (e.t === 'd' || e.t === 'u') {
      const { x, y } = this.pos(e);
      const now = Date.now();
      if (e.t === 'd') {
        const c = this.click;
        const same = now - c.at < 500 && c.b === (e.b ?? 0) && Math.abs(c.x - x) < 5 && Math.abs(c.y - y) < 5;
        this.click = { at: now, x, y, b: e.b ?? 0, n: same ? c.n + 1 : 1 };
        this.buttons |= bit(e.b);
      } else {
        this.buttons &= ~bit(e.b);
      }
      await cdp.send('Input.dispatchMouseEvent', {
        type: e.t === 'd' ? 'mousePressed' : 'mouseReleased', x, y, button: btn(e.b), buttons: this.buttons, clickCount: this.click.n || 1, modifiers: this.mods,
      });
    } else if (e.t === 'w') {
      const { x, y } = this.pos(e);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: e.dx ?? 0, deltaY: e.dy ?? 0, modifiers: this.mods });
    } else if (e.t === 'k' && e.c) {
      const mod = MODS[e.c] ?? 0;
      if (mod) this.mods = e.down ? this.mods | mod : this.mods & ~mod;
      const k = keyInfo(e.c, (this.mods & 8) !== 0);
      if (!k) return;
      const typed = !(this.mods & 7) && k.text;
      await cdp.send('Input.dispatchKeyEvent', {
        type: e.down ? (typed ? 'keyDown' : 'rawKeyDown') : 'keyUp', modifiers: this.mods, key: k.key, code: e.c,
        windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(e.down && typed ? { text: k.text, unmodifiedText: k.text } : {}),
      });
    } else if (e.t === 'text' && e.s) {
      const text = e.s;
      if (text.length > 40 || /[^\x20-\x7e\n\r\t]/.test(text)) {
        // long or non-ASCII text: insert in one go (no key events)
        for (const part of text.split(/\r?\n/).map((v, i) => ({ v, i }))) {
          if (part.i > 0) await this.press('Enter');
          if (part.v) await cdp.send('Input.insertText', { text: part.v });
        }
      } else {
        for (const ch of text) {
          if (ch === '\n' || ch === '\r') { await this.press('Enter'); continue; }
          if (ch === '\t') { await this.press('Tab'); continue; }
          const code = ch === ' ' ? 'Space' : null;
          const vk = /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : /[0-9]/.test(ch) ? ch.charCodeAt(0) : 0;
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, ...(code ? { code } : {}) });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, ...(code ? { code } : {}) });
        }
      }
    }
  }

  private async press(code: string): Promise<void> {
    const k = NAMED[code];
    if (!this.cdp) return;
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code, windowsVirtualKeyCode: k.vk, text: k.text, unmodifiedText: k.text });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code, windowsVirtualKeyCode: k.vk });
  }

  // ── commands (address bar and Claude) ──────────────────────

  async command(c: NasCommand): Promise<void> {
    this.touch();
    const p = this.active;
    const ctx = this.ctx;
    if (!ctx) return;
    const byId = (id: number) => ctx.pages().find((x) => this.ids.get(x) === id);
    switch (c.cmd) {
      case 'back': await p?.goBack({ timeout: 15_000 }).catch(() => undefined); break;
      case 'forward': await p?.goForward({ timeout: 15_000 }).catch(() => undefined); break;
      case 'reload': await p?.reload({ timeout: 15_000 }).catch(() => undefined); break;
      case 'stop': await this.cdp?.send('Page.stopLoading').catch(() => undefined); break;
      case 'navigate': await this.goto(p, c.url); break;
      case 'tab-new': { const np = await ctx.newPage(); if (c.url) await this.goto(np, c.url); break; }
      case 'tab-close': { const t = byId(c.id); if (t) await t.close().catch(() => undefined); break; }
      case 'tab-focus': { const t = byId(c.id); if (t) await this.focus(t); break; }
    }
    this.pushState();
  }

  private async goto(p: Page | null, url: string): Promise<void> {
    if (!p) return;
    this.loading = true;
    this.pushState();
    try { await p.goto(normalizeUrl(url), { timeout: 30_000, waitUntil: 'domcontentloaded' }); }
    catch (err) {
      // a navigation that is replaced by a redirect or a download is no failure for the caller
      if (!/ERR_ABORTED|interrupted/i.test(String(err))) { this.loading = false; throw err; }
    }
    this.loading = false;
  }

  // ── Claude ─────────────────────────────────────────────────

  async screenshot(): Promise<{ jpeg: Buffer; w: number; h: number }> {
    this.touch();
    if (!this.active) throw new Error('Geen open tabblad');
    const jpeg = await this.active.screenshot({ type: 'jpeg', quality: 70, timeout: 15_000 });
    return { jpeg, w: VIEW_W, h: VIEW_H };
  }

  /** Page text plus the visible interactive elements with click coordinates in screenshot pixels. */
  async read(): Promise<{ url: string; title: string; text: string; elements: Array<{ tag: string; type?: string; label: string; x: number; y: number }> }> {
    this.touch();
    const p = this.active;
    if (!p) throw new Error('Geen open tabblad');
    const data = await p.evaluate(() => {
      const label = (el: Element) => {
        const h = el as HTMLElement & { type?: string; value?: string; placeholder?: string; alt?: string };
        return (h.getAttribute('aria-label') || h.innerText || (h.type === 'password' ? '' : h.value) || h.placeholder || h.alt || h.getAttribute('title') || h.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      };
      const out: Array<{ tag: string; type?: string; label: string; x: number; y: number }> = [];
      const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[onclick]';
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        out.push({ tag: el.tagName.toLowerCase(), type: (el as HTMLInputElement).type || undefined, label: label(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        if (out.length >= 80) break;
      }
      return { text: (document.body?.innerText || '').slice(0, 20000), elements: out };
    });
    return { url: p.url(), title: await p.title().catch(() => ''), ...data };
  }

  // ── end ────────────────────────────────────────────────────

  async close(reason = 'gestopt'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.offer) { clearTimeout(this.offer.timer); this.offer = null; }
    registry.delete(this.userId);
    const ctx = this.ctx;
    this.ctx = null; this.cdp = null; this.active = null;
    for (const s of this.subs) s.state({ tabs: [], canBack: false, canForward: false, loading: false });
    this.subs.clear();
    try { await Promise.race([ctx?.close(), sleep(8_000)]); } catch { /* already gone */ }
    onClose.forEach((f) => f(this.userId, reason));
  }
}

const registry = new Map<string, NasBrowser>();
const starting = new Map<string, Promise<NasBrowser>>();
const onClose = new Set<(userId: string, reason: string) => void>();

/** remote.ts ends the viewer session when the browser closes (idle, crash). */
export function onNasClosed(f: (userId: string, reason: string) => void): void { onClose.add(f); }

export function runningNas(userId: string): NasBrowser | null { return registry.get(userId) ?? null; }

/** The browser of this user; starts it when needed. Strictly per user: the key is the user id. */
export async function getNas(userId: string): Promise<NasBrowser> {
  const have = registry.get(userId);
  if (have && !have.closed) { have.touch(); return have; }
  const busy = starting.get(userId);
  if (busy) return busy;
  const p = (async () => {
    const b = new NasBrowser(userId);
    registry.set(userId, b);
    try { await b.launch(); } catch (err) { registry.delete(userId); await b.close('start mislukt').catch(() => undefined); throw err; }
    return b;
  })();
  starting.set(userId, p);
  try { return await p; } finally { starting.delete(userId); }
}

export async function closeAllNas(): Promise<void> {
  await Promise.all([...registry.values()].map((b) => b.close('server herstart').catch(() => undefined)));
}
