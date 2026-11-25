import { query } from '../db';
import { randomBytes } from 'crypto';
import { broadcastSse } from './sseEvents';
import { redis } from '../redis';

/**
 * Shared projects: no owner. All members are equal (projects.user_id is the technical anchor of the first creator and gives no extra rights;
 * when he leaves it moves to another member, see leaveProject). Every access check goes through here, so rights have one place.
 */
export async function ensureSharedProjectSchema(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS project_members (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, user_id)
  )`);
  await query('CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)');
  // the creator is the first member (also see database/migrations/012); projects.user_id stays the technical anchor
  await query('INSERT INTO project_members (project_id, user_id) SELECT id, user_id FROM projects ON CONFLICT DO NOTHING');
  await query(`CREATE TABLE IF NOT EXISTS project_connectors (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, connector_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS conversation_reads (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
  )`);
  await query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL');
  await query('CREATE SEQUENCE IF NOT EXISTS project_gid_seq START 30000 MINVALUE 30000');
  await query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS gid INTEGER');
  // group chat: colour per participant, agents per project, project memory (see database/migrations/012_shared_project_groups.sql)
  await query('ALTER TABLE project_members ADD COLUMN IF NOT EXISTS color TEXT');
  await query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_color TEXT');
  await query('CREATE UNIQUE INDEX IF NOT EXISTS project_members_color_idx ON project_members (project_id, color) WHERE color IS NOT NULL');
  await query(`CREATE TABLE IF NOT EXISTS project_agents (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    account_mode TEXT NOT NULL DEFAULT 'user' CHECK (account_mode IN ('user','owner')),
    fallback BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (project_id, agent_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS project_agent_users (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, agent_id, user_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS project_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT 'algemeen',
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,
    added_via TEXT NOT NULL DEFAULT 'person',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query('CREATE INDEX IF NOT EXISTS project_memory_project_idx ON project_memory (project_id)');
  // no owner: history of changes, who added an agent or connector, sync state of geheugen.md (database/migrations/013_project_events.sql)
  await query(`CREATE TABLE IF NOT EXISTS project_events (
    id BIGSERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query('CREATE INDEX IF NOT EXISTS project_events_project_idx ON project_events (project_id, id DESC)');
  await query('ALTER TABLE project_agents ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES users(id) ON DELETE SET NULL');
  await query('ALTER TABLE project_connectors ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES users(id) ON DELETE SET NULL');
  await query(`CREATE TABLE IF NOT EXISTS project_memory_sync (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    file_hash TEXT NOT NULL,
    db_hash TEXT NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

// ── Colours of the participants (8 fixed, unique per project, more than 8: generated) ──
export const MEMBER_PALETTE = ['#A78BFA', '#F472B6', '#FBBF24', '#22D3EE', '#FB7185', '#F59E6B', '#C8A27A', '#60A5FA'];

function hslHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function nextColor(used: Set<string>): string {
  const free = MEMBER_PALETTE.find((c) => !used.has(c));
  if (free) return free;
  for (let i = used.size; i < used.size + 400; i++) { // golden angle: spread hues, never kiesbaar; hue 90-175 is green (own bubble) and skipped
    const h = (i * 137.508) % 360;
    if (h >= 90 && h <= 175) continue;
    const c = hslHex(h, 70, 66);
    if (!used.has(c)) return c;
  }
  return '#94A3B8';
}

/** Give everyone without a colour the first free one (owner first, then by join date). */
export async function ensureColors(projectId: string): Promise<void> {
  const own = (await query<{ owner_color: string | null }>('SELECT owner_color FROM projects WHERE id = $1', [projectId])).rows[0];
  const mem = (await query<{ user_id: string; color: string | null }>('SELECT user_id, color FROM project_members WHERE project_id = $1 ORDER BY created_at', [projectId])).rows;
  if (own?.owner_color && mem.every((m) => m.color)) return;
  const used = new Set<string>([own?.owner_color, ...mem.map((m) => m.color)].filter(Boolean) as string[]);
  if (own && !own.owner_color) { const c = nextColor(used); used.add(c); await query('UPDATE projects SET owner_color = $2 WHERE id = $1', [projectId, c]); }
  const ownerNow = (await query<{ owner_color: string | null; user_id: string }>('SELECT owner_color, user_id FROM projects WHERE id = $1', [projectId])).rows[0];
  for (const m of mem.filter((x) => !x.color)) {
    if (ownerNow && m.user_id === ownerNow.user_id) { // the creator also has a member row: same colour as owner_color
      if (ownerNow.owner_color) await query('UPDATE project_members SET color = $3 WHERE project_id = $1 AND user_id = $2', [projectId, m.user_id, ownerNow.owner_color]).catch(() => undefined);
      continue;
    }
    const c = nextColor(used); used.add(c);
    await query('UPDATE project_members SET color = $3 WHERE project_id = $1 AND user_id = $2', [projectId, m.user_id, c]).catch(() => { /* race: next call retries */ });
  }
}

/** Choose a colour from the palette that nobody else in the project has. */
export async function setMemberColor(projectId: string, userId: string, color: string): Promise<void> {
  if (!MEMBER_PALETTE.includes(color)) throw new Error('Onbekende kleur');
  await ensureColors(projectId);
  const taken = await query(
    `SELECT 1 FROM project_members WHERE project_id = $1 AND color = $2 AND user_id <> $3
     UNION ALL SELECT 1 FROM projects WHERE id = $1 AND owner_color = $2 AND user_id <> $3`, [projectId, color, userId]);
  if (taken.rowCount) throw new Error('Kleur is al in gebruik');
  const isOwner = (await query('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId])).rowCount;
  if (isOwner) {
    await query('UPDATE project_members SET color = NULL WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    await query('UPDATE projects SET owner_color = $2 WHERE id = $1', [projectId, color]);
    await query('UPDATE project_members SET color = $3 WHERE project_id = $1 AND user_id = $2', [projectId, userId, color]);
  } else await query('UPDATE project_members SET color = $3 WHERE project_id = $1 AND user_id = $2', [projectId, userId, color]);
}

export interface ConvAccess { conversationId: string; ownerId: string; projectId: string | null; projectOwnerId: string | null; shared: boolean }

/** Rights on a conversation: own loose chat, or any chat of a project the user owns or is a member of. null = no access. */
export async function convAccess(convId: string, userId: string): Promise<ConvAccess | null> {
  const r = await query<{ id: string; user_id: string; project_id: string | null; powner: string | null; members: number; gid: number | null }>(
    `SELECT c.id, c.user_id, c.project_id, p.user_id AS powner, p.gid,
            (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id <> p.user_id) AS members
     FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
     WHERE c.id = $1 AND c.status != 'deleted'
       AND ((c.project_id IS NULL AND c.user_id = $2)
         OR p.user_id = $2
         OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = c.project_id AND pm.user_id = $2))`,
    [convId, userId]);
  const x = r.rows[0];
  if (!x) return null;
  return { conversationId: x.id, ownerId: x.user_id, projectId: x.project_id, projectOwnerId: x.powner, shared: (x.members ?? 0) > 0 || x.gid != null };
}

export interface ProjectAccess { id: string; name: string; instructions: string; ownerId: string; gid: number | null; shared: boolean; isOwner: boolean }

/** The project when the user is owner or member. */
export async function projectAccess(projectId: string, userId: string): Promise<ProjectAccess | null> {
  const r = await query<{ id: string; name: string; instructions: string; user_id: string; gid: number | null; members: number }>(
    `SELECT p.id, p.name, p.instructions, p.user_id, p.gid,
            (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id <> p.user_id) AS members
     FROM projects p
     WHERE p.id = $1 AND (p.user_id = $2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2))`,
    [projectId, userId]);
  const p = r.rows[0];
  if (!p) return null;
  return { id: p.id, name: p.name, instructions: p.instructions, ownerId: p.user_id, gid: p.gid, shared: p.members > 0 || p.gid != null, isOwner: p.user_id === userId };
}

export interface MemberInfo { id: string; name: string; avatar: string | null; is_owner: boolean; color: string | null }

export async function projectMembers(projectId: string): Promise<MemberInfo[]> {
  const sel = () => query<MemberInfo>(
    `SELECT u.id, COALESCE(u.name, u.email) AS name, u.avatar, false AS is_owner, p.owner_color AS color FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = $1
     UNION ALL
     SELECT u.id, COALESCE(u.name, u.email), u.avatar, false, pm.color FROM project_members pm JOIN users u ON u.id = pm.user_id JOIN projects p ON p.id = pm.project_id WHERE pm.project_id = $1 AND u.is_active AND pm.user_id <> p.user_id
     ORDER BY 2`, [projectId]);
  let rows = (await sel()).rows;
  if (rows.length > 1 && rows.some((m) => !m.color)) {
    try { await ensureColors(projectId); rows = (await sel()).rows; } catch (e) { console.error('[shared] colours failed:', (e as Error).message); }
  }
  return rows;
}

export async function projectMemberIds(projectId: string): Promise<string[]> {
  return (await projectMembers(projectId)).map((m) => m.id);
}

/** Project gid for the shared dir (group permissions), allocated on first share. */
export async function ensureProjectGid(projectId: string): Promise<number> {
  const r = await query<{ gid: number }>(
    `UPDATE projects SET gid = COALESCE(gid, nextval('project_gid_seq')) WHERE id = $1 RETURNING gid`, [projectId]);
  return r.rows[0].gid;
}

/** Tell the open apps of every member (the client filters on memberIds). */
export async function notifyMembers(projectId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    broadcastSse('conversation-update', { ...payload, projectId, memberIds: await projectMemberIds(projectId) });
  } catch (e) { console.error('[shared] notify failed:', (e as Error).message); }
}

// ── Agents per project: every member may add agents, set who uses them and the account ──
export interface ProjectAgentRow {
  id: string; name: string; avatar: string | null; color: string | null; description: string;
  owner_id: string; owner_name: string; in_project: boolean; account_mode: 'user' | 'owner'; fallback: boolean; user_ids: string[];
}

/**
 * Agents of the actor plus the ones already in the project (added by others), with their state in this project.
 * account_mode 'owner' = the account of the member who added the agent (owner_id/owner_name are that member); fallback = the asker's account.
 */
export async function projectAgentRows(projectId: string, actorId: string): Promise<ProjectAgentRow[]> {
  const { listAgents } = await import('./agents');
  const list = (await listAgents(actorId)).filter((a) => a.is_active);
  const pa = (await query<{ agent_id: string; enabled: boolean; account_mode: 'user' | 'owner'; fallback: boolean; added_by: string | null }>(
    'SELECT agent_id, enabled, account_mode, fallback, added_by FROM project_agents WHERE project_id = $1', [projectId])).rows;
  const us = (await query<{ agent_id: string; user_id: string }>('SELECT agent_id, user_id FROM project_agent_users WHERE project_id = $1', [projectId])).rows;
  const have = new Set(list.map((a) => a.id));
  const extra = (await query<{ id: string; name: string; avatar: string | null; color: string | null; description: string; user_id: string }>(
    `SELECT a.id, a.name, a.avatar, a.color, a.description, a.user_id FROM agents a WHERE a.id = ANY($1::uuid[]) AND a.is_active`,
    [pa.filter((x) => x.enabled && !have.has(x.agent_id)).map((x) => x.agent_id)])).rows;
  const all = [...list.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar ?? null, color: a.color ?? null, description: a.description, owner_id: a.owner_id, sa: 'user' as const, sf: true })),
    ...extra.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, color: a.color, description: a.description, owner_id: a.user_id, sa: 'user' as const, sf: true }))];
  const holder = (a: { id: string; owner_id: string }) => pa.find((x) => x.agent_id === a.id)?.added_by ?? a.owner_id;
  const names = new Map((await query<{ id: string; n: string }>('SELECT id, COALESCE(name, email) AS n FROM users WHERE id = ANY($1::uuid[])', [[...new Set(all.map(holder))]])).rows.map((u) => [u.id, u.n]));
  return all.map((a) => {
    const row = pa.find((x) => x.agent_id === a.id);
    const h = holder(a);
    return { id: a.id, name: a.name, avatar: a.avatar, color: a.color, description: a.description, owner_id: h, owner_name: names.get(h) ?? '',
      in_project: !!row?.enabled, account_mode: row?.account_mode ?? a.sa, fallback: row?.fallback ?? a.sf,
      user_ids: us.filter((u) => u.agent_id === a.id).map((u) => u.user_id) };
  });
}

/** Agent ids the asker may use in this project (in the project and allowed for him). */
export async function allowedAgentIds(projectId: string, userId: string): Promise<string[]> {
  const r = await query<{ agent_id: string }>(
    `SELECT pa.agent_id FROM project_agents pa JOIN agents a ON a.id = pa.agent_id AND a.is_active
     WHERE pa.project_id = $1 AND pa.enabled AND EXISTS (SELECT 1 FROM project_agent_users pu WHERE pu.project_id = pa.project_id AND pu.agent_id = pa.agent_id AND pu.user_id = $2)`,
    [projectId, userId]);
  return r.rows.map((x) => x.agent_id);
}

export interface ProjectAgentSet { agentId: string; inProject: boolean; userIds: string[]; accountMode?: 'user' | 'owner'; fallback?: boolean }

/** Any member: which agents are in, who may use them and the account. The first to add an agent is the one whose account 'owner' means. */
export async function setProjectAgent(projectId: string, actorId: string, s: ProjectAgentSet): Promise<{ name: string; was: boolean }> {
  const rows = await projectAgentRows(projectId, actorId);
  const agent = rows.find((a) => a.id === s.agentId);
  if (!agent) throw new Error('Agent niet beschikbaar');
  const members = new Set((await projectMembers(projectId)).map((m) => m.id));
  const users = [...new Set(s.userIds)].filter((u) => members.has(u));
  await query(
    `INSERT INTO project_agents (project_id, agent_id, enabled, account_mode, fallback, added_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (project_id, agent_id) DO UPDATE SET enabled = $3,
       account_mode = CASE WHEN $7 THEN $4 ELSE project_agents.account_mode END, fallback = CASE WHEN $7 THEN $5 ELSE project_agents.fallback END,
       added_by = CASE WHEN $3 AND (NOT project_agents.enabled OR project_agents.added_by IS NULL) THEN $6 ELSE project_agents.added_by END`,
    [projectId, s.agentId, s.inProject, s.accountMode ?? agent.account_mode, s.fallback ?? agent.fallback, actorId, s.accountMode !== undefined]);
  await query('DELETE FROM project_agent_users WHERE project_id = $1 AND agent_id = $2', [projectId, s.agentId]);
  if (s.inProject) for (const u of users) await query('INSERT INTO project_agent_users (project_id, agent_id, user_id) VALUES ($1,$2,$3)', [projectId, s.agentId, u]);
  return { name: agent.name, was: agent.in_project };
}

/** A new member may use the agents that are in the project (everyone can narrow that down). */
export async function grantAgentsToMember(projectId: string, userId: string): Promise<void> {
  await query(`INSERT INTO project_agent_users (project_id, agent_id, user_id)
    SELECT project_id, agent_id, $2 FROM project_agents WHERE project_id = $1 AND enabled ON CONFLICT DO NOTHING`, [projectId, userId]);
}

/** Agents of this run as full rows for the --agents file; the knowledge of an agent stays with the member who owns it. */
export async function projectRunAgents(projectId: string, userId: string): Promise<import('./agents').Agent[]> {
  const ids = await allowedAgentIds(projectId, userId);
  if (!ids.length) return [];
  const r = await query<import('./agents').Agent>(
    `SELECT a.id, a.name, a.slug, a.description, a.prompt, a.model, a.avatar, a.color, a.created_at, a.visibility,
            a.share_users::text[] AS share_users, a.share_groups::text[] AS share_groups, a.user_id AS owner_id, TRUE AS is_active,
            CASE WHEN a.user_id = $2 THEN a.knowledge END AS knowledge, '{}'::text[] AS connector_ids
     FROM agents a WHERE a.id = ANY($1::uuid[]) ORDER BY a.created_at`, [ids, userId]);
  return r.rows;
}

/**
 * Account for a run in which a project agent was addressed (@name): when the agent is set to 'the account of the member who added it'
 * that member's account (only while he is still a member), else null = the asker's own account.
 */
export async function projectAgentAccount(projectId: string, userId: string, message: string): Promise<{ ownerId: string; slots: number[] | null; fallback: boolean; agentId: string; agentName: string } | null> {
  const r = await query<{ agent_id: string; name: string; holder: string; slots: number[] | null; fallback: boolean }>(
    `SELECT pa.agent_id, a.name, pa.added_by AS holder, a.account_slots AS slots, pa.fallback
     FROM project_agents pa JOIN agents a ON a.id = pa.agent_id
     WHERE pa.project_id = $1 AND pa.enabled AND pa.account_mode = 'owner' AND pa.added_by IS NOT NULL AND pa.added_by <> $2
       AND (EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pa.project_id AND pm.user_id = pa.added_by)
         OR EXISTS (SELECT 1 FROM projects p WHERE p.id = pa.project_id AND p.user_id = pa.added_by))`, [projectId, userId]);
  const low = message.toLowerCase();
  const allowed = r.rows.length ? await allowedAgentIds(projectId, userId) : [];
  for (const x of r.rows) {
    if (!allowed.includes(x.agent_id)) continue;
    if (low.includes('@' + x.name.toLowerCase())) return { ownerId: x.holder, slots: x.slots?.length ? x.slots : null, fallback: x.fallback, agentId: x.agent_id, agentName: x.name };
  }
  return null;
}

// ── History of changes per project: who, what, when ──
export interface ProjectEventRow { id: string; user_id: string | null; user_name: string | null; user_avatar: string | null; action: string; target: string | null; details: Record<string, unknown>; created_at: string }

export async function logProjectEvent(projectId: string, userId: string | null, action: string, target?: string | null, details: Record<string, unknown> = {}): Promise<void> {
  try {
    await query('INSERT INTO project_events (project_id, user_id, action, target, details) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [projectId, userId, action, target ? target.slice(0, 200) : null, JSON.stringify(details)]);
  } catch (e) { console.error('[shared] event failed:', (e as Error).message); }
}

export async function listProjectEvents(projectId: string, before?: number, limit = 30): Promise<{ events: ProjectEventRow[]; next: string | null }> {
  const lim = Math.min(Math.max(limit, 1), 100);
  const r = await query<ProjectEventRow>(
    `SELECT e.id::text, e.user_id, COALESCE(u.name, u.email) AS user_name, CASE WHEN length(u.avatar) < 60000 THEN u.avatar END AS user_avatar, e.action, e.target, e.details, e.created_at
     FROM project_events e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.project_id = $1 AND ($2::bigint IS NULL OR e.id < $2) ORDER BY e.id DESC LIMIT $3`, [projectId, before ?? null, lim + 1]);
  const rows = r.rows.slice(0, lim);
  return { events: rows, next: r.rows.length > lim ? rows[rows.length - 1].id : null };
}

/**
 * A member leaves (or is removed). Never the last one. His agents and connectors in the project go with him (his credentials stay private).
 * The technical anchor projects.user_id moves to another member when the creator leaves; nobody gets extra rights from it.
 */
export async function leaveProject(projectId: string, targetId: string): Promise<void> {
  const members = await projectMembers(projectId);
  if (!members.some((m) => m.id === targetId)) throw new Error('Geen lid');
  if (members.length <= 1) throw new Error('Je bent het laatste lid: een project zonder leden kan niet. Verwijder het project als je het niet meer nodig hebt.');
  const own = (await query<{ user_id: string }>('SELECT user_id FROM projects WHERE id = $1', [projectId])).rows[0];
  if (own?.user_id === targetId) {
    const next = (await query<{ user_id: string; color: string | null }>('SELECT pm.user_id, pm.color FROM project_members pm JOIN users u ON u.id = pm.user_id AND u.is_active WHERE pm.project_id = $1 AND pm.user_id <> $2 ORDER BY pm.created_at LIMIT 1', [projectId, targetId])).rows[0];
    if (!next) throw new Error('Geen ander lid om het project aan over te dragen');
    await query('UPDATE projects SET user_id = $2, owner_color = $3, updated_at = now() WHERE id = $1', [projectId, next.user_id, next.color]);
  }
  await query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, targetId]);
  await query('DELETE FROM project_agent_users WHERE project_id = $1 AND user_id = $2', [projectId, targetId]);
  await query('DELETE FROM project_agents WHERE project_id = $1 AND added_by = $2', [projectId, targetId]);
  await query('DELETE FROM project_connectors WHERE project_id = $1 AND connector_id IN (SELECT id FROM connectors WHERE user_id = $2)', [projectId, targetId]);
  await query('DELETE FROM message_queue WHERE user_id = $2 AND conversation_id IN (SELECT id FROM conversations WHERE project_id = $1)', [projectId, targetId]);
}

// ── Project memory: in the database, editable by all members; a project run gets only this ──
export interface ProjectMemoryRow { id: string; content: string; topic: string; pinned: boolean; added_by: string | null; added_by_name: string | null; added_via: string; source_conversation_id: string | null; updated_at: string }
const normTopic = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9à-ü_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'algemeen';
const MCOLS = `m.id, m.content, m.topic, m.pinned, m.added_by, COALESCE(u.name, u.email) AS added_by_name, m.added_via, m.source_conversation_id, m.updated_at`;

/** geheugen.md in the project dir follows every change in the database (services/projectMemoryFile.ts). */
function fileSync(projectId: string): void {
  void import('./projectMemoryFile').then((m) => m.syncProjectMemory(projectId)).catch((e) => console.error('[memory-file] sync failed:', (e as Error).message));
}

export async function listProjectMemory(projectId: string, q = '', limit = 200): Promise<ProjectMemoryRow[]> {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 12) ?? [];
  const where = words.length ? 'AND (' + words.map((_, i) => `(lower(m.content) LIKE $${i + 3} OR m.topic LIKE $${i + 3})`).join(' OR ') + ')' : '';
  return (await query<ProjectMemoryRow>(
    `SELECT ${MCOLS} FROM project_memory m LEFT JOIN users u ON u.id = m.added_by WHERE m.project_id = $1 ${where}
     ORDER BY m.pinned DESC, m.updated_at DESC LIMIT $2`, [projectId, limit, ...words.map((w) => `%${w}%`)])).rows;
}

