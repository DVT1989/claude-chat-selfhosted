import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createReadStream } from 'fs';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, requireAdmin, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { userForMemoryToken } from '../services/memory';
import * as fed from '../services/federation';
import * as chat from '../services/federationChat';

export const federationRouter = Router();
federationRouter.use(rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } }));

type FReq = Request & { fedKey?: { id: string; direction: 'read' | 'readwrite'; created_by: string | null }; fedInstall?: string };

// ── key-authenticated part (other installation) ───────────────
const keyAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
    const k = m ? await fed.authKey(m[1].trim()) : null;
    if (!k) throw new AppError(401, 'Sleutel ongeldig of ingetrokken');
    (req as FReq).fedKey = k;
    const inst = String(req.headers['x-federation-install'] ?? '');
    (req as FReq).fedInstall = /^[0-9a-f-]{36}$/.test(inst) ? inst : undefined;
    next();
  } catch (e) { next(e); }
};

federationRouter.get('/manifest', keyAuth, async (req, res, next) => {
  try { res.json(await fed.manifest((req as FReq).fedKey!.direction)); } catch (e) { next(e); }
});

federationRouter.get('/export/:kind', keyAuth, async (req, res, next) => {
  try {
    const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined;
    res.json(await fed.exportPage(String(req.params.kind), fed.parseCursor(req.query.after), Number(req.query.limit) || 20, (req as FReq).fedInstall ?? null, owner));
  } catch (e) { next(e); }
});

federationRouter.get('/attachments/:id', keyAuth, async (req, res, next) => {
  try {
    const f = await fed.findAttachment(String(req.params.id));
    if (!f) throw new AppError(404, 'Bijlage niet gevonden');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(f.size));
    createReadStream(f.path).on('error', next).pipe(res);
  } catch (e) { next(e); }
});

const writeOnly = (req: Request, _res: Response, next: NextFunction) =>
  (req as FReq).fedKey?.direction === 'readwrite' ? next() : next(new AppError(403, 'Deze sleutel mag alleen lezen'));

federationRouter.put('/attachments/:installId/:rid', keyAuth, writeOnly, express.raw({ type: '*/*', limit: '25mb' }), (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body)) throw new AppError(400, 'Geen data');
    fed.stageAttachment(String(req.params.installId), String(req.params.rid), req.body);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// the sender uses its own install id from the header
