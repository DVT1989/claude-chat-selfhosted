import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, pool } from '../db';
import { ensureSharedProjectSchema, convAccess, projectAccess } from './sharedProjects';

// Needs a database; skipped when none is reachable (e.g. in the image build).
test('shared project access: only owner and members', async (t) => {
  try { await query('SELECT 1'); await ensureSharedProjectSchema(); } catch { t.skip('no database'); return; }
  const mk = async (n: string) => (await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1,'x',$1) RETURNING id`, [`t-${n}-${Date.now()}@test.invalid`])).rows[0].id;
  const [owner, member, outsider] = [await mk('o'), await mk('m'), await mk('x')];
  try {
    const pid = (await query<{ id: string }>(`INSERT INTO projects (user_id, name) VALUES ($1,'T') RETURNING id`, [owner])).rows[0].id;
    await query('INSERT INTO project_members (project_id, user_id, added_by) VALUES ($1,$2,$3)', [pid, member, owner]);
    const cid = (await query<{ id: string }>(`INSERT INTO conversations (user_id, title, model, project_id) VALUES ($1,'t','m',$2) RETURNING id`, [owner, pid])).rows[0].id;
    assert.ok(await convAccess(cid, owner));
    assert.ok(await convAccess(cid, member));
    assert.equal(await convAccess(cid, outsider), null);
    assert.equal((await projectAccess(pid, member))?.isOwner, false);
    assert.equal((await projectAccess(pid, owner))?.isOwner, true);
    assert.equal(await projectAccess(pid, outsider), null);
  } finally {
    await query('DELETE FROM conversations WHERE user_id = $1', [owner]);
    await query('DELETE FROM projects WHERE user_id = $1', [owner]);
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[owner, member, outsider]]);
    await pool.end().catch(() => undefined);
  }
});
