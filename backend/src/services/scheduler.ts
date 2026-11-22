/**
 * Background scheduler — executes rate-limit resumes automatically.
 * Uses Redis sorted set (score = execute timestamp ms).
 */
import { redis } from '../redis';
import { sendPushToUser } from './pushNotifications';
import { getAuthStatus } from './claudeCode';
import { query } from '../db';
import { hasRoomNow } from './claudeAccounts';

const SCHEDULE_KEY = 'resume_schedules';

export interface ScheduledResume {
  userId: string;
  conversationId: string;
  message: string;
  /** set when the limit was hit: allows an early start once an account has room again */
  createdAt?: number;
  /** own agents that stopped halfway (limit or restart): the resume asks Claude to let them finish (SendMessage) */
  agents?: AgentResume[];
}

export interface AgentResume { name: string; ccAgentId: string; reason: 'limit' | 'restart'; since: number }

/** The follow-up line for one interrupted agent (the main Claude passes it on with SendMessage). */
export function agentResumeLine(a: AgentResume): string {
  return `${a.name} werd onderbroken door ${a.reason === 'limit' ? 'de limiet' : 'een herstart van de server'}. Laat ${a.name} verder gaan met SendMessage naar agentId ${a.ccAgentId}: kijk wat er al gedaan is en maak het af.`;
}

/** Automatic agent resumes are on unless AGENT_AUTO_RESUME=0 (then only the Verder button remains). */
export function agentAutoResumeOn(): boolean {
  return process.env.AGENT_AUTO_RESUME !== '0';
}

async function existingItem(conversationId: string): Promise<{ item: ScheduledResume; score: number } | null> {
  const all = await redis.zrange(SCHEDULE_KEY, '0', '-1', 'WITHSCORES');
  for (let i = 0; i < all.length; i += 2) {
    if (!all[i].startsWith(`${conversationId}|`)) continue;
    try { return { item: JSON.parse(all[i].slice(all[i].indexOf('|') + 1)) as ScheduledResume, score: parseInt(all[i + 1], 10) }; } catch { return null; }
  }
  return null;
}

/** When the planned resume of a conversation runs (epoch ms), or null. */
export async function getScheduledResumeAt(conversationId: string): Promise<number | null> {
  return (await existingItem(conversationId))?.score ?? null;
}

/**
 * Schedule a conversation resume at a specific time. Replaces any existing schedule for that conversation,
 * but interrupted agents of the old schedule are carried over (one follow-up per conversation).
 */
export async function scheduleResume(item: ScheduledResume, executeAt: Date): Promise<void> {
  const prev = await existingItem(item.conversationId);
  const agents = [...(prev?.item.agents ?? []), ...(item.agents ?? [])]
    .filter((a, i, list) => list.findIndex((b) => b.ccAgentId === a.ccAgentId) === i);
  const merged: ScheduledResume = { ...item, ...(agents.length ? { agents } : {}) };
  // an agent-only follow-up never drops the conversation's own resume message, and never moves it later
  let at = executeAt.getTime();
  if (prev && !item.message && prev.item.message) { merged.message = prev.item.message; merged.createdAt = prev.item.createdAt ?? merged.createdAt; at = Math.min(at, prev.score); }
// Remove existing entry for this conversation first
  await cancelScheduledResume(item.conversationId);
  await redis.zadd(SCHEDULE_KEY, at, `${item.conversationId}|${JSON.stringify(merged)}`);
}

/** What is planned for a conversation: its own resume message and/or interrupted agents (names). */
export async function getScheduledResumeInfo(conversationId: string): Promise<{ message: string; agents: string[] } | null> {
  const prev = await existingItem(conversationId);
  return prev ? { message: prev.item.message ?? '', agents: (prev.item.agents ?? []).map((a) => a.name) } : null;
}

/** An agent was already resumed (Claude did it itself): take it out of the planned follow-up. */
export async function dropAgentResume(conversationId: string, ccAgentId: string): Promise<void> {
  const prev = await existingItem(conversationId);
  if (!prev?.item.agents?.some((a) => a.ccAgentId === ccAgentId)) return;
  const agents = prev.item.agents.filter((a) => a.ccAgentId !== ccAgentId);
  await cancelScheduledResume(conversationId);
  if (!prev.item.message && !agents.length) return; // nothing left to do
  await redis.zadd(SCHEDULE_KEY, prev.score, `${conversationId}|${JSON.stringify({ ...prev.item, agents })}`);
}

/** Agents of a follow-up that were not resumed in the meantime (a resumed agent_start after `since`). */
async function stillInterrupted(conversationId: string, agents: AgentResume[]): Promise<AgentResume[]> {
  if (!agents.length) return agents;
  const since = Math.min(...agents.map((a) => a.since));
  const r = await query<{ content: string }>(
    `SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant' AND content LIKE '%"resumed":true%'
       AND created_at > to_timestamp($2::double precision / 1000) - interval '6 hours'`, [conversationId, since]).catch(() => ({ rows: [] as Array<{ content: string }> }));
  const resumedAt = new Map<string, number>();
  for (const row of r.rows) {
    try {
      for (const e of JSON.parse(row.content) as Array<Record<string, unknown>>) {
        if (e.type === 'agent_start' && e.resumed === true && typeof e.ccAgentId === 'string' && typeof e.at === 'string') {
          resumedAt.set(e.ccAgentId, Math.max(resumedAt.get(e.ccAgentId) ?? 0, Date.parse(e.at)));
        }
      }
    } catch { /* not structured */ }
  }
  return agents.filter((a) => !((resumedAt.get(a.ccAgentId) ?? 0) > a.since));
}

