/**
 * Runs one Telegram long-poll loop per user that enabled Telegram in Settings.
 * Messages go through startConversationRun, the same path as the web chat.
 */
import { query } from '../../db';
import { messengerPrompt, type Channel } from '../messengerStyle';
import { accountEvents } from '../claudeAccounts';
import { decrypt } from '../crypto';
import { getAuthStatus } from '../claudeCode';
import { createBot, BotDeps, Link, COMMANDS } from './bot';
import * as tg from './api';
import { htmlToPlain } from './format';
import * as messenger from '../messenger';

const POLL_TIMEOUT_SEC = 50;
/** Default identity for the admin; everyone else picks their own name, or stays neutral. */
export const ADMIN_BOT_NAME = 'Anthron';
export const ADMIN_BOT_AVATAR = '/anthron.webp';
const botShort = (name: string) => `${name}, je butler voor Claude op de NAS.`;
const botDescription = (name: string) => `Goedendag, ik ben ${name}. Via mij praat je met Claude op je NAS en ga je verder in je `
  + 'bestaande gesprekken. Ik luister alleen naar mijn eigenaar.';

/** Name and avatar of this user's own bot: the bot with the WhatsApp link (agentBots), else the old setting, else Anthron for admins. */
export async function botIdentity(userId: string): Promise<{ name: string | null; avatar: string | null }> {
  const r = await query<{ role: string; bot_name: string | null; bot_avatar: string | null }>(
    `SELECT u.role, COALESCE(b.name, t.bot_name) AS bot_name, COALESCE(b.avatar, t.bot_avatar) AS bot_avatar
       FROM users u LEFT JOIN telegram_links t ON t.user_id = u.id
       LEFT JOIN LATERAL (SELECT name, avatar FROM telegram_agent_bots WHERE user_id = u.id AND opt_messenger LIMIT 1) b ON TRUE
      WHERE u.id = $1`, [userId]);
  const row = r.rows[0];
  const admin = row?.role === 'admin';
  return {
    name: row?.bot_name || (admin ? ADMIN_BOT_NAME : null),
    avatar: row?.bot_avatar || (admin ? ADMIN_BOT_AVATAR : null),
  };
}
const RETRY_MS = 30_000;
const REPLY_POLL_MS = 1_500;
const REPLY_TIMEOUT_MS = 15 * 60_000;

export async function ensureTelegramSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS telegram_links (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      bot_token_enc TEXT,
      bot_username TEXT,
      chat_id BIGINT,
      chat_name TEXT,
      active_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      status TEXT,
      status_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // last confirmed Telegram update + 1, so a restart never handles an old message twice
  await query('ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS update_offset BIGINT NOT NULL DEFAULT 0');
  await query('ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS pair_code TEXT');
  await query('ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS bot_name TEXT');
  await query('ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS bot_avatar TEXT');
  await query('ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS pair_code_expires TIMESTAMPTZ');
  await query('ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS pair_attempts INTEGER NOT NULL DEFAULT 0');
}

const MAX_PAIR_ATTEMPTS = 5;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** New one-time pairing code, valid 15 minutes; replaces any previous code. */
export async function newPairCode(userId: string): Promise<{ code: string; expiresAt: string }> {
  const { randomInt } = await import('crypto');
  const code = Array.from({ length: 6 }, () => PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]).join('');
  const r = await query<{ pair_code_expires: string }>(
    `UPDATE telegram_links SET pair_code = $2, pair_code_expires = now() + interval '15 minutes', pair_attempts = 0
      WHERE user_id = $1 RETURNING pair_code_expires`, [userId, code]);
  if (!r.rows.length) throw new Error('Telegram is nog niet ingesteld');
  return { code, expiresAt: new Date(r.rows[0].pair_code_expires).toISOString() };
}

/** Checks a pairing code: single use, 15 minutes, locked after 5 wrong tries. */
export async function checkPairCode(userId: string, code: string): Promise<boolean> {
  const r = await query<{ pair_code: string; expired: boolean; pair_attempts: number }>(
    `UPDATE telegram_links SET pair_attempts = pair_attempts + 1
      WHERE user_id = $1 AND pair_code IS NOT NULL
      RETURNING pair_code, pair_code_expires < now() AS expired, pair_attempts`, [userId]);
  const row = r.rows[0];
  if (!row) return false;
  if (row.pair_attempts > MAX_PAIR_ATTEMPTS || row.expired) {
    await query('UPDATE telegram_links SET pair_code = NULL, pair_code_expires = NULL WHERE user_id = $1', [userId]);
    return false;
  }
  if (code.trim().toUpperCase() !== row.pair_code) return false;
  await query('UPDATE telegram_links SET pair_code = NULL, pair_code_expires = NULL, pair_attempts = 0 WHERE user_id = $1', [userId]);
  return true;
}

