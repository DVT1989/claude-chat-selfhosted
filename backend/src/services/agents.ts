/**
 * Personal agents: per user, a named helper with its own prompt, model and avatar. Each run of that
 * user gets them as Claude Code subagents (--agents file in the run's own home); the main Claude
 * hands a task to one when it fits, and the chat shows the agent's answer in its own bubble.
 * Strictly per user: every query filters on user_id and only the owner's runs ever see them.
 */
import { writeFileSync, chownSync, mkdirSync } from 'fs';
import { join } from 'path';
import { query } from '../db';
import { AppError } from '../middleware/errorHandler';

export interface Agent {
  id: string; name: string; slug: string; description: string; prompt: string;
  model: string; avatar: string | null; color: string; is_active: boolean; created_at: string;
  knowledge: string | null; trained_at: string | null; trained_conversations: number;
}

export async function ensureAgentsSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'inherit',
      avatar TEXT,
      color VARCHAR(7) NOT NULL DEFAULT '#6366f1',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS agents_user_slug_idx ON agents (user_id, slug)');
  // training on earlier conversations (services/agentTraining.ts); every change logged so it can be undone
  await query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS knowledge TEXT,
    ADD COLUMN IF NOT EXISTS trained_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS trained_conversations INTEGER NOT NULL DEFAULT 0`);
  await query(`
    CREATE TABLE IF NOT EXISTS agent_training_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      before JSONB,
      after JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query('CREATE INDEX IF NOT EXISTS agent_training_log_agent_idx ON agent_training_log (agent_id, created_at DESC)');
}

/** Subagent type name for Claude Code: a stable slug, prefixed so it never clashes with built-in agents. */
export function slugify(name: string): string {
  const s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `agent-${s || 'naamloos'}`;
}

export async function listAgents(userId: string): Promise<Agent[]> {
  const r = await query<Agent>(
    `SELECT id, name, slug, description, prompt, model, avatar, color, is_active, created_at,
            knowledge, trained_at, trained_conversations
     FROM agents WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return r.rows;
}

/** A free slug for this user's agent name (the Claude Code subagent type). */
export async function uniqueSlug(userId: string, name: string, exceptId?: string): Promise<string> {
  const base = slugify(name);
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const r = await query('SELECT 1 FROM agents WHERE user_id = $1 AND slug = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)', [userId, slug, exceptId ?? null]);
    if (!r.rowCount) return slug;
  }
  throw new AppError(409, 'Kies een andere naam');
}

export interface NewAgent { name: string; description: string; prompt: string; model?: string; avatar?: string | null; color?: string; is_active?: boolean }

/** Create an agent for this user (max 30). Used by the agents page and the task wizard. Returns the new id. */
export async function createAgent(userId: string, a: NewAgent): Promise<string> {
  const count = await query<{ n: string }>('SELECT count(*) AS n FROM agents WHERE user_id = $1', [userId]);
  if (Number(count.rows[0].n) >= 30) throw new AppError(400, 'Maximaal 30 agents');
  const slug = await uniqueSlug(userId, a.name);
  const r = await query<{ id: string }>(
    `INSERT INTO agents (user_id, name, slug, description, prompt, model, avatar, color, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [userId, a.name, slug, a.description, a.prompt, a.model ?? 'inherit', a.avatar ?? null, a.color ?? '#6366f1', a.is_active ?? true]);
  return r.rows[0].id;
}

const CHAT_RULES = [
  '',
  'Je werkt binnen een chat-app. Jouw eindantwoord verschijnt letterlijk in een eigen balonnetje met jouw naam en avatar, als een deelnemer in het gesprek.',
  'Spreek als jezelf, in de ik-vorm, en spreek de gebruiker direct aan met je en jij. Nooit over jezelf in de derde persoon, nooit "de agent", "de hoofdagent", "het rapport" of "ik heb opdracht gekregen".',
  'Opmaak: begin met de kern in één of twee zinnen. Gebruik daarna korte alinea\'s, opsommingen met - en waar het helpt een kleine tabel of **vet** voor de belangrijkste getallen. Geen kopjes boven korte antwoorden. Sluit af met wat je voorstelt of wat je van de gebruiker nodig hebt.',
].join('\n');

/**
 * Write the user's active agents as a Claude Code --agents file in the run's home and return its
 * path, or null when there are none. The file sits in the user's own (private) home, not in argv,
 * so the prompts do not show up in the process list.
 */
export async function writeAgentsFile(userId: string, home: string, uid: number, gid: number): Promise<{ path: string; agents: Agent[] } | null> {
  const agents = (await listAgents(userId)).filter((a) => a.is_active);
  if (!agents.length) return null;
  const def: Record<string, { description: string; prompt: string; model?: string }> = {};
  for (const a of agents) {
    def[a.slug] = {
      description: `${a.name}: ${a.description}`,
      prompt: `Je bent ${a.name}.\n\n${a.prompt}\n${knowledgeBlock(a)}${CHAT_RULES}\n${colleaguesBlock(a, agents)}`,
      ...(a.model && a.model !== 'inherit' ? { model: a.model } : {}),
    };
  }
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'chat-agents.json');
  writeFileSync(path, JSON.stringify(def), { mode: 0o600 });
  try { chownSync(path, uid, gid); } catch { /* ignore */ }
  return { path, agents };
}

