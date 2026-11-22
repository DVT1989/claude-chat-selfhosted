import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { userForMemoryToken } from '../services/memory';
import { searchHistory, conversationExcerpt } from '../services/history';

export const historyRouter = Router();

const isId = (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const role = (r: unknown) => (r === 'user' || r === 'assistant' ? r : null);
const since = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

// ── Claude inside this container: loopback + the per-run memory token (same as /memory/claude) ──
const claude = Router();
claude.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const userId = await userForMemoryToken(String(req.headers['x-memory-token'] ?? ''));
    if (!userId) throw new AppError(401, 'Token ongeldig of verlopen');
    (req as Request & { histUser?: string }).histUser = userId;
    next();
  } catch (err) { next(err); }
});
const uid = (req: Request) => (req as Request & { histUser?: string }).histUser!;

claude.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').slice(0, 200);
    if (!q.trim()) throw new AppError(400, 'Geef q, bijv. ?q=selfupdate backend');
    res.json({ results: await searchHistory(uid(req), q, {
      limit: Number(req.query.limit) || 8, role: role(req.query.role), since: since(req.query.since),
      excludeConversation: isId(req.query.exclude) ? String(req.query.exclude) : null,
    }) });
  } catch (err) { next(err); }
});
claude.get('/conversation/:id', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) throw new AppError(404, 'Niet gevonden');
    const out = await conversationExcerpt(uid(req), String(req.params.id), isId(req.query.around) ? String(req.query.around) : null, Number(req.query.n) || 6);
    if (!out) throw new AppError(404, 'Niet gevonden');
    res.json(out);
  } catch (err) { next(err); }
});
historyRouter.use('/claude', claude);

// ── The user in the app ──
historyRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    res.json({ results: await searchHistory(req.user!.userId, String(req.query.q ?? '').slice(0, 200), { limit: Number(req.query.limit) || 10, role: role(req.query.role) }) });
  } catch (err) { next(err); }
});
