/**
 * Render service: Claude renders HTML (a design, mockup, site) or a URL to PNG screenshots on the server
 * (headless Chromium via playwright-core) and gets them back as chat attachments, so the user sees the
 * design inline in the chat. One shared headless browser, closed after IDLE_MS without use.
 *
 * Local files are not opened via file:// (that could pull in other files of the container); they are served
 * through a virtual origin (http://render.local/) from one directory inside the user's own workspace.
 */
import { chromium, type Browser, type Route } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';
import http from 'http';
import https from 'https';
import { randomUUID } from 'crypto';
import { query } from '../db';
import { config } from '../config';
import { getUserWorkspace } from './claudeCode';

const IDLE_MS = 5 * 60_000;
const ORIGIN = 'http://render.local';
const MAX_HEIGHT = 12_000;
let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;
let idle: NodeJS.Timeout | null = null;
let active = 0;

async function getBrowser(): Promise<Browser> {
  if (idle) { clearTimeout(idle); idle = null; }
  if (browser?.isConnected()) return browser;
  if (!starting) {
    starting = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--mute-audio'] })
      .then((b) => { browser = b; b.on('disconnected', () => { browser = null; }); return b; })
      .finally(() => { starting = null; });
  }
  return starting;
}
function scheduleClose(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => { if (active === 0 && browser) { void browser.close().catch(() => undefined); browser = null; } }, IDLE_MS);
  idle.unref();
}

/** Directories this user may render from: own workspace, and (admin) the admin workspace. */
export function allowedRoots(userId: string, isAdmin: boolean): string[] {
  const roots = [getUserWorkspace(userId)];
  if (isAdmin) roots.push(path.join(config.workspaceRoot, `_admin-${userId}`));
  return roots.map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
}
export function insideRoots(p: string, roots: string[]): string | null {
  let real: string;
  try { real = fs.realpathSync(p); } catch { return null; }
  return roots.some((r) => real === r || real.startsWith(r + path.sep)) ? real : null;
}

function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
const dnsCache = new Map<string, boolean>();
async function hostBlocked(host: string): Promise<boolean> {
  if (dnsCache.has(host)) return dnsCache.get(host)!;
  let blocked = true;
  try {
    if (net.isIP(host)) blocked = privateIp(host);
    else blocked = (await dns.lookup(host, { all: true })).some((a) => privateIp(a.address));
  } catch { blocked = true; }
  dnsCache.set(host, blocked);
  if (dnsCache.size > 500) dnsCache.clear();
  return blocked;
}

// ── Per-user hosts list ("hostfile"): test a site that runs on this Docker host (or in the LAN) under its real
// domain name. Format per line, like /etc/hosts: TARGET NAME [NAME ...]; '#' starts a comment.
// TARGET: IPv4, [IPv6], a hostname, or docker-host (the gateway of this container = the Docker host itself),
// optionally with :port and/or a scheme (http://docker-host:8080 forces plain http to the target).
// NAME: exact domain or *.domain. Matched requests are fetched by Node and fulfilled into the page.
export interface HostTarget { host: string; port?: number; scheme?: 'http' | 'https' }
export type HostMap = Map<string, HostTarget>;

function dockerGateway(): string | null {
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === '00000000' && f[2] && f[2] !== '00000000') {
        const h = f[2];
        return [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join('.');
      }
    }
  } catch { /* ignore */ }
  return null;
}
// own container networks (other claude-chat containers live there); the gateway itself is allowed
function ownSubnets(): Array<{ net: number; mask: number }> {
  const out: Array<{ net: number; mask: number }> = [];
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || f[1] === '00000000') continue;
      const le = (h: string) => (parseInt(h.slice(6, 8) + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2), 16)) >>> 0;
      out.push({ net: le(f[1]), mask: le(f[7]) });
    }
  } catch { /* ignore */ }
  return out;
}
const ip4num = (ip: string) => ip.split('.').reduce((a, b) => ((a << 8) + Number(b)) >>> 0, 0);

