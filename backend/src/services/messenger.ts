/**
 * Telegram and WhatsApp side by side: the user's own chats on both channels.
 * - Claude can send a message to either channel (curl to /messenger with a per-run token).
 * - /telegram <tekst> in WhatsApp and /whatsapp <tekst> in Telegram forward to the other channel.
 * - Optional: mirror every question+answer to the other channel, and one shared active conversation.
 * Every part has its own switch in messenger_settings; nothing goes to other people's chats.
 */
import { randomBytes } from 'crypto';
import { query } from '../db';
import { redis } from '../redis';
import { decrypt, hashToken } from './crypto';

export type Channel = 'telegram' | 'whatsapp';
export const CHANNELS: Channel[] = ['telegram', 'whatsapp'];
export const LABEL: Record<Channel, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' };
export const other = (c: Channel): Channel => (c === 'telegram' ? 'whatsapp' : 'telegram');

export interface MessengerSettings {
  /** Claude may send messages via this channel */
  claudeTelegram: boolean;
  claudeWhatsapp: boolean;
  /** /telegram and /whatsapp forward commands may deliver to this channel */
  relayTelegram: boolean;
  relayWhatsapp: boolean;
  /** questions and answers from the other channel are copied here */
  mirrorTelegram: boolean;
  mirrorWhatsapp: boolean;
  /** /resume and /nieuw on one channel also switch the other one */
  syncActive: boolean;
  /** Claude may send WhatsApp messages to other numbers than the user's own; off unless switched on by hand */
  contactsWhatsapp: boolean;
  /** Max. different recipients per hour for contactsWhatsapp; 0 = unlimited */
  recipientsPerHour: number;
}
type BoolKey = Exclude<keyof MessengerSettings, 'recipientsPerHour'>;
export const MAX_RECIPIENTS_PER_HOUR = 10000;

export const DEFAULTS: MessengerSettings = {
  claudeTelegram: true, claudeWhatsapp: true,
  relayTelegram: true, relayWhatsapp: true,
  mirrorTelegram: false, mirrorWhatsapp: false,
  syncActive: false,
  contactsWhatsapp: false,
  recipientsPerHour: 20,
};

const COLUMNS: Record<BoolKey, string> = {
  claudeTelegram: 'claude_telegram', claudeWhatsapp: 'claude_whatsapp',
  relayTelegram: 'relay_telegram', relayWhatsapp: 'relay_whatsapp',
  mirrorTelegram: 'mirror_telegram', mirrorWhatsapp: 'mirror_whatsapp',
  syncActive: 'sync_active',
  contactsWhatsapp: 'contacts_whatsapp',
};

export async function ensureMessengerSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS messenger_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      claude_telegram BOOLEAN NOT NULL DEFAULT TRUE,
      claude_whatsapp BOOLEAN NOT NULL DEFAULT TRUE,
      relay_telegram BOOLEAN NOT NULL DEFAULT TRUE,
      relay_whatsapp BOOLEAN NOT NULL DEFAULT TRUE,
      mirror_telegram BOOLEAN NOT NULL DEFAULT FALSE,
      mirror_whatsapp BOOLEAN NOT NULL DEFAULT FALSE,
      sync_active BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query('ALTER TABLE messenger_settings ADD COLUMN IF NOT EXISTS contacts_whatsapp BOOLEAN NOT NULL DEFAULT FALSE');
  await query('ALTER TABLE messenger_settings ADD COLUMN IF NOT EXISTS recipients_per_hour INTEGER NOT NULL DEFAULT 20');
}

export async function getSettings(userId: string): Promise<MessengerSettings> {
  const r = await query<Record<string, boolean | number>>('SELECT * FROM messenger_settings WHERE user_id = $1', [userId]);
  const row = r.rows[0];
  const out = { ...DEFAULTS };
  if (!row) return out;
  for (const [k, col] of Object.entries(COLUMNS) as Array<[BoolKey, string]>) out[k] = (row[col] as boolean | undefined) ?? DEFAULTS[k];
  out.recipientsPerHour = Number(row.recipients_per_hour ?? DEFAULTS.recipientsPerHour);
  return out;
}

