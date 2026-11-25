import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { broadcastSse } from '../services/sseEvents';
import { ensureProjectDir } from '../services/claudeCode';
import { projectAccess, projectMembers, projectMemberIds, notifyMembers, ensureProjectGid, type ProjectAccess,
  setMemberColor, ensureColors, MEMBER_PALETTE, projectAgentRows, setProjectAgent, grantAgentsToMember, logProjectEvent, listProjectEvents, leaveProject,
  listProjectMemory, addProjectMemory, updateProjectMemory, deleteProjectMemory, scopeForProjectToken } from '../services/sharedProjects';
import { addLesson } from '../services/lessons';

export const projectsRouter = Router();

// ── Claude inside a run of a shared project: loopback + project token; only this project's memory ──
const memSchema = z.object({ content: z.string().trim().min(3).max(4000), topic: z.string().trim().min(1).max(40).optional(), pinned: z.boolean().optional() });
const claude = Router();
claude.use(async (req: Request, _res: Response, next) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const sc = await scopeForProjectToken(String(req.headers['x-memory-token'] ?? ''));
    if (!sc) throw new AppError(401, 'Token ongeldig of verlopen');
    // the token holder must still be a member
    if (!await projectAccess(sc.projectId, sc.userId)) throw new AppError(403, 'Geen lid van dit project');
    (req as Request & { pscope?: typeof sc }).pscope = sc;
    next();
  } catch (err) { next(err); }
});
const scope = (req: Request) => (req as Request & { pscope?: { userId: string; projectId: string; conversationId: string } }).pscope!;
const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
claude.get('/memory', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 30);
    const rows = await listProjectMemory(scope(req).projectId, String(req.query.q ?? ''), limit);
    res.json({ results: rows.map((m) => ({ id: m.id, topic: m.topic, content: m.content, pinned: m.pinned || undefined })) });
  } catch (err) { next(err); }
});
claude.post('/memory', async (req, res, next) => {
  try {
    const sc = scope(req);
    const b = memSchema.parse(req.body);
    const id = await addProjectMemory(sc.projectId, b, { userId: sc.userId, via: 'claude', conversationId: sc.conversationId });
    await logProjectEvent(sc.projectId, null, 'memory.add', b.content.slice(0, 80), { via: 'claude', by: sc.userId, topic: b.topic ?? 'algemeen' });
    void notifyMembers(sc.projectId, { action: 'memory' });
    res.json({ id });
  } catch (err) { next(err); }
});
claude.patch('/memory/:id', async (req, res, next) => {
  try {
    if (!isId(String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    const sc = scope(req);
    const b = memSchema.partial().parse(req.body);
    if (!await updateProjectMemory(sc.projectId, String(req.params.id), b)) throw new AppError(404, 'Niet gevonden');
    await logProjectEvent(sc.projectId, null, 'memory.update', (b.content ?? '').slice(0, 80) || String(req.params.id), { via: 'claude', by: sc.userId, id: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
claude.delete('/memory/:id', async (req, res, next) => {
  try {
    if (!isId(String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    const sc = scope(req);
    if (!await deleteProjectMemory(sc.projectId, String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    await logProjectEvent(sc.projectId, null, 'memory.delete', String(req.params.id), { via: 'claude', by: sc.userId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
projectsRouter.use('/claude', claude);

projectsRouter.use(requireAuth);

const COLORS = ['terracotta', 'amber', 'olive', 'teal', 'blue', 'violet', 'rose', 'slate'] as const;

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.enum(COLORS).optional(),
  icon: z.string().max(32).optional(),
  instructions: z.string().max(20000).optional(),
});
const updateSchema = createSchema.partial();

const LAST = `(SELECT max(c.updated_at) FROM conversations c WHERE c.project_id = p.id AND c.status != 'deleted')`;
const SELECT = `SELECT p.id, p.name, p.color, p.icon, p.instructions, p.created_at, p.updated_at, p.user_id AS owner_id,
  (SELECT count(*)::int FROM conversations c WHERE c.project_id = p.id AND c.status != 'deleted') AS chat_count,
  ${LAST} AS last_activity
  FROM projects p`;

/** The project info a run needs (shared dir + group when it has members) */
export async function projectRunInfo(a: ProjectAccess) {
  const gid = a.shared ? (a.gid ?? await ensureProjectGid(a.id)) : null;
  return { id: a.id, name: a.name, instructions: a.instructions, shared: a.shared && gid ? { gid, ownerId: a.ownerId } : null };
}

/** Rights: member or not. Nothing else (no owner). A non-member gets 403 on an existing project, 404 on an unknown id. */
async function need(req: Request): Promise<ProjectAccess> {
  const id = String((req.params as Record<string, string>).id);
  if (!isId(id)) throw new AppError(404, 'Project not found');
  const a = await projectAccess(id, req.user!.userId);
  if (!a) {
    const exists = await query('SELECT 1 FROM projects WHERE id = $1', [id]);
    throw exists.rowCount ? new AppError(403, 'Je bent geen lid van dit project') : new AppError(404, 'Project not found');
  }
  return a;
}

async function view(id: string, userId: string) {
  const r = await query(`${SELECT} WHERE p.id = $1`, [id]);
  const p = r.rows[0];
  const members = await projectMembers(id);
  return { ...p, is_owner: false, shared: members.length > 1,
    members: members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar && m.avatar.length < 60000 ? m.avatar : null, is_owner: m.is_owner, color: m.color })) };
}

projectsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const uid = req.user!.userId;
    const r = await query<{ id: string }>(
      `${SELECT} WHERE p.user_id = $1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)
       ORDER BY COALESCE(${LAST}, p.updated_at) DESC`, [uid]);
    const ids = r.rows.map((p) => p.id);
    const mem = await query<{ project_id: string; id: string; name: string; avatar: string | null; is_owner: boolean }>(
      `SELECT p.id AS project_id, u.id, COALESCE(u.name, u.email) AS name, u.avatar, false AS is_owner FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = ANY($1::uuid[])
       UNION ALL
       SELECT pm.project_id, u.id, COALESCE(u.name, u.email), u.avatar, false FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ANY($1::uuid[]) AND u.is_active`, [ids]);
    const by = new Map<string, Array<{ id: string; name: string; avatar: string | null; is_owner: boolean }>>();
    for (const m of mem.rows) {
      const l = by.get(m.project_id) ?? [];
      l.push({ id: m.id, name: m.name, avatar: m.avatar && m.avatar.length < 60000 ? m.avatar : null, is_owner: m.is_owner });
      by.set(m.project_id, l);
    }
    const projects = r.rows.map((p) => {
      const members = by.get(p.id) ?? [];
      return { ...p, is_owner: false, shared: members.length > 1, members };
    });
    res.json({ projects });
  } catch (err) { next(err); }
});

projectsRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const b = createSchema.parse(req.body);
    const ins = await query<{ id: string }>(
      'INSERT INTO projects (user_id, name, color, icon, instructions) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user!.userId, b.name, b.color ?? 'terracotta', b.icon ?? 'folder', b.instructions ?? ''],
    );
    const p = await view(ins.rows[0].id, req.user!.userId);
    const pr = p as unknown as { id: string; name: string; instructions: string };
    ensureProjectDir(req.user!.userId, { id: pr.id, name: pr.name, instructions: pr.instructions });
    broadcastSse('conversation-update', { action: 'project', userId: req.user!.userId });
    res.status(201).json({ project: p });
  } catch (err) { next(err); }
});

// Members are equal: everyone may change name, colour and instructions
projectsRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const b = updateSchema.parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const k of ['name', 'color', 'icon', 'instructions'] as const) {
      if (b[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(b[k]); }
    }
    if (!sets.length) throw new AppError(400, 'Nothing to update');
    sets.push('updated_at = NOW()');
    vals.push(a.id);
    await query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    const p = await view(a.id, req.user!.userId);
    const info = await projectRunInfo((await projectAccess(a.id, req.user!.userId))!);
    ensureProjectDir(req.user!.userId, info);
    broadcastSse('conversation-update', { action: 'project', userId: req.user!.userId });
    await notifyMembers(a.id, { action: 'project' });
    await logProjectEvent(a.id, req.user!.userId, 'project.update', b.name ?? a.name, { fields: Object.keys(b).filter((k) => b[k as keyof typeof b] !== undefined) });
    res.json({ project: p });
  } catch (err) { next(err); }
});

// Any member may delete the project (it is the only way out for the last member). Chats stay with their writer (project_id becomes null); files stay in the project dir.
projectsRouter.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const ids = await projectMemberIds(a.id);
    // everyone keeps his own chats as loose chats
    await query('DELETE FROM projects WHERE id = $1', [a.id]);
    broadcastSse('conversation-update', { action: 'project', userId: req.user!.userId, memberIds: ids });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Members ──
projectsRouter.get('/unread', async (req: Request, res: Response, next) => {
  try {
    const r = await query<{ conversation_id: string; project_id: string; n: number }>(
      `SELECT c.id AS conversation_id, c.project_id, count(m.id)::int AS n
       FROM conversations c
       JOIN projects p ON p.id = c.project_id
       JOIN messages m ON m.conversation_id = c.id AND m.role = 'user' AND m.user_id IS NOT NULL AND m.user_id <> $1
       LEFT JOIN conversation_reads cr ON cr.conversation_id = c.id AND cr.user_id = $1
       WHERE c.status != 'deleted'
         AND (p.user_id = $1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1))
         AND m.created_at > COALESCE(cr.last_read_at, (SELECT min(created_at) FROM project_members WHERE project_id = p.id))
       GROUP BY c.id, c.project_id`, [req.user!.userId]);
    const conversations: Record<string, number> = {};
    const projects: Record<string, number> = {};
    for (const x of r.rows) { conversations[x.conversation_id] = x.n; projects[x.project_id] = (projects[x.project_id] ?? 0) + x.n; }
    res.json({ conversations, projects });
  } catch (err) { next(err); }
});

projectsRouter.post('/read/:convId', async (req: Request, res: Response, next) => {
  try {
    const { convAccess } = await import('../services/sharedProjects');
    const acc = await convAccess(String(req.params.convId), req.user!.userId);
    if (!acc) throw new AppError(404, 'Gesprek niet gevonden');
    await query(
      `INSERT INTO conversation_reads (conversation_id, user_id, last_read_at) VALUES ($1,$2,now())
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now()`, [acc.conversationId, req.user!.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

projectsRouter.get('/:id/members', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    res.json({ members: await projectMembers(a.id), is_owner: false });
  } catch (err) { next(err); }
});

// People who can still be added (search on name)
projectsRouter.get('/:id/candidates', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const q = String(req.query.q ?? '').trim();
    const r = await query<{ id: string; name: string; avatar: string | null }>(
      `SELECT u.id, COALESCE(u.name, u.email) AS name, u.avatar FROM users u
       WHERE u.is_active AND u.id <> $1 AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $2 AND pm.user_id = u.id)
         AND ($3 = '' OR COALESCE(u.name, u.email) ILIKE '%' || $3 || '%')
       ORDER BY 2 LIMIT 20`, [a.ownerId, a.id, q]);
    res.json({ users: r.rows });
  } catch (err) { next(err); }
});

// Any member may add people
projectsRouter.post('/:id/members', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const u = await query('SELECT id FROM users WHERE id = $1 AND is_active', [userId]);
    if (!u.rows[0]) throw new AppError(404, 'Gebruiker niet gevonden');
    if (userId !== a.ownerId) {
      await query('INSERT INTO project_members (project_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [a.id, userId, req.user!.userId]);
    }
    await ensureProjectGid(a.id);
    // from now on the project has a shared dir: build it (moves the owner's files) with the owner's view
    await ensureColors(a.id);
    await grantAgentsToMember(a.id, userId);
    const fresh = await projectAccess(a.id, a.ownerId);
    if (fresh) ensureProjectDir(a.ownerId, await projectRunInfo(fresh));
    await notifyMembers(a.id, { action: 'project' });
    await logProjectEvent(a.id, req.user!.userId, 'member.add', (await projectMembers(a.id)).find((m) => m.id === userId)?.name ?? userId, { userId });
    res.json({ members: await projectMembers(a.id) });
  } catch (err) { next(err); }
});

// Leave (yourself) or remove someone: every member may. The last member cannot leave.
projectsRouter.delete('/:id/members/:userId', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const target = String(req.params.userId);
    const before = await projectMemberIds(a.id);
    const name = (await projectMembers(a.id)).find((m) => m.id === target)?.name ?? target;
    try { await leaveProject(a.id, target); } catch (e) { throw new AppError(e instanceof Error && e.message === 'Geen lid' ? 404 : 400, (e as Error).message); }
    await logProjectEvent(a.id, req.user!.userId, target === req.user!.userId ? 'member.leave' : 'member.remove', name, { userId: target });
    broadcastSse('conversation-update', { action: 'project', projectId: a.id, memberIds: before });
    res.json({ members: await projectMembers(a.id) });
  } catch (err) { next(err); }
});

