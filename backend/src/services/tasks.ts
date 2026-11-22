/**
 * Scheduled tasks: a prompt that runs on a cron schedule (or once) in its own conversation
 * "Automatisch: <naam>", through the same pipeline as a typed message (startConversationRun), so the
 * user can watch live, agent bubbles included. Optionally handed to one of the user's agents.
 *
 * - Not autonomous (default): Claude only investigates and ends with "Voorgestelde acties: ...";
 *   the push and the chat then offer "Uitvoeren". Autonomous: Claude does the work itself, but
 *   drastic actions (delete, restart, security) stay a proposal.
 * - Subscription full (hasRoomNow): the run moves 15 minutes on (last_status 'opgeschoven').
 * - Never twice at once: an open run (bezig/wachtrij) skips the next one ('overgeslagen').
 * - Missed runs after a restart: next_run_at is in the past, so the task runs once and the next
 *   time is computed from now (only the last one is caught up).
 * - After the run: a short Haiku summary (runStructured) in last_summary, and a push with a link.
 */
import { query } from '../db';
import { AppError } from '../middleware/errorHandler';
import { runStructured, getAuthStatus } from './claudeCode';
import { hasRoomNow } from './claudeAccounts';
import { sendPushToUser } from './pushNotifications';
import { listAgents, AGENT_COLORS, type Agent } from './agents';
import { nextRun, describeCron, parseCron, isValidTimezone, localParts } from './taskSchedule';

export type TaskStatus = 'bezig' | 'wachtrij' | 'gelukt' | 'mislukt' | 'opgeschoven' | 'overgeslagen';

export interface Task {
  id: string; user_id: string; name: string; prompt: string; agent_id: string | null;
  cron: string | null; schedule_text: string; run_at: string | null; timezone: string;
  enabled: boolean; autonomous: boolean; conversation_id: string | null;
  next_run_at: string | null; last_run_at: string | null; last_status: TaskStatus | null; last_summary: string | null;
  source_pattern: string | null; created_at: string; updated_at: string;
}

const COLS = `id, user_id, name, prompt, agent_id, cron, schedule_text, run_at, timezone, enabled, autonomous, conversation_id,
  next_run_at, last_run_at, last_status, last_summary, source_pattern, created_at, updated_at`;
const RETRY_MS = 15 * 60_000;
const STALE_HOURS = 6;
const EXECUTE_TEXT = 'Voer de voorgestelde acties uit.';

export async function ensureTasksSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
      cron TEXT,
      schedule_text TEXT NOT NULL DEFAULT '',
      run_at TIMESTAMPTZ,
      timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      autonomous BOOLEAN NOT NULL DEFAULT FALSE,
      conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      next_run_at TIMESTAMPTZ,
      last_run_at TIMESTAMPTZ,
      last_status TEXT,
      last_summary TEXT,
      source_pattern TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (cron IS NOT NULL OR run_at IS NOT NULL)
    )`);
  await query('CREATE INDEX IF NOT EXISTS scheduled_tasks_user_idx ON scheduled_tasks (user_id, created_at)');
  await query('CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx ON scheduled_tasks (next_run_at) WHERE enabled');
  await query(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id UUID,
      kind TEXT NOT NULL DEFAULT 'gepland',
      status TEXT NOT NULL DEFAULT 'bezig',
      message_text TEXT,
      assistant_msg_id UUID,
      summary TEXT,
      has_proposal BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    )`);
  await query('CREATE INDEX IF NOT EXISTS task_runs_task_idx ON task_runs (task_id, started_at DESC)');
  await query('CREATE INDEX IF NOT EXISTS task_runs_open_idx ON task_runs (conversation_id) WHERE status IN (\'bezig\', \'wachtrij\')');
  // suggestions ("Automatiseren?") the user waved away
  await query('ALTER TABLE task_patterns ADD COLUMN IF NOT EXISTS automate_dismissed_at TIMESTAMPTZ').catch(() => {});
}

// ── Schedule ────────────────────────────────────────────────
export interface ScheduleInput { cron?: string | null; run_at?: string | null; timezone?: string }

/** Next run for a task's schedule, from now. Null for a one-off in the past or an invalid pattern. */
export function computeNext(s: { cron: string | null; run_at: string | null; timezone: string }, from = new Date()): Date | null {
  if (s.cron) return nextRun(s.cron, s.timezone, from);
  if (s.run_at) { const d = new Date(s.run_at); return d.getTime() > from.getTime() - 60_000 ? d : null; }
  return null;
}