interface Poller { stop(): void; done: Promise<void> }
const pollers = new Map<string, Poller>();

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

async function setStatus(userId: string, status: string, message: string | null): Promise<void> {
  await query('UPDATE telegram_links SET status = $2, status_message = $3, updated_at = now() WHERE user_id = $1', [userId, status, message]);
}

/** Wait until the assistant row of a run is final; resolves with its text, rejects with its error. */
export async function waitForReply(assistantMsgId: string, pollMs = REPLY_POLL_MS, timeoutMs = REPLY_TIMEOUT_MS): Promise<string> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await query<{ content: string; metadata: Record<string, unknown> }>('SELECT content, metadata FROM messages WHERE id = $1', [assistantMsgId]);
    const row = r.rows[0];
    if (!row) throw new Error('antwoord verdwenen');
    if (row.metadata?.streaming === false || (row.metadata && !('streaming' in row.metadata))) {
      if (!row.content && row.metadata.error) throw new Error(String(row.metadata.error));
      return row.content;
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  throw new Error('Claude deed er langer dan 15 minuten over; kijk in de web-app.');
}

export function depsFor(token: string, channel: Channel = 'telegram'): BotDeps {
  return {
    send: async (chatId, text, html) => {
      try {
        await tg.sendMessage(token, chatId, text, html);
      } catch (err) {
        // Telegram refuses HTML it cannot parse: send the same text without markup
        if (!html || !(err instanceof tg.TelegramError) || err.status !== 400) throw err;
        await tg.sendMessage(token, chatId, htmlToPlain(text));
      }
    },
    typing: (chatId) => tg.sendTyping(token, chatId),
    botName: channel === 'telegram' ? async (userId) => (await botIdentity(userId)).name : undefined,
    listConversations: async (userId) => (await query<{ id: string; title: string; updated_at: string }>(
      `SELECT id, title, updated_at FROM conversations
        WHERE user_id = $1 AND status != 'deleted' AND NOT (metadata ? 'isSystem')
        ORDER BY updated_at DESC LIMIT 10`, [userId])).rows,
    createConversation: async (userId) => (await query<{ id: string }>(
      `INSERT INTO conversations (user_id, title, metadata) VALUES ($1, 'Telegram-gesprek', '{"telegram": true}'::jsonb) RETURNING id`,
      [userId])).rows[0].id,
    markTelegram: async (id) => { await query(`UPDATE conversations SET metadata = metadata || '{"telegram": true}'::jsonb WHERE id = $1`, [id]); },
    checkPairCode: (userId, code) => checkPairCode(userId, code),
    savePairing: async (userId, chatId, chatName) => {
      await query('UPDATE telegram_links SET chat_id = $2, chat_name = $3, updated_at = now() WHERE user_id = $1', [userId, chatId, chatName]);
    },
    setActive: (userId, id) => messenger.setActive(userId, 'telegram', id),
    getActive: (userId) => messenger.getActive(userId, 'telegram'),
    relayTo: { command: 'whatsapp', send: (userId, text) => messenger.relay(userId, 'telegram', text) },
    afterReply: (userId, convId, q, a) => messenger.mirror(userId, 'telegram', convId, q, a),
    statusExtra: (userId) => messenger.otherStatusLine(userId, 'telegram'),
    startRun: async (userId, convId, text, notify) => {
      if ((await getAuthStatus(userId)) !== 'authenticated') {
        return { ok: true, reply: Promise.reject(new Error('Je Claude-account is niet gekoppeld (web-app → Instellingen → Claude Code).')) };
      }
      const u = (await query<{ role: string; language: string | null; name: string | null }>('SELECT role, language, name FROM users WHERE id = $1', [userId])).rows[0];
      const conv = (await query<{ id: string; model: string; metadata: Record<string, unknown> }>(
        `SELECT id, model, metadata FROM conversations WHERE id = $1 AND user_id = $2 AND status != 'deleted'`, [convId, userId])).rows[0];
      if (!conv) return { ok: true, reply: Promise.reject(new Error('Gesprek niet gevonden. Kies er een met /gesprekken.')) };
      // lazy import: routes/stream pulls in the whole web stack
      const { startConversationRun } = await import('../../routes/stream');
      // Only during this question: pass on a switch to another Claude subscription
      const onSwitch = (cid: string, note: string) => { if (cid === conv.id) notify?.(note); };
      accountEvents.on('switch', onSwitch);
      const started = await startConversationRun({
        userId, role: u?.role ?? 'user', language: u?.language ?? 'nl', conv, userMessage: text, attachmentIds: [],
        appendSystemPrompt: messengerPrompt(channel, u?.name ?? null),
      });
      if (started.busy) { accountEvents.off('switch', onSwitch); return { ok: false, busy: true }; }
      const reply = waitForReply(started.assistantMsgId);
      void reply.catch(() => undefined).finally(() => accountEvents.off('switch', onSwitch));
      return { ok: true, reply };
    },
  };
}

