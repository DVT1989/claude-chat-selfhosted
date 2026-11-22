/**
 * Delegations: an agent gets its own workplace. Instead of a subagent inside the chat run (which stops
 * when that chat stops or restarts), Claude hands longer work to an agent with POST /agents/claude/delegate.
 * That makes a conversation "<Agent>: <titel>" and starts a run there through the same pipeline as
 * scheduled tasks (startConversationRun), in which the main Claude gives the task to the agent on the
 * foreground. The parent conversation shows a card (event type 'delegation') with live status.
 *
 * - At most MAX_RUNNING delegations run at once per user, and only while the chosen account is under
 *   a subscription that is not at its limit (like a chat; the share limits are for background work); the rest waits as 'queued' and starts by itself (pump, every 30 s and after a finish).
 * - Interrupted (limit, token, restart, stop): the existing resume logic continues the run in the
 *   delegation's own conversation; the next run start sets it to 'running' again.
 * - Finished: a short Haiku summary (runStructured), a push, the card in the parent updated in place
 *   (stored, also when the parent chat was done), and a line for Claude in the parent's next run.
 *
 * Parent identity: every run gets CC_RUN_TOKEN in its env (claudeCode.ts); the token maps to the user
 * and the conversation of that run. Only with it can a delegation from the admin chat run privileged.
 */
import { randomBytes } from 'crypto';
import { query } from '../db';
import { redis } from '../redis';
import { AppError } from '../middleware/errorHandler';
import { runStructured, getAuthStatus } from './claudeCode';
import { accountsOverview } from './claudeAccounts';
import { sendPushToUser } from './pushNotifications';
import { listAgents, type Agent } from './agents';
import * as broker from './streamBroker';
import { getScheduledResumeAt } from './scheduler';

export type DelegationStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
export const MAX_RUNNING = 3;
const PUMP_MS = 30_000;
const RUN_TOKEN_TTL_SEC = 24 * 3600;

export interface Delegation {
  id: string; user_id: string; agent_id: string | null; parent_conversation_id: string | null; conversation_id: string;
  title: string; status: DelegationStatus; result_summary: string | null; prompt: string;
  parent_message_id: string | null; privileged: boolean; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; reported_at: string | null;
}
const COLS = `id, user_id, agent_id, parent_conversation_id, conversation_id, title, status, result_summary, prompt,
  parent_message_id, privileged, error, created_at, started_at, finished_at, reported_at`;

export async function ensureDelegationsSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS agent_delegations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
      parent_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'interrupted')),
      result_summary TEXT,
      prompt TEXT NOT NULL,
      parent_message_id UUID,
      privileged BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      reported_at TIMESTAMPTZ
    )`);
  await query('CREATE INDEX IF NOT EXISTS agent_delegations_parent_idx ON agent_delegations (parent_conversation_id, created_at)');
  await query('CREATE INDEX IF NOT EXISTS agent_delegations_conv_idx ON agent_delegations (conversation_id)');
  await query("CREATE INDEX IF NOT EXISTS agent_delegations_open_idx ON agent_delegations (user_id) WHERE status IN ('queued', 'running')");
  // Claude runs are children of the backend: a run still 'running' at boot died with the previous process.
  // resumeInterrupted continues it in its own conversation; that run start sets it to 'running' again.
  await query(`UPDATE agent_delegations SET status = 'interrupted', error = 'Onderbroken door een herstart' WHERE status = 'running'`);
}

// ── Run tokens: which run (user + conversation) calls the API ──
const runKey = (t: string) => `ccrun:${t}`;

export async function issueRunToken(userId: string, conversationId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redis.set(runKey(token), JSON.stringify({ userId, conversationId }), 'EX', RUN_TOKEN_TTL_SEC);
  return token;
}

export async function runTokenInfo(token: string): Promise<{ userId: string; conversationId: string } | null> {
  if (!token || token.length > 100) return null;
  const raw = await redis.get(runKey(token)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as { userId: string; conversationId: string }; } catch { return null; }
}

// ── Live runs: the stream pipeline registers the running answer per conversation ──
// (so a card can go into the answer that is being written, and be updated there)
export interface LiveRun { assistantMsgId: string; inject: (ev: Record<string, unknown>) => void }
const liveRuns = new Map<string, LiveRun>();
export function registerLiveRun(conversationId: string, run: LiveRun): () => void {
  liveRuns.set(conversationId, run);
  return () => { if (liveRuns.get(conversationId) === run) liveRuns.delete(conversationId); };
}

/** The card event as stored in the parent's answer. */
function cardEvent(d: Delegation, agent: Pick<Agent, 'id' | 'name'> | null): Record<string, unknown> {
  return {
    type: 'delegation', delegationId: d.id, conversationId: d.conversation_id, title: d.title,
    agentId: agent?.id ?? d.agent_id, agentName: agent?.name ?? 'Agent', status: d.status,
    ...(d.result_summary ? { summary: d.result_summary } : {}), at: new Date(d.created_at).toISOString(),
    ...(d.finished_at ? { finishedAt: new Date(d.finished_at).toISOString() } : {}),
  };
}

/** Put the card in the parent: into the answer being written, or as its own stored message. */
async function placeCard(d: Delegation, agent: Agent): Promise<string | null> {
  if (!d.parent_conversation_id) return null;
  const live = liveRuns.get(d.parent_conversation_id);
  if (live) {
    live.inject(cardEvent(d, agent));
    return live.assistantMsgId;
  }
  const r = await query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3::jsonb) RETURNING id`,
    [d.parent_conversation_id, JSON.stringify([cardEvent(d, agent)]), JSON.stringify({ delegation_id: d.id })]);
  broker.publish(d.parent_conversation_id, 'delegation', cardEvent(d, agent));
  return r.rows[0].id;
}

