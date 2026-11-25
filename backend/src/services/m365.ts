/**
 * Microsoft 365 / Entra ID tenants as connectors, via the OAuth device-code flow.
 * Client: "Microsoft Graph Command Line Tools" (a Microsoft public client, the same one Graph PowerShell
 * uses), so no app registration is needed. Delegated Graph scopes: read-only, except adding/assigning
 * Intune apps and writing files in OneDrive/SharePoint the account itself may edit; one connector per tenant.
 */
import { query } from '../db';
import { encrypt, decrypt } from './crypto';

export const M365_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const BASE_SCOPES = [
  'offline_access', 'User.Read', 'User.Read.All', 'Group.Read.All', 'Directory.Read.All', 'Organization.Read.All',
  'AuditLog.Read.All', 'Reports.Read.All', 'Policy.Read.All',
  'DeviceManagementManagedDevices.Read.All', 'DeviceManagementConfiguration.Read.All',
  'DeviceManagementApps.ReadWrite.All', // add + assign Intune apps (only after the user confirms)
  'Mail.Read', 'Mail.Read.Shared', // own mailbox + shared mailboxes this account may open
];
const toScope = (list: string[]) => list.map((s) => (s === 'offline_access' ? s : `https://graph.microsoft.com/${s}`)).join(' ');
export const M365_SCOPES = toScope([...BASE_SCOPES,
  'Files.ReadWrite.All', // OneDrive and SharePoint files this account can open, and write where it may edit
  'Calendars.Read', // own calendar (planning, hours)
]);
/** Read rights: what an agent set to "Lezen" gets (a token with only these, so it cannot write). */
export const M365_READ_SCOPES = toScope(['offline_access', 'User.Read', 'User.Read.All', 'Group.Read.All', 'Directory.Read.All', 'Organization.Read.All',
  'AuditLog.Read.All', 'Reports.Read.All', 'Policy.Read.All', 'DeviceManagementManagedDevices.Read.All', 'DeviceManagementConfiguration.Read.All',
  'DeviceManagementApps.Read.All', 'Mail.Read', 'Mail.Read.Shared', 'Files.Read.All', 'Calendars.Read']);
/** What tenants linked before 2026-11-20 consented to; their refresh keeps working until they link again. */
const LEGACY_SCOPES = toScope([...BASE_SCOPES, 'Files.Read.All']);

const loginBase = () => process.env.M365_LOGIN_BASE ?? 'https://login.microsoftonline.com';
const graphBase = () => process.env.M365_GRAPH_BASE ?? 'https://graph.microsoft.com';

export interface DeviceLogin { userCode: string; verificationUri: string; expiresAt: string }
type Pending = { status: 'pending' | 'done' | 'error'; message?: string; tenantName?: string; login: DeviceLogin };
const pending = new Map<string, Pending>();

async function form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function tenantName(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${graphBase()}/v1.0/organization?$select=displayName`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as { value?: Array<{ displayName?: string }> };
    return j.value?.[0]?.displayName ?? null;
  } catch {
    return null;
  }
}

/** Save (or replace) the connector of one tenant for this user. */
async function saveTenant(userId: string, tokens: Record<string, unknown>): Promise<string> {
  const access = String(tokens.access_token ?? '');
  const claims = jwtClaims(access);
  const tenantId = String(claims.tid ?? '');
  const account = String(claims.upn ?? claims.unique_name ?? claims.preferred_username ?? '');
  const name = (await tenantName(access)) ?? tenantId;
  const creds = encrypt(JSON.stringify({ refresh_token: tokens.refresh_token }));
  const config = { tenantId, tenantName: name, account };
  const upd = await query(
    `UPDATE connectors SET config = $3::jsonb, credentials_enc = $4, is_active = true, test_status = 'ok',
            last_tested_at = now(), updated_at = now()
      WHERE user_id = $1 AND type = 'm365' AND config->>'tenantId' = $2`,
    [userId, tenantId, JSON.stringify(config), creds]);
  if (!upd.rowCount) {
    await query(
      `INSERT INTO connectors (user_id, name, type, config, credentials_enc, is_active, test_status, last_tested_at)
       VALUES ($1, $2, 'm365', $3::jsonb, $4, true, 'ok', now())`,
      [userId, `M365 ${name}`.slice(0, 255), JSON.stringify(config), creds]);
  }
  return name;
}

/** Start a device-code login; the backend keeps polling until the user signed in (or it expired). */
export async function startDeviceLogin(userId: string, pollMs?: number): Promise<DeviceLogin> {
  const d = await form(`${loginBase()}/organizations/oauth2/v2.0/devicecode`, { client_id: M365_CLIENT_ID, scope: M365_SCOPES });
  if (!d.device_code) throw new Error(String(d.error_description ?? 'Microsoft gaf geen code terug'));
  const login: DeviceLogin = {
    userCode: String(d.user_code),
    verificationUri: String(d.verification_uri ?? 'https://microsoft.com/devicelogin'),
    expiresAt: new Date(Date.now() + Number(d.expires_in ?? 900) * 1000).toISOString(),
  };
  const state: Pending = { status: 'pending', login };
  pending.set(userId, state);
  const interval = pollMs ?? Number(d.interval ?? 5) * 1000;
  void (async () => {
    while (pending.get(userId) === state && Date.now() < Date.parse(login.expiresAt)) {
      await new Promise((r) => setTimeout(r, interval));
      const t = await form(`${loginBase()}/organizations/oauth2/v2.0/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: M365_CLIENT_ID, device_code: String(d.device_code),
      }).catch(() => ({ error: 'network' }) as Record<string, unknown>);
      if (t.access_token) {
        try {
          state.tenantName = await saveTenant(userId, t);
          state.status = 'done';
        } catch (err) {
          state.status = 'error'; state.message = (err as Error).message;
        }
        return;
      }
      if (t.error && !['authorization_pending', 'slow_down', 'network'].includes(String(t.error))) {
        state.status = 'error';
        state.message = String(t.error_description ?? t.error).split('\n')[0];
        return;
      }
    }
    if (state.status === 'pending') { state.status = 'error'; state.message = 'De code is verlopen. Probeer het opnieuw.'; }
  })();
  return login;
}

