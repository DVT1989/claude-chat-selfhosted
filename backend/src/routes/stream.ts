import { resumePlan, resumeMessage, type LastMessage } from '../services/resumePlan';
import { Router, Request, Response } from 'express';
import { query } from '../db';
import { accountEvents, earliestRoom, hasRoomElsewhere } from '../services/claudeAccounts';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { runTask, isRateLimitText, getAuthStatus, ConnectorConfig, AttachmentInfo, getUserWorkspace, getUserHomeDir, getValidAccessToken, ensureAdminProjectWorkspace } from '../services/claudeCode';
import { readFileSync } from 'fs';
import { broadcastSse } from '../services/sseEvents';
import { join } from 'path';
import { decrypt } from '../services/crypto';
import * as broker from '../services/streamBroker';
import { graphAccessToken } from '../services/m365';
import { scrubIfSecret } from '../services/agentTraining';
import { sendPushToUser } from '../services/pushNotifications';
import * as queue from '../services/messageQueue';
import { agentAutoResumeOn, scheduleResume as scheduleAgentResume, type AgentResume } from '../services/scheduler';

// Stop pressed: the queue waits until the user sends again. "Send now" aborts but keeps the queue going.
const stoppedByUser = new Set<string>();
const drainAfterAbort = new Set<string>();

async function publishQueue(convId: string): Promise<void> {
  broker.publish(convId, 'queue', { items: await queue.listQueue(convId) });
}

/** Starts the next queued message when the conversation is idle. Never throws. */
async function drainQueue(convId: string): Promise<void> {
  try {
    if (broker.getActiveTask(convId)) return;
    const item = await queue.popFirst(convId);
    if (!item) return;
    const conv = await getConversation(convId, item.user_id);
    const u = (await query<{ role: string; language: string | null }>(
      'SELECT role, language FROM users WHERE id = $1 AND is_active = true', [item.user_id])).rows[0];
    if (!conv || !u) { await publishQueue(convId); return; }
    const started = await startConversationRun({
      userId: item.user_id, role: u.role, language: u.language ?? 'nl', conv,
      userMessage: item.content, attachmentIds: item.attachment_ids ?? [], push: true,
    });
    if (started.busy) {
      // Lost a race with another start: put it back in front, the next finish drains it
      await query(
        `INSERT INTO message_queue (conversation_id, user_id, content, attachment_ids, sort)
         VALUES ($1, $2, $3, $4::jsonb, (SELECT COALESCE(MIN(sort), 0) - 1 FROM message_queue WHERE conversation_id = $1))`,
        [convId, item.user_id, item.content, JSON.stringify(item.attachment_ids ?? [])]);
    }
    await publishQueue(convId);
  } catch (e) { console.error('[queue] drain failed:', e); }
}

/** Queue a message from the app itself (scheduled tasks): shown in the queue, runs after the current answer. */
export async function enqueueMessage(convId: string, userId: string, content: string): Promise<void> {
  await queue.enqueue(convId, userId, content, []);
  stoppedByUser.delete(convId);
  await publishQueue(convId);
  await drainQueue(convId); // the answer may have finished in the meantime
}

/** After a restart: continue every conversation that still has waiting messages. */
export async function resumeQueues(): Promise<void> {
  try {
    for (const id of await queue.conversationsWithQueue()) await drainQueue(id);
  } catch (e) { console.error('[queue] resume failed:', e); }
}

/**
 * After a restart: own agents that were cut off (last 6 hours, conversation not streaming, nothing said since)
 * get a follow-up so they finish their task. Their bubbles are marked (agent_interrupted, reason restart).
 * Conversations that resume anyway (resumeInterrupted) carry the agent lines in that same message; the
 * others get one planned follow-up each. Off with AGENT_AUTO_RESUME=0. Never throws.
 */
export async function resumeAfterRestart(convIds: string[], deployConv: string | null = null): Promise<void> {
  if (deployConv) convIds = [...convIds, deployConv];
  const agentLines = new Map<string, string[]>();
  const pending = new Map<string, { userId: string; list: AgentResume[]; at: Date }>();
  if (agentAutoResumeOn()) {
    try {
      const { agentResumeLine } = await import('../services/scheduler');
      const r = await query<{ id: string; conversation_id: string; content: string; user_id: string }>(
        `SELECT DISTINCT ON (m.conversation_id) m.id, m.conversation_id, m.content, c.user_id
           FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.status != 'deleted'
          WHERE m.role = 'assistant' AND m.created_at > now() - interval '6 hours' AND m.content LIKE '%"ccAgentId"%'
          ORDER BY m.conversation_id, m.created_at DESC`);
      for (const row of r.rows) {
        try {
          if (broker.getActiveTask(row.conversation_id)) continue;
          const last = (await query<{ id: string }>('SELECT id FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1', [row.conversation_id])).rows[0];
          if (last?.id !== row.id) continue; // the conversation went on after this answer
          const tries = (await query<{ n: string }>(
            `SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND role = 'user' AND metadata->>'auto' = 'agent' AND created_at > now() - interval '6 hours'`,
            [row.conversation_id])).rows[0];
          if (Number(tries?.n ?? 0) >= 3) { console.log(`[stream] ${row.conversation_id}: agents al 3 keer hervat, niet opnieuw`); continue; }
          const events = JSON.parse(row.content) as Array<Record<string, unknown>>;
          const cut = interruptedAgents(events);
          if (!cut.length) continue;
          const now = new Date();
          const resumeAt = new Date(now.getTime() + 20_000);
          for (const a of cut) events.push({ type: 'agent_interrupted', toolUseId: a.toolUseId, agentId: a.agentId, agentName: a.agentName, ccAgentId: a.ccAgentId, reason: 'restart', at: now.toISOString(), resumeAt: resumeAt.toISOString() });
          await query('UPDATE messages SET content = $1 WHERE id = $2', [JSON.stringify(events), row.id]);
          const list: AgentResume[] = cut.map((a) => ({ name: a.agentName, ccAgentId: a.ccAgentId, reason: 'restart', since: now.getTime() }));
          if (convIds.includes(row.conversation_id)) {
            agentLines.set(row.conversation_id, list.map(agentResumeLine));
            pending.set(row.conversation_id, { userId: row.user_id, list, at: resumeAt });
          } else {
            await scheduleAgentResume({ userId: row.user_id, conversationId: row.conversation_id, message: '', agents: list }, resumeAt);
          }
          console.log(`[stream] ${row.conversation_id}: ${list.map((a) => a.name).join(', ')} gaat verder na de herstart`);
        } catch (e) { console.error('[stream] agent resume after restart failed:', e); }
      }
    } catch (e) { console.error('[stream] agent scan after restart failed:', e); }
  }
  const started = await resumeInterrupted(convIds, agentLines, deployConv);
  // the conversation itself did not resume after all: the agents still get their own follow-up
  for (const [convId, p] of pending) {
    if (started.has(convId)) continue;
    await scheduleAgentResume({ userId: p.userId, conversationId: convId, message: '', agents: p.list }, p.at).catch((e) => console.error('[stream] agent resume schedule failed:', e));
  }
}

/** Bubbles of own agents in a stored answer that never finished (no result, or "Onderbroken"), latest per agent. */
export function interruptedAgents(events: Array<Record<string, unknown>>): Array<{ toolUseId: string; agentId: string; agentName: string; ccAgentId: string }> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const e of events) if (e.type === 'agent_start' && typeof e.ccAgentId === 'string') latest.set(e.ccAgentId, e);
  const out: Array<{ toolUseId: string; agentId: string; agentName: string; ccAgentId: string }> = [];
  for (const [cc, st] of latest) {
    const id = st.toolUseId;
    if (events.some((e) => e.type === 'agent_interrupted' && e.toolUseId === id)) continue; // limit: already planned
    const res = events.find((e) => e.type === 'agent_result' && e.toolUseId === id);
    const cutOff = !res || (res.isError === true && /^onderbroken$/i.test(String(res.content ?? '').trim()));
    if (cutOff) out.push({ toolUseId: String(id), agentId: String(st.agentId), agentName: String(st.agentName), ccAgentId: cc });
  }
  return out;
}