const NAME_RE = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/i;
export function parseHosts(text: string | null | undefined): { map: HostMap; errors: string[] } {
  const map: HostMap = new Map();
  const errors: string[] = [];
  String(text ?? '').split(/\r?\n/).slice(0, 200).forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const [target, ...names] = line.split(/\s+/);
    let rest = target;
    let scheme: HostTarget['scheme'];
    const sm = /^(https?):\/\//i.exec(rest);
    if (sm) { scheme = sm[1].toLowerCase() as 'http' | 'https'; rest = rest.slice(sm[0].length).replace(/\/+$/, ''); }
    let host = rest; let port: number | undefined;
    const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(rest);
    if (v6) { host = v6[1]; port = v6[2] ? Number(v6[2]) : undefined; }
    else if (!net.isIPv6(rest)) { const m = /^([^:]+)(?::(\d+))?$/.exec(rest); if (m) { host = m[1]; port = m[2] ? Number(m[2]) : undefined; } }
    const okHost = host.toLowerCase() === 'docker-host' || net.isIP(host) || NAME_RE.test(host);
    if (!okHost || (port !== undefined && (port < 1 || port > 65535)) || !names.length) { errors.push(`regel ${i + 1}: ${raw.trim().slice(0, 80)}`); return; }
    for (const n of names) {
      if (!NAME_RE.test(n)) { errors.push(`regel ${i + 1}: ongeldige naam ${n.slice(0, 60)}`); continue; }
      map.set(n.toLowerCase(), { host: host.toLowerCase() === 'docker-host' ? 'docker-host' : host, port, scheme });
    }
  });
  return { map, errors };
}
function lookupHost(map: HostMap | undefined, hostname: string): HostTarget | null {
  if (!map?.size) return null;
  const h = hostname.toLowerCase();
  if (map.has(h)) return map.get(h)!;
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) { const w = '*.' + parts.slice(i).join('.'); if (map.has(w)) return map.get(w)!; }
  return null;
}
// ports of services that are not websites; non-admins may not reach them through the hosts list
const DENY_PORTS = new Set([22, 23, 25, 110, 143, 465, 587, 993, 995, 2375, 2376, 3306, 4000, 5432, 6379, 11211, 27017]);
async function resolveTarget(t: HostTarget, port: number, isAdmin: boolean): Promise<string> {
  let ip: string;
  if (t.host === 'docker-host') { const g = dockerGateway(); if (!g) throw new Error('docker-host onbekend'); ip = g; }
  else if (net.isIP(t.host)) ip = t.host;
  else ip = (await dns.lookup(t.host)).address;
  if (isAdmin) return ip;
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (DENY_PORTS.has(port)) throw new Error(`poort ${port} niet toegestaan`);
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 127 || a === 0 || (a === 169 && b === 254)) throw new Error('adres niet toegestaan');
    const g = dockerGateway();
    if (v !== g && ownSubnets().some((s) => ((ip4num(v) & s.mask) >>> 0) === s.net)) throw new Error('adres niet toegestaan');
  } else if (v === '::1' || v === '::' || v.startsWith('fe80')) throw new Error('adres niet toegestaan');
  return ip;
}