export function validateSchedule(s: ScheduleInput): void {
  if (s.timezone && !isValidTimezone(s.timezone)) throw new AppError(400, 'Onbekende tijdzone');
  if (s.cron) {
    if (!parseCron(s.cron)) throw new AppError(400, 'Ongeldige cron-expressie (vijf velden: minuut uur dag maand weekdag)');
  } else if (s.run_at) {
    const d = new Date(s.run_at);
    if (Number.isNaN(d.getTime())) throw new AppError(400, 'Ongeldig tijdstip');
    if (d.getTime() < Date.now() - 60_000) throw new AppError(400, 'Het tijdstip ligt in het verleden');
  } else {
    throw new AppError(400, 'Geef een frequentie (cron) of een eenmalig tijdstip (run_at)');
  }
}

// ── CRUD ────────────────────────────────────────────────────
export async function listTasks(userId: string): Promise<Task[]> {
  return (await query<Task>(`SELECT ${COLS} FROM scheduled_tasks WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;
}

export async function getTask(userId: string, id: string): Promise<Task | null> {
  return (await query<Task>(`SELECT ${COLS} FROM scheduled_tasks WHERE id = $1 AND user_id = $2`, [id, userId])).rows[0] ?? null;
}

export interface TaskInput {
  name: string; prompt: string; agent_id?: string | null;
  cron?: string | null; schedule_text?: string; run_at?: string | null; timezone?: string;
  enabled?: boolean; autonomous?: boolean; source_pattern?: string | null;
}

async function checkAgent(userId: string, agentId: string | null | undefined): Promise<void> {
  if (!agentId) return;
  const r = await query('SELECT 1 FROM agents WHERE id = $1 AND user_id = $2', [agentId, userId]);
  if (!r.rowCount) throw new AppError(400, 'Agent niet gevonden');
}

export async function createTask(userId: string, b: TaskInput): Promise<Task> {
  const n = await query<{ n: string }>('SELECT count(*) AS n FROM scheduled_tasks WHERE user_id = $1', [userId]);
  if (Number(n.rows[0].n) >= 50) throw new AppError(400, 'Maximaal 50 taken');
  const tz = b.timezone || 'Europe/Amsterdam';
  const cron = b.cron?.trim() || null;
  const runAt = cron ? null : (b.run_at || null);
  validateSchedule({ cron, run_at: runAt, timezone: tz });
  await checkAgent(userId, b.agent_id);
  const enabled = b.enabled ?? true;
  const next = enabled ? computeNext({ cron, run_at: runAt, timezone: tz }) : null;
  const text = b.schedule_text?.trim() || (cron ? describeCron(cron) : `Eenmalig op ${fmtLocal(new Date(runAt!), tz)}`);
  const r = await query<Task>(
    `INSERT INTO scheduled_tasks (user_id, name, prompt, agent_id, cron, schedule_text, run_at, timezone, enabled, autonomous, next_run_at, source_pattern)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLS}`,
    [userId, b.name.trim(), b.prompt.trim(), b.agent_id || null, cron, text, runAt, tz, !!enabled, !!b.autonomous, next, b.source_pattern ?? null]);
  return r.rows[0];
}

export async function updateTask(userId: string, id: string, p: Partial<TaskInput>): Promise<Task> {
  const cur = await getTask(userId, id);
  if (!cur) throw new AppError(404, 'Taak niet gevonden');
  const scheduleChanged = p.cron !== undefined || p.run_at !== undefined || p.timezone !== undefined;
  let cron = cur.cron, runAt = cur.run_at, tz = cur.timezone;
  if (p.timezone) tz = p.timezone;
  if (p.cron !== undefined || p.run_at !== undefined) {
    cron = p.cron?.trim() || null;
    runAt = cron ? null : (p.run_at || null);
  }
  if (scheduleChanged) validateSchedule({ cron, run_at: runAt, timezone: tz });
  if (p.agent_id !== undefined) await checkAgent(userId, p.agent_id);
  const enabled = p.enabled ?? cur.enabled;
  // (re)computed when the schedule changes or the task is switched on; off clears it
  let next: Date | null | string = cur.next_run_at;
  if (!enabled) next = null;
  else if (scheduleChanged || !cur.enabled || !cur.next_run_at) {
    next = computeNext({ cron, run_at: runAt, timezone: tz });
    if (!next) throw new AppError(400, 'Het eenmalige tijdstip ligt in het verleden; kies een nieuw tijdstip');
  }
  const text = p.schedule_text?.trim() || (scheduleChanged ? (cron ? describeCron(cron) : `Eenmalig op ${fmtLocal(new Date(runAt!), tz)}`) : cur.schedule_text);
  const r = await query<Task>(
    `UPDATE scheduled_tasks SET name = $3, prompt = $4, agent_id = $5, cron = $6, schedule_text = $7, run_at = $8, timezone = $9,
       enabled = $10, autonomous = $11, next_run_at = $12, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`,
    [id, userId, p.name?.trim() || cur.name, p.prompt?.trim() || cur.prompt, p.agent_id !== undefined ? (p.agent_id || null) : cur.agent_id,
      cron, text, runAt, tz, !!enabled, p.autonomous !== undefined ? !!p.autonomous : cur.autonomous, next]);
  // the conversation follows the name
  if (p.name && p.name.trim() !== cur.name && cur.conversation_id) {
    await query('UPDATE conversations SET title = $1 WHERE id = $2 AND user_id = $3', [`Automatisch: ${p.name.trim()}`, cur.conversation_id, userId]).catch(() => {});
  }
  return r.rows[0];
}

export async function deleteTask(userId: string, id: string): Promise<boolean> {
  const r = await query('DELETE FROM scheduled_tasks WHERE id = $1 AND user_id = $2', [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function listRuns(userId: string, taskId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  return (await query(
    `SELECT id, kind, status, summary, has_proposal, error, started_at, finished_at FROM task_runs
     WHERE task_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT $3`, [taskId, userId, limit])).rows;
}

function fmtLocal(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.day}-${p.month}-${p.year} om ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// ── Running ─────────────────────────────────────────────────
const starting = new Set<string>();

function rulesFor(autonomous: boolean): string {
  return autonomous
    ? [
      'Je mag het werk van deze taak zelf uitvoeren.',
      'Ingrijpende acties (iets verwijderen, een apparaat of dienst herstarten, beveiliging of gebruikers wijzigen) voer je niet uit: zet die als voorstel onder "Voorgestelde acties: ..." aan het eind.',
      'Eindig met een korte samenvatting van wat je hebt gedaan.',
    ].join('\n')
    : [
      'Voer niets uit dat iets verandert of verstuurt: niet boeken, mailen, berichten sturen, installeren, verwijderen, herstarten of instellingen wijzigen. Alleen lezen en onderzoeken.',
      'Eindig met een kort voorstel in de vorm "Voorgestelde acties: ..." (een korte opsomming), of zeg dat er niets te doen is. De gebruiker kan daarna met één knop laten uitvoeren.',
    ].join('\n');
}

function buildPrefix(task: Task, agent: Agent | null): string {
  const lines = [
    `[Automatische taak "${task.name}" (${task.schedule_text || 'eenmalig'}). De gebruiker kijkt niet live mee; vraag dus niets tussendoor, maar maak de taak zo goed mogelijk af.]`,
    rulesFor(task.autonomous),
  ];
  if (agent) {
    lines.push(`Geef deze taak met de Agent-tool aan ${agent.name} (subagent_type "${agent.slug}"), op de voorgrond: gebruik geen run_in_background, wacht op het antwoord. Geef ${agent.name} deze regels mee. Vat het antwoord daarna niet opnieuw samen.`);
  }
  return lines.join('\n');
}

async function ensureConversation(task: Task): Promise<string> {
  if (task.conversation_id) {
    const r = await query("SELECT 1 FROM conversations WHERE id = $1 AND status != 'deleted'", [task.conversation_id]);
    if (r.rowCount) return task.conversation_id;
  }
  const u = (await query<{ default_model: string | null }>('SELECT default_model FROM users WHERE id = $1', [task.user_id])).rows[0];
  const c = await query<{ id: string }>(
    `INSERT INTO conversations (user_id, title, model, metadata) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [task.user_id, `Automatisch: ${task.name}`, u?.default_model ?? 'sonnet', JSON.stringify({ task_id: task.id })]);
  await query('UPDATE scheduled_tasks SET conversation_id = $1 WHERE id = $2', [c.rows[0].id, task.id]);
  return c.rows[0].id;
}

