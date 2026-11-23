import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, requireAdmin, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

/** Simple user groups (admin only): a name and its members. Used for sharing agents. */
export const groupsRouter = Router();
groupsRouter.use(requireAuth, requireAdmin);
groupsRouter.param('id', (_req, _res, next, id: string) => next(/^[0-9a-f-]{36}$/i.test(id) ? undefined : new AppError(404, 'Groep niet gevonden')));

async function list() {
  const r = await query<{ id: string; name: string; members: string[] }>(
    `SELECT g.id, g.name, COALESCE(array_agg(m.user_id::text) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
     FROM user_groups g LEFT JOIN user_group_members m ON m.group_id = g.id GROUP BY g.id ORDER BY g.name`);
  return r.rows;
}

const body = z.object({ name: z.string().trim().min(1).max(60), members: z.array(z.string().uuid()).max(500).default([]) });

async function setMembers(groupId: string, members: string[]) {
  const ids = [...new Set(members)];
  if (ids.length) {
    const ok = await query('SELECT 1 FROM users WHERE id = ANY($1::uuid[])', [ids]);
    if (ok.rowCount !== ids.length) throw new AppError(400, 'Onbekende gebruiker');
  }
  await query('DELETE FROM user_group_members WHERE group_id = $1', [groupId]);
  if (ids.length) await query('INSERT INTO user_group_members (group_id, user_id) SELECT $1, unnest($2::uuid[])', [groupId, ids]);
}

const dup = (err: unknown) => (err as { code?: string }).code === '23505' ? new AppError(409, 'Er is al een groep met die naam') : err;

groupsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await query<{ id: string; name: string }>('SELECT id, name FROM users WHERE is_active ORDER BY name');
    res.json({ groups: await list(), users: users.rows });
  } catch (err) { next(err); }
});
groupsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = body.parse(req.body);
    const r = await query<{ id: string }>('INSERT INTO user_groups (name) VALUES ($1) RETURNING id', [b.name]);
    await setMembers(r.rows[0].id, b.members);
    await auditLog(req.user!.userId, 'group.create', 'group', r.rows[0].id, req.ip ?? '', { name: b.name });
    res.status(201).json({ groups: await list() });
  } catch (err) { next(dup(err)); }
});
groupsRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = body.parse(req.body), id = String(req.params.id);
    const r = await query('UPDATE user_groups SET name = $2 WHERE id = $1', [id, b.name]);
    if (!r.rowCount) throw new AppError(404, 'Groep niet gevonden');
    await setMembers(id, b.members);
    await auditLog(req.user!.userId, 'group.update', 'group', id, req.ip ?? '', { name: b.name, members: b.members.length });
    res.json({ groups: await list() });
  } catch (err) { next(dup(err)); }
});
groupsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const r = await query('DELETE FROM user_groups WHERE id = $1', [id]);
    if (!r.rowCount) throw new AppError(404, 'Groep niet gevonden');
    // drop the group from agents that were shared with it
    await query('UPDATE agents SET share_groups = array_remove(share_groups, $1::uuid) WHERE $1::uuid = ANY(share_groups)', [id]);
    await auditLog(req.user!.userId, 'group.delete', 'group', id, req.ip ?? '', {});
    res.json({ groups: await list() });
  } catch (err) { next(err); }
});