export function deviceLoginStatus(userId: string): Pending | null {
  return pending.get(userId) ?? null;
}

/**
 * Fresh Graph access token for a tenant connector (called at the start of every Claude run).
 * Stores the rotated refresh token so the 90-day sliding window keeps going.
 */
export async function graphAccessToken(userId: string, tenantId: string, credentialsEnc: string, mode: 'write' | 'read' = 'write'): Promise<string> {
  const { refresh_token } = JSON.parse(decrypt(credentialsEnc)) as { refresh_token?: string };
  if (!refresh_token) throw new Error('geen refresh token');
  // Our own scope list, never ".default": that returns every right ever consented to this public client in the
  // tenant (e.g. Application.ReadWrite.All from earlier Graph PowerShell use), far more than Claude may have.
  const refresh = (scope: string) => form(`${loginBase()}/${tenantId}/oauth2/v2.0/token`, {
    grant_type: 'refresh_token', client_id: M365_CLIENT_ID, refresh_token, scope,
  });
  if (mode === 'read') {
    // read-only run (an agent set to "Lezen"): a token with only read rights; if that is not possible, the normal path below
    const r = await refresh(M365_READ_SCOPES);
    if (r.access_token) {
      if (r.refresh_token && r.refresh_token !== refresh_token) {
        await query(`UPDATE connectors SET credentials_enc = $3, last_tested_at = now()
                      WHERE user_id = $1 AND type = 'm365' AND config->>'tenantId' = $2`,
          [userId, tenantId, encrypt(JSON.stringify({ refresh_token: r.refresh_token }))]);
      }
      return String(r.access_token);
    }
  }
  let t = await refresh(M365_SCOPES);
  // linked before the new rights existed: no consent for them yet, so keep the old set until the user links again
  if (!t.access_token && /AADSTS65001|consent|invalid_scope|AADSTS70000/i.test(String(t.error_description ?? t.error ?? ''))) {
    t = await refresh(LEGACY_SCOPES);
  }
  if (!t.access_token) {
    await query(`UPDATE connectors SET test_status = 'error', test_message = $3, last_tested_at = now()
                  WHERE user_id = $1 AND type = 'm365' AND config->>'tenantId' = $2`,
      [userId, tenantId, 'Opnieuw inloggen nodig: ' + String(t.error_description ?? t.error ?? '').split('\n')[0].slice(0, 200)]);
    throw new Error('Microsoft 365-login verlopen; koppel de tenant opnieuw');
  }
  if (t.refresh_token && t.refresh_token !== refresh_token) {
    await query(`UPDATE connectors SET credentials_enc = $3, test_status = 'ok', last_tested_at = now()
                  WHERE user_id = $1 AND type = 'm365' AND config->>'tenantId' = $2`,
      [userId, tenantId, encrypt(JSON.stringify({ refresh_token: t.refresh_token }))]);
  }
  return String(t.access_token);
}

/**
 * Microsoft 365 is opt-in per agent: config.agent_access maps agent id -> 'read' | 'write'; no entry = no access.
 * A run without agents (the owner's own main Claude) gets 'write'. With several agents in the run the lowest
 * level counts; null = leave the tenant out of this run.
 */
export function m365RunMode(accessRaw: unknown, agentIds: string[]): 'read' | 'write' | null {
  if (!agentIds.length) return 'write';
  const access = (accessRaw ?? {}) as Record<string, string>;
  let mode: 'read' | 'write' = 'write';
  for (const id of agentIds) {
    if (access[id] === 'read') mode = 'read';
    else if (access[id] !== 'write') return null;
  }
  return mode;
}
