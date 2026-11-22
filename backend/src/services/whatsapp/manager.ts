/**
 * WhatsApp as a linked device (the WhatsApp Web protocol via Baileys, no browser).
 * One session per user. Only messages the user sends to their own "Message yourself" chat
 * are handled; they go through the same bot logic as Telegram (/resume, /nieuw, ...).
 */
import fs from 'fs/promises';
import path from 'path';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion,
  DisconnectReason, Browsers, areJidsSameUser, jidNormalizedUser,
} from 'baileys';
import type { WASocket, WAMessage, proto, Contact } from 'baileys';
import { saveContacts, savePhoneForLid, phoneOfJid, contactsWithoutPhone, countContacts, clearContacts, ContactRow } from './contacts';
import { query } from '../../db';
import { createBot, BotDeps, Link, TEXT } from '../telegram/bot';
import { depsFor } from '../telegram/manager';
import { toWhatsAppChunks, REPLY_PREFIX } from './format';
import * as messenger from '../messenger';

const DATA_DIR = process.env.WHATSAPP_DATA_DIR || '/data/whatsapp';
const logger = pino({ level: process.env.WHATSAPP_LOG_LEVEL || 'silent' });
const SELF = 'self'; // the bot only ever talks to one chat: the user's own
const MAX_AGE_MS = 10 * 60_000; // messages older than this (offline backlog) are ignored
const MAX_RETRY_MS = 60_000;
/** App-state collections; the address book (contactAction) lives in critical_unblock_low. No messages. */
const APP_STATE = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'] as const;

export async function ensureWhatsAppSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_links (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      phone_jid TEXT,
      phone_lid TEXT,
      push_name TEXT,
      active_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      status TEXT,
      status_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const { ensureContactsSchema } = await import('./contacts');
  await ensureContactsSchema();
}

const authDir = (userId: string) => path.join(DATA_DIR, userId.replace(/[^a-zA-Z0-9-]/g, ''));

async function setStatus(userId: string, status: string, message: string | null): Promise<void> {
  await query('UPDATE whatsapp_links SET status = $2, status_message = $3, updated_at = now() WHERE user_id = $1', [userId, status, message]);
}

let cachedVersion: [number, number, number] | undefined;
async function waVersion(): Promise<[number, number, number] | undefined> {
  if (cachedVersion) return cachedVersion;
  try {
    const v = await fetchLatestBaileysVersion();
    cachedVersion = v.version as [number, number, number];
  } catch { /* fall back to the version built into Baileys */ }
  return cachedVersion;
}

function toMillis(ts: unknown): number {
  if (ts == null) return 0;
  if (typeof ts === 'object' && ts !== null && 'toNumber' in ts) return (ts as { toNumber(): number }).toNumber() * 1000;
  return Number(ts) * 1000;
}

/** Text of a message, also when wrapped (disappearing messages, own other device, ...). */
function textOf(m: proto.IMessage | null | undefined, depth = 0): string | null {
  if (!m || depth > 4) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  const inner = m.ephemeralMessage?.message ?? m.deviceSentMessage?.message ?? m.viewOnceMessage?.message
    ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message;
  if (inner) return textOf(inner, depth + 1);
  return m.imageMessage?.caption ?? m.videoMessage?.caption ?? null;
}

class Session {
  qr: string | null = null;
  private sock: WASocket | null = null;
  private stopped = false;
  private retries = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private replyJid: string | null = null;
  private readonly sentIds = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly startedAt = Date.now();
  private needWelcome: boolean;
  private readonly ctl = new AbortController();
  private readonly link: Link<string>;
  private readonly bot: ReturnType<typeof createBot<string>>;
  private contactSync: Promise<{ total: number; named: number }> | null = null;
  private autoSynced = false;

  constructor(private readonly userId: string, activeConversationId: string | null, wasLinked: boolean) {
    this.link = { userId, chatId: SELF, activeConversationId };
    this.needWelcome = !wasLinked;
    this.bot = createBot<string>(this.deps(), this.ctl.signal);
  }

  private deps(): BotDeps<string> {
    const base = depsFor('', 'whatsapp'); // shared parts: conversations list and Claude runs (WhatsApp chat style)
    return {
      ...base,
      typing: undefined,
      send: (_chat, text) => this.send(text),
      formatReply: (content) => toWhatsAppChunks(content),
      createConversation: async (userId) => (await query<{ id: string }>(
        `INSERT INTO conversations (user_id, title, metadata) VALUES ($1, 'WhatsApp-gesprek', '{"whatsapp": true}'::jsonb) RETURNING id`,
        [userId])).rows[0].id,
      markTelegram: async (id) => { await query(`UPDATE conversations SET metadata = metadata || '{"whatsapp": true}'::jsonb WHERE id = $1`, [id]); },
      savePairing: async () => undefined, // pairing is the QR scan
      checkPairCode: async () => false,
      setActive: (userId, id) => messenger.setActive(userId, 'whatsapp', id),
      getActive: (userId) => messenger.getActive(userId, 'whatsapp'),
      relayTo: { command: 'telegram', send: (userId, text) => messenger.relay(userId, 'whatsapp', text) },
      afterReply: (userId, convId, q, a) => messenger.mirror(userId, 'whatsapp', convId, q, a),
      statusExtra: (userId) => messenger.otherStatusLine(userId, 'whatsapp'),
    };
  }

