/**
 * Import a laptop history bundle (made by nas-history-sync/sync_history.py on the owner's PC).
 *
 *   node dist/scripts/importHistory.js --user <email prefix> --bundle /import/<file>.tgz
 *
 * Bundle: bundle.ndjson (one session per line), sessions/<sid>.jsonl, archive/<project>/<file>.md.
 * Each session becomes one conversation (dedup on metadata.laptop_session_id). A conversation that was
 * continued on the NAS is never overwritten: new laptop turns become a "(laptop, vervolg)" conversation.
 * Prints one JSON summary line on stdout.
 */
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { chownRun, loadRunUids } from '../services/runUsers';
import { createReadStream, existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, readFileSync, mkdtempSync, rmSync, chmodSync, createWriteStream } from 'fs';
import { once } from 'events';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import type { PoolClient } from 'pg';


export interface BundleMsg { role: 'user' | 'assistant'; content: string; created_at: string; tools: unknown[] }
export interface BundleSession {
  session_id: string; project: string; cwd: string; title: string;
  started_at: string; updated_at: string; messages: BundleMsg[]; sha256: string; archive_path: string;
}
export interface ImportPaths { homeDir: string; workspaceDir: string; chown: boolean }
export interface ImportSummary { created: number; updated: number; followups: number; skipped: number }

function own(p: string, paths: ImportPaths): void {
  if (paths.chown) chownRun(p);
}

function mkdirOwned(dir: string, paths: ImportPaths): void {
  if (existsSync(dir)) return;
  mkdirOwned(dirname(dir), paths);
  mkdirSync(dir, { mode: 0o755 });
  own(dir, paths);
}

/** Claude Code stores sessions under a folder named after the cwd with '/' replaced by '-'. */
export function projectFolder(paths: ImportPaths): string {
  return join(paths.homeDir, '.claude', 'projects', paths.workspaceDir.replace(/[^A-Za-z0-9]/g, '-'));
}

