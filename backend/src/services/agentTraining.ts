/**
 * Training an agent on the user's earlier conversations. Finds the conversations that fit the agent's
 * field (full text search on its description and signal words, plus the conversations where it was
 * active itself), lets Haiku pull out facts, paths, commands, ways of working, pitfalls and preferences
 * per batch, and merges those into one compact knowledge block on the agent (see writeAgentsFile).
 * Every change is logged in agent_training_log with before/after, so it can be undone.
 *
 * Same manners as the learning loop: one training at a time, Haiku via runStructured, under the shared
 * background lock (backgroundJobs: one job at a time over learning, backfill, cleanup and training) and only
 * while the chosen account is under 80% of its subscription; chats may run meanwhile. Secrets are
 * filtered before anything goes to Haiku and again on the result.
 */
import { query } from '../db';
import { AppError } from '../middleware/errorHandler';
import { runStructured, getAuthStatus } from './claudeCode';
import { tryAcquire, lockReason, roomBelow } from './backgroundJobs';
import { redact, hasSecret } from './learning';
import { rankConversations } from './history';
import { redis } from '../redis';

// queued trainings sit in redis, so a backend restart resumes them (a run that was busy starts over)
const QUEUE_KEY = 'train:queue';

const MODEL = 'haiku';
const MAX_CONVERSATIONS = 1000;   // in practice: every conversation that fits the agent's field
const PER_CONVERSATION = 7_000;   // characters of one conversation
const BATCH_MAX = 26_000;         // characters per Haiku call
const KNOWLEDGE_MAX = 6_000;      // about 1500 tokens
const MERGE_MAX = 60_000;         // characters of new points per merge call; more is merged in rounds

export interface TrainStatus {
  state: 'geen' | 'wachten' | 'bezig' | 'klaar' | 'fout';
  done: number; total: number; waiting: string | null; error: string | null;
}
const status = new Map<string, TrainStatus>();
const queue: Array<{ userId: string; agentId: string }> = [];
let running = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Places where a secret is given: the value is taken out and then removed everywhere in the text. */
const HARVEST: RegExp[] = [
  /sshpass\s+-p\s*(?:'([^']+)'|"([^"]+)"|(\S+))/gi,
  /\b[A-Z_]*(?:PASS|PASSWD|PASSWORD|SECRET|TOKEN)[A-Z_]*=(?:'([^']+)'|"([^"]+)"|(\S+))/g,
  /(?:wachtwoord|password|passwd|pincode|pin)\b[^\n]{0,40}?\b(?:is|=|:)\s*['"]?([^\s'"]{6,})/gi,
  /\s-p\s*'([^']{4,})'/g,
  /printf\s+'%s'\s+'([^']{4,})'/g,
];