  get connected(): boolean { return !!this.sock?.user && !this.stopped; }

  private async toRow(c: Partial<Contact>): Promise<ContactRow | null> {
    if (!c.id) return null;
    const jid = jidNormalizedUser(c.id);
    const lid = c.lid ? jidNormalizedUser(c.lid) : jid.endsWith('@lid') ? jid : null;
    let phone = phoneOfJid(c.phoneNumber ? jidNormalizedUser(c.phoneNumber) : null) ?? phoneOfJid(jid);
    if (!phone && lid) {
      try { phone = phoneOfJid(await this.sock?.signalRepository.lidMapping.getPNForLID(lid) ?? null); } catch { /* unknown yet */ }
    }
    return { jid, lid, phone, name: c.name ?? null, notify: c.notify ?? c.verifiedName ?? null };
  }

  private async onContacts(list: Array<Partial<Contact>>): Promise<void> {
    const rows = (await Promise.all(list.map((c) => this.toRow(c)))).filter((r): r is ContactRow => r !== null);
    if (rows.length) await saveContacts(this.userId, rows);
  }

  /** Pulls the address book from the phone (app-state snapshot). Only names and numbers. */
  syncContacts(): Promise<{ total: number; named: number }> {
    if (this.contactSync) return this.contactSync;
    const run = async () => {
      const sock = this.sock;
      if (!sock?.user || this.stopped) throw new Error('WhatsApp geen verbinding');
      await sock.resyncAppState(APP_STATE, true);
      // contacts known only by LID: ask the mapping store for their numbers
      const lids = await contactsWithoutPhone(this.userId);
      if (lids.length) {
        const maps = (await sock.signalRepository.lidMapping.getPNsForLIDs(lids).catch(() => null)) ?? [];
        for (const m of maps) {
          const phone = phoneOfJid(jidNormalizedUser(m.pn));
          if (phone) await savePhoneForLid(this.userId, jidNormalizedUser(m.lid), phone);
        }
      }
      return countContacts(this.userId);
    };
    this.contactSync = run().finally(() => { this.contactSync = null; });
    return this.contactSync;
  }

  /** Markdown text from outside the bot (Claude, the other channel) to the user's own chat. */
  async sendExternal(content: string): Promise<void> {
    if (!this.connected) throw new Error('WhatsApp geen verbinding');
    for (const part of toWhatsAppChunks(content)) await this.send(part);
  }

  /** Plain message to someone else (no "Claude:" prefix): it comes from the user's own account. */
  async sendToNumber(number: string, content: string): Promise<void> {
    const sock = this.sock;
    if (!sock?.user || this.stopped) throw new Error('WhatsApp geen verbinding');
    const [hit] = (await sock.onWhatsApp(number)) ?? [];
    if (!hit?.exists) throw new Error(`+${number} staat niet op WhatsApp`);
    if (this.isSelf(hit.jid)) throw new Error('Dat is je eigen nummer; stuur zonder to naar je eigen chat');
    for (const part of toWhatsAppChunks(content, 4000)) {
      const sent = await sock.sendMessage(hit.jid, { text: part });
      if (sent?.key?.id) this.sentIds.add(sent.key.id);
    }
  }

  private async send(text: string): Promise<void> {
    const sock = this.sock;
    if (!sock?.user || this.stopped) return;
    const jid = this.replyJid ?? jidNormalizedUser(sock.user.id);
    const sent = await sock.sendMessage(jid, { text: REPLY_PREFIX + text });
    const id = sent?.key?.id;
    if (id) {
      this.sentIds.add(id);
      if (this.sentIds.size > 1000) this.sentIds.delete(this.sentIds.values().next().value as string);
    }
  }

  private isSelf(jid: string | null | undefined): boolean {
    const me = this.sock?.user;
    if (!jid || !me) return false;
    return areJidsSameUser(jid, me.id) || (!!me.lid && areJidsSameUser(jid, me.lid));
  }