/**
 * After a restart: let Claude continue conversations whose answer was cut off (selfupdate, crash), and
 * the conversation that started the selfupdate (it checks the rollout). See resumePlan. Never throws.
 */
export async function resumeInterrupted(convIds: string[], agentLines: Map<string, string[]> = new Map(), deployConv: string | null = null): Promise<Set<string>> {
  const started = new Set<string>();
  for (const convId of [...new Set(convIds)]) {
    try {
      if (broker.getActiveTask(convId)) continue;
      const owner = (await query<{ user_id: string }>("SELECT user_id FROM conversations WHERE id = $1 AND status != 'deleted'", [convId])).rows[0];
      if (!owner) continue;
      // Only when the cut-off answer is the last message and no user message came after it
      const last = (await query<LastMessage>(
        'SELECT role, metadata, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1', [convId])).rows[0];
      const recent = (await query<{ n: string }>(
        `SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND role = 'user' AND metadata->>'auto' = 'resume' AND created_at > now() - interval '1 hour'`,
        [convId])).rows[0];
      const deploy = convId === deployConv;
      const kind = resumePlan(last, { deploy, recentResumes: Number(recent?.n ?? 0) });
      if (!kind) {
        if (deploy || last?.metadata?.interrupted) console.log(`[stream] ${convId}: niet hervat (laatste bericht ${last?.role ?? 'geen'}, ${recent?.n ?? 0} keer hervat dit uur)`);
        continue;
      }
      const conv = await getConversation(convId, owner.user_id);
      const u = (await query<{ role: string; language: string | null }>('SELECT role, language FROM users WHERE id = $1 AND is_active = true', [owner.user_id])).rows[0];
      if (!conv || !u) continue;
      await startConversationRun({
        userId: owner.user_id, role: u.role, language: u.language ?? 'nl', conv, attachmentIds: [], push: true, auto: 'resume',
        userMessage: [resumeMessage(kind, deploy), ...(agentLines.get(convId) ?? [])].join('\n\n'),
      });
      started.add(convId);
      console.log(kind === 'interrupted' ? `[stream] onderbroken gesprek ${convId} hervat` : `[stream] ${convId}: gaat vanzelf verder na zijn selfupdate (uitrol controleren)`);
    } catch (e) { console.error('[stream] resume interrupted failed:', e); }
  }
  return started;
}

/** The user's own question behind this answer (not an automatic resume), short, without the device context. */
async function lastQuestion(convId: string): Promise<string> {
  const r = await query<{ content: string }>(
    `SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user' AND (metadata->>'auto') IS NULL
       AND content NOT LIKE 'De backend is herstart%' AND content NOT LIKE 'Je werd net onderbroken%'
     ORDER BY created_at DESC LIMIT 1`, [convId]).catch(() => ({ rows: [] as Array<{ content: string }> }));
  let q = r.rows[0]?.content ?? '';
  if (q.startsWith('Op apparaat ')) q = q.includes('\n\n') ? q.slice(q.lastIndexOf('\n\n') + 2) : q.replace(/^Op apparaat [^:]*\):\s*/, '');
  q = q.replace(/\s+/g, ' ').trim();
  return q.length > 70 ? q.slice(0, 69).trimEnd() + '…' : q;
}

/** First sentence of the answer, as plain text. */
function firstSentence(text: string): string {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]+/g, '').replace(/\s+/g, ' ').trim();
  const m = plain.match(/^(.{20,160}?[.!?])(\s|$)/);
  const s = m ? m[1] : plain;
  return s.length > 140 ? s.slice(0, 139).trimEnd() + '…' : s;
}

/** Push for a finished answer: "Ik ben klaar met: <question>" plus the first sentence. Never throws. */
async function notifyAnswerReady(userId: string, convId: string, isSystemConv: boolean, text: string, failed = false): Promise<void> {
  try {
    const r = await query<{ title: string | null; on: boolean | null }>("SELECT title, (metadata->>'push_on')::boolean AS on FROM conversations WHERE id = $1", [convId]);
    if (!r.rows[0]?.on) return; // only conversations where the bell is switched on
    const q = await lastQuestion(convId);
    const lead = failed ? `Gestopt met een fout${q ? ` bij: ${q}` : ''}` : q ? `Ik ben klaar met: ${q}` : 'Ik ben klaar.';
    const first = firstSentence(text);
    await sendPushToUser(userId, {
      title: isSystemConv ? 'Admin-chat' : (r.rows[0]?.title || 'Claude'),
      body: first ? `${lead}\n${first}` : lead,
      url: isSystemConv ? '/settings/adminprompt' : `/chat/${convId}`,
      tag: `conv-${convId}`,
    }, { onlyAway: true });
  } catch (e) { console.error('[push] answer notification failed:', e); }
}

// Track active SSE clients per user — used to suppress push when app already open
const activeStreams = new Map<string, number>();
export function isUserActive(userId: string): boolean { return (activeStreams.get(userId) ?? 0) > 0; }
function addActive(userId: string) { activeStreams.set(userId, (activeStreams.get(userId) ?? 0) + 1); }
function removeActive(userId: string) {
  const n = (activeStreams.get(userId) ?? 1) - 1;
  if (n <= 0) activeStreams.delete(userId); else activeStreams.set(userId, n);
}

export const streamRouter = Router();
streamRouter.use(requireAuth);

const MAX_MESSAGE_LENGTH = 50_000;
const FLUSH_DEBOUNCE_MS = 1_000;

async function getConversation(convId: string, userId: string) {
  const result = await query<{
    id: string; model: string; metadata: Record<string, unknown>;
  }>(
    'SELECT id, model, metadata FROM conversations WHERE id = $1 AND user_id = $2 AND status != $3',
    [convId, userId, 'deleted'],
  );
  return result.rows[0] ?? null;
}

// Set up SSE response headers + a periodic keep-alive ping. Returns the timer
// so the caller can clear it on close. The keep-alive forces buffering proxies
// (Synology Application Portal, CDN, etc.) to flush response body to the client.
function startSse(res: Response): NodeJS.Timeout {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
    else clearInterval(keepAlive);
  }, 5000);
  return keepAlive;
}

// ────────────────────────────────────────────────────────────────────────────
// Shared start-or-join helper used by both GET and POST handlers.
//
// Preconditions (caller's responsibility):
//   - `userMessage` is non-empty and length-validated
//   - conversation has been fetched and ownership-checked
//   - auth status has been verified ('authenticated')
//
// Behaviour:
//   - If a task is already running for this conversation → SSE-subscribe only
//     (no INSERTs, no spawn). Closing the request unsubscribes but never
//     aborts the running task.
//   - Otherwise → INSERT user message, pre-create assistant placeholder,
//     load attachments, spawn `runConversationTask` in the background, and
//     SSE-subscribe.
// ────────────────────────────────────────────────────────────────────────────
async function startOrJoinStream(
  req: Request,
  res: Response,
  conv: { id: string; model: string; metadata: Record<string, unknown> },
  userMessage: string,
  attachmentIds: string[],
  /** Instructions for Claude in front of this message (device sessions), never stored as the user's text */
  promptPrefix?: string,
): Promise<void> {
  // ── Join an in-flight task if one exists for this conversation ──
  const existing = broker.getActiveTask(conv.id);
  if (existing) {
    addActive(req.user!.userId);
    const userActiveCleanup = () => removeActive(req.user!.userId);

    const keepAlive = startSse(res);
    const unsubscribe = broker.subscribe(conv.id, res, /* replayHistory */ true);

    let closed = false;
    req.on('close', () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
      userActiveCleanup();
      // NB: deliberately no abort — the task keeps running.
    });
    return;
  }

  // ── Fresh start: wire this requester first, so it receives every event of the run ──
  addActive(req.user!.userId);
  const userActiveCleanup = () => removeActive(req.user!.userId);

  const keepAlive = startSse(res);
  const unsubscribe = broker.subscribe(conv.id, res, /* replayHistory */ false);

  let closed = false;
  req.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
    userActiveCleanup();
    // Deliberately NOT aborting the task — it keeps running so other tabs
    // (and a future reconnect) still receive its output.
  });

  await startConversationRun({
    userId: req.user!.userId,
    role: req.user!.role,
    language: req.user!.language ?? 'nl',
    conv,
    userMessage,
    attachmentIds,
    push: true,
    promptPrefix,
  });
}