/** Update the stored card (status, summary) in place. Waits while that answer is still being finalised. */
async function updateCard(d: Delegation): Promise<void> {
  if (!d.parent_conversation_id) return;
  const agent = d.agent_id ? (await listAgents(d.user_id)).find((a) => a.id === d.agent_id) ?? null : null;
  const ev = cardEvent(d, agent);
  const live = liveRuns.get(d.parent_conversation_id);
  if (live && live.assistantMsgId === d.parent_message_id) { live.inject(ev); return; } // inject publishes too
  if (!d.parent_message_id) { broker.publish(d.parent_conversation_id, 'delegation', ev); return; }
  for (let i = 0; i < 20; i++) {
    const m = (await query<{ content: string; streaming: boolean }>(
      "SELECT content, COALESCE(metadata->>'streaming', 'false') = 'true' AS streaming FROM messages WHERE id = $1", [d.parent_message_id])).rows[0];
    if (!m) return;
    if (m.streaming) {
      // the run is finishing (its final write would overwrite ours) or it registers again: try once more shortly
      const again = liveRuns.get(d.parent_conversation_id);
      if (again && again.assistantMsgId === d.parent_message_id) { again.inject(ev); return; }
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    let events: Array<Record<string, unknown>>;
    try { events = JSON.parse(m.content); if (!Array.isArray(events)) return; } catch { return; }
    const i2 = events.findIndex((e) => e.type === 'delegation' && e.delegationId === d.id);
    if (i2 >= 0) events[i2] = { ...events[i2], ...ev }; else events.push(ev);
    await query('UPDATE messages SET content = $1 WHERE id = $2', [JSON.stringify(events), d.parent_message_id]);
    broker.publish(d.parent_conversation_id, 'delegation', ev); // open windows of the parent refresh the card
    return;
  }
}

// ── Create ──────────────────────────────────────────────────
export interface DelegateInput { agent: string; task: string; prompt: string; parentConversationId?: string | null }

async function findAgent(userId: string, name: string): Promise<Agent> {
  const n = name.trim().toLowerCase().replace(/^@/, '');
  const a = (await listAgents(userId)).find((x) => x.is_active && (x.slug === n || x.slug === `agent-${n}` || x.name.toLowerCase() === n));
  if (!a) throw new AppError(400, `Agent "${name}" niet gevonden of niet actief`);
  return a;
}

/**
 * Hand a task to an agent in its own conversation. `runConv` is the conversation of the calling run
 * (from its run token); without a token the parent must be named and belong to the user.
 */
export async function createDelegation(userId: string, b: DelegateInput, runConv: string | null): Promise<Delegation> {
  const agent = await findAgent(userId, b.agent);
  const parentId = runConv ?? b.parentConversationId ?? null;
  if (b.parentConversationId && runConv && b.parentConversationId !== runConv) throw new AppError(400, 'parentConversationId hoort niet bij deze run');
  let parent: { id: string; model: string; metadata: Record<string, unknown>; title: string | null } | null = null;
  if (parentId) {
    parent = (await query<{ id: string; model: string; metadata: Record<string, unknown>; title: string | null }>(
      "SELECT id, model, metadata, title FROM conversations WHERE id = $1 AND user_id = $2 AND status != 'deleted'", [parentId, userId])).rows[0] ?? null;
    if (!parent) throw new AppError(404, 'Oudergesprek niet gevonden');
  }
  // no delegations from a workplace: collaboration there goes inline (Vraag aan / Overdracht aan)
  if (parent?.metadata?.delegation_id) throw new AppError(409, 'Dit gesprek is al een werkplek van een agent; werk hier inline samen met de Agent-tool');
  const open = (await query<{ n: string }>("SELECT count(*) AS n FROM agent_delegations WHERE user_id = $1 AND status IN ('queued', 'running')", [userId])).rows[0];
  if (Number(open?.n ?? 0) >= 20) throw new AppError(429, 'Er staan al 20 delegaties open');
  const role = (await query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId])).rows[0]?.role;
  // a delegation from the admin chat works in the admin workspace too (only with the run token of that chat)
  const privileged = !!runConv && parent?.metadata?.isSystem === true && role === 'admin';
  const title = b.task.trim().replace(/\s+/g, ' ').slice(0, 80);
  const u = (await query<{ default_model: string | null }>('SELECT default_model FROM users WHERE id = $1', [userId])).rows[0];
  const id = (await query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0].id;
  const conv = (await query<{ id: string }>(
    `INSERT INTO conversations (user_id, title, model, metadata) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [userId, `${agent.name}: ${title}`, parent?.model ?? u?.default_model ?? 'sonnet', JSON.stringify({
      delegation_id: id, delegated_agent_id: agent.id, parent_conversation_id: parent?.id ?? null, ...(privileged ? { delegated_privileged: true } : {}),
    })])).rows[0];
  const d = (await query<Delegation>(
    `INSERT INTO agent_delegations (id, user_id, agent_id, parent_conversation_id, conversation_id, title, prompt, privileged)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [id, userId, agent.id, parent?.id ?? null, conv.id, title, b.prompt.trim(), privileged])).rows[0];
  const msgId = await placeCard(d, agent).catch((e) => { console.error('[delegations] card failed:', e); return null; });
  if (msgId) await query('UPDATE agent_delegations SET parent_message_id = $2 WHERE id = $1', [d.id, msgId]);
  void pump(userId);
  return { ...d, parent_message_id: msgId };
}