// ── Connectors: every member shares his own with the project (and may withdraw only his own); all members see what is shared ──
projectsRouter.get('/:id/connectors', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const uid = req.user!.userId;
    const r = await query<{ id: string; name: string; type: string; shared: boolean; mine: boolean; by: string | null }>(
      `SELECT c.id, c.name, c.type, (pc.connector_id IS NOT NULL) AS shared, (c.user_id = $1) AS mine, COALESCE(u.name, u.email) AS by
       FROM connectors c LEFT JOIN project_connectors pc ON pc.project_id = $2 AND pc.connector_id = c.id LEFT JOIN users u ON u.id = c.user_id
       WHERE c.is_active AND (c.user_id = $1 OR pc.connector_id IS NOT NULL) ORDER BY (c.user_id = $1) DESC, c.name`, [uid, a.id]);
    res.json({ connectors: r.rows, can_edit: true });
  } catch (err) { next(err); }
});

// Sets which of MY connectors are shared; those of other members stay as they are
projectsRouter.put('/:id/connectors', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const uid = req.user!.userId;
    const { connectorIds } = z.object({ connectorIds: z.array(z.string().uuid()).max(100) }).parse(req.body);
    const mine = (await query<{ id: string; name: string }>('SELECT id, name FROM connectors WHERE user_id = $1 AND is_active', [uid])).rows;
    const want = new Set(mine.filter((c) => connectorIds.includes(c.id)).map((c) => c.id));
    const had = new Set((await query<{ connector_id: string }>('SELECT connector_id FROM project_connectors WHERE project_id = $1 AND connector_id = ANY($2::uuid[])', [a.id, mine.map((c) => c.id)])).rows.map((x) => x.connector_id));
    for (const c of mine) {
      if (want.has(c.id) && !had.has(c.id)) {
        await query('INSERT INTO project_connectors (project_id, connector_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [a.id, c.id, uid]);
        await logProjectEvent(a.id, uid, 'connector.share', c.name, { connectorId: c.id });
      } else if (!want.has(c.id) && had.has(c.id)) {
        await query('DELETE FROM project_connectors WHERE project_id = $1 AND connector_id = $2', [a.id, c.id]);
        await logProjectEvent(a.id, uid, 'connector.unshare', c.name, { connectorId: c.id });
      }
    }
    res.json({ ok: true, count: want.size });
  } catch (err) { next(err); }
});