export interface StartRunOptions {
  userId: string;
  role: string;
  language: string;
  conv: { id: string; model: string; metadata: Record<string, unknown> };
  userMessage: string;
  attachmentIds: string[];
  /** Extra system prompt for this run (Telegram/WhatsApp chat style) */
  appendSystemPrompt?: string;
  /** Web runs: push when the answer is ready and no app window is on screen */
  push?: boolean;
  /** Instructions for Claude in front of the user's message; the stored message stays the user's own text */
  promptPrefix?: string;
  /** Sent by the app itself (e.g. continue after a restart): shown as a small notice, not as the user's bubble */
  auto?: 'resume' | 'limit' | 'task' | 'agent' | 'delegation';
}

/**
 * Start a Claude run for a conversation without any HTTP involved (web stream handlers and the
 * Telegram bot). Persists the user message and an assistant placeholder, then runs in the background.
 * Returns busy when a run is already active for this conversation.
 */
export async function startConversationRun(o: StartRunOptions): Promise<{ busy: true } | { busy: false; assistantMsgId: string }> {
  // Take the conversation's task slot synchronously, before any await: otherwise a web and a
  // Telegram start in the same moment both pass the check and the loser breaks the winner's stream.
  const abort = new AbortController();
  let cleanup: () => void;
  try {
    cleanup = broker.registerActiveTask(o.conv.id, () => abort.abort());
  } catch {
    return { busy: true };
  }
  try {
    return await prepareAndRun(o, { abort, cleanup });
  } catch (err) {
    cleanup();
    throw err;
  }
}

