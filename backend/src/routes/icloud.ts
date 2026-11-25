import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { simpleParser } from 'mailparser';
import type { ImapFlow } from 'imapflow';
import { AppError } from '../middleware/errorHandler';
import { icloudForToken, withIcloud } from '../services/icloud';

/** Claude inside this container: loopback + per-run token (x-icloud-token). Read, search, move, flag, draft; no send, no delete. */
export const icloudRouter = Router();
const claude = Router();
claude.use(express.json({ limit: '5mb' }));
type Who = { userId: string; connectorId: string };
claude.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const who = await icloudForToken(String(req.headers['x-icloud-token'] ?? ''));
    if (!who) throw new AppError(401, 'Token ongeldig of verlopen (alleen toegekende agents krijgen een token)');
    (req as Request & { ic?: Who }).ic = who;
    next();
  } catch (err) { next(err); }
});

const run = <T>(req: Request, fn: (c: ImapFlow) => Promise<T>) => { const w = (req as Request & { ic?: Who }).ic!; return withIcloud(w.userId, w.connectorId, fn); };
const str = (v: unknown, what: string, max = 500): string => {
  if (typeof v !== 'string' || !v.length || v.length > max) throw new AppError(400, `${what} ontbreekt of is ongeldig`);
  return v;
};
const uidOf = (v: unknown): number => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'uid ongeldig'); return n; };
const wrap = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { h(req, res).catch(next); };
const addr = (a?: { name?: string; address?: string }[]) => (a ?? []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address ?? '')).join(', ');
const MAX_BODY = 20000;

// GET /icloud/claude/folders
claude.get('/folders', wrap(async (req, res) => {
  const out = await run(req, async (c) => (await c.list()).map((m) => ({ path: m.path, specialUse: m.specialUse ?? null, flags: [...(m.flags ?? [])] })));
  res.json({ folders: out });
}));

// POST /messages {folder, from?, subject?, text?, unseen?, flagged?, since?, limit?}  (newest first)
claude.post('/messages', wrap(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const folder = str(b.folder ?? 'INBOX', 'folder');
  const limit = Math.min(Math.max(Number(b.limit) || 25, 1), 100);
  const crit: Record<string, unknown> = {};
  if (typeof b.from === 'string' && b.from) crit.from = b.from;
  if (typeof b.subject === 'string' && b.subject) crit.subject = b.subject;
  if (typeof b.text === 'string' && b.text) crit.body = b.text;
  if (b.unseen === true) crit.seen = false;
  if (b.flagged === true) crit.flagged = true;
  if (typeof b.since === 'string' && !isNaN(Date.parse(b.since))) crit.since = new Date(b.since);
  const out = await run(req, async (c) => {
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    try {
      const found = (await c.search(Object.keys(crit).length ? crit : { all: true }, { uid: true })) || [];
      const uids = found.sort((a, z) => z - a).slice(0, limit);
      const rows: unknown[] = [];
      if (uids.length) {
        for await (const m of c.fetch(uids, { uid: true, flags: true, envelope: true }, { uid: true })) {
          rows.push({ uid: m.uid, from: addr(m.envelope?.from), subject: m.envelope?.subject ?? '', date: m.envelope?.date ?? null, flags: [...(m.flags ?? [])] });
        }
      }
      return { total: found.length, messages: (rows as { uid: number }[]).sort((a, z) => z.uid - a.uid) };
    } finally { lock.release(); }
  });
  res.json(out);
}));

// POST /search {folder, text, limit?}  (UID SEARCH TEXT)
claude.post('/search', wrap(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const folder = str(b.folder ?? 'INBOX', 'folder');
  const text = str(b.text, 'text', 200);
  const limit = Math.min(Math.max(Number(b.limit) || 25, 1), 100);
  const out = await run(req, async (c) => {
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    try {
      const found = (await c.search({ text }, { uid: true })) || [];
      const uids = found.sort((a, z) => z - a).slice(0, limit);
      const rows: { uid: number }[] = [];
      if (uids.length) {
        for await (const m of c.fetch(uids, { uid: true, flags: true, envelope: true }, { uid: true })) {
          rows.push({ uid: m.uid, from: addr(m.envelope?.from), subject: m.envelope?.subject ?? '', date: m.envelope?.date ?? null, flags: [...(m.flags ?? [])] } as { uid: number });
        }
      }
      return { total: found.length, messages: rows.sort((a, z) => z.uid - a.uid) };
    } finally { lock.release(); }
  });
  res.json(out);
}));

