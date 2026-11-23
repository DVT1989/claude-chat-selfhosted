/**
 * All Telegram bots of a user (the former personal bot is migrated into this table too). Per bot: token,
 * optional linked agents, chatters (the owner via a pair link, others via an invite link or approval) and options:
 * /resume-/nieuw-/status commands, full answers with code, WhatsApp link (relay, mirror, Claude may send).
 * Every approved chatter talks through createBot (bot.ts): own conversations under the owner, /resume to switch.
 * Without agents the chatter talks to Claude itself; with agents to those agents (@naam or the coordinator).
 */
import { query } from '../../db';
import { decrypt } from '../crypto';
import { getAuthStatus, runStructured } from '../claudeCode';
import { listAgents, type Agent } from '../agents';
import { sendPushToUser } from '../pushNotifications';
import { waitForReply } from './manager';
import { agentChatPrompt, cleanAgentAnswer, parseMention, AGENT_TEXT, type AgentInfo, type Coordination } from './agentBot';
import { createBot, COMMANDS, type BotDeps, type Link, type TgUpdate } from './bot';
import { htmlToPlain } from './format';
import { messengerPrompt } from '../messengerStyle';
import { accountEvents } from '../claudeAccounts';
import * as messenger from '../messenger';
import * as tg from './api';

const POLL_TIMEOUT_SEC = 50;
const RETRY_MS = 30_000;