async function prepareAndRun(
  o: StartRunOptions,
  reserved: { abort: AbortController; cleanup: () => void },
): Promise<{ busy: false; assistantMsgId: string }> {
  const conv = o.conv;
  // the conversation goes on now: a resume planned after a usage limit is no longer needed
  if (o.auto !== 'limit') {
    try { const { cancelScheduledResume } = await import('../services/scheduler'); await cancelScheduledResume(conv.id); } catch { /* ignore */ }
  }
  const userMessage = o.userMessage;
  const attachmentIds = o.attachmentIds;
  const meta = conv.metadata as { claude_session_id?: string; isSystem?: boolean; delegated_privileged?: boolean; delegation_id?: string };
  const sessionId = meta.claude_session_id ?? null;

  // Admin system conversations run privileged (see runTask's privileged option), and so does the
  // workplace of a delegation that came from the admin chat (services/delegations.ts)
  const isSystemConv = (meta.isSystem === true || meta.delegated_privileged === true) && o.role === 'admin';

  // a workplace of a delegation: running (again), also after a limit or a restart
  if (meta.delegation_id) {
    try { const { onRunStarted } = await import('../services/delegations'); await onRunStarted(conv.id, conv.metadata); } catch { /* ignore */ }
  }
  // the user goes on in a conversation that delegated work: tell Claude what finished meanwhile
  let promptPrefix = o.promptPrefix;
  if (!o.auto) {
    try {
      const { reportForParent } = await import('../services/delegations');
      const report = await reportForParent(conv.id);
      if (report) promptPrefix = [report, promptPrefix].filter(Boolean).join('\n\n');
    } catch (e) { console.error('[stream] delegation report failed:', e); }
  }

  // Load ALL active connectors for this user (not just conversation-linked)
  const connResult = await query<{
    id: string; name: string; type: string; config: Record<string, unknown>; credentials_enc: string | null;
  }>(
    `SELECT id, name, type, config, credentials_enc
     FROM connectors
     WHERE user_id = $1 AND is_active = true`,
    [o.userId],
  );

  // connectors limited to chosen agents (config.agent_ids): only for the owner's main Claude and those agents
  {
    const { runAgentIds, connectorAllowed } = await import('../services/ninjaone');
    const runAgents = await runAgentIds(meta as Record<string, unknown>);
    connResult.rows = connResult.rows.filter(c => connectorAllowed(c.config ?? {}, runAgents));
  }

  const connectors: ConnectorConfig[] = connResult.rows.map(c => ({
    name: c.name,
    type: c.type as ConnectorConfig['type'],
    config: c.config,
    credentials: c.credentials_enc
      ? (() => { try { return JSON.parse(decrypt(c.credentials_enc!)) as Record<string, unknown>; } catch { return {}; } })()
      : {},
  }));
  // Microsoft 365: trade the stored refresh token for a fresh Graph access token for this run
  await Promise.all(connResult.rows.map(async (row, i) => {
    if (row.type !== 'm365' || !row.credentials_enc) return;
    try {
      connectors[i].credentials = { access_token: await graphAccessToken(o.userId, String(row.config.tenantId), row.credentials_enc) };
    } catch (err) {
      connectors[i].credentials = { error: (err as Error).message };
    }
  }));

  // Google Search Console: trade the stored refresh token for a fresh access token for this run
  await Promise.all(connResult.rows.map(async (row, i) => {
    if (row.type !== 'google-search-console' || !row.credentials_enc) return;
    try {
      const { accessTokenFor } = await import('../services/googleSearchConsole');
      connectors[i].credentials = { access_token: await accessTokenFor(row.credentials_enc) };
    } catch (err) {
      connectors[i].credentials = { error: (err as Error).message };
    }
  }));

  // NinjaOne: Claude gets a per-run proxy token, never the client secret
  await Promise.all(connResult.rows.map(async (row, i) => {
    if (row.type !== 'ninjaone') return;
    try {
      const { issueNinjaToken, ninjaBase } = await import('../services/ninjaone');
      connectors[i].credentials = { token: await issueNinjaToken(o.userId, row.id) };
      connectors[i].config = { ...row.config, base: ninjaBase(row.config) };
    } catch (err) {
      connectors[i].credentials = {};
      console.error('[stream] ninjaone token failed:', err);
    }
  }));

  // Telegram / WhatsApp as a pseudo-connector: a fresh per-run token, only for channels the user allows
  if (!isSystemConv) {
    try {
      const { issueClaudeToken } = await import('../services/messenger');
      const issued = await issueClaudeToken(o.userId);
      if (issued) connectors.push({ name: 'Telegram/WhatsApp', type: 'messenger', config: { channels: issued.channels, contacts: issued.contacts, recipientsPerHour: issued.recipientsPerHour, botName: issued.botName }, credentials: { token: issued.token } });
    } catch (err) {
      console.error('[stream] messenger token failed:', err);
    }
  }

  // Devices (Claude Agent) as a pseudo-connector: per-run token, only when there are devices.
  // Every chat, Telegram/WhatsApp and the admin chat: own devices only.
  {
    try {
      const { issueClaudeToken } = await import('../services/devices');
      const issued = await issueClaudeToken(o.userId);
      if (issued) connectors.push({ name: 'Apparaten', type: 'devices', config: { devices: issued.devices }, credentials: { token: issued.token } });
    } catch (err) {
      console.error('[stream] devices token failed:', err);
    }
  }

  // Shared lessons (what went wrong before and what works) for the connectors of this run,
  // plus a token so Claude can add one. Personal facts stay in the account's own memory.
  try {
    const { lessonsFor, issueLessonToken } = await import('../services/lessons');
    const { memoryCore, issueMemoryToken } = await import('../services/memory');
    const { getBudget } = await import('../services/contextBudget');
    const types = connectors.map((c) => c.type as string);
    // personal memory (database, per user) rides along: a small core here, the rest Claude searches
    connectors.push({ name: 'Gedeelde kennis', type: 'lessons',
      config: { lessons: await lessonsFor(types), memory: await memoryCore(o.userId), budgetTokens: await getBudget(o.userId) },
      credentials: { token: await issueLessonToken(o.userId), memoryToken: await issueMemoryToken(o.userId) } });
  } catch (err) {
    console.error('[stream] lessons failed:', err);
  }

  // Persist user message (only on a fresh start — not on join, handled above)
  // The message keeps its attachments, so the chat shows their thumbnails after a reload
  let msgAtts: Array<{ id: string; original_name: string; mime_type: string; size_bytes: number }> = [];
  if (attachmentIds.length > 0) {
    msgAtts = (await query<{ id: string; original_name: string; mime_type: string; size_bytes: number }>(
      'SELECT id, original_name, mime_type, size_bytes FROM conversation_attachments WHERE id = ANY($1) AND user_id = $2 AND conversation_id = $3',
      [attachmentIds, o.userId, conv.id])).rows;
  }
  await query(
    'INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, $2, $3, $4::jsonb)',
    [conv.id, 'user', userMessage, JSON.stringify({ ...(msgAtts.length ? { attachments: msgAtts } : {}), ...(o.auto ? { auto: o.auto } : {}) })],
  );

  // Live list: a new conversation gets a provisional title from the first message right away (the AI title
  // follows after the run), and every open client refreshes its preview line without a reload.
  {
    const convMeta = conv.metadata as { delegation_id?: string; isSystem?: boolean };
    const firstLine = userMessage.trim().replace(/\s+/g, ' ');
    let titled = false;
    if (!convMeta.delegation_id && !convMeta.isSystem && firstLine) {
      const provisional = firstLine.slice(0, 80) + (firstLine.length > 80 ? '…' : '');
      const r = await query(
        `UPDATE conversations SET title = $1 WHERE id = $2 AND (title IS NULL OR btrim(title) IN ('', 'Nieuw gesprek', 'New conversation')) RETURNING id`,
        [provisional, conv.id],
      ).catch(() => ({ rows: [] as unknown[] }));
      titled = r.rows.length > 0;
    }
    broadcastSse('conversation-update', { action: titled ? 'title' : 'message', userId: o.userId, conversationId: conv.id });
  }

  // A conversation imported from the laptop that now has a NAS turn must never be overwritten by a
  // later laptop sync. Marked before the run starts, so a failed or stopped run counts too.
  // (scripts/importHistory.ts also treats any non-laptop message as a NAS turn.)
  const laptopMeta = conv.metadata as { laptop_session_id?: string; continued_on_nas?: boolean };
  if (laptopMeta.laptop_session_id && !laptopMeta.continued_on_nas) {
    await query(
      `UPDATE conversations SET metadata = metadata || '{"continued_on_nas": true}'::jsonb WHERE id = $1`,
      [conv.id],
    ).catch((e) => console.error('[stream] Failed to mark continued_on_nas:', e));
  }

  // Pre-create the assistant message row with empty content + streaming flag.
  // We will UPDATE it incrementally as events arrive, so a refresh during the
  // stream still shows the partial text.
  const assistantInsert = await query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, content, metadata)
     VALUES ($1, 'assistant', '', $2::jsonb)
     RETURNING id`,
    [conv.id, JSON.stringify({ streaming: true })],
  );
  const assistantMsgId = assistantInsert.rows[0].id;
  broker.publish(conv.id, 'run_start', { userMessage, assistantMsgId });

  // Load conversation attachments (also for the admin chat; files are read by absolute path)
  const attachmentInfos: AttachmentInfo[] = [];
  if (attachmentIds.length > 0) {
    const attResult = await query<{ stored_name: string; mime_type: string; original_name: string }>(
      'SELECT stored_name, mime_type, original_name FROM conversation_attachments WHERE id = ANY($1) AND user_id = $2',
      [attachmentIds, o.userId]
    );
    await query('UPDATE conversation_attachments SET sent_at = now() WHERE id = ANY($1) AND user_id = $2 AND sent_at IS NULL',
      [attachmentIds, o.userId]).catch((e) => console.error('[attachments] mark sent failed:', e));
    const ws = getUserWorkspace(o.userId);
    for (const att of attResult.rows) {
      const isImage = att.mime_type.startsWith('image/');
      const filePath = join(ws, 'attachments', conv.id, att.stored_name);
      let textContent: string | undefined;
      if (!isImage) {
        try {
          const raw = readFileSync(filePath, 'utf-8');
          textContent = raw.length > 60000 ? raw.slice(0, 60000) + '\n[... afgekapt ...]' : raw;
        } catch { /* can't read */ }
      }
      attachmentInfos.push({ path: filePath, originalName: att.original_name, mimeType: att.mime_type, isImage, textContent });
    }
  }

  // Resolve effective model up front (used by runTask path)
  let effectiveModel = conv.model;
  if (!effectiveModel || effectiveModel === 'claude-opus-4-5') {
    const u = await query<{ default_model: string | null }>(
      'SELECT default_model FROM users WHERE id = $1',
      [o.userId],
    );
    effectiveModel = u.rows[0]?.default_model ?? 'sonnet';
  }

  // Chat in a project: runs in the shared project dir with the project's instructions
  let project: { id: string; name: string; instructions: string } | null = null;
  if (!isSystemConv) {
    try {
      const pr = await query<{ id: string; name: string; instructions: string }>(
        'SELECT p.id, p.name, p.instructions FROM projects p JOIN conversations c ON c.project_id = p.id WHERE c.id = $1 AND p.user_id = $2',
        [conv.id, o.userId]);
      project = pr.rows[0] ?? null;
    } catch (e) { console.error('[stream] project lookup failed:', (e as Error).message); }
  }

  // Kick the task off in the background; listeners follow it through the broker.
  void runConversationTask({
    project,
    userId: o.userId,
    language: o.language,
    conv,
    sessionId,
    isSystemConv,
    connectors,
    attachmentInfos,
    effectiveModel,
    userMessage,
    assistantMsgId,
    reserved,
    appendSystemPrompt: o.appendSystemPrompt,
    push: o.push,
    promptPrefix,
  });
  return { busy: false, assistantMsgId };
}

// SSE streaming via GET — used by EventSource clients and for subscribe-only
// (no `message` query param) reconnects. Long messages should use the POST
// variant below to avoid URL-length proxy limits.
streamRouter.get('/:id/stream', async (req: Request, res: Response, next) => {
  try {
    const conv = await getConversation(String(req.params.id), req.user!.userId);
    if (!conv) throw new AppError(404, 'Gesprek niet gevonden');

    const userMessage = (req.query.message as string | undefined) ?? '';

    // ── Pre-SSE validation: oversized messages get a clean 413 (NOT an SSE
    // error event), so the client can show a normal error UI.
    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      res.status(413).json({ error: 'Bericht te lang (max 50000 tekens)' });
      return;
    }

    // ─── SUBSCRIBE-ONLY MODE ────────────────────────────────────────────────
    // No `message` query param → this is a passive listener (e.g. a second
    // browser tab opened on the same conversation, or a refresh during a
    // stream). Attach to the broker, replay history, and bail. Closing this
    // request must NEVER abort the running task.
    if (!userMessage.trim()) {
      addActive(req.user!.userId);
      const userActiveCleanup = () => removeActive(req.user!.userId);

      const keepAlive = startSse(res);
      const unsubscribe = broker.subscribe(conv.id, res, /* replayHistory */ true);

      let closed = false;
      req.on('close', () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        userActiveCleanup();
        // NB: deliberately no abort — the task (if any) keeps running.
      });
      return;
    }

    // ─── START-OR-JOIN MODE ─────────────────────────────────────────────────
    const authStatus = await getAuthStatus(req.user!.userId);
    if (authStatus !== 'authenticated') {
      throw new AppError(422, 'Koppel eerst je Claude-account via Koppelingen → Claude Code.');
    }

    const attachmentIds = ((req.query.attachments as string) ?? '').split(',').filter(Boolean);
    await startOrJoinStream(req, res, conv, userMessage, attachmentIds);
  } catch (err) {
    if (!res.headersSent) {
      next(err);
    } else {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Stream fout' })}\n\n`);
      } catch { /* response already gone */ }
      try { res.end(); } catch { /* ignore */ }
    }
  }
});

