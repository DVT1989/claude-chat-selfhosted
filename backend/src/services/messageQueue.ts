/**
 * Messages typed while Claude is busy wait here (like Claude Code) and run one by one when the
 * current answer is done. Stored in the database so the queue keeps going with the app closed
 * and survives a backend restart.
 */
import { query } from '../db';

export interface QueuedMessage { id: string; content: string; created_at: string; attachment_ids: string[] }

export async function ensureQueueSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      sort DOUBLE PRECISION NOT NULL DEFAULT extract(epoch from clock_timestamp()),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query('CREATE INDEX IF NOT EXISTS message_queue_conv_idx ON message_queue (conversation_id, sort)');
  await query(`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS attachment_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
}

export async function listQueue(conversationId: string): Promise<QueuedMessage[]> {
  const r = await query<QueuedMessage>(
    'SELECT id, content, created_at, attachment_ids FROM message_queue WHERE conversation_id = $1 ORDER BY sort, created_at',
    [conversationId]);
  return r.rows;
}

export async function enqueue(conversationId: string, userId: string, content: string, attachmentIds: string[] = []): Promise<void> {
  await query('INSERT INTO message_queue (conversation_id, user_id, content, attachment_ids) VALUES ($1, $2, $3, $4::jsonb)', [conversationId, userId, content, JSON.stringify(attachmentIds)]);
}

export async function removeQueued(conversationId: string, id: string): Promise<boolean> {
  const r = await query('DELETE FROM message_queue WHERE id = $1 AND conversation_id = $2', [id, conversationId]);
  return (r.rowCount ?? 0) > 0;
}

/** Puts an item first in line. */
export async function moveToFront(conversationId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE message_queue SET sort = (SELECT COALESCE(MIN(sort), 0) - 1 FROM message_queue WHERE conversation_id = $1)
     WHERE id = $2 AND conversation_id = $1`, [conversationId, id]);
  return (r.rowCount ?? 0) > 0;
}

/** Takes the first item off the queue (atomically, so two drains never run the same message). */
export async function popFirst(conversationId: string): Promise<{ content: string; user_id: string; attachment_ids: string[] } | null> {
  const r = await query<{ content: string; user_id: string; attachment_ids: string[] }>(
    `DELETE FROM message_queue WHERE id = (
       SELECT id FROM message_queue WHERE conversation_id = $1 ORDER BY sort, created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING content, user_id, attachment_ids`, [conversationId]);
  return r.rows[0] ?? null;
}

/** Conversations with waiting messages (to resume after a restart). */
export async function conversationsWithQueue(): Promise<string[]> {
  const r = await query<{ conversation_id: string }>('SELECT DISTINCT conversation_id FROM message_queue');
  return r.rows.map((x) => x.conversation_id);
}