/** Cancel any scheduled resume for a conversation. */
export async function cancelScheduledResume(conversationId: string): Promise<void> {
  const all = await redis.zrange(SCHEDULE_KEY, '0', '-1');
  for (const member of all) {
    if (member.startsWith(`${conversationId}|`)) {
      await redis.zrem(SCHEDULE_KEY, member);
    }
  }
}

/** Return the scheduled execute time for a conversation, or null if nothing scheduled. */
export async function getScheduledResumeTime(conversationId: string): Promise<Date | null> {
  const all = await redis.zrange(SCHEDULE_KEY, '0', '-1');
  for (const member of all) {
    if (member.startsWith(`${conversationId}|`)) {
      const score = await redis.zscore(SCHEDULE_KEY, member);
      if (score) return new Date(parseInt(score, 10));
    }
  }
  return null;
}

/** Execute all due resumes. Called every 30 s. */
async function processScheduled(): Promise<void> {
  const now = Date.now();
  const due = await redis.zrangebyscore(SCHEDULE_KEY, 0, now);
  // Early start: a subscription has clear room again (manual reset, new window). Only for
  // automatic schedules at least 3 minutes old, so a fresh limit is not retried in a loop.
  const later = await redis.zrangebyscore(SCHEDULE_KEY, `(${now}`, '+inf');
  const roomCache = new Map<string, boolean>();
  for (const m of later) {
    try {
      const it = JSON.parse(m.slice(m.indexOf('|') + 1)) as ScheduledResume;
      if (!it.createdAt || now - it.createdAt < 3 * 60_000) continue;
      if (!roomCache.has(it.userId)) roomCache.set(it.userId, await hasRoomNow(it.userId));
      if (roomCache.get(it.userId)) due.push(m);
    } catch { /* skip */ }
  }
  if (due.length === 0) return;

  for (const member of due) {

// Remove first — prevent double execution on restart
    await redis.zrem(SCHEDULE_KEY, member);

    const pipeIdx = member.indexOf('|');
    if (pipeIdx === -1) continue;

    let item: ScheduledResume;
    try {
      item = JSON.parse(member.slice(pipeIdx + 1)) as ScheduledResume;
    } catch {
      continue;
    }

    try {
      const authStatus = await getAuthStatus(item.userId);
      if (authStatus !== 'authenticated') {
        console.log(`[scheduler] Skip ${item.conversationId}: not authenticated`);
        continue;
      }
      const conv = (await query<{ id: string; model: string; metadata: Record<string, unknown>; title: string }>(
        "SELECT id, model, metadata, title FROM conversations WHERE id = $1 AND status != 'deleted'", [item.conversationId])).rows[0];
      if (!conv) { console.log(`[scheduler] Conversation ${item.conversationId} not found`); continue; }
      const u = (await query<{ role: string; language: string | null }>('SELECT role, language FROM users WHERE id = $1 AND is_active = true', [item.userId])).rows[0];
      if (!u) continue;
      // Interrupted agents: only those Claude did not resume itself in the meantime
      const agents = await stillInterrupted(item.conversationId, item.agents ?? []);
      const text = [item.message, ...agents.map(agentResumeLine)].filter(Boolean).join('\n\n');
      if (!text) { console.log(`[scheduler] ${item.conversationId}: agents al hervat, niets te doen`); continue; }
      // Same path as a normal message: right workspace (admin chat too), live in the app, queue continues afterwards
      const { startConversationRun } = await import('../routes/stream');
      const r = await startConversationRun({
        userId: item.userId, role: u.role, language: u.language ?? 'nl', conv, attachmentIds: [], push: true,
        userMessage: text, auto: item.message ? (item.createdAt ? 'limit' : undefined) : 'agent',
      });
      if (r.busy) {
        await scheduleResume(item, new Date(Date.now() + 60_000));
        continue;
      }
      if ((conv.metadata as { push_on?: boolean }).push_on) await notifyUserIfAway(item.userId, 'Claude is weer bezig', `Vervolg op: ${conv.title ?? 'gesprek'}`, `/chat/${item.conversationId}`).catch(() => {});
      console.log(`[scheduler] resume started for conversation ${item.conversationId}`);
    } catch (err) {
      console.error(`[scheduler] Error processing ${item.conversationId}:`, err);
    }
  }
}

export function startScheduler(): void {
  console.log('✓ Scheduler started (30s interval)');

// Run once immediately to pick up any overdue tasks from before restart
  processScheduled().catch(err => console.error('[scheduler] Initial check error:', err));
  setInterval(() => {
    processScheduled().catch(err => console.error('[scheduler] Error:', err));
  }, 30_000);
}



// Push notification helper — only sends when user is not actively connected via SSE
export async function notifyUserIfAway(userId: string, title: string, body: string, url?: string): Promise<void> {
  await sendPushToUser(userId, { title, body, url, tag: 'scheduler' }, { onlyAway: true }).catch(() => {});
}
