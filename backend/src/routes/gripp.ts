import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { AppError } from '../middleware/errorHandler';
import { grippForToken, grippAuthFor, GRIPP_URL } from '../services/gripp';

/** Claude inside this container: loopback + per-run token (x-gripp-token). The API token never leaves the backend. */
export const grippRouter = Router();
const claude = Router();
claude.use(express.json({ limit: '5mb' }));
claude.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const who = await grippForToken(String(req.headers['x-gripp-token'] ?? ''));
    if (!who) throw new AppError(401, 'Token ongeldig of verlopen (alleen toegekende agents krijgen een token)');
    (req as Request & { gp?: typeof who }).gp = who;
    next();
  } catch (err) { next(err); }
});

// POST /gripp/claude/call with the api3 body (one call object or an array of them) -> api3.php
claude.post('/call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const who = (req as Request & { gp?: { userId: string; connectorId: string } }).gp!;
    const body = req.body as unknown;
    if (!body || typeof body !== 'object') throw new AppError(400, 'Stuur een JSON-body met method, params en id (of een array daarvan)');
    const token = await grippAuthFor(who.userId, who.connectorId);
    const r = await fetch(GRIPP_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status).type(r.headers.get('content-type') ?? 'application/json').send(buf);
  } catch (err) { next(err); }
});
claude.use((_req, _res, next) => next(new AppError(404, 'Gebruik POST /gripp/claude/call')));

grippRouter.use('/claude', claude);