// ── Starting (queue) ────────────────────────────────────────
function prefixFor(d: Delegation, agent: Agent, parentTitle: string | null): string {
  return [
    `[Werkplek van ${agent.name}: deze opdracht is gedelegeerd${parentTitle ? ` vanuit het gesprek "${parentTitle}"` : ''}. De gebruiker kijkt niet live mee; vraag dus niets tussendoor, maar maak de taak zo goed mogelijk af. Is er voor iets ingrijpends een akkoord nodig, doe dat dan niet en zet het onder "Open punten" aan het eind.]`,
    `Geef deze taak met de Agent-tool aan ${agent.name} (subagent_type "${agent.slug}"), op de voorgrond: gebruik geen run_in_background, wacht op het antwoord. Samenwerken met collega's (Vraag aan / Overdracht aan) handel je hier af zoals gewoonlijk, met de Agent-tool en SendMessage. Delegeer niet opnieuw via /agents/claude/delegate.`,
    `Vat het antwoord van ${agent.name} daarna niet opnieuw samen; sluit hooguit af met wat er nog open staat.`,
  ].join('\n');
}

const starting = new Set<string>();

/** Start one queued delegation now (the caller checked the limits). */
async function startOne(d: Delegation): Promise<boolean> {
  if (starting.has(d.id)) return false;
  starting.add(d.id);
  try {
    const agent = d.agent_id ? (await listAgents(d.user_id)).find((a) => a.id === d.agent_id && a.is_active) ?? null : null;
    if (!agent) {
      await finish(d.id, 'failed', 'De agent bestaat niet meer of staat uit.', 'Agent niet gevonden');
      return false;
    }
    if (await getAuthStatus(d.user_id) !== 'authenticated') return false;
    const u = (await query<{ role: string; language: string | null }>('SELECT role, language FROM users WHERE id = $1 AND is_active = true', [d.user_id])).rows[0];
    const conv = (await query<{ id: string; model: string; metadata: Record<string, unknown> }>(
      "SELECT id, model, metadata FROM conversations WHERE id = $1 AND status != 'deleted'", [d.conversation_id])).rows[0];
    if (!u || !conv) { await finish(d.id, 'failed', 'Het gesprek van de werkplek is verwijderd.', 'Gesprek niet gevonden'); return false; }
    const parentTitle = d.parent_conversation_id
      ? (await query<{ title: string | null }>('SELECT title FROM conversations WHERE id = $1', [d.parent_conversation_id])).rows[0]?.title ?? null : null;
    // claim it first, so a second pump does not start it too
    const claimed = await query("UPDATE agent_delegations SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'queued'", [d.id]);
    if (!claimed.rowCount) return false;
    const { startConversationRun } = await import('../routes/stream');
    const started = await startConversationRun({
      userId: d.user_id, role: u.role, language: u.language ?? 'nl', conv, attachmentIds: [], push: false,
      userMessage: d.prompt, promptPrefix: prefixFor(d, agent, parentTitle), auto: 'delegation',
    });
    if (started.busy) {
      await query("UPDATE agent_delegations SET status = 'queued' WHERE id = $1 AND status = 'running'", [d.id]);
      return false;
    }
    console.log(`[delegations] ${d.id.slice(0, 8)} gestart: ${agent.name}: ${d.title}`);
    return true;
  } catch (e) {
    console.error(`[delegations] start ${d.id} failed:`, (e as Error).message);
    await finish(d.id, 'failed', `Mislukt bij het starten: ${shortText((e as Error).message, 140)}`, (e as Error).message.slice(0, 500)).catch(() => {});
    return false;
  } finally {
    starting.delete(d.id);
  }
}