// ── Colour of a participant: every member may change any colour ──
projectsRouter.put('/:id/members/:userId/color', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const target = String(req.params.userId);
    if (!(await projectMembers(a.id)).some((m) => m.id === target)) throw new AppError(404, 'Geen lid');
    const { color } = z.object({ color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }).parse(req.body);
    try { await setMemberColor(a.id, target, color.toUpperCase()); } catch (e) { throw new AppError(409, (e as Error).message); }
    await notifyMembers(a.id, { action: 'project' });
    const ms = await projectMembers(a.id);
    await logProjectEvent(a.id, req.user!.userId, 'member.color', ms.find((m) => m.id === target)?.name ?? target, { userId: target, color: color.toUpperCase() });
    res.json({ members: ms, palette: MEMBER_PALETTE });
  } catch (err) { next(err); }
});

// ── Agents per project: every member adds agents, decides who may use them and which account ──
projectsRouter.get('/:id/agents', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    res.json({ agents: await projectAgentRows(a.id, req.user!.userId), can_edit: true, me: req.user!.userId });
  } catch (err) { next(err); }
});

projectsRouter.put('/:id/agents/:agentId', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const b = z.object({ inProject: z.boolean(), userIds: z.array(z.string().uuid()).max(200), accountMode: z.enum(['user', 'owner']).optional(), fallback: z.boolean().optional() }).parse(req.body);
    const agentId = String(req.params.agentId);
    if (!isId(agentId)) throw new AppError(404, 'Niet gevonden');
    let r: { name: string; was: boolean };
    try { r = await setProjectAgent(a.id, req.user!.userId, { agentId, ...b }); } catch (e) { throw new AppError(400, (e as Error).message); }
    const names = new Map((await projectMembers(a.id)).map((m) => [m.id, m.name]));
    const action = !r.was && b.inProject ? 'agent.add' : r.was && !b.inProject ? 'agent.remove' : b.accountMode !== undefined ? 'agent.account' : 'agent.users';
    await logProjectEvent(a.id, req.user!.userId, action, r.name, { agentId, users: b.userIds.map((u) => names.get(u) ?? u), accountMode: b.accountMode, fallback: b.fallback });
    await notifyMembers(a.id, { action: 'project' });
    res.json({ agents: await projectAgentRows(a.id, req.user!.userId) });
  } catch (err) { next(err); }
});

