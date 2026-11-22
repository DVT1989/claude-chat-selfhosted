import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { query } from '../db';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getUserWorkspace } from '../services/claudeCode';
import { randomUUID } from 'crypto';

const router = Router();
router.use(requireAuth);

router.post('/:conversationId/attachments', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { conversationId } = req.params as Record<string, string>;
    const { fileName, mimeType, data } = req.body as { fileName: string; mimeType: string; data: string };

    if (!fileName || !mimeType || !data) {
      return res.status(400).json({ error: 'fileName, mimeType, data required' });
    }

    const conv = await query(
      "SELECT id FROM conversations WHERE id = $1 AND user_id = $2 AND status != 'deleted'",
      [conversationId, userId]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > 20 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 20MB)' });
    }

    const uuid = randomUUID();
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const storedName = `${uuid}_${safeFileName}`;

    const workspace = getUserWorkspace(userId);
    const attachDir = join(workspace, 'attachments', conversationId);
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(join(attachDir, storedName), buffer);

    const result = await query(
      `INSERT INTO conversation_attachments (conversation_id, user_id, original_name, stored_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, conversation_id, original_name, mime_type, size_bytes, created_at`,
      [conversationId, userId, fileName, storedName, mimeType, buffer.length]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[attachments] upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

router.get('/:conversationId/attachments', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { conversationId } = req.params as Record<string, string>;

    const result = await query(
      `SELECT id, conversation_id, original_name, mime_type, size_bytes, created_at
       FROM conversation_attachments
       WHERE conversation_id = $1 AND user_id = $2 AND sent_at IS NULL
       ORDER BY created_at ASC`,
      [conversationId, userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list attachments' });
  }
});

router.delete('/:conversationId/attachments/:attachmentId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { conversationId, attachmentId } = req.params as Record<string, string>;

    const result = await query(
      `DELETE FROM conversation_attachments
       WHERE id = $1 AND conversation_id = $2 AND user_id = $3
       RETURNING stored_name`,
      [attachmentId, conversationId, userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const workspace = getUserWorkspace(userId);
    const filePath = join(workspace, 'attachments', conversationId, result.rows[0].stored_name as string);
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});


router.get('/:conversationId/attachments/:attachmentId/content', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { conversationId, attachmentId } = req.params as Record<string, string>;
    const result = await query<{ stored_name: string; mime_type: string; original_name: string }>(
      'SELECT stored_name, mime_type, original_name FROM conversation_attachments WHERE id = $1 AND conversation_id = $2 AND user_id = $3',
      [attachmentId, conversationId, userId]
    );
    if (!result.rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const att = result.rows[0];
    const filePath = join(getUserWorkspace(userId), 'attachments', conversationId, att.stored_name);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'File not found' }); return; }
    // Whitelist of safe inline MIME types — others forced as download to prevent XSS
    const SAFE_INLINE = new Set([
      'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
      'image/avif', 'image/x-icon', 'image/bmp',
      'application/pdf',
      'text/plain',
    ]);
    const safeMime = SAFE_INLINE.has(att.mime_type.toLowerCase()) ? att.mime_type : 'application/octet-stream';
    res.setHeader('Content-Type', safeMime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (!SAFE_INLINE.has(att.mime_type.toLowerCase())) {
      const safeName = att.original_name.replace(/[^\w.\-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }
    res.send(readFileSync(filePath));
  } catch (err) {
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

export { router as attachmentsRouter };
