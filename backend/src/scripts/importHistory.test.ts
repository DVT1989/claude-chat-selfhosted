// Run inside the backend container: node --test dist/scripts/importHistory.test.js
// Uses a throwaway schema (test_import) with copies of the real tables; public data is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PoolClient } from 'pg';
import { pool } from '../db';
import { importBundle, projectFolder, BundleSession, ImportPaths } from './importHistory';

let db: PoolClient;
let root: string;
let paths: ImportPaths;
const USER = '00000000-0000-0000-0000-00000000aaaa';
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

function session(n: number, sha: string, sid = SID, title = 'NAS controle'): BundleSession {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}`, created_at: `2026-11-01T10:0${i}:00Z`, tools: [] });
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { session_id: sid, project: 'Bureaublad', cwd: 'C:/x', title, started_at: '2026-11-01T10:00:00Z',
    updated_at: `2026-11-01T10:0${Math.min(n - 1, 9)}:00Z`, messages, sha256: sha, archive_path: `bureaublad/2026-11-01_${slug}_${sid.slice(0, 8)}.md` };
}

function writeBundle(s: BundleSession): string {
  const dir = mkdtempSync(join(root, 'b-'));
  mkdirSync(join(dir, 'sessions'));
  mkdirSync(join(dir, 'archive', 'bureaublad'), { recursive: true });
  writeFileSync(join(dir, 'bundle.ndjson'), JSON.stringify(s) + '\n');
  writeFileSync(join(dir, 'sessions', `${s.session_id}.jsonl`), JSON.stringify({ type: 'user', sessionId: s.session_id }) + '\n');
  // bundles made on Windows arrive world-writable
  chmodSync(join(dir, 'sessions', `${s.session_id}.jsonl`), 0o666);
  writeFileSync(join(dir, 'archive', s.archive_path), '# NAS controle\n');
  chmodSync(join(dir, 'archive', s.archive_path), 0o666);
  return dir;
}

async function convs() {
  return (await db.query(`SELECT id, title, metadata FROM conversations WHERE user_id = $1 ORDER BY created_at, title`, [USER])).rows;
}

before(async () => {
  db = await pool.connect();
  await db.query('DROP SCHEMA IF EXISTS test_import CASCADE; CREATE SCHEMA test_import');
  await db.query('CREATE TABLE test_import.conversations (LIKE public.conversations INCLUDING DEFAULTS)');
  await db.query('CREATE TABLE test_import.messages (LIKE public.messages INCLUDING DEFAULTS)');
  await db.query('SET search_path TO test_import, public');
  root = mkdtempSync(join(tmpdir(), 'imp-test-'));
  paths = { homeDir: join(root, 'home'), workspaceDir: '/workspace/' + USER, chown: false };
  paths.workspaceDir = join(root, 'workspace', USER);
});

after(async () => {
  await db.query('SET search_path TO public; DROP SCHEMA IF EXISTS test_import CASCADE');
  db.release();
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

test('new session creates one conversation with its messages and files', async () => {
  const s0 = session(4, 'h1');
  const r = await importBundle(writeBundle(s0), USER, db, paths);
  assert.deepEqual(r, { created: 1, updated: 0, followups: 0, skipped: 0 });
  const c = await convs();
  assert.equal(c.length, 1);
  assert.equal(c[0].title, 'Bureaublad: NAS controle');
  assert.equal(c[0].metadata.claude_session_id, SID);
  const m = (await db.query('SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at', [c[0].id])).rows;
  assert.equal(m.length, 4);
  assert.equal(m[0].created_at.toISOString(), '2026-11-01T10:00:00.000Z');
  assert.ok(existsSync(join(projectFolder(paths), `${SID}.jsonl`)));
  assert.equal(statSync(join(projectFolder(paths), `${SID}.jsonl`)).mode & 0o777, 0o600);
  assert.equal(statSync(join(paths.workspaceDir, 'geschiedenis', s0.archive_path)).mode & 0o777, 0o644);
  assert.ok(readFileSync(join(paths.workspaceDir, 'geschiedenis', 'INDEX.md'), 'utf8').includes('| NAS controle | bureaublad | 2026-11-01 |'));
});

test('same session again is skipped', async () => {
  const r = await importBundle(writeBundle(session(4, 'h1')), USER, db, paths);
  assert.deepEqual(r, { created: 0, updated: 0, followups: 0, skipped: 1 });
});

test('grown session replaces the messages', async () => {
  const r = await importBundle(writeBundle(session(6, 'h2')), USER, db, paths);
  assert.equal(r.updated, 1);
  const c = await convs();
  assert.equal(c.length, 1);
  const n = (await db.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [c[0].id])).rows[0].n;
  assert.equal(n, 6);
});

test('continued on the NAS: original untouched, new laptop turns become a follow-up', async () => {
  const [c] = await convs();
  await db.query(`UPDATE conversations SET metadata = metadata || '{"continued_on_nas": true}' WHERE id = $1`, [c.id]);
  const r = await importBundle(writeBundle(session(8, 'h3')), USER, db, paths);
  assert.equal(r.followups, 1);
  const all = await convs();
  assert.equal(all.length, 2);
  const follow = all.find((x) => x.metadata.laptop_followup_of === c.id)!;
  assert.equal(follow.title, 'Bureaublad: NAS controle (laptop, vervolg)');
  assert.notEqual(follow.metadata.claude_session_id, SID);
  const moved = readFileSync(join(projectFolder(paths), `${follow.metadata.claude_session_id}.jsonl`), 'utf8');
  assert.ok(moved.includes(follow.metadata.claude_session_id));
  const orig = (await db.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [c.id])).rows[0].n;
  assert.equal(orig, 6);
  const again = await importBundle(writeBundle(session(8, 'h3')), USER, db, paths);
  assert.equal(again.skipped, 1);
});

test('a later laptop change updates the existing follow-up instead of adding another', async () => {
  const r = await importBundle(writeBundle(session(10, 'h4')), USER, db, paths);
  assert.equal(r.updated, 1);
  const all = await convs();
  assert.equal(all.length, 2);
  const follow = all.find((x) => x.metadata.laptop_followup_of)!;
  const n = (await db.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [follow.id])).rows[0].n;
  assert.equal(n, 10);
});

const SID2 = 'bbbbbbbb-1111-2222-3333-444444444444';
test('NAS turns protect a conversation even when the flag was never set', async () => {
  await importBundle(writeBundle(session(2, 'x1', SID2)), USER, db, paths);
  const c = (await convs()).find((x) => x.metadata.laptop_session_id === SID2 && !x.metadata.laptop_followup_of)!;
  await db.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'vanaf de NAS')`, [c.id]);
  const r = await importBundle(writeBundle(session(4, 'x2', SID2)), USER, db, paths);
  assert.equal(r.followups, 1);
  const kept = (await db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND content = 'vanaf de NAS'`, [c.id])).rows[0].n;
  assert.equal(kept, 1);
});

const SID3 = 'cccccccc-1111-2222-3333-444444444444';
test('a new title replaces the archive file instead of adding a second one', async () => {
  const a = session(2, 'y1', SID3, 'Oude titel');
  await importBundle(writeBundle(a), USER, db, paths);
  const b = session(4, 'y2', SID3, 'Nieuwe titel');
  await importBundle(writeBundle(b), USER, db, paths);
  assert.ok(!existsSync(join(paths.workspaceDir, 'geschiedenis', a.archive_path)));
  assert.ok(existsSync(join(paths.workspaceDir, 'geschiedenis', b.archive_path)));
  const index = readFileSync(join(paths.workspaceDir, 'geschiedenis', 'INDEX.md'), 'utf8');
  assert.equal(index.split('cccccccc').length - 1, 1);
});

const SID4 = 'dddddddd-1111-2222-3333-444444444444';
test('NUL characters (not allowed in Postgres text/jsonb) are dropped', async () => {
  const s = session(2, 'z1', SID4, 'Nul');
  s.messages[0].content = 'a\u0000b';
  s.messages[1].tools = [{ name: 'Bash', input: { command: 'x\u0000y' }, result: '\u0000' }];
  const r = await importBundle(writeBundle(s), USER, db, paths);
  assert.equal(r.created, 1);
  const c = (await convs()).find((x) => x.metadata.laptop_session_id === SID4)!;
  const m = (await db.query('SELECT content FROM messages WHERE conversation_id = $1 ORDER BY created_at', [c.id])).rows;
  assert.equal(m[0].content, 'ab');
});