/** What the agent learned from earlier conversations (training), as its own section in the prompt. */
function knowledgeBlock(a: Agent): string {
  const k = a.knowledge?.trim();
  return k ? `\nWat je al weet (uit eerdere gesprekken):\n${k}\n` : '';
}


/**
 * The other agents as colleagues. A subagent cannot start another agent itself, so it asks through
 * its report ("Vraag aan Designer: ...") and the main Claude passes the question on and brings the answer back.
 */
function colleaguesBlock(self: Agent, all: Agent[]): string {
  const others = all.filter((o) => o.id !== self.id);
  if (!others.length) return '';
  return [
    '',
    'Collega-agents (je werkt samen, niet alleen):',
    ...others.map((o) => `- ${o.name}: ${o.description}`),
    'Samenwerken:',
    '- Hoort een deel van de taak beter bij een collega, of heb je hun kennis of oordeel nodig, doe het dan niet half zelf. Zet aan het eind van je verslag per collega een regel "Vraag aan <naam>: <concrete vraag met de context die nodig is>" of "Overdracht aan <naam>: <wat er moet gebeuren>". Je krijgt het antwoord daarna terug en gaat verder.',
    '- Stel alleen vragen die je echt nodig hebt, kort en concreet, en zeg wat je al weet.',
    '- Krijg je een vraag van een collega, beantwoord die dan direct en kort, vanuit je eigen vakgebied.',
  ].join('\n');
}

/** Extra system prompt so the main Claude knows the agents exist and does not repeat their answers. */
export function agentsSystemPrompt(agents: Agent[]): string {
  const lines = agents.map((a) => `- ${a.name} (subagent_type "${a.slug}"): ${a.description}`);
  return [
    'De gebruiker heeft eigen agents ingesteld. Past een taak (of een deel ervan) bij de omschrijving van een agent, geef die dan met de Agent-tool (subagent_type) aan die agent. Noemt de gebruiker een agent bij naam of met @naam, gebruik die agent dan altijd.',
    'Langer werk voor een agent (bouwen, reviewen, onderzoek van meer dan een paar minuten) geef je met delegate (CLAUDE.md, sectie Agents): dan werkt de agent in een eigen werkplek, los van deze chat. Korte vragen gaan inline met de Agent-tool. Ben je zelf al een werkplek, dan werk je inline.',
    ...lines,
    'Het antwoord van een agent staat al zichtbaar in een eigen balonnetje in het gesprek. Herhaal het daarna niet: vul hooguit kort aan of trek een conclusie.',
    `Noem een agent bij zijn naam als een collega ("Ik vraag het even aan ${agents[0]?.name ?? 'Builder'}"), en geef hem de opdracht in de jij-vorm.`,
    'Start een eigen agent met de Agent-tool altijd op de voorgrond (run_in_background: false): dan komt zijn verslag zeker terug en loopt de bubbel goed af. Langer werk dat los van dit gesprek moet doorlopen, geef je met delegate een eigen werkplek.',
    'Agents werken samen. Eindigt het verslag van een agent met "Vraag aan <naam>: ..." of "Overdracht aan <naam>: ...", geef dat dan meteen aan die agent (met de context die nodig is) en breng het antwoord terug naar de eerste agent met SendMessage, zodat die verder kan. Laat de gebruiker niet tussendoor wachten, behalve als er een akkoord nodig is. Hooguit 3 rondes heen en weer per taak; daarna vat je samen wat er nog open staat.',
  ].join('\n');
}

// ── Wizard: Claude turns an idea into a complete agent ──────────
export const AGENT_COLORS = ['#6366f1', '#a855f7', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#64748b'];

export interface AssistQuestion { id: string; question: string; why: string; multi: boolean; options: Array<{ label: string; detail: string }> }
export interface AssistDraft { name: string; color: string; description: string; prompt: string; model: 'haiku' | 'sonnet' | 'opus'; model_reason: string; summary: string }
export interface AssistInput {
  idea: string;
  current?: { name: string; description: string; prompt: string; model: string } | null;
  answers: Array<{ question: string; answer: string }>;
  round: number;
}

const QUESTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['id', 'question', 'why', 'multi', 'options'],
  properties: {
    id: { type: 'string' }, question: { type: 'string' }, why: { type: 'string' }, multi: { type: 'boolean' },
    options: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['label', 'detail'],
      properties: { label: { type: 'string' }, detail: { type: 'string' } } } },
  },
};

