import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, auditLog } from '../middleware/auth';
import { encrypt, decrypt } from '../services/crypto';
import { AppError } from '../middleware/errorHandler';
import { testConnector } from '../services/connectors';

export const connectorsRouter = Router();

const CONNECTOR_TYPES = ['git', 'github', 'ssh', 'sftp', 'ftp', 'smb', 'python', 'sudo', 'focustrack', 'google-search-console', 'ninjaone'] as const;
type ConnectorType = (typeof CONNECTOR_TYPES)[number];

// ── All routes below require authentication ──────────────────────────────────
connectorsRouter.use(requireAuth);

// List connectors
connectorsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const result = await query<{
      id: string; name: string; type: ConnectorType; config: Record<string, unknown>;
      is_active: boolean; test_status: string | null; test_message: string | null;
      last_tested_at: string | null; created_at: string;
    }>(
      `SELECT id, name, type, config, is_active, test_status, test_message, last_tested_at, created_at
       FROM connectors WHERE user_id = $1 ORDER BY created_at ASC`,
      [req.user!.userId],
    );
    res.json({ connectors: result.rows });
  } catch (err) {
    next(err);
  }
});

/** config.agent_ids: only own agents of this user (empty = every agent, as before). */
async function cleanConfig(userId: string, config: Record<string, unknown> | undefined): Promise<Record<string, unknown> | undefined> {
  if (!config || !('agent_ids' in config)) return config;
  const ids = Array.isArray(config.agent_ids) ? [...new Set((config.agent_ids as unknown[]).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))] : [];
  const own = ids.length ? (await query<{ id: string }>('SELECT id::text AS id FROM agents WHERE user_id = $1 AND id::text = ANY($2::text[])', [userId, ids])).rows.map((r) => r.id) : [];
  return { ...config, agent_ids: own };
}

const connectorSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(CONNECTOR_TYPES),
  config: z.record(z.string(), z.unknown()).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

// Create connector
connectorsRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const body = connectorSchema.parse(req.body);
    if (body.type === 'google-search-console') throw new AppError(400, 'Deze koppeling maak je met Inloggen met Google');

    body.config = await cleanConfig(req.user!.userId, body.config);
    const credEnc = body.credentials
      ? encrypt(JSON.stringify(body.credentials))
      : null;

    const result = await query<{ id: string; name: string; type: string; created_at: string }>(
      `INSERT INTO connectors (user_id, name, type, credentials_enc, config)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, type, created_at`,
      [req.user!.userId, body.name, body.type, credEnc, JSON.stringify(body.config ?? {})],
    );
    await auditLog(req.user!.userId, 'connector.create', 'connector', result.rows[0].id, req.ip ?? '', { type: body.type, name: body.name });
    res.status(201).json({ connector: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Get single connector
connectorsRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const result = await query(
      `SELECT id, name, type, config, is_active, test_status, test_message, last_tested_at, created_at
       FROM connectors WHERE id = $1 AND user_id = $2`,
      [String(req.params.id), req.user!.userId],
    );
    if (!result.rows[0]) throw new AppError(404, 'Connector not found');
    res.json({ connector: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Update connector
connectorsRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      credentials: z.record(z.string(), z.unknown()).optional(),
      isActive: z.boolean().optional(),
    });
    const body = schema.parse(req.body);
    const { id } = req.params as Record<string, string>;

    const owned = await query<{ id: string; type: string; name: string }>('SELECT id, type, name FROM connectors WHERE id = $1 AND user_id = $2', [id, req.user!.userId]);
    if (!owned.rows[0]) throw new AppError(404, 'Connector not found');

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined) { updates.push(`name = $${idx++}`); values.push(body.name); }
    body.config = await cleanConfig(req.user!.userId, body.config);
    if (body.config !== undefined) { updates.push(`config = $${idx++}`); values.push(JSON.stringify(body.config)); }
    if (body.credentials !== undefined) {
      updates.push(`credentials_enc = $${idx++}`);
      values.push(encrypt(JSON.stringify(body.credentials)));
    }
    if (body.isActive !== undefined) { updates.push(`is_active = $${idx++}`); values.push(body.isActive); }

    if (updates.length > 0) {
      values.push(id);
      await query(`UPDATE connectors SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    }
    await auditLog(req.user!.userId, 'connector.update', 'connector', id, req.ip ?? '', { id, type: owned.rows[0].type, name: body.name ?? owned.rows[0].name });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Delete connector
connectorsRouter.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const result = await query(
      'DELETE FROM connectors WHERE id = $1 AND user_id = $2',
      [String(req.params.id), req.user!.userId],
    );
    if (result.rowCount === 0) throw new AppError(404, 'Connector not found');
    await auditLog(req.user!.userId, 'connector.delete', 'connector', String(req.params.id), req.ip ?? '', { id: String(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Test connector
connectorsRouter.post('/:id/test', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params as Record<string, string>;
    const result = await query<{
      type: ConnectorType; config: Record<string, unknown>; credentials_enc: string | null;
    }>(
      'SELECT type, config, credentials_enc FROM connectors WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId],
    );

    if (!result.rows[0]) throw new AppError(404, 'Connector not found');
    const { type, config: connConfig, credentials_enc } = result.rows[0];
    let credentials: Record<string, unknown> = {};

    if (credentials_enc) {
      credentials = JSON.parse(decrypt(credentials_enc));
    }

    const testResult = await testConnector(type, connConfig, credentials);

    await query(
      `UPDATE connectors SET test_status = $1, test_message = $2, last_tested_at = NOW() WHERE id = $3`,
      [testResult.ok ? 'ok' : 'error', testResult.message, id],
    );

    await auditLog(req.user!.userId, 'connector.test', 'connector', id, req.ip ?? '', { id, type, ok: testResult.ok });
    res.json(testResult);
  } catch (err) {
    next(err);
  }
});