async function setLast(taskId: string, status: TaskStatus, summary: string | null): Promise<void> {
  await query('UPDATE scheduled_tasks SET last_status = $2, last_summary = COALESCE($3, last_summary), updated_at = now() WHERE id = $1', [taskId, status, summary]);
}

export type RunKind = 'gepland' | 'handmatig' | 'uitvoeren';
export interface RunResult { status: TaskStatus; message: string; conversationId?: string }

/**
 * Start a task now: in its conversation, or in the queue when an answer is already running there.
 * kind 'uitvoeren' sends "Voer de voorgestelde acties uit." (the approval of a proposal).
 */
export async function startTask(userId: string, taskId: string, kind: RunKind): Promise<RunResult> {
  if (starting.has(taskId)) return { status: 'overgeslagen', message: 'Deze taak wordt al gestart' };
  starting.add(taskId);
  try {
    const task = await getTask(userId, taskId);
    if (!task) throw new AppError(404, 'Taak niet gevonden');
    // runs that never finished (crash, lost hook) do not block forever
    await query(`UPDATE task_runs SET status = 'mislukt', error = 'Geen afronding ontvangen', finished_at = now()
      WHERE task_id = $1 AND status IN ('bezig', 'wachtrij') AND started_at < now() - interval '${STALE_HOURS} hours'`, [taskId]);
    const open = await query('SELECT 1 FROM task_runs WHERE task_id = $1 AND status IN (\'bezig\', \'wachtrij\')', [taskId]);
    if (open.rowCount) {
      if (kind === 'gepland') await setLast(taskId, 'overgeslagen', 'Overgeslagen: de vorige run liep nog.');
      return { status: 'overgeslagen', message: 'Deze taak loopt al', conversationId: task.conversation_id ?? undefined };
    }
    if (kind !== 'uitvoeren' && !await hasRoomNow(userId)) {
      const at = new Date(Date.now() + RETRY_MS);
      await query(`UPDATE scheduled_tasks SET last_status = 'opgeschoven', last_summary = $2,
          next_run_at = CASE WHEN enabled OR $3::boolean THEN LEAST(COALESCE(next_run_at, $4::timestamptz), $4::timestamptz) ELSE next_run_at END,
          enabled = enabled OR $3::boolean, updated_at = now() WHERE id = $1`,
        [taskId, `Opgeschoven: je abonnement zit vol. Nieuwe poging om ${fmtLocal(at, task.timezone).split(' om ')[1]}.`, kind === 'gepland', at]);
      return { status: 'opgeschoven', message: 'Je abonnement zit vol; de taak wordt over een kwartier opnieuw geprobeerd' };
    }
    if (await getAuthStatus(userId) !== 'authenticated') {
      await setLast(taskId, 'mislukt', 'Mislukt: er is geen Claude-account gekoppeld.');
      throw new AppError(422, 'Koppel eerst je Claude-account');
    }
    const u = (await query<{ role: string; language: string | null }>('SELECT role, language FROM users WHERE id = $1 AND is_active = true', [userId])).rows[0];
    if (!u) throw new AppError(404, 'Gebruiker niet gevonden');

    const convId = await ensureConversation(task);
    const conv = (await query<{ id: string; model: string; metadata: Record<string, unknown> }>(
      'SELECT id, model, metadata FROM conversations WHERE id = $1', [convId])).rows[0];
    const agent = task.agent_id ? ((await listAgents(userId)).find((a) => a.id === task.agent_id && a.is_active) ?? null) : null;

    const userMessage = kind === 'uitvoeren' ? EXECUTE_TEXT : task.prompt;
    const prefix = kind === 'uitvoeren'
      ? 'De gebruiker keurt de voorgestelde acties uit je vorige antwoord goed. Voer ze nu uit en meld daarna kort wat je hebt gedaan en wat eventueel niet lukte.'
      + (agent ? ` Laat ${agent.name} (subagent_type "${agent.slug}") het uitvoeren, op de voorgrond (geen run_in_background).` : '')
      : buildPrefix(task, agent);

    const run = await query<{ id: string }>(
      `INSERT INTO task_runs (task_id, user_id, conversation_id, kind, status, message_text) VALUES ($1, $2, $3, $4, 'bezig', $5) RETURNING id`,
      [taskId, userId, convId, kind, userMessage]);
    const runId = run.rows[0].id;
    await query("UPDATE scheduled_tasks SET last_run_at = now(), last_status = 'bezig', updated_at = now() WHERE id = $1", [taskId]);
    if (kind === 'uitvoeren') {
      // the button is used: it disappears from the chat
      await query(`UPDATE messages SET metadata = jsonb_set(metadata, '{task_action,used}', 'true'::jsonb)
        WHERE conversation_id = $1 AND metadata ? 'task_action'`, [convId]).catch(() => {});
    }

    const { startConversationRun, enqueueMessage } = await import('../routes/stream');
    const started = await startConversationRun({
      userId, role: u.role, language: u.language ?? 'nl', conv, attachmentIds: [], push: false,
      userMessage, promptPrefix: prefix, auto: kind === 'uitvoeren' ? undefined : 'task',
    });
    if (started.busy) {
      // an answer is running in this conversation: after it, in the queue (with the instructions in the text)
      const queued = kind === 'uitvoeren' ? userMessage : `${prefix}\n\n${userMessage}`;
      await query("UPDATE task_runs SET status = 'wachtrij', message_text = $2 WHERE id = $1", [runId, queued]);
      await enqueueMessage(convId, userId, queued);
      return { status: 'wachtrij' as TaskStatus, message: 'Er loopt al een antwoord in het taakgesprek; de taak staat in de wachtrij', conversationId: convId };
    }
    await query('UPDATE task_runs SET assistant_msg_id = $2 WHERE id = $1', [runId, started.assistantMsgId]);
    return { status: 'bezig' as TaskStatus, message: 'De taak loopt', conversationId: convId };
  } finally {
    starting.delete(taskId);
  }
}

