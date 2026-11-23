/**
 * Remote desktop (Meekijken / Overnemen) over plain HTTPS, no WebSocket needed through the proxies.
 *
 * Browser:  POST /devices/remote/:id/start                  -> { sid }  (queues a "remote" job on the agent)
 *           GET  /devices/remote/:id/s/:sid/stream          -> binary stream of u32-length-prefixed messages
 *           POST /devices/remote/:id/s/:sid/input           -> mouse/keyboard events, quality, key frame request
 *           POST /devices/remote/:id/s/:sid/sas             -> Ctrl+Alt+Del (job on the service)
 *           DELETE /devices/remote/:id/s/:sid
 * Agent helper (X-Remote-Key from the job, no database lookups per frame):
 *           POST /devices/remote/agent/:sid/frame  (octet-stream)  -> control { stop, key, quality, scale }
 *           POST /devices/remote/agent/:sid/input  (long-poll)     -> control + queued events
 *
 * Mounted above the general rate limiter: a session sends many small requests per second.
 * Stream messages: a frame from the agent as-is (first byte 1), or JSON status (first byte "{").
 */
import express, { Router, Request, Response, NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import * as dev from '../services/devices';
import { query } from '../db';
import { getNas, onNasClosed, normalizeUrl, type NasBrowser, type NasEvent, type NasState } from '../services/nasBrowser';

export const remoteRouter = Router();

const MIN_AGENT = [1, 3, 0];
const START_TIMEOUT_MS = 30_000;   // first frame must arrive within this time
const IDLE_END_MS = 20_000;        // no viewer left: end the session
const CLAUDE_IDLE_MS = 90_000;     // a session Claude started without a viewer ends after this quiet time
const HOLD_MS = 25_000;            // input long-poll
const MAX_EVENTS = 2000;

interface Viewer { res: Response; needKey: boolean }
interface Session {
  sid: string; key: string; deviceId: string; deviceName: string; userId: string; ip: string;
  viewers: Set<Viewer>; events: unknown[]; waiter: { res: Response; timer: NodeJS.Timeout } | null;
  wantKey: boolean; quality: number; scale: number; ctlDirty: boolean;
  started: number; firstFrame: number; frames: number; bytes: number; control: boolean;
  timers: { start?: NodeJS.Timeout; idle?: NodeJS.Timeout; ping?: NodeJS.Timeout }; ended: boolean;
  // Claude: screenshot requests, last screenshot size (its coordinate space), last use
  userName: string; nameSent: boolean; notice: boolean;
  /** look of the pill on the PC: accent colour, initials, photo (sent once via /avatar) */
  accent: string; initials: string; avatar: Buffer | null;
  /** started by Claude without a viewer: the PC shows "Claude werkt mee" until a person joins */
  claudeOnly: boolean;
  /** last sign of life from the helper (frame, shot or input poll), and whether viewers were told it stalled */
  agentAt: number; stalled: boolean;
  /** Browser (NAS): the browser runs in this process, no agent. Frames and input go straight to it. */
  nas: NasBrowser | null; unsub: (() => void) | null;
  shotReq: number; shot: { w: number; h: number; jpeg: Buffer; at: number } | null; shotWaiters: Array<() => void>; claudeAt: number;
}
const sessions = new Map<string, Session>();

const versionOk = (v: string | null) => {
  const p = (v ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((p[i] ?? 0) !== MIN_AGENT[i]) return (p[i] ?? 0) > MIN_AGENT[i]; }
  return true;
};

function status(v: Viewer, body: Record<string, unknown>): void {
  const json = Buffer.from(JSON.stringify(body));
  const head = Buffer.alloc(4); head.writeUInt32LE(json.length);
  try { v.res.write(head); v.res.write(json); } catch { /* gone */ }
}

function ctl(s: Session, extra: Record<string, unknown> = {}) {
  const out = { stop: s.ended, key: s.wantKey, quality: s.quality, scale: s.scale, shot: s.shotReq, name: s.userName, notice: s.notice, claude: s.claudeOnly, accent: s.accent, initials: s.initials, avatar: !!s.avatar, ...extra };
  s.wantKey = false;
  s.shotReq = 0;
  s.ctlDirty = false;
  return out;
}

function flushWaiter(s: Session): void {
  if (s.nas) {
    if (s.wantKey) { s.wantKey = false; s.nas.resend(); }
    s.ctlDirty = false; s.shotReq = 0;
    if (s.events.length) s.nas.input(s.events.splice(0, s.events.length) as NasEvent[]);
    return;
  }
  const w = s.waiter;
  if (!w) return;
  if (!s.ended && !s.events.length && !s.wantKey && !s.ctlDirty && !s.shotReq) return;
  s.waiter = null;
  clearTimeout(w.timer);
  const events = s.events.splice(0, s.events.length);
  try { w.res.json(ctl(s, { events })); } catch { /* gone */ }
}

async function end(s: Session, reason: string): Promise<void> {
  if (s.ended) return;
  s.ended = true;
  Object.values(s.timers).forEach((t) => t && clearTimeout(t));
  if (s.timers.ping) clearInterval(s.timers.ping);
  flushWaiter(s);
  if (s.unsub) { s.unsub(); s.unsub = null; }
  for (const v of s.viewers) { status(v, { status: 'ended', reason }); try { v.res.end(); } catch { /* gone */ } }
  s.viewers.clear();
  // keep it a minute so the helper still gets "stop" instead of a bare 404
  setTimeout(() => sessions.delete(s.sid), 60_000);
  await auditLog(s.userId, 'device.remote.end', 'device', s.deviceId, s.ip, {
    device: s.deviceName, reason, control: s.control, seconds: Math.round((Date.now() - s.started) / 1000), frames: s.frames, mb: Math.round(s.bytes / 1e5) / 10,
  }).catch(() => undefined);
}

function scheduleIdle(s: Session): void {
  if (s.timers.idle) clearTimeout(s.timers.idle);
  s.timers.idle = setTimeout(() => {
    if (s.viewers.size) return;
    const quiet = Date.now() - s.claudeAt;
    if (quiet < CLAUDE_IDLE_MS) { scheduleIdle(s); return; }
    void end(s, s.claudeAt ? 'Claude klaar' : 'venster gesloten');
  }, IDLE_END_MS);
}

// ── Agent helper ─────────────────────────────────────────────

function agentSession(req: Request): Session | null {
  const s = sessions.get(String(req.params.sid));
  const k = Buffer.from(String(req.headers['x-remote-key'] ?? ''));
  if (!s || k.length !== s.key.length || !timingSafeEqual(k, Buffer.from(s.key))) return null;
  alive(s);
  return s;
}

/** The helper answered: if viewers were told the link dropped, tell them it is back. */
function alive(s: Session): void {
  s.agentAt = Date.now();
  if (s.stalled) { s.stalled = false; for (const v of s.viewers) status(v, { status: 'live' }); }
}

// A connection hiccup (wifi switch, router) usually lasts 1-10 s. The helper sends at least a heartbeat
// frame every 5 s, so 8 s of silence means trouble: viewers see "reconnecting"; after 45 s it is over.
// A real shutdown or sleep does not wait for this: the agent reports it (endDeviceSessions).
const STALL_MS = 8_000;
const DEAD_MS = 45_000;
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.ended || !s.firstFrame || s.nas) continue;
    const quiet = now - s.agentAt;
    if (quiet > DEAD_MS) { void end(s, 'de pc reageert niet meer (uitgeschakeld of geen netwerk)'); continue; }
    if (quiet > STALL_MS && !s.stalled) { s.stalled = true; for (const v of s.viewers) status(v, { status: 'stalled' }); }
  }
}, 2_000).unref();

