/**
 * Logic of a Telegram agent bot: strangers ask for access, the owner approves in the app, and an
 * approved chatter talks to one or more agents of the owner. No network or database here: everything
 * goes through AgentBotDeps, so it can be tested with fakes.
 */
import { toTelegramChunks } from './format';
import { finalReplyText } from '../messengerStyle';

export interface AgentInfo { id: string; name: string; slug: string; description: string }
export interface ChatterInfo { id: string; status: 'pending' | 'approved' | 'denied' | 'revoked'; name: string }
export type Coordination = { agents: string[]; reason: string };

export interface AgentBotUpdate {
  update_id: number;
  message?: { chat: { id: number; type?: string; first_name?: string; last_name?: string; username?: string }; text?: string };
}

export interface AgentBotDeps {
  /** Text is markdown-ish; the implementation turns it into Telegram HTML (with a plain fallback). */
  send(chatId: number, text: string): Promise<void>;
  typing?(chatId: number): Promise<void>;
  getChatter(chatId: number): Promise<ChatterInfo | null>;
  /** Creates a pending request and tells the owner (push). */
  requestAccess(chatId: number, name: string, username: string | null): Promise<void>;
  /** Counts one message for this chatter; false when the per-hour limit of the bot is reached. */
  allow(chatterId: string): Promise<boolean>;
  agents(): Promise<AgentInfo[]>;
  /** The coordinator picks the agents (slugs) that can answer, or explains why none can. */
  coordinate(question: string, agents: AgentInfo[]): Promise<Coordination>;
  /** One agent answers in the chatter's own conversation; resolves with the stored answer text. */
  runAgent(chatter: ChatterInfo, agent: AgentInfo, text: string): Promise<string>;
}

export const AGENT_TEXT = {
  requested: 'Aanvraag verstuurd. Zodra de eigenaar je goedkeurt, kun je hier berichten sturen.',
  stillPending: 'Je aanvraag staat nog open. De eigenaar moet je eerst goedkeuren.',
  rateLimited: 'Je hebt even veel berichten gestuurd. Probeer het over een uur opnieuw.',
  busy: 'Ik ben nog bezig met je vorige bericht. Stuur het zo opnieuw.',
  noAgents: 'Er is nog geen agent aan deze bot gekoppeld.',
  emptyQuestion: 'Wat wil je aan de agent vragen? Typ je vraag na de naam.',
  failed: 'Er ging iets mis bij het beantwoorden. Probeer het zo nog eens.',
  noCoordination: 'Ik kon niet bepalen wie dit kan beantwoorden. Spreek een agent aan met @naam.',
};

/** Lowercase letters and digits only: "@Designer-Design" and "@irisdesign" match the same agent. */
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/**
 * Answer text for a chat: only the final text, no code blocks (finalReplyText), no inline code ticks,
 * no lines that look like a shell prompt. The full answer stays readable in the app.
 */
