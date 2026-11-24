/**
 * NinjaOne (RMM/PSA) as a per-user connector (type 'ninjaone'): OAuth2 client_credentials, token cached until it expires.
 * Claude never sees the client secret: it gets a per-run token for the loopback proxy in routes/ninjaone.ts.
 */
import { randomBytes } from 'crypto';
import { query } from '../db';
import { redis } from '../redis';
import { decrypt } from './crypto';

export const NINJA_TYPE = 'ninjaone';
export const NINJA_REGIONS: Record<string, string> = {
  eu: 'https://eu.ninjarmm.com', app: 'https://app.ninjarmm.com', ca: 'https://ca.ninjarmm.com',
  oc: 'https://oc.ninjarmm.com', us2: 'https://us2.ninjarmm.com',
};
const SCOPE = 'monitoring management';
const TOKEN_TTL_SEC = 6 * 3600;

/** Instance URL from the config: a known region, or an own https URL (host only). */
export function ninjaBase(config: Record<string, unknown>): string {
  const region = String(config.region ?? 'eu').trim().toLowerCase();
  if (NINJA_REGIONS[region]) return NINJA_REGIONS[region];
  const raw = String(config.url ?? (region.startsWith('http') ? region : '')).trim();
  const m = raw.match(/^(?:https?:\/\/)?([a-z0-9.-]+(?::\d+)?)/i);
  return m ? `https://${m[1].toLowerCase()}` : '';
}

const cache = new Map<string, { token: string; exp: number }>();

export async function ninjaAccessToken(base: string, clientId: string, clientSecret: string): Promise<string> {
  const key = `${base}|${clientId}|${clientSecret.slice(-6)}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  let r: Response;
  try {
    r = await fetch(`${base}/ws/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: SCOPE }),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error(`NinjaOne-server ${base} niet bereikbaar. Klopt de regio?`); }
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (r.status === 400 || r.status === 401) throw new Error(`NinjaOne weigert Client ID of Client Secret${j.error_description ? ` (${String(j.error_description).slice(0, 120)})` : ''}. Controleer ook de regio en of de app van het type API-diensten (client credentials) is.`);
    throw new Error(`NinjaOne gaf HTTP ${r.status} bij het inloggen`);
  }
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('NinjaOne gaf geen token terug');
  cache.set(key, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

export async function testNinja(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const base = ninjaBase(config);
  const id = String(credentials.client_id ?? '').trim();
  const secret = String(credentials.client_secret ?? '').trim();
  if (!base) return { ok: false, message: 'Kies een regio of vul een eigen adres in' };
  if (!id || !secret) return { ok: false, message: 'Client ID en Client Secret zijn verplicht' };
  let token: string;
  try { token = await ninjaAccessToken(base, id, secret); } catch (e) { return { ok: false, message: (e as Error).message }; }
  let r: Response;
  try { r = await fetch(`${base}/v2/users?userType=TECHNICIAN`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
  catch { return { ok: false, message: `NinjaOne-server ${base} niet bereikbaar` }; }
  if (r.status === 403) return { ok: false, message: 'Ingelogd, maar geen recht op gebruikers. Geef de app de scope Management en Monitoring.' };
  if (!r.ok) return { ok: false, message: `NinjaOne gaf HTTP ${r.status} bij het ophalen van technici` };
  const list = (await r.json().catch(() => null)) as unknown;
  const n = Array.isArray(list) ? list.length : 0;
  return { ok: true, message: `Verbonden met ${base.replace('https://', '')}, ${n} ${n === 1 ? 'technicus' : 'technici'}` };
}

// ── per-run proxy token ─────────────────────────────────────
const tokenKey = (t: string) => `ninjaone:claude:${t}`;
export async function issueNinjaToken(userId: string, connectorId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redis.set(tokenKey(token), JSON.stringify({ userId, connectorId }), 'EX', TOKEN_TTL_SEC);
  return token;
}
export async function ninjaForToken(token: string): Promise<{ userId: string; connectorId: string } | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const v = await redis.get(tokenKey(token));
  if (!v) return null;
  try { return JSON.parse(v) as { userId: string; connectorId: string }; } catch { return null; }
}

/** Base URL and a fresh access token for a stored connector of this user. */
export async function ninjaAuthFor(userId: string, connectorId: string): Promise<{ base: string; token: string }> {
  const r = await query<{ config: Record<string, unknown>; credentials_enc: string | null; is_active: boolean }>(
    `SELECT config, credentials_enc, is_active FROM connectors WHERE id = $1 AND user_id = $2 AND type = 'ninjaone'`, [connectorId, userId]);
  const row = r.rows[0];
  if (!row || !row.is_active || !row.credentials_enc) throw new Error('NinjaOne-koppeling niet beschikbaar of uitgeschakeld');
  const c = JSON.parse(decrypt(row.credentials_enc)) as Record<string, unknown>;
  const base = ninjaBase(row.config);
  return { base, token: await ninjaAccessToken(base, String(c.client_id ?? ''), String(c.client_secret ?? '')) };
}

// ── which agents may use a connector (config.agent_ids; empty = everyone, as before) ──
/** Agent ids behind a run: workplace of a delegation, scheduled task of an agent, Telegram agent bot. Empty = the owner's main Claude. */
export async function runAgentIds(meta: Record<string, unknown>): Promise<string[]> {
  const ids = new Set<string>();
  if (typeof meta.delegated_agent_id === 'string') ids.add(meta.delegated_agent_id);
  if (Array.isArray(meta.telegram_agent_ids)) for (const a of meta.telegram_agent_ids) ids.add(String(a));
  if (typeof meta.task_id === 'string') {
    try {
      const r = await query<{ agent_id: string | null }>('SELECT agent_id::text AS agent_id FROM scheduled_tasks WHERE id::text = $1', [meta.task_id]);
      if (r.rows[0]?.agent_id) ids.add(r.rows[0].agent_id);
    } catch { /* ignore */ }
  }
  return [...ids];
}
export function connectorAllowed(config: Record<string, unknown>, runAgents: string[]): boolean {
  const allowed = Array.isArray(config.agent_ids) ? (config.agent_ids as unknown[]).map(String) : [];
  if (!allowed.length || !runAgents.length) return true;
  return runAgents.some((a) => allowed.includes(a));
}