/** The agent reported shutdown, restart or sleep: end its sessions at once with that reason. */
export function endDeviceSessions(deviceId: string, reason: string): number {
  let n = 0;
  for (const s of sessions.values()) if (s.deviceId === deviceId && !s.ended) { void end(s, reason); n++; }
  return n;
}

function deliverFrame(s: Session, body: Buffer): void {
  const isKey = (body[1] & 1) === 1;
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
  for (const v of s.viewers) {
    if (v.needKey && !isKey) continue;
    // a slow viewer skips frames until the next key frame, so its picture never gets corrupted
    if (v.res.writableNeedDrain) { v.needKey = true; s.wantKey = true; continue; }
    try { v.res.write(head); v.res.write(body); v.needKey = false; } catch { /* gone */ }
  }
}

/** A screencast JPEG as one full-screen key rect in the agent frame format (no cursor: the page draws its own). */
function nasFrame(jpeg: Buffer, w: number, h: number): Buffer {
  const b = Buffer.alloc(30 + jpeg.length);
  b[0] = 1; b[1] = 1; b.writeUInt16LE(w, 2); b.writeUInt16LE(h, 4); b.writeUInt16LE(1, 6);
  b.writeInt32LE(-1, 8); b.writeInt32LE(0, 12); b.writeUInt16LE(1, 16);
  b.writeUInt16LE(0, 18); b.writeUInt16LE(0, 20); b.writeUInt16LE(w, 22); b.writeUInt16LE(h, 24); b.writeUInt32LE(jpeg.length, 26);
  jpeg.copy(b, 30);
  return b;
}