const HOP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
type Fetched = { status: number; headers: Record<string, string>; body: Buffer };
async function fetchVia(u: URL, t: HostTarget, isAdmin: boolean, method: string, headers: Record<string, string>, body: Buffer | null): Promise<Fetched> {
  const scheme = t.scheme ?? (u.protocol === 'https:' ? 'https' : 'http');
  const port = t.port ?? (u.port ? Number(u.port) : scheme === 'https' ? 443 : 80);
  const ip = await resolveTarget(t, port, isAdmin);
  const hdrs = { ...headers, host: u.host, 'accept-encoding': 'identity' };
  return new Promise<Fetched>((resolve, reject) => {
    const opts: https.RequestOptions = { host: ip, port, method, path: u.pathname + u.search, headers: hdrs, timeout: 20_000 };
    if (scheme === 'https') { opts.servername = net.isIP(u.hostname) ? undefined : u.hostname; opts.rejectUnauthorized = false; }
    const r = (scheme === 'https' ? https : http).request(opts, (resp) => {
      const chunks: Buffer[] = []; let size = 0;
      resp.on('data', (c: Buffer) => { size += c.length; if (size > 30_000_000) r.destroy(new Error('antwoord te groot')); else chunks.push(c); });
      resp.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(resp.headers)) if (v != null && !HOP.has(k)) h[k] = Array.isArray(v) ? v.join(k === 'set-cookie' ? '\n' : ', ') : String(v);
        resolve({ status: resp.statusCode ?? 502, headers: h, body: Buffer.concat(chunks) });
      });
      resp.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
/* Fetch a mapped request in Node and hand it to the page. Redirects to a mapped host are followed here,
   because Chromium sends a redirect from route.fulfill straight to the network (real DNS). */
async function proxyFetch(route: Route, u: URL, t: HostTarget, isAdmin: boolean, map: HostMap): Promise<void> {
  const req = route.request();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(await req.allHeaders())) if (!k.startsWith(':') && k !== 'content-length') headers[k] = v;
  let method = req.method(); let body = req.postDataBuffer();
  let cur = u; let target = t; const cookies: string[] = [];
  let res = await fetchVia(cur, target, isAdmin, method, headers, body);
  for (let hop = 0; hop < 8 && res.status >= 300 && res.status < 400 && res.headers.location; hop++) {
    let next: URL; try { next = new URL(res.headers.location, cur); } catch { break; }
    const nt = /^https?:$/.test(next.protocol) ? lookupHost(map, next.hostname) : null;
    if (!nt) break; // unmapped target: let Chromium follow it normally
    if (res.headers['set-cookie']) cookies.push(res.headers['set-cookie']);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) { method = 'GET'; body = null; delete headers['content-type']; }
    cur = next; target = nt;
    res = await fetchVia(cur, target, isAdmin, method, headers, body);
  }
  if (cookies.length) res.headers['set-cookie'] = [...cookies, res.headers['set-cookie']].filter(Boolean).join('\n');
  let out = res.body;
  // the page keeps the original URL; let relative links resolve against the final one
  if (cur.href !== u.href && /text\/html/i.test(res.headers['content-type'] ?? '')) {
    const html = out.toString('utf8');
    const tag = `<base href="${cur.href.replace(/"/g, '%22')}">`;
    out = Buffer.from(/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html, 'utf8');
  }
  await route.fulfill({ status: res.status, headers: res.headers, body: out });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

export interface RenderOpts {
  html?: string;          // inline HTML
  file?: string;          // HTML file (absolute path) inside the user's workspace; its directory serves the assets
  base?: string;          // directory for relative assets of inline html
  url?: string;           // http(s) URL
  widths?: number[];      // viewport widths, default [390, 1280]
  height?: number;        // viewport height (default 844 for <= 600 px wide, else 800)
  fullPage?: boolean;     // default true
  theme?: 'light' | 'dark';
  selector?: string;      // screenshot of one element
  waitMs?: number;        // extra wait after load (animations, fonts), max 10 s
  allowPrivate?: boolean; // admin only: allow private/loopback hosts (local dev server)
  hosts?: HostMap;        // per-user hosts list (see parseHosts)
  isAdmin?: boolean;
}
export interface Shot { width: number; png: Buffer }

export async function render(o: RenderOpts, roots: string[]): Promise<Shot[]> {
  const sources = [o.html != null, !!o.file, !!o.url].filter(Boolean).length;
  if (sources !== 1) throw new Error('Geef precies een van html, file of url');
  let baseDir: string | null = null;
  let startUrl: string;
  let inlineHtml: string | null = null;
  if (o.file) {
    const f = insideRoots(o.file, roots);
    if (!f || !fs.statSync(f).isFile()) throw new Error('Bestand niet gevonden of buiten je werkruimte');
    baseDir = path.dirname(f);
    startUrl = `${ORIGIN}/${path.basename(f).split('/').map(encodeURIComponent).join('/')}`;
  } else if (o.html != null) {
    if (o.base) {
      baseDir = insideRoots(o.base, roots);
      if (!baseDir || !fs.statSync(baseDir).isDirectory()) throw new Error('base niet gevonden of buiten je werkruimte');
    }
    inlineHtml = String(o.html);
    startUrl = `${ORIGIN}/__inline__.html`;
  } else {
    const u = new URL(String(o.url));
    if (!/^https?:$/.test(u.protocol)) throw new Error('Alleen http(s)-URLs');
    startUrl = u.toString();
  }
  const widths = (o.widths?.length ? o.widths : [390, 1280]).slice(0, 4).map((w) => Math.min(Math.max(Math.round(Number(w) || 1280), 240), 2560));
  const waitMs = Math.min(Math.max(Number(o.waitMs) || 0, 0), 10_000);

  const hostErrors = new Set<string>();
  const onRoute = async (route: Route) => {
    const u = new URL(route.request().url());
    if (u.origin === ORIGIN) {
      if (inlineHtml != null && u.pathname === '/__inline__.html') return route.fulfill({ status: 200, contentType: MIME['.html'], body: inlineHtml });
      if (!baseDir) return route.fulfill({ status: 404, body: '' });
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const target = path.resolve(baseDir, rel);
      const real = insideRoots(target, [baseDir]);
      if (!real || !fs.statSync(real).isFile()) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream', body: fs.readFileSync(real) });
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (!/^https?:$/.test(u.protocol)) return route.abort();
    const mapped = lookupHost(o.hosts, u.hostname);
    if (mapped) {
      try { return await proxyFetch(route, u, mapped, !!o.isAdmin, o.hosts!); } catch (err) {
        hostErrors.add(`${u.hostname}: ${(err as Error).message.split('\n')[0].slice(0, 120)}`);
        return route.abort('connectionfailed');
      }
    }
    if (!o.allowPrivate && (await hostBlocked(u.hostname))) return route.abort('blockedbyclient');
    return route.continue();
  };

  active++;
  const b = await getBrowser();
  const shots: Shot[] = [];
  try {
    for (const width of widths) {
      const mobile = width <= 600;
      const ctx = await b.newContext({
        viewport: { width, height: Math.min(Math.max(Number(o.height) || (mobile ? 844 : 800), 200), 4000) },
        deviceScaleFactor: mobile ? 2 : 1,
        isMobile: mobile, hasTouch: mobile,
        colorScheme: o.theme === 'dark' ? 'dark' : 'light',
        locale: 'nl-NL', timezoneId: 'Europe/Amsterdam',
        acceptDownloads: false, serviceWorkers: 'block',
      });
      try {
        await ctx.route('**/*', onRoute);
        const page = await ctx.newPage();
        try { await page.goto(startUrl, { waitUntil: 'load', timeout: 30_000 }); } catch (err) {
          if (hostErrors.size) throw new Error(`Hostlijst: ${[...hostErrors].slice(0, 3).join('; ')}`);
          throw err;
        }
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => undefined);
        if (waitMs) await page.waitForTimeout(waitMs);
        let png: Buffer;
        if (o.selector) {
          png = await page.locator(o.selector).first().screenshot({ timeout: 10_000, animations: 'disabled' });
        } else {
          const full = o.fullPage !== false;
          const h = full ? await page.evaluate(() => document.documentElement.scrollHeight) : 0;
          png = await page.screenshot({ fullPage: full && h <= MAX_HEIGHT, clip: full && h > MAX_HEIGHT ? { x: 0, y: 0, width, height: MAX_HEIGHT } : undefined, animations: 'disabled', timeout: 30_000 });
        }
        shots.push({ width, png });
      } finally {
        await ctx.close().catch(() => undefined);
      }
    }
  } finally {
    active--;
    scheduleClose();
  }
  return shots;
}

/** Store a PNG as attachment of the conversation (same storage as user uploads). */
export async function saveAttachment(userId: string, conversationId: string, name: string, png: Buffer): Promise<{ id: string; url: string }> {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const stored = `${randomUUID()}_${safe}`;
  const dir = path.join(getUserWorkspace(userId), 'attachments', conversationId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stored), png);
  const r = await query<{ id: string }>(
    `INSERT INTO conversation_attachments (conversation_id, user_id, original_name, stored_name, mime_type, size_bytes, sent_at)
     VALUES ($1, $2, $3, $4, 'image/png', $5, now()) RETURNING id`,
    [conversationId, userId, name, stored, png.length],
  );
  const id = r.rows[0].id;
  return { id, url: `/api/conversations/${conversationId}/attachments/${id}/content` };
}