/** Pure (tested): how many queued delegations may start now. */
export function freeSlots(running: number, hasRoom: boolean, max = MAX_RUNNING): number {
  return hasRoom ? Math.max(0, max - running) : 0;
}

const pumping = new Set<string>();
/** Start queued delegations while there is room: under MAX_RUNNING running and the account under 80%. */
export async function pump(onlyUser?: string): Promise<void> {
  const users = onlyUser ? [onlyUser]
    : (await query<{ user_id: string }>("SELECT DISTINCT user_id FROM agent_delegations WHERE status = 'queued'")).rows.map((r) => r.user_id);
  for (const userId of users) {
    if (pumping.has(userId)) continue;
    pumping.add(userId);
    try {
      const queued = (await query<Delegation>(`SELECT ${COLS} FROM agent_delegations WHERE user_id = $1 AND status = 'queued' ORDER BY created_at LIMIT 10`, [userId])).rows;
      if (!queued.length) continue;
      const running = Number((await query<{ n: string }>("SELECT count(*) AS n FROM agent_delegations WHERE user_id = $1 AND status = 'running'", [userId])).rows[0]?.n ?? 0);
      // a delegation is work the user asked for in a chat: it runs like that chat would, so only when
      // every linked subscription is at its limit does it wait (the share limits are for background work)
      let free = freeSlots(running, (await accountsOverview(userId)).some((a) => !a.limited));
      for (const d of queued) {
        if (free <= 0) break;
        if (await startOne(d)) free--;
      }
    } catch (e) {
      console.error('[delegations] pump failed:', (e as Error).message);
    } finally {
      pumping.delete(userId);
    }
  }
}

// ── Hooks from the stream pipeline ──────────────────────────
/** A run starts in a workplace (also a resume after a limit or restart): it is running again. */
export async function onRunStarted(conversationId: string, metadata: Record<string, unknown>): Promise<void> {
  if (!metadata?.delegation_id) return;
  // also after done/failed: a steering message from the card starts a new round, the card shows it live again
  await query(`UPDATE agent_delegations SET status = 'running', error = NULL, started_at = COALESCE(started_at, now())
    WHERE id = $1 AND status IN ('queued', 'interrupted', 'done', 'failed')`, [metadata.delegation_id]).catch(() => {});
}