remoteRouter.post('/agent/:sid/frame', express.raw({ type: 'application/octet-stream', limit: '40mb' }), (req: Request, res: Response) => {
  const s = agentSession(req);
  if (!s) { res.status(404).json({ stop: true }); return; }
  if (s.ended) { res.json({ stop: true }); return; }
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 18 || body[0] !== 1) { res.status(400).json({ error: 'ongeldig frame' }); return; }
  if (!s.firstFrame) { s.firstFrame = Date.now(); if (s.timers.start) clearTimeout(s.timers.start); }
  s.frames++; s.bytes += body.length;
  deliverFrame(s, body);
  res.json(ctl(s));
});

remoteRouter.post('/agent/:sid/input', (req: Request, res: Response) => {
  const s = agentSession(req);
  if (!s) { res.status(404).json({ stop: true }); return; }
  if (s.waiter) { clearTimeout(s.waiter.timer); try { s.waiter.res.json(ctl(s, { events: [] })); } catch { /* gone */ } }
  const timer = setTimeout(() => {
    if (s.waiter?.res === res) s.waiter = null;
    try { res.json(ctl(s, { events: [] })); } catch { /* gone */ }
  }, HOLD_MS);
  s.waiter = { res, timer };
  res.on('close', () => { if (s.waiter?.res === res) { clearTimeout(timer); s.waiter = null; } });
  if (s.ended || s.events.length || s.wantKey || s.ctlDirty || s.shotReq) flushWaiter(s);
});

// the person at the PC clicked the red button on the island: end the session
remoteRouter.post('/agent/:sid/hangup', (req: Request, res: Response) => {
  const s = agentSession(req);
  if (!s) { res.status(404).json({ stop: true }); return; }
  void end(s, 'gestopt op de pc');
  res.json({ stop: true });
});

// the operator's photo for the pill on the PC (asked once by the helper)
remoteRouter.post('/agent/:sid/avatar', (req: Request, res: Response) => {
  const s = agentSession(req);
  if (!s || !s.avatar) { res.status(404).end(); return; }
  res.type('application/octet-stream').send(s.avatar);
});

remoteRouter.post('/agent/:sid/shot', express.raw({ type: 'application/octet-stream', limit: '20mb' }), (req: Request, res: Response) => {
  const s = agentSession(req);
  if (!s) { res.status(404).json({ stop: true }); return; }
  const b = req.body as Buffer;
  if (Buffer.isBuffer(b) && b.length > 8) {
    s.shot = { w: b.readUInt16LE(0), h: b.readUInt16LE(2), jpeg: b.subarray(4), at: Date.now() };
    s.shotWaiters.splice(0).forEach((f) => f());
  }
  res.json(ctl(s));
});

