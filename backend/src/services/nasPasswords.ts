/**
 * Password manager of Browser (NAS): per user, per origin. The password is only stored encrypted
 * (services/crypto.ts, as with connectors) and is never logged. Claude only ever gets id + username.
 */
import { query } from '../db';
import { encrypt, decrypt } from './crypto';

export interface PwAccount { id: string; username: string }
export interface PwRow extends PwAccount { origin: string; host: string; created_at: string; updated_at: string }

export async function ensureNasPasswordTables(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS nas_passwords (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    origin TEXT NOT NULL, host TEXT NOT NULL, username TEXT NOT NULL, password_enc TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, origin, username))`);
  await query('CREATE INDEX IF NOT EXISTS idx_nas_passwords_user_origin ON nas_passwords(user_id, origin)');
  await query(`CREATE TABLE IF NOT EXISTS nas_password_never (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, origin TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (user_id, origin))`);
}

/** http(s) origin of a URL (scheme, host, port); null for data:, about:, file: and the like. */
export function originOf(url: string): { origin: string; host: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { origin: u.origin, host: u.hostname.replace(/^www\./, '') + (u.port ? `:${u.port}` : '') };
  } catch { return null; }
}

const cache = new Map<string, { at: number; list: PwAccount[] }>();
const key = (userId: string, origin: string) => `${userId}|${origin}`;
const bust = (userId: string, origin?: string) => { if (origin) cache.delete(key(userId, origin)); else for (const k of cache.keys()) if (k.startsWith(`${userId}|`)) cache.delete(k); };

export async function accountsFor(userId: string, origin: string): Promise<PwAccount[]> {
  const c = cache.get(key(userId, origin));
  if (c && Date.now() - c.at < 5000) return c.list;
  const r = await query<PwAccount>('SELECT id, username FROM nas_passwords WHERE user_id = $1 AND origin = $2 ORDER BY lower(username)', [userId, origin]);
  cache.set(key(userId, origin), { at: Date.now(), list: r.rows });
  return r.rows;
}

export async function listAll(userId: string): Promise<PwRow[]> {
  const r = await query<PwRow>('SELECT id, origin, host, username, created_at, updated_at FROM nas_passwords WHERE user_id = $1 ORDER BY lower(host), lower(username)', [userId]);
  return r.rows;
}

/** 'new' | 'same' (identical password already saved) | 'update' (account exists with another password) */
export async function compare(userId: string, origin: string, username: string, password: string): Promise<'new' | 'same' | 'update'> {
  const r = await query<{ password_enc: string }>('SELECT password_enc FROM nas_passwords WHERE user_id = $1 AND origin = $2 AND username = $3', [userId, origin, username]);
  if (!r.rows[0]) return 'new';
  try { return decrypt(r.rows[0].password_enc) === password ? 'same' : 'update'; } catch { return 'update'; }
}

export async function save(userId: string, origin: string, host: string, username: string, password: string): Promise<void> {
  await query(
    `INSERT INTO nas_passwords (user_id, origin, host, username, password_enc) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, origin, username) DO UPDATE SET password_enc = EXCLUDED.password_enc, host = EXCLUDED.host, updated_at = NOW()`,
    [userId, origin, host, username, encrypt(password)]);
  bust(userId, origin);
}

export async function remove(userId: string, id: string): Promise<boolean> {
  const r = await query<{ origin: string }>('DELETE FROM nas_passwords WHERE id = $1 AND user_id = $2 RETURNING origin', [id, userId]);
  bust(userId);
  return !!r.rows[0];
}

/** Decrypted password of one account of this user. Only for filling and for the reveal click of the owner. */
export async function secret(userId: string, id: string): Promise<{ origin: string; username: string; password: string } | null> {
  const r = await query<{ origin: string; username: string; password_enc: string }>('SELECT origin, username, password_enc FROM nas_passwords WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = r.rows[0];
  if (!row) return null;
  return { origin: row.origin, username: row.username, password: decrypt(row.password_enc) };
}

export async function isNever(userId: string, origin: string): Promise<boolean> {
  const r = await query('SELECT 1 FROM nas_password_never WHERE user_id = $1 AND origin = $2', [userId, origin]);
  return r.rows.length > 0;
}
export async function setNever(userId: string, origin: string): Promise<void> {
  await query('INSERT INTO nas_password_never (user_id, origin) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, origin]);
}
