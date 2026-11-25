/**
 * iCloud mail as a per-user connector (type 'icloud'): IMAP on imap.mail.me.com:993 with an app-specific password.
 * Read, search, move, flag and create drafts only: no SMTP, no delete, no EXPUNGE.
 * Claude never sees the password: it gets a per-run token for the loopback proxy in routes/icloud.ts.
 */
import { randomBytes } from 'crypto';
import { ImapFlow } from 'imapflow';
import { query } from '../db';
import { redis } from '../redis';
import { decrypt } from './crypto';

export const ICLOUD_HOST = 'imap.mail.me.com';
const TOKEN_TTL_SEC = 6 * 3600;

function newClient(user: string, pass: string): ImapFlow {
  const c = new ImapFlow({ host: ICLOUD_HOST, port: 993, secure: true, auth: { user, pass }, logger: false, socketTimeout: 60000 });
  c.on('error', () => undefined);
  return c;
}

export async function testIcloud(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const user = String(config.user ?? '').trim();
  const pass = String(credentials.password ?? '').trim();
  if (!user || !pass) return { ok: false, message: 'Apple-ID en app-specifiek wachtwoord zijn verplicht' };
  const c = newClient(user, pass);
  try {
    await c.connect();
    const list = await c.list();
    return { ok: true, message: `Verbonden met iCloud Mail, ${list.length} mappen` };
  } catch (e) {
    const m = (e as Error).message ?? '';
    return { ok: false, message: /auth|credential|login/i.test(m) ? 'iCloud weigert de login. Gebruik een app-specifiek wachtwoord (appleid.apple.com).' : `iCloud niet bereikbaar: ${m.slice(0, 120)}` };
  } finally { try { await c.logout(); } catch { /* ignore */ } }
}

// per-run proxy token
const tokenKey = (t: string) => `icloud:claude:${t}`;
export async function issueIcloudToken(userId: string, connectorId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redis.set(tokenKey(token), JSON.stringify({ userId, connectorId }), 'EX', TOKEN_TTL_SEC);
  return token;
}
export async function icloudForToken(token: string): Promise<{ userId: string; connectorId: string } | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const v = await redis.get(tokenKey(token));
  if (!v) return null;
  try { return JSON.parse(v) as { userId: string; connectorId: string }; } catch { return null; }
}

/** Open a session for a stored connector (owner of the connector), run fn, always log out. */
export async function withIcloud<T>(userId: string, connectorId: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const r = await query<{ config: Record<string, unknown> | null; credentials_enc: string | null; is_active: boolean }>(
    `SELECT config, credentials_enc, is_active FROM connectors WHERE id = $1 AND user_id = $2 AND type = 'icloud'`, [connectorId, userId]);
  const row = r.rows[0];
  if (!row || !row.is_active || !row.credentials_enc) throw new Error('iCloud-koppeling niet beschikbaar of uitgeschakeld');
  const cred = JSON.parse(decrypt(row.credentials_enc)) as Record<string, unknown>;
  const user = String(row.config?.user ?? '').trim();
  const pass = String(cred.password ?? '').trim();
  if (!user || !pass) throw new Error('iCloud-koppeling is onvolledig');
  const c = newClient(user, pass);
  await c.connect();
  try { return await fn(c); } finally { try { await c.logout(); } catch { /* ignore */ } }
}
