import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { userForMemoryToken } from '../services/memory';
import { createAgent, listAgents, AGENT_COLORS } from '../services/agents';
import * as tasks from '../services/tasks';

export const tasksRouter = Router();

const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const taskSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(3).max(20_000),
  agent_id: z.string().uuid().nullable().optional(),
  cron: z.string().trim().max(100).nullable().optional(),
  schedule_text: z.string().trim().max(120).optional(),
  run_at: z.string().max(40).nullable().optional(),
  timezone: z.string().max(60).optional(),
  enabled: z.boolean().optional(),
  autonomous: z.boolean().optional(),
  source_pattern: z.string().max(80).nullable().optional(),
});
const patchSchema = taskSchema.partial();
const newAgentSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(5).max(1000),
  prompt: z.string().trim().min(5).max(20_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(AGENT_COLORS[0]),
});

/** The task as the app and Claude see it, plus the next few run times. */
function view(t: tasks.Task) {
  const { user_id: _u, ...rest } = t;
  return { ...rest, next_runs: t.enabled && t.cron ? tasks.previewRuns(t.cron, t.timezone) : t.next_run_at ? [new Date(t.next_run_at).toISOString()] : [] };
}

// ── Claude inside this container: loopback + the per-run memory token (same as /memory/claude) ──
const claude = Router();
claude.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const userId = await userForMemoryToken(String(req.headers['x-memory-token'] ?? ''));
    if (!userId) throw new AppError(401, 'Token ongeldig of verlopen');
    (req as Request & { taskUser?: string }).taskUser = userId;
    next();
  } catch (err) { next(err); }
});
const cuid = (req: Request) => (req as Request & { taskUser?: string }).taskUser!;
claude.param('id', (_req, _res, next, id: string) => next(isId(id) ? undefined : new AppError(404, 'Taak niet gevonden')));

/** Claude names an agent by name or subagent type ("agent"); null clears it. */
async function withAgent<T extends { agent_id?: string | null }>(userId: string, body: unknown, parsed: T): Promise<T> {
  const name = (body as { agent?: unknown })?.agent;
  if (name === null || name === '') return { ...parsed, agent_id: null };
  if (typeof name !== 'string') return parsed;
  const n = name.trim().toLowerCase();
  const a = (await listAgents(userId)).find((x) => x.slug === n || x.name.toLowerCase() === n);
  if (!a) throw new AppError(400, `Agent "${name}" niet gevonden`);
  return { ...parsed, agent_id: a.id };
}