// ── After the run ───────────────────────────────────────────
const SUMMARY_SYSTEM = `Je vat het resultaat van een automatische taak samen voor een pushmelding.
Schrijf in het Nederlands, in de ik-vorm namens de assistent, zonder opmaak, emoji of aanhef.
summary: maximaal twee korte zinnen (samen hooguit 180 tekens) met de kern: wat er gevonden of gedaan is, met de belangrijkste getallen.
has_proposal: true als het antwoord eindigt met voorgestelde acties die de gebruiker nog moet goedkeuren, anders false.`;
const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'has_proposal'],
  properties: { summary: { type: 'string' }, has_proposal: { type: 'boolean' } },
};

/** Visible text of an answer (plain or structured events), agent answers included. */
function answerText(content: string): string {
  if (!content.startsWith('[')) return content;
  try {
    const ev = JSON.parse(content) as Array<{ type: string; text?: string; content?: string }>;
    return ev.map((e) => (e.type === 'text' ? e.text : e.type === 'agent_result' ? e.content : '') ?? '').filter(Boolean).join('\n\n');
  } catch { return content; }
}

const PROPOSAL_RE = /voorgestelde acties\s*:/i;

function shortText(t: string): string {
  const plain = t.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]+/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 180 ? plain.slice(0, 179).trimEnd() + '…' : plain;
}

