import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { scheduleResume, cancelScheduledResume, getScheduledResumeTime, getScheduledResumeInfo } from '../services/scheduler';
import { broadcastSse } from '../services/sseEvents';
import { messagePreview } from '../services/preview';

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

// List conversations for current user
conversationsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string ?? '50', 10), 100);
    const offset = parseInt(req.query.offset as string ?? '0', 10);

    const result = await query<{
      id: string; title: string; model: string; status: string;
      provider_account_id: string | null; token_count: number;
      updated_at: string; created_at: string;
      last_role: string | null; last_tail: string | null;
    }>(
      `SELECT c.id, c.title, c.model, c.status, c.provider_account_id,
              c.token_count, c.updated_at, c.created_at,
              lm.role AS last_role, lm.tail AS last_tail
       FROM conversations c
       -- Last message for the WhatsApp-style preview line; only its tail (tool answers can be huge)
       LEFT JOIN LATERAL (
         SELECT m.role, right(m.content, 6000) AS tail
         FROM messages m
         WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant')
         ORDER BY m.created_at DESC
         LIMIT 1
       ) lm ON true
       WHERE c.user_id = $1 AND c.status != 'deleted'
         -- the admin system conversation lives under Settings → Admin-chat, not in the chat list
         AND COALESCE((c.metadata->>'isSystem')::boolean, false) = false
         -- Claude sessions on a device live in that device's activity log, not in the chat list
         AND COALESCE((c.metadata->>'device_log')::boolean, false) = false
         -- device terminal sessions (Claude taking over a terminal) live on the device page
         AND c.metadata->>'deviceTerminal' IS NULL
         -- agent workplaces (delegations) are reached through their card in the parent conversation
         AND c.metadata->>'delegation_id' IS NULL
       ORDER BY c.updated_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user!.userId, limit, offset],
    );

    res.json({
      conversations: result.rows.map(({ last_role, last_tail, ...c }) => ({
        ...c,
        last_message: last_role ? { role: last_role, preview: messagePreview(last_tail) } : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Get single conversation + messages
conversationsRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params as Record<string, string>;

    const convResult = await query<{
      id: string; user_id: string; title: string; model: string;
      status: string; provider_account_id: string | null;
      token_count: number; metadata: Record<string, unknown>;
      updated_at: string; created_at: string;
    }>(
      `SELECT id, user_id, title, model, status, provider_account_id,
              token_count, metadata, updated_at, created_at
       FROM conversations WHERE id = $1 AND user_id = $2`,
      [id, req.user!.userId],
    );

    if (!convResult.rows[0]) throw new AppError(404, 'Conversation not found');

    const messagesResult = await query(
      `SELECT id, conversation_id, role, content, token_count, metadata, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id],
    );

    const connectorsResult = await query(
      `SELECT c.id, c.name, c.type FROM connectors c
       INNER JOIN conversation_connectors cc ON cc.connector_id = c.id
       WHERE cc.conversation_id = $1`,
      [id],
    );

    res.json({
      conversation: convResult.rows[0],
      messages: messagesResult.rows,
      connectors: connectorsResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// Create conversation
conversationsRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const schema = z.object({
      title: z.string().min(1).max(500).optional(),
      model: z.string().max(100).optional(),
      connectorIds: z.array(z.string().uuid()).optional(),
      /** a Claude session on this device: kept out of the chat list, shown in the device's activities */
      deviceId: z.string().uuid().optional(),
    });
    const body = schema.parse(req.body);

    // Resolve initial model: explicit body.model > user's default_model > 'sonnet'
    let initialModel = body.model;
    if (!initialModel) {
      const u = await query<{ default_model: string | null }>(
        'SELECT default_model FROM users WHERE id = $1',
        [req.user!.userId],
      );
      initialModel = u.rows[0]?.default_model ?? 'sonnet';
    }

    const result = await query<{
      id: string; title: string; model: string; status: string;
      token_count: number; updated_at: string; created_at: string;
    }>(
      `INSERT INTO conversations (user_id, title, model, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, title, model, status, token_count, updated_at, created_at`,
      [
        req.user!.userId,
        body.title ?? 'New conversation',
        initialModel,
        JSON.stringify(body.deviceId ? { device_id: body.deviceId, device_log: true } : {}),
      ],
    );

    const conv = result.rows[0];

    // Link connectors
    if (body.connectorIds?.length) {
      for (const connId of body.connectorIds) {
        const check = await query(
          'SELECT id FROM connectors WHERE id = $1 AND user_id = $2',
          [connId, req.user!.userId],
        );
        if (check.rows[0]) {
          await query(
            'INSERT INTO conversation_connectors (conversation_id, connector_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [conv.id, connId],
          );
        }
      }
    }

    broadcastSse('conversation-update', { action: 'created', userId: req.user!.userId });
    res.status(201).json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

// Update conversation
// Push per conversation: off unless switched on (metadata.push_on)
conversationsRouter.get('/:id/push', async (req: Request, res: Response, next) => {
  try {
    const r = await query<{ on: boolean | null }>("SELECT (metadata->>'push_on')::boolean AS on FROM conversations WHERE id = $1 AND user_id = $2", [String(req.params.id), req.user!.userId]);
    if (!r.rows[0]) throw new AppError(404, 'Conversation not found');
    res.json({ on: !!r.rows[0].on });
  } catch (err) { next(err); }
});

conversationsRouter.put('/:id/push', async (req: Request, res: Response, next) => {
  try {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    const r = await query("UPDATE conversations SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'push_muted') || jsonb_build_object('push_on', $1::boolean) WHERE id = $2 AND user_id = $3 RETURNING id", [on, String(req.params.id), req.user!.userId]);
    if (!r.rows[0]) throw new AppError(404, 'Conversation not found');
    res.json({ on });
  } catch (err) { next(err); }
});

conversationsRouter.put('/:id', async (req: Request, res: Response, next) => {
  try {
    const schema = z.object({
      title: z.string().min(1).max(500).optional(),
      model: z.string().max(100).optional(),
      status: z.enum(['active', 'archived']).optional(),
      connectorIds: z.array(z.string().uuid()).optional(),
    });
    const body = schema.parse(req.body);
    const { id } = req.params as Record<string, string>;

    // Verify ownership
    const owned = await query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [id, req.user!.userId]);
    if (!owned.rows[0]) throw new AppError(404, 'Conversation not found');

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.title !== undefined) { updates.push(`title = $${idx++}`); values.push(body.title); }
    if (body.model !== undefined) { updates.push(`model = $${idx++}`); values.push(body.model); }
    if (body.status !== undefined) { updates.push(`status = $${idx++}`); values.push(body.status); }

    if (updates.length > 0) {
      values.push(id);
      await query(`UPDATE conversations SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    }

    if (body.connectorIds !== undefined) {
      await query('DELETE FROM conversation_connectors WHERE conversation_id = $1', [id]);
      for (const connId of body.connectorIds) {
        const check = await query('SELECT id FROM connectors WHERE id = $1 AND user_id = $2', [connId, req.user!.userId]);
        if (check.rows[0]) {
          await query('INSERT INTO conversation_connectors (conversation_id, connector_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, connId]);
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Delete conversation
conversationsRouter.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const result = await query(
      "UPDATE conversations SET status = 'deleted' WHERE id = $1 AND user_id = $2",
      [String(req.params.id), req.user!.userId],
    );
    if (result.rowCount === 0) throw new AppError(404, 'Conversation not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Export conversation as JSON
conversationsRouter.get('/:id/export', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params as Record<string, string>;
    const convResult = await query(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId],
    );
    if (!convResult.rows[0]) throw new AppError(404, 'Conversation not found');

    const messagesResult = await query(
      'SELECT role, content, token_count, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [id],
    );
    const stateResult = await query('SELECT state FROM conversation_states WHERE conversation_id = $1', [id]);

    const exported = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      conversation: convResult.rows[0],
      messages: messagesResult.rows,
      state: stateResult.rows[0]?.state ?? null,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="conversation-${id}.json"`);
    res.json(exported);
  } catch (err) {
    next(err);
  }
});

// ── Schedule-resume routes ────────────────────────────────────

// GET: check if a resume is scheduled for this conversation
conversationsRouter.get('/:id/schedule-resume', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params as Record<string, string>;
    // Verify ownership
    const owned = await query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2 AND status != $3', [id, req.user!.userId, 'deleted']);
    if (!owned.rows[0]) throw new AppError(404, 'Conversation not found');

    const scheduledFor = await getScheduledResumeTime(id);
    // agentsOnly: only interrupted agents wait (their bubbles show it), not the conversation itself
    const info = await getScheduledResumeInfo(id);
    res.json({ scheduledFor: scheduledFor?.toISOString() ?? null, agents: info?.agents ?? [], agentsOnly: !!info && !info.message });
  } catch (err) { next(err); }
});