async function placeSession(bundleDir: string, fromSid: string, toSid: string, paths: ImportPaths): Promise<void> {
  const dir = projectFolder(paths);
  mkdirOwned(dir, paths);
  const dst = join(dir, `${toSid}.jsonl`);
  const src = join(bundleDir, 'sessions', `${fromSid}.jsonl`);
  if (fromSid === toSid) {
    copyFileSync(src, dst);
  } else {
    // a follow-up gets its own session id, so resume on the NAS does not mix it with the continued one.
    // Line by line: session files can be hundreds of MB.
    const out = createWriteStream(dst);
    const rl = createInterface({ input: createReadStream(src, 'utf8'), crlfDelay: Infinity });
    for await (const l of rl) {
      let line = l;
      if (l.trim()) {
        try {
          const o = JSON.parse(l);
          if (o.sessionId === fromSid) o.sessionId = toSid;
          if (o.session_id === fromSid) o.session_id = toSid;
          line = JSON.stringify(o);
        } catch { /* keep the line as it is */ }
      }
      if (!out.write(line + '\n')) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
  }
  chmodSync(dst, 0o600); // transcripts can hold private data, like Claude Code's own files
  own(dst, paths);
}

function placeArchive(bundleDir: string, s: BundleSession, paths: ImportPaths, previous?: unknown): void {
  const src = join(bundleDir, 'archive', s.archive_path);
  if (!existsSync(src)) return;
  const root = join(paths.workspaceDir, 'geschiedenis');
  const dst = join(root, s.archive_path);
  mkdirOwned(dirname(dst), paths);
  copyFileSync(src, dst);
  chmodSync(dst, 0o644);
  own(dst, paths);
  // the file name holds the title; when the title changed, drop the old copy so INDEX.md lists it once
  if (typeof previous === 'string' && previous && previous !== s.archive_path) {
    rmSync(join(root, previous), { force: true });
  }
}

/** Any message that did not come from the laptop means the conversation was continued on the NAS. */
async function hasNasTurns(db: PoolClient, conv: { id: string; metadata: Record<string, unknown> }): Promise<boolean> {
  if (conv.metadata.continued_on_nas) return true;
  const r = await db.query(
    `SELECT 1 FROM messages WHERE conversation_id = $1 AND (metadata->>'source') IS DISTINCT FROM 'laptop' LIMIT 1`,
    [conv.id],
  );
  return r.rows.length > 0;
}

async function replaceConversation(db: PoolClient, conv: { id: string; metadata: Record<string, unknown> }, s: BundleSession, title: string): Promise<void> {
  await db.query('DELETE FROM messages WHERE conversation_id = $1', [conv.id]);
  await insertMessages(db, conv.id, s.messages);
  await db.query(
    `UPDATE conversations SET title = $2, updated_at = $3::timestamptz,
            metadata = metadata || $4::jsonb WHERE id = $1`,
    [conv.id, title.slice(0, 500), s.updated_at || new Date().toISOString(),
      JSON.stringify({ laptop_sha256: s.sha256, archive_path: s.archive_path })],
  );
}

async function insertMessages(db: PoolClient, convId: string, msgs: BundleMsg[]): Promise<void> {
  for (const m of msgs) {
    await db.query(
      `INSERT INTO messages (conversation_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4::jsonb, COALESCE(NULLIF($5, '')::timestamptz, now()))`,
      [convId, m.role, m.content, JSON.stringify({ source: 'laptop', ...(m.tools?.length ? { tools: m.tools } : {}) }), m.created_at],
    );
  }
}

async function createConversation(db: PoolClient, userId: string, s: BundleSession, sid: string, title: string, extra: object): Promise<void> {
  const meta = {
    source: 'laptop', laptop_session_id: s.session_id, laptop_project: s.project, laptop_sha256: s.sha256,
    claude_session_id: sid, archive_path: s.archive_path, ...extra,
  };
  const r = await db.query<{ id: string }>(
    `INSERT INTO conversations (user_id, title, metadata, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz) RETURNING id`,
    [userId, title.slice(0, 500), JSON.stringify(meta), s.started_at || new Date().toISOString(), s.updated_at || new Date().toISOString()],
  );
  await insertMessages(db, r.rows[0].id, s.messages);
}

export async function importSession(db: PoolClient, userId: string, s: BundleSession, bundleDir: string, paths: ImportPaths): Promise<keyof ImportSummary> {
  const existing = await db.query<{ id: string; metadata: Record<string, unknown> }>(
    `SELECT id, metadata FROM conversations
      WHERE user_id = $1 AND metadata->>'laptop_session_id' = $2 AND NOT (metadata ? 'laptop_followup_of')
      ORDER BY created_at LIMIT 1`,
    [userId, s.session_id],
  );
  const title = `${s.project}: ${s.title}`;

  if (!existing.rows.length) {
    await createConversation(db, userId, s, s.session_id, title, {});
    await placeSession(bundleDir, s.session_id, s.session_id, paths);
    placeArchive(bundleDir, s, paths);
    return 'created';
  }
  const conv = existing.rows[0];
  if (conv.metadata.laptop_sha256 === s.sha256) return 'skipped';

  if (!(await hasNasTurns(db, conv))) {
    await replaceConversation(db, conv, s, title);
    await placeSession(bundleDir, s.session_id, s.session_id, paths);
    placeArchive(bundleDir, s, paths, conv.metadata.archive_path);
    return 'updated';
  }

  // Continued on the NAS: never touch it. New laptop turns go to the newest follow-up, as long as that
  // one was not continued on the NAS itself; otherwise a new follow-up is started.
  const follow = await db.query<{ id: string; metadata: Record<string, unknown> }>(
    `SELECT id, metadata FROM conversations WHERE user_id = $1 AND metadata->>'laptop_followup_of' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [userId, conv.id],
  );
  const last = follow.rows[0];
  if (last && last.metadata.laptop_sha256 === s.sha256) return 'skipped';
  if (last && !(await hasNasTurns(db, last))) {
    await replaceConversation(db, last, s, `${title} (laptop, vervolg)`);
    await placeSession(bundleDir, s.session_id, String(last.metadata.claude_session_id), paths);
    placeArchive(bundleDir, s, paths, last.metadata.archive_path);
    return 'updated';
  }
  const sid = randomUUID();
  await createConversation(db, userId, s, sid, `${title} (laptop, vervolg)`, { laptop_followup_of: conv.id });
  await placeSession(bundleDir, s.session_id, sid, paths);
  placeArchive(bundleDir, s, paths);
  return 'followups';
}

/** Rebuild geschiedenis/INDEX.md from the archive files that exist. */
export function writeIndex(paths: ImportPaths): void {
  const root = join(paths.workspaceDir, 'geschiedenis');
  if (!existsSync(root)) return;
  const rows: string[] = [];
  for (const proj of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(root, proj.name)).filter((n) => n.endsWith('.md'))) {
      const first = readFileSync(join(root, proj.name, f), 'utf8').split('\n', 1)[0].replace(/^# /, '').replace(/\|/g, '/');
      rows.push(`| ${first} | ${proj.name} | ${f.slice(0, 10)} | ${proj.name}/${f} |`);
    }
  }
  rows.sort((a, b) => (a.split('|')[3] < b.split('|')[3] ? 1 : -1));
  const md = ['# Eerdere gesprekken (laptop)', '', 'Nieuwste eerst. Zoek in deze map met grep.', '',
    '| Titel | Project | Datum | Bestand |', '|---|---|---|---|', ...rows, ''].join('\n');
  writeFileSync(join(root, 'INDEX.md'), md);
  own(join(root, 'INDEX.md'), paths);
}

/** Postgres text and jsonb cannot hold U+0000, which shows up in captured binary tool output. */
function stripNul(v: unknown): unknown {
  if (typeof v === 'string') return v.includes('\u0000') ? v.replace(/\u0000/g, '') : v;
  if (Array.isArray(v)) return v.map(stripNul);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripNul(x)]));
  return v;
}

export async function importBundle(dir: string, userId: string, db: PoolClient, paths: ImportPaths): Promise<ImportSummary> {
  const summary: ImportSummary = { created: 0, updated: 0, followups: 0, skipped: 0 };
  const rl = createInterface({ input: createReadStream(join(dir, 'bundle.ndjson'), 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const s = stripNul(JSON.parse(line)) as BundleSession;
    await db.query('BEGIN');
    try {
      summary[await importSession(db, userId, s, dir, paths)]++;
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw new Error(`session ${s.session_id}: ${(err as Error).message}`);
    }
  }
  writeIndex(paths);
  return summary;
}

async function main(): Promise<void> {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const user = arg('--user');
  const bundle = arg('--bundle');
  if (!user || !bundle) throw new Error('usage: importHistory --user <email prefix> --bundle <file.tgz>');

  const { pool } = await import('../db');
  const { config } = await import('../config');
  const u = await pool.query<{ id: string }>(`SELECT id FROM users WHERE split_part(email, '@', 1) = $1`, [user]);
  if (u.rows.length !== 1) throw new Error(`user "${user}" not found (or not unique)`);
  const userId = u.rows[0].id;
  await loadRunUids();

  const dir = mkdtempSync(join(tmpdir(), 'history-'));
  try {
    execFileSync('tar', ['-xzf', bundle, '-C', dir]);
    const db = await pool.connect();
    try {
      const paths: ImportPaths = {
        homeDir: join(config.claudeHomesRoot, `user-${userId}`),
        workspaceDir: join(config.workspaceRoot, userId),
        chown: true,
      };
      console.log(JSON.stringify(await importBundle(dir, userId, db, paths)));
    } finally {
      db.release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
}
