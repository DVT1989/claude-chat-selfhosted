/**
 * Devices: Windows/Mac computers with the Claude Agent. The agent long-polls /devices/agent/poll
 * over HTTPS (no inbound ports); jobs (commands, file read/write, inventory) are handed out there
 * and answered via /devices/agent/result. Pending jobs and waiting polls live in memory: a job
 * is short-lived and the caller (Claude) waits for its answer.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Response } from 'express';
import { query } from '../db';
import { redis } from '../redis';

export const ONLINE_MS = 75_000;          // a poll at least every ~50s keeps a device online
const POLL_HOLD_MS = 25_000;
const CODE_TTL_MIN = 30;
const CLAUDE_TOKEN_TTL_SEC = 6 * 3600;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function ensureDeviceSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      hostname TEXT,
      os TEXT,
      os_name TEXT,
      arch TEXT,
      agent_version TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      inventory JSONB,
      inventory_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      last_ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query('CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id)');
  await query(`
    CREATE TABLE IF NOT EXISTS device_enroll_codes (
      code_hash TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  // Background tasks (updates, actions): run one by one per device, also with the app closed
  await query(`
    CREATE TABLE IF NOT EXISTS device_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      tool TEXT,
      command TEXT NOT NULL,
      shell TEXT NOT NULL DEFAULT '',
      timeout_sec INTEGER NOT NULL DEFAULT 1800,
      status TEXT NOT NULL DEFAULT 'queued',
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )`);
  await query('CREATE INDEX IF NOT EXISTS device_tasks_dev_idx ON device_tasks (device_id, created_at DESC)');
  // a task running during a restart lost its answer; the agent may still have finished it
  await query(`UPDATE device_tasks SET status = 'interrupted', finished_at = now() WHERE status = 'running'`);
  // RMM fields (NinjaOne-style): organisation, location, assigned user, custom fields, maintenance, alerts
  await query(`ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS org TEXT,
    ADD COLUMN IF NOT EXISTS location TEXT,
    ADD COLUMN IF NOT EXISTS assigned_user TEXT,
    ADD COLUMN IF NOT EXISTS role TEXT,
    ADD COLUMN IF NOT EXISTS custom JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS maintenance_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS maintenance_reason TEXT,
    ADD COLUMN IF NOT EXISTS alerts_ack JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await query('ALTER TABLE device_tasks ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ');
  await query('CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource_id, created_at DESC)');
  await query('ALTER TABLE device_tasks ADD COLUMN IF NOT EXISTS runas TEXT');
  await query(`
    CREATE TABLE IF NOT EXISTS device_favorites (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, device_id)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS device_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query('CREATE INDEX IF NOT EXISTS device_notes_dev_idx ON device_notes (device_id, created_at DESC)');
  // Script library per user (Uitvoeren > Script)
  await query(`
    CREATE TABLE IF NOT EXISTS device_scripts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      os TEXT NOT NULL DEFAULT 'windows',
      shell TEXT NOT NULL DEFAULT '',
      runas TEXT NOT NULL DEFAULT 'system',
      timeout_sec INTEGER NOT NULL DEFAULT 600,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS device_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      require_totp BOOLEAN NOT NULL DEFAULT TRUE
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS device_global_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )`);
}

// ── Pairing ──────────────────────────────────────────────────

export async function createEnrollCode(userId: string): Promise<{ code: string; expiresAt: string }> {
  const bytes = randomBytes(8);
  let raw = '';
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const r = await query<{ expires_at: string }>(
    `INSERT INTO device_enroll_codes (code_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${CODE_TTL_MIN} minutes')
     RETURNING expires_at`, [sha256(code), userId]);
  await query('DELETE FROM device_enroll_codes WHERE expires_at < now()');
  return { code, expiresAt: r.rows[0].expires_at };
}

export interface EnrollInfo { code: string; hostname?: string; os?: string; osName?: string; arch?: string; version?: string }

/** Exchanges a pairing code (single use) for a device and its secret token. */
export async function enrollDevice(info: EnrollInfo, ip: string): Promise<{ deviceId: string; token: string; name: string } | null> {
  const code = info.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : info.code;
  const used = await query<{ user_id: string }>(
    'DELETE FROM device_enroll_codes WHERE code_hash = $1 AND expires_at > now() RETURNING user_id', [sha256(formatted)]);
  const userId = used.rows[0]?.user_id;
  if (!userId) return null;
  const token = randomBytes(32).toString('base64url');
  const name = (info.hostname || 'Apparaat').slice(0, 80);
  const r = await query<{ id: string }>(
    `INSERT INTO devices (user_id, name, hostname, os, os_name, arch, agent_version, token_hash, last_seen_at, last_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9) RETURNING id`,
    [userId, name, info.hostname ?? null, info.os ?? null, info.osName ?? null, info.arch ?? null, info.version ?? null, sha256(token), ip]);
  // A browser that pairs again (update, reinstall) replaces its old pairing with the same name: no duplicates
  if (info.os === 'browser') {
    await query("DELETE FROM devices WHERE user_id = $1 AND os = 'browser' AND name = $2 AND id <> $3", [userId, name, r.rows[0].id]);
  }
  return { deviceId: r.rows[0].id, token, name };
}