// POST: schedule a resume
conversationsRouter.post('/:id/schedule-resume', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params as Record<string, string>;
    const schema = z.object({
      message: z.string().min(1).max(32000),
      scheduledFor: z.string().datetime(),
    });
    const body = schema.parse(req.body);

    // Verify ownership
    const owned = await query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2 AND status != $3', [id, req.user!.userId, 'deleted']);
    if (!owned.rows[0]) throw new AppError(404, 'Conversation not found');

    const executeAt = new Date(body.scheduledFor);
    await scheduleResume({ userId: req.user!.userId, conversationId: id, message: body.message }, executeAt);

    res.json({ ok: true, scheduledFor: executeAt.toISOString() });
  } catch (err) { next(err); }
});

// DELETE: cancel a scheduled resume
conversationsRouter.delete('/:id/schedule-resume', async (req: Request, res: Response, next) => {
  try {
    const { id } = req.params as Record<string, string>;
    const owned = await query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [id, req.user!.userId]);
    if (!owned.rows[0]) throw new AppError(404, 'Conversation not found');

    await cancelScheduledResume(id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Import conversation
conversationsRouter.post('/import', async (req: Request, res: Response, next) => {
  try {
    const schema = z.object({
      conversation: z.object({
        title: z.string(),
        model: z.string(),
      }),
      messages: z.array(z.object({
        role: z.string(),
        content: z.string(),
      })),
    });
    const body = schema.parse(req.body);

    const convResult = await query<{ id: string }>(
      `INSERT INTO conversations (user_id, title, model)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.user!.userId, body.conversation.title, body.conversation.model],
    );
    const convId = convResult.rows[0].id;

    for (const msg of body.messages) {
      await query(
        'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
        [convId, msg.role, msg.content],
      );
    }

    res.status(201).json({ conversationId: convId });
  } catch (err) {
    next(err);
  }
});
