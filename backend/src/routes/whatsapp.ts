import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { reloadWhatsApp, unlinkWhatsApp, whatsappQr, whatsappSyncContacts } from '../services/whatsapp/manager';
import { countContacts } from '../services/whatsapp/contacts';
import { AppError } from '../middleware/errorHandler';

export const whatsappRouter = Router();
whatsappRouter.use(requireAuth);

async function status(userId: string) {
  const r = await query<{
    enabled: boolean; phone_jid: string | null; push_name: string | null; status: string | null; status_message: string | null;
  }>('SELECT enabled, phone_jid, push_name, status, status_message FROM whatsapp_links WHERE user_id = $1', [userId]);
  const row = r.rows[0];
  return {
    enabled: row?.enabled ?? false,
    linked: row?.phone_jid != null,
    phone: row?.phone_jid ? '+' + row.phone_jid.split('@')[0].split(':')[0] : null,
    name: row?.push_name ?? null,
    status: row?.status ?? 'off',
    statusMessage: row?.status_message ?? null,
    qr: whatsappQr(userId),
    contacts: await countContacts(userId),
  };
}

whatsappRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await status(req.user!.userId)); } catch (err) { next(err); }
});

// enabled: true without a link starts a session that shows a QR code; also used for "new QR"
whatsappRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as { enabled?: unknown };
    await query('INSERT INTO whatsapp_links (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    if (typeof body.enabled === 'boolean') {
      await query('UPDATE whatsapp_links SET enabled = $2, updated_at = now() WHERE user_id = $1', [userId, body.enabled]);
    }
    await reloadWhatsApp(userId);
    res.json(await status(userId));
  } catch (err) { next(err); }
});

// Fetch the address book from the phone again (names and numbers only)
whatsappRouter.post('/contacts/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    try {
      await whatsappSyncContacts(req.user!.userId);
    } catch (err) {
      throw new AppError(409, `Synchroniseren mislukt: ${(err as Error).message}`);
    }
    res.json(await status(req.user!.userId));
  } catch (err) { next(err); }
});

whatsappRouter.delete('/link', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    await unlinkWhatsApp(userId);
    res.json(await status(userId));
  } catch (err) { next(err); }
});

whatsappRouter.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT c.id, c.title, c.updated_at, (w.active_conversation_id = c.id) AS active
         FROM conversations c LEFT JOIN whatsapp_links w ON w.user_id = c.user_id
        WHERE c.user_id = $1 AND c.status != 'deleted' AND (c.metadata->>'whatsapp')::boolean IS TRUE
        ORDER BY c.updated_at DESC LIMIT 100`, [req.user!.userId]);
    res.json({ conversations: r.rows });
  } catch (err) { next(err); }
});