export interface AgentDevice { id: string; user_id: string; name: string; enabled: boolean }

export async function deviceForToken(token: string): Promise<AgentDevice | null> {
  if (!token || token.length < 20) return null;
  const r = await query<AgentDevice>('SELECT id, user_id, name, enabled FROM devices WHERE token_hash = $1', [sha256(token)]);
  return r.rows[0] ?? null;
}

export async function getSettings(userId: string): Promise<{ requireTotp: boolean }> {
  const r = await query<{ require_totp: boolean }>('SELECT require_totp FROM device_settings WHERE user_id = $1', [userId]);
  return { requireTotp: r.rows[0]?.require_totp ?? true };
}

export async function saveSettings(userId: string, requireTotp: boolean): Promise<void> {
  await query(
    `INSERT INTO device_settings (user_id, require_totp) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET require_totp = EXCLUDED.require_totp`, [userId, requireTotp]);
}

// ── Jobs: handed out on poll, answered on result ─────────────

export interface Job { id: string; type: 'exec' | 'read' | 'write' | 'inventory' | 'update' | 'remote' | 'sas' | 'browser'; cmd?: string; args?: Record<string, unknown>; command?: string; shell?: string; timeoutSec?: number; runas?: 'system' | 'user'; elevated?: boolean; path?: string; dataB64?: string; session?: string; key?: string }
export interface JobResult { id: string; ok: boolean; exitCode?: number; output?: string; error?: string; dataB64?: string; data?: unknown; durationMs?: number }

const queued = new Map<string, Job[]>();                       // deviceId -> jobs not yet handed out
const waiting = new Map<string, { res: Response; timer: NodeJS.Timeout }>(); // deviceId -> open poll
const pending = new Map<string, { deviceId: string; resolve: (r: JobResult) => void; timer: NodeJS.Timeout }>();

function flush(deviceId: string): void {
  const w = waiting.get(deviceId);
  const jobs = queued.get(deviceId);
  if (!w || !jobs?.length) return;
  waiting.delete(deviceId);
  clearTimeout(w.timer);
  queued.delete(deviceId);
  try { w.res.json({ jobs }); } catch { /* connection gone: jobs time out */ }
}

/** Long-poll: answers at once with queued jobs, otherwise after POLL_HOLD_MS with none. */
export function holdPoll(deviceId: string, res: Response): void {
  const prev = waiting.get(deviceId);
  if (prev) { clearTimeout(prev.timer); try { prev.res.json({ jobs: [] }); } catch { /* ignore */ } }
  const timer = setTimeout(() => {
    if (waiting.get(deviceId)?.res === res) waiting.delete(deviceId);
    try { res.json({ jobs: [] }); } catch { /* ignore */ }
  }, POLL_HOLD_MS);
  waiting.set(deviceId, { res, timer });
  res.on('close', () => {
    if (waiting.get(deviceId)?.res === res) { clearTimeout(timer); waiting.delete(deviceId); }
  });
  flush(deviceId);
}

export function runJob(deviceId: string, job: Omit<Job, 'id'>, waitMs: number): Promise<JobResult> {
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const q = queued.get(deviceId);
      if (q) queued.set(deviceId, q.filter((j) => j.id !== id));
      resolve({ id, ok: false, error: 'geen antwoord van het apparaat (time-out)' });
    }, waitMs);
    pending.set(id, { deviceId, resolve, timer });
    queued.set(deviceId, [...(queued.get(deviceId) ?? []), { id, ...job }]);
    flush(deviceId);
  });
}

export function deliverResult(deviceId: string, r: JobResult): boolean {
  const p = pending.get(r.id);
  if (!p || p.deviceId !== deviceId) return false;
  pending.delete(r.id);
  clearTimeout(p.timer);
  p.resolve(r);
  return true;
}

export async function storeInventory(deviceId: string, inventory: unknown): Promise<void> {
  const inv = inventory as Record<string, unknown> | null;
  await query(
    `UPDATE devices SET inventory = $1::jsonb, inventory_at = now(),
       os_name = COALESCE($2, os_name), agent_version = COALESCE($3, agent_version) WHERE id = $4`,
    [JSON.stringify(inventory ?? {}), typeof inv?.os === 'string' ? inv.os : null,
     typeof inv?.agentVersion === 'string' ? inv.agentVersion : null, deviceId]);
}

// ── Listing ──────────────────────────────────────────────────

