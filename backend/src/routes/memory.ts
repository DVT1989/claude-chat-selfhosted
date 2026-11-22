import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { existsSync } from 'fs';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import * as mem from '../services/memory';
import { getUserHomeDir } from '../services/claudeCode';
import { listAccounts } from '../services/claudeAccounts';

export const memoryRouter = Router();

const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const addSchema = z.object({
  topic: z.string().trim().min(1).max(40),
  content: z.string().trim().min(3).max(4000),
  tags: z.string().max(200).optional(),
  pinned: z.boolean().optional(),
});
const patchSchema = addSchema.partial();

// ── Claude inside this container (loopback + per-run token) ──
const claude = Router();
claude.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const userId = await mem.userForMemoryToken(String(req.headers['x-memory-token'] ?? ''));
    if (!userId) throw new AppError(401, 'Token ongeldig of verlopen');
    (req as Request & { memUser?: string }).memUser = userId;
    next();
  } catch (err) { next(err); }
});
const uid = (req: Request) => (req as Request & { memUser?: string }).memUser!;
const brief = (m: mem.Memory) => ({ id: m.id, topic: m.topic, content: m.content, tags: m.tags || undefined, pinned: m.pinned || undefined });

claude.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '');
    const topic = req.query.topic ? String(req.query.topic) : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 30);
    res.json({ results: (await mem.searchMemories(uid(req), q, topic, limit)).map(brief) });
  } catch (err) { next(err); }
});
claude.get('/topics', async (req, res, next) => {
  try { res.json({ topics: await mem.topics(uid(req)) }); } catch (err) { next(err); }
});
claude.post('/', async (req, res, next) => {
  try {
    const b = addSchema.parse(req.body);
    const out = await mem.addMemory(uid(req), b);
    await auditLog(uid(req), 'memory.add', 'memory', out.id || null, '', { topic: b.topic, via: 'claude' });
    res.json(out);
  } catch (err) { next(err); }
});
claude.patch('/:id', async (req, res, next) => {
  try {
    if (!isId(String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    if (!await mem.updateMemory(uid(req), String(req.params.id), patchSchema.parse(req.body))) throw new AppError(404, 'Niet gevonden');
    res.json({ ok: true });
  } catch (err) { next(err); }
});
claude.delete('/:id', async (req, res, next) => {
  try {
    if (!isId(String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    if (!await mem.deleteMemory(uid(req), String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    await auditLog(uid(req), 'memory.delete', 'memory', String(req.params.id), '', { via: 'claude' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
memoryRouter.use('/claude', claude);

// ── The user in the app: view, edit, pin, delete, import ──
memoryRouter.use(requireAuth);
memoryRouter.get('/', async (req, res, next) => {
  try { res.json({ memories: await mem.listMemories(req.user!.userId) }); } catch (err) { next(err); }
});
memoryRouter.post('/', async (req, res, next) => {
  try {
    const out = await mem.addMemory(req.user!.userId, addSchema.parse(req.body));
    res.json({ ...out, memories: await mem.listMemories(req.user!.userId) });
  } catch (err) { next(err); }
});
memoryRouter.post('/import', async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const homes = [getUserHomeDir(userId), ...listAccounts(userId).map((a) => a.dir), `/claude-homes/admin-${userId}`].filter((h, i, a) => existsSync(h) && a.indexOf(h) === i);
    const out = await mem.importFileMemories(userId, homes);
    await auditLog(userId, 'memory.import', 'memory', null, req.ip ?? '', out);
    res.json({ ...out, memories: await mem.listMemories(userId) });
  } catch (err) { next(err); }
});
memoryRouter.patch('/:id', async (req, res, next) => {
  try {
    if (!isId(String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    if (!await mem.updateMemory(req.user!.userId, String(req.params.id), patchSchema.parse(req.body))) throw new AppError(404, 'Niet gevonden');
    res.json({ memories: await mem.listMemories(req.user!.userId) });
  } catch (err) { next(err); }
});
memoryRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!isId(String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    await mem.deleteMemory(req.user!.userId, String(req.params.id));
    await auditLog(req.user!.userId, 'memory.delete', 'memory', String(req.params.id), req.ip ?? '', {});
    res.json({ memories: await mem.listMemories(req.user!.userId) });
  } catch (err) { next(err); }
});
