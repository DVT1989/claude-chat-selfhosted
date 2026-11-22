import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, auditLog } from '../middleware/auth';
import { getVapidPublicKey, sendPushToUser, markPresence } from '../services/pushNotifications';

export const pushRouter = Router();

// Public — needed before subscription
pushRouter.get('/vapid-public-key', (_req: Request, res: Response) => {
  res.json({ key: getVapidPublicKey() });
});

pushRouter.use(requireAuth);

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(10).max(256),
    auth: z.string().min(10).max(256),
  }),
});

pushRouter.post('/subscribe', async (req: Request, res: Response, next) => {
  try {
    const body = subscribeSchema.parse(req.body);
    const ua = (req.headers['user-agent'] ?? '').toString().slice(0, 256);

    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         last_used_at = NOW()`,

[req.user!.userId, body.endpoint, body.keys.p256dh, body.keys.auth, ua],
    );
    let endpointHost = '';
    try { endpointHost = new URL(body.endpoint).host; } catch { /* ignore */ }
    await auditLog(req.user!.userId, 'push.subscribe', 'push_subscription', null, req.ip ?? '', { endpoint_host: endpointHost });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Visibility heartbeat of an app window; decides whether finished answers get a push
pushRouter.post('/presence', (req: Request, res: Response, next) => {
  try {
    const body = z.object({ clientId: z.string().min(8).max(64), visible: z.boolean(), endpoint: z.string().url().max(2048).nullish() }).parse(req.body);
    markPresence(req.user!.userId, body.clientId, body.visible, body.endpoint ?? null);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

pushRouter.post('/unsubscribe', async (req: Request, res: Response, next) => {
  try {
    const body = z.object({ endpoint: z.string().url().max(2048) }).parse(req.body);
    await query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',

[req.user!.userId, body.endpoint],
    );
    let endpointHost = '';
    try { endpointHost = new URL(body.endpoint).host; } catch { /* ignore */ }
    await auditLog(req.user!.userId, 'push.unsubscribe', 'push_subscription', null, req.ip ?? '', { endpoint_host: endpointHost });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

pushRouter.get('/status', async (req: Request, res: Response, next) => {
  try {
    const r = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM push_subscriptions WHERE user_id = $1',

[req.user!.userId],
    );
    res.json({ enabled: parseInt(r.rows[0]?.count ?? '0', 10) > 0 });
  } catch (err) {
    next(err);
  }
});

// Admin/test: send self a test push
pushRouter.post('/test', async (req: Request, res: Response, next) => {
  try {
    await sendPushToUser(req.user!.userId, {
      title: 'Claude Chat — testbericht',
      body: 'Notificaties werken. ✓',
      url: '/chat',
      tag: 'test',
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