// ── Browser ──────────────────────────────────────────────────

const scopeOf = (req: Request): dev.Scope => dev.requestScope(req);

function userSession(req: Request): Session {
  const s = sessions.get(String(req.params.sid));
  if (!s || s.ended) throw new AppError(404, 'Sessie beëindigd');
  if (s.userId !== req.user!.userId) throw new AppError(403, 'Geen toegang');
  if (s.deviceId !== String(req.params.id)) throw new AppError(404, 'Sessie hoort bij een ander apparaat');
  return s;
}

/** First name of the user, shown next to the cursor on the PC ("Sam"). */
async function firstName(userId: string): Promise<string> {
  try {
    const r = await query<{ name: string | null; email: string }>('SELECT name, email FROM users WHERE id = $1', [userId]);
    const n = (r.rows[0]?.name || r.rows[0]?.email.split('@')[0] || '').trim().split(/\s+/)[0];
    return n ? n.slice(0, 24) : 'Beheerder';
  } catch { return 'Beheerder'; }
}

/** Accent colour, initials and photo of the operator, for the pill on the PC. */
async function looks(userId: string): Promise<{ accent: string; initials: string; avatar: Buffer | null }> {
  try {
    const r = await query<{ name: string | null; email: string; avatar: string | null; accent_color: string | null }>(
      'SELECT name, email, avatar, accent_color FROM users WHERE id = $1', [userId]);
    const u = r.rows[0];
    const words = (u?.name || u?.email.split('@')[0] || '?').trim().split(/\s+/);
    const initials = (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
    const m = u?.avatar?.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
    return { accent: u?.accent_color || '#CC785C', initials, avatar: m ? Buffer.from(m[2], 'base64') : null };
  } catch { return { accent: '#CC785C', initials: '?', avatar: null }; }
}

/** "Sam kijkt mee" on the PC: on unless the operator switched it off in Profiel. */
async function noticeOn(userId: string): Promise<boolean> {
  try {
    const r = await query<{ on: boolean | null }>("SELECT (preferences->>'remote_notice')::boolean AS on FROM users WHERE id = $1", [userId]);
    return r.rows[0]?.on !== false;
  } catch { return true; }
}

type DeviceInfo = NonNullable<Awaited<ReturnType<typeof dev.getDevice>>>;

async function openNasSession(d: DeviceInfo, userId: string, ip: string, by: 'viewer' | 'claude'): Promise<Session> {
  if (d.os !== 'nasbrowser' || !d.enabled) throw new AppError(409, `${d.name} is niet beschikbaar`);
  let nas: NasBrowser;
  try { nas = await getNas(userId); }
  catch (err) { throw new AppError(502, `${dev.NAS_NAME} starten mislukt: ${String((err as Error).message).split('\n')[0].slice(0, 200)}`); }
  const sid = randomBytes(16).toString('hex');
  const s: Session = {
    sid, key: randomBytes(24).toString('hex'), deviceId: d.id, deviceName: d.name, userId, ip,
    viewers: new Set(), events: [], waiter: null, wantKey: true, quality: 55, scale: 1, ctlDirty: false,
    started: Date.now(), firstFrame: 0, frames: 0, bytes: 0, control: false, timers: {}, ended: false,
    shotReq: 0, shot: null, shotWaiters: [], claudeAt: by === 'claude' ? Date.now() : 0,
    userName: '', nameSent: true, notice: false, accent: '', initials: '', avatar: null, claudeOnly: by === 'claude', agentAt: Date.now(), stalled: false,
    nas, unsub: null,
  };
  s.unsub = nas.subscribe({
    frame: (jpeg, w, h) => {
      if (s.ended) return;
      if (!s.firstFrame) { s.firstFrame = Date.now(); for (const v of s.viewers) status(v, { status: 'live' }); }
      const body = nasFrame(jpeg, w, h);
      s.frames++; s.bytes += body.length;
      deliverFrame(s, body);
    },
    state: (st: NasState) => { for (const v of s.viewers) status(v, { status: 'tabs', ...st }); },
    cursor: (c: string) => { for (const v of s.viewers) status(v, { status: 'cursor', c }); },
  });
  sessions.set(sid, s);
  scheduleIdle(s);
  await auditLog(userId, 'device.remote.start', 'device', d.id, ip, { device: d.name, by, nas: true });
  return s;
}

// the browser closed itself (idle, crash): end the viewer sessions with that reason
onNasClosed((userId, reason) => {
  for (const s of sessions.values()) if (s.nas && s.userId === userId && !s.ended) void end(s, `de browser is gestopt (${reason})`);
});

async function openSession(d: DeviceInfo, userId: string, ip: string, quality: number, scale: number, by: 'viewer' | 'claude'): Promise<Session> {
  if (d.os === 'nasbrowser') return openNasSession(d, userId, ip, by);
  if (!d.online) throw new AppError(409, `${d.name} is offline`);
  if (d.os !== 'windows' && d.os !== 'darwin') throw new AppError(409, 'Meekijken werkt alleen op Windows en macOS');
  if (d.os === 'darwin' && !atLeast(d.agent_version, MAC_MIN)) throw new AppError(409, `Agent ${d.agent_version ?? '?'} kan op een Mac nog niet meekijken; werk de agent bij naar ${MAC_MIN.join('.')} of nieuwer`);
  if (!versionOk(d.agent_version)) throw new AppError(409, `Agent ${d.agent_version ?? '?'} is te oud voor meekijken; werk de agent bij naar ${MIN_AGENT.join('.')} of nieuwer`);
  const sid = randomBytes(16).toString('hex');
  const key = randomBytes(24).toString('hex');
  const s: Session = {
    sid, key, deviceId: d.id, deviceName: d.name, userId, ip,
    viewers: new Set(), events: [], waiter: null, wantKey: true, quality, scale, ctlDirty: false,
    started: Date.now(), firstFrame: 0, frames: 0, bytes: 0, control: false, timers: {}, ended: false,
    shotReq: 0, shot: null, shotWaiters: [], claudeAt: by === 'claude' ? Date.now() : 0,
    userName: await firstName(userId), nameSent: false, notice: await noticeOn(userId), ...(await looks(userId)), claudeOnly: by === 'claude', agentAt: Date.now(), stalled: false,
    nas: null, unsub: null,
  };
  sessions.set(sid, s);
  const r = await dev.runJob(d.id, { type: 'remote', session: sid, key }, 20_000);
  if (!r.ok) { sessions.delete(sid); throw new AppError(502, `Meekijken starten mislukt: ${r.error || r.output || 'onbekende fout'}`); }
  s.timers.start = setTimeout(() => void end(s, 'het apparaat stuurt geen beeld'), START_TIMEOUT_MS);
  scheduleIdle(s);
  await auditLog(userId, 'device.remote.start', 'device', d.id, ip, { device: d.name, by });
  return s;
}

remoteRouter.post('/:id/start', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ quality: z.number().int().min(10).max(95).optional(), scale: z.union([z.literal(1), z.literal(2)]).optional() }).parse(req.body ?? {});
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    // one helper per PC: a second window (phone and laptop at once) joins the session that runs
    const running = [...sessions.values()].find((x) => x.deviceId === d.id && !x.ended && x.userId === req.user!.userId);
    if (running) { running.claudeOnly = false; running.ctlDirty = true; flushWaiter(running); res.json({ sid: running.sid, joined: true }); return; }
    const s = await openSession(d, req.user!.userId, req.ip ?? '', body.quality ?? 55, body.scale ?? 1, 'viewer');
    res.json({ sid: s.sid });
  } catch (err) { next(err); }
});

