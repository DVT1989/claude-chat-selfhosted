import { chmodSync, chownSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { pool } from '../db';
import { config } from '../config';

/**
 * Per-user OS identity. Every normal chat run gets its own uid (users.run_uid, from 20000, never reused),
 * so one user's chat cannot read another user's home (OAuth token) or workspace. The admin chat keeps
 * 1001:0; group root (gid 0) on the 2770 user dirs is what lets it in. Run uids are not in /etc/passwd
 * of a fresh container, so they are added at startup (ssh/scp need a passwd entry to find the home).
 */
export const ADMIN_UID = 1001;
const FIRST_UID = 20000;
const uids = new Map<string, number>();
let lastLoad = 0;

export async function ensureRunUserSchema(): Promise<void> {
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS users_run_uid_seq START ${FIRST_UID} MINVALUE ${FIRST_UID}`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS run_uid INTEGER');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_run_uid_key ON users(run_uid)');
  await pool.query(`UPDATE users SET run_uid = nextval('users_run_uid_seq') WHERE id IN (SELECT id FROM users WHERE run_uid IS NULL ORDER BY created_at, id)`);
  await pool.query(`ALTER TABLE users ALTER COLUMN run_uid SET DEFAULT nextval('users_run_uid_seq')`);
}

export async function loadRunUids(): Promise<void> {
  const r = await pool.query<{ id: string; run_uid: number }>('SELECT id, run_uid FROM users WHERE run_uid IS NOT NULL');
  for (const row of r.rows) uids.set(row.id, row.run_uid);
  lastLoad = Date.now();
}

/** Await this before the first sync use for a user (new users get their uid from the column default). */
export async function ensureRunUid(userId: string): Promise<number> {
  const have = uids.get(userId);
  if (have) return have;
  let r = await pool.query<{ run_uid: number | null }>('SELECT run_uid FROM users WHERE id = $1', [userId]);
  if (r.rows[0] && r.rows[0].run_uid == null) {
    r = await pool.query(`UPDATE users SET run_uid = nextval('users_run_uid_seq') WHERE id = $1 AND run_uid IS NULL RETURNING run_uid`, [userId]);
  }
  const uid = r.rows[0]?.run_uid;
  if (!uid) throw new Error(`Geen run_uid voor gebruiker ${userId}`);
  uids.set(userId, uid);
  try { addPasswd(userId, uid); } catch (e) { console.error('[runuser] passwd:', (e as Error).message); }
  try { ensureRunDirs(userId); } catch (e) { console.error('[runuser] dirs:', (e as Error).message); }
  return uid;
}

export function runUidOf(userId: string): number {
  const uid = uids.get(userId);
  if (!uid) throw new Error(`run_uid van ${userId} niet geladen`);
  return uid;
}

export const homeOfRun = (userId: string) => join(config.claudeHomesRoot, `user-${userId}`);
export const workspaceOfRun = (userId: string) => join(config.workspaceRoot, userId);

/** Owner for a path inside a user home or workspace: that user's run uid (group root); admin dirs 1001:0. */
function ownerFor(path: string): [number, number] | null {
  for (const root of [config.claudeHomesRoot, config.workspaceRoot]) {
    if (!path.startsWith(root + '/')) continue;
    const seg = path.slice(root.length + 1).split('/')[0];
    if (seg.startsWith('admin-') || seg.startsWith('_admin-')) return [ADMIN_UID, 0];
    const uid = uids.get(seg.replace(/^user-/, ''));
    return uid ? [uid, 0] : null;
  }
  return null;
}

/** chown a file the backend (root) wrote in a user's home/workspace to that user's run uid, group root. */
export function chownRun(path: string): void {
  const o = ownerFor(path);
  if (!o) { console.warn('[runuser] geen eigenaar voor', path); return; }
  chownSync(path, o[0], o[1]);
}

/** Recursive variant (symlinks themselves, not their targets). */
export function chownRunTree(path: string): void {
  const o = ownerFor(path);
  if (!o) return;
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { execFileSync('chown', ['-h', `${o[0]}:${o[1]}`, p]); return; }
    chownSync(p, o[0], o[1]);
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  };
  walk(path);
}

/** uid/gid to spawn a run with. Privileged (admin chat) stays 1001:0; others get their own uid and private gid. */
export function spawnIds(userId: string, privileged?: boolean, gidOverride?: number | null): { uid: number; gid: number } {
  if (privileged) return { uid: ADMIN_UID, gid: 0 };
  const uid = runUidOf(userId);
  // shared project: the project group gives access to the shared project dir
  return { uid, gid: gidOverride ?? uid };
}

function addPasswd(userId: string, uid: number): void {
  const name = `cc${uid}`;
  const home = homeOfRun(userId);
  const pw = readFileSync('/etc/passwd', 'utf8');
  if (!new RegExp(`^[^:]*:[^:]*:${uid}:`, 'm').test(pw)) appendFileSync('/etc/passwd', `${name}:x:${uid}:${uid}:Claude user:${home}:/bin/bash\n`);
  const gr = readFileSync('/etc/group', 'utf8');
  if (!new RegExp(`^[^:]*:[^:]*:${uid}:`, 'm').test(gr)) appendFileSync('/etc/group', `${name}:x:${uid}:\n`);
}

/** Top-level dirs: owner run uid, group root, 2770 (setgid keeps new files in group root, so the admin chat can read them). */
function ensureRunDirs(userId: string): void {
  const uid = uids.get(userId)!;
  for (const d of [homeOfRun(userId), workspaceOfRun(userId)]) {
    if (!existsSync(d)) continue;
    const st = statSync(d);
    if (st.uid !== uid || st.gid !== 0) chownSync(d, uid, 0);
    if ((st.mode & 0o7777) !== 0o2770) chmodSync(d, 0o2770);
  }
}

/** Startup: schema, uids, passwd entries and a one-time chown -R of existing homes and workspaces. */
export async function initRunUsers(): Promise<void> {
  await ensureRunUserSchema();
  await loadRunUids();
  for (const [userId, uid] of uids) {
    try { addPasswd(userId, uid); } catch (e) { console.error('[runuser] passwd:', (e as Error).message); }
    for (const d of [homeOfRun(userId), workspaceOfRun(userId)]) {
      if (!existsSync(d)) continue;
      const marker = join(d, '.run-uid');
      let done = false;
      try { done = readFileSync(marker, 'utf8').trim() === String(uid); } catch { /* not migrated yet */ }
      try {
        if (!done) {
          execFileSync('chown', ['-R', '-h', `${uid}:0`, d]);
          execFileSync('find', [d, '-type', 'd', '!', '-perm', '-2000', '-exec', 'chmod', 'g+s', '{}', '+']);
          writeFileSync(marker, String(uid), { mode: 0o644 });
          chownSync(marker, uid, 0);
          console.log(`[runuser] ${d} -> ${uid}:0`);
        } else {
          execFileSync('find', [d, '!', '-user', String(uid), '-exec', 'chown', '-h', `${uid}:0`, '{}', '+']);
        }
      } catch (e) { console.error('[runuser] migratie', d, (e as Error).message); }
    }
    try { ensureRunDirs(userId); } catch (e) { console.error('[runuser] dirs:', (e as Error).message); }
  }
  setInterval(() => { if (Date.now() - lastLoad > 60_000) void loadRunUids().catch(() => undefined); }, 60_000).unref();
}