const SUMMARY_SYSTEM = `Je vat het resultaat samen van werk dat een agent in een eigen werkplek deed, voor een kaartje en een pushmelding.
Schrijf in het Nederlands, in de ik-vorm namens de agent, zonder opmaak, emoji of aanhef.
summary: maximaal twee korte zinnen (samen hooguit 200 tekens) met de kern: wat er gedaan of gevonden is, met de belangrijkste getallen, en of er iets open staat.`;
const SUMMARY_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } };

function answerText(content: string): string {
  if (!content.startsWith('[')) return content;
  try {
    const ev = JSON.parse(content) as Array<{ type: string; text?: string; content?: string }>;
    return ev.map((e) => (e.type === 'text' ? e.text : e.type === 'agent_result' ? e.content : '') ?? '').filter(Boolean).join('\n\n');
  } catch { return content; }
}
function shortText(t: string, max = 200): string {
  const plain = t.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]+/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
}

/** Pure (tested): an agent in this answer stopped without a result (limit, token, restart): it resumes later. */
export function hasCutOffAgent(content: string): boolean {
  if (!content.startsWith('[')) return false;
  try {
    const ev = JSON.parse(content) as Array<Record<string, unknown>>;
    const starts = ev.filter((e) => e.type === 'agent_start');
    if (!starts.length) return false;
    const last = new Map<string, Record<string, unknown>>();
    for (const s of starts) last.set(String(s.ccAgentId ?? s.agentId ?? s.toolUseId), s);
    return [...last.values()].some((s) => {
      const r = ev.find((e) => e.type === 'agent_result' && e.toolUseId === s.toolUseId);
      return !r || (r.isError === true && /^onderbroken$/i.test(String(r.content ?? '').trim()));
    });
  } catch { return false; }
}

async function finish(id: string, status: DelegationStatus, summary: string | null, error: string | null): Promise<Delegation | null> {
  const d = (await query<Delegation>(
    `UPDATE agent_delegations SET status = $2, result_summary = COALESCE($3, result_summary), error = $4,
       finished_at = CASE WHEN $2 IN ('done', 'failed') THEN now() ELSE finished_at END
     WHERE id = $1 RETURNING ${COLS}`, [id, status, summary, error])).rows[0] ?? null;
  if (d) await updateCard(d).catch((e) => console.error('[delegations] card update failed:', e));
  return d;
}

export interface FinishedRun { convId: string; userId: string; assistantMsgId: string; failed: boolean; limitHit: boolean; aborted: boolean; error: string }

/** Called after every run; only acts in a workplace with a delegation that is running. Never throws. */
export async function onRunFinished(f: FinishedRun): Promise<void> {
  try {
    const d = (await query<Delegation>(`SELECT ${COLS} FROM agent_delegations WHERE conversation_id = $1 AND status IN ('running', 'interrupted')`, [f.convId])).rows[0];
    if (!d) return;
    const msg = (await query<{ content: string }>('SELECT content FROM messages WHERE id = $1', [f.assistantMsgId])).rows[0];
    const content = msg?.content ?? '';
    if (f.limitHit || f.aborted || hasCutOffAgent(content)) {
      // the limit resume, the agent resume or "Verder" in the workplace continue it
      await finish(d.id, 'interrupted', null, f.limitHit ? 'Gebruikslimiet' : f.aborted ? 'Gestopt' : 'Agent onderbroken');
    } else if (f.failed) {
      const done = await finish(d.id, 'failed', `Mislukt: ${shortText(f.error || 'onbekende fout', 160)}`, f.error.slice(0, 500));
      if (done) await notify(done, true);
    } else {
      const text = answerText(content).trim();
      let summary = text ? shortText(text) : 'Klaar, maar zonder antwoord.';
      if (text) {
        try {
          const agent = d.agent_id ? (await listAgents(d.user_id)).find((a) => a.id === d.agent_id) : undefined;
          const out = await runStructured<{ summary: string }>(d.user_id, {
            system: SUMMARY_SYSTEM, schema: SUMMARY_SCHEMA, model: 'haiku', timeoutMs: 90_000, action: 'delegation_summary',
            prompt: `Agent: ${agent?.name ?? 'agent'}\nTaak: ${d.title}\n\nAntwoord:\n${text.slice(-12_000)}`,
          });
          if (out.summary?.trim()) summary = shortText(out.summary);
        } catch (e) { console.error('[delegations] summary failed:', (e as Error).message); }
      }
      const done = await finish(d.id, 'done', summary, null);
      // a Coach proposal of kind 'other' that was handed to this delegation is now carried out
      if (done) await query(`UPDATE agent_proposals SET status = 'applied', applied_at = now() WHERE delegation_id = $1 AND status IN ('open', 'reverted')`, [d.id]).catch(() => {});
      if (done) await notify(done, false);
    }
  } catch (e) {
    console.error('[delegations] finish failed:', e);
  } finally {
    // a slot came free (or the account was the limit): try the queue
    void pump(f.userId).catch(() => {});
  }
}