function startPoller(userId: string, token: string, chatId: number | null, activeId: string | null, startOffset: number): Poller {
  const ctl = new AbortController();
  const link: Link = { userId, chatId, activeConversationId: activeId };
  const bot = createBot(depsFor(token), ctl.signal);
  const loop = async () => {
    let offset = startOffset;
    try {
      const me = await tg.getMe(token);
      await query("UPDATE telegram_links SET bot_username = $2, status = 'ok', status_message = NULL WHERE user_id = $1", [userId, me.username]);
      await tg.setCommands(token, COMMANDS).catch((e) => console.error('[telegram] setCommands failed:', e));
      const name = (await botIdentity(userId)).name;
      if (name && me.first_name !== name) {
        // only when it differs: Telegram rate-limits these calls
        await tg.setProfile(token, name, botDescription(name), botShort(name)).catch((e) => console.error('[telegram] setProfile failed:', e));
      }
    } catch (err) {
      await setStatus(userId, 'error', `Bot-token werkt niet: ${(err as Error).message}`);
      if (err instanceof tg.TelegramError && err.status === 401) return;
    }
    while (!ctl.signal.aborted) {
      try {
        const updates = await tg.getUpdates(token, offset, POLL_TIMEOUT_SEC, ctl.signal);
        for (const u of updates) {
          if (ctl.signal.aborted) break; // a stopped poller must not act on the rest of its batch
          offset = u.update_id + 1;
          await query('UPDATE telegram_links SET update_offset = $2 WHERE user_id = $1', [userId, offset]);
          await bot.handleUpdate(link, u).catch((e) => console.error('[telegram] update failed:', e));
        }
      } catch (err) {
        if (ctl.signal.aborted) break;
        if (err instanceof tg.TelegramError && err.status === 401) {
          await setStatus(userId, 'error', 'Bot-token ongeldig of ingetrokken. Plak een nieuwe token.');
          return;
        }
        const conflict = err instanceof tg.TelegramError && err.status === 409;
        await setStatus(userId, 'error', conflict
          ? 'Deze bot wordt ook ergens anders uitgelezen (409). Stop dat programma.'
          : `Telegram onbereikbaar: ${(err as Error).message}. Nieuwe poging over 30 s.`);
        await sleep(RETRY_MS, ctl.signal);
        if (!ctl.signal.aborted) await setStatus(userId, 'ok', null);
      }
    }
  };
  // never let a rejected loop (e.g. a database hiccup in setStatus) become an unhandled rejection
  const done = loop().catch((err) => console.error('[telegram] poller crashed:', err));
  return { stop: () => ctl.abort(), done };
}

const reloads = new Map<string, Promise<void>>();

/** (Re)start the poller of one user from the saved settings. Calls per user run one after another. */
export function reloadTelegram(userId: string): Promise<void> {
  const next = (reloads.get(userId) ?? Promise.resolve()).then(() => doReload(userId));
  const tail = next.catch(() => undefined);
  reloads.set(userId, tail);
  void tail.then(() => { if (reloads.get(userId) === tail) reloads.delete(userId); });
  return next;
}

async function doReload(userId: string): Promise<void> {
  const old = pollers.get(userId);
  if (old) {
    old.stop();
    pollers.delete(userId);
    await old.done.catch(() => undefined); // never two pollers on one token
  }
  const r = await query<{ enabled: boolean; bot_token_enc: string | null; chat_id: string | null; active_conversation_id: string | null; update_offset: string }>(
    'SELECT enabled, bot_token_enc, chat_id, active_conversation_id, update_offset FROM telegram_links WHERE user_id = $1 AND migrated_at IS NULL', [userId]);
  const row = r.rows[0];
  if (!row?.enabled || !row.bot_token_enc) {
    if (row) await setStatus(userId, 'off', null);
    return;
  }
  const token = decrypt(row.bot_token_enc);
  pollers.set(userId, startPoller(userId, token, row.chat_id === null ? null : Number(row.chat_id), row.active_conversation_id, Number(row.update_offset ?? 0)));
}

export async function startTelegram(): Promise<void> {
  try {
    const r = await query<{ user_id: string }>('SELECT user_id FROM telegram_links WHERE enabled = true AND bot_token_enc IS NOT NULL AND migrated_at IS NULL');
    for (const { user_id } of r.rows) await reloadTelegram(user_id);
    if (r.rows.length) console.log(`✓ Telegram: ${r.rows.length} bot(s) gestart`);
  } catch (err) {
    console.error('✗ Telegram start failed:', err);
  }
}

export async function stopAllTelegram(): Promise<void> {
  const all = [...pollers.values()];
  pollers.clear();
  for (const p of all) p.stop();
  await Promise.all(all.map((p) => p.done.catch(() => undefined)));
}