// Account of an agent in the project: any member ('user' = the asker's, 'owner' = the member who added the agent)
projectsRouter.put('/:id/agents/:agentId/account', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const agentId = String(req.params.agentId);
    if (!isId(agentId)) throw new AppError(404, 'Niet gevonden');
    const b = z.object({ accountMode: z.enum(['user', 'owner']), fallback: z.boolean() }).parse(req.body);
    const r = await query('UPDATE project_agents SET account_mode = $3, fallback = $4 WHERE project_id = $1 AND agent_id = $2', [a.id, agentId, b.accountMode, b.fallback]);
    if (!r.rowCount) throw new AppError(404, 'Agent zit niet in dit project');
    const nm = (await query<{ name: string }>('SELECT name FROM agents WHERE id = $1', [agentId])).rows[0]?.name ?? agentId;
    await logProjectEvent(a.id, req.user!.userId, 'agent.account', nm, { agentId, accountMode: b.accountMode, fallback: b.fallback });
    res.json({ agents: await projectAgentRows(a.id, req.user!.userId) });
  } catch (err) { next(err); }
});

// ── History of changes ──
projectsRouter.get('/:id/events', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const before = /^\d{1,18}$/.test(String(req.query.before ?? '')) ? Number(req.query.before) : undefined;
    res.json(await listProjectEvents(a.id, before, Number(req.query.limit) || 30));
  } catch (err) { next(err); }
});