/** Where a push for a delegation opens: the parent conversation with the card open (?delegation=<id>), not the workplace. */
async function cardUrl(d: Delegation): Promise<string> {
  if (!d.parent_conversation_id) return `/chat/${d.conversation_id}`;
  const p = (await query<{ sys: boolean | null }>("SELECT (metadata->>'isSystem')::boolean AS sys FROM conversations WHERE id = $1", [d.parent_conversation_id])).rows[0];
  const q = `?delegation=${encodeURIComponent(d.id)}`;
  return p?.sys ? `/settings/adminprompt${q}` : `/chat/${d.parent_conversation_id}${q}`;
}

async function notify(d: Delegation, failed: boolean): Promise<void> {
  const agent = d.agent_id ? (await listAgents(d.user_id)).find((a) => a.id === d.agent_id) : undefined;
  await sendPushToUser(d.user_id, {
    title: `${agent?.name ?? 'Agent'} ${failed ? 'liep vast' : 'is klaar'}: ${d.title}`,
    body: d.result_summary ?? '',
    url: await cardUrl(d),
    tag: `delegation-${d.id}`,
  }).catch(() => {});
}

/**
 * Lines for Claude in the parent's next run: delegations that finished since it last heard, once.
 * (Claude's own session does not see the card; this way "en, is Builder klaar?" just works.)
 */
export async function reportForParent(conversationId: string): Promise<string | null> {
  const rows = (await query<Delegation & { agent_name: string | null }>(
    `UPDATE agent_delegations d SET reported_at = now() FROM (SELECT id FROM agent_delegations
        WHERE parent_conversation_id = $1 AND status IN ('done', 'failed') AND reported_at IS NULL ORDER BY finished_at LIMIT 10) x
     WHERE d.id = x.id
     RETURNING d.id, d.title, d.status, d.result_summary, d.conversation_id, (SELECT name FROM agents a WHERE a.id = d.agent_id) AS agent_name`,
    [conversationId])).rows;
  if (!rows.length) return null;
  return ['[Afgeronde delegaties sinds je vorige antwoord (de gebruiker ziet ze als kaart in dit gesprek):',
    ...rows.map((r) => `- ${r.agent_name ?? 'Agent'}: ${r.title} (${r.status === 'done' ? 'klaar' : 'mislukt'}, gesprek ${r.conversation_id}): ${r.result_summary ?? ''}`),
    'Het volledige verslag staat in dat gesprek; haal het op met GET /history/claude/conversation/<id> als je het nodig hebt.]'].join('\n');
}

// ── Reading ─────────────────────────────────────────────────
export interface DelegationView {
  id: string; title: string; status: DelegationStatus; summary: string | null; error: string | null;
  conversationId: string; parentConversationId: string | null;
  agent: { id: string | null; name: string; slug: string | null; color: string | null };
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  /** live: the current step in the workplace (agent or main run), its number of steps and when the run started */
  live: { step: { tool: string; detail: string; at: number } | null; steps: number; runStartedAt: number;
    /** the agent at work right now (its turn started and has no result yet); null while the main run works */
    active?: CrewMember | null } | null;
  /** interrupted: why, and when the planned resume runs (limit reset); absent when nothing is planned */
  wait?: { reason: 'limit' | 'restart' | 'other'; resumeAt?: string };
  /** queued: place in the queue (1 = next) */
  position?: number;
  /** the agents that worked in the workplace, in order of their first turn (the card shows "Builder + Designer") */
  crew?: CrewMember[];
}
export interface CrewMember { id: string | null; name: string }