remoteRouter.get('/:id/s/:sid/stream', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = userSession(req);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    const v: Viewer = { res, needKey: true };
    s.viewers.add(v);
    s.wantKey = true;
    flushWaiter(s);
    status(v, { status: s.firstFrame ? 'live' : 'starting' });
    if (s.nas) void s.nas.state().then((st) => status(v, { status: 'tabs', ...st }));
    // keeps proxies from closing a quiet stream (static screen)
    const ping = setInterval(() => { const z0 = Buffer.alloc(4); try { res.write(z0); } catch { /* gone */ } }, 15_000);
    res.on('close', () => { clearInterval(ping); s.viewers.delete(v); if (!s.viewers.size) scheduleIdle(s); });
  } catch (err) { next(err); }
});

const inputBody = z.object({
  events: z.array(z.object({
    t: z.enum(['m', 'd', 'u', 'w', 'k', 'text']), x: z.number().int().optional(), y: z.number().int().optional(), b: z.number().int().optional(),
    dx: z.number().int().optional(), dy: z.number().int().optional(), c: z.string().max(40).optional(), down: z.boolean().optional(), s: z.string().max(5000).optional(),
  })).max(500).optional(),
  key: z.boolean().optional(), quality: z.number().int().min(10).max(95).optional(), scale: z.union([z.literal(1), z.literal(2)]).optional(),
});

