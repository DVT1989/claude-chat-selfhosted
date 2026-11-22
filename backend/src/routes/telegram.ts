import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { encrypt } from '../services/crypto';
import { getMe } from '../services/telegram/api';
import { reloadTelegram, newPairCode, botIdentity } from '../services/telegram/manager';

export const telegramRouter = Router();
telegramRouter.use(requireAuth);

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;

async function status(userId: string) {
  const r = await query<{
    enabled: boolean; bot_token_enc: string | null; bot_username: string | null; chat_id: string | null;
    chat_name: string | null; status: string | null; status_message: string | null; pair_code_expires: string | null;
  }>('SELECT enabled, bot_token_enc, bot_username, chat_id, chat_name, status, status_message, pair_code_expires FROM telegram_links WHERE user_id = $1', [userId]);
  const row = r.rows[0];
  const ident = await botIdentity(userId);
  return {
    botName: ident.name,
    botAvatar: ident.avatar,
    enabled: row?.enabled ?? false,
    hasToken: !!row?.bot_token_enc,
    botUsername: row?.bot_username ?? null,
    paired: row?.chat_id != null,
    chatName: row?.chat_name ?? null,
    status: row?.status ?? 'off',
    statusMessage: row?.status_message ?? null,
    pairCodeExpires: row?.pair_code_expires ?? null,
  };
}

telegramRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await status(req.user!.userId)); } catch (err) { next(err); }
});

telegramRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const body = (req.body ?? {}) as { enabled?: unknown; botToken?: unknown; botName?: unknown; botAvatar?: unknown };
    const token = typeof body.botToken === 'string' ? body.botToken.trim() : '';
    let username: string | null = null;
    if (token) {
      if (!TOKEN_RE.test(token)) throw new AppError(400, 'Ongeldige bot-token: kopieer de hele token van @BotFather.');
      try {
        username = (await getMe(token)).username;
      } catch {
        throw new AppError(400, 'Telegram kent deze bot-token niet. Controleer hem bij @BotFather.');
      }
    }
    await query(`INSERT INTO telegram_links (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    if (token) {
      // a new bot means a new chat: pair again
      await query(`UPDATE telegram_links SET bot_token_enc = $2, bot_username = $3, chat_id = NULL, chat_name = NULL,
                   active_conversation_id = NULL, update_offset = 0, pair_code = NULL, updated_at = now() WHERE user_id = $1`, [userId, encrypt(token), username]);
    }
    if (body.botName !== undefined) {
      const n = typeof body.botName === 'string' ? body.botName.trim() : '';
      if (n.length > 64) throw new AppError(400, 'Botnaam mag maximaal 64 tekens zijn.');
      await query('UPDATE telegram_links SET bot_name = $2, updated_at = now() WHERE user_id = $1', [userId, n || null]);
    }
    if (body.botAvatar !== undefined) {
      const a = typeof body.botAvatar === 'string' ? body.botAvatar : '';
      if (a && (!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(a) || a.length > 400_000)) throw new AppError(400, 'Ongeldige afbeelding (png, jpeg of webp, maximaal 300 kB).');
      await query('UPDATE telegram_links SET bot_avatar = $2, updated_at = now() WHERE user_id = $1', [userId, a || null]);
    }
    if (typeof body.enabled === 'boolean') {
      await query('UPDATE telegram_links SET enabled = $2, updated_at = now() WHERE user_id = $1', [userId, body.enabled]);
    }
    await reloadTelegram(userId);
    res.json(await status(userId));
  } catch (err) { next(err); }
});

telegramRouter.delete('/pairing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    await query('UPDATE telegram_links SET chat_id = NULL, chat_name = NULL, active_conversation_id = NULL, pair_code = NULL, updated_at = now() WHERE user_id = $1', [userId]);
    await reloadTelegram(userId);
    res.json(await status(userId));
  } catch (err) { next(err); }
});

// One-time pairing code (15 min) + a t.me deep link that sends "/start <code>" for you.
telegramRouter.post('/pair-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const st = await status(userId);
    if (!st.hasToken) throw new AppError(400, 'Sla eerst een bot-token op.');
    if (st.paired) throw new AppError(409, 'Al gekoppeld. Ontkoppel eerst.');
    const { code, expiresAt } = await newPairCode(userId);
    res.json({ code, expiresAt, link: st.botUsername ? `https://t.me/${st.botUsername}?start=${code}` : null });
  } catch (err) { next(err); }
});

telegramRouter.get('/conversations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT c.id, c.title, c.updated_at, (t.active_conversation_id = c.id) AS active
         FROM conversations c LEFT JOIN telegram_links t ON t.user_id = c.user_id
        WHERE c.user_id = $1 AND c.status != 'deleted' AND (c.metadata->>'telegram')::boolean IS TRUE
        ORDER BY c.updated_at DESC LIMIT 100`, [req.user!.userId]);
    res.json({ conversations: r.rows });
  } catch (err) { next(err); }
});