export async function ensureAgentBotSchema(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS telegram_agent_bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    bot_token_enc TEXT NOT NULL,
    bot_username TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    rate_per_hour INTEGER NOT NULL DEFAULT 20,
    update_offset BIGINT NOT NULL DEFAULT 0,
    status TEXT,
    status_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await query('CREATE INDEX IF NOT EXISTS telegram_agent_bots_user_idx ON telegram_agent_bots (user_id)');
  await query(`CREATE TABLE IF NOT EXISTS telegram_agent_bot_agents (
    bot_id UUID NOT NULL REFERENCES telegram_agent_bots(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (bot_id, agent_id))`);
  await query(`CREATE TABLE IF NOT EXISTS telegram_agent_chatters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES telegram_agent_bots(id) ON DELETE CASCADE,
    chat_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    username TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    UNIQUE (bot_id, chat_id))`);
  await query(`CREATE TABLE IF NOT EXISTS telegram_agent_hits (
    chatter_id UUID NOT NULL REFERENCES telegram_agent_chatters(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await query('CREATE INDEX IF NOT EXISTS telegram_agent_hits_idx ON telegram_agent_hits (chatter_id, at)');
  await query(`ALTER TABLE telegram_agent_bots
    ADD COLUMN IF NOT EXISTS avatar TEXT,
    ADD COLUMN IF NOT EXISTS opt_commands BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS opt_full BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS opt_messenger BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS owner_code TEXT,
    ADD COLUMN IF NOT EXISTS owner_code_expires TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS owner_code_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS invite_code TEXT,
    ADD COLUMN IF NOT EXISTS invite_code_expires TIMESTAMPTZ`);
  await query('ALTER TABLE telegram_agent_chatters ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE');
  await query(`ALTER TABLE telegram_links
    ADD COLUMN IF NOT EXISTS bot_id UUID REFERENCES telegram_agent_bots(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMPTZ`);
  await migratePersonalBots();
}

/** One time: every personal bot (telegram_links) becomes a normal bot with the owner as approved chatter. */
async function migratePersonalBots(): Promise<void> {
  const rows = (await query<{
    user_id: string; enabled: boolean; bot_token_enc: string; bot_username: string | null; chat_id: string | null; chat_name: string | null;
    active_conversation_id: string | null; update_offset: string; bot_name: string | null; bot_avatar: string | null; role: string;
  }>(`SELECT t.user_id, t.enabled, t.bot_token_enc, t.bot_username, t.chat_id, t.chat_name, t.active_conversation_id, t.update_offset,
             t.bot_name, t.bot_avatar, u.role
        FROM telegram_links t JOIN users u ON u.id = t.user_id
       WHERE t.bot_token_enc IS NOT NULL AND t.migrated_at IS NULL`)).rows;
  for (const r of rows) {
    const admin = r.role === 'admin';
    const bot = (await query<{ id: string }>(
      `INSERT INTO telegram_agent_bots (user_id, name, bot_token_enc, bot_username, enabled, rate_per_hour, update_offset, avatar,
                                        opt_commands, opt_full, opt_messenger)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, TRUE, TRUE,
               NOT EXISTS (SELECT 1 FROM telegram_agent_bots WHERE user_id = $1 AND opt_messenger)) RETURNING id`,
      [r.user_id, r.bot_name || (admin ? 'Anthron' : (r.bot_username ? `@${r.bot_username}` : 'Telegram-bot')), r.bot_token_enc, r.bot_username,
        r.enabled, Number(r.update_offset ?? 0), r.bot_avatar || (admin ? '/anthron.webp' : null)])).rows[0];
    if (r.chat_id != null) {
      await query(`INSERT INTO telegram_agent_chatters (bot_id, chat_id, name, status, is_owner, decided_at, conversation_id)
                   VALUES ($1, $2, $3, 'approved', TRUE, now(), $4) ON CONFLICT (bot_id, chat_id) DO NOTHING`,
        [bot.id, r.chat_id, r.chat_name || 'Eigenaar', r.active_conversation_id]);
    }
    // the old poller in manager.ts stays off for this row (enabled false), the old columns stay for a rollback
    await query('UPDATE telegram_links SET bot_id = $2, migrated_at = now(), enabled = FALSE WHERE user_id = $1', [r.user_id, bot.id]);
    console.log(`✓ Telegram: persoonlijke bot van ${r.user_id} omgezet naar een gewone bot`);
  }
}

interface BotRow {
  id: string; user_id: string; name: string; bot_token_enc: string; enabled: boolean; rate_per_hour: number; update_offset: string;
  avatar: string | null; opt_commands: boolean; opt_full: boolean; opt_messenger: boolean;
}
interface Chatter { id: string; chat_id: string; name: string; status: 'pending' | 'approved' | 'denied' | 'revoked'; is_owner: boolean; conversation_id: string | null }
const BOT_COLUMNS = 'id, user_id, name, bot_token_enc, enabled, rate_per_hour, update_offset, avatar, opt_commands, opt_full, opt_messenger';

const COORD_SCHEMA = {
  type: 'object',
  properties: {
    agents: { type: 'array', items: { type: 'string' }, description: 'slugs of the agents that should answer (max 3)' },
    reason: { type: 'string', description: 'only when agents is empty: short friendly explanation in Dutch why nobody can help' },
  },
  required: ['agents', 'reason'],
};

export async function coordinate(ownerId: string, question: string, agents: AgentInfo[]): Promise<Coordination> {
  const list = agents.map((a) => `- ${a.slug}: ${a.name}: ${a.description}`).join('\n');
  return runStructured<Coordination>(ownerId, {
    system: 'Je bent de coordinator van een team agents dat in een chat vragen beantwoordt, als in een vergadering. '
      + 'Kies welke agent(s) de vraag het best kunnen beantwoorden (meestal een, hooguit drie, alleen meer als de vraag echt over meerdere vakgebieden gaat). '
      + 'Kan geen enkele agent het, laat dan agents leeg en leg in reason in een of twee vriendelijke zinnen, namens het hele team ("wij"), uit waarom niet en waar de vraag wel terecht kan. '
      + 'Voer de vraag zelf niet uit.',
    prompt: `Agents:\n${list}\n\nVraag van de chatter:\n${question.slice(0, 4000)}`,
    schema: COORD_SCHEMA, model: 'haiku', timeoutMs: 90_000, action: 'telegram-agent',
  });
}

async function botAgents(bot: { id: string; user_id: string }): Promise<Array<Agent>> {
  const linked = new Set((await query<{ agent_id: string }>('SELECT agent_id FROM telegram_agent_bot_agents WHERE bot_id = $1', [bot.id])).rows.map((r) => r.agent_id));
  return (await listAgents(bot.user_id)).filter((a) => linked.has(a.id) && a.is_active);
}

const MAX_AGENTS_PER_QUESTION = 3;
const LIST_LIMIT = 10;
const KNOWN_COMMANDS = new Set(['start', 'help', 'resume', 'open', 'gesprekken', 'nieuw', 'status', 'whatsapp']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const MAX_OWNER_ATTEMPTS = 5;
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

const getChatter = async (botId: string, chatId: number) => (await query<Chatter>(
  'SELECT id, chat_id, name, status, is_owner, conversation_id FROM telegram_agent_chatters WHERE bot_id = $1 AND chat_id = $2', [botId, chatId])).rows[0] ?? null;
const chatterById = async (id: string) => (await query<Chatter>(
  'SELECT id, chat_id, name, status, is_owner, conversation_id FROM telegram_agent_chatters WHERE id = $1', [id])).rows[0] ?? null;

/** New link code for a bot: owner = single use, 15 minutes; invite = 24 hours, for several people. */
export async function newBotCode(botId: string, kind: 'owner' | 'invite'): Promise<{ code: string; expiresAt: string }> {
  const { randomInt } = await import('crypto');
  const code = Array.from({ length: kind === 'owner' ? 6 : 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const r = kind === 'owner'
    ? await query<{ e: string }>(`UPDATE telegram_agent_bots SET owner_code = $2, owner_code_expires = now() + interval '15 minutes', owner_code_attempts = 0
        WHERE id = $1 RETURNING owner_code_expires AS e`, [botId, code])
    : await query<{ e: string }>(`UPDATE telegram_agent_bots SET invite_code = $2, invite_code_expires = now() + interval '24 hours'
        WHERE id = $1 RETURNING invite_code_expires AS e`, [botId, code]);
  return { code, expiresAt: new Date(r.rows[0].e).toISOString() };
}

/** Which kind of code this is for the bot, or null. The owner code burns attempts and is single use. */
async function useCode(botId: string, raw: string): Promise<'owner' | 'invite' | null> {
  const code = raw.trim().toUpperCase();
  const inv = (await query<{ ok: boolean }>(
    'SELECT (invite_code = $2 AND invite_code_expires > now()) AS ok FROM telegram_agent_bots WHERE id = $1', [botId, code])).rows[0];
  if (inv?.ok) return 'invite';
  const r = (await query<{ owner_code: string; expired: boolean; owner_code_attempts: number }>(
    `UPDATE telegram_agent_bots SET owner_code_attempts = owner_code_attempts + 1 WHERE id = $1 AND owner_code IS NOT NULL
     RETURNING owner_code, owner_code_expires < now() AS expired, owner_code_attempts`, [botId])).rows[0];
  if (!r) return null;
  if (r.expired || r.owner_code_attempts > MAX_OWNER_ATTEMPTS) {
    await query('UPDATE telegram_agent_bots SET owner_code = NULL, owner_code_expires = NULL WHERE id = $1', [botId]);
    return null;
  }
  if (r.owner_code !== code) return null;
  await query('UPDATE telegram_agent_bots SET owner_code = NULL, owner_code_expires = NULL, owner_code_attempts = 0 WHERE id = $1', [botId]);
  return 'owner';
}

async function allow(bot: BotRow, chatterId: string): Promise<boolean> {
  await query(`DELETE FROM telegram_agent_hits WHERE at < now() - interval '2 hours'`);
  const used = Number((await query<{ n: string }>(
    `SELECT count(*) AS n FROM telegram_agent_hits WHERE chatter_id = $1 AND at > now() - interval '1 hour'`, [chatterId])).rows[0].n);
  if (bot.rate_per_hour > 0 && used >= bot.rate_per_hour) return false;
  await query('INSERT INTO telegram_agent_hits (chatter_id) VALUES ($1)', [chatterId]);
  return true;
}

async function sendHtml(token: string, chatId: number, text: string, html?: boolean): Promise<void> {
  try { await tg.sendMessage(token, chatId, text, html); } catch (err) {
    if (!html || !(err instanceof tg.TelegramError) || err.status !== 400) throw err;
    await tg.sendMessage(token, chatId, htmlToPlain(text)); // Telegram refuses HTML it cannot parse
  }
}

type Started = { busy: true } | { busy: false; assistantMsgId: string };

/**
 * Deps for createBot; the link's userId is the chatter id. owner = the chatter who linked with the owner code:
 * no rate limit, all own conversations, and (opt_messenger) the WhatsApp link of the owner.
 */
function depsFor(bot: BotRow, token: string, owner: boolean): BotDeps<number> {
  const messengerOn = owner && bot.opt_messenger;
  const base = `c.user_id = $1 AND c.status != 'deleted' AND NOT (c.metadata ? 'isSystem')`;

  async function list(chatterId: string) {
    if (!owner) {
      return (await query<{ id: string; title: string; updated_at: string }>(
        `SELECT c.id, c.title, c.updated_at FROM conversations c WHERE ${base} AND c.metadata->>'telegram_chatter' = $2
          ORDER BY c.updated_at DESC LIMIT ${LIST_LIMIT}`, [bot.user_id, chatterId])).rows;
    }
    const ids = (await botAgents(bot)).map((a) => a.id);
    // never the conversations of other chatters of this bot
    const mine = `(c.metadata->>'telegram_chatter' IS NULL OR c.metadata->>'telegram_chatter' = $2)`;
    if (!ids.length) {
      return (await query<{ id: string; title: string; updated_at: string }>(
        `SELECT c.id, c.title, c.updated_at FROM conversations c WHERE ${base} AND ${mine}
          ORDER BY c.updated_at DESC LIMIT ${LIST_LIMIT}`, [bot.user_id, chatterId])).rows;
    }
    return (await query<{ id: string; title: string; updated_at: string }>(
      `SELECT c.id, c.title, c.updated_at FROM conversations c WHERE ${base} AND ${mine} AND (
          c.metadata->>'telegram_chatter' = $2
          OR c.metadata->>'delegated_agent_id' = ANY($3::text[])
          OR c.metadata->'telegram_agent_ids' ?| $3::text[]
          OR EXISTS (SELECT 1 FROM scheduled_tasks t WHERE t.id::text = c.metadata->>'task_id' AND t.agent_id::text = ANY($3::text[])))
        ORDER BY c.updated_at DESC LIMIT ${LIST_LIMIT}`, [bot.user_id, chatterId, ids])).rows;
  }

  async function startOnce(conv: { id: string; model: string; metadata: Record<string, unknown> }, role: string, language: string,
    text: string, prompt: string): Promise<Started> {
    const { startConversationRun } = await import('../../routes/stream');
    return startConversationRun({ userId: bot.user_id, role, language, conv, userMessage: text, attachmentIds: [], appendSystemPrompt: prompt });
  }

  return {
    send: (chatId, text, html) => sendHtml(token, chatId, text, html),
    typing: (chatId) => tg.sendTyping(token, chatId),
    botName: async () => bot.name,
    listConversations: list,
    createConversation: async (chatterId) => {
      const c = await chatterById(chatterId);
      const agentIds = (await botAgents(bot)).map((a) => a.id);
      const meta = { telegram: true, telegram_agent_bot: bot.id, telegram_bot_name: bot.name, telegram_chatter: chatterId,
        telegram_chatter_name: c?.name ?? '', ...(agentIds.length ? { telegram_agent_ids: agentIds } : {}) };
      const title = owner && !agentIds.length ? 'Telegram-gesprek' : `${bot.name} · ${c?.name ?? 'Telegram'}`;
      return (await query<{ id: string }>('INSERT INTO conversations (user_id, title, metadata) VALUES ($1, $2, $3::jsonb) RETURNING id',
        [bot.user_id, title.slice(0, 200), JSON.stringify(meta)])).rows[0].id;
    },
    markTelegram: async (id) => { await query(`UPDATE conversations SET metadata = metadata || '{"telegram": true}'::jsonb WHERE id = $1`, [id]); },
    savePairing: async () => undefined, // pairing happens before createBot (owner or invite code)
    checkPairCode: async () => false,
    setActive: async (chatterId, id) => {
      if (messengerOn) await messenger.setActive(bot.user_id, 'telegram', id);
      await query('UPDATE telegram_agent_chatters SET conversation_id = $2 WHERE id = $1', [chatterId, id]);
    },
    getActive: async (chatterId) => (messengerOn
      ? messenger.getActive(bot.user_id, 'telegram')
      : (await chatterById(chatterId))?.conversation_id ?? null),
    ...(messengerOn ? {
      relayTo: { command: 'whatsapp', send: (_c: string, text: string) => messenger.relay(bot.user_id, 'telegram', text) },
      afterReply: (_c: string, convId: string, q: string, a: string) => messenger.mirror(bot.user_id, 'telegram', convId, q, a),
      statusExtra: () => messenger.otherStatusLine(bot.user_id, 'telegram'),
    } : {}),
    startRun: async (chatterId, convId, text, notify) => {
      const fail = (m: string) => ({ ok: true as const, reply: Promise.reject(new Error(m)) });
      if ((await getAuthStatus(bot.user_id)) !== 'authenticated') {
        return fail(owner ? 'Je Claude-account is niet gekoppeld (web-app, Instellingen, Claude Code).' : 'De eigenaar van deze bot heeft Claude nu niet gekoppeld.');
      }
      const conv = (await query<{ id: string; model: string; metadata: Record<string, unknown> }>(
        `SELECT id, model, metadata FROM conversations WHERE id = $1 AND user_id = $2 AND status != 'deleted'`, [convId, bot.user_id])).rows[0];
      if (!conv || (!owner && conv.metadata?.telegram_chatter !== chatterId)) return fail('Gesprek niet gevonden. Kies er een met /resume of begin met /nieuw.');
      const chatter = await chatterById(chatterId);
      const who = chatter?.name ?? 'de gesprekspartner';
      const u = (await query<{ role: string; language: string | null; name: string | null }>('SELECT role, language, name FROM users WHERE id = $1', [bot.user_id])).rows[0];
      const role = owner ? (u?.role ?? 'user') : 'user';
      const language = u?.language ?? 'nl';
      const agents = await botAgents(bot);

      if (!agents.length) {
        // Claude itself, like the personal bot used to be
        const prompt = bot.opt_full
          ? messengerPrompt('telegram', owner ? (u?.name ?? null) : who)
          : agentChatPrompt({ name: 'Claude', prompt: 'Je bent de assistent van de eigenaar van deze bot en helpt de gesprekspartner met zijn vraag.', knowledge: null }, who, bot.name);
        const onSwitch = (cid: string, note: string) => { if (cid === conv.id) notify?.(note); };
        accountEvents.on('switch', onSwitch);
        const started = await startOnce(conv, role, language, text, prompt);
        if (started.busy) { accountEvents.off('switch', onSwitch); return { ok: false, busy: true }; }
        const reply = waitForReply(started.assistantMsgId).then((t) => (bot.opt_full ? t : cleanAgentAnswer(t)));
        void reply.catch(() => undefined).finally(() => accountEvents.off('switch', onSwitch));
        return { ok: true, reply };
      }

      // One or more agents: @naam, or the coordinator picks (a meeting); each answers in turn.
      const infos: AgentInfo[] = agents.map((a) => ({ id: a.id, name: a.name, slug: a.slug, description: a.description }));
      const runAgent = async (a: Agent, question: string): Promise<string> => {
        const prompt = bot.opt_full
          ? [`Je bent ${a.name}.`, a.prompt.trim(), a.knowledge?.trim() ? `Wat je geleerd hebt:\n${a.knowledge.trim()}` : '',
            messengerPrompt('telegram', owner ? (u?.name ?? null) : who)].filter(Boolean).join('\n\n')
          : agentChatPrompt(a, who, bot.name);
        const model = ['haiku', 'sonnet', 'opus'].includes(a.model) ? a.model : conv.model;
        for (let attempt = 0; attempt < 8; attempt++) {
          const started = await startOnce({ ...conv, model }, role, language, question, prompt);
          if (!started.busy) {
            const t = await waitForReply(started.assistantMsgId);
            return bot.opt_full ? t : cleanAgentAnswer(t);
          }
          await new Promise((r) => setTimeout(r, 4000)); // the owner is typing in this conversation too
        }
        throw new Error('gesprek is bezet');
      };
      const reply = (async (): Promise<string> => {
        let chosen: AgentInfo[] = [];
        let question = text;
        if (infos.length === 1) {
          chosen = infos;
          question = parseMention(text, infos).rest || text;
        } else {
          const m = parseMention(text, infos);
          if (m.unknown) return `Die agent ken ik niet. Beschikbaar: ${infos.map((a) => `@${a.name}`).join(', ')}.`;
          if (m.agent) {
            if (!m.rest) return AGENT_TEXT.emptyQuestion;
            chosen = [m.agent];
            question = m.rest;
          } else {
            let plan: Coordination;
            try { plan = await coordinate(bot.user_id, question, infos); } catch { return AGENT_TEXT.noCoordination; }
            const bySlug = new Map(infos.map((a) => [a.slug, a]));
            chosen = [...new Set(plan.agents)].map((s) => bySlug.get(s)).filter((a): a is AgentInfo => !!a).slice(0, MAX_AGENTS_PER_QUESTION);
            if (!chosen.length) {
              return `**${infos.map((a) => a.name).join(' en ')}**\n\n${plan.reason.trim() || 'Dit valt buiten wat wij kunnen. Probeer het anders te vragen.'}`;
            }
          }
        }
        const parts: string[] = [];
        for (const info of chosen) {
          const a = agents.find((x) => x.id === info.id)!;
          let answer: string;
          try { answer = await runAgent(a, question); } catch (err) {
            console.error('[telegram-bot] agent run failed:', (err as Error).message);
            answer = AGENT_TEXT.failed;
          }
          parts.push(`**${a.name}**\n\n${answer}`);
        }
        return parts.join('\n\n');
      })();
      return { ok: true, reply };
    },
  };
}

async function welcome(bot: BotRow, c: Chatter): Promise<string> {
  const agents = await botAgents(bot);
  const lines = [`Welkom, ${firstName(c.name)}. Ik ben ${bot.name}.`];
  if (!agents.length) lines.push(c.is_owner ? 'Via mij praat je met Claude op de NAS.' : 'Via mij praat je met Claude, de assistent van de eigenaar.');
  else if (agents.length === 1) lines.push(`Je praat hier met ${agents[0].name}.`);
  else lines.push(`Je kunt een agent aanspreken met @naam: ${agents.map((a) => `@${a.name}`).join(', ')}. Zonder @naam kiest het team zelf wie antwoordt.`);
  if (bot.opt_commands) {
    lines.push('/resume — je recente gesprekken\n/resume <nr> — verder in een gesprek\n/nieuw — nieuw gesprek\n/status — welk gesprek actief is'
      + (c.is_owner && bot.opt_messenger ? '\n/whatsapp <tekst> — doorsturen naar je WhatsApp' : ''));
  }
  lines.push('Typ gewoon je bericht.');
  return lines.join('\n\n');
}

const commandsFor = (bot: BotRow) => (bot.opt_commands ? COMMANDS.filter((c) => bot.opt_messenger || c.command !== 'whatsapp') : []);

/** Handles one update: access (code, request, approval) here, the conversation itself in createBot. */
function createHandler(bot: BotRow, token: string, signal: AbortSignal) {
  const ownerBot = createBot<number>(depsFor(bot, token, true), signal);
  const guestBot = createBot<number>(depsFor(bot, token, false), signal);
  const links = new Map<string, Link<number>>();
  const send = (chatId: number, text: string) => (signal.aborted ? Promise.resolve() : sendHtml(token, chatId, text));
  const push = (body: string) => void sendPushToUser(bot.user_id, {
    title: `Telegram-bot ${bot.name}`, body, url: '/settings/telegram', tag: `tgbot-${bot.id}`,
  }).catch(() => undefined);

  return async function handleUpdate(update: TgUpdate<number>): Promise<void> {
    const msg = update.message;
    if (!msg?.text || signal.aborted) return;
    if (msg.chat.type && msg.chat.type !== 'private') return; // groups: never
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const name = ([msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || String(chatId)).slice(0, 120);
    let c = await getChatter(bot.id, chatId);

    const start = /^\/start(?:@\S+)?\s+(\S+)\s*$/i.exec(text);
    if (start) {
      const kind = await useCode(bot.id, start[1]);
      if (kind === 'owner' || (kind === 'invite' && (!c || c.status === 'pending'))) {
        c = (await query<Chatter>(
          `INSERT INTO telegram_agent_chatters (bot_id, chat_id, name, username, status, is_owner, decided_at)
           VALUES ($1, $2, $3, $4, 'approved', $5, now())
           ON CONFLICT (bot_id, chat_id) DO UPDATE SET status = 'approved', is_owner = telegram_agent_chatters.is_owner OR $5, decided_at = now()
           RETURNING id, chat_id, name, status, is_owner, conversation_id`, [bot.id, chatId, name, msg.chat.username ?? null, kind === 'owner'])).rows[0];
        links.delete(c.id);
        if (kind === 'invite') push(`${name} is via je uitnodigingslink toegevoegd.`);
        return send(chatId, await welcome(bot, c));
      }
    }

    if (!c) {
      const r = await query(`INSERT INTO telegram_agent_chatters (bot_id, chat_id, name, username) VALUES ($1,$2,$3,$4)
         ON CONFLICT (bot_id, chat_id) DO NOTHING RETURNING id`, [bot.id, chatId, name, msg.chat.username ?? null]);
      if (r.rows.length) push(`${name} vraagt toegang tot ${bot.name}.`);
      return send(chatId, AGENT_TEXT.requested);
    }
    if (c.status === 'pending') return send(chatId, AGENT_TEXT.stillPending);
    if (c.status !== 'approved') return; // denied or revoked: no answer, nothing runs

    const cmd = /^\/([a-z]+)(?:@\S+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase() ?? null;
    if (cmd === 'start' || cmd === 'help') return send(chatId, await welcome(bot, c));
    if (cmd && !bot.opt_commands) return; // commands off: one conversation, nothing else
    if (!c.is_owner && !(cmd && KNOWN_COMMANDS.has(cmd)) && !(await allow(bot, c.id))) return send(chatId, AGENT_TEXT.rateLimited);

    let link = links.get(c.id);
    if (!link || link.chatId !== chatId) {
      link = { userId: c.id, chatId, activeConversationId: c.conversation_id };
      links.set(c.id, link);
    }
    return (c.is_owner ? ownerBot : guestBot).handleUpdate(link, update);
  };
}

interface Poller { stop(): void; done: Promise<void> }
const pollers = new Map<string, Poller>();
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});
const setStatus = (id: string, status: string, message: string | null) =>
  query('UPDATE telegram_agent_bots SET status = $2, status_message = $3, updated_at = now() WHERE id = $1', [id, status, message]);

function startPoller(bot: BotRow, token: string): Poller {
  const ctl = new AbortController();
  const handle = createHandler(bot, token, ctl.signal);
  const loop = async () => {
    let offset = Number(bot.update_offset ?? 0);
    try {
      const me = await tg.getMe(token);
      await query("UPDATE telegram_agent_bots SET bot_username = $2, status = 'ok', status_message = NULL WHERE id = $1", [bot.id, me.username]);
      await tg.setCommands(token, commandsFor(bot)).catch(() => undefined);
      if (me.first_name !== bot.name) {
        // only when it differs: Telegram rate-limits these calls
        await tg.setProfile(token, bot.name, `Goedendag, ik ben ${bot.name}. Stuur me een bericht; de eigenaar laat je toe.`, `${bot.name} op Telegram.`)
          .catch((e) => console.error('[telegram-bot] setProfile failed:', (e as Error).message));
      }
    } catch (err) {
      await setStatus(bot.id, 'error', `Bot-token werkt niet: ${(err as Error).message}`);
      if (err instanceof tg.TelegramError && err.status === 401) return;
    }
    while (!ctl.signal.aborted) {
      try {
        const updates = await tg.getUpdates(token, offset, POLL_TIMEOUT_SEC, ctl.signal);
        for (const u of updates) {
          if (ctl.signal.aborted) break;
          offset = u.update_id + 1;
          await query('UPDATE telegram_agent_bots SET update_offset = $2 WHERE id = $1', [bot.id, offset]);
          await handle(u as TgUpdate<number>).catch((e) => console.error('[telegram-agent] update failed:', e));
        }
      } catch (err) {
        if (ctl.signal.aborted) break;
        if (err instanceof tg.TelegramError && err.status === 401) {
          await setStatus(bot.id, 'error', 'Bot-token ongeldig of ingetrokken. Plak een nieuwe token.');
          return;
        }
        const conflict = err instanceof tg.TelegramError && err.status === 409;
        await setStatus(bot.id, 'error', conflict
          ? 'Deze bot wordt ook ergens anders uitgelezen (409). Stop dat programma.'
          : `Telegram onbereikbaar: ${(err as Error).message}. Nieuwe poging over 30 s.`);
        await sleep(RETRY_MS, ctl.signal);
        if (!ctl.signal.aborted) await setStatus(bot.id, 'ok', null);
      }
    }
  };
  const done = loop().catch((err) => console.error('[telegram-agent] poller crashed:', err));
  return { stop: () => ctl.abort(), done };
}

const reloads = new Map<string, Promise<void>>();

/** (Re)start one bot from the saved settings; calls per bot run one after another. */
export function reloadAgentBot(botId: string): Promise<void> {
  const next = (reloads.get(botId) ?? Promise.resolve()).then(() => doReload(botId));
  const tail = next.catch(() => undefined);
  reloads.set(botId, tail);
  void tail.then(() => { if (reloads.get(botId) === tail) reloads.delete(botId); });
  return next;
}

async function doReload(botId: string): Promise<void> {
  const old = pollers.get(botId);
  if (old) { old.stop(); pollers.delete(botId); await old.done.catch(() => undefined); }
  const row = (await query<BotRow>(`SELECT ${BOT_COLUMNS} FROM telegram_agent_bots WHERE id = $1`, [botId])).rows[0];
  if (!row) return;
  if (!row.enabled) { await setStatus(botId, 'off', null); return; }
  pollers.set(botId, startPoller(row, decrypt(row.bot_token_enc)));
}

export async function stopAgentBot(botId: string): Promise<void> {
  const old = pollers.get(botId);
  if (old) { old.stop(); pollers.delete(botId); await old.done.catch(() => undefined); }
}

/** Message to a chatter from the bot (approval, refusal). Never throws. */
export async function notifyChatter(botId: string, chatId: number, text: string): Promise<void> {
  try {
    const r = (await query<{ bot_token_enc: string }>('SELECT bot_token_enc FROM telegram_agent_bots WHERE id = $1', [botId])).rows[0];
    if (r) await tg.sendMessage(decrypt(r.bot_token_enc), chatId, text);
  } catch (e) { console.error('[telegram-agent] notify failed:', (e as Error).message); }
}

export async function startAgentBots(): Promise<void> {
  try {
    const r = await query<{ id: string }>('SELECT id FROM telegram_agent_bots WHERE enabled = true');
    for (const { id } of r.rows) await reloadAgentBot(id);
    if (r.rows.length) console.log(`✓ Telegram-agentbots: ${r.rows.length} gestart`);
  } catch (err) { console.error('✗ Telegram-agentbots start failed:', err); }
}

export async function stopAllAgentBots(): Promise<void> {
  const all = [...pollers.values()];
  pollers.clear();
  for (const p of all) p.stop();
  await Promise.all(all.map((p) => p.done.catch(() => undefined)));
}
