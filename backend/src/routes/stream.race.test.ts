// Two starts of the same conversation at the same moment: exactly one may run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db';
import { startConversationRun } from './stream';

let userId = '';
after(async () => {
  if (userId) {
    await new Promise((r) => setTimeout(r, 3000)); // let the (failing, not logged in) run finish first
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    const { rmSync } = await import('fs');
    const { join } = await import('path');
    const { config } = await import('../config');
    rmSync(join(config.claudeHomesRoot, `user-${userId}`), { recursive: true, force: true });
    rmSync(join(config.workspaceRoot, userId), { recursive: true, force: true });
  }
  await pool.end();
});

test('review: concurrent starts on one conversation give one run and one user message', async () => {
  userId = (await pool.query(`INSERT INTO users (email, password_hash, name, role) VALUES ('race-test-' || gen_random_uuid(), 'x', 'race', 'user') RETURNING id`)).rows[0].id;
  const conv = (await pool.query(`INSERT INTO conversations (user_id, title, model) VALUES ($1, 'race', 'haiku') RETURNING id, model, metadata`, [userId])).rows[0];
  const opts = (msg: string) => ({ userId, role: 'user', language: 'nl', conv, userMessage: msg, attachmentIds: [] });
  const [a, b] = await Promise.all([startConversationRun(opts('een')), startConversationRun(opts('twee'))]);
  assert.equal([a, b].filter((r) => r.busy).length, 1);
  const n = (await pool.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'user'`, [conv.id])).rows[0].n;
  assert.equal(n, 1);
});
