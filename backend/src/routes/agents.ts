import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { listAgents, uniqueSlug, createAgent, assistPrompt, ASSIST_SYSTEM } from '../services/agents';
import { runStructured } from '../services/claudeCode';
import { startTraining, trainingStatus, setKnowledge, revertKnowledge } from '../services/agentTraining';
import { userForMemoryToken } from '../services/memory';
import { createDelegation, listDelegations, getDelegation, runTokenInfo } from '../services/delegations';

export const agentsRouter = Router();

// ── Claude inside this container: loopback + the per-run memory token (same as /tasks/claude) ──
const claude = Router();
claude.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const userId = await userForMemoryToken(String(req.headers['x-memory-token'] ?? ''));
    if (!userId) throw new AppError(401, 'Token ongeldig of verlopen');
    (req as Request & { claudeUser?: string }).claudeUser = userId;
    next();
  } catch (err) { next(err); }
});
const cuid = (req: Request) => (req as Request & { claudeUser?: string }).claudeUser!;
const delegateSchema = z.object({
  agent: z.string().trim().min(1).max(60),
  task: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(10).max(40_000),
  parentConversationId: z.string().uuid().nullable().optional(),
});

/** Hand a task to an agent in its own workplace: {delegationId, conversationId}. */
claude.post('/delegate', async (req, res, next) => {
  try {
    const userId = cuid(req);
    const b = delegateSchema.parse(req.body);
    // the calling run (CC_RUN_TOKEN): the parent, and the only way to a privileged workplace
    const run = await runTokenInfo(String(req.headers['x-run-token'] ?? ''));
    const runConv = run && run.userId === userId ? run.conversationId : null;
    if (!runConv && !b.parentConversationId) throw new AppError(400, 'Geef x-run-token ($CC_RUN_TOKEN) of parentConversationId mee');
    const d = await createDelegation(userId, b, runConv);
    await auditLog(userId, 'agent.delegate', 'delegation', d.id, '', { agent: b.agent, title: d.title, parent: d.parent_conversation_id });
    res.json({ delegationId: d.id, conversationId: d.conversation_id, status: d.status });
  } catch (err) { next(err); }
});
claude.get('/delegations', async (req, res, next) => {
  try {
    const parent = typeof req.query.parent === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.parent) ? req.query.parent : null;
    res.json({ delegations: await listDelegations(cuid(req), parent) });
  } catch (err) { next(err); }
});
/** Steer a running (or finished) workplace: the message goes to its queue and runs after the current step,
 *  or right away when the agent is idle (a new round, like the input in the card). */
claude.post('/delegations/:id/message', async (req, res, next) => {
  try {
    const userId = cuid(req);
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(400, 'Ongeldig id');
    const content = z.object({ content: z.string().trim().min(1).max(20_000) }).parse(req.body).content;
    const d = await getDelegation(userId, id);
    if (!d) throw new AppError(404, 'Werkplek niet gevonden');
    const { enqueueMessage } = await import('./stream');
    await enqueueMessage(d.conversationId, userId, content);
    await auditLog(userId, 'agent.delegate.message', 'delegation', id, '', { length: content.length });
    res.json({ ok: true, delegationId: id, conversationId: d.conversationId });
  } catch (err) { next(err); }
});
agentsRouter.use('/claude', claude);

agentsRouter.use(requireAuth);

// ── The app: the cards in a conversation ──
agentsRouter.get('/delegations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parent = typeof req.query.parent === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.parent) ? req.query.parent : null;
    res.json({ delegations: await listDelegations(req.user!.userId, parent) });
  } catch (err) { next(err); }
});
agentsRouter.get('/delegations/:delegationId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.delegationId);
    const d = /^[0-9a-f-]{36}$/i.test(id) ? await getDelegation(req.user!.userId, id) : null;
    if (!d) throw new AppError(404, 'Delegatie niet gevonden');
    res.json({ delegation: d });
  } catch (err) { next(err); }
});
agentsRouter.param('id', (_req, _res, next, id: string) => {
  next(/^[0-9a-f-]{36}$/i.test(id) ? undefined : new AppError(404, 'Agent niet gevonden'));
});

const MODEL_RE = /^(inherit|opus|sonnet|haiku|claude-[a-z0-9.-]{3,60})$/;

const agentSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(5).max(1000),
  prompt: z.string().trim().min(5).max(20000),
  model: z.string().regex(MODEL_RE).default('inherit'),
  avatar: z.string().max(400_000).nullable().optional()
    .refine((v) => v == null || /^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(v), 'Ongeldige afbeelding'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  is_active: z.boolean().default(true),
  account_slots: z.array(z.number().int().min(0).max(20)).max(20).nullable().optional(),
});

agentsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ agents: await listAgents(req.user!.userId) }); } catch (err) { next(err); }
});

agentsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = agentSchema.parse(req.body);
    const userId = req.user!.userId;
    const id = await createAgent(userId, b);
    await auditLog(userId, 'agent.create', 'agent', id, req.ip ?? '', { name: b.name });
    res.status(201).json({ agents: await listAgents(userId) });
  } catch (err) { next(err); }
});

agentsRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = agentSchema.parse(req.body);
    const userId = req.user!.userId;
    const id = String(req.params.id);
    const cur = await query<{ name: string; slug: string }>('SELECT name, slug FROM agents WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!cur.rows[0]) throw new AppError(404, 'Agent niet gevonden');
    const slug = cur.rows[0].name === b.name ? cur.rows[0].slug : await uniqueSlug(userId, b.name, id);
    await query(
      `UPDATE agents SET name=$1, slug=$2, description=$3, prompt=$4, model=$5, avatar=$6, color=$7, is_active=$8, account_slots=$11, updated_at=now()
       WHERE id = $9 AND user_id = $10`,
      [b.name, slug, b.description, b.prompt, b.model, b.avatar ?? null, b.color, b.is_active, id, userId,
       b.account_slots?.length ? [...new Set(b.account_slots)].sort((x, y) => x - y) : null]);
    await auditLog(userId, 'agent.update', 'agent', id, req.ip ?? '', { name: b.name });
    res.json({ agents: await listAgents(userId) });
  } catch (err) { next(err); }
});

agentsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const r = await query('DELETE FROM agents WHERE id = $1 AND user_id = $2', [String(req.params.id), userId]);
    if (!r.rowCount) throw new AppError(404, 'Agent niet gevonden');
    await auditLog(userId, 'agent.delete', 'agent', String(req.params.id), req.ip ?? '', {});
    res.json({ agents: await listAgents(userId) });
  } catch (err) { next(err); }
});

// Training on earlier conversations: start, follow, edit the knowledge block, undo the last change
agentsRouter.post('/:id/train', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId, id = String(req.params.id);
    await startTraining(userId, id);
    await auditLog(userId, 'agent.train', 'agent', id, req.ip ?? '', {});
    res.status(202).json(await trainingStatus(userId, id));
  } catch (err) { next(err); }
});

agentsRouter.get('/:id/train', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await trainingStatus(req.user!.userId, String(req.params.id))); } catch (err) { next(err); }
});

agentsRouter.patch('/:id/knowledge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId, id = String(req.params.id);
    const b = z.object({ knowledge: z.string().max(12000) }).parse(req.body);
    await setKnowledge(userId, id, b.knowledge);
    await auditLog(userId, 'agent.knowledge', 'agent', id, req.ip ?? '', { chars: b.knowledge.length });
    res.json(await trainingStatus(userId, id));
  } catch (err) { next(err); }
});

agentsRouter.post('/:id/knowledge/revert', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId, id = String(req.params.id);
    await revertKnowledge(userId, id);
    await auditLog(userId, 'agent.knowledge.revert', 'agent', id, req.ip ?? '', {});
    res.json(await trainingStatus(userId, id));
  } catch (err) { next(err); }
});

// Wizard: idea (+ answers) → questions or a complete proposal. Nothing is saved here.
const assistBusy = new Set<string>();
agentsRouter.post('/assist', async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user!.userId;
  let mine = false;
  try {
    const b = z.object({
      idea: z.string().max(8000).default(''),
      current: z.object({ name: z.string().max(60), description: z.string().max(1000), prompt: z.string().max(20000), model: z.string().max(80) }).nullable().optional(),
      answers: z.array(z.object({ question: z.string().max(500), answer: z.string().max(2000) })).max(20).default([]),
      round: z.number().int().min(0).max(2).default(0),
    }).parse(req.body);
    if (!b.idea.trim() && !b.current) throw new AppError(400, 'Beschrijf eerst wat de agent moet doen');
    if (assistBusy.has(userId)) throw new AppError(429, 'Claude is al bezig met een voorstel');
    assistBusy.add(userId); mine = true;
    const { prompt, schema } = assistPrompt(b);
    const out = await runStructured<Record<string, unknown>>(userId, { system: ASSIST_SYSTEM, prompt, schema, model: 'sonnet' });
    res.json(out);
  } catch (err) { next(err); } finally { if (mine) assistBusy.delete(userId); }
});
