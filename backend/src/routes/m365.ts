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

m365Router.delete('/tenants/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(`DELETE FROM connectors WHERE id = $1 AND user_id = $2 AND type = 'm365'`, [String(req.params.id), req.user!.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
