import express, { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { CHANNELS, Channel, channelState, claudeSend, claudeSendContact, getSettings, saveSettings, userForToken } from '../services/messenger';

/** Settings page: /messenger (logged-in user). */
export const messengerRouter = Router();

/**
 * Claude Code inside this container: /messenger/agent/* with the per-run token from .messenger.token.
 * Only from loopback, so the token is useless from outside even if it leaked.
 */
messengerRouter.use('/agent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const userId = await userForToken(String(req.headers['x-messenger-token'] ?? ''));
    if (!userId) throw new AppError(401, 'Token ongeldig of verlopen; start een nieuwe beurt');
    res.locals.userId = userId;
    next();
  } catch (err) { next(err); }
});


messengerRouter.get('/agent/channels', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = res.locals.userId as string;
    const s = await getSettings(userId);
    const states = await Promise.all(CHANNELS.map((c) => channelState(userId, c)));
    res.json({
      channels: states.map((st) => ({
        ...st,
        allowed: st.channel === 'telegram' ? s.claudeTelegram : s.claudeWhatsapp,
      })),
      whatsappContacts: s.claudeWhatsapp && s.contactsWhatsapp,
    });
  } catch (err) { next(err); }
});

// POST /agent/send/whatsapp with a text/plain body, or POST /agent/send with JSON {channel, text}
// Address book lookup for "stuur Jan een WhatsApp"; only when sending to others is switched on
messengerRouter.get('/agent/whatsapp/contacts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = res.locals.userId as string;
    const s = await getSettings(userId);
    if (!s.claudeWhatsapp || !s.contactsWhatsapp) throw new AppError(409, 'Versturen naar andere contacten staat uit (Instellingen, WhatsApp)');
    const q = String(req.query.q ?? '').trim();
    if (!q) throw new AppError(400, 'q (naam of deel van een nummer) ontbreekt');
    const { searchContacts, countContacts } = await import('../services/whatsapp/contacts');
    const [contacts, count] = await Promise.all([searchContacts(userId, q), countContacts(userId)]);
    res.json({ contacts, addressBookSize: count.total });
  } catch (err) { next(err); }
});

messengerRouter.post(['/agent/send', '/agent/send/:channel'], express.text({ type: 'text/*', limit: '100kb' }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = res.locals.userId as string;
    const body = (typeof req.body === 'string' ? { text: req.body } : req.body ?? {}) as { channel?: unknown; text?: unknown; to?: unknown };
    const to = String(req.query.to ?? body.to ?? '').trim();
    const channel = String(req.params.channel ?? body.channel ?? '').toLowerCase() as Channel;
    if (!CHANNELS.includes(channel)) throw new AppError(400, 'channel moet telegram of whatsapp zijn');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new AppError(400, 'text is leeg');
    if (text.length > 20000) throw new AppError(400, 'text is te lang (max 20000 tekens)');
    if (to && channel !== 'whatsapp') throw new AppError(400, 'to (ander nummer) kan alleen bij whatsapp');
    try {
      if (to) return void res.json({ ok: true, channel, to: await claudeSendContact(userId, to, text) });
      await claudeSend(userId, channel, text);
    } catch (err) {
      throw new AppError(409, (err as Error).message);
    }
    res.json({ ok: true, channel });
  } catch (err) { next(err); }
});

messengerRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    res.json({ settings: await getSettings(userId), channels: await Promise.all(CHANNELS.map((c) => channelState(userId, c))) });
  } catch (err) { next(err); }
});

messengerRouter.put('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    let settings;
    try {
      settings = await saveSettings(userId, (req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof RangeError) throw new AppError(400, err.message);
      throw err;
    }
    res.json({ settings, channels: await Promise.all(CHANNELS.map((c) => channelState(userId, c))) });
  } catch (err) { next(err); }
});