function toolDetail(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.description ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? i.command ?? i.prompt ?? '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 89) + '…' : s;
}

/** Pure (tested): the current step from the broker history of the workplace. */
export function liveStep(history: Array<{ event: string; data: unknown }>): { step: { tool: string; detail: string; at: number } | null; steps: number } {
  let step: { tool: string; detail: string; at: number } | null = null;
  let steps = 0;
  for (const h of history) {
    const d = (h.data ?? {}) as Record<string, unknown>;
    if (h.event === 'agent_activity') {
      if (d.toolName !== 'text' && d.toolName !== 'background') steps++;
      step = { tool: String(d.toolName ?? ''), detail: String(d.detail ?? ''), at: Number(d.at) || Date.now() };
    } else if (h.event === 'tool_use' && d.toolName !== 'Agent' && d.toolName !== 'Task') {
      steps++;
      step = { tool: String(d.toolName ?? ''), detail: toolDetail(String(d.toolName ?? ''), d.toolInput), at: 0 };
    } else if (h.event === 'agent_start') {
      step = { tool: 'start', detail: '', at: 0 };
    }
  }
  return { step, steps };
}

/**
 * Pure (tested): who took part, from agent_start/agent_result events (broker history `{event, data}` or
 * stored `{type, ...}`), and who is at work now: the latest turn without a result.
 */
export function crewOf(events: Array<Record<string, unknown>>): { crew: CrewMember[]; active: CrewMember | null } {
  const crew: CrewMember[] = [];
  const open = new Map<string, CrewMember>();
  for (const e of events) {
    const type = typeof e.event === 'string' ? e.event : e.type;
    const d = (typeof e.event === 'string' ? e.data ?? {} : e) as Record<string, unknown>;
    if (type === 'agent_start') {
      const m: CrewMember = { id: typeof d.agentId === 'string' ? d.agentId : null, name: String(d.agentName ?? '').trim() };
      if (!m.name) continue;
      if (!crew.some((c) => c.name.toLowerCase() === m.name.toLowerCase())) crew.push(m);
      open.delete(String(d.toolUseId)); open.set(String(d.toolUseId), m);
    } else if (type === 'agent_result' || type === 'agent_interrupted') open.delete(String(d.toolUseId));
  }
  return { crew, active: [...open.values()].pop() ?? null };
}

/** Crew from the stored answers of a workplace (a cut-off turn there is no longer "active"); cached briefly. */
const crewCache = new Map<string, { at: number; crew: CrewMember[] }>();
async function storedCrew(conversationId: string): Promise<CrewMember[]> {
  const hit = crewCache.get(conversationId);
  if (hit && Date.now() - hit.at < 20_000) return hit.crew;
  const rows = (await query<{ content: string }>(
    `SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant' AND content LIKE '%"agent_start"%' ORDER BY created_at`, [conversationId])).rows;
  const events: Array<Record<string, unknown>> = [];
  for (const r of rows) { try { const ev = JSON.parse(r.content); if (Array.isArray(ev)) events.push(...ev.filter((e) => e?.type === 'agent_start')); } catch { /* not JSON */ } }
  const crew = crewOf(events).crew;
  crewCache.set(conversationId, { at: Date.now(), crew });
  if (crewCache.size > 500) crewCache.delete(crewCache.keys().next().value as string);
  return crew;
}

function mergeCrew(a: CrewMember[], b: CrewMember[]): CrewMember[] {
  const out = [...a];
  for (const m of b) if (!out.some((c) => c.name.toLowerCase() === m.name.toLowerCase())) out.push(m);
  return out;
}