federationRouter.put('/attachments/:rid', keyAuth, writeOnly, express.raw({ type: '*/*', limit: '25mb' }), (req, res, next) => {
  try {
    const inst = (req as FReq).fedInstall;
    if (!inst || !Buffer.isBuffer(req.body)) throw new AppError(400, 'Geen data of installatie-id');
    fed.stageAttachment(inst, String(req.params.rid), req.body);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// consultation between admin chats (services/federationChat.ts): needs a two-way key, the other side answers read-only
federationRouter.post('/consult/ask', keyAuth, writeOnly, express.json({ limit: '200kb' }), async (req, res, next) => {
  try {
    const b = z.object({ question: z.string().min(1).max(20000), topic: z.string().min(1).max(64), round: z.number().int().optional(), reason: z.string().max(200).nullable().optional(), from: z.string().max(100).optional() }).parse(req.body);
    const r = await chat.receiveAsk((req as FReq).fedKey!, (req as FReq).fedInstall, b);
    res.status(202).json(r);
  } catch (e) {
    if (e instanceof AppError || e instanceof z.ZodError) return next(e);
    console.error('[federation] consult/ask mislukt:', e);
    next(new AppError(500, `Ontvanger kon het overleg niet starten: ${chat.scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 300)}`));
  }
});
federationRouter.get('/consult/:id', keyAuth, writeOnly, async (req, res, next) => {
  try { res.json(await chat.consultStatus(String(req.params.id))); } catch (e) { next(e); }
});

const importSchema = z.object({
  install: z.object({ id: z.string().uuid(), name: z.string().max(100) }),
  items: z.array(z.object({
    id: z.string().max(200), ts: z.string().max(40), owner_email: z.string().nullable(), hash: z.string().length(64), data: z.any(),
    origin: z.object({ install: z.string(), id: z.string() }).nullable().optional(),
  })).max(50),
});
federationRouter.post('/import/:kind', keyAuth, writeOnly, express.json({ limit: '30mb' }), async (req, res, next) => {
  try {
    const body = importSchema.parse(req.body);
    const key = (req as FReq).fedKey!;
    const admin = key.created_by ?? (await query<{ id: string }>(`SELECT id FROM users WHERE role='admin' AND is_active ORDER BY created_at LIMIT 1`)).rows[0]?.id;
    if (!admin) throw new AppError(500, 'Geen beheerder gevonden');
    const results = [];
    for (const item of body.items) {
      const r = await fed.applyIncoming({ install: body.install, kind: String(req.params.kind), item: item as fed.Item, fallbackAdmin: admin, peerId: null, pushed: false });
      results.push({ id: item.id, ...r });
    }
    res.json({ results });
  } catch (e) { next(e); }
});

// ── admin part (session or admin memory token from the admin chat) ──
const adminAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mt = req.headers['x-memory-token'];
    if (mt) {
      const addr = req.socket.remoteAddress ?? '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
      const uid = await userForMemoryToken(String(mt));
      if (!uid) throw new AppError(401, 'Token ongeldig of verlopen');
      const u = (await query<{ email: string; role: string }>('SELECT email, role FROM users WHERE id = $1 AND is_active', [uid])).rows[0];
      if (!u || u.role !== 'admin') throw new AppError(403, 'Alleen voor beheerders');
      req.user = { userId: uid, email: u.email, role: u.role, language: 'nl', theme: 'light' };
      return next();
    }
    return requireAuth(req, res, (err?: unknown) => (err ? next(err) : requireAdmin(req, res, next)));
  } catch (e) { next(e); }
};
const admin = Router();
admin.use(adminAuth, express.json({ limit: '1mb' }));
federationRouter.use('/admin', admin);

admin.get('/self', async (_req, res, next) => { try { res.json({ ...(await fed.selfInfo()), kinds: fed.KINDS.map((k) => ({ key: k, label: fed.KIND_LABEL[k] })) }); } catch (e) { next(e); } });
admin.patch('/self', async (req, res, next) => {
  try { await fed.setSelfName(z.object({ name: z.string().min(1).max(80) }).parse(req.body).name); res.json(await fed.selfInfo()); } catch (e) { next(e); }
});

admin.get('/keys', async (_req, res, next) => { try { res.json({ keys: await fed.listKeys() }); } catch (e) { next(e); } });
admin.post('/keys', async (req, res, next) => {
  try {
    const b = z.object({ name: z.string().min(1).max(80), direction: z.enum(['read', 'readwrite']) }).parse(req.body);
    const r = await fed.createKey(req.user!.userId, b.name, b.direction);
    await auditLog(req.user!.userId, 'federation.key.create', 'federation_key', r.item.id, req.ip ?? '', { direction: b.direction });
    res.status(201).json(r);
  } catch (e) { next(e); }
});
admin.delete('/keys/:id', async (req, res, next) => {
  try {
    if (!(await fed.revokeKey(String(req.params.id)))) throw new AppError(404, 'Sleutel niet gevonden');
    await auditLog(req.user!.userId, 'federation.key.revoke', 'federation_key', String(req.params.id), req.ip ?? '');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

admin.get('/peers', async (_req, res, next) => { try { res.json({ peers: await fed.listPeers() }); } catch (e) { next(e); } });
admin.post('/peers', async (req, res, next) => {
  try {
    const b = z.object({ name: z.string().min(1).max(80), url: z.string().min(8).max(300), apiKey: z.string().min(10).max(200), allUsers: z.boolean().optional() }).parse(req.body);
    const id = await fed.createPeer(req.user!.userId, b);
    await auditLog(req.user!.userId, 'federation.peer.create', 'federation_peer', id, req.ip ?? '');
    res.status(201).json({ id });
  } catch (e) { next(e); }
});
admin.patch('/peers/:id', async (req, res, next) => {
  try {
    const b = z.object({ name: z.string().max(80).optional(), url: z.string().max(300).optional(), apiKey: z.string().max(200).optional(),
      enabled: z.boolean().optional(), nightly: z.boolean().optional(), allUsers: z.boolean().optional(), kinds: z.record(z.string(), z.boolean()).optional() }).parse(req.body);
    const p = await fed.getPeer(String(req.params.id));
    await fed.updatePeer(p.id, b);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
admin.delete('/peers/:id', async (req, res, next) => {
  try { const p = await fed.getPeer(String(req.params.id)); await fed.deletePeer(p.id); await auditLog(req.user!.userId, 'federation.peer.delete', 'federation_peer', p.id, req.ip ?? ''); res.json({ ok: true }); } catch (e) { next(e); }
});
admin.post('/peers/:id/test', async (req, res, next) => {
  try { const p = await fed.getPeer(String(req.params.id)); res.json(await fed.testPeer(p.id)); } catch (e) { next(e); }
});
admin.post('/peers/:id/sync', async (req, res, next) => {
  try {
    const b = z.object({ kinds: z.array(z.string()).optional(), owner: z.string().optional(), push: z.boolean().optional() }).parse(req.body ?? {});
    const p = await fed.getPeer(String(req.params.id));
    res.json({ result: await fed.syncPeer(p.id, { ...b, manual: true }) });
  } catch (e) { next(e); }
});
admin.post('/peers/:id/import', async (req, res, next) => {
  try {
    const b = z.object({ kind: z.string(), match: z.string().min(1) }).parse(req.body);
    const p = await fed.getPeer(String(req.params.id));
    res.json({ results: await fed.importOnDemand(p.id, b.kind, b.match) });
  } catch (e) { next(e); }
});

admin.post('/peers/:id/ask', async (req, res, next) => {
  try {
    const b = z.object({ question: z.string().min(1).max(20000), conversationId: z.string().uuid(), reason: z.string().max(200).optional() }).parse(req.body);
    const out = await chat.ask(req.user!.userId, String(req.params.id), b);
    await auditLog(req.user!.userId, 'federation.consult.ask', 'federation_peer', String(req.params.id), req.ip ?? '', { round: out.round });
    res.json(out);
  } catch (e) { next(e); }
});
admin.get('/consults', async (_req, res, next) => { try { res.json({ consults: await chat.listConsults() }); } catch (e) { next(e); } });

admin.get('/conflicts', async (req, res, next) => {
  try { res.json({ conflicts: await fed.listConflicts(req.query.status === 'resolved' ? 'resolved' : 'open') }); } catch (e) { next(e); }
});
admin.post('/conflicts/:id/resolve', async (req, res, next) => {
  try {
    const b = z.object({ choice: z.enum(['local', 'remote']) }).parse(req.body);
    await fed.resolveConflict(String(req.params.id), b.choice);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