export async function addProjectMemory(projectId: string, b: { content: string; topic?: string; pinned?: boolean }, by: { userId: string; via: 'person' | 'claude'; conversationId?: string | null }): Promise<string> {
  const dup = await query<{ id: string }>('SELECT id FROM project_memory WHERE project_id = $1 AND lower(content) = lower($2)', [projectId, b.content]);
  if (dup.rows[0]) return dup.rows[0].id;
  const r = await query<{ id: string }>(
    `INSERT INTO project_memory (project_id, content, topic, pinned, added_by, added_via, source_conversation_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [projectId, b.content, normTopic(b.topic ?? 'algemeen'), !!b.pinned, by.userId, by.via, by.conversationId ?? null]);
  fileSync(projectId);
  return r.rows[0].id;
}

export async function updateProjectMemory(projectId: string, id: string, b: { content?: string; topic?: string; pinned?: boolean }): Promise<boolean> {
  const r = await query(
    `UPDATE project_memory SET content = COALESCE($3, content), topic = COALESCE($4, topic), pinned = COALESCE($5, pinned), updated_at = now() WHERE project_id = $1 AND id = $2`,
    [projectId, id, b.content ?? null, b.topic ? normTopic(b.topic) : null, b.pinned ?? null]);
  fileSync(projectId);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteProjectMemory(projectId: string, id: string): Promise<boolean> {
  const ok = ((await query('DELETE FROM project_memory WHERE project_id = $1 AND id = $2', [projectId, id])).rowCount ?? 0) > 0;
  fileSync(projectId);
  return ok;
}

/** CLAUDE.md core: pinned plus the newest, and the topic list. */
export async function projectMemoryCore(projectId: string): Promise<{ core: Array<{ id: string; topic: string; content: string; pinned: boolean }>; topics: Array<{ topic: string; count: number }>; total: number }> {
  const core = (await query<{ id: string; topic: string; content: string; pinned: boolean }>(
    'SELECT id, topic, content, pinned FROM project_memory WHERE project_id = $1 ORDER BY pinned DESC, updated_at DESC LIMIT 15', [projectId])).rows;
  const topics = (await query<{ topic: string; count: number }>('SELECT topic, count(*)::int AS count FROM project_memory WHERE project_id = $1 GROUP BY topic ORDER BY 2 DESC', [projectId])).rows;
  return { core, topics, total: topics.reduce((n, t) => n + t.count, 0) };
}

// ── Token of a project run: only valid for this project's memory (and render), never for personal memory, history or tasks ──
const PTOKEN_TTL_SEC = 12 * 3600;
export async function issueProjectToken(userId: string, projectId: string, conversationId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redis.set(`memory:project:${token}`, JSON.stringify({ userId, projectId, conversationId }), 'EX', PTOKEN_TTL_SEC);
  return token;
}

export async function scopeForProjectToken(token: string): Promise<{ userId: string; projectId: string; conversationId: string } | null> {
  if (!token || token.length > 100) return null;
  const v = await redis.get(`memory:project:${token}`);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
