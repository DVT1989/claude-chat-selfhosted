import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { userForMemoryToken } from '../services/memory';
import * as insights from '../services/insights';
import { listAgents } from '../services/agents';
import { auditLog } from '../middleware/auth';

/** Coach (and any run) via loopback + the per-run memory token, like /memory/claude and /tasks/claude. */
export const insightsRouter = Router();

const claude = Router();
claude.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const userId = await userForMemoryToken(String(req.headers['x-memory-token'] ?? ''));
    if (!userId) throw new AppError(401, 'Token ongeldig of verlopen');
    (req as Request & { insUser?: string }).insUser = userId;
    next();
  } catch (err) { next(err); }
});
const uid = (req: Request) => (req as Request & { insUser?: string }).insUser!;

const date = (v: unknown, fallback: Date): Date => {
  if (typeof v !== 'string' || !v.trim()) return fallback;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new AppError(400, `Ongeldige datum: ${v} (gebruik ISO, bijv. 2026-11-20 of 2026-11-20T06:00:00Z)`);
  return new Date(t);
};

// GET /insights/claude?since=ISO&until=ISO (standaard: de laatste 24 uur, maximaal 31 dagen)
claude.get('/', async (req, res, next) => {
  try {
    const until = date(req.query.until, new Date());
    const since = date(req.query.since, new Date(until.getTime() - 24 * 3600_000));
    if (since >= until) throw new AppError(400, 'since moet voor until liggen');
    if (until.getTime() - since.getTime() > 31 * 86400_000) throw new AppError(400, 'Hooguit 31 dagen per keer');
    res.json(await insights.buildInsights(uid(req), since, until));
  } catch (err) { next(err); }
});

const proposalSchema = z.object({
  agent: z.string().max(80).nullable().optional(),
  kind: z.enum(['prompt', 'model', 'description', 'skill', 'other']),
  title: z.string().trim().min(3).max(200),
  reason: z.string().max(2000).optional(),
  evidence: z.string().max(4000).optional(),
  after: z.string().max(20_000).nullable().optional(),
  apply: z.boolean().optional(),
  skill: z.object({ name: z.string().max(64), description: z.string().max(1000), body: z.string().max(20_000) }).nullable().optional(),
});

claude.get('/proposals', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' && ['open', 'applied', 'rejected', 'reverted'].includes(req.query.status) ? req.query.status : null;
    // compact for Claude: no full before/after texts
    const list = await insights.listProposals(uid(req), { status });
    res.json({ proposals: list.map((p) => ({ id: p.id, agent: p.agent_name, kind: p.kind, title: p.title, status: p.status, created_at: p.created_at, applied_at: p.applied_at, delegation_id: p.delegation_id ?? undefined, delegation_status: p.delegation_status ?? undefined })) });
  } catch (err) { next(err); }
});

claude.post('/proposals', async (req, res, next) => {
  try {
    const b = proposalSchema.parse(req.body);
    const { apply, ...input } = b;
    const created = await insights.createProposal(uid(req), input);
    await auditLog(uid(req), 'pit.proposal.create', 'agent_proposal', created.id, req.ip ?? '', { kind: b.kind, title: b.title });
    if (!apply) return void res.status(201).json(created);
    const applied = await insights.applyProposal(uid(req), created.id);
    await auditLog(uid(req), 'pit.proposal.apply', 'agent_proposal', created.id, req.ip ?? '', { ...applied });
    res.status(201).json({ ...created, ...applied });
  } catch (err) { next(err); }
});

// Coach handles his own proposals: apply, reject and revert (also skill proposals: apply = approve)
for (const action of ['apply', 'reject', 'revert'] as const) {
  claude.post(`/proposals/:id/${action}`, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'Niet gevonden');
      let out: Record<string, unknown> = { status: action === 'apply' ? 'applied' : action === 'reject' ? 'rejected' : 'reverted' };
      if (action === 'apply') out = { ...(await insights.applyProposal(uid(req), id)) };
      else if (action === 'reject') await insights.rejectProposal(uid(req), id);
      else await insights.revertProposal(uid(req), id);
      await auditLog(uid(req), `pit.proposal.${action}`, 'agent_proposal', id, req.ip ?? '', out);
      res.json({ id, ...out });
    } catch (err) { next(err); }
  });
}

// the user's agents with their full prompt, as the basis for a proposal (after = the complete new value)
claude.get('/agents', async (req, res, next) => {
  try {
    const name = typeof req.query.name === 'string' ? req.query.name.toLowerCase() : '';
    const list = (await listAgents(uid(req), { ownOnly: true })).filter((a) => !name || a.name.toLowerCase() === name || a.slug === name || a.slug === `agent-${name}`);
    res.json({ agents: list.map((a) => ({ id: a.id, name: a.name, slug: a.slug, model: a.model, is_active: a.is_active, description: a.description, prompt: a.prompt })) });
  } catch (err) { next(err); }
});

insightsRouter.use('/claude', claude);
