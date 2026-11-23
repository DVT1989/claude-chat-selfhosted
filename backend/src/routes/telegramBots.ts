import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { encrypt } from '../services/crypto';
import { getMe } from '../services/telegram/api';
import { listAgents } from '../services/agents';
import { reloadAgentBot, stopAgentBot, notifyChatter, newBotCode } from '../services/telegram/agentBots';

/** All Telegram bots of the logged-in user (the old personal bot was migrated into these). */
export const telegramBotsRouter = Router();
telegramBotsRouter.use(requireAuth);

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;
const uuid = z.string().uuid();

async function verifyToken(token: string, exceptBotId?: string): Promise<string> {
  if (!TOKEN_RE.test(token)) throw new AppError(400, 'Ongeldige bot-token: kopieer de hele token van @BotFather.');
  let username: string;
  try { username = (await getMe(token)).username; } catch { throw new AppError(400, 'Telegram kent deze bot-token niet. Controleer hem bij @BotFather.'); }
  const dup = await query(
    `SELECT 1 FROM telegram_agent_bots WHERE bot_username = $1 AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')
     UNION ALL SELECT 1 FROM telegram_links WHERE bot_username = $1 AND migrated_at IS NULL AND bot_token_enc IS NOT NULL`, [username, exceptBotId ?? null]);
  if (dup.rows.length) throw new AppError(409, 'Deze bot is al in gebruik (persoonlijke bot of andere agent-bot). Maak een eigen bot via @BotFather.');
  return username;
}

async function ownBot(userId: string, id: string) {
  const r = await query<{ id: string }>('SELECT id FROM telegram_agent_bots WHERE id = $1 AND user_id = $2', [uuid.parse(id), userId]);
  if (!r.rows.length) throw new AppError(404, 'Bot niet gevonden');
}

/** Only agents this user may use (own or shared with them). */
async function checkAgents(userId: string, ids: string[]): Promise<string[]> {
  const ok = new Set((await listAgents(userId)).map((a) => a.id));
  const bad = ids.filter((i) => !ok.has(i));
  if (bad.length) throw new AppError(400, 'Een gekozen agent bestaat niet of is niet voor jou beschikbaar');
  return [...new Set(ids)];
}

async function setAgents(botId: string, ids: string[]): Promise<void> {
  await query('DELETE FROM telegram_agent_bot_agents WHERE bot_id = $1', [botId]);
  for (const id of ids) await query('INSERT INTO telegram_agent_bot_agents (bot_id, agent_id) VALUES ($1,$2)', [botId, id]);
}

async function overview(userId: string) {
  const bots = (await query<{
    id: string; name: string; bot_username: string | null; enabled: boolean; rate_per_hour: number; status: string | null; status_message: string | null;
    avatar: string | null; opt_commands: boolean; opt_full: boolean; opt_messenger: boolean; invite_code: string | null; invite_code_expires: string | null;
  }>(`SELECT id, name, bot_username, enabled, rate_per_hour, status, status_message, avatar, opt_commands, opt_full, opt_messenger,
             CASE WHEN invite_code_expires > now() THEN invite_code END AS invite_code,
             CASE WHEN invite_code_expires > now() THEN invite_code_expires END AS invite_code_expires
        FROM telegram_agent_bots WHERE user_id = $1 ORDER BY opt_messenger DESC, created_at`, [userId])).rows;
  const ids = bots.map((b) => b.id);
  const links = ids.length ? (await query<{ bot_id: string; agent_id: string }>('SELECT bot_id, agent_id FROM telegram_agent_bot_agents WHERE bot_id = ANY($1::uuid[])', [ids])).rows : [];
  const chatters = ids.length ? (await query<{
    id: string; bot_id: string; name: string; username: string | null; status: string; is_owner: boolean; conversation_id: string | null; requested_at: string; decided_at: string | null; last_active: string | null;
  }>(`SELECT c.id, c.bot_id, c.name, c.username, c.status, c.is_owner, c.conversation_id, c.requested_at, c.decided_at,
             (SELECT max(at) FROM telegram_agent_hits h WHERE h.chatter_id = c.id) AS last_active
        FROM telegram_agent_chatters c WHERE c.bot_id = ANY($1::uuid[]) ORDER BY c.requested_at DESC`, [ids])).rows : [];
  const agents = (await listAgents(userId)).map((a) => ({ id: a.id, name: a.name, color: a.color, avatar: a.avatar, shared_by: a.shared_by, is_active: a.is_active }));
  return {
    agents,
    bots: bots.map((b) => ({
      id: b.id, name: b.name, botUsername: b.bot_username, enabled: b.enabled, ratePerHour: b.rate_per_hour,
      status: b.status ?? 'off', statusMessage: b.status_message, avatar: b.avatar,
      optCommands: b.opt_commands, optFull: b.opt_full, optMessenger: b.opt_messenger,
      invite: b.invite_code && b.bot_username ? { link: `https://t.me/${b.bot_username}?start=${b.invite_code}`, expiresAt: b.invite_code_expires } : null,
      agentIds: links.filter((l) => l.bot_id === b.id).map((l) => l.agent_id),
      chatters: chatters.filter((c) => c.bot_id === b.id).map(({ bot_id, is_owner, conversation_id, requested_at, decided_at, last_active, ...c }) => ({
        ...c, isOwner: is_owner, conversationId: conversation_id, requestedAt: requested_at, decidedAt: decided_at, lastActive: last_active })),
    })),
  };
}

telegramBotsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await overview(req.user!.userId)); } catch (err) { next(err); }
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  botToken: z.string().trim().min(1),
  agentIds: z.array(z.string().uuid()).max(20).default([]),
  ratePerHour: z.number().int().min(0).max(1000).default(20),
});

telegramBotsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const b = createSchema.parse(req.body);
    const agentIds = await checkAgents(userId, b.agentIds);
    const username = await verifyToken(b.botToken);
    const r = await query<{ id: string }>(
      `INSERT INTO telegram_agent_bots (user_id, name, bot_token_enc, bot_username, rate_per_hour) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [userId, b.name, encrypt(b.botToken), username, b.ratePerHour]);
    // the first bot of a user carries the WhatsApp link by default (like the old personal bot)
    await query(`UPDATE telegram_agent_bots SET opt_messenger = TRUE WHERE id = $1
                  AND NOT EXISTS (SELECT 1 FROM telegram_agent_bots WHERE user_id = $2 AND opt_messenger)`, [r.rows[0].id, userId]);
    await setAgents(r.rows[0].id, agentIds);
    await auditLog(userId, 'telegram.agentbot.create', 'telegram_agent_bot', r.rows[0].id, '', { name: b.name });
    await reloadAgentBot(r.rows[0].id);
    res.json(await overview(userId));
  } catch (err) { next(err); }
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  botToken: z.string().trim().optional(),
  enabled: z.boolean().optional(),
  agentIds: z.array(z.string().uuid()).max(20).optional(),
  ratePerHour: z.number().int().min(0).max(1000).optional(),
  avatar: z.string().max(400_000).refine((v) => v === '' || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || /^\/[\w.-]+$/.test(v),
    'Avatar moet een png, jpeg of webp zijn').optional(),
  optCommands: z.boolean().optional(),
  optFull: z.boolean().optional(),
  optMessenger: z.boolean().optional(),
});

telegramBotsRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = String(req.params.id);
    await ownBot(userId, id);
    const b = updateSchema.parse(req.body);
    if (b.agentIds) await setAgents(id, await checkAgents(userId, b.agentIds));
    if (b.name !== undefined) await query('UPDATE telegram_agent_bots SET name = $2, updated_at = now() WHERE id = $1', [id, b.name]);
    if (b.ratePerHour !== undefined) await query('UPDATE telegram_agent_bots SET rate_per_hour = $2, updated_at = now() WHERE id = $1', [id, b.ratePerHour]);
    if (b.enabled !== undefined) await query('UPDATE telegram_agent_bots SET enabled = $2, updated_at = now() WHERE id = $1', [id, b.enabled]);
    if (b.avatar !== undefined) await query('UPDATE telegram_agent_bots SET avatar = $2, updated_at = now() WHERE id = $1', [id, b.avatar || null]);
    if (b.optCommands !== undefined) await query('UPDATE telegram_agent_bots SET opt_commands = $2, updated_at = now() WHERE id = $1', [id, b.optCommands]);
    if (b.optFull !== undefined) await query('UPDATE telegram_agent_bots SET opt_full = $2, updated_at = now() WHERE id = $1', [id, b.optFull]);
    const alsoReload: string[] = [];
    if (b.optMessenger !== undefined) {
      if (b.optMessenger) {
        // one bot per user carries the WhatsApp link
        const prev = await query<{ id: string }>('UPDATE telegram_agent_bots SET opt_messenger = FALSE WHERE user_id = $1 AND id <> $2 AND opt_messenger RETURNING id', [userId, id]);
        alsoReload.push(...prev.rows.map((r) => r.id));
      }
      await query('UPDATE telegram_agent_bots SET opt_messenger = $2, updated_at = now() WHERE id = $1', [id, b.optMessenger]);
    }
    if (b.botToken) {
      const username = await verifyToken(b.botToken, id);
      // a new bot means a new set of chatters: the old chat ids belong to the old bot
      await query('UPDATE telegram_agent_bots SET bot_token_enc = $2, bot_username = $3, update_offset = 0, updated_at = now() WHERE id = $1', [id, encrypt(b.botToken), username]);
      await query('UPDATE telegram_agent_chatters SET status = $2, decided_at = now() WHERE bot_id = $1', [id, 'revoked']);
    }
    await reloadAgentBot(id);
    for (const other of alsoReload) await reloadAgentBot(other);
    res.json(await overview(userId));
  } catch (err) { next(err); }
});

const codeSchema = z.object({ kind: z.enum(['owner', 'invite']) });

/** Link that sends "/start CODE": owner = you yourself (15 min, once), invite = others without approval (24 h). */
telegramBotsRouter.post('/:id/code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = String(req.params.id);
    await ownBot(userId, id);
    const { kind } = codeSchema.parse(req.body);
    const u = (await query<{ bot_username: string | null }>('SELECT bot_username FROM telegram_agent_bots WHERE id = $1', [id])).rows[0];
    const { code, expiresAt } = await newBotCode(id, kind);
    await auditLog(userId, `telegram.agentbot.code.${kind}`, 'telegram_agent_bot', id, '', {});
    res.json({ code, expiresAt, link: u?.bot_username ? `https://t.me/${u.bot_username}?start=${code}` : null });
  } catch (err) { next(err); }
});

telegramBotsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = String(req.params.id);
    await ownBot(userId, id);
    await stopAgentBot(id);
    await query('DELETE FROM telegram_agent_bots WHERE id = $1', [id]);
    await auditLog(userId, 'telegram.agentbot.delete', 'telegram_agent_bot', id, '', {});
    res.json(await overview(userId));
  } catch (err) { next(err); }
});

const decideSchema = z.object({ action: z.enum(['approve', 'deny', 'revoke']) });
const NEXT = { approve: 'approved', deny: 'denied', revoke: 'revoked' } as const;

telegramBotsRouter.put('/:id/chatters/:cid', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const id = String(req.params.id);
    await ownBot(userId, id);
    const { action } = decideSchema.parse(req.body);
    const r = await query<{ chat_id: string; status: string }>(
      'SELECT chat_id, status FROM telegram_agent_chatters WHERE id = $1 AND bot_id = $2', [uuid.parse(String(req.params.cid)), id]);
    const row = r.rows[0];
    if (!row) throw new AppError(404, 'Chatter niet gevonden');
    if (action === 'revoke' && row.status !== 'approved') throw new AppError(409, 'Alleen goedgekeurde chatters kun je intrekken');
    if (action !== 'revoke' && row.status === 'approved') throw new AppError(409, 'Deze chatter is al goedgekeurd');
    await query('UPDATE telegram_agent_chatters SET status = $2, decided_at = now() WHERE id = $1', [String(req.params.cid), NEXT[action]]);
    await auditLog(userId, `telegram.agentbot.chatter.${action}`, 'telegram_agent_chatter', String(req.params.cid), '', { bot: id });
    if (action === 'approve') void notifyChatter(id, Number(row.chat_id), 'Je bent goedgekeurd. Je kunt nu je vraag sturen.');
    else if (action === 'deny') void notifyChatter(id, Number(row.chat_id), 'Je aanvraag is helaas niet goedgekeurd.');
    res.json(await overview(userId));
  } catch (err) { next(err); }
});