const stepAt = new Map<string, { key: string; at: number }>();
function view(d: Delegation, agents: Agent[], queuePos?: number, stored?: CrewMember[], resumeAtMs?: number | null): DelegationView {
  const a = agents.find((x) => x.id === d.agent_id);
  let live: DelegationView['live'] = null;
  let crew: CrewMember[] = stored ?? [];
  const task = d.status === 'running' ? broker.getActiveTask(d.conversation_id) : null;
  if (task) {
    const s = liveStep(task.history);
    // tool_use and agent_start carry no time (at 0): keep the moment this step was first seen
    if (s.step && !s.step.at) {
      const key = `${s.steps}:${s.step.tool}:${s.step.detail}`;
      const prev = stepAt.get(d.id);
      if (prev?.key !== key) stepAt.set(d.id, { key, at: Date.now() });
      s.step.at = stepAt.get(d.id)!.at;
    }
    const c = crewOf(task.history as unknown as Array<Record<string, unknown>>);
    crew = mergeCrew(crew, c.crew);
    live = { ...s, runStartedAt: task.startedAt, active: c.active };
  } else stepAt.delete(d.id);
  // the delegated agent first, then whoever it asked
  const own = crew.findIndex((c) => (d.agent_id && c.id === d.agent_id) || (a && c.name.toLowerCase() === a.name.toLowerCase()));
  if (own > 0) crew = [crew[own], ...crew.slice(0, own), ...crew.slice(own + 1)];
  return {
    id: d.id, title: d.title, status: d.status, summary: d.result_summary, error: d.error,
    conversationId: d.conversation_id, parentConversationId: d.parent_conversation_id,
    agent: { id: d.agent_id, name: a?.name ?? 'Agent', slug: a?.slug ?? null, color: a?.color ?? null },
    createdAt: new Date(d.created_at).toISOString(), startedAt: d.started_at ? new Date(d.started_at).toISOString() : null,
    finishedAt: d.finished_at ? new Date(d.finished_at).toISOString() : null, live,
    ...(d.status === 'interrupted' ? { wait: {
      reason: d.error === 'Gebruikslimiet' ? 'limit' as const : /herstart/i.test(d.error ?? '') ? 'restart' as const : 'other' as const,
      ...(resumeAtMs ? { resumeAt: new Date(resumeAtMs).toISOString() } : {}) } } : {}),
    ...(queuePos ? { position: queuePos } : {}),
    ...(crew.length ? { crew } : {}),
  };
}

async function queuePositions(userId: string): Promise<Map<string, number>> {
  const q = (await query<{ id: string }>("SELECT id FROM agent_delegations WHERE user_id = $1 AND status = 'queued' ORDER BY created_at", [userId])).rows;
  return new Map(q.map((r, i) => [r.id, i + 1]));
}

export async function listDelegations(userId: string, parent: string | null, limit = 30): Promise<DelegationView[]> {
  const rows = (await query<Delegation>(
    `SELECT ${COLS} FROM agent_delegations WHERE user_id = $1 AND ($2::uuid IS NULL OR parent_conversation_id = $2)
     ORDER BY created_at DESC LIMIT $3`, [userId, parent, limit])).rows;
  const agents = await listAgents(userId);
  const pos = rows.some((r) => r.status === 'queued') ? await queuePositions(userId) : new Map<string, number>();
  const at = new Map<string, number | null>();
  await Promise.all(rows.filter((r) => r.status === 'interrupted').map(async (r) => { at.set(r.id, await getScheduledResumeAt(r.conversation_id).catch(() => null)); }));
  return rows.map((r) => view(r, agents, pos.get(r.id), undefined, at.get(r.id)));
}

export async function getDelegation(userId: string, id: string): Promise<DelegationView | null> {
  const d = (await query<Delegation>(`SELECT ${COLS} FROM agent_delegations WHERE id = $1 AND user_id = $2`, [id, userId])).rows[0];
  if (!d) return null;
  const pos = d.status === 'queued' ? await queuePositions(userId) : new Map<string, number>();
  const stored = d.status === 'queued' ? [] : await storedCrew(d.conversation_id).catch(() => [] as CrewMember[]);
  const resumeAt = d.status === 'interrupted' ? await getScheduledResumeAt(d.conversation_id).catch(() => null) : null;
  return view(d, await listAgents(userId), pos.get(d.id), stored, resumeAt);
}

export function startDelegations(): void {
  setTimeout(() => void pump().catch(() => {}), 15_000).unref();
  setInterval(() => void pump().catch(() => {}), PUMP_MS).unref();
  console.log('✓ Delegaties gestart (30s)');
}
