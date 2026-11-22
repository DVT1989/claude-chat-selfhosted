/**
 * Telegram bot logic for one claude-chat user: pairing, commands and chatting with Claude.
 * No network or database here — everything goes through BotDeps, so it can be tested with fakes.
 */
import { toTelegramChunks } from './format';
import { finalReplyText, thinkingMessage, THINKING_AFTER_MS } from '../messengerStyle';

export interface TgUpdate<C = number> {
  update_id: number;
  message?: {
    chat: { id: C; type?: string; title?: string; first_name?: string; last_name?: string; username?: string };
    text?: string;
  };
}

export interface Link<C = number> { userId: string; chatId: C | null; activeConversationId: string | null }

export interface ConversationItem { id: string; title: string; updated_at: string }

export type RunStart = { ok: true; reply: Promise<string> } | { ok: false; busy: true };

export interface BotDeps<C = number> {
  /** html: text is Telegram HTML (parse_mode HTML); otherwise plain text. */
  send(chatId: C, text: string, html?: boolean): Promise<void>;
  typing?(chatId: C): Promise<void>;
  /** Splits a stored answer into plain-text messages (e.g. WhatsApp). Default: Telegram HTML chunks. */
  formatReply?(content: string): string[];
  /** Display name of this user's bot (intro texts); null = neutral wording. */
  botName?(userId: string): Promise<string | null>;
  listConversations(userId: string): Promise<ConversationItem[]>;
  createConversation(userId: string): Promise<string>;
  markTelegram(conversationId: string): Promise<void>;
  savePairing(userId: string, chatId: C, chatName: string): Promise<void>;
  /** True once for the current one-time code from Settings; burns attempts and expires. */
  checkPairCode(userId: string, code: string): Promise<boolean>;
  setActive(userId: string, conversationId: string | null): Promise<void>;
  /** Starts a Claude run; `reply` resolves with the answer text or rejects with the error.
   *  `notify` gets short notes during this run (e.g. a switch to another Claude subscription). */
  startRun(userId: string, conversationId: string, text: string, notify?: (note: string) => void): Promise<RunStart>;
  /** Saved active conversation; another channel may have switched it (shared active conversation). */
  getActive?(userId: string): Promise<string | null>;
  /** "/<command> <tekst>" forwards the text to the other channel; send returns the confirmation. */
  relayTo?: { command: string; send(userId: string, text: string): Promise<string> };
  /** Called after an answer was delivered (mirroring to the other channel). Must not throw. */
  afterReply?(userId: string, conversationId: string, question: string, answer: string): Promise<void>;
  /** Extra lines for /status (the other channel). */
  statusExtra?(userId: string): Promise<string>;
}

/** Intro texts with the bot's own name (per user); without a name a neutral wording. */
export function welcomeText(name: string | null): string {
  return `Gekoppeld! Goedendag, ik ben ${name ?? 'je assistent'}, tot je dienst. Via mij praat je met Claude op de NAS.\n\n`
    + '/resume — je recente gesprekken\n/resume <nr> — verder in een gesprek\n/nieuw — nieuw gesprek\n'
    + '/status — welk gesprek actief is\n\nTyp gewoon je bericht.';
}
export function pairFirstText(name: string | null): string {
  return `Goedendag, ik ben ${name ?? 'je assistent'}. Koppelen kan alleen met de link of code uit claude-chat (Koppelingen → Telegram-bot).`;
}

export const TEXT = {
  welcome: welcomeText(null),
  pairFirst: pairFirstText(null),
  unknownNumber: 'Onbekend nummer. Stuur eerst /resume en kies dan /resume <nr>.',
  newConversation: 'Nieuw gesprek: je volgende bericht start het.',
  queued: 'Nog bezig, je bericht staat in de wachtrij.',
  queueFull: 'Er staat al een bericht in de wachtrij. Wacht tot Claude klaar is.',
  busyElsewhere: 'Dit gesprek is nu bezig in de web-app of via een ander kanaal. Probeer het zo opnieuw.',
  noConversations: 'Je hebt nog geen gesprekken. Typ een bericht om er een te beginnen.',
  noActive: 'Geen actief gesprek. Je volgende bericht start een nieuw gesprek.',
};

