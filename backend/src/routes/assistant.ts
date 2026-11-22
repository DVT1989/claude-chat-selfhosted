import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { query } from '../db';
import * as learning from '../services/learning';
import { DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET, getBudget } from '../services/contextBudget';
import { buildGraph } from '../services/knowledgeGraph';
import * as insights from '../services/insights';
import { lockReason } from '../services/backgroundJobs';

/** The personal assistant layer in the app: what the learning loop saved, skill proposals, token budget. */
export const assistantRouter = Router();
assistantRouter.use(requireAuth);

const isId = (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);

assistantRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const [settings, budget, logRows, proposals, patterns, runs, ctx, avg] = await Promise.all([
      learning.getSettings(userId),
      getBudget(userId),
      query(`SELECT l.id, l.kind, l.action, l.target_id, l.before, l.after, l.note, l.created_at, l.reverted_at, l.conversation_id,
                    c.title AS conversation_title
             FROM learn_log l LEFT JOIN conversations c ON c.id = l.conversation_id
             WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 80`, [userId]),
      query(`SELECT id, name, description, body, script_name, script_lang, script_content, reason, status, installed_name, created_at, decided_at,
                    (SELECT count FROM task_patterns p WHERE p.id = s.pattern_id) AS seen
             FROM skill_proposals s WHERE user_id = $1 AND (status = 'open' OR decided_at > now() - interval '30 days')
             ORDER BY (status = 'open') DESC, created_at DESC LIMIT 30`, [userId]),
      query(`SELECT key, summary, count, last_seen FROM task_patterns WHERE user_id = $1 ORDER BY count DESC, last_seen DESC LIMIT 12`, [userId]),
      query(`SELECT kind, status, saved, skipped, input_chars, error, started_at, finished_at FROM learn_runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 12`, [userId]),
      query(`SELECT created_at, claude_md_tokens, memory_tokens, lessons_tokens, global_md_tokens, skills_tokens, skills_count, agents_tokens, total_tokens, budget, trimmed
             FROM context_sizes WHERE user_id = $1 ORDER BY id DESC LIMIT 30`, [userId]),
      query(`SELECT round(avg(total_tokens))::int AS total, round(avg(claude_md_tokens + global_md_tokens))::int AS core, count(*)::int AS runs,
                    count(*) FILTER (WHERE cardinality(trimmed) > 0)::int AS trimmed_runs
             FROM context_sizes WHERE user_id = $1 AND created_at > now() - interval '7 days'`, [userId]),
    ]);
    res.json({
      settings, budget: { tokens: budget, default: DEFAULT_BUDGET, min: MIN_BUDGET, max: MAX_BUDGET },
      log: logRows.rows, proposals: proposals.rows, patterns: patterns.rows, runs: runs.rows,
      context: { recent: ctx.rows, week: avg.rows[0] }, busy: learning.isBusy(),
    });
  } catch (err) { next(err); }
});

// Swarm: all knowledge of this user as nodes and edges in one go (lessons only for admins or own)
assistantRouter.get('/graph', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await buildGraph(req.user!.userId, req.user!.role === 'admin'));
  } catch (err) { next(err); }
});

assistantRouter.patch('/settings', async (req, res, next) => {
  try {
    const b = z.object({ learn: z.boolean().optional(), budgetTokens: z.number().int().min(MIN_BUDGET).max(MAX_BUDGET).nullable().optional() }).parse(req.body);
    const out = await learning.setSettings(req.user!.userId, b);
    await auditLog(req.user!.userId, 'assistant.settings', 'user', req.user!.userId, req.ip ?? '', b);
    res.json({ settings: out, budget: await getBudget(req.user!.userId) });
  } catch (err) { next(err); }
});

assistantRouter.post('/log/:id/revert', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) throw new AppError(404, 'Niet gevonden');
    try { await learning.revertLog(req.user!.userId, String(req.params.id)); }
    catch (e) { throw new AppError(400, (e as Error).message); }
    await auditLog(req.user!.userId, 'assistant.revert', 'learn_log', String(req.params.id), req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

assistantRouter.post('/proposals/:id/approve', async (req, res, next) => {
  try {
    if (!isId(req.params.id)) throw new AppError(404, 'Niet gevonden');
    let name: string;
    try { name = await learning.approveProposal(req.user!.userId, String(req.params.id)); }
    catch (e) { throw new AppError(400, (e as Error).message); }
    await auditLog(req.user!.userId, 'assistant.skill.approve', 'skill', null, req.ip ?? '', { proposal: req.params.id, name });
    res.json({ ok: true, name });
  } catch (err) { next(err); }
});

assistantRouter.post('/proposals/:id/reject', async (req, res, next) => {
  try {
    if (!isId(req.params.id) || !await learning.rejectProposal(req.user!.userId, String(req.params.id))) throw new AppError(404, 'Niet gevonden');
    await auditLog(req.user!.userId, 'assistant.skill.reject', 'skill', null, req.ip ?? '', { proposal: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Backfill: run the learning loop once over all older conversations (resumes after a restart)
assistantRouter.post('/backfill', async (req, res, next) => {
  try { await learning.startBackfill(req.user!.userId); res.json({ started: true, ...(await learning.backfillStatus(req.user!.userId)) }); }
  catch (err) { next(err); }
});
assistantRouter.get('/backfill', async (req, res, next) => {
  try { res.json(await learning.backfillStatus(req.user!.userId)); } catch (err) { next(err); }
});

// Run now (in the background; the overview shows the result)
assistantRouter.post('/learn/run', async (req, res, next) => {
  try {
    { const why = lockReason(); if (why) { res.json({ started: false, waiting: why }); return; } }
    const userId = req.user!.userId;
    void learning.tick(userId, true).then((r) => console.log(`[learning] handmatig: ${r.learned} gesprek(ken), ${r.proposals} voorstel(len)${r.waiting ? `, wacht: ${r.waiting}` : ''}`))
      .catch((e) => console.error('[learning] handmatig:', e));
    res.json({ started: true });
  } catch (err) { next(err); }
});

assistantRouter.post('/cleanup/run', async (req, res, next) => {
  try {
    { const why = lockReason(); if (why) { res.json({ started: false, waiting: why }); return; } }
    void learning.cleanupOne(req.user!.userId).catch((e) => console.error('[learning] opruimen:', e));
    res.json({ started: true });
  } catch (err) { next(err); }
});

// ── Proposals of Coach: apply changes the agent (prompt, model or description), revert puts the old value back ──
assistantRouter.get('/agent-proposals', async (req, res, next) => {
  try { res.json({ proposals: await insights.listProposals(req.user!.userId) }); } catch (err) { next(err); }
});
for (const action of ['apply', 'reject', 'revert'] as const) {
  assistantRouter.post(`/agent-proposals/:id/${action}`, async (req, res, next) => {
    try {
      if (!isId(req.params.id)) throw new AppError(404, 'Niet gevonden');
      const userId = req.user!.userId, id = String(req.params.id);
      if (action === 'apply') await insights.applyProposal(userId, id);
      else if (action === 'reject') await insights.rejectProposal(userId, id);
      else await insights.revertProposal(userId, id);
      await auditLog(userId, `assistant.agent_proposal.${action}`, 'agent_proposal', id, req.ip ?? '', {});
      res.json({ proposals: await insights.listProposals(userId) });
    } catch (err) { next(err); }
  });
}