// SSE streaming via POST — same start-or-join semantics as GET, but accepts
// the user message in a JSON body so long pastes (>~8KB) cannot hit nginx /
// Synology Application Portal URL-length limits. EventSource is GET-only, so
// the client consumes this with `fetch()` and reads `response.body` manually.
streamRouter.post('/:id/stream', async (req: Request, res: Response, next) => {
  try {
    // ── Body validation (mirrors GET's pre-flight checks) ──
    const body = (req.body ?? {}) as { message?: unknown; attachments?: unknown; context?: unknown };
    const userMessage = typeof body.message === 'string' ? body.message : '';
    const context = typeof body.context === 'string' ? body.context.trim().slice(0, 4000) : '';

    if (!userMessage.trim()) {
      res.status(400).json({ error: 'Bericht vereist' });
      return;
    }
    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      res.status(413).json({ error: 'Bericht te lang (max 50000 tekens)' });
      return;
    }

    const conv = await getConversation(String(req.params.id), req.user!.userId);
    if (!conv) throw new AppError(404, 'Gesprek niet gevonden');

    const authStatus = await getAuthStatus(req.user!.userId);
    if (authStatus !== 'authenticated') {
      throw new AppError(422, 'Koppel eerst je Claude-account via Koppelingen → Claude Code.');
    }

    // Normalise attachments: accept array of strings only; ignore other shapes.
    const attachmentIds: string[] = Array.isArray(body.attachments)
      ? body.attachments.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];

    await startOrJoinStream(req, res, conv, userMessage, attachmentIds, context || undefined);
  } catch (err) {
    if (!res.headersSent) {
      next(err);
    } else {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Stream fout' })}\n\n`);
      } catch { /* response already gone */ }
      try { res.end(); } catch { /* ignore */ }
    }
  }
});

// ── Queue: messages sent while Claude is busy ──
streamRouter.get('/:id/queue', async (req: Request, res: Response, next) => {
  try {
    const conv = await getConversation(String(req.params.id), req.user!.userId);
    if (!conv) throw new AppError(404, 'Gesprek niet gevonden');
    res.json({ items: await queue.listQueue(conv.id) });
  } catch (err) { next(err); }
});

streamRouter.post('/:id/queue', async (req: Request, res: Response, next) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message as string : '';
    if (!message.trim()) throw new AppError(400, 'Bericht vereist');
    if (message.length > MAX_MESSAGE_LENGTH) throw new AppError(413, 'Bericht te lang (max 50000 tekens)');
    const conv = await getConversation(String(req.params.id), req.user!.userId);
    if (!conv) throw new AppError(404, 'Gesprek niet gevonden');
    const attachmentIds: string[] = Array.isArray(req.body?.attachments)
      ? (req.body.attachments as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
    await queue.enqueue(conv.id, req.user!.userId, message, attachmentIds);
    // they wait with the message, not in the composer
    if (attachmentIds.length) await query('UPDATE conversation_attachments SET sent_at = now() WHERE id = ANY($1) AND user_id = $2', [attachmentIds, req.user!.userId]);
    stoppedByUser.delete(conv.id);
    await publishQueue(conv.id);
    await drainQueue(conv.id); // idle (it just finished): runs at once
    res.json({ items: await queue.listQueue(conv.id) });
  } catch (err) { next(err); }
});

streamRouter.delete('/:id/queue/:qid', async (req: Request, res: Response, next) => {
  try {
    const conv = await getConversation(String(req.params.id), req.user!.userId);
    if (!conv) throw new AppError(404, 'Gesprek niet gevonden');
    await queue.removeQueued(conv.id, String(req.params.qid));
    await publishQueue(conv.id);
    res.json({ items: await queue.listQueue(conv.id) });
  } catch (err) { next(err); }
});

// Send now: interrupt the current answer and run this message next
streamRouter.post('/:id/queue/:qid/now', async (req: Request, res: Response, next) => {
  try {
    const conv = await getConversation(String(req.params.id), req.user!.userId);
    if (!conv) throw new AppError(404, 'Gesprek niet gevonden');
    if (!await queue.moveToFront(conv.id, String(req.params.qid))) throw new AppError(404, 'Bericht staat niet meer in de wachtrij');
    stoppedByUser.delete(conv.id);
    const active = broker.getActiveTask(conv.id);
    if (active) { drainAfterAbort.add(conv.id); active.abort(); } else await drainQueue(conv.id);
    await publishQueue(conv.id);
    res.json({ items: await queue.listQueue(conv.id) });
  } catch (err) { next(err); }
});