/** Secret filters on top of redact(): every harvested value, plus sshpass, --password and sudo -S forms. */
export function scrub(text: string): string {
  const found = new Set<string>();
  for (const re of HARVEST) for (const m of text.matchAll(re)) {
    const v = m.slice(1).find((x) => x);
    if (v && v.length >= 4 && !/^\$|^\[weg/.test(v)) found.add(v.replace(/[.,;)]+$/, ''));
  }
  let t = text;
  for (const v of [...found].sort((a, b) => b.length - a.length)) t = t.split(v).join('[weg]');
  return redact(t)
    .replace(/(sshpass\s+-p\s*)('[^']*'|"[^"]*"|\S+)/gi, '$1[weg]')
    .replace(/(--(?:pw|pass|password|passwd|secret|token|api-key)[= ]\s*)('[^']*'|"[^"]*"|\S+)/gi, '$1[weg]')
    .replace(/(\s-p\s*)('[^']*'|"[^"]*")/g, '$1[weg]')
    .replace(/(echo\s+)('[^']*'|"[^"]*"|\S+)(\s*\|\s*sudo\s+-S)/gi, '$1[weg]$3');
}

/** scrub() only when the text looks like it holds a secret, so ordinary commands (mkdir -p "x") stay untouched. */
export function scrubIfSecret(text: string): string {
  return /sshpass|SSHPASS|passw|wachtwoord|secret|token|api-key|sudo\s+-S/i.test(text) ? scrub(text) : text;
}

// ── Which conversations ─────────────────────────────────────
interface AgentRow { id: string; user_id: string; name: string; description: string; prompt: string; knowledge: string | null }

/** Search terms: the signal words (if listed) and the meaningful words of the description. */
export function trainingTerms(a: { name: string; description: string }): string[] {
  const d = a.description;
  const sig = /signaalwoorden\s*:\s*([^.\n]+)/i.exec(d)?.[1] ?? '';
  const signal = sig.split(/[,;]/).map((s) => s.replace(/['"“”‘’.]/g, '').trim()).filter((s) => s.length >= 2);
  const rest = d.replace(/signaalwoorden\s*:[^.\n]+/i, '');
  const STOP = new Set(['voor', 'naar', 'over', 'met', 'van', 'een', 'het', 'die', 'dat', 'deze', 'zijn', 'wordt', 'worden', 'inzetten',
    'zoals', 'bijvoorbeeld', 'zelf', 'eigen', 'welke', 'horen', 'zetten', 'werken', 'stelt', 'problemen', 'klanten',
    'gesprekken', 'agents', 'uitlezen', 'inschatten', 'controleren', 'analyseert', 'verliepen', 'beoordeling', 'verbetering', 'kritische',
    'nieuwe', 'functies', 'wijzigingen', 'vraagt', 'bouwt', 'bouwen', 'beoordeelt', 'adviseert', 'storingen', 'diensten', 'apparaten']);
  const words = (rest.toLowerCase().match(/[\p{L}\p{N}-]{5,}/gu) ?? []).filter((w) => !STOP.has(w));
  return [...new Set([...signal, ...words])].slice(0, 30);
}

async function pickConversations(a: AgentRow): Promise<Array<{ id: string; title: string }>> {
  // where the agent itself was active: strongest signal, most bubbles first
  const own = (await query<{ id: string; title: string }>(
    `SELECT c.id, max(COALESCE(c.title, '')) AS title FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = $1 AND c.status <> 'deleted' AND m.content LIKE $2
     GROUP BY c.id ORDER BY count(*) DESC, max(m.created_at) DESC LIMIT $3`,
    [a.user_id, `%"agentId":"${a.id}"%`, MAX_CONVERSATIONS])).rows;
  const fts = await rankConversations(a.user_id, trainingTerms(a), MAX_CONVERSATIONS * 2);
  const out = new Map<string, { id: string; title: string }>();
  for (const c of own) out.set(c.id, c);
  for (const c of fts) { if (out.size >= MAX_CONVERSATIONS) break; if (!out.has(c.conversation_id)) out.set(c.conversation_id, { id: c.conversation_id, title: c.title }); }
  return [...out.values()].slice(0, MAX_CONVERSATIONS);
}

// ── Transcript of one conversation ──────────────────────────
interface Ev { type?: string; text?: string; content?: string; agentName?: string; task?: string; toolName?: string; toolInput?: Record<string, unknown> }

function clip(s: string, n: number): string { const t = s.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); return t.length > n ? `${t.slice(0, n)} [...]` : t; }

export function renderAssistant(content: string): string {
  if (!content.startsWith('[{')) return clip(content, 900);
  let evs: Ev[];
  try { evs = JSON.parse(content) as Ev[]; } catch { return clip(content, 900); }
  const lines: string[] = [];
  for (const e of evs) {
    if (e.type === 'text' && e.text) lines.push(clip(e.text, 700));
    else if (e.type === 'agent_start') lines.push(`[opdracht aan ${e.agentName ?? 'agent'}] ${clip(e.task ?? '', 200)}`);
    else if (e.type === 'agent_result' && e.content) lines.push(`[antwoord agent] ${clip(e.content, 900)}`);
    else if (e.type === 'tool_use' && e.toolInput) {
      const i = e.toolInput;
      const what = String(i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? '').replace(/\s+/g, ' ').slice(0, 180);
      if (what) lines.push(`  [${String(e.toolName ?? 'tool').replace(/^mcp__\w+__/, '')}] ${what}`);
    }
  }
  return lines.join('\n');
}

async function conversationText(convId: string, title: string): Promise<string> {
  const msgs = (await query<{ role: string; content: string; created_at: Date }>(
    `SELECT role, content, created_at FROM messages WHERE conversation_id = $1 AND content <> '' ORDER BY created_at, id`, [convId])).rows;
  if (!msgs.length) return '';
  const parts = msgs.map((m) => `${m.role === 'user' ? 'GEBRUIKER' : 'CLAUDE'}: ${m.role === 'user' ? clip(m.content, 1200) : renderAssistant(m.content)}`);
  // head and tail when it is long: the question and the outcome matter most
  let body = scrub(parts.join('\n\n'));
  if (body.length > PER_CONVERSATION) body = `${body.slice(0, PER_CONVERSATION * 0.45)}\n[...]\n${body.slice(-PER_CONVERSATION * 0.55)}`;
  return scrub(`### GESPREK: ${title || '(zonder titel)'} (${msgs[0].created_at.toISOString().slice(0, 10)})\n${body}`);
}

// ── Haiku ───────────────────────────────────────────────────
const KINDS = ['feit', 'pad', 'commando', 'werkwijze', 'valkuil', 'voorkeur'];
const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['kind', 'text'],
    properties: { kind: { type: 'string', enum: KINDS }, text: { type: 'string' } } } } },
};
const MERGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['knowledge'], properties: { knowledge: { type: 'string' } } };

function extractSystem(a: AgentRow): string {
  return `Je haalt kennis uit eerdere gesprekken voor een agent in een chat-app. De agent heet ${a.name} en zijn vakgebied is: ${a.description}
Zijn eigen instructies (herhaal niets wat hier al staat):
${a.prompt.slice(0, 2500)}

Haal uit de gesprekken alleen wat ${a.name} binnen dat vakgebied later helpt, zodat hij minder hoeft uit te zoeken of te vragen:
- feit: vaste gegevens (welke systemen, diensten, versies, hoe iets is ingericht)
- pad: bestandspaden, mappen, URL's, containernamen
- commando: commando's of API-aanroepen die werkten, exact
- werkwijze: hoe de gebruiker iets gedaan wil hebben, vaste stappen
- valkuil: wat misging en hoe het wel moet
- voorkeur: voorkeuren en feedback van de gebruiker over hoe het moet
Regels: een punt per item, kort (max 2 zinnen), op zichzelf leesbaar, in het Nederlands. Alleen blijvende kennis, niets tijdelijks (status van vandaag, losse storingen die opgelost zijn zonder les). Niets buiten het vakgebied.
NOOIT wachtwoorden, tokens, sleutels, pincodes of andere geheimen, ook niet gedeeltelijk of als voorbeeld. Staat er [weg], laat dat item weg.
Lege lijst is prima: liever niets dan iets onzekers.`;
}

const MERGE_SYSTEM = `Je voegt kennispunten voor een agent samen tot een compact kennisblok voor zijn systeemprompt.
- Ontdubbel en voeg samen wat over hetzelfde gaat; bij tegenstrijdigheid wint het nieuwste of meest specifieke.
- Indeling met korte regels in platte tekst: per groep een regel met de groepsnaam en een dubbele punt (Feiten en paden, Commando's, Werkwijze, Valkuilen, Voorkeuren van de gebruiker), daaronder punten met "- ". Lege groepen weglaten.
- Paden, commando's en namen exact overnemen. Geen inleiding of afsluiting.
- Maximaal ongeveer 1200 woorden; schrap eerst het minst bruikbare.
- NOOIT wachtwoorden, tokens of andere geheimen.`;

/** Wait for room on the subscription (under 80%); the shared lock is held by the training itself. */
async function waitForRoom(userId: string, st: TrainStatus): Promise<void> {
  for (;;) {
    const why = await getAuthStatus(userId) !== 'authenticated' ? 'geen Claude-account gekoppeld'
      : !await roomBelow(userId) ? 'sessie boven 80% of week bijna op' : null;
    if (!why) { st.state = 'bezig'; st.waiting = null; return; }
    st.state = 'wachten'; st.waiting = why;
    await sleep(30_000);
  }
}

/** Keep whole lines up to the limit and drop any line that still looks like a secret. */
function finish(k: string): string {
  const lines = k.split('\n').map((l) => l.trimEnd()).filter((l) => !hasSecret(l) && !/\[weg\]/.test(l));
  let out = '';
  for (const l of lines) { if (out.length + l.length + 1 > KNOWLEDGE_MAX) break; out += (out ? '\n' : '') + l; }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

async function train(userId: string, agentId: string, st: TrainStatus): Promise<void> {
  const a = (await query<AgentRow>('SELECT id, user_id, name, description, prompt, knowledge FROM agents WHERE id = $1 AND user_id = $2', [agentId, userId])).rows[0];
  if (!a) throw new AppError(404, 'Agent niet gevonden');
  const convs = await pickConversations(a);
  st.total = convs.length; st.done = 0;
  if (!convs.length) throw new Error('Geen passende gesprekken gevonden');

  const items: string[] = [];
  let batch: string[] = [], size = 0, inBatch = 0;
  const flush = async () => {
    if (!batch.length) return;
    await waitForRoom(userId, st);
    const out = await runStructured<{ items: Array<{ kind: string; text: string }> }>(userId, {
      system: extractSystem(a), prompt: batch.join('\n\n'), schema: EXTRACT_SCHEMA, model: MODEL, timeoutMs: 180_000, action: 'training' });
    for (const it of out.items ?? []) { const t = it.text?.trim(); if (t && !hasSecret(t)) items.push(`[${it.kind}] ${t}`); }
    st.done += inBatch;
    batch = []; size = 0; inBatch = 0;
  };
  for (const c of convs) {
    const t = await conversationText(c.id, c.title);
    if (t && size + t.length > BATCH_MAX && batch.length) await flush();
    if (t) { batch.push(t); size += t.length; }
    inBatch++;
  }
  await flush();
  if (!items.length && !a.knowledge) throw new Error('Geen bruikbare kennis gevonden');

  // merge in rounds: each round folds a slice of the new points into the block of the round before
  let knowledge = a.knowledge ?? '';
  for (let i = 0; i < items.length || (i === 0 && !items.length);) {
    const slice: string[] = [];
    for (let size = 0; i < items.length && (size + items[i].length < MERGE_MAX || !slice.length); i++) { slice.push(items[i]); size += items[i].length + 1; }
    await waitForRoom(userId, st);
    const merged = await runStructured<{ knowledge: string }>(userId, {
      system: MERGE_SYSTEM, schema: MERGE_SCHEMA, model: MODEL, timeoutMs: 180_000, action: 'training',
      prompt: [`Agent: ${a.name} (${a.description})`, '',
        knowledge ? `HUIDIGE KENNIS (behoud wat nog klopt):\n${knowledge}\n` : '',
        'NIEUWE KENNISPUNTEN:', ...slice].join('\n') });
    const next = finish(merged.knowledge ?? '');
    if (next) knowledge = next;
    if (!items.length) break;
  }
  if (!knowledge) throw new Error('Samenvoegen gaf geen kennis');
  await saveKnowledge(userId, agentId, { knowledge, trained_at: new Date().toISOString(), trained_conversations: convs.length });
}

// ── Store and undo ──────────────────────────────────────────
interface Snapshot { knowledge: string | null; trained_at: string | null; trained_conversations: number }

async function saveKnowledge(userId: string, agentId: string, next: Partial<Snapshot> & { knowledge: string | null }): Promise<void> {
  const cur = (await query<Snapshot>('SELECT knowledge, trained_at, trained_conversations FROM agents WHERE id = $1 AND user_id = $2', [agentId, userId])).rows[0];
  if (!cur) throw new AppError(404, 'Agent niet gevonden');
  const after: Snapshot = { knowledge: next.knowledge, trained_at: next.trained_at ?? cur.trained_at, trained_conversations: next.trained_conversations ?? cur.trained_conversations };
  await query('INSERT INTO agent_training_log (agent_id, before, after) VALUES ($1, $2::jsonb, $3::jsonb)', [agentId, JSON.stringify(cur), JSON.stringify(after)]);
  await query('UPDATE agents SET knowledge = $3, trained_at = $4, trained_conversations = $5, updated_at = now() WHERE id = $1 AND user_id = $2',
    [agentId, userId, after.knowledge, after.trained_at, after.trained_conversations]);
}

/** Edit the block by hand (also logged, so it can be undone). Empty text removes it. */
export async function setKnowledge(userId: string, agentId: string, text: string): Promise<void> {
  const k = text.trim();
  if (k && hasSecret(k)) throw new AppError(400, 'Er lijkt een wachtwoord, token of sleutel in te staan');
  await saveKnowledge(userId, agentId, { knowledge: k || null });
}

/** Back to the version before the last change; repeat to go further back. */
export async function revertKnowledge(userId: string, agentId: string): Promise<void> {
  const own = await query('SELECT 1 FROM agents WHERE id = $1 AND user_id = $2', [agentId, userId]);
  if (!own.rowCount) throw new AppError(404, 'Agent niet gevonden');
  const last = (await query<{ id: string; before: Snapshot }>('SELECT id, before FROM agent_training_log WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1', [agentId])).rows[0];
  if (!last) throw new AppError(409, 'Er is geen vorige versie');
  const b = last.before ?? { knowledge: null, trained_at: null, trained_conversations: 0 };
  await query('UPDATE agents SET knowledge = $3, trained_at = $4, trained_conversations = $5, updated_at = now() WHERE id = $1 AND user_id = $2',
    [agentId, userId, b.knowledge, b.trained_at, b.trained_conversations ?? 0]);
  await query('DELETE FROM agent_training_log WHERE id = $1', [last.id]);
}

// ── Queue ───────────────────────────────────────────────────
export async function startTraining(userId: string, agentId: string): Promise<TrainStatus> {
  const own = await query('SELECT 1 FROM agents WHERE id = $1 AND user_id = $2', [agentId, userId]);
  if (!own.rowCount) throw new AppError(404, 'Agent niet gevonden');
  const cur = status.get(agentId);
  if (cur && (cur.state === 'wachten' || cur.state === 'bezig')) return cur;
  const st: TrainStatus = { state: 'wachten', done: 0, total: 0, waiting: running ? 'een andere training loopt' : null, error: null };
  status.set(agentId, st);
  queue.push({ userId, agentId });
  await redis.rpush(QUEUE_KEY, `${userId}:${agentId}`).catch(() => 0);
  void runQueue();
  return st;
}

async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const st = status.get(job.agentId)!;
      // one background job at a time: wait for the learning loop, backfill or cleanup to finish
      let release = tryAcquire('training');
      while (!release) {
        st.state = 'wachten'; st.waiting = lockReason();
        await sleep(30_000);
        release = tryAcquire('training');
      }
      try {
        await train(job.userId, job.agentId, st);
        st.state = 'klaar'; st.waiting = null;
        console.log(`[training] ${job.agentId.slice(0, 8)}: klaar, ${st.total} gesprekken`);
      } catch (err) {
        st.state = 'fout'; st.waiting = null; st.error = (err as Error).message.slice(0, 300);
        console.error(`[training] ${job.agentId.slice(0, 8)}:`, st.error);
      } finally { release(); await redis.lrem(QUEUE_KEY, 0, `${job.userId}:${job.agentId}`).catch(() => 0); }
      for (const q of queue) { const s = status.get(q.agentId); if (s) s.waiting = 'een andere training loopt'; }
    }
  } finally { running = false; }
}