  private async onMessage(m: WAMessage): Promise<void> {
    const key = m.key;
    if (!key?.fromMe || !key.id) return;
    if (this.sentIds.has(key.id) || this.seen.has(key.id)) return;
    this.seen.add(key.id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value as string);
    const chatJid = this.isSelf(key.remoteJid) ? key.remoteJid! : this.isSelf(key.remoteJidAlt) ? key.remoteJidAlt! : null;
    if (!chatJid) return; // a message to someone else: never touch it
    const ts = toMillis(m.messageTimestamp);
    if (ts && ts < Math.min(this.startedAt, Date.now()) - MAX_AGE_MS) return;
    const text = textOf(m.message)?.trim();
    if (!text || text.startsWith(REPLY_PREFIX.trim())) return; // own reply sent from elsewhere
    this.replyJid = chatJid;
    await this.bot.handleUpdate(this.link, { update_id: 0, message: { chat: { id: SELF, type: 'private' }, text } });
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    const dir = authDir(this.userId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const version = await waVersion();
    if (this.stopped) return;
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('Claude Chat'),
      markOnlineOnConnect: false, // keep notifications on the phone
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      void (async () => {
        if (this.stopped || this.sock !== sock) return;
        if (u.isNewLogin) this.needWelcome = true;
        if (u.qr) {
          this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
          await setStatus(this.userId, 'qr', null);
        }
        if (u.connection === 'open') {
          this.qr = null;
          this.retries = 0;
          const me = sock.user;
          await query(`UPDATE whatsapp_links SET phone_jid = $2, phone_lid = $3, push_name = $4, status = 'ok', status_message = NULL,
                       updated_at = now() WHERE user_id = $1`,
          [this.userId, me ? jidNormalizedUser(me.id) : null, me?.lid ? jidNormalizedUser(me.lid) : null, me?.name ?? me?.notify ?? null]);
          if (!this.autoSynced) {
            this.autoSynced = true;
            // first connection without an address book yet: fetch it in the background
            void countContacts(this.userId).then((c) => (c.named === 0 ? this.syncContacts() : undefined))
              .catch((e) => console.error('[whatsapp] contact sync failed:', (e as Error).message));
          }
          if (this.needWelcome) {
            this.needWelcome = false;
            await this.send(TEXT.welcome.replace('Gekoppeld!', 'WhatsApp gekoppeld!') + '\n\nStuur je berichten hier, in je chat met jezelf.')
              .catch((e) => console.error('[whatsapp] welcome failed:', e));
          }
        }
        if (u.connection === 'close') await this.onClose(u.lastDisconnect?.error, state.creds.registered || !!state.creds.me);
      })().catch((e) => console.error('[whatsapp] connection update failed:', e));
    });
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) this.onMessage(m).catch((e) => console.error('[whatsapp] message failed:', e));
      // the name someone set on their own WhatsApp; their message itself is not read
      const seen = messages.filter((m) => !m.key?.fromMe && m.pushName && m.key?.remoteJid && !m.key.remoteJid.endsWith('@g.us'))
        .map((m) => ({ id: m.key.remoteJid!, phoneNumber: m.key.remoteJidAlt ?? undefined, notify: m.pushName! }));
      if (seen.length) this.onContacts(seen).catch((e) => console.error('[whatsapp] push names failed:', e));
    });
    sock.ev.on('contacts.upsert', (list) => { this.onContacts(list).catch((e) => console.error('[whatsapp] contacts failed:', e)); });
    sock.ev.on('contacts.update', (list) => { this.onContacts(list).catch((e) => console.error('[whatsapp] contacts failed:', e)); });
    sock.ev.on('messaging-history.set', ({ contacts }) => {
      if (contacts?.length) this.onContacts(contacts).catch((e) => console.error('[whatsapp] contacts failed:', e));
    });
    sock.ev.on('lid-mapping.update', (m) => {
      const phone = phoneOfJid(jidNormalizedUser(m.pn));
      if (phone) savePhoneForLid(this.userId, jidNormalizedUser(m.lid), phone).catch(() => undefined);
    });
  }

  private async onClose(error: unknown, registered: boolean): Promise<void> {
    this.sock = null;
    if (this.stopped) return;
    const code = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    if (code === DisconnectReason.loggedOut) {
      this.stopped = true;
      this.qr = null;
      await fs.rm(authDir(this.userId), { recursive: true, force: true });
      await clearContacts(this.userId);
      await query(`UPDATE whatsapp_links SET enabled = false, phone_jid = NULL, phone_lid = NULL, push_name = NULL,
                   status = 'loggedout', status_message = 'Uitgelogd vanaf je telefoon. Koppel opnieuw met een nieuwe QR-code.',
                   updated_at = now() WHERE user_id = $1`, [this.userId]);
      if (sessions.get(this.userId) === this) sessions.delete(this.userId);
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      this.stopped = true;
      await setStatus(this.userId, 'error', 'Deze koppeling is elders geopend. Zet WhatsApp uit en weer aan.');
      return;
    }
    if (!registered && code === DisconnectReason.timedOut) {
      this.stopped = true;
      this.qr = null;
      await setStatus(this.userId, 'qr_expired', 'QR-code verlopen. Vraag een nieuwe aan.');
      return;
    }
    const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(MAX_RETRY_MS, 2000 * 2 ** this.retries++);
    if (registered) await setStatus(this.userId, 'connecting', delay ? `Verbinding verbroken (${code ?? 'onbekend'}), nieuwe poging over ${Math.round(delay / 1000)} s.` : null);
    this.retryTimer = setTimeout(() => { this.start().catch((e) => this.fail(e)); }, delay);
  }

  fail(err: unknown): void {
    console.error('[whatsapp] session failed:', err);
    void setStatus(this.userId, 'error', `WhatsApp-sessie mislukt: ${(err as Error).message}`).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.ctl.abort();
    this.qr = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const s = this.sock;
    this.sock = null;
    try { s?.end(undefined); } catch { /* already closed */ }
  }

  /** Unlink the device on the phone as well. */
  async logout(): Promise<void> {
    const s = this.sock;
    this.stopped = true;
    this.ctl.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try { await s?.logout(); } catch { /* not connected: removing the keys is enough */ }
    this.sock = null;
  }
}