// ── Stop endpoint: aborts the active task for this conversation ──
streamRouter.post('/:id/stream/stop', async (req: Request, res: Response, next) => {
  try {
    const conv = await getConversation(String(req.params.id), req.user!.userId);
    if (!conv) throw new AppError(404, 'Gesprek niet gevonden');
    const active = broker.getActiveTask(conv.id);
    if (active) { stoppedByUser.add(conv.id); active.abort(); }
    res.status(200).json({ stopped: !!active });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Background task runner — owns the AbortController and DB persistence.
// Decoupled from the HTTP request so closing the browser does NOT kill it.
// ────────────────────────────────────────────────────────────────────────────

interface RunArgs {
  userId: string;
  language: string;
  conv: { id: string; model: string; metadata: Record<string, unknown> };
  sessionId: string | null;
  project?: { id: string; name: string; instructions: string } | null;
  isSystemConv: boolean;
  connectors: ConnectorConfig[];
  attachmentInfos: AttachmentInfo[];
  effectiveModel: string;
  userMessage: string;
  assistantMsgId: string;
  /** Slot already taken by startConversationRun (so two starts cannot both run). */
  reserved?: { abort: AbortController; cleanup: () => void };
  appendSystemPrompt?: string;
  push?: boolean;
  promptPrefix?: string;
}

async function runConversationTask(args: RunArgs): Promise<void> {
  const { userId, language, conv, sessionId, isSystemConv, connectors, attachmentInfos, effectiveModel, userMessage, assistantMsgId } = args;

  const abort = args.reserved?.abort ?? new AbortController();
  let cleanupTask: (() => void) | null = args.reserved?.cleanup ?? null;
  try {
    if (!cleanupTask) cleanupTask = broker.registerActiveTask(conv.id, () => abort.abort());
  } catch (e) {
    // Should not happen — the GET handler checks getActiveTask before calling
    // this. If it does, surface and bail without running. Also clean up the
    // empty assistant placeholder row we inserted before invoking this fn,
    // so it does not stay orphaned with {streaming: true} forever.
    console.error('[stream] registerActiveTask failed:', e);
    try {
      await query(
        "DELETE FROM messages WHERE id = $1 AND content = ''",
        [assistantMsgId],
      );
    } catch (delErr) { console.error('[stream] orphan cleanup failed:', delErr); }
    broker.publish(conv.id, 'error', { message: 'Kon taak niet starten (al bezig?)' });
    broker.publish(conv.id, 'done', {});
    return;
  }

  // ── Accumulators for DB persistence + final summary ──
  let assistantText = '';
  const assistantEvents: Array<Record<string, unknown>> = [];
  let hasStructured = false;
  let limitHit = false;
  let limitResetAt: string | null = null;
  let limitHitAt = 0;
  let limitMessage = '';
  let doneCostUsd: number | undefined;
  let doneInputTokens = 0;
  let doneOutputTokens = 0;
  let doneCacheRead = 0;
  let doneCacheCreation = 0;

  // ── Debounced flush of assistant message to DB ──
  let flushTimer: NodeJS.Timeout | null = null;
  // Track the in-flight flush as a Promise so finalize can await it (with a
  // bounded timeout) instead of spinning on a busy-wait. `null` means idle.
  let currentFlushPromise: Promise<void> | null = null;
  let flushDirty = false; // set true if a new event arrived while a flush was running
  // Set true at the start of finalize. Both scheduleFlush and flushNow check
  // this at entry and return immediately, so any rescheduled flush that fires
  // AFTER finalize has cleared the timer (race window) becomes a no-op and
  // cannot revive `streaming: true` after the final UPDATE has cleared it.
  let finalized = false;

  // The stored copy of a tool call never keeps a literal password (sshpass -p, SSHPASS=, "wachtwoord is ...")
  const scrubToolInput = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubIfSecret(v);
    if (Array.isArray(v)) return v.map(scrubToolInput);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubToolInput(x)]));
    return v;
  };

  const computeContent = (): string =>
    hasStructured ? JSON.stringify(assistantEvents) : assistantText;

  const flushNow = async (): Promise<void> => {
    if (finalized) return; // post-finalize: no-op (Fix 3)
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (currentFlushPromise) { flushDirty = true; return; }
    const work = (async (): Promise<void> => {
      try {
        const content = computeContent();
        await query(
          `UPDATE messages SET content = $1, metadata = $2::jsonb WHERE id = $3`,
          [content, JSON.stringify({ streaming: true }), assistantMsgId],
        );
      } catch (e) {
        console.error('[stream] incremental flush failed:', e);
      } finally {
        currentFlushPromise = null;
        if (flushDirty && !finalized) {
          flushDirty = false;
          // Schedule another flush soon to pick up changes that arrived during the in-flight write.
          scheduleFlush();
        } else {
          flushDirty = false;
        }
      }
    })();
    currentFlushPromise = work;
    return work;
  };

  const scheduleFlush = (): void => {
    if (finalized) return; // post-finalize: no-op (Fix 3)
    if (flushTimer) return; // already scheduled
    flushTimer = setTimeout(() => { flushTimer = null; void flushNow(); }, FLUSH_DEBOUNCE_MS);
  };

  // A delegation card (services/delegations.ts) goes into this answer and is updated in place
  const injectDelegation = (ev: Record<string, unknown>): void => {
    hasStructured = true;
    const cur = assistantEvents.find((e) => e.type === 'delegation' && e.delegationId === ev.delegationId);
    const sid = broker.publish(conv.id, 'delegation', ev);
    if (cur) Object.assign(cur, ev); else assistantEvents.push({ ...ev, sid });
    void flushNow();
  };
  const unregisterLive = await import('../services/delegations')
    .then((m) => m.registerLiveRun(conv.id, { assistantMsgId, inject: injectDelegation }))
    .catch(() => () => { /* not available */ });

  const handleEvent = (ev: { type: string; [key: string]: unknown }): void => {
    switch (ev.type) {
      case 'thinking':
        hasStructured = true;
        assistantEvents.push({ type: 'thinking', thinking: ev.thinking, sid: broker.publish(conv.id, 'thinking', { thinking: ev.thinking }) });
        scheduleFlush();
        break;
      case 'text':
        // Claude Code's own limit line ("You've hit your limit · resets ..."): held back. When another
        // account takes over it is dropped; when all are full the app shows its own notice instead.
        if (typeof ev.text === 'string' && ev.text.length < 300 && /hit your .*limit|limit · resets/i.test(ev.text)) break;
        assistantText += ev.text as string;
        // sid: SSE id stored with the event, so a client seeding from the saved partial skips live duplicates
        assistantEvents.push({ type: 'text', text: ev.text, sid: broker.publish(conv.id, 'text', { text: ev.text }) });
        scheduleFlush();
        break;
      case 'tool_use':
        hasStructured = true;
        assistantEvents.push({ type: 'tool_use', toolName: ev.toolName, toolInput: scrubToolInput(ev.toolInput), toolUseId: ev.toolUseId,
          sid: broker.publish(conv.id, 'tool_use', { toolName: ev.toolName, toolInput: ev.toolInput, toolUseId: ev.toolUseId }) });
        // Flush immediately on tool boundary so a refresh shows accurate progress
        void flushNow();
        break;
      case 'tool_result':
        assistantEvents.push({ type: 'tool_result', toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError,
          sid: broker.publish(conv.id, 'tool_result', { toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }) });
        void flushNow();
        break;
      case 'agent_start': {
        hasStructured = true;
        // at: the real start of this bubble (for a SendMessage follow-up: the moment it continued), so the
        // "bezig" timer keeps running from there after a reload or a resubscribe instead of starting at 0
        const d: Record<string, unknown> = { toolUseId: ev.toolUseId, agentId: ev.agentId, agentName: ev.agentName, task: ev.task, at: new Date().toISOString() };
        if (ev.resumed === true) d.resumed = true;
        if (typeof ev.ccAgentId === 'string') d.ccAgentId = ev.ccAgentId;
        // t0, steps and errs: stats for /insights (Coach), not shown
        assistantEvents.push({ type: 'agent_start', ...d, sid: broker.publish(conv.id, 'agent_start', d), t0: new Date().toISOString() });
        void flushNow();
        // Claude resumed it itself: the planned automatic follow-up for this agent is no longer needed
        if (ev.resumed === true && typeof ev.ccAgentId === 'string') {
          const cc = ev.ccAgentId;
          void import('../services/scheduler').then((m) => m.dropAgentResume(conv.id, cc)).catch(() => { /* nothing planned */ });
        }
        break;
      }
      case 'agent_interrupted': {
        // An agent stopped by the usage limit: it finishes its task by itself at the reset time (or earlier
        // when an account has room again). The bubble shows "wacht" with that time; Verder stays as fallback.
        hasStructured = true;
        const auto = agentAutoResumeOn();
        const t = typeof ev.resetAt === 'string' ? Date.parse(ev.resetAt) : NaN;
        const resumeAt = new Date(Number.isFinite(t) && t > Date.now() ? t + 60_000 : Date.now() + 30 * 60_000);
        const d: Record<string, unknown> = { toolUseId: ev.toolUseId, agentId: ev.agentId, agentName: ev.agentName, ccAgentId: ev.ccAgentId, reason: ev.reason, at: new Date().toISOString(), ...(auto ? { resumeAt: resumeAt.toISOString() } : {}) };
        assistantEvents.push({ type: 'agent_interrupted', ...d, sid: broker.publish(conv.id, 'agent_interrupted', d) });
        void flushNow();
        if (auto && typeof ev.ccAgentId === 'string') {
          const a = { name: String(ev.agentName), ccAgentId: ev.ccAgentId, reason: 'limit' as const, since: Date.now() };
          void scheduleAgentResume({ userId, conversationId: conv.id, message: '', createdAt: Date.now(), agents: [a] }, resumeAt)
            .then(() => console.log(`[stream] ${a.name} (${a.ccAgentId}) hervat om ${resumeAt.toISOString()}`))
            .catch((e) => console.error('[stream] agent resume schedule failed:', e));
        }
        break;
      }
      case 'agent_meta': {
        // Claude Code's agentId for a bubble, stored so a later SendMessage (also in a next run) finds the agent
        const st = assistantEvents.find((e) => e.type === 'agent_start' && e.toolUseId === ev.toolUseId);
        if (st && typeof ev.ccAgentId === 'string' && !st.ccAgentId) { st.ccAgentId = ev.ccAgentId; void flushNow(); }
        break;
      }
      case 'agent_activity': {
        // live status only, not stored; only the number of tool steps is kept on the agent_start (stats)
        broker.publish(conv.id, 'agent_activity', { toolUseId: ev.toolUseId, toolName: ev.toolName, detail: ev.detail ?? '', at: Date.now() });
        if (ev.toolName !== 'text' && ev.toolName !== 'background') {
          const st = assistantEvents.find((e) => e.type === 'agent_start' && e.toolUseId === ev.toolUseId);
          if (st) st.steps = (Number(st.steps) || 0) + 1;
        }
        break;
      }
      case 'tool_error': {
        // stats only: mark the failed call (main run) or count it on the agent's bubble
        const st = ev.agentBubble
          ? assistantEvents.find((e) => e.type === 'agent_start' && e.toolUseId === ev.agentBubble)
          : assistantEvents.find((e) => e.type === 'tool_use' && e.toolUseId === ev.toolUseId);
        if (st && ev.agentBubble) st.errs = (Number(st.errs) || 0) + 1;
        else if (st) st.err = true;
        break;
      }
      case 'agent_result': {
        hasStructured = true;
        const d = { toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError };
        assistantEvents.push({ type: 'agent_result', ...d, sid: broker.publish(conv.id, 'agent_result', d), t1: new Date().toISOString() });
        void flushNow();
        break;
      }
      case 'rate_limited':
        limitHit = true;
        limitHitAt = Date.now();
        if (typeof ev.resetAt === 'string') limitResetAt = ev.resetAt;
        // not shown yet: the run may continue on another account (see the failover below)
        limitMessage = typeof ev.message === 'string' ? ev.message : '';
        break;
      case 'done':
        // Bookkeeping only — final 'done' SSE event is published explicitly below.
        doneCostUsd = ev.costUsd as number | undefined;
        doneInputTokens = (ev.inputTokens as number) ?? 0;
        doneOutputTokens = (ev.outputTokens as number) ?? 0;
        doneCacheRead = (ev.cacheReadTokens as number) ?? 0;
        doneCacheCreation = (ev.cacheCreationTokens as number) ?? 0;
        break;
      case 'error':
        // In-band error from Claude (the CLI emitted an `error` event but
        // didn't throw). Mark the run as failed BEFORE publishing so the
        // post-loop bookkeeping (token counting, auto-title, usage_logs
        // INSERT) is skipped — otherwise we'd record cost for a failed run.
        // The outer try/catch will NOT see this; runFailed is the only
        // signal here.
        // Stop or "send now" aborted the run on purpose: not an error, keep what was written so far
        if (abort.signal.aborted) break;
        runFailed = true;
        errorMessage = (ev.message as string) ?? 'Onbekende fout';
        broker.publish(conv.id, 'error', { message: ev.message });
        break;
    }
  };

  let newSessionId = sessionId ?? '';
  let runFailed = false;
  let errorMessage = '';

  // One Claude run. When the subscription runs out in the middle of an answer and another linked
  // subscription has room, the answer continues there once (same session, so nothing is lost).
  const SWITCH_NOTE = 'Ik doe even een snelle wissel naar mijn andere account: de tokens voor deze sessie zijn bijna op. Ik ga gewoon verder.';
  const CONTINUE_PROMPT = 'Je werd net onderbroken door een gebruikslimiet. Ga verder met mijn vorige vraag, precies waar je gebleven was.';
  const attempt = async (message: string, sid: string | null, first: boolean): Promise<string> => {
    const onEv = (ev: unknown) => handleEvent(ev as { type: string; [key: string]: unknown });
    const result = isSystemConv
      ? await runTask(userId, message, sid, onEv, abort.signal, connectors.filter(c => c.type === 'devices' || c.type === 'github' || c.type === 'lessons' || c.type === 'focustrack' || c.type === 'google-search-console' || c.type === 'ninjaone'), ensureAdminProjectWorkspace(userId, language ?? 'nl', !!(conv.metadata as { delegation_id?: string }).delegation_id),
          language, first ? attachmentInfos : [], effectiveModel, { privileged: true, conversationId: conv.id, werkplek: !!(conv.metadata as { delegation_id?: string }).delegation_id })
      : await runTask(userId, message, sid, onEv, abort.signal, connectors, undefined,
          language, first ? attachmentInfos : [], effectiveModel, { appendSystemPrompt: args.appendSystemPrompt, conversationId: conv.id, project: args.project });
    return result.sessionId;
  };
  /** Remove the limit notice of the interrupted attempt from the answer being built. */
  const dropLimitTraces = (): void => {
    for (let i = assistantEvents.length - 1; i >= 0; i--) {
      const e = assistantEvents[i];
      const t = typeof e.text === 'string' ? e.text : '';
      if (e.type === 'rate_limited' || (e.type === 'text' && t.length < 300 && isRateLimitText(t.toLowerCase()))) {
        assistantEvents.splice(i, 1);
        if (e.type === 'text') assistantText = assistantText.replace(t, '');
      }
    }
  };

  try {
    newSessionId = await attempt(args.promptPrefix ? `${args.promptPrefix}\n\n${userMessage}` : userMessage, sessionId, true);
    if (limitHit && !abort.signal.aborted && await hasRoomElsewhere(userId)) {
      limitHit = false;
      dropLimitTraces();
      // UI #26: a quiet line in the history ("Gewisseld om 14:05"); the live note comes from account_switch
      hasStructured = true;
      assistantEvents.push({ type: 'limit_note', kind: 'switched', at: new Date().toISOString() });
      broker.publish(conv.id, 'account_switch', { message: SWITCH_NOTE });
      accountEvents.emit('switch', conv.id, SWITCH_NOTE);
      newSessionId = await attempt(CONTINUE_PROMPT, newSessionId || sessionId, false) || newSessionId;
    }
  } catch (e) {
    runFailed = true;
    errorMessage = e instanceof Error ? e.message : 'Onbekende fout';
    broker.publish(conv.id, 'error', { message: errorMessage });
  }

  // Every subscription is full: resume by itself at the reset time (or earlier when an account
  // gets room again); the app shows the time with a cancel button. Works with the app closed too.
  if (limitHit && !abort.signal.aborted) {
    try {
      // continue as soon as the first of the linked accounts has room again, not only this one
      const first = await earliestRoom(userId).catch(() => null);
      const t = first ?? (limitResetAt ? Date.parse(limitResetAt) : NaN);
      const at = new Date(Number.isFinite(t) && t > Date.now() ? t + 60_000 : Date.now() + 30 * 60_000);
      // only now, with every account full, the notice appears (with the time it continues)
      hasStructured = true;
      // `at`: when the limit was hit, for the history line "Limiet bereikt om 14:02" (UI #26)
      assistantEvents.push({ type: 'rate_limited', resetAt: at.toISOString(), message: limitMessage, at: new Date(limitHitAt || Date.now()).toISOString() });
      broker.publish(conv.id, 'rate_limited', { resetAt: at.toISOString(), message: limitMessage });
      const { scheduleResume } = await import('../services/scheduler');
      await scheduleResume({ userId, conversationId: conv.id, message: CONTINUE_PROMPT, createdAt: Date.now() }, at);
      broker.publish(conv.id, 'resume_scheduled', { at: at.toISOString() });
    } catch (e) { console.error('[stream] auto-resume schedule failed:', e); }
  }

  // ── Final DB write for the assistant message ──
  // Order matters here:
  //   1. Set `finalized = true` FIRST. Any flushNow/scheduleFlush calls that
  //      land after this point (including a rescheduled flush queued by
  //      flushNow's finally{} during the wait below) will become no-ops.
  //      This prevents the race where a rescheduled flush fires after our
  //      final UPDATE and rewrites `streaming: true` (Fix 3).
  //   2. Clear any pending debounce timer.
  //   3. Await the in-flight flush (if any) with a 5s timeout — bounded so a
  //      stuck DB connection cannot wedge the conversation slot forever
  //      (Fix 2). On timeout we proceed; the final UPDATE below overwrites
  //      whatever the stuck flush would have written anyway.
  unregisterLive(); // a card update after this point waits for the final write (updateCard)
  finalized = true;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  // Snapshot via `as` cast: TypeScript's control-flow analysis narrows
  // `currentFlushPromise` to `null` at this point (closure assignments in
  // `flushNow` aren't tracked for outer-scope narrowing), but at runtime it
  // may still hold a pending Promise that scheduleFlush kicked off.
  const inFlight = currentFlushPromise as Promise<void> | null;
  if (inFlight) {
    let timedOut = false;
    const timeoutSentinel = new Promise<void>(resolve =>
      setTimeout(() => { timedOut = true; resolve(); }, 5000)
    );
    await Promise.race([inFlight.catch(() => { /* logged inside flushNow */ }), timeoutSentinel]);
    if (timedOut) {
      console.warn('[stream] in-flight flush exceeded 5s timeout during finalize; proceeding (final UPDATE will overwrite)');
    }
  }

  const finalContent = computeContent();
  if (runFailed) {
    try {
      await query(
        `UPDATE messages SET content = $1, metadata = $2::jsonb WHERE id = $3`,
        [finalContent, JSON.stringify({ streaming: false, error: errorMessage }), assistantMsgId],
      );
    } catch (e) { console.error('[stream] final (error) UPDATE failed:', e); }
  } else if (!finalContent && abort.signal.aborted) {
    // Stopped before anything was written: no empty bubble with only a time, also not after a reload
    try {
      await query(
        `DELETE FROM messages WHERE id = $1 AND COALESCE(content, '') = '' AND NOT (metadata ? 'tools')`,
        [assistantMsgId],
      );
    } catch (e) { console.error('[stream] remove empty stopped message failed:', e); }
  } else if (!finalContent) {
    // No content was produced — keep the row but clear the streaming flag so
    // DB state matches spec ("final UPDATE clears streaming flag"). The UI can
    // decide whether to render an empty assistant bubble.
    try {
      await query(
        "UPDATE messages SET content = '', metadata = metadata - 'streaming' WHERE id = $1",
        [assistantMsgId],
      );
    } catch (e) { console.error('[stream] final (empty) UPDATE failed:', e); }
  } else {
    try {
      await query(
        `UPDATE messages SET content = $1, metadata = metadata - 'streaming' WHERE id = $2`,
        [finalContent, assistantMsgId],
      );
    } catch (e) { console.error('[stream] final UPDATE failed:', e); }
  }

  // ── Bookkeeping (only on success path) ──
  if (!runFailed) {
    if (newSessionId && newSessionId !== sessionId) {
      await query(
        `UPDATE conversations SET metadata = metadata || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ claude_session_id: newSessionId }), conv.id],
      ).catch((e) => console.error('[stream] Failed to update session_id:', e));
    }

    // Auto-title on first exchange (skip system conversations and workplaces — they keep their fixed title)
    if (!isSystemConv && !(conv.metadata as { delegation_id?: string }).delegation_id) {
      try {
        const msgCount = await query('SELECT COUNT(*) FROM messages WHERE conversation_id = $1', [conv.id]);
        if (parseInt((msgCount.rows[0] as { count: string }).count, 10) <= 2) {
          const shortReply = (assistantText ?? '').slice(0, 300);
          generateTitle(userId, userMessage, shortReply, conv.id).catch(() => {
            const fallback = userMessage.slice(0, 80) + (userMessage.length > 80 ? '…' : '');
            void setConvTitle(userId, conv.id, fallback);
          });
        }
      } catch (e) { console.error('[stream] auto-title check failed:', e); }
    }

    await query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conv.id]).catch(() => {});
    broadcastSse('conversation-update', { action: 'message', userId, conversationId: conv.id });

    const totalTokens = doneInputTokens + doneOutputTokens;
    await query(
      `UPDATE conversations
       SET token_count = token_count + $1,
           cost_usd    = cost_usd + $2
       WHERE id = $3`,
      [totalTokens, doneCostUsd ?? 0, conv.id],
    ).catch(() => {});

    if (totalTokens > 0 || (doneCostUsd ?? 0) > 0) {
      await query(
        `INSERT INTO usage_logs (user_id, conversation_id, action, input_tokens, output_tokens, cost_usd, metadata)
         VALUES ($1, $2, 'chat', $3, $4, $5, $6::jsonb)`,
        [userId, conv.id, doneInputTokens, doneOutputTokens, doneCostUsd ?? 0,
          JSON.stringify({ cache_read: doneCacheRead, cache_creation: doneCacheCreation, delegation: !!(conv.metadata as { delegation_id?: string }).delegation_id })],
      ).catch((e) => console.error('[stream] Failed to insert usage_log:', e));
    }
  }

  // Stopped, limit or failed run: the tokens were spent but no 'done' event came. Log an estimate (chars / 4).
  if ((runFailed || limitHit || abort.signal.aborted) && doneInputTokens + doneOutputTokens === 0) {
    const est = Math.ceil((assistantText ?? '').length / 4);
    const reason = runFailed ? 'error' : limitHit ? 'limit' : 'aborted';
    await query(
      `INSERT INTO usage_logs (user_id, conversation_id, action, input_tokens, output_tokens, cost_usd, metadata)
       VALUES ($1, $2, 'chat-partial', 0, $3, 0, $4::jsonb)`,
      [userId, conv.id, est, JSON.stringify({ estimated: true, reason })],
    ).catch((e) => console.error('[stream] Failed to insert partial usage_log:', e));
  }

  // Always publish a final 'done' so subscribers know to stop spinning.
  broker.publish(conv.id, 'done', { costUsd: doneCostUsd, inputTokens: doneInputTokens, outputTokens: doneOutputTokens });

  // A scheduled task's run: summary, push and the "Uitvoeren" action (services/tasks.ts). Never throws.
  void import('../services/tasks').then((t) => t.onRunFinished({
    convId: conv.id, userId, assistantMsgId, userMessage, failed: runFailed, limitHit, aborted: abort.signal.aborted, error: runFailed ? errorMessage : '',
  })).catch((e) => console.error('[tasks] finish hook failed:', e));
  // The workplace of a delegation: status, summary, push and the card in the parent. Never throws.
  if ((conv.metadata as { delegation_id?: string }).delegation_id) {
    void import('../services/delegations').then((m) => m.onRunFinished({
      convId: conv.id, userId, assistantMsgId, failed: runFailed, limitHit, aborted: abort.signal.aborted, error: runFailed ? errorMessage : '',
    })).catch((e) => console.error('[delegations] finish hook failed:', e));
  }

  if (args.push && !abort.signal.aborted) {
    void notifyAnswerReady(userId, conv.id, isSystemConv, runFailed ? errorMessage : assistantText, runFailed);
  }

  // Release the active-task slot AFTER the final 'done' so it ends up in the
  // history buffer and lingers for late subscribers. endActiveTask both
  // deletes the activeTasks entry AND moves history into lingeringHistories
  // for HISTORY_TTL_MS — so it MUST run before cleanupTask (which would
  // otherwise delete the entry first and cause endActiveTask to early-exit,
  // breaking the 30s replay window for late subscribers).
  broker.endActiveTask(conv.id);
  if (cleanupTask) cleanupTask(); // idempotent no-op now; safety net only.

  // Next queued message. Not after Stop, a failure or a hit limit (it would fail the same way).
  const forced = drainAfterAbort.delete(conv.id);
  const stopped = stoppedByUser.delete(conv.id);
  if (forced || (!stopped && !runFailed && !limitHit)) void drainQueue(conv.id);
}

// ── Generate a short AI title for a conversation ────────────
// Title is set after the run is done; tell open clients so the list and header stop showing "Nieuw gesprek".
async function setConvTitle(userId: string, convId: string, title: string): Promise<void> {
  try {
    await query('UPDATE conversations SET title = $1 WHERE id = $2', [title, convId]);
    broadcastSse('conversation-update', { action: 'title', userId, conversationId: convId });
  } catch (e) { console.error('[stream] set title failed:', e); }
}

async function generateTitle(userId: string, userMsg: string, assistantMsg: string, convId: string): Promise<void> {
  const homeDir = getUserHomeDir(userId);
  const token = await getValidAccessToken(homeDir);
  if (!token) {
    // No token — use fallback
    const fallback = userMsg.slice(0, 80) + (userMsg.length > 80 ? '…' : '');
    await setConvTitle(userId, convId, fallback);
    return;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 40,
      messages: [
        {
          role: 'user',
          content: `Genereer een korte titel (max 6 woorden, geen aanhalingstekens) voor dit gesprek:\n\nGebruiker: ${userMsg.slice(0, 200)}\nAssistent: ${assistantMsg.slice(0, 200)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Title API: ${res.status}`);
  const body = await res.json() as { content?: Array<{ text?: string }> };
  const title = (body.content?.[0]?.text ?? '').trim().replace(/^["']|["']$/g, '').slice(0, 100);

  if (title) {
    await setConvTitle(userId, convId, title);
  } else {
    const fallback = userMsg.slice(0, 80) + (userMsg.length > 80 ? '…' : '');
    await setConvTitle(userId, convId, fallback);
  }
}