export async function saveSettings(userId: string, patch: Partial<Record<keyof MessengerSettings, unknown>>): Promise<MessengerSettings> {
  await query('INSERT INTO messenger_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  for (const [k, col] of Object.entries(COLUMNS) as Array<[BoolKey, string]>) {
    if (typeof patch[k] === 'boolean') { vals.push(patch[k]); sets.push(`${col} = $${vals.length}`); }
  }
  if (patch.recipientsPerHour !== undefined) {
    const n = Number(patch.recipientsPerHour);
    if (!Number.isInteger(n) || n < 0 || n > MAX_RECIPIENTS_PER_HOUR) {
      throw new RangeError(`Ontvangers per uur moet een heel getal van 0 tot ${MAX_RECIPIENTS_PER_HOUR} zijn (0 = onbeperkt)`);
    }
    vals.push(n); sets.push(`recipients_per_hour = $${vals.length}`);
  }
  if (sets.length) await query(`UPDATE messenger_settings SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, vals);
  return getSettings(userId);
}

const flag = (s: MessengerSettings, kind: 'claude' | 'relay' | 'mirror', c: Channel): boolean =>
  s[`${kind}${c === 'telegram' ? 'Telegram' : 'Whatsapp'}` as BoolKey];

// ── Channel state and delivery ───────────────────────────────

export interface ChannelState { channel: Channel; ready: boolean; reason: string | null }

export async function channelState(userId: string, c: Channel): Promise<ChannelState> {
  if (c === 'telegram') {
    const r = await query<{ enabled: boolean; bot_token_enc: string | null; chat_id: string | null }>(
      'SELECT enabled, bot_token_enc, chat_id FROM telegram_links WHERE user_id = $1', [userId]);
    const row = r.rows[0];
    const reason = !row?.bot_token_enc ? 'niet ingesteld' : !row.enabled ? 'uitgeschakeld' : row.chat_id == null ? 'niet gekoppeld' : null;
    return { channel: c, ready: reason === null, reason };
  }
  const { whatsappConnected } = await import('./whatsapp/manager');
  const r = await query<{ enabled: boolean; phone_jid: string | null }>('SELECT enabled, phone_jid FROM whatsapp_links WHERE user_id = $1', [userId]);
  const row = r.rows[0];
  const reason = !row?.phone_jid ? 'niet gekoppeld' : !row.enabled ? 'uitgeschakeld' : !whatsappConnected(userId) ? 'geen verbinding' : null;
  return { channel: c, ready: reason === null, reason };
}

/** Delivers markdown text to the user's own chat on a channel. Throws with a readable reason. */
export async function deliver(userId: string, c: Channel, text: string): Promise<void> {
  const st = await channelState(userId, c);
  if (!st.ready) throw new Error(`${LABEL[c]} ${st.reason}`);
  if (c === 'telegram') {
    const row = (await query<{ bot_token_enc: string; chat_id: string }>(
      'SELECT bot_token_enc, chat_id FROM telegram_links WHERE user_id = $1', [userId])).rows[0];
    const { depsFor } = await import('./telegram/manager');
    const { toTelegramChunks } = await import('./telegram/format');
    const deps = depsFor(decrypt(row.bot_token_enc));
    for (const part of toTelegramChunks(text)) await deps.send(Number(row.chat_id), part, true);
    return;
  }
  const { whatsappSendSelf } = await import('./whatsapp/manager');
  await whatsappSendSelf(userId, text);
}

/** Sent by Claude from a conversation. */
export async function claudeSend(userId: string, c: Channel, text: string): Promise<void> {
  const s = await getSettings(userId);
  if (!flag(s, 'claude', c)) throw new Error(`Claude mag niet via ${LABEL[c]} sturen (Instellingen, ${LABEL[c]})`);
  await deliver(userId, c, text);
}

// ── WhatsApp to other people ─────────────────────────────────

// Only the number of DIFFERENT recipients per hour is capped (setting recipientsPerHour, 0 = unlimited);
// any number of messages to the same people is fine.

/** "+31 6-1234 5678", "0031612345678", "0612345678" -> "31612345678" (Dutch 06 when no country code). */
export function normalizeNumber(input: string): string | null {
  let d = input.replace(/[\s().-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (/^0[1-9]/.test(d)) d = '31' + d.slice(1);
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

/** Sent by Claude to someone else's WhatsApp; returns the number used. */
export async function claudeSendContact(userId: string, to: string, text: string): Promise<string> {
  const s = await getSettings(userId);
  if (!s.claudeWhatsapp) throw new Error('Claude mag niet via WhatsApp sturen (Instellingen, WhatsApp)');
  if (!s.contactsWhatsapp) throw new Error('Versturen naar andere contacten staat uit; de gebruiker kan dit aanzetten in Instellingen, WhatsApp');
  const number = normalizeNumber(to);
  if (!number) throw new Error(`Ongeldig nummer: ${to}. Gebruik het internationale formaat, bijvoorbeeld 31612345678`);
  const st = await channelState(userId, 'whatsapp');
  if (!st.ready) throw new Error(`WhatsApp ${st.reason}`);
  const limit = s.recipientsPerHour;
  const key = `messenger:recipients:${userId}:${Math.floor(Date.now() / 3_600_000)}`;
  if (!(await redis.sismember(key, number))) {
    if (limit > 0 && (await redis.scard(key)) >= limit) {
      throw new Error(`Dit uur al naar ${limit} verschillende mensen gestuurd (instelbaar in Instellingen, WhatsApp); naar hen kan nog wel, een nieuwe ontvanger pas volgend uur`);
    }
    await redis.sadd(key, number);
    await redis.expire(key, 3700);
  }
  const { whatsappSendTo } = await import('./whatsapp/manager');
  await whatsappSendTo(userId, number, text);
  const { auditLog } = await import('../middleware/auth');
  await auditLog(userId, 'whatsapp.send_contact', 'whatsapp', null, 'claude', { to: number, chars: text.length, preview: text.slice(0, 200) });
  return number;
}

/** /telegram <tekst> or /whatsapp <tekst> typed in the other channel; returns the confirmation text. */
export async function relay(userId: string, from: Channel, text: string): Promise<string> {
  const to = other(from);
  const s = await getSettings(userId);
  if (!flag(s, 'relay', to)) return `Doorsturen naar ${LABEL[to]} staat uit (Instellingen, ${LABEL[to]}).`;
  if (!text.trim()) return `Gebruik: /${to} <tekst>`;
  try {
    await deliver(userId, to, `Doorgestuurd vanuit ${LABEL[from]}:\n\n${text}`);
    return `Doorgestuurd naar ${LABEL[to]}.`;
  } catch (err) {
    return `Niet doorgestuurd: ${(err as Error).message}.`;
  }
}

/** Copy of a finished question+answer for the other channel, when that channel mirrors. Never throws. */
export async function mirror(userId: string, from: Channel, conversationId: string, question: string, answer: string): Promise<void> {
  try {
    const to = other(from);
    const s = await getSettings(userId);
    if (!flag(s, 'mirror', to)) return;
    if (!(await channelState(userId, to)).ready) return;
    const title = (await query<{ title: string }>('SELECT title FROM conversations WHERE id = $1', [conversationId])).rows[0]?.title;
    const q = question.length > 500 ? question.slice(0, 500) + '...' : question;
    await deliver(userId, to, `Via ${LABEL[from]}${title ? `, ${title}` : ''}\n\nJij: ${q}\n\n${answer}`);
  } catch (err) {
    console.error('[messenger] mirror failed:', err);
  }
}

const TABLE: Record<Channel, string> = { telegram: 'telegram_links', whatsapp: 'whatsapp_links' };

/** Saves the active conversation of a channel; with syncActive also of the other channel. */
export async function setActive(userId: string, c: Channel, id: string | null): Promise<void> {
  await query(`UPDATE ${TABLE[c]} SET active_conversation_id = $2, updated_at = now() WHERE user_id = $1`, [userId, id]);
  if ((await getSettings(userId)).syncActive) {
    await query(`UPDATE ${TABLE[other(c)]} SET active_conversation_id = $2, updated_at = now() WHERE user_id = $1`, [userId, id]);
  }
}

/** Current active conversation as saved (with syncActive the other channel may have changed it). */
export async function getActive(userId: string, c: Channel): Promise<string | null> {
  const r = await query<{ active_conversation_id: string | null }>(`SELECT active_conversation_id FROM ${TABLE[c]} WHERE user_id = $1`, [userId]);
  return r.rows[0]?.active_conversation_id ?? null;
}

/** One line for /status: how the other channel is doing. */
export async function otherStatusLine(userId: string, c: Channel): Promise<string> {
  const o = other(c);
  const st = await channelState(userId, o);
  const s = await getSettings(userId);
  const opts = [
    flag(s, 'relay', o) ? `/${o} <tekst> stuurt door` : null,
    flag(s, 'mirror', o) ? 'leest mee' : null,
    s.syncActive ? 'actief gesprek gedeeld' : null,
  ].filter(Boolean);
  return `${LABEL[o]}: ${st.ready ? 'verbonden' : st.reason}${opts.length ? ` (${opts.join(', ')})` : ''}`;
}

// ── Per-run token for Claude ─────────────────────────────────

const TOKEN_TTL_SEC = 6 * 3600;
const tokenKey = (t: string) => `messenger:token:${hashToken(t)}`;

/** Returns null when Claude may not send via any channel that is set up. */
export async function issueClaudeToken(userId: string): Promise<{ token: string; channels: Channel[]; contacts: boolean; recipientsPerHour: number; botName: string | null } | null> {
  const s = await getSettings(userId);
  const states = await Promise.all(CHANNELS.map((c) => channelState(userId, c)));
  // offered when allowed and set up; a temporarily lost WhatsApp connection still counts
  const channels = CHANNELS.filter((c, i) => flag(s, 'claude', c) && !['niet ingesteld', 'niet gekoppeld'].includes(states[i].reason ?? ''));
  if (!channels.length) return null;
  const token = randomBytes(24).toString('base64url');
  await redis.set(tokenKey(token), userId, 'EX', TOKEN_TTL_SEC);
  return { token, channels, contacts: s.contactsWhatsapp && channels.includes('whatsapp'), recipientsPerHour: s.recipientsPerHour, botName: (await (await import('./telegram/manager')).botIdentity(userId)).name };
}

export async function userForToken(token: string): Promise<string | null> {
  if (!token || token.length < 20) return null;
  return redis.get(tokenKey(token));
}
