import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { broadcastSse } from '../services/sseEvents';
import { ensureProjectDir } from '../services/claudeCode';

export const projectsRouter = Router();
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
const SELECT = `SELECT p.id, p.name, p.color, p.icon, p.instructions, p.created_at, p.updated_at,
  (SELECT count(*)::int FROM conversations c WHERE c.project_id = p.id AND c.status != 'deleted') AS chat_count,
  ${LAST} AS last_activity
  FROM projects p`;

projectsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const r = await query(`${SELECT} WHERE p.user_id = $1 ORDER BY COALESCE(${LAST}, p.updated_at) DESC`, [req.user!.userId]);
    res.json({ projects: r.rows });
  } catch (err) { next(err); }
});

projectsRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const b = createSchema.parse(req.body);
    const ins = await query<{ id: string }>(
      'INSERT INTO projects (user_id, name, color, icon, instructions) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user!.userId, b.name, b.color ?? 'terracotta', b.icon ?? 'folder', b.instructions ?? ''],
    );
    const r = await query(`${SELECT} WHERE p.id = $1`, [ins.rows[0].id]);
    const p = r.rows[0];
    ensureProjectDir(req.user!.userId, { id: p.id, name: p.name, instructions: p.instructions });
    broadcastSse('conversation-update', { action: 'project', userId: req.user!.userId });
    res.status(201).json({ project: p });
  } catch (err) { next(err); }
});

projectsRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params as Record<string, string>;
    const b = updateSchema.parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const k of ['name', 'color', 'icon', 'instructions'] as const) {
      if (b[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(b[k]); }
    }
    if (!sets.length) throw new AppError(400, 'Nothing to update');
    sets.push('updated_at = NOW()');
    vals.push(id, req.user!.userId);
    const u = await query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING id`, vals);
    if (!u.rows[0]) throw new AppError(404, 'Project not found');
    const r = await query(`${SELECT} WHERE p.id = $1`, [id]);
    const p = r.rows[0];
    ensureProjectDir(req.user!.userId, { id: p.id, name: p.name, instructions: p.instructions });
    broadcastSse('conversation-update', { action: 'project', userId: req.user!.userId });
    res.json({ project: p });
  } catch (err) { next(err); }
});

// Deleting a project keeps its chats (project_id becomes null) and the files in the project dir
projectsRouter.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params as Record<string, string>;
    const d = await query('DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user!.userId]);
    if (!d.rows[0]) throw new AppError(404, 'Project not found');
    broadcastSse('conversation-update', { action: 'project', userId: req.user!.userId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