export interface FinishedRun {
  convId: string; userId: string; assistantMsgId: string; userMessage: string;
  failed: boolean; limitHit: boolean; aborted: boolean; error: string;
}

/** Called by the stream pipeline after every run; only acts on runs of a scheduled task. Never throws. */
export async function onRunFinished(f: FinishedRun): Promise<void> {
  try {
    const run = (await query<{ id: string; task_id: string; kind: RunKind; name: string }>(
      `SELECT r.id, r.task_id, r.kind, t.name FROM task_runs r JOIN scheduled_tasks t ON t.id = r.task_id
       WHERE r.conversation_id = $1 AND r.status IN ('bezig', 'wachtrij')
         AND (r.assistant_msg_id = $2 OR (r.assistant_msg_id IS NULL AND r.message_text = $3))
       ORDER BY r.started_at LIMIT 1`, [f.convId, f.assistantMsgId, f.userMessage])).rows[0];
    if (!run) return;
    await query('UPDATE task_runs SET assistant_msg_id = $2 WHERE id = $1', [run.id, f.assistantMsgId]);

    let status: TaskStatus, summary: string, hasProposal = false;
    if (f.limitHit) {
      status = 'opgeschoven';
      summary = 'Gebruikslimiet bereikt; Claude gaat in het gesprek vanzelf verder zodra er weer ruimte is.';
    } else if (f.aborted) {
      status = 'mislukt'; summary = 'Gestopt voordat de taak klaar was.';
    } else if (f.failed) {
      status = 'mislukt'; summary = `Mislukt: ${shortText(f.error || 'onbekende fout')}`;
    } else {
      status = 'gelukt';
      const msg = (await query<{ content: string }>('SELECT content FROM messages WHERE id = $1', [f.assistantMsgId])).rows[0];
      const text = answerText(msg?.content ?? '').trim();
      hasProposal = run.kind !== 'uitvoeren' && PROPOSAL_RE.test(text);
      if (!text) summary = 'Klaar, maar zonder antwoord.';
      else {
        try {
          const out = await runStructured<{ summary: string; has_proposal: boolean }>(f.userId, {
            system: SUMMARY_SYSTEM, schema: SUMMARY_SCHEMA, model: 'haiku', timeoutMs: 90_000, action: 'task_summary',
            prompt: `Taak: ${run.name}\n\nAntwoord:\n${text.slice(-12_000)}`,
          });
          summary = shortText(out.summary || text);
          if (run.kind !== 'uitvoeren') hasProposal = hasProposal || !!out.has_proposal;
        } catch (e) {
          console.error('[tasks] summary failed:', (e as Error).message);
          summary = shortText(text);
        }
      }
    }

    await query('UPDATE task_runs SET status = $2, summary = $3, has_proposal = $4, error = $5, finished_at = now() WHERE id = $1',
      [run.id, status, summary, hasProposal, f.failed ? f.error.slice(0, 500) : null]);
    await setLast(run.task_id, status, summary);
    if (hasProposal) {
      await query(`UPDATE messages SET metadata = metadata || $2::jsonb WHERE id = $1`,
        [f.assistantMsgId, JSON.stringify({ task_action: { task_id: run.task_id, run_id: run.id } })]);
    }
    if (status === 'opgeschoven') return; // the resume after the limit has its own notice
    await sendPushToUser(f.userId, {
      title: `${status === 'mislukt' ? 'Mislukt' : run.kind === 'uitvoeren' ? 'Uitgevoerd' : 'Taak klaar'}: ${run.name}`,
      body: summary,
      url: `/chat/${f.convId}`,
      tag: `task-${run.task_id}`,
      ...(hasProposal ? { actions: [{ action: 'uitvoeren', title: 'Uitvoeren' }], actionUrl: `/api/tasks/${run.task_id}/execute` } : {}),
    }, { onlyAway: run.kind !== 'gepland' }).catch(() => {});
  } catch (e) {
    console.error('[tasks] finish failed:', e);
  }
}

