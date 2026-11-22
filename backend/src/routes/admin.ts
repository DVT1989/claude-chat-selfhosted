import { Router, Request, Response, NextFunction } from 'express';
import { refreshModels } from './models';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db';
import { sessions } from '../redis';
import { requireAuth, requireAdmin, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { getAuthStatus } from '../services/claudeCode';

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { createBackup, listBackups, restoreBackup, deleteBackup, restartBackend, BACKUP_ROOT } from '../services/backup';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.post('/models/refresh', async (_req: Request, res: Response, next) => {
  try {
    const models = await refreshModels();
    res.json({ ok: true, count: models.length, models });
  } catch (err) {
    next(err);
  }
});

// List all users
adminRouter.get('/users', async (_req: Request, res: Response, next) => {
  try {
    const result = await query(
      `SELECT id, email, name, role, is_active, created_at,
              (SELECT COUNT(*) FROM conversations WHERE user_id = users.id) as conversation_count
       FROM users ORDER BY created_at DESC`,
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// Create local user (admin only)
adminRouter.post('/users', async (req: Request, res: Response, next) => {
  try {
    const schema = z.object({
      username: z.string().min(1).max(255),
      name: z.string().min(1).max(255),
      password: z.string().min(8).max(128),
      role: z.enum(['user', 'admin']).default('user'),
    });
    const body = schema.parse(req.body);

    const existing = await query('SELECT id FROM users WHERE email = $1', [body.username.toLowerCase()]);
    if (existing.rows.length > 0) throw new AppError(409, 'Gebruikersnaam al in gebruik');

    const passwordHash = await bcrypt.hash(body.password, 12);
    const result = await query<{ id: string; email: string; name: string; role: string }>(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role`,
      [body.username.toLowerCase(), passwordHash, body.name, body.role],
    );
    await auditLog(req.user!.userId, 'admin.user.create', 'user', result.rows[0].id, req.ip ?? '', { email: body.username, role: body.role });
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Delete user
adminRouter.delete('/users/:id', async (req: Request, res: Response, next) => {
  try {
    if (String(req.params.id) === req.user!.userId) throw new AppError(400, 'Je kunt jezelf niet verwijderen');
    const result = await query('DELETE FROM users WHERE id = $1', [String(req.params.id)]);
    if (result.rowCount === 0) throw new AppError(404, 'Gebruiker niet gevonden');
    // Force-logout the deleted user from every device (FK ON DELETE CASCADE on sessions table will clean PG rows,
    // but Redis session entries are independent and must be flushed explicitly).
    await sessions.delAll(String(req.params.id));
    await query('DELETE FROM sessions WHERE user_id = $1', [String(req.params.id)]).catch(() => {});
    await auditLog(req.user!.userId, 'admin.user.delete', 'user', String(req.params.id), req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Update user (role, active status)
adminRouter.put('/users/:id', async (req: Request, res: Response, next) => {
  try {
    const schema = z.object({
      role: z.enum(['user', 'admin']).optional(),
      isActive: z.boolean().optional(),
      /** an admin sets a new password (e.g. the user forgot it) */
      password: z.string().min(8).max(200).optional(),
    });
    const body = schema.parse(req.body);
    // An admin demoting or disabling themselves would lock everyone out of user management.
    if (String(req.params.id) === req.user!.userId && (body.role === 'user' || body.isActive === false)) {
      throw new AppError(400, 'Je kunt je eigen rol of account niet uitzetten');
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.role !== undefined) { updates.push(`role = $${idx++}`); values.push(body.role); }
    if (body.isActive !== undefined) { updates.push(`is_active = $${idx++}`); values.push(body.isActive); }
    if (body.password !== undefined) { updates.push(`password_hash = $${idx++}`); values.push(await bcrypt.hash(body.password, 12)); }

    if (updates.length === 0) { res.json({ ok: true }); return; }

    values.push(String(req.params.id));
    const result = await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    if (result.rowCount === 0) throw new AppError(404, 'User not found');

    // Role or active-state changes must take effect immediately on every device the user is logged in on.
    // Demoting an admin or disabling a user while they hold a stale JWT would otherwise leave them with their old powers
    // until the JWT expires. delAll wipes Redis sessions; the SQL DELETE wipes the audit/persistence table.
    if (body.role !== undefined || body.isActive !== undefined || body.password !== undefined) {
      await sessions.delAll(String(req.params.id));
      await query('DELETE FROM sessions WHERE user_id = $1', [String(req.params.id)]).catch(() => {});
    }

    // never log the password itself
    await auditLog(req.user!.userId, 'admin.user.update', 'user', String(req.params.id), req.ip ?? '', { ...body, password: body.password ? '(gewijzigd)' : undefined });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// System stats
adminRouter.get('/stats', async (_req: Request, res: Response, next) => {
  try {
    const [users, conversations, messages, usage] = await Promise.all([
      query('SELECT COUNT(*) FROM users WHERE is_active = true'),
      query("SELECT COUNT(*) FROM conversations WHERE status != 'deleted'"),
      query('SELECT COUNT(*) FROM messages'),
      query('SELECT SUM(input_tokens + output_tokens) as total_tokens FROM usage_logs'),
    ]);

    res.json({
      users: parseInt((users.rows[0] as { count: string }).count, 10),
      conversations: parseInt((conversations.rows[0] as { count: string }).count, 10),
      messages: parseInt((messages.rows[0] as { count: string }).count, 10),
      totalTokens: parseInt((usage.rows[0] as { total_tokens: string }).total_tokens ?? '0', 10),
    });
  } catch (err) {
    next(err);
  }
});

// Get or create the system conversation for this admin
adminRouter.post('/system/conversation/reset', async (req: Request, res: Response, next) => {
  try {
    // Mark all existing system conversations for this user as deleted
    await query(
      `UPDATE conversations SET status = 'deleted'
       WHERE user_id = $1 AND (metadata->>'isSystem')::boolean = true AND status != 'deleted'`,
      [req.user!.userId],
    );
    // Create a fresh one
    const created = await query<{ id: string }>(
      `INSERT INTO conversations (user_id, title, metadata)
       VALUES ($1, 'Systeem Beheer', '{"isSystem": true}'::jsonb)
       RETURNING id`,
      [req.user!.userId],
    );
    res.json({ conversationId: created.rows[0].id });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/system/conversation', async (req: Request, res: Response, next) => {
  try {
    // Check Claude auth
    const authStatus = await getAuthStatus(req.user!.userId);

    // Find existing system conversation
    const existing = await query<{
      id: string; title: string; updated_at: string; created_at: string;
    }>(
      `SELECT id, title, updated_at, created_at FROM conversations
       WHERE user_id = $1 AND (metadata->>'isSystem')::boolean = true AND status != 'deleted'
       ORDER BY created_at ASC LIMIT 1`,
      [req.user!.userId],
    );

    let conversationId: string;
    let isNew = false;

    if (existing.rows[0]) {
      conversationId = existing.rows[0].id;
    } else {
      const created = await query<{ id: string }>(
        `INSERT INTO conversations (user_id, title, metadata)
         VALUES ($1, 'Systeem Beheer', '{"isSystem": true}'::jsonb)
         RETURNING id`,
        [req.user!.userId],
      );
      conversationId = created.rows[0].id;
      isNew = true;
    }

    const messages = await query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId],
    );

    res.json({
      conversationId,
      isNew,
      claudeAuthStatus: authStatus,
      messages: messages.rows,
    });
  } catch (err) {
    next(err);
  }
});

// List active sessions for a user
adminRouter.get('/users/:id/sessions', async (req: Request, res: Response, next) => {
  try {
    const result = await query(
      `SELECT id, user_id, ip_address, user_agent, expires_at, created_at
       FROM sessions WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [String(req.params.id)],
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    next(err);
  }
});

// Revoke all sessions for a user (force logout on every device)
adminRouter.delete('/users/:id/sessions', async (req: Request, res: Response, next) => {
  try {
    await sessions.delAll(String(req.params.id));
    const result = await query('DELETE FROM sessions WHERE user_id = $1', [String(req.params.id)]);
    await auditLog(req.user!.userId, 'admin.sessions.revoke', 'user', String(req.params.id), req.ip ?? '', { revoked: result.rowCount ?? 0 });
    res.json({ revoked: result.rowCount ?? 0 });
  } catch (err) {
    next(err);
  }
});

// Audit logs
adminRouter.get('/logs', async (req: Request, res: Response, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string ?? '100', 10), 500);
    const offset = parseInt(req.query.offset as string ?? '0', 10);

    const result = await query(
      `SELECT al.*, u.email FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       ORDER BY al.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    res.json({ logs: result.rows });
  } catch (err) {
    next(err);
  }
});

// Backups run in this process (the former admin-claude container was merged into the backend).
adminRouter.get('/backups', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ backups: listBackups() });
  } catch (err) {
    next(err);
  }
});

// Create backup now
adminRouter.post('/backups/now', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entry = await createBackup();
    await auditLog(req.user!.userId, 'backup.create', 'backup', null, req.ip ?? '', {});
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

// Delete a backup
adminRouter.delete('/backups/:name', async (req: Request, res: Response, next: NextFunction) => {
  const name = String(req.params.name);
  try {
    deleteBackup(name);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    await auditLog(req.user!.userId, 'backup.delete', 'backup', name, req.ip ?? '', { name });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Download a backup as a tar.gz
adminRouter.get('/backups/:name/download', (req: Request, res: Response) => {
  const name = String(req.params.name);
  if (!/^[\w\-]+$/.test(name)) { res.status(400).json({ error: 'Invalid backup name' }); return; }
  if (!existsSync(join(BACKUP_ROOT, name))) { res.status(404).json({ error: 'Backup not found' }); return; }

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="backup-${name}.tar.gz"`);
  const tar = spawn('tar', ['-czf', '-', '-C', BACKUP_ROOT, name]);
  tar.stdout.pipe(res);
  tar.stderr.on('data', (d: Buffer) => console.error('[backup download tar]', d.toString()));
  tar.on('error', (err) => {
    console.error('[backup download] tar spawn error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'tar failed' });
    else res.end();
  });
  tar.on('close', (code) => {
    if (code !== 0 && !res.headersSent) res.status(500).json({ error: `tar exit ${code}` });
    else if (!res.writableEnded) res.end();
  });
});

// Restore a backup
adminRouter.post('/backups/:name/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Log BEFORE the operation: restore may invalidate the JWT mid-flight.
    await auditLog(req.user!.userId, 'backup.restore', 'backup', String(req.params.name), req.ip ?? '', { name: String(req.params.name) });
    await restoreBackup(String(req.params.name));
    res.json({ ok: true });
    // The restore replaced the database and volumes under this process: restart it once the reply is out.
    setTimeout(() => {
      try { restartBackend(); } catch (err) { console.error('[backup] restart after restore failed:', err); }
    }, 1000);
  } catch (err) {
    next(err);
  }
});