export function cleanAgentAnswer(content: string): string {
  let t = finalReplyText(content);
  t = t.replace(/`([^`\n]+)`/g, '$1').replace(/^\s*\$\s+\S.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return t || '(geen antwoord)';
}

/** "@naam vraag" anywhere in the text. Returns the agent and the text without the mention. */
export function parseMention(text: string, agents: AgentInfo[]): { agent: AgentInfo | null; unknown: string | null; rest: string } {
  const re = /(^|\s)@([\p{L}\p{N}_-]+)/gu;
  for (const m of text.matchAll(re)) {
    const key = norm(m[2]);
    const agent = agents.find((a) => norm(a.name) === key || norm(a.slug) === key);
    if (agent) {
      const rest = (text.slice(0, m.index) + m[1] + text.slice(m.index! + m[0].length)).replace(/\s+/g, ' ').trim();
      return { agent, unknown: null, rest };
    }
    if (agents.length > 1 && m.index === 0) return { agent: null, unknown: m[2], rest: text };
  }
  return { agent: null, unknown: null, rest: text };
}

/** System prompt of one agent in a Telegram conversation: its own prompt, then the chat rules. */
export function agentChatPrompt(agent: { name: string; prompt: string; knowledge: string | null }, chatter: string, bot: string): string {
  return [
    `Je bent ${agent.name}.`,
    agent.prompt.trim(),
    agent.knowledge?.trim() ? `Wat je geleerd hebt:\n${agent.knowledge.trim()}` : '',
    `Dit bericht komt via de Telegram-bot "${bot}" van ${chatter}. ${chatter} is geen techneut en ziet alleen je eindantwoord.`,
    'Je mag je tools en koppelingen gebruiken om het antwoord te vinden, maar het antwoord zelf is een gewoon gesprek, zoals een collega dat in een chat schrijft.',
    'Streng verboden in je antwoord: commando\'s, codeblokken, code, bestandspaden, logregels, tooluitvoer, wachtwoorden, tokens of andere geheimen. Vertel in gewone woorden wat je gevonden of gedaan hebt.',
    'Voer alleen uit wat bij jouw taak als agent hoort. Wijzig, verwijder of verstuur niets namens de eigenaar zonder dat dit duidelijk de bedoeling van de vraag is, en deel nooit gegevens van de eigenaar die niet nodig zijn voor het antwoord.',
    'Schrijf kort, vriendelijk en zonder kopjes of tabellen. Zet je eigen naam niet in het antwoord; dat doet de bot.',
  ].filter(Boolean).join('\n\n');
}

const MAX_AGENTS_PER_QUESTION = 3;

/** A bot without linked agents talks to Claude itself. */
export const CLAUDE_AGENT: AgentInfo = { id: 'claude', name: 'Claude', slug: 'claude', description: '' };

export function createAgentBot(deps: AgentBotDeps, stopped?: AbortSignal) {
  const live = () => !stopped?.aborted;
  const running = new Set<string>(); // chatter ids with a question in progress
  const background = new Set<Promise<void>>();
  const send = async (chatId: number, text: string) => { if (live()) await deps.send(chatId, text); };
  const answer = (chatId: number, who: string, text: string) => send(chatId, `**${who}**\n\n${text}`);

  async function handle(chatter: ChatterInfo, chatId: number, text: string): Promise<void> {
    const agents = await deps.agents();
    let chosen: AgentInfo[] = [];
    let question = text;
    if (!agents.length) {
      chosen = [CLAUDE_AGENT];
    } else if (agents.length === 1) {
      chosen = agents;
      question = parseMention(text, agents).rest || text;
    } else {
      const m = parseMention(text, agents);
      if (m.unknown) return send(chatId, `Die agent ken ik niet. Beschikbaar: ${agents.map((a) => `@${a.name}`).join(', ')}.`);
      if (m.agent) {
        if (!m.rest) return send(chatId, AGENT_TEXT.emptyQuestion);
        chosen = [m.agent];
        question = m.rest;
      }
    }

    if (!chosen.length) {
      // a meeting: the coordinator picks who answers
      await deps.typing?.(chatId).catch(() => undefined);
      let plan: Coordination;
      try { plan = await deps.coordinate(question, agents); } catch { return send(chatId, AGENT_TEXT.noCoordination); }
      const bySlug = new Map(agents.map((a) => [a.slug, a]));
      chosen = [...new Set(plan.agents)].map((s) => bySlug.get(s)).filter((a): a is AgentInfo => !!a).slice(0, MAX_AGENTS_PER_QUESTION);
      if (!chosen.length) {
        const who = agents.map((a) => a.name).join(' en ');
        return answer(chatId, who, plan.reason.trim() || 'Dit valt buiten wat wij kunnen. Probeer het anders te vragen.');
      }
    }

    for (const agent of chosen) {
      if (!live()) return;
      await deps.typing?.(chatId).catch(() => undefined);
      try {
        const reply = await deps.runAgent(chatter, agent, question);
        await answer(chatId, agent.name, cleanAgentAnswer(reply));
      } catch (err) {
        console.error('[telegram-agent] run failed:', (err as Error).message);
        await answer(chatId, agent.name, AGENT_TEXT.failed);
      }
    }
  }

  async function handleUpdate(update: AgentBotUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text || !live()) return;
    if (msg.chat.type && msg.chat.type !== 'private') return; // groups: never
    const chatId = msg.chat.id;
    const chatter = await deps.getChatter(chatId);

    if (!chatter) {
      const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || String(chatId);
      await deps.requestAccess(chatId, name, msg.chat.username ?? null);
      return send(chatId, AGENT_TEXT.requested);
    }
    if (chatter.status === 'pending') return send(chatId, AGENT_TEXT.stillPending);
    if (chatter.status !== 'approved') return; // denied or revoked: no answer, nothing runs

    const text = msg.text.trim();
    if (/^\/(start|help)(@\S+)?$/i.test(text)) {
      const agents = await deps.agents();
      const list = agents.length > 1 ? `\n\nJe kunt een agent aanspreken met @naam: ${agents.map((a) => `@${a.name}`).join(', ')}. Zonder @naam kiest het team zelf wie antwoordt.` : '';
      return send(chatId, `Welkom, ${chatter.name}. Typ gewoon je vraag.${list}`);
    }
    if (text.startsWith('/') && !text.startsWith('/ ')) return; // no commands: this is a conversation

    if (running.has(chatter.id)) return send(chatId, AGENT_TEXT.busy);
    if (!(await deps.allow(chatter.id))) return send(chatId, AGENT_TEXT.rateLimited);
    running.add(chatter.id);
    // in the background so the poller keeps receiving updates
    const p = handle(chatter, chatId, text).catch((e) => console.error('[telegram-agent] failed:', e))
      .finally(() => { running.delete(chatter.id); });
    background.add(p);
    void p.finally(() => background.delete(p));
  }

  async function idle(): Promise<void> {
    while (background.size) await Promise.all([...background]);
  }

  return { handleUpdate, idle };
}

/** Telegram HTML chunks of a markdown-ish answer. */
export const toChunks = toTelegramChunks;
