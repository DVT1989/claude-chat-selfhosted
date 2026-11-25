/**
 * GRIPP (api3) as a per-user connector (type 'gripp'): static API token (Bearer), one JSON-RPC style endpoint.
 * Claude never sees the token: it gets a per-run token for the loopback proxy in routes/gripp.ts.
 */
import { randomBytes } from 'crypto';
import { query } from '../db';
import { redis } from '../redis';
import { decrypt } from './crypto';

export const GRIPP_TYPE = 'gripp';
export const GRIPP_URL = 'https://api.gripp.com/public/api3.php';
const TOKEN_TTL_SEC = 6 * 3600;

export async function testGripp(_config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const token = String(credentials.token ?? '').trim();
  if (!token) return { ok: false, message: 'API-token is verplicht' };
  let r: Response;
  try {
    r = await fetch(GRIPP_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify([{ method: 'employee.get', params: [[], { paging: { firstresult: 0, maxresults: 1 } }], id: 1 }]),
      signal: AbortSignal.timeout(15000),
    });
  } catch { return { ok: false, message: 'GRIPP-API niet bereikbaar' }; }
  if (r.status === 401 || r.status === 403) return { ok: false, message: 'GRIPP weigert het token. Controleer het API-token (GRIPP > Instellingen > API).' };
  if (!r.ok) return { ok: false, message: `GRIPP gaf HTTP ${r.status}` };
  const j = (await r.json().catch(() => null)) as unknown;
  const first = Array.isArray(j) ? (j[0] as { result?: { count?: number }; error?: unknown } | undefined) : (j as { result?: { count?: number }; error?: unknown } | null);
  if (!first) return { ok: false, message: 'Onverwacht antwoord van GRIPP' };
  if (first.error) return { ok: false, message: `GRIPP: ${JSON.stringify(first.error).slice(0, 160)}` };
  const n = first.result?.count;
  return { ok: true, message: `Verbonden met GRIPP${typeof n === 'number' ? `, ${n} medewerkers` : ''}` };
}

// per-run proxy token
const tokenKey = (t: string) => `gripp:claude:${t}`;
export async function issueGrippToken(userId: string, connectorId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redis.set(tokenKey(token), JSON.stringify({ userId, connectorId }), 'EX', TOKEN_TTL_SEC);
  return token;
}
export async function grippForToken(token: string): Promise<{ userId: string; connectorId: string } | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const v = await redis.get(tokenKey(token));
  if (!v) return null;
  try { return JSON.parse(v) as { userId: string; connectorId: string }; } catch { return null; }
}

/** API token of a stored connector of this user (owner of the connector, also for shared agents). */
export async function grippAuthFor(userId: string, connectorId: string): Promise<string> {
  const r = await query<{ credentials_enc: string | null; is_active: boolean }>(
    `SELECT credentials_enc, is_active FROM connectors WHERE id = $1 AND user_id = $2 AND type = 'gripp'`, [connectorId, userId]);
  const row = r.rows[0];
  if (!row || !row.is_active || !row.credentials_enc) throw new Error('GRIPP-koppeling niet beschikbaar of uitgeschakeld');
  const c = JSON.parse(decrypt(row.credentials_enc)) as Record<string, unknown>;
  const t = String(c.token ?? '').trim();
  if (!t) throw new Error('GRIPP-koppeling heeft geen token');
  return t;
}