// POST /read {folder, uid}  (BODY.PEEK[]: read status unchanged)
claude.post('/read', wrap(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const folder = str(b.folder ?? 'INBOX', 'folder');
  const uid = uidOf(b.uid);
  const out = await run(req, async (c) => {
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    try {
      const m = await c.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
      if (!m || !m.source) throw new AppError(404, 'Bericht niet gevonden');
      const p = await simpleParser(m.source);
      const html = typeof p.html === 'string' ? p.html : '';
      const text = (p.text && p.text.trim()) ? p.text : html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
      return {
        uid, flags: [...(m.flags ?? [])], from: p.from?.text ?? '', to: p.to ? (Array.isArray(p.to) ? p.to.map((x) => x.text).join(', ') : p.to.text) : '',
        cc: p.cc ? (Array.isArray(p.cc) ? p.cc.map((x) => x.text).join(', ') : p.cc.text) : '', subject: p.subject ?? '', date: p.date ?? null,
        attachments: (p.attachments ?? []).map((a) => ({ filename: a.filename ?? '(naamloos)', contentType: a.contentType, size: a.size })),
        text: text.slice(0, MAX_BODY), truncated: text.length > MAX_BODY,
      };
    } finally { lock.release(); }
  });
  res.json(out);
}));

// POST /move {folder, uid, to}  (UID MOVE, target folder must exist)
claude.post('/move', wrap(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const folder = str(b.folder ?? 'INBOX', 'folder');
  const to = str(b.to, 'to');
  const uid = uidOf(b.uid);
  await run(req, async (c) => {
    const boxes = await c.list();
    if (!boxes.some((m) => m.path === to)) throw new AppError(404, `Doelmap "${to}" bestaat niet (zie /folders)`);
    const lock = await c.getMailboxLock(folder);
    try { await c.messageMove(String(uid), to, { uid: true }); } finally { lock.release(); }
  });
  res.json({ ok: true, uid, from: folder, to });
}));

// POST /flag {folder, uid, flagged: boolean}  (only \Flagged)
claude.post('/flag', wrap(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const folder = str(b.folder ?? 'INBOX', 'folder');
  const uid = uidOf(b.uid);
  if (typeof b.flagged !== 'boolean') throw new AppError(400, 'flagged (true of false) ontbreekt');
  await run(req, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      if (b.flagged) await c.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
      else await c.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
    } finally { lock.release(); }
  });
  res.json({ ok: true, uid, flagged: b.flagged });
}));

const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

// POST /draft {to, subject, text, cc?, from?}  -> APPEND to "Drafts" with (\Draft \Seen). Nothing is sent.
claude.post('/draft', wrap(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const to = clean(str(b.to, 'to', 500)), subject = clean(str(b.subject ?? '', 'subject', 300).toString() || ''), text = str(b.text, 'text', 100000);
  const cc = typeof b.cc === 'string' ? clean(b.cc).slice(0, 500) : '';
  const out = await run(req, async (c) => {
    const user = (c as unknown as { authenticated?: string }).authenticated;
    const from = typeof b.from === 'string' && b.from ? clean(b.from).slice(0, 200) : '';
    const raw = [
      from ? `From: ${from}` : (user ? `From: ${user}` : ''),
      `To: ${to}`, cc ? `Cc: ${cc}` : '', `Subject: ${encWord(subject)}`, `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'X-Unsent: 1', '',
      (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'), '',
    ].filter((l, i) => l !== '' || i >= 8).join('\r\n');
    const r = await c.append('Drafts', raw, ['\\Draft', '\\Seen']);
    return { ok: true, folder: 'Drafts', uid: r ? r.uid ?? null : null };
  });
  res.json(out);
}));

claude.use((_req, _res, next) => next(new AppError(404, 'Onbekend pad: gebruik /folders, /messages, /search, /read, /move, /flag of /draft')));
icloudRouter.use('/claude', claude);