// ── Scheduler ───────────────────────────────────────────────
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const due = (await query<{ id: string; user_id: string; cron: string | null; timezone: string }>(
      `SELECT id, user_id, cron, timezone FROM scheduled_tasks
       WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now() ORDER BY next_run_at LIMIT 20`)).rows;
    for (const t of due) {
      // claim it: the next time is computed from now, so after a restart only the last missed run is made up
      const next = t.cron ? nextRun(t.cron, t.timezone, new Date()) : null;
      const claimed = await query(
        `UPDATE scheduled_tasks SET next_run_at = $2, enabled = CASE WHEN cron IS NULL THEN false ELSE enabled END
         WHERE id = $1 AND enabled AND next_run_at IS NOT NULL AND next_run_at <= now()`, [t.id, next]);
      if (!claimed.rowCount) continue;
      try {
        const r = await startTask(t.user_id, t.id, 'gepland');
        console.log(`[tasks] ${t.id}: ${r.status}`);
      } catch (e) {
        console.error(`[tasks] run ${t.id} failed:`, (e as Error).message);
        await setLast(t.id, 'mislukt', `Mislukt: ${(e as Error).message.slice(0, 160)}`).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[tasks] tick failed:', e);
  } finally {
    ticking = false;
  }
}

export function startTaskScheduler(): void {
  void (async () => {
    try {
      // a restart cut the running answers off (resumeInterrupted continues them with another message)
      await query(`UPDATE task_runs SET status = 'mislukt', error = 'Onderbroken door een herstart', finished_at = now() WHERE status = 'bezig'`);
      await query(`UPDATE scheduled_tasks SET last_status = 'mislukt', last_summary = 'Onderbroken door een herstart van de server.' WHERE last_status = 'bezig'
        AND NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id = scheduled_tasks.id AND r.status = 'wachtrij')`);
      // enabled cron tasks without a next time (e.g. after an edit by hand)
      const missing = (await query<{ id: string; cron: string; timezone: string }>(
        'SELECT id, cron, timezone FROM scheduled_tasks WHERE enabled AND next_run_at IS NULL AND cron IS NOT NULL')).rows;
      for (const t of missing) await query('UPDATE scheduled_tasks SET next_run_at = $2 WHERE id = $1', [t.id, nextRun(t.cron, t.timezone)]);
    } catch (e) { console.error('[tasks] startup failed:', e); }
    await tick();
  })();
  setInterval(() => { void tick(); }, 30_000);
  console.log('✓ Task scheduler started (30s interval)');
}

