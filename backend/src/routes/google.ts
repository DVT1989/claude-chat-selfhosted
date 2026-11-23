import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, requireAdmin, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { getClient, setClient, clearClient, startLogin, finishLogin, redirectUri, setupPrompt, GSC_SCOPE } from '../services/googleSearchConsole';

export const googleRouter = Router();

const back = (res: Response, ok: boolean, msg: string) =>
  res.redirect(`/settings/connectors?google=${ok ? 'ok' : 'error'}&msg=${encodeURIComponent(msg)}`);

// Google sends the browser here. No auth header is possible, so the one-time state (bound to the user) is the proof.
googleRouter.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) return back(res, false, error === 'access_denied' ? 'Inloggen geannuleerd' : error);
  if (!code || !state) return back(res, false, 'Ongeldige terugkeer van Google');
  try {
    const r = await finishLogin(code, state);
    await auditLog(r.userId, 'connector.google.login', 'connector', '', req.ip ?? '', { sites: r.sites });
    back(res, true, `Verbonden, ${r.sites} site(s) gevonden`);
  } catch (err) {
    back(res, false, (err as Error).message);
  }
});

googleRouter.use(requireAuth);

googleRouter.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = await getClient();
    res.json({
      configured: !!client,
      clientId: client?.clientId ?? null, // the secret is never returned
      isAdmin: req.user!.role === 'admin',
      redirectUri: redirectUri(),
      scope: GSC_SCOPE,
    });
  } catch (err) { next(err); }
});

googleRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ url: await startLogin(req.user!.userId) }); }
  catch (err) { next(new AppError(400, (err as Error).message)); }
});

googleRouter.put('/config', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = z.object({ clientId: z.string().trim().min(10).max(300), clientSecret: z.string().trim().min(8).max(300) }).parse(req.body);
    if (!/\.apps\.googleusercontent\.com$/.test(b.clientId)) throw new AppError(400, 'Dit is geen Google Client ID (eindigt op .apps.googleusercontent.com)');
    await setClient(b.clientId, b.clientSecret);
    await auditLog(req.user!.userId, 'connector.google.config', 'setting', '', req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

googleRouter.delete('/config', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await clearClient();
    await auditLog(req.user!.userId, 'connector.google.config.delete', 'setting', '', req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Admin: the fixed plan for "Laat Claude het instellen"; the frontend starts the chat with it. */
googleRouter.get('/setup-prompt', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dev = await query<{ n: string }>("SELECT COUNT(*)::text AS n FROM devices WHERE os = 'browser' AND enabled = true AND user_id = $1", [req.user!.userId]).catch(() => ({ rows: [{ n: '0' }] }));
    res.json({ prompt: setupPrompt(), browsers: Number(dev.rows[0].n) });
  } catch (err) { next(err); }
});