remoteRouter.post('/:id/s/:sid/input', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = userSession(req);
    const b = inputBody.parse(req.body ?? {});
    if (b.events?.length) {
      if (!s.control) {
        s.control = true;
        void auditLog(s.userId, 'device.remote.control', 'device', s.deviceId, s.ip, { device: s.deviceName }).catch(() => undefined);
      }
      s.events.push(...b.events);
      if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    }
    if (b.key) s.wantKey = true;
    if (b.quality && b.quality !== s.quality) { s.quality = b.quality; s.ctlDirty = true; }
    if (b.scale && b.scale !== s.scale) { s.scale = b.scale; s.ctlDirty = true; }
    flushWaiter(s);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// address bar of the Browser (NAS): back, forward, reload, navigate, tabs
const browserCmd = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.enum(['back', 'forward', 'reload', 'stop']) }),
  z.object({ cmd: z.literal('navigate'), url: z.string().min(1).max(4000) }),
  z.object({ cmd: z.literal('tab-new'), url: z.string().max(4000).optional() }),
  z.object({ cmd: z.enum(['tab-close', 'tab-focus']), id: z.number().int().min(0) }),
]);

remoteRouter.post('/:id/s/:sid/browser', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = userSession(req);
    if (!s.nas) throw new AppError(400, `Alleen voor ${dev.NAS_NAME}`);
    const c = browserCmd.parse(req.body ?? {});
    s.control = true;
    await s.nas.command(c);
    if (c.cmd === 'navigate') await auditLog(s.userId, 'device.browser.navigate', 'device', s.deviceId, s.ip, { device: s.deviceName, nas: true, by: 'viewer', url: normalizeUrl(c.url).slice(0, 300) }).catch(() => undefined);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

const pwBody = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['save', 'never', 'dismiss']) }),
  z.object({ action: z.literal('fill'), id: z.string().uuid() }),
]);

