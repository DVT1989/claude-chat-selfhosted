import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { AppError } from '../middleware/errorHandler';
import { ninjaForToken, ninjaAuthFor } from '../services/ninjaone';

/** Claude inside this container: loopback + per-run token (x-ninjaone-token). The client secret never leaves the backend. */
export const ninjaoneRouter = Router();
const claude = Router();
claude.use(express.raw({ type: () => true, limit: '25mb' }));
claude.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const who = await ninjaForToken(String(req.headers['x-ninjaone-token'] ?? ''));
    if (!who) throw new AppError(401, 'Token ongeldig of verlopen (alleen toegekende agents krijgen een token)');
    (req as Request & { nj?: typeof who }).nj = who;
    next();
  } catch (err) { next(err); }
});

// ANY /ninjaone/claude/v2/... -> {instance}/v2/...
claude.all(/^\/(v2\/.*)$/, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const who = (req as Request & { nj?: { userId: string; connectorId: string } }).nj!;
    const sub = String((req.params as unknown as string[])[0] ?? '');
    if (sub.includes('..') || sub.includes('\\') || /[\r\n]/.test(sub)) throw new AppError(400, 'Ongeldig pad');
    const method = req.method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new AppError(405, 'Methode niet toegestaan');
    const raw: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;
    const ct = String(req.headers['content-type'] ?? '');
    let payload: Buffer | string | undefined = raw && raw.length ? raw : undefined;
    if (!payload && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && Object.keys(req.body).length) payload = JSON.stringify(req.body);
    // never a public comment to the customer: a comment must say "public": false explicitly
    if (method === 'POST' && /^v2\/ticketing\/ticket\/\d+\/comment\/?$/.test(sub)) {
      const txt = payload ? payload.toString('utf8') : '';
      if (!/["']?public["']?\s*[:=]\s*false/i.test(txt) && !/name="comment\.public"\s*\r?\n\r?\n\s*false/i.test(txt)) {
        throw new AppError(403, 'Alleen privé-opmerkingen: zet "public":false in het comment-deel. Een publieke opmerking gaat naar de klant en is niet toegestaan.');
      }
    }
    const { base, token } = await ninjaAuthFor(who.userId, who.connectorId);
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const r = await fetch(`${base}/${sub}${qs}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(ct && payload ? { 'Content-Type': ct } : {}) },
      body: method === 'GET' || method === 'DELETE' ? undefined : (payload as BodyInit | undefined),
      signal: AbortSignal.timeout(60000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status).type(r.headers.get('content-type') ?? 'application/json').send(buf);
  } catch (err) { next(err); }
});
claude.use((_req, _res, next) => next(new AppError(404, 'Gebruik /ninjaone/claude/v2/...')));

ninjaoneRouter.use('/claude', claude);