export interface DeviceRow {
  id: string; name: string; hostname: string | null; os: string | null; os_name: string | null; arch: string | null;
  agent_version: string | null; enabled: boolean; inventory: Record<string, unknown> | null; inventory_at: string | null;
  last_seen_at: string | null; last_ip: string | null; created_at: string; owner?: string | null;
  display_name: string | null; org: string | null; location: string | null; assigned_user: string | null; role: string | null;
  custom: Record<string, unknown>; maintenance_until: string | null; maintenance_reason: string | null; alerts_ack: string[];
  notes_count?: number; favorite?: boolean;
}

export const isOnline = (d: { last_seen_at: string | null; enabled: boolean }) =>
  d.enabled && !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < ONLINE_MS;

/** Scope: a user id (own devices) or null (admin: every device). */
export type Scope = string | null;

/** Own devices by default. Only an admin who explicitly asks (header x-devices-all: 1 or ?all=1) gets every device. */
export function requestScope(req: { user?: { userId: string; role: string }; headers: Record<string, unknown>; query: Record<string, unknown> }): Scope {
  const u = req.user!;
  const all = String(req.headers['x-devices-all'] ?? '') === '1' || String(req.query.all ?? '') === '1';
  return u.role === 'admin' && all ? null : u.userId;
}

export async function listDevices(scope: Scope, viewer: string | null = null): Promise<Array<DeviceRow & { online: boolean }>> {
  const r = await query<DeviceRow>(
    `SELECT d.id, d.name, d.hostname, d.os, d.os_name, d.arch, d.agent_version, d.enabled, d.inventory, d.inventory_at,
            d.last_seen_at, d.last_ip, d.created_at, u.name AS owner, d.display_name, d.org, d.location, d.assigned_user, d.role,
            d.custom, d.maintenance_until, d.maintenance_reason, d.alerts_ack,
            (SELECT count(*)::int FROM device_notes n WHERE n.device_id = d.id) AS notes_count,
            EXISTS (SELECT 1 FROM device_favorites f WHERE f.device_id = d.id AND f.user_id = $3::uuid) AS favorite
     FROM devices d JOIN users u ON u.id = d.user_id WHERE ($1::uuid IS NULL OR d.user_id = $1::uuid) AND $2::int IS NULL ORDER BY lower(d.name)`, [scope, null, viewer]);
  return r.rows.map((d) => ({ ...d, online: isOnline(d) }));
}

export async function getDevice(scope: Scope, idOrName: string, viewer: string | null = null): Promise<(DeviceRow & { online: boolean }) | null> {
  const r = await query<DeviceRow>(
    `SELECT d.id, d.name, d.hostname, d.os, d.os_name, d.arch, d.agent_version, d.enabled, d.inventory, d.inventory_at,
            d.last_seen_at, d.last_ip, d.created_at, u.name AS owner, d.display_name, d.org, d.location, d.assigned_user, d.role,
            d.custom, d.maintenance_until, d.maintenance_reason, d.alerts_ack,
            (SELECT count(*)::int FROM device_notes n WHERE n.device_id = d.id) AS notes_count,
            EXISTS (SELECT 1 FROM device_favorites f WHERE f.device_id = d.id AND f.user_id = $3::uuid) AS favorite
     FROM devices d JOIN users u ON u.id = d.user_id
     WHERE ($1::uuid IS NULL OR d.user_id = $1::uuid)
       AND (d.id::text = lower($2::text) OR lower(d.name) = lower($2::text) OR lower(d.hostname) = lower($2::text))
     ORDER BY d.created_at DESC LIMIT 1`, [scope, idOrName, viewer]);
  const d = r.rows[0];
  return d ? { ...d, online: isOnline(d) } : null;
}

// ── Claude access: per-run token, only from inside this container ──

const tokenKey = (t: string) => `devices:claude:${t}`;

/** Claude only ever sees the devices of the user themselves, admin included. */
export async function issueClaudeToken(userId: string): Promise<{ token: string; devices: Array<{ id: string; name: string; os: string | null; online: boolean }> } | null> {
  const devices = (await listDevices(userId)).filter((d) => d.enabled);
  if (!devices.length) return null;
  const token = randomBytes(24).toString('base64url');
  await redis.set(tokenKey(token), JSON.stringify({ userId }), 'EX', CLAUDE_TOKEN_TTL_SEC);
  return { token, devices: devices.map((d) => ({ id: d.id, name: d.name, os: d.os, online: d.online })) };
}

export async function userForClaudeToken(token: string): Promise<{ userId: string; scope: Scope } | null> {
  if (!token || token.length < 20) return null;
  const v = await redis.get(tokenKey(token));
  if (!v) return null;
  try {
    const o = JSON.parse(v) as { userId: string };
    return { userId: o.userId, scope: o.userId };
  } catch { return { userId: v, scope: v }; }
}