const sessions = new Map<string, Session>();
const reloads = new Map<string, Promise<void>>();

export function whatsappConnected(userId: string): boolean {
  return sessions.get(userId)?.connected ?? false;
}

export async function whatsappSendSelf(userId: string, content: string): Promise<void> {
  const s = sessions.get(userId);
  if (!s) throw new Error('WhatsApp staat uit');
  await s.sendExternal(content);
}

export async function whatsappSyncContacts(userId: string): Promise<{ total: number; named: number }> {
  const s = sessions.get(userId);
  if (!s?.connected) throw new Error('WhatsApp geen verbinding');
  return s.syncContacts();
}

export async function whatsappSendTo(userId: string, number: string, content: string): Promise<void> {
  const s = sessions.get(userId);
  if (!s) throw new Error('WhatsApp staat uit');
  await s.sendToNumber(number, content);
}

export function whatsappQr(userId: string): string | null {
  return sessions.get(userId)?.qr ?? null;
}

/** Run calls per user one after another. */
function serial(userId: string, fn: () => Promise<void>): Promise<void> {
  const next = (reloads.get(userId) ?? Promise.resolve()).then(fn);
  const tail = next.catch(() => undefined);
  reloads.set(userId, tail);
  void tail.then(() => { if (reloads.get(userId) === tail) reloads.delete(userId); });
  return next;
}

/** (Re)start the session of one user from the saved settings. */
export function reloadWhatsApp(userId: string): Promise<void> {
  return serial(userId, async () => {
    sessions.get(userId)?.stop();
    sessions.delete(userId);
    const r = await query<{ enabled: boolean; phone_jid: string | null; active_conversation_id: string | null }>(
      'SELECT enabled, phone_jid, active_conversation_id FROM whatsapp_links WHERE user_id = $1', [userId]);
    const row = r.rows[0];
    if (!row?.enabled) {
      if (row) await setStatus(userId, 'off', null);
      return;
    }
    if (!row.phone_jid) await setStatus(userId, 'connecting', null); // waiting for the first QR
    const s = new Session(userId, row.active_conversation_id, !!row.phone_jid);
    sessions.set(userId, s);
    s.start().catch((e) => s.fail(e));
  });
}

/** Log out on the phone, remove the keys and switch off. */
export function unlinkWhatsApp(userId: string): Promise<void> {
  return serial(userId, async () => {
    const s = sessions.get(userId);
    sessions.delete(userId);
    if (s) await s.logout();
    await fs.rm(authDir(userId), { recursive: true, force: true });
    await clearContacts(userId);
    await query(`UPDATE whatsapp_links SET enabled = false, phone_jid = NULL, phone_lid = NULL, push_name = NULL,
                 active_conversation_id = NULL, status = 'off', status_message = NULL, updated_at = now() WHERE user_id = $1`, [userId]);
  });
}

export async function startWhatsApp(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(DATA_DIR, 0o700); // the keys must not be readable for Claude Code (runs as clauderunner)
    // only linked accounts reconnect at boot; an unscanned QR session does not linger after a restart
    await query(`UPDATE whatsapp_links SET status = 'off', status_message = NULL WHERE enabled AND phone_jid IS NULL`);
    await query('UPDATE whatsapp_links SET enabled = false WHERE enabled AND phone_jid IS NULL');
    const r = await query<{ user_id: string }>('SELECT user_id FROM whatsapp_links WHERE enabled AND phone_jid IS NOT NULL');
    for (const { user_id } of r.rows) await reloadWhatsApp(user_id);
    if (r.rows.length) console.log(`✓ WhatsApp: ${r.rows.length} sessie(s) gestart`);
  } catch (err) {
    console.error('✗ WhatsApp start failed:', err);
  }
}
