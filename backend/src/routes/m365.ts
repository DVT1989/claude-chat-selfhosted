import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { startDeviceLogin, deviceLoginStatus } from '../services/m365';

export const m365Router = Router();
m365Router.use(requireAuth);

m365Router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await startDeviceLogin(req.user!.userId)); } catch (err) { next(new AppError(502, (err as Error).message)); }
});

m365Router.get('/login', (req: Request, res: Response) => {
  const s = deviceLoginStatus(req.user!.userId);
  res.json(s ? { status: s.status, message: s.message ?? null, tenantName: s.tenantName ?? null } : { status: 'none' });
});

m365Router.get('/tenants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT id, name, config, is_active, test_status, test_message, updated_at FROM connectors
        WHERE user_id = $1 AND type = 'm365' ORDER BY name`, [req.user!.userId]);
    res.json({ tenants: r.rows });
  } catch (err) { next(err); }
});

// Rights per agent for this tenant (opt-in): 'read' (token with only read rights) or 'write'; no entry = no access
m365Router.put('/tenants/:id/access', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { access?: Record<string, unknown> };
    const own = await query<{ id: string }>('SELECT id::text AS id FROM agents WHERE user_id = $1', [req.user!.userId]);
    const ids = new Set(own.rows.map((r) => r.id));
    const access: Record<string, 'read' | 'write'> = {};
    for (const [k, v] of Object.entries(body.access ?? {})) if (ids.has(k) && (v === 'read' || v === 'write')) access[k] = v;
    const r = await query(`UPDATE connectors SET config = config || jsonb_build_object('agent_access', $3::jsonb, 'agent_access_v', 2), updated_at = now()
                            WHERE id = $1 AND user_id = $2 AND type = 'm365' RETURNING id`,
      [String(req.params.id), req.user!.userId, JSON.stringify(access)]);
    if (!r.rowCount) throw new AppError(404, 'Tenant niet gevonden');
    res.json({ access });
  } catch (err) { next(err); }
});

m365Router.delete('/tenants/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(`DELETE FROM connectors WHERE id = $1 AND user_id = $2 AND type = 'm365'`, [String(req.params.id), req.user!.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
