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
    // keep the agent switches (Settings > Agents > Koppelingen) in step: an agent has access exactly when its switch is on
    const keys = Object.keys(access);
    await query('DELETE FROM agent_connectors WHERE connector_id = $1 AND NOT (agent_id::text = ANY($2::text[]))', [String(req.params.id), keys]);
    if (keys.length) await query('INSERT INTO agent_connectors (agent_id, connector_id) SELECT UNNEST($2::uuid[]), $1 ON CONFLICT DO NOTHING', [String(req.params.id), keys]);
    res.json({ access });
  } catch (err) { next(err); }
});

// Level of one agent that already has access (the switch under Settings > Agents > Koppelingen)
m365Router.put('/tenants/:id/access/:agentId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const level = (req.body ?? {}).level;
    if (level !== 'read' && level !== 'write') throw new AppError(400, 'Ongeldig niveau');
    const r = await query(`UPDATE connectors SET config = jsonb_set(config, ARRAY['agent_access', $3::text], to_jsonb($4::text)), updated_at = now()
                            WHERE id = $1 AND user_id = $2 AND type = 'm365' AND config->'agent_access' ? $3::text RETURNING id`,
      [String(req.params.id), req.user!.userId, String(req.params.agentId), level]);
    if (!r.rowCount) throw new AppError(404, 'Agent heeft geen toegang');
    res.json({ level });
  } catch (err) { next(err); }
});

m365Router.delete('/tenants/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(`DELETE FROM connectors WHERE id = $1 AND user_id = $2 AND type = 'm365'`, [String(req.params.id), req.user!.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