claude.get('/', async (req, res, next) => {
  try {
    const agents = await listAgents(cuid(req));
    res.json({ tasks: (await tasks.listTasks(cuid(req))).map((t) => ({ ...view(t), agent: agents.find((a) => a.id === t.agent_id)?.name ?? null })) });
  } catch (err) { next(err); }
});
// Claude proposes: a new task starts switched off until the user agrees (then PATCH enabled=true)
claude.post('/', async (req, res, next) => {
  try {
    const b = await withAgent(cuid(req), req.body, taskSchema.parse(req.body));
    const t = await tasks.createTask(cuid(req), { ...b, enabled: b.enabled ?? false });
    await auditLog(cuid(req), 'task.create', 'task', t.id, '', { name: t.name, via: 'claude' });
    res.json({ task: view(t) });
  } catch (err) { next(err); }
});
claude.patch('/:id', async (req, res, next) => {
  try {
    const t = await tasks.updateTask(cuid(req), String(req.params.id), await withAgent(cuid(req), req.body, patchSchema.parse(req.body)));
    await auditLog(cuid(req), 'task.update', 'task', t.id, '', { via: 'claude', enabled: t.enabled });
    res.json({ task: view(t) });
  } catch (err) { next(err); }
});
claude.post('/:id/run', async (req, res, next) => {
  try { res.json(await tasks.startTask(cuid(req), String(req.params.id), 'handmatig')); } catch (err) { next(err); }
});
claude.delete('/:id', async (req, res, next) => {
  try {
    if (!await tasks.deleteTask(cuid(req), String(req.params.id))) throw new AppError(404, 'Taak niet gevonden');
    await auditLog(cuid(req), 'task.delete', 'task', String(req.params.id), '', { via: 'claude' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
tasksRouter.use('/claude', claude);

// ── The user in the app ──
tasksRouter.use(requireAuth);
tasksRouter.param('id', (_req, _res, next, id: string) => next(isId(id) ? undefined : new AppError(404, 'Taak niet gevonden')));

async function listAll(userId: string) {
  return { tasks: (await tasks.listTasks(userId)).map(view), suggestions: await tasks.suggestions(userId) };
}

tasksRouter.get('/', async (req, res, next) => {
  try { res.json(await listAll(req.user!.userId)); } catch (err) { next(err); }
});

// Create; with new_agent the recommended agent is made first (agents service) and gets the task
tasksRouter.post('/', async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const b = taskSchema.extend({ new_agent: newAgentSchema.optional() }).parse(req.body);
    let agentId = b.agent_id ?? null;
    if (b.new_agent) {
      agentId = await createAgent(userId, { ...b.new_agent, model: 'inherit' });
      await auditLog(userId, 'agent.create', 'agent', agentId, req.ip ?? '', { name: b.new_agent.name, via: 'task-wizard' });
    }
    const { new_agent: _n, ...input } = b;
    const t = await tasks.createTask(userId, { ...input, agent_id: agentId });
    await auditLog(userId, 'task.create', 'task', t.id, req.ip ?? '', { name: t.name });
    res.status(201).json({ task: view(t), ...await listAll(userId) });
  } catch (err) { next(err); }
});

tasksRouter.patch('/:id', async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const t = await tasks.updateTask(userId, String(req.params.id), patchSchema.parse(req.body));
    await auditLog(userId, 'task.update', 'task', t.id, req.ip ?? '', { enabled: t.enabled, autonomous: t.autonomous });
    res.json({ task: view(t), ...await listAll(userId) });
  } catch (err) { next(err); }
});

tasksRouter.delete('/:id', async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    if (!await tasks.deleteTask(userId, String(req.params.id))) throw new AppError(404, 'Taak niet gevonden');
    await auditLog(userId, 'task.delete', 'task', String(req.params.id), req.ip ?? '', {});
    res.json(await listAll(userId));
  } catch (err) { next(err); }
});

tasksRouter.get('/:id/runs', async (req, res, next) => {
  try { res.json({ runs: await tasks.listRuns(req.user!.userId, String(req.params.id)) }); } catch (err) { next(err); }
});

// Run now
tasksRouter.post('/:id/run', async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const r = await tasks.startTask(userId, String(req.params.id), 'handmatig');
    res.json({ result: r, ...await listAll(userId) });
  } catch (err) { next(err); }
});

// "Uitvoeren": approve the proposed actions (chat button and the push action)
tasksRouter.post('/:id/execute', async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const r = await tasks.startTask(userId, String(req.params.id), 'uitvoeren');
    await auditLog(userId, 'task.execute', 'task', String(req.params.id), req.ip ?? '', { status: r.status });
    res.json({ result: r });
  } catch (err) { next(err); }
});

// Wizard: plain language → proposal. Nothing is saved here.
const assistBusy = new Set<string>();
tasksRouter.post('/assist', async (req, res, next) => {
  const userId = req.user!.userId;
  let mine = false;
  try {
    const b = z.object({ text: z.string().trim().min(3).max(4000) }).parse(req.body);
    if (assistBusy.has(userId)) throw new AppError(429, 'Claude is al bezig met een voorstel');
    assistBusy.add(userId); mine = true;
    res.json(await tasks.assistTask(userId, b.text));
  } catch (err) { next(err); } finally { if (mine) assistBusy.delete(userId); }
});

// Preview of a schedule (the wizard's summary): readable text and the next run times
tasksRouter.post('/preview', async (req, res, next) => {
  try {
    const b = z.object({ cron: z.string().max(100), timezone: z.string().max(60).default('Europe/Amsterdam') }).parse(req.body);
    tasks.validateSchedule({ cron: b.cron, timezone: b.timezone });
    const { describeCron } = await import('../services/taskSchedule');
    res.json({ schedule_text: describeCron(b.cron), next_runs: tasks.previewRuns(b.cron, b.timezone) });
  } catch (err) { next(err); }
});

tasksRouter.post('/suggestions/:key/dismiss', async (req, res, next) => {
  try {
    await tasks.dismissSuggestion(req.user!.userId, String(req.params.key).slice(0, 80));
    res.json(await listAll(req.user!.userId));
  } catch (err) { next(err); }
});