/** Password manager bar: answer to "save password?" and manual fill. Never carries a password. */
remoteRouter.post('/:id/s/:sid/pw', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = userSession(req);
    if (!s.nas) throw new AppError(400, `Alleen voor ${dev.NAS_NAME}`);
    const b = pwBody.parse(req.body ?? {});
    s.control = true;
    if (b.action === 'fill') {
      const r = await s.nas.pwFill(b.id).catch((err: Error) => { throw new AppError(409, err.message); });
      await auditLog(s.userId, 'device.browser.password.fill', 'device', s.deviceId, s.ip, { device: s.deviceName, nas: true, by: 'viewer', account: b.id }).catch(() => undefined);
      res.json({ ok: true, ...r });
      return;
    }
    await s.nas.pwAnswer(b.action);
    if (b.action === 'save') await auditLog(s.userId, 'device.browser.password.save', 'device', s.deviceId, s.ip, { device: s.deviceName, nas: true }).catch(() => undefined);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

remoteRouter.post('/:id/s/:sid/sas', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = userSession(req);
    const r = await dev.runJob(s.deviceId, { type: 'sas' }, 15_000);
    await auditLog(s.userId, 'device.remote.sas', 'device', s.deviceId, s.ip, { device: s.deviceName, ok: r.ok });
    if (!r.ok) throw new AppError(502, r.error || 'Ctrl+Alt+Del mislukt');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

remoteRouter.delete('/:id/s/:sid', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = userSession(req);
    // another window still watches this session: only this one leaves
    if (s.viewers.size > 1) { res.json({ ok: true, left: true }); return; }
    await end(s, 'gestopt door gebruiker');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Claude (via /devices/claude/:dev/screen and /act) ────────
// Claude works in the open viewer session of the device, or starts one without a viewer.
// Every mouse action is announced to the viewers first, so the Claude cursor glides there before it clicks.

const CLAUDE_MIN = [1, 3, 2];
const MAC_MIN = [1, 5, 0];
const SHOT_W = 1280;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const atLeast = (v: string | null, min: number[]) => {
  const p = (v ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((p[i] ?? 0) !== min[i]) return (p[i] ?? 0) > min[i]; }
  return true;
};

function tell(s: Session, body: Record<string, unknown>): void {
  for (const v of s.viewers) status(v, { status: 'claude', ...body });
}

function queue(s: Session, ...events: Array<Record<string, unknown>>): void {
  s.events.push(...events.map((e) => ({ ...e, by: 'claude' })));
  flushWaiter(s);
}

async function claudeSession(d: DeviceInfo, userId: string): Promise<Session> {
  if (d.os !== 'nasbrowser' && !atLeast(d.agent_version, CLAUDE_MIN)) throw new AppError(409, `Agent ${d.agent_version ?? '?'} kan nog geen schermafbeeldingen voor Claude maken; werk de agent bij naar ${CLAUDE_MIN.join('.')}`);
  const open = [...sessions.values()].filter((x) => x.deviceId === d.id && !x.ended).sort((a, b) => b.started - a.started);
  const s = open[0] ?? await openSession(d, userId, '', 55, 1, 'claude');
  s.claudeAt = Date.now();
  return s;
}

/** Fresh screenshot (max 1280 wide) as JPEG; its pixel size is the coordinate space for act(). */
export async function claudeScreen(d: DeviceInfo, userId: string): Promise<{ jpeg: Buffer; w: number; h: number }> {
  const s = await claudeSession(d, userId);
  tell(s, { t: 'look' });
  if (s.nas) {
    const shot = await s.nas.screenshot().catch((err: Error) => { throw new AppError(502, `Schermafbeelding mislukt: ${err.message.split('\n')[0]}`); });
    s.shot = { ...shot, at: Date.now() };
    return shot;
  }
  const before = s.shot?.at ?? 0;
  const got = new Promise<void>((resolve) => s.shotWaiters.push(resolve));
  s.shotReq = SHOT_W;
  flushWaiter(s);
  await Promise.race([got, sleep(s.firstFrame ? 8000 : 25_000)]);
  if (!s.shot || s.shot.at === before) throw new AppError(504, 'Geen schermafbeelding ontvangen van het apparaat');
  return { jpeg: s.shot.jpeg, w: s.shot.w, h: s.shot.h };
}

const KEY_NAMES: Record<string, string> = {
  ctrl: 'ControlLeft', control: 'ControlLeft', alt: 'AltLeft', option: 'AltLeft', opt: 'AltLeft', command: 'MetaLeft', shift: 'ShiftLeft', win: 'MetaLeft', meta: 'MetaLeft', cmd: 'MetaLeft',
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  space: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', printscreen: 'PrintScreen', menu: 'ContextMenu',
};
const keyCode = (k: string): string | null => {
  const x = k.trim().toLowerCase();
  if (KEY_NAMES[x]) return KEY_NAMES[x];
  if (/^f([1-9]|1[0-2])$/.test(x)) return x.toUpperCase();
  if (/^[a-z]$/.test(x)) return `Key${x.toUpperCase()}`;
  if (/^[0-9]$/.test(x)) return `Digit${x}`;
  return null;
};

const actionSchema = z.object({
  click: z.tuple([z.number(), z.number()]).optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  double: z.boolean().optional(),
  move: z.tuple([z.number(), z.number()]).optional(),
  drag: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  scroll: z.tuple([z.number(), z.number(), z.number()]).optional(),
  type: z.string().max(5000).optional(),
  key: z.string().max(60).optional(),
  wait: z.number().min(0).max(10_000).optional(),
});
const actSchemaList = z.array(actionSchema);
export const actBody = z.object({ actions: actSchemaList.min(1).max(50) });

export async function claudeAct(d: DeviceInfo, userId: string, actions: z.infer<typeof actSchemaList>): Promise<{ done: number }> {
  const s = await claudeSession(d, userId);
  if (!s.shot) throw new AppError(409, 'Maak eerst een schermafbeelding (screen); de coordinaten horen bij die afbeelding');
  const { w, h } = s.shot;
  const nx = (x: number) => Math.round(Math.min(1, Math.max(0, x / w)) * 65535);
  const ny = (y: number) => Math.round(Math.min(1, Math.max(0, y / h)) * 65535);
  const moveTo = async (x: number, y: number) => {
    const p = { x: nx(x), y: ny(y) };
    tell(s, { t: 'move', ...p });
    queue(s, { t: 'm', ...p });
    await sleep(s.viewers.size ? 420 : 30); // let the cursor arrive before the click
    return p;
  };
  let done = 0;
  for (const a of actions) {
    if (s.ended) throw new AppError(410, 'Sessie beëindigd');
    s.claudeAt = Date.now();
    if (a.click) {
      const p = await moveTo(a.click[0], a.click[1]);
      const b = a.button === 'right' ? 2 : a.button === 'middle' ? 1 : 0;
      for (let i = 0; i < (a.double ? 2 : 1); i++) { tell(s, { t: 'click', ...p }); queue(s, { t: 'd', b, ...p }, { t: 'u', b, ...p }); await sleep(60); }
    } else if (a.move) {
      await moveTo(a.move[0], a.move[1]);
    } else if (a.drag) {
      const p = await moveTo(a.drag[0], a.drag[1]);
      queue(s, { t: 'd', b: 0, ...p });
      const q = { x: nx(a.drag[2]), y: ny(a.drag[3]) };
      tell(s, { t: 'move', ...q });
      for (let i = 1; i <= 8; i++) queue(s, { t: 'm', x: Math.round(p.x + ((q.x - p.x) * i) / 8), y: Math.round(p.y + ((q.y - p.y) * i) / 8) });
      await sleep(300);
      queue(s, { t: 'u', b: 0, ...q });
    } else if (a.scroll) {
      await moveTo(a.scroll[0], a.scroll[1]);
      queue(s, { t: 'w', dy: Math.round(Math.max(-30, Math.min(30, a.scroll[2])) * 120) });
    } else if (a.type !== undefined) {
      tell(s, { t: 'type' });
      queue(s, { t: 'text', s: a.type });
    } else if (a.key) {
      const codes = a.key.split('+').map(keyCode);
      if (codes.some((c) => !c)) throw new AppError(400, `Onbekende toets in "${a.key}"`);
      tell(s, { t: 'type' });
      queue(s, ...codes.map((c) => ({ t: 'k', c, down: true })), ...[...codes].reverse().map((c) => ({ t: 'k', c, down: false })));
    } else if (a.wait) {
      tell(s, { t: 'look' });
      await sleep(a.wait);
    }
    done++;
    await sleep(80);
  }
  await sleep(250); // give the screen a moment before Claude looks again
  if (!s.control) s.control = true;
  await auditLog(userId, 'device.remote.claude', 'device', d.id, '', {
    device: d.name, actions: actions.map((a) => Object.keys(a).filter((k) => k !== 'type').join(',') + (a.type !== undefined ? `type(${a.type.length})` : '')).join('; ').slice(0, 500),
  }).catch(() => undefined);
  return { done };
}
