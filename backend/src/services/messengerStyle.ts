/**
 * How Claude talks on Telegram and WhatsApp: only the final answer (no tool lines, no in-between
 * text, no code blocks), a short "even uitzoeken" note when it takes a while, and a friendly,
 * colleague-like tone.
 */

export type Channel = 'telegram' | 'whatsapp';

interface StoredEvent { type?: string; text?: string; toolUseId?: string; agentName?: string; content?: string }

/** Seconds before the "I'm looking into it" note is sent. */
export const THINKING_AFTER_MS = 5000;

/**
 * Stored answer → what the phone gets. A tool-using run is stored as a JSON event list; only the
 * text after the last tool call is the actual answer (earlier text is "ik kijk even…" chatter).
 * Fenced code blocks are dropped: the full answer stays in the web app.
 */
export function finalReplyText(content: string): string {
  let text = content;
  if (content.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(content) as StoredEvent[];
      if (Array.isArray(parsed)) {
        // an agent's answer counts as answer text, with its name in front (the main answer does not repeat it)
        const names = new Map(parsed.filter((e) => e?.type === 'agent_start').map((e) => [e.toolUseId, e.agentName]));
        const events: StoredEvent[] = parsed.map((e) => (e?.type === 'agent_result' && e.content?.trim()
          ? { type: 'text', text: `${names.get(e.toolUseId) ?? 'Agent'}: ${e.content.trim()}` } : e));
        let lastTool = -1;
        events.forEach((e, i) => { if (e?.type === 'tool_use') lastTool = i; });
        const texts = (list: StoredEvent[]) => list.filter((e) => e?.type === 'text' && e.text?.trim()).map((e) => e.text!.trim());
        let after = texts(events.slice(lastTool + 1));
        if (!after.length) after = texts(events).slice(-1); // no text after the last tool: use the last text at all
        text = after.join('\n\n');
      }
    } catch { /* plain markdown after all */ }
  }
  const hadCode = /```/.test(text);
  text = text.replace(/```[\s\S]*?(```|$)/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return hadCode ? 'Klaar. Het stuk code staat in de web-app, dat leest daar een stuk prettiger.' : '(geen antwoord)';
  if (hadCode) text += '\n\n(De code staat in de web-app.)';
  return text;
}

const THINKING = [
  'Even kijken, ik zoek het voor je uit. 🔍',
  'Goeie vraag, ik duik er even in.',
  'Momentje, ik ga het even voor je uitzoeken.',
  'Ik pak het op, ben zo terug.',
  'Even graven, ik laat het zo weten. ⛏️',
  'Daar moet ik even voor in de logs/bestanden kijken, momentje.',
  'Komt eraan, even uitzoeken hoe het zit.',
  'Ik ga ermee aan de slag. Koffie erbij? ☕',
];

/** A varied short note for when the answer takes longer than THINKING_AFTER_MS. */
export function thinkingMessage(rand: () => number = Math.random): string {
  return THINKING[Math.floor(rand() * THINKING.length) % THINKING.length];
}

/** Appended to Claude's system prompt for runs that come in via Telegram or WhatsApp. */
export function messengerPrompt(channel: Channel, name: string | null): string {
  const app = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  const who = name?.trim() ? name.trim().split(/\s+/)[0] : 'de gebruiker';
  return [
    `Dit bericht komt via ${app} op de telefoon van ${who}. Schrijf daarom als een chatbericht van een collega met wie ${who} samen iets uitzoekt.`,
    'Toon: vriendelijk, luchtig en respectvol. Een droge grap of knipoog mag af en toe, maar niet flauw en niet in elk bericht. Soms kort en to the point, soms wat losser: wat bij de vraag past.',
    'Vorm: gewone zinnen in korte alinea\'s. Geen kopjes, geen tabellen, geen codeblokken en geen commando\'s, tenzij er expliciet om gevraagd wordt. Vertel in gewone taal wat je gevonden of gedaan hebt en wat de volgende stap is.',
    `${who} ziet alleen je eindantwoord, niet je tussenstappen of tool-uitvoer; zet dus alles wat telt in dat eindantwoord.`,
    'Deze chatstijl gaat voor eventuele beknopte of "caveman"-stijlinstructies elders.',
  ].join('\n');
}