/** After a restart: put the trainings that were queued or running back in the queue. */
export async function resumeTrainings(): Promise<void> {
  const jobs = [...new Set(await redis.lrange(QUEUE_KEY, 0, -1))];
  await redis.del(QUEUE_KEY);
  for (const j of jobs) {
    const [userId, agentId] = j.split(':');
    try { await startTraining(userId, agentId); } catch (err) { console.error(`[training] hervatten ${agentId?.slice(0, 8)}:`, (err as Error).message); }
  }
  if (jobs.length) console.log(`[training] ${jobs.length} training(en) hervat`);
}

/** for tests */
export const __test = { conversationText };

export async function trainingStatus(userId: string, agentId: string): Promise<TrainStatus & { knowledge: string | null; trained_at: string | null; trained_conversations: number; can_revert: boolean }> {
  const a = (await query<Snapshot & { n: string }>(
    `SELECT knowledge, trained_at, trained_conversations, (SELECT count(*) FROM agent_training_log l WHERE l.agent_id = a.id) AS n
     FROM agents a WHERE id = $1 AND user_id = $2`, [agentId, userId])).rows[0];
  if (!a) throw new AppError(404, 'Agent niet gevonden');
  const st = status.get(agentId) ?? { state: 'geen' as const, done: 0, total: 0, waiting: null, error: null };
  return { ...st, knowledge: a.knowledge, trained_at: a.trained_at, trained_conversations: a.trained_conversations, can_revert: Number(a.n) > 0 };
}