const LIST_SIZE = 10;

/** Shown in Telegram's "/" menu (setMyCommands). */
export const COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'resume', description: 'Verder in een gesprek (zonder nummer: lijst)' },
  { command: 'nieuw', description: 'Nieuw gesprek beginnen' },
  { command: 'status', description: 'Welk gesprek is actief' },
  { command: 'gesprekken', description: 'Recente gesprekken' },
  { command: 'whatsapp', description: 'Bericht doorsturen naar je WhatsApp' },
  { command: 'help', description: 'Uitleg' },
];

function parseCommand(text: string): { cmd: string; arg: string } | null {
  const m = /^\/([a-z]+)(?:@\S+)?(?:\s+(.*))?$/is.exec(text.trim());
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] ?? '').trim() } : null;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** `stopped` aborts when the poller is stopped (token change, unpair, disable): from then on nothing is sent or run. */
export function createBot<C = number>(deps: BotDeps<C>, stopped?: AbortSignal) {
  const lastList = new Map<string, string[]>(); // userId -> conversation ids as numbered in /gesprekken
  const queues = new Map<string, { queued: string | null }>(); // conversationId -> running state
  const background = new Set<Promise<void>>();
  const live = () => !stopped?.aborted;

  async function send(chatId: C, text: string, html = false): Promise<void> {
    if (live()) await deps.send(chatId, text, html);
  }

  async function sendAll(chatId: C, text: string): Promise<void> {
    if (deps.formatReply) {
      for (const part of deps.formatReply(text)) await send(chatId, part, false);
      return;
    }
    for (const part of toTelegramChunks(text)) await send(chatId, part, true);
  }

  async function runLoop(link: Link<C>, chatId: C, convId: string, first: string): Promise<void> {
    const state = { queued: null as string | null };
    queues.set(convId, state);
    try {
      let msg: string | null = first;
      while (msg !== null && live()) {
        await deps.typing?.(chatId).catch(() => undefined);
        // Taking a while (Claude is looking things up)? Say so once, like a colleague would.
        let thinking: ReturnType<typeof setTimeout> | undefined;
        try {
          const r = await deps.startRun(link.userId, convId, msg, (note) => { void send(chatId, note).catch(() => undefined); });
          if (!r.ok) {
            await send(chatId, TEXT.busyElsewhere);
            break;
          }
          thinking = setTimeout(() => { void send(chatId, thinkingMessage()).catch(() => undefined); }, THINKING_AFTER_MS);
          // Only the final answer goes to the phone: no tool lines, in-between text or code blocks
          const answer = finalReplyText(await r.reply);
          clearTimeout(thinking);
          await sendAll(chatId, answer);
          if (deps.afterReply && live()) void deps.afterReply(link.userId, convId, msg, answer).catch(() => undefined);
        } catch (err) {
          clearTimeout(thinking);
          await send(chatId, `Fout: ${(err as Error).message}`);
        }
        msg = state.queued;
        state.queued = null;
      }
    } finally {
      queues.delete(convId);
    }
  }

  /** Follow a switch made on the other channel (shared active conversation). */
  async function refreshActive(link: Link<C>): Promise<void> {
    if (!deps.getActive) return;
    try { link.activeConversationId = await deps.getActive(link.userId); } catch { /* keep the known one */ }
  }

  async function chat(link: Link<C>, chatId: C, text: string): Promise<void> {
    await refreshActive(link);
    let convId = link.activeConversationId;
    if (!convId) {
      convId = await deps.createConversation(link.userId);
      await deps.markTelegram(convId);
      await deps.setActive(link.userId, convId);
      link.activeConversationId = convId;
    }
    const running = queues.get(convId);
    if (running) {
      if (running.queued !== null) {
        await send(chatId, TEXT.queueFull);
      } else {
        running.queued = text;
        await send(chatId, TEXT.queued);
      }
      return;
    }
    // runs in the background so the poller keeps receiving updates (needed for the queue)
    const p = runLoop(link, chatId, convId, text).catch((e) => console.error('[telegram] run failed:', e));
    background.add(p);
    void p.finally(() => background.delete(p));
  }

  async function handleUpdate(link: Link<C>, update: TgUpdate<C>): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;
    const chatId = msg.chat.id;
    const command = parseCommand(msg.text);

    if (!live()) return;
    if (link.chatId === null) {
      // only a private chat can pair: in a group every member could drive Claude
      if (msg.chat.type && msg.chat.type !== 'private') return;
      // Pairing needs the one-time code from Settings (the bot can be found by anyone).
      // Anything else gets no answer at all.
      if (command?.cmd === 'start') {
        if (!command.arg || !(await deps.checkPairCode(link.userId, command.arg))) {
          await send(chatId, pairFirstText(await deps.botName?.(link.userId) ?? null));
          return;
        }
        const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || String(chatId);
        await deps.savePairing(link.userId, chatId, name);
        link.chatId = chatId;
        await send(chatId, welcomeText(await deps.botName?.(link.userId) ?? null));
      }
      return;
    }
    if (chatId !== link.chatId) return; // only the paired chat, and not even a reply to others

    if (!command) return chat(link, chatId, msg.text);
    if (deps.relayTo && command.cmd === deps.relayTo.command) {
      const rest = /^\/\S+\s*([\s\S]*)$/.exec(msg.text.trim())?.[1] ?? ''; // keep line breaks
      return send(chatId, await deps.relayTo.send(link.userId, rest.trim()));
    }

    switch (command.cmd) {
      case 'start':
      case 'help':
        return send(chatId, welcomeText(await deps.botName?.(link.userId) ?? null));
      case 'resume': // like Claude Code: without a number a list, with a number continue that one
      case 'open':
        if (!command.arg) await refreshActive(link);
        return command.arg ? openConversation(link, chatId, command.arg) : listConversations(link, chatId);
      case 'gesprekken':
        await refreshActive(link);
        return listConversations(link, chatId);
      case 'nieuw':
        await deps.setActive(link.userId, null);
        link.activeConversationId = null;
        return send(chatId, TEXT.newConversation);
      case 'status': {
        await refreshActive(link);
        const extra = deps.statusExtra ? `\n\n${await deps.statusExtra(link.userId).catch(() => '')}`.trimEnd() : '';
        if (!link.activeConversationId) return send(chatId, TEXT.noActive + extra);
        const title = (await deps.listConversations(link.userId)).find((c) => c.id === link.activeConversationId)?.title ?? 'onbekend';
        return send(chatId, `Actief gesprek: ${title}${queues.has(link.activeConversationId) ? '\nClaude is nu bezig.' : ''}${extra}`);
      }
      default:
        return chat(link, chatId, msg.text); // unknown /word: treat as text (e.g. a skill command)
    }
  }

  async function listConversations(link: Link<C>, chatId: C): Promise<void> {
    const list = (await deps.listConversations(link.userId)).slice(0, LIST_SIZE);
    if (!list.length) return send(chatId, TEXT.noConversations);
    lastList.set(link.userId, list.map((c) => c.id));
    const lines = list.map((c, i) => `${i + 1}. ${c.title} (${shortDate(c.updated_at)})${c.id === link.activeConversationId ? ' ← actief' : ''}`);
    return send(chatId, `Recente gesprekken:\n${lines.join('\n')}\n\nKies met /resume <nr>.`);
  }

  async function openConversation(link: Link<C>, chatId: C, arg: string): Promise<void> {
    const n = Number.parseInt(arg, 10);
    let ids = lastList.get(link.userId);
    if (!ids) {
      ids = (await deps.listConversations(link.userId)).slice(0, LIST_SIZE).map((c) => c.id);
      lastList.set(link.userId, ids);
    }
    const id = Number.isInteger(n) && n >= 1 ? ids[n - 1] : undefined;
    if (!id) return send(chatId, TEXT.unknownNumber);
    await deps.setActive(link.userId, id);
    await deps.markTelegram(id);
    link.activeConversationId = id;
    const title = (await deps.listConversations(link.userId)).find((c) => c.id === id)?.title ?? 'gesprek';
    return send(chatId, `Geopend: ${title}\nTyp je bericht.`);
  }

  /** Resolves when all running replies are done (tests). */
  async function idle(): Promise<void> {
    while (background.size) await Promise.all([...background]);
  }

  return { handleUpdate, idle };
}