// ── Wizard: plain language → name, prompt, schedule and agent advice (Haiku) ──
export interface AssistOut {
  name: string; prompt: string;
  has_schedule: boolean; cron: string; schedule_text: string; run_at: string;
  advice: 'bestaand' | 'nieuw' | 'los'; agent_slug: string; advice_reason: string;
  new_agent: { name: string; description: string; prompt: string; color: string };
}

const ASSIST_SYSTEM = `Je helpt een gebruiker van een chat-app om een automatische taak te maken: een opdracht die Claude op vaste momenten zelf uitvoert in een eigen gesprek, met dezelfde tools en koppelingen (shell, Microsoft 365, mail, apparaten, FocusTrack, internet).
Schrijf alles in het Nederlands, kort en zonder vulwoorden.

- name: korte naam voor de taak, max 4 woorden (bijv. "Mailoverzicht ochtend").
- prompt: de opdracht aan Claude in de jij-vorm, concreet en toetsbaar: wat bekijken, waarop letten, welke vorm het antwoord heeft. Geen tijdstip of frequentie in de prompt. Niet zeggen of hij mag uitvoeren, dat regelt de app.
- Frequentie: staat er een moment of frequentie in de tekst, zet has_schedule=true en geef cron (vijf velden: minuut uur dag-van-de-maand maand weekdag, 0=zondag) plus schedule_text (bijv. "Elke werkdag om 08:00"). Eenmalig moment ("morgen om 9"): cron leeg en run_at als lokale tijd YYYY-MM-DDTHH:MM. Geen moment genoemd: has_schedule=false, cron, schedule_text en run_at leeg. Verzin zelf geen frequentie.
- advice: kies één van drie.
  bestaand: een van de agents van de gebruiker past duidelijk bij deze taak. agent_slug = de slug van die agent.
  nieuw: geen bestaande agent past, en het is een terugkerend vakgebied waar waarschijnlijk meer taken bij horen (bijv. mail, uren, netwerk, beveiliging). Vul new_agent: name (kort, menselijk, als een collega, max 2 woorden), description (1 tot 2 zinnen "wanneer inzetten" met signaalwoorden), prompt (systeemprompt in de jij-vorm met korte kopjes in platte tekst: Rol, Taak, Werkwijze, Regels en grenzen, Antwoordvorm; begin niet met "Je bent <naam>"), color (een van de gegeven kleuren).
  los: een eenmalige of op zichzelf staande taak zonder vakgebied; geen agent nodig.
  Velden die niet van toepassing zijn: lege strings. advice_reason: één korte zin waarom.`;

function assistSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['name', 'prompt', 'has_schedule', 'cron', 'schedule_text', 'run_at', 'advice', 'agent_slug', 'advice_reason', 'new_agent'],
    properties: {
      name: { type: 'string' }, prompt: { type: 'string' },
      has_schedule: { type: 'boolean' }, cron: { type: 'string' }, schedule_text: { type: 'string' }, run_at: { type: 'string' },
      advice: { type: 'string', enum: ['bestaand', 'nieuw', 'los'] }, agent_slug: { type: 'string' }, advice_reason: { type: 'string' },
      new_agent: { type: 'object', additionalProperties: false, required: ['name', 'description', 'prompt', 'color'],
        properties: { name: { type: 'string' }, description: { type: 'string' }, prompt: { type: 'string' }, color: { type: 'string' } } },
    },
  };
}

export async function assistTask(userId: string, text: string): Promise<AssistOut & { agent_id: string | null; next_runs: string[] }> {
  const agents = (await listAgents(userId)).filter((a) => a.is_active);
  const now = new Date();
  const p = localParts(now, 'Europe/Amsterdam');
  const days = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  const prompt = [
    `Nu: ${days[p.dow]} ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} (Europe/Amsterdam).`,
    agents.length
      ? `Agents van de gebruiker:\n${agents.map((a) => `- ${a.name} (slug ${a.slug}): ${a.description}`).join('\n')}`
      : 'De gebruiker heeft nog geen agents.',
    `Kleuren voor een nieuwe agent: ${AGENT_COLORS.join(', ')}`,
    `Wat de gebruiker wil:\n${text.trim()}`,
  ].join('\n\n');
  const out = await runStructured<AssistOut>(userId, { system: ASSIST_SYSTEM, prompt, schema: assistSchema(), model: 'haiku', timeoutMs: 120_000, action: 'assist' });
  // keep only what is valid; a bad cron becomes "ask the user"
  const agent = out.advice === 'bestaand' ? agents.find((a) => a.slug === out.agent_slug) ?? null : null;
  if (out.advice === 'bestaand' && !agent) out.advice = 'los';
  if (out.cron && !parseCron(out.cron)) { out.cron = ''; out.has_schedule = !!out.run_at; }
  if (out.run_at && Number.isNaN(new Date(out.run_at).getTime())) { out.run_at = ''; out.has_schedule = !!out.cron; }
  if (!out.cron && !out.run_at) out.has_schedule = false;
  if (out.cron && !out.schedule_text) out.schedule_text = describeCron(out.cron);
  if (out.advice === 'nieuw' && !AGENT_COLORS.includes(out.new_agent.color)) out.new_agent.color = AGENT_COLORS[0];
  return { ...out, agent_id: agent?.id ?? null, next_runs: out.cron ? previewRuns(out.cron, 'Europe/Amsterdam') : [] };
}

