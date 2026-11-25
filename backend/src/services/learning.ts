/**
 * Learning loop (inspired by Hermes Agent): after a conversation has gone quiet, a cheap model
 * (Haiku) reads the new part and stores facts, preferences and feedback in the user's memory and
 * technical lessons in the shared lessons. Every change is logged in learn_log with a before/after
 * snapshot, so the user can see it and undo it. Tasks that keep coming back (about 3 times) turn
 * into a skill PROPOSAL (SKILL.md, optionally with a script); it only becomes a skill after approval.
 * A daily cleanup archives long unused facts and merges near-duplicates. Nothing is hard-deleted
 * without a trail.
 *
 * Never in the way of a chat: one job at a time, only when no Claude run is going on, only when the
 * user's subscription has room, and always with Haiku via runStructured (same account choice and
 * single-flight OAuth refresh as normal runs).
 */
import { chownSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { query } from '../db';
import { chownRun } from './runUsers';
import { scrub, renderAssistant } from './agentTraining';
import { redis } from '../redis';
import * as mem from './memory';
import { addLessonWithId, deleteLesson } from './lessons';
import { runStructured, getAuthStatus, getUserHomeDir, getPrivilegedHomeDir } from './claudeCode';
import { getActiveTask } from './streamBroker';
import { tryAcquire, lockReason, roomBelow } from './backgroundJobs';
import { buildSkillMd, isValidSkillName, listOwnSkills, saveOwnSkill, slugify } from './userSkills';

const MODEL = 'haiku';
const QUIET_MIN = 20;          // minutes of silence before a conversation counts as finished
const MIN_TURNS = 2;           // new user turns needed after the silence
const FORCE_TURNS = 12;        // ... or this many new turns, even without silence
const WINDOW_DAYS = 3;         // never backfill older conversations automatically
const PATTERN_THRESHOLD = 3;   // a task seen in this many conversations gets a skill proposal
const TRANSCRIPT_MAX = 20_000; // characters sent to Haiku per run (was 30k: only the new part of a conversation goes in, plus 2 context messages)
const UNUSED_DAYS = 120;       // cleanup: not used for this long (and rarely used) -> archived


// ── Schema ──────────────────────────────────────────────────
export async function ensureLearningSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS learn_state (
      conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      learned_until TIMESTAMPTZ NOT NULL,
      runs INTEGER NOT NULL DEFAULT 0,
      last_status TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS learn_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id UUID,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'bezig',
      model TEXT,
      input_chars INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    )`);
  await query('CREATE INDEX IF NOT EXISTS learn_runs_user_idx ON learn_runs (user_id, started_at DESC)');
  await query(`
    CREATE TABLE IF NOT EXISTS learn_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      run_id UUID,
      conversation_id UUID,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id UUID,
      before JSONB,
      after JSONB,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reverted_at TIMESTAMPTZ
    )`);
  await query('CREATE INDEX IF NOT EXISTS learn_log_user_idx ON learn_log (user_id, created_at DESC)');
  await query(`
    CREATE TABLE IF NOT EXISTS task_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      summary TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      conversation_ids UUID[] NOT NULL DEFAULT '{}',
      proposed_at_count INTEGER NOT NULL DEFAULT 0,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, key)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS skill_proposals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pattern_id UUID REFERENCES task_patterns(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      script_name TEXT,
      script_lang TEXT,
      script_content TEXT,
      reason TEXT NOT NULL DEFAULT '',
      conversation_ids UUID[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'open',
      installed_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    )`);
  await query('CREATE INDEX IF NOT EXISTS skill_proposals_user_idx ON skill_proposals (user_id, status)');
}

// ── Secrets and personal data ───────────────────────────────
const SECRET_RES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk-ant-[\w-]{10,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})/g,
  /\b((?:password|passwd|pwd|wachtwoord|secret|token|api[_-]?key|client[_-]?secret|bearer)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
  /(\b[a-z][\w+.-]*:\/\/[^:\s/@]+:)[^@\s]+@/gi,
];
/** Long random-looking strings (keys, tokens): letters and digits mixed, 32+ characters. */
const RANDOM_RE = /\b(?=[A-Za-z0-9+/_-]{32,}\b)(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9+/_-]{32,}\b/g;

export function redact(text: string): string {
  let t = text;
  t = t.replace(SECRET_RES[0], '[sleutel weg]');
  t = t.replace(SECRET_RES[1], '[token weg]');
  t = t.replace(SECRET_RES[2], '$1[weg]');
  t = t.replace(SECRET_RES[3], '$1[weg]@');
  t = t.replace(RANDOM_RE, (m) => (/^[0-9a-f-]{36}$/i.test(m) ? m : '[weg]'));
  return t;
}
export const hasSecret = (text: string) => redact(text) !== text || /\[(weg|token weg|sleutel weg)\]/.test(text);

/** Lessons are shared with every account: nothing that points at a person, customer or machine. */
function looksPersonal(text: string, names: string[]): boolean {
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) return true;                              // e-mail
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) return true; // ids
  if (/\b(?!127\.0\.0\.1)(\d{1,3}\.){3}\d{1,3}\b/.test(text)) return true;              // IP addresses
  if (/\b[A-Z]{2,}[A-Z0-9]*-(PC|WS|LT|NB|SRV|DC|TAB)\d*/.test(text)) return true;         // machine names
  const low = text.toLowerCase();
  return names.some((n) => n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(low));
}

const wordSet = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
export function similarity(a: string, b: string): number {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ── Settings ────────────────────────────────────────────────
export interface AssistantSettings { learn: boolean; budgetTokens: number | null }

export async function getSettings(userId: string): Promise<AssistantSettings> {
  const r = await query<{ a: { learn?: boolean; budgetTokens?: number } | null }>(`SELECT preferences->'assistant' AS a FROM users WHERE id = $1`, [userId]);
  const a = r.rows[0]?.a ?? {};
  return { learn: a.learn !== false, budgetTokens: typeof a.budgetTokens === 'number' ? a.budgetTokens : null };
}

export async function setSettings(userId: string, patch: Partial<AssistantSettings>): Promise<AssistantSettings> {
  const clean: Record<string, unknown> = {};
  if (typeof patch.learn === 'boolean') clean.learn = patch.learn;
  if (patch.budgetTokens === null || typeof patch.budgetTokens === 'number') clean.budgetTokens = patch.budgetTokens;
  await query(
    `UPDATE users SET preferences = jsonb_set(COALESCE(preferences, '{}'::jsonb), '{assistant}',
       COALESCE(preferences->'assistant', '{}'::jsonb) || $2::jsonb) WHERE id = $1`, [userId, JSON.stringify(clean)]);
  return getSettings(userId);
}

// ── Job runner: one background job at a time (shared lock in backgroundJobs), beside the chats ──
// Runs while the user chats, as long as the chosen account stays under 80% of its subscription.
async function mayRun(userId: string): Promise<string | null> {
  if (await getAuthStatus(userId) !== 'authenticated') return 'geen Claude-account gekoppeld';
  if (!await roomBelow(userId)) return 'sessie boven 80% of week bijna op';
  return null;
}

async function startRun(userId: string, kind: string, conversationId: string | null): Promise<string> {
  return (await query<{ id: string }>(`INSERT INTO learn_runs (user_id, conversation_id, kind, model) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, conversationId, kind, MODEL])).rows[0].id;
}
async function endRun(id: string, r: { status: string; saved?: number; skipped?: number; inputChars?: number; error?: string }): Promise<void> {
  await query(`UPDATE learn_runs SET status = $2, saved = $3, skipped = $4, input_chars = $5, error = $6, finished_at = now() WHERE id = $1`,
    [id, r.status, r.saved ?? 0, r.skipped ?? 0, r.inputChars ?? 0, r.error?.slice(0, 500) ?? null]);
}
async function log(userId: string, runId: string | null, conversationId: string | null, e: { kind: string; action: string; target: string | null; before?: unknown; after?: unknown; note?: string }): Promise<void> {
  await query(`INSERT INTO learn_log (user_id, run_id, conversation_id, kind, action, target_id, before, after, note) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
    [userId, runId, conversationId, e.kind, e.action, e.target, e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.note ?? null]);
}

// ── Transcript ──────────────────────────────────────────────
interface Msg { id: string; role: string; content: string; created_at: Date; metadata: { tools?: Array<{ name?: string; input?: Record<string, unknown> }> } | null }

function clip(s: string, head: number, tail: number): string {
  const t = s.replace(/\n{3,}/g, '\n\n').trim();
  return t.length <= head + tail + 20 ? t : `${t.slice(0, head)}\n[...]\n${t.slice(-tail)}`;
}
function toolLines(m: Msg, max = 8): string[] {
  const out: string[] = [];
  for (const t of m.metadata?.tools ?? []) {
    if (out.length >= max) break;
    const inp = t.input ?? {};
    const what = String(inp.command ?? inp.code ?? inp.file_path ?? inp.pattern ?? inp.url ?? inp.description ?? '').replace(/\s+/g, ' ').slice(0, 160);
    out.push(`  [tool ${String(t.name ?? '?').replace(/^mcp__\w+__/, '')}] ${what}`);
  }
  return out;
}
function transcript(msgs: Msg[], max = TRANSCRIPT_MAX): string {
  const parts = msgs.map((m) => {
    const head = m.role === 'user' ? 'GEBRUIKER' : 'CLAUDE';
    // tool turns are stored as a JSON list of events: read them as text plus one line per tool
    const body = m.role === 'user' ? clip(m.content, 1400, 300) : m.content.startsWith('[{') ? clip(renderAssistant(m.content), 700, 700) : clip(m.content, 700, 700);
    return [`${head} (${m.created_at.toISOString().slice(0, 16).replace('T', ' ')}):`, body, ...(m.role === 'assistant' ? toolLines(m) : [])].join('\n');
  });
  let out = '';
  for (let i = parts.length - 1; i >= 0; i--) {          // newest first, so the end of the conversation always fits
    if (out.length + parts[i].length > max) { out = '[eerder deel weggelaten]\n\n' + out; break; }
    out = parts[i] + '\n\n' + out;
  }
  // scrub(): redact() plus harvested passwords (sshpass, SSHPASS=, "wachtwoord is ...") everywhere in the text
  return scrub(out.trim());
}

// ── Learning one conversation ───────────────────────────────
const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    memories: { type: 'array', maxItems: 8, items: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'update'] }, id: { type: 'string' }, topic: { type: 'string' },
      content: { type: 'string' }, tags: { type: 'string' } }, required: ['action', 'topic', 'content'] } },
    lessons: { type: 'array', maxItems: 4, items: { type: 'object', properties: {
      topic: { type: 'string' }, lesson: { type: 'string' } }, required: ['topic', 'lesson'] } },
    tasks: { type: 'array', maxItems: 3, items: { type: 'object', properties: {
      key: { type: 'string' }, summary: { type: 'string' } }, required: ['key', 'summary'] } },
  },
  required: ['memories', 'lessons', 'tasks'],
};
type LearnOut = { memories: Array<{ action: 'add' | 'update'; id?: string; topic: string; content: string; tags?: string }>; lessons: Array<{ topic: string; lesson: string }>; tasks: Array<{ key: string; summary: string }> };

const LEARN_SYSTEM = `Je bent de leerlus van een persoonlijke assistent. Je leest het nieuwe deel van een afgerond gesprek tussen de gebruiker en Claude en bepaalt wat het waard is om te onthouden, zodat een volgende sessie minder hoeft uit te zoeken of te vragen. Antwoord alleen met JSON volgens het schema. Schrijf in het Nederlands.

memories (persoonlijk geheugen van deze gebruiker):
- Alleen blijvende feiten: wie de gebruiker is, voorkeuren, feedback op hoe Claude werkt (met waarom en hoe toe te passen), klanten, apparaten, tenants, projecten, paden, werkwijzen, afspraken.
- Een feit per item, kort (1 tot 3 zinnen), op zichzelf leesbaar zonder het gesprek. Topic: user, feedback, klant, project, apparaat, contact, werkwijze of een ander kort woord.
- Staat het al in BESTAANDE HERINNERINGEN: niet opnieuw toevoegen. Is een bestaand feit veranderd of onvolledig: action "update" met dat id en de volledige nieuwe tekst.
- Niets tijdelijks (wat er vandaag mis was, de status van een lopende taak), niets wat Claude zelf algemeen weet.
- NOOIT wachtwoorden, tokens, sleutels, pincodes of andere geheimen, ook niet gedeeltelijk.

lessons (gedeelde technische kennis, voor alle gebruikers van de app):
- Alleen als er iets technisch misging en duidelijk werd hoe het wel moet (commando, pad, recht, beperking). Een regel, algemeen geformuleerd, 15 tot 400 tekens.
- NOOIT namen, e-mailadressen, klant- of bedrijfsnamen, apparaatnamen, IP-adressen, ID's of andere persoonlijke gegevens. Twijfel je: weglaten. Bestaat de les al: weglaten.
- topic: kort, bijv. app, devices, github, m365, messenger, ssh, git, security.

tasks (soorten werk in dit gesprek, om terugkerende taken te herkennen):
- Hooguit 3 taken die de gebruiker liet doen en die vaker kunnen terugkomen (bijv. uren boeken, backend uitrollen, mailbox nalopen).
- key: kebab-case, 2 tot 5 woorden, algemeen (geen datums of namen van gesprekken). Gebruik een BESTAANDE TAAK-key als het dezelfde soort taak is.
- summary: een zin over wat de taak inhoudt en hoe hij gedaan werd.

Lege lijsten zijn prima: liever niets dan iets onzekers.`;

export async function learnConversation(userId: string, conv: { id: string; title: string; learned_until: Date | null }, opts: { chunk?: boolean } = {}): Promise<{ saved: number; skipped: number; status: string; more?: boolean }> {
  const runId = await startRun(userId, 'gesprek', conv.id);
  try {
    const all = (await query<Msg>(
      `SELECT id, role, content, created_at, metadata FROM messages WHERE conversation_id = $1 AND content <> '' ORDER BY created_at, id`, [conv.id])).rows;
    const fromIdx = conv.learned_until ? all.findIndex((m) => m.created_at > conv.learned_until!) : 0;
    if (fromIdx < 0) { await endRun(runId, { status: 'niets nieuw' }); return { saved: 0, skipped: 0, status: 'niets nieuw' }; }
    // backfill: a long conversation in pieces that each fit, so nothing in the middle is lost
    let endIdx = all.length;
    if (opts.chunk) {
      let size = 0;
      for (let i = fromIdx; i < all.length; i++) {
        size += Math.min(all[i].content.length, all[i].role === 'user' ? 1700 : 1400) + 200;
        if (size > TRANSCRIPT_MAX * 0.9 && i > fromIdx) { endIdx = i; break; }
      }
    }
    // nothing new from the user (only assistant output, or just test messages): nothing to learn, skip the call
    if (!all.slice(fromIdx, endIdx).some((m) => m.role === 'user' && m.content.trim().length >= 15)) {
      await query(
        `INSERT INTO learn_state (conversation_id, user_id, learned_until, runs, last_status) VALUES ($1, $2, $3, 1, 'niets nieuw')
         ON CONFLICT (conversation_id) DO UPDATE SET learned_until = EXCLUDED.learned_until, last_status = 'niets nieuw'`,
        [conv.id, userId, all[endIdx - 1].created_at]).catch(() => {});
      await endRun(runId, { status: 'niets nieuw' });
      return { saved: 0, skipped: 0, status: 'niets nieuw', more: endIdx < all.length };
    }
    const more = endIdx < all.length;
    const until = all.length ? all[endIdx - 1].created_at : new Date();
    const part = all.slice(Math.max(0, fromIdx - 2), endIdx);
    const text = transcript(part);

    const existing = (await query<{ id: string; topic: string; content: string }>(
      `SELECT id, topic, content FROM user_memories WHERE user_id = $1 AND merged_into IS NULL
       ORDER BY pinned DESC, (archived_at IS NULL) DESC, updated_at DESC LIMIT 80`, [userId])).rows;
    const lessonsNow = (await query<{ topic: string; lesson: string }>('SELECT topic, lesson FROM shared_lessons ORDER BY created_at DESC LIMIT 60')).rows;
    const patterns = (await query<{ key: string; summary: string; count: number }>(
      'SELECT key, summary, count FROM task_patterns WHERE user_id = $1 ORDER BY last_seen DESC LIMIT 50', [userId])).rows;

    const prompt = [
      `BESTAANDE HERINNERINGEN (id | topic | tekst):`,
      ...existing.map((m) => `${m.id} | ${m.topic} | ${m.content.replace(/\s+/g, ' ').slice(0, 220)}`),
      existing.length ? '' : '(geen)',
      `BESTAANDE LESSEN:`,
      ...lessonsNow.map((l) => `[${l.topic}] ${l.lesson}`),
      '',
      `BESTAANDE TAAK-KEYS:`,
      ...patterns.map((p) => `${p.key} (${p.count}x): ${p.summary}`),
      patterns.length ? '' : '(geen)',
      `GESPREK: ${conv.title || '(zonder titel)'}`,
      '',
      text,
    ].join('\n');

    const out = await runStructured<LearnOut>(userId, { system: LEARN_SYSTEM, prompt, schema: LEARN_SCHEMA, model: MODEL, timeoutMs: 150_000, action: 'learn' });
    const r = await applyLearning(userId, runId, conv.id, out, existing);
    await query(
      `INSERT INTO learn_state (conversation_id, user_id, learned_until, runs, last_status) VALUES ($1, $2, $3, 1, 'ok')
       ON CONFLICT (conversation_id) DO UPDATE SET learned_until = $3, runs = learn_state.runs + 1, last_status = 'ok', updated_at = now()`,
      [conv.id, userId, until]);
    await endRun(runId, { status: 'ok', saved: r.saved, skipped: r.skipped, inputChars: prompt.length });
    return { ...r, status: 'ok', more };
  } catch (err) {
    const msg = (err as Error).message;
    await endRun(runId, { status: 'fout', error: msg });
    // a limit is retried later; anything else counts as done, so a broken conversation is not retried forever
    if (!/limiet|429/i.test(msg)) {
      await query(
        `INSERT INTO learn_state (conversation_id, user_id, learned_until, runs, last_status) VALUES ($1, $2, now(), 1, 'fout')
         ON CONFLICT (conversation_id) DO UPDATE SET learned_until = now(), runs = learn_state.runs + 1, last_status = 'fout', updated_at = now()`,
        [conv.id, userId]).catch(() => {});
    }
    throw err;
  }
}

async function applyLearning(userId: string, runId: string, convId: string, out: LearnOut, existing: Array<{ id: string; topic: string; content: string }>): Promise<{ saved: number; skipped: number }> {
  let saved = 0, skipped = 0;
  const known = new Map(existing.map((m) => [m.id, m]));
  const user = (await query<{ name: string | null; email: string }>('SELECT name, email FROM users WHERE id = $1', [userId])).rows[0];
  const names = [user?.name ?? '', user?.email?.split('@')[0] ?? ''].flatMap((n) => n.toLowerCase().split(/\s+/)).filter(Boolean);

  for (const m of (out.memories ?? []).slice(0, 8)) {
    const content = (m.content ?? '').trim();
    if (content.length < 10 || content.length > 1200 || hasSecret(content)) { skipped++; continue; }
    if (m.action === 'update' && m.id && known.has(m.id)) {
      const before = (await query<mem.Memory>('SELECT topic, content, tags FROM user_memories WHERE id = $1 AND user_id = $2', [m.id, userId])).rows[0];
      if (!before || before.content.trim() === content) { skipped++; continue; }
      await mem.updateMemory(userId, m.id, { content, topic: m.topic || before.topic, tags: m.tags ?? before.tags });
      await log(userId, runId, convId, { kind: 'memory', action: 'update', target: m.id,
        before: { topic: before.topic, content: before.content, tags: before.tags }, after: { topic: m.topic || before.topic, content, tags: m.tags ?? before.tags } });
      saved++;
      continue;
    }
    // near-duplicate of something we already know: skip rather than add a second version
    if ([...known.values()].some((k) => similarity(k.content, content) >= 0.7)) { skipped++; continue; }
    const r = await mem.addMemory(userId, { topic: m.topic || 'algemeen', content, tags: (m.tags ?? '').slice(0, 200) });
    if (r.result !== 'added') { skipped++; continue; }
    known.set(r.id, { id: r.id, topic: m.topic, content });
    await log(userId, runId, convId, { kind: 'memory', action: 'add', target: r.id, after: { topic: m.topic, content, tags: m.tags ?? '' } });
    saved++;
  }

  for (const l of (out.lessons ?? []).slice(0, 4)) {
    const topic = (l.topic ?? '').trim().toLowerCase();
    const lesson = (l.lesson ?? '').trim();
    if (!/^[a-z0-9-]{2,30}$/.test(topic) || lesson.length < 15 || lesson.length > 400 || hasSecret(lesson) || looksPersonal(lesson, names)) { skipped++; continue; }
    const r = await addLessonWithId(userId, topic, lesson);
    if (r.result !== 'added') { skipped++; continue; }
    await log(userId, runId, convId, { kind: 'lesson', action: 'add', target: r.id, after: { topic, lesson } });
    saved++;
  }

  for (const t of (out.tasks ?? []).slice(0, 3)) {
    const key = slugify(t.key ?? '').slice(0, 60);
    const summary = (t.summary ?? '').trim().slice(0, 400);
    if (key.length < 3 || !summary || hasSecret(summary)) continue;
    // counted once per conversation; the summary follows the latest occurrence
    await query(
      `INSERT INTO task_patterns (user_id, key, summary, count, conversation_ids) VALUES ($1, $2, $3, 1, ARRAY[$4::uuid])
       ON CONFLICT (user_id, key) DO UPDATE SET
         count = task_patterns.count + CASE WHEN $4::uuid = ANY(task_patterns.conversation_ids) THEN 0 ELSE 1 END,
         conversation_ids = CASE WHEN $4::uuid = ANY(task_patterns.conversation_ids) THEN task_patterns.conversation_ids
                                 ELSE (task_patterns.conversation_ids || $4::uuid)[greatest(1, cardinality(task_patterns.conversation_ids) - 8):] END,
         summary = $3, last_seen = now()`,
      [userId, key, summary, convId]);
  }
  return { saved, skipped };
}

// ── Skill proposals ─────────────────────────────────────────
const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    worth: { type: 'boolean' },
    name: { type: 'string' },
    description: { type: 'string' },
    instructions: { type: 'string' },
    script: { type: 'object', properties: {
      filename: { type: 'string' }, language: { type: 'string', enum: ['bash', 'ts'] }, content: { type: 'string' }, usage: { type: 'string' } } },
    reason: { type: 'string' },
  },
  required: ['worth', 'name', 'description', 'instructions', 'reason'],
};
type ProposalOut = { worth: boolean; name: string; description: string; instructions: string; script?: { filename?: string; language?: 'bash' | 'ts'; content?: string; usage?: string } | null; reason: string };

const PROPOSAL_SYSTEM = `Je ontwerpt een Claude Code-skill voor een taak die een gebruiker steeds opnieuw laat doen. Doel: het volgende keer sneller en met minder tokens doen, liefst met een vast script zodat het werk één aanroep wordt in plaats van veel losse tool calls. Antwoord alleen met JSON volgens het schema, in het Nederlands.

- worth: false als de gesprekken te verschillend zijn of er niets vast te leggen valt.
- name: kebab-case, kort, beschrijvend (bijv. backend-uitrollen).
- description: een of twee zinnen die zeggen WANNEER de skill gebruikt moet worden, met de woorden die de gebruiker dan gebruikt. Hieraan herkent Claude de skill.
- instructions: markdown, kort: wanneer, stappen, valkuilen die in de gesprekken naar voren kwamen, hoe je controleert dat het gelukt is. Geen inleiding.
- script (alleen als het werk echt in een vast script past): bash (voorkeur) of ts (draait met node, typen worden weggelaten). Parameters als argumenten, set -euo pipefail bij bash, duidelijke uitvoer, geen interactieve vragen. Gebruik alleen paden, commando's en endpoints die in de gesprekken voorkwamen; geheimen nooit in het script zetten maar lezen uit de bestanden of variabelen die de gesprekken ook gebruikten. usage: een regel met de aanroep.
- reason: een zin waarom dit tijd of tokens scheelt.`;

export async function makeProposal(userId: string, patternId: string): Promise<'voorstel' | 'geen voorstel'> {
  const p = (await query<{ key: string; summary: string; count: number; conversation_ids: string[] }>(
    'SELECT key, summary, count, conversation_ids FROM task_patterns WHERE id = $1 AND user_id = $2', [patternId, userId])).rows[0];
  if (!p) return 'geen voorstel';
  const runId = await startRun(userId, 'voorstel', null);
  try {
    const convs = p.conversation_ids.slice(-3);
    const parts: string[] = [];
    for (const cid of convs) {
      const c = (await query<{ title: string }>(`SELECT COALESCE(title, '') AS title FROM conversations WHERE id = $1 AND user_id = $2`, [cid, userId])).rows[0];
      if (!c) continue;
      const msgs = (await query<Msg>(`SELECT id, role, content, created_at, metadata FROM messages WHERE conversation_id = $1 AND content <> '' ORDER BY created_at, id`, [cid])).rows;
      parts.push(`### Gesprek: ${c.title}\n${transcript(msgs, 7000)}`);
    }
    const own = listOwnSkills(getUserHomeDir(userId)).map((s) => `${s.name}: ${s.description.slice(0, 120)}`);
    const prompt = [`TAAK: ${p.key} (${p.count}x gezien)`, `Samenvatting: ${p.summary}`, '',
      `BESTAANDE EIGEN SKILLS (niet dubbel maken):`, ...(own.length ? own : ['(geen)']), '', ...parts].join('\n');
    const out = await runStructured<ProposalOut>(userId, { system: PROPOSAL_SYSTEM, prompt, schema: PROPOSAL_SCHEMA, model: MODEL, timeoutMs: 180_000, action: 'learn' });
    await query('UPDATE task_patterns SET proposed_at_count = count WHERE id = $1', [patternId]);

    const name = slugify(out.name || p.key);
    const body = (out.instructions ?? '').trim();
    if (!out.worth || !isValidSkillName(name) || !body || !out.description?.trim() || hasSecret(body)) {
      await endRun(runId, { status: 'geen voorstel', inputChars: prompt.length });
      return 'geen voorstel';
    }
    let script: { name: string; lang: string; content: string } | null = null;
    const sc = out.script;
    if (sc?.content?.trim() && !hasSecret(sc.content)) {
      const lang = sc.language === 'ts' ? 'ts' : 'bash';
      const base = slugify((sc.filename ?? '').replace(/\.(sh|ts|js|bash)$/i, '')) || name;
      script = { name: `${base}.${lang === 'ts' ? 'ts' : 'sh'}`, lang, content: sc.content.replace(/\r\n/g, '\n').trim() + '\n' };
    }
    const fullBody = script
      ? `${body}\n\n## Script\nDit terugkerende werk is één aanroep. Gebruik het script in plaats van de losse stappen; kijk alleen naar de stappen hierboven als het script faalt.\n\`\`\`bash\n${script.lang === 'ts' ? 'node' : 'bash'} ~/.claude/skills/${name}/scripts/${script.name}${sc?.usage ? ` ${sc.usage.replace(/^.*?scripts\/\S+\s*/, '').replace(/^(bash|node)\s+\S+\s*/, '')}` : ''}\n\`\`\`\n`
      : body;
    await query(
      `INSERT INTO skill_proposals (user_id, pattern_id, name, description, body, script_name, script_lang, script_content, reason, conversation_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, patternId, name, out.description.trim().slice(0, 1000), fullBody, script?.name ?? null, script?.lang ?? null, script?.content ?? null, (out.reason ?? '').slice(0, 500), convs]);
    await endRun(runId, { status: 'voorstel', saved: 1, inputChars: prompt.length });
    return 'voorstel';
  } catch (err) {
    await endRun(runId, { status: 'fout', error: (err as Error).message });
    throw err;
  }
}

/** Approve: becomes the user's own skill (SKILL.md plus script), also visible in the admin chat. */
export async function approveProposal(userId: string, id: string): Promise<string> {
  const p = (await query<{ name: string; description: string; body: string; script_name: string | null; script_content: string | null; status: string }>(
    'SELECT name, description, body, script_name, script_content, status FROM skill_proposals WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!p) throw new Error('Voorstel niet gevonden');
  if (p.status !== 'open') throw new Error('Over dit voorstel is al beslist');
  const home = getUserHomeDir(userId);
  const taken = new Set(listOwnSkills(home).map((s) => s.name));
  let name = p.name;
  for (let i = 2; taken.has(name) || existsSync(join(home, '.claude', 'skills', name)); i++) name = `${p.name}-${i}`;
  const body = p.body.split(`/skills/${p.name}/`).join(`/skills/${name}/`);
  saveOwnSkill(home, name, buildSkillMd(name, p.description, body));
  const dir = join(home, '.claude', 'skills', name);
  if (p.script_name && p.script_content) {
    const sdir = join(dir, 'scripts');
    mkdirSync(sdir, { recursive: true, mode: 0o755 });
    chownRun(sdir);
    const f = join(sdir, p.script_name);
    writeFileSync(f, p.script_content, { mode: 0o755 });
    chownRun(f);
  }
  // the admin chat has its own home: link the new skill there too (like the other own skills)
  try {
    const adminSkills = join(getPrivilegedHomeDir(userId), '.claude', 'skills');
    const link = join(adminSkills, name);
    if (existsSync(adminSkills)) {
      let present = true;
      try { lstatSync(link); } catch { present = false; }
      if (!present) symlinkSync(dir, link);
    }
  } catch (err) { console.error('[learning] admin link failed:', (err as Error).message); }
  await query(`UPDATE skill_proposals SET status = 'goedgekeurd', installed_name = $3, decided_at = now() WHERE id = $1 AND user_id = $2`, [id, userId, name]);
  return name;
}

export async function rejectProposal(userId: string, id: string): Promise<boolean> {
  const r = await query(`UPDATE skill_proposals SET status = 'afgewezen', decided_at = now() WHERE id = $1 AND user_id = $2 AND status = 'open'`, [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

// ── Undo ────────────────────────────────────────────────────
export async function revertLog(userId: string, id: string): Promise<void> {
  const e = (await query<{ kind: string; action: string; target_id: string | null; before: Record<string, unknown> | null; reverted_at: string | null }>(
    'SELECT kind, action, target_id, before, reverted_at FROM learn_log WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!e) throw new Error('Niet gevonden');
  if (e.reverted_at) throw new Error('Is al teruggedraaid');
  const b = e.before ?? {};
  if (e.kind === 'memory' && e.action === 'add' && e.target_id) {
    await mem.deleteMemory(userId, e.target_id);                        // the content stays in this log entry
  } else if (e.kind === 'memory' && e.action === 'update' && e.target_id) {
    await mem.updateMemory(userId, e.target_id, { topic: String(b.topic ?? ''), content: String(b.content ?? ''), tags: String(b.tags ?? '') });
  } else if (e.kind === 'memory' && e.action === 'archive' && e.target_id) {
    await query('UPDATE user_memories SET archived_at = NULL, archive_reason = NULL WHERE id = $1 AND user_id = $2', [e.target_id, userId]);
  } else if (e.kind === 'memory' && e.action === 'merge' && e.target_id) {
    const keeper = b.keeper as { content: string; use_count: number } | undefined;
    const merged = (b.merged as string[] | undefined) ?? [];
    if (keeper) await query('UPDATE user_memories SET content = $3, use_count = $4, updated_at = now() WHERE id = $1 AND user_id = $2', [e.target_id, userId, keeper.content, keeper.use_count]);
    await query('UPDATE user_memories SET archived_at = NULL, archive_reason = NULL, merged_into = NULL WHERE user_id = $1 AND id = ANY($2)', [userId, merged]);
  } else if (e.kind === 'lesson' && e.action === 'add' && e.target_id) {
    await deleteLesson(e.target_id);
  } else {
    throw new Error('Dit kan niet worden teruggedraaid');
  }
  await query('UPDATE learn_log SET reverted_at = now() WHERE id = $1', [id]);
}

// ── Cleanup ─────────────────────────────────────────────────
const MERGE_SCHEMA = {
  type: 'object',
  properties: { merges: { type: 'array', items: { type: 'object', properties: {
    group: { type: 'integer' }, merge: { type: 'boolean' }, content: { type: 'string' } }, required: ['group', 'merge'] } } },
  required: ['merges'],
};

export async function cleanupUser(userId: string): Promise<{ archived: number; merged: number }> {
  const runId = await startRun(userId, 'opruimen', null);
  let archived = 0, merged = 0;
  try {
    // 1. long unused and rarely used: out of the core (still searchable, comes back when used)
    const stale = (await query<{ id: string; topic: string; content: string }>(
      `UPDATE user_memories SET archived_at = now(), archive_reason = 'ongebruikt'
       WHERE user_id = $1 AND NOT pinned AND archived_at IS NULL AND merged_into IS NULL AND use_count < 3
         AND COALESCE(last_used_at, created_at) < now() - make_interval(days => $2)
       RETURNING id, topic, content`, [userId, UNUSED_DAYS])).rows;
    for (const s of stale) {
      await log(userId, runId, null, { kind: 'memory', action: 'archive', target: s.id, after: { topic: s.topic, content: s.content }, note: `${UNUSED_DAYS} dagen niet gebruikt` });
      archived++;
    }

    // 2. near-duplicates within a topic: Haiku merges them into one fact
    const live = (await query<{ id: string; topic: string; content: string; pinned: boolean; use_count: number }>(
      `SELECT id, topic, content, pinned, use_count FROM user_memories WHERE user_id = $1 AND archived_at IS NULL AND merged_into IS NULL`, [userId])).rows;
    const parent = new Map<string, string>(live.map((m) => [m.id, m.id]));
    const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      if (live[i].topic === live[j].topic && similarity(live[i].content, live[j].content) >= 0.5) parent.set(find(live[j].id), find(live[i].id));
    }
    const groups = new Map<string, typeof live>();
    for (const m of live) { const r = find(m.id); groups.set(r, [...(groups.get(r) ?? []), m]); }
    const clusters = [...groups.values()].filter((g) => g.length > 1).slice(0, 6);
    if (clusters.length && !(await mayRun(userId))) {
      const prompt = clusters.map((g, i) => `GROEP ${i}:\n${g.map((m) => `- ${m.content.replace(/\s+/g, ' ')}`).join('\n')}`).join('\n\n');
      const out = await runStructured<{ merges: Array<{ group: number; merge: boolean; content?: string }> }>(userId, {
        system: 'Je ruimt een persoonlijk geheugen op. Per groep: zeggen de feiten hetzelfde (of vult de een de ander aan)? Dan merge true en content = één samengevoegd feit, kort, in het Nederlands, zonder informatie te verliezen. Gaan ze over verschillende dingen: merge false. Nooit geheimen of wachtwoorden opnemen. Alleen JSON.',
        prompt, schema: MERGE_SCHEMA, model: MODEL, timeoutMs: 120_000, action: 'learn' });
      for (const m of out.merges ?? []) {
        const g = clusters[m.group];
        const content = (m.content ?? '').trim();
        if (!g || !m.merge || content.length < 10 || content.length > 1500 || hasSecret(content)) continue;
        const keeper = [...g].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.use_count - a.use_count)[0];
        const others = g.filter((x) => x.id !== keeper.id);
        await query('UPDATE user_memories SET content = $3, use_count = $4, updated_at = now() WHERE id = $1 AND user_id = $2',
          [keeper.id, userId, content, g.reduce((n, x) => n + x.use_count, 0)]).catch(async (err: Error) => {
          // the merged text may equal one of the others (unique per user): keep the keeper as it is then
          if (!/duplicate/i.test(err.message)) throw err;
        });
        await query(`UPDATE user_memories SET archived_at = now(), archive_reason = 'samengevoegd', merged_into = $3 WHERE user_id = $1 AND id = ANY($2)`,
          [userId, others.map((o) => o.id), keeper.id]);
        await log(userId, runId, null, { kind: 'memory', action: 'merge', target: keeper.id,
          before: { keeper: { content: keeper.content, use_count: keeper.use_count }, merged: others.map((o) => o.id), texts: others.map((o) => o.content) },
          after: { content }, note: `${g.length} feiten samengevoegd` });
        merged += others.length;
      }
    }
    await endRun(runId, { status: 'ok', saved: archived + merged });
    return { archived, merged };
  } catch (err) {
    await endRun(runId, { status: 'fout', error: (err as Error).message, saved: archived + merged });
    throw err;
  }
}

// ── Scheduling ──────────────────────────────────────────────
interface Candidate { id: string; user_id: string; title: string; learned_until: Date | null }

export async function candidates(onlyUser: string | null, manual: boolean, windowDays = WINDOW_DAYS): Promise<Candidate[]> {
  return (await query<Candidate>(
    `SELECT c.id, c.user_id, COALESCE(c.title, '') AS title, ls.learned_until
     FROM conversations c
     JOIN messages m ON m.conversation_id = c.id
     JOIN users u ON u.id = c.user_id AND u.is_active
     LEFT JOIN learn_state ls ON ls.conversation_id = c.id
     WHERE c.status <> 'deleted' AND ($1::uuid IS NULL OR c.user_id = $1)
       AND COALESCE(u.preferences->'assistant'->>'learn', 'true') <> 'false'
     GROUP BY c.id, ls.learned_until
     HAVING max(m.created_at) > COALESCE(ls.learned_until, '-infinity')
        AND max(m.created_at) > now() - make_interval(days => $2)
        AND bool_and(COALESCE(m.metadata->>'streaming', 'false') <> 'true')
        AND (
          (max(m.created_at) < now() - make_interval(mins => $3)
            AND count(*) FILTER (WHERE m.role = 'user' AND m.created_at > COALESCE(ls.learned_until, '-infinity')) >= $4)
          OR count(*) FILTER (WHERE m.role = 'user' AND m.created_at > COALESCE(ls.learned_until, '-infinity')) >= $5)
     ORDER BY max(m.created_at) LIMIT 5`,
    [onlyUser, windowDays, manual ? 2 : QUIET_MIN, manual ? 1 : MIN_TURNS, FORCE_TURNS])).rows;
}

/** One pass: learn from finished conversations, then at most one skill proposal. */
export async function tick(onlyUser: string | null = null, manual = false): Promise<{ learned: number; proposals: number; waiting?: string }> {
  const release = tryAcquire('leerlus');
  if (!release) return { learned: 0, proposals: 0, waiting: lockReason()! };
  let learned = 0, proposals = 0;
  try {
    for (const c of await candidates(onlyUser, manual)) {
      if (getActiveTask(c.id)) continue;
      const why = await mayRun(c.user_id);
      if (why) return { learned, proposals, waiting: why };
      try { await learnConversation(c.user_id, c); learned++; } catch (err) { console.error(`[learning] ${c.id}:`, (err as Error).message); }
    }
    const due = (await query<{ id: string; user_id: string }>(
      `SELECT p.id, p.user_id FROM task_patterns p
       WHERE p.count >= $1 AND p.count >= p.proposed_at_count + $1 AND ($2::uuid IS NULL OR p.user_id = $2)
         AND NOT EXISTS (SELECT 1 FROM skill_proposals s WHERE s.pattern_id = p.id AND s.status = 'open')
       ORDER BY p.count DESC LIMIT 1`, [PATTERN_THRESHOLD, onlyUser])).rows[0];
    if (due && !(await mayRun(due.user_id))) {
      try { if (await makeProposal(due.user_id, due.id) === 'voorstel') proposals++; } catch (err) { console.error('[learning] proposal:', (err as Error).message); }
    }
    return { learned, proposals };
  } finally {
    release();
  }
}

// ── Backfill: all older conversations of a user, once ──────
// The users to backfill sit in redis, so a backend restart resumes where it stopped (learn_state).
const BACKFILL_KEY = 'learn:backfill';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startBackfill(userId: string): Promise<void> {
  await redis.sadd(BACKFILL_KEY, userId);
  void runBackfill().catch((e) => console.error('[learning] inhalen:', e));
}

export async function backfillStatus(userId: string): Promise<{ active: boolean; left: number }> {
  const active = (await redis.sismember(BACKFILL_KEY, userId)) === 1;
  const left = Number((await query<{ n: string }>(
    `SELECT count(DISTINCT c.id) AS n FROM conversations c JOIN messages m ON m.conversation_id = c.id
     LEFT JOIN learn_state ls ON ls.conversation_id = c.id
     WHERE c.user_id = $1 AND c.status <> 'deleted' AND m.created_at > COALESCE(ls.learned_until, '-infinity')`, [userId])).rows[0]?.n ?? 0);
  return { active, left };
}

let backfilling = false;
async function runBackfill(): Promise<void> {
  if (backfilling) return;
  backfilling = true;
  try {
    for (;;) {
      const users = await redis.smembers(BACKFILL_KEY);
      if (!users.length) return;
      for (const userId of users) {
        // wait while another background job works or the subscription is over 80%
        const why = lockReason() ?? await mayRun(userId);
        if (why) { await sleep(60_000); continue; }
        const release = tryAcquire('inhalen');
        if (!release) { await sleep(60_000); continue; }
        let did = false;
        try {
          const c = (await candidates(userId, true, 3650))[0];
          if (c && !getActiveTask(c.id)) {
            did = true;
            try {
              const r = await learnConversation(userId, c, { chunk: true });
              console.log(`[learning] inhalen ${c.id.slice(0, 8)}: ${r.status}, ${r.saved} opgeslagen${r.more ? ', volgend stuk' : ''}`);
            } catch (err) { console.error(`[learning] inhalen ${c.id}:`, (err as Error).message); await sleep(30_000); }
          } else {
            // all conversations done: turn every recurring task into a proposal (with a script where it fits)
            const due = (await query<{ id: string }>(
              `SELECT p.id FROM task_patterns p WHERE p.user_id = $1 AND p.count >= $2 AND p.count >= p.proposed_at_count + $2
                 AND NOT EXISTS (SELECT 1 FROM skill_proposals s WHERE s.pattern_id = p.id AND s.status = 'open')
               ORDER BY p.count DESC LIMIT 1`, [userId, PATTERN_THRESHOLD])).rows[0];
            if (due) {
              did = true;
              try { console.log(`[learning] inhalen voorstel: ${await makeProposal(userId, due.id)}`); }
              catch (err) { console.error('[learning] inhalen voorstel:', (err as Error).message); await query('UPDATE task_patterns SET proposed_at_count = count WHERE id = $1', [due.id]); }
            } else {
              await redis.srem(BACKFILL_KEY, userId);
              console.log(`[learning] inhalen klaar voor ${userId.slice(0, 8)}`);
            }
          }
        } finally { release(); }
        if (did) await sleep(3_000);
      }
    }
  } finally {
    backfilling = false;
  }
}

export async function cleanupAll(): Promise<void> {
  const release = tryAcquire('opruimen');
  if (!release) return;
  try {
    const users = (await query<{ user_id: string }>('SELECT DISTINCT user_id FROM user_memories')).rows;
    for (const u of users) {
      try { const r = await cleanupUser(u.user_id); if (r.archived || r.merged) console.log(`[learning] opruimen ${u.user_id.slice(0, 8)}: ${r.archived} gearchiveerd, ${r.merged} samengevoegd`); }
      catch (err) { console.error('[learning] cleanup:', (err as Error).message); }
    }
  } finally {
    release();
  }
}

export async function cleanupOne(userId: string): Promise<{ archived: number; merged: number } | { waiting: string }> {
  const release = tryAcquire('opruimen');
  if (!release) return { waiting: lockReason()! };
  try { return await cleanupUser(userId); } finally { release(); }
}

/** A background job (learning, backfill, cleanup or training) holds the shared lock. */
export function isBusy(): boolean { return lockReason() !== null; }

export function startLearning(): void {
  // every 5 minutes; the first pass a little after boot so restarts stay quiet
  setTimeout(() => void tick().catch((e) => console.error('[learning]', e)), 90_000).unref();
  setInterval(() => void tick().catch((e) => console.error('[learning]', e)), 5 * 60_000).unref();
  console.log('✓ Leerlus gestart (5 min)');
  // resume an unfinished backfill after a restart
  setTimeout(() => void runBackfill().catch((e) => console.error('[learning] inhalen:', e)), 120_000).unref();
}