const ANALYZE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'questions'],
  properties: { summary: { type: 'string' }, questions: { type: 'array', minItems: 1, maxItems: 6, items: QUESTION_SCHEMA } },
};

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['draft', 'questions'],
  properties: {
    draft: { type: 'object', additionalProperties: false, required: ['name', 'color', 'description', 'prompt', 'model', 'model_reason', 'summary'],
      properties: {
        name: { type: 'string' }, color: { type: 'string', enum: AGENT_COLORS }, description: { type: 'string' }, prompt: { type: 'string' },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] }, model_reason: { type: 'string' }, summary: { type: 'string' },
      } },
    questions: { type: 'array', maxItems: 3, items: QUESTION_SCHEMA },
  },
};

const ASSIST_SYSTEM = `Je helpt een gebruiker van een chat-app om een eigen "agent" te maken: een Claude Code subagent met een vaste taak.
De hoofd-Claude in een gesprek geeft een taak aan deze agent als die past bij de omschrijving "wanneer inzetten". De agent werkt in een eigen context met dezelfde tools en koppelingen (shell, bestanden, SSH, Microsoft 365, apparaten van de gebruiker, internet) en zijn eindantwoord verschijnt in een eigen balonnetje in het gesprek.
Schrijf alles in het Nederlands, helder en zonder vulwoorden.

Vragen stellen:
- Alleen over wat echt onduidelijk is en de werking van de agent verandert: grenzen (wat mag hij zelf, wat eerst vragen), gedrag bij twijfel of fouten, gewenste vorm van het antwoord, toon, scope, belangrijke situaties uit het idee.
- Elke vraag concreet, met 2 tot 5 keuzes die direct aanklikbaar zijn. label kort (max 6 woorden), detail een korte uitleg van wat die keuze betekent. multi=true alleen als meerdere keuzes samen logisch zijn.
- why: één korte zin waarom dit uitmaakt.
- Geen vragen over naam, kleur of model: die stel jij zelf voor.

Het voorstel (draft):
- name: kort en menselijk, als een collega (bijv. "Netwerkexpert", "Mail-assistent"), max 3 woorden.
- description: 1 tot 2 zinnen "wanneer inzetten", met de concrete onderwerpen en signaalwoorden, zodat de hoofd-Claude hem betrouwbaar kiest en niet te vaak.
- prompt: volledige systeemprompt in de jij-vorm aan de agent. Opbouw met korte kopjes in platte tekst: Rol, Taak, Werkwijze (stappen), Regels en grenzen (inclusief de keuzes van de gebruiker uit de antwoorden), Bij twijfel of fouten, Antwoordvorm. Concreet en toetsbaar, geen algemeenheden. Begin niet met "Je bent <naam>", dat zet de app er zelf voor.
- model: haiku voor eenvoudige, snelle, routinematige taken; sonnet voor de meeste taken met analyse, schrijven, code of meerdere stappen; opus alleen voor zware redeneer- of architectuurtaken waar kwaliteit duidelijk zwaarder weegt dan snelheid en kosten. model_reason: één zin waarom.
- summary: één zin wat de agent gaat doen.
- color: kies een kleur die bij het onderwerp past.`;

export function assistPrompt(i: AssistInput): { prompt: string; schema: object } {
  const parts = [`Idee van de gebruiker:\n${i.idea.trim() || '(geen nieuw idee, verbeter de bestaande agent)'}`];
  if (i.current) parts.push(`Bestaande agent die verbeterd moet worden:\nNaam: ${i.current.name}\nWanneer inzetten: ${i.current.description}\nModel: ${i.current.model}\nPrompt:\n${i.current.prompt}`);
  if (i.answers.length) parts.push('Antwoorden van de gebruiker op eerdere vragen:\n' + i.answers.map((a) => `- ${a.question}\n  ${a.answer}`).join('\n'));
  if (i.round === 0) {
    parts.push(`Analyseer het idee${i.current ? ' en de bestaande agent' : ''}. Geef in summary in 2 tot 3 zinnen terug wat je ervan begrijpt, en stel 3 tot 6 vragen over wat nog onduidelijk is${i.current ? ' of ontbreekt in de bestaande prompt' : ''}.`);
    return { prompt: parts.join('\n\n'), schema: ANALYZE_SCHEMA };
  }
  parts.push(i.round === 1
    ? 'Maak nu het volledige voorstel. Is er nog iets wezenlijks onduidelijk, stel dan maximaal 3 aanvullende vragen in questions (het voorstel maak je toch al zo goed mogelijk); anders een lege lijst.'
    : 'Maak nu het definitieve voorstel. questions moet een lege lijst zijn.');
  return { prompt: parts.join('\n\n'), schema: DRAFT_SCHEMA };
}

export { ASSIST_SYSTEM };