/** The next few run times, for the summary in the wizard. */
export function previewRuns(cron: string, tz: string, n = 3): string[] {
  const out: string[] = [];
  let from = new Date();
  for (let i = 0; i < n; i++) {
    const d = nextRun(cron, tz, from);
    if (!d) break;
    out.push(d.toISOString());
    from = d;
  }
  return out;
}

// ── Suggestions: recurring tasks at fixed moments (from the learning loop, no model call) ──
export interface Suggestion {
  key: string; summary: string; count: number; cron: string; schedule_text: string; reason: string;
}

const DAGDEEL = (h: number) => (h < 6 ? 'nacht' : h < 12 ? 'ochtend' : h < 18 ? 'middag' : 'avond');
const DAGDEEL_LABEL: Record<string, string> = { nacht: "'s nachts", ochtend: "'s ochtends", middag: "'s middags", avond: "'s avonds" };

export async function suggestions(userId: string): Promise<Suggestion[]> {
  const rows = (await query<{ key: string; summary: string; count: number; times: Date[] }>(
    `SELECT p.key, p.summary, p.count, array_agg(c.created_at ORDER BY c.created_at) AS times
     FROM task_patterns p JOIN conversations c ON c.id = ANY(p.conversation_ids) AND c.user_id = p.user_id
     WHERE p.user_id = $1 AND p.count >= 3 AND p.automate_dismissed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM scheduled_tasks t WHERE t.user_id = p.user_id AND t.source_pattern = p.key)
     GROUP BY p.key, p.summary, p.count`, [userId]).catch(() => ({ rows: [] }))).rows;
  const out: Suggestion[] = [];
  for (const r of rows) {
    const local = r.times.map((t) => localParts(new Date(t), 'Europe/Amsterdam'));
    if (local.length < 3) continue;
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    // the same weekday at least 3 times
    const byDow = new Map<number, typeof local>();
    for (const l of local) byDow.set(l.dow, [...(byDow.get(l.dow) ?? []), l]);
    const bestDow = [...byDow.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (bestDow && bestDow[1].length >= 3) {
      const h = median(bestDow[1].map((l) => l.hour));
      const cron = `0 ${h} * * ${bestDow[0]}`;
      out.push({ key: r.key, summary: r.summary, count: r.count, cron, schedule_text: describeCron(cron),
        reason: `${bestDow[1].length} keer op een ${describeCron(cron).split(' ')[1]}` });
      continue;
    }
    // the same part of the day at least 3 times
    const byPart = new Map<string, typeof local>();
    for (const l of local) byPart.set(DAGDEEL(l.hour), [...(byPart.get(DAGDEEL(l.hour)) ?? []), l]);
    const bestPart = [...byPart.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (bestPart && bestPart[1].length >= 3) {
      const h = median(bestPart[1].map((l) => l.hour));
      const weekdaysOnly = bestPart[1].every((l) => l.dow >= 1 && l.dow <= 5);
      const cron = `0 ${h} * * ${weekdaysOnly ? '1-5' : '*'}`;
      out.push({ key: r.key, summary: r.summary, count: r.count, cron, schedule_text: describeCron(cron),
        reason: `${bestPart[1].length} keer ${DAGDEEL_LABEL[bestPart[0]]}` });
    }
  }
  return out.slice(0, 5);
}

export async function dismissSuggestion(userId: string, key: string): Promise<void> {
  await query('UPDATE task_patterns SET automate_dismissed_at = now() WHERE user_id = $1 AND key = $2', [userId, key]);
}