// ── Project memory (all members edit) ──
projectsRouter.get('/:id/memory', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    res.json({ memories: await listProjectMemory(a.id, String(req.query.q ?? '')) });
  } catch (err) { next(err); }
});
projectsRouter.post('/:id/memory', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const b = memSchema.parse(req.body);
    await addProjectMemory(a.id, b, { userId: req.user!.userId, via: 'person' });
    await logProjectEvent(a.id, req.user!.userId, 'memory.add', b.content.slice(0, 80), { via: 'person', topic: b.topic ?? 'algemeen' });
    res.json({ memories: await listProjectMemory(a.id) });
  } catch (err) { next(err); }
});
projectsRouter.patch('/:id/memory/:mid', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const b = memSchema.partial().parse(req.body);
    if (!isId(String(req.params.mid)) || !await updateProjectMemory(a.id, String(req.params.mid), b)) throw new AppError(404, 'Niet gevonden');
    await logProjectEvent(a.id, req.user!.userId, b.pinned !== undefined && b.content === undefined ? 'memory.pin' : 'memory.update', (b.content ?? '').slice(0, 80) || String(req.params.mid), { via: 'person', id: req.params.mid, pinned: b.pinned });
    res.json({ memories: await listProjectMemory(a.id) });
  } catch (err) { next(err); }
});
projectsRouter.delete('/:id/memory/:mid', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const old = isId(String(req.params.mid)) ? (await query<{ content: string }>('SELECT content FROM project_memory WHERE id = $1 AND project_id = $2', [String(req.params.mid), a.id])).rows[0]?.content : undefined;
    if (!isId(String(req.params.mid)) || !await deleteProjectMemory(a.id, String(req.params.mid))) throw new AppError(404, 'Niet gevonden');
    await logProjectEvent(a.id, req.user!.userId, 'memory.delete', (old ?? '').slice(0, 80), { via: 'person' });
    res.json({ memories: await listProjectMemory(a.id) });
  } catch (err) { next(err); }
});
// Technical rule to the shared lessons: only after confirmation by a member, with the text he checked (no names or customers)
projectsRouter.post('/:id/memory/:mid/lesson', async (req: Request, res: Response, next) => {
  try {
    const a = await need(req);
    const { lesson, topic } = z.object({ lesson: z.string().trim().min(10).max(600), topic: z.string().trim().min(1).max(40).default('app') }).parse(req.body);
    const m = await query('SELECT 1 FROM project_memory WHERE id = $1 AND project_id = $2', [String(req.params.mid), a.id]);
    if (!m.rowCount) throw new AppError(404, 'Niet gevonden');
    res.json({ result: await addLesson(req.user!.userId, topic, lesson) });
  } catch (err) { next(err); }
});
