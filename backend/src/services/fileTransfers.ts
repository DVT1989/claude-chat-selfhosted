/**
 * Large file transfers between devices (and the NAS) through a staging area on the server.
 * Source agent uploads in 8 MB blocks (PUT chunk, resumable), destination agent downloads with Range
 * (resumable), SHA-256 over the whole file, progress per phase, staging cleaned up afterwards.
 * Older agents (job types unknown to them) fall back to the read/write jobs for files up to 15 MB.
 */
import { createHash } from 'crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, statfsSync, unlinkSync, copyFileSync, renameSync } from 'fs';
import { open, readFile, rm, truncate, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join } from 'path';
import { query } from '../db';
import { auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import * as dev from './devices';

export const STAGE_DIR = process.env.TRANSFER_DIR ?? '/data/transfers';
const LEGACY_MAX = 15 << 20;
const STALE_MS = 6 * 60_000;
const GIVE_UP_MS = 24 * 3600_000;
const MIN_FREE = 1 << 30;

export interface Transfer {
  id: string; user_id: string; src_kind: 'device' | 'nas'; src_device_id: string | null; src_path: string; src_name: string;
  dst_kind: 'device' | 'nas'; dst_device_id: string | null; dst_path: string; dst_name: string; overwrite: boolean;
  size: string | null; sha256: string | null; status: 'queued' | 'uploading' | 'downloading' | 'done' | 'failed' | 'cancelled';
  up_bytes: string; down_bytes: string; attempts: number; error: string | null; origin: string;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
}

export async function ensureTransferSchema(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS file_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    src_kind TEXT NOT NULL, src_device_id UUID, src_path TEXT NOT NULL, src_name TEXT NOT NULL,
    dst_kind TEXT NOT NULL, dst_device_id UUID, dst_path TEXT NOT NULL, dst_name TEXT NOT NULL,
    overwrite BOOLEAN NOT NULL DEFAULT false,
    size BIGINT, sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    up_bytes BIGINT NOT NULL DEFAULT 0, down_bytes BIGINT NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT, origin TEXT NOT NULL DEFAULT 'claude',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)`);
  await query('CREATE INDEX IF NOT EXISTS file_transfers_user_idx ON file_transfers (user_id, created_at DESC)');
  mkdirSync(STAGE_DIR, { recursive: true });
}

export const stagePath = (id: string) => join(STAGE_DIR, `${id}.bin`);
const num = (v: string | number | null | undefined) => Number(v ?? 0);

export async function getTransfer(id: string, userId?: string): Promise<Transfer | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await query<Transfer>(`SELECT * FROM file_transfers WHERE id = $1 ${userId ? 'AND user_id = $2' : ''}`, userId ? [id, userId] : [id]);
  return r.rows[0] ?? null;
}

export function publicView(t: Transfer) {
  const size = num(t.size);
  const up = num(t.up_bytes), down = num(t.down_bytes);
  const percent = t.status === 'done' ? 100 : size > 0 ? Math.min(99, Math.floor(((up + down) / (2 * size)) * 100)) : 0;
  return {
    id: t.id, status: t.status, phase: t.status === 'uploading' ? 'upload' : t.status === 'downloading' ? 'download' : t.status,
    from: { device: t.src_name, path: t.src_path }, to: { device: t.dst_name, path: t.dst_path },
    sizeBytes: t.size === null ? null : size, uploadedBytes: up, downloadedBytes: down, percent,
    sha256: t.status === 'done' ? t.sha256 : undefined, error: t.error ?? undefined,
    createdAt: t.created_at, finishedAt: t.finished_at ?? undefined,
  };
}

async function setT(id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = now()');
  await query(`UPDATE file_transfers SET ${sets.join(', ')} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

const FINAL = ['done', 'failed', 'cancelled'];

export async function cleanup(id: string): Promise<void> {
  await rm(stagePath(id), { force: true }).catch(() => undefined);
}

export async function finish(t: Transfer, status: 'done' | 'failed' | 'cancelled', error?: string): Promise<void> {
  const cur = await getTransfer(t.id);
  if (!cur || FINAL.includes(cur.status)) return;
  await setT(t.id, { status, error: error ?? null, finished_at: new Date() });
  await cleanup(t.id);
  const action = status === 'done' ? 'device.transfer.done' : status === 'failed' ? 'device.transfer.fail' : 'device.transfer.cancel';
  await auditLog(t.user_id, action, 'file_transfer', t.id, '', {
    from: `${t.src_name}:${t.src_path}`, to: `${t.dst_name}:${t.dst_path}`, bytes: cur.size === null ? null : num(cur.size), sha256: cur.sha256, error, origin: t.origin,
  });
}

/** Creates a transfer and starts it. from/to: device name or id, or "nas" (admins only, path on the server). */
export async function createTransfer(userId: string, o: { from: string; fromPath: string; to: string; toPath: string; overwrite?: boolean; origin?: string }): Promise<Transfer> {
  const isAdmin = (await query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId])).rows[0]?.role === 'admin';
  const resolve = async (who: string, path: string, side: 'van' | 'naar') => {
    if (!path.trim()) throw new AppError(400, `pad ${side} ontbreekt`);
    if (who.toLowerCase() === 'nas') {
      if (!isAdmin) throw new AppError(403, 'De NAS als bron of doel is alleen voor beheerders');
      if (!isAbsolute(path) || /^\/(proc|sys|dev)\b/.test(path) || path.startsWith(STAGE_DIR) || basename(path) === '.env') throw new AppError(403, `pad op de NAS niet toegestaan: ${path}`);
      return { kind: 'nas' as const, id: null, name: 'NAS' };
    }
    // own devices only, also for admins
    const d = await dev.getDevice(userId, who);
    if (!d) throw new AppError(404, `Apparaat "${who}" niet gevonden`);
    if (d.os !== 'windows' && d.os !== 'darwin') throw new AppError(409, `${d.name} ondersteunt geen bestandsoverdracht`);
    if (!d.enabled) throw new AppError(409, `${d.name} is uitgeschakeld in de app`);
    if (!d.online) throw new AppError(409, `${d.name} is offline`);
    return { kind: 'device' as const, id: d.id, name: d.name };
  };
  const src = await resolve(o.from, o.fromPath, 'van');
  const dst = await resolve(o.to, o.toPath, 'naar');
  if (src.kind === 'nas' && dst.kind === 'nas') throw new AppError(400, 'Van NAS naar NAS: gebruik cp');
  const r = await query<Transfer>(
    `INSERT INTO file_transfers (user_id, src_kind, src_device_id, src_path, src_name, dst_kind, dst_device_id, dst_path, dst_name, overwrite, origin, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now()) RETURNING *`,
    [userId, src.kind, src.id, o.fromPath, src.name, dst.kind, dst.id, o.toPath, dst.name, o.overwrite === true, o.origin ?? 'claude']);
  const t = r.rows[0];
  await auditLog(userId, 'device.transfer.start', 'file_transfer', t.id, '', { from: `${src.name}:${o.fromPath}`, to: `${dst.name}:${o.toPath}`, overwrite: o.overwrite === true, origin: t.origin });
  void advance(t.id);
  return t;
}

export async function cancelTransfer(t: Transfer): Promise<void> { await finish(t, 'cancelled', 'geannuleerd'); }

export async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

function checkSpace(size: number): void {
  try {
    const s = statfsSync(STAGE_DIR);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < size + MIN_FREE) throw new AppError(507, `te weinig vrije ruimte voor de tijdelijke opslag (${Math.round(free / 1e9)} GB vrij, ${Math.round(size / 1e9 * 10) / 10} GB nodig)`);
  } catch (e) { if (e instanceof AppError) throw e; }
}

const running = new Set<string>();
const unknownJob = (e?: string) => /onbekend jobtype/i.test(e ?? '');

/** Moves a transfer to its next step (idempotent; also used to resume after an interruption). */
export async function advance(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    let t = await getTransfer(id);
    if (!t || FINAL.includes(t.status)) return;
    if (t.status === 'queued' || t.status === 'uploading') {
      if (t.src_kind === 'nas') {
        const st = statSync(t.src_path, { throwIfNoEntry: false });
        if (!st || !st.isFile()) return void (await finish(t, 'failed', `bron niet gevonden of geen bestand: ${t.src_path}`));
        checkSpace(st.size);
        copyFileSync(t.src_path, stagePath(t.id));
        await setT(t.id, { size: st.size, up_bytes: st.size, sha256: await hashFile(stagePath(t.id)), status: 'downloading' });
      } else {
        const d = await dev.getDevice(t.user_id, t.src_device_id!);
        if (!d || !d.online) return; // wait for the device; the sweeper tries again
        const { result } = await sendJob(t.src_device_id!, { type: 'upload', xfer: t.id, path: t.src_path }, 60);
        if (unknownJob(result.error)) {
          const { result: rd } = await sendJob(t.src_device_id!, { type: 'read', path: t.src_path }, 120);
          if (!rd.ok) return void (await finish(t, 'failed', /te groot/.test(rd.error ?? '') ? 'agent op de bron is te oud voor grote bestanden: werk de agent bij' : rd.error ?? 'lezen mislukt'));
          const buf = Buffer.from(rd.dataB64 ?? '', 'base64');
          await writeFile(stagePath(t.id), buf);
          await setT(t.id, { size: buf.length, up_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), status: 'downloading' });
        } else if (!result.ok) {
          return void (await finish(t, 'failed', result.error ?? 'uploaden starten mislukt'));
        } else if (t.status === 'queued') {
          const size = num((result.data as { size?: number } | undefined)?.size);
          checkSpace(size);
          await setT(t.id, { size, status: 'uploading' });
          if (size === 0) { await writeFile(stagePath(t.id), ''); await setT(t.id, { sha256: createHash('sha256').digest('hex'), status: 'downloading' }); }
        }
      }
      t = await getTransfer(id);
      if (!t || t.status !== 'downloading') return;
    }
    if (t.status === 'downloading') {
      if (t.dst_kind === 'nas') {
        if (existsSync(t.dst_path) && !t.overwrite) return void (await finish(t, 'failed', `doelbestand bestaat al: ${t.dst_path}`));
        mkdirSync(dirname(t.dst_path), { recursive: true });
        const tmp = `${t.dst_path}.ccpart`;
        copyFileSync(stagePath(t.id), tmp);
        if (await hashFile(tmp) !== t.sha256) { unlinkSync(tmp); return void (await finish(t, 'failed', 'checksum op de NAS klopt niet')); }
        renameSync(tmp, t.dst_path);
        await setT(t.id, { down_bytes: num(t.size) });
        return void (await finish(t, 'done'));
      }
      const d = await dev.getDevice(t.user_id, t.dst_device_id!);
      if (!d || !d.online) return;
      const { result } = await sendJob(t.dst_device_id!, { type: 'download', xfer: t.id, path: t.dst_path, overwrite: t.overwrite }, 60);
      if (unknownJob(result.error)) {
        if (num(t.size) > LEGACY_MAX) return void (await finish(t, 'failed', 'agent op het doel is te oud voor grote bestanden: werk de agent bij'));
        const buf = await readFile(stagePath(t.id));
        const { result: w } = await sendJob(t.dst_device_id!, { type: 'write', path: t.dst_path, dataB64: buf.toString('base64') }, 120);
        if (!w.ok) return void (await finish(t, 'failed', w.error ?? 'schrijven mislukt'));
        await setT(t.id, { down_bytes: buf.length });
        await finish(t, 'done');
      } else if (!result.ok) {
        await finish(t, 'failed', result.error ?? 'downloaden starten mislukt');
      }
    }
  } catch (e) {
    const t = await getTransfer(id).catch(() => null);
    if (t) await finish(t, 'failed', e instanceof Error ? e.message : String(e));
  } finally { running.delete(id); }
}

async function sendJob(deviceId: string, job: Omit<dev.Job, 'id'>, timeoutSec: number) {
  const result = await dev.runJob(deviceId, job, timeoutSec * 1000);
  return { result };
}

// ── Agent side: chunks, progress, completion ──

/** Transfer for an agent call: the device must be the source (up) or the destination (down) and the transfer active. */
export async function xferForAgent(id: string, deviceId: string, side: 'up' | 'down'): Promise<Transfer> {
  let t = await getTransfer(id);
  // the agent starts right after its job result; the server records size and phase a moment later
  for (let i = 0; side === 'up' && t?.status === 'queued' && i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); t = await getTransfer(id); }
  if (!t || (side === 'up' ? t.src_device_id : t.dst_device_id) !== deviceId) throw new AppError(404, 'Overdracht onbekend');
  if (FINAL.includes(t.status)) throw new AppError(410, `Overdracht is ${t.status === 'cancelled' ? 'geannuleerd' : 'beëindigd'}`);
  if ((side === 'up') !== (t.status === 'uploading' || t.status === 'queued')) throw new AppError(409, 'Overdracht is niet in deze fase');
  return t;
}

export async function writeChunk(t: Transfer, offset: number, data: Buffer, sha: string): Promise<number> {
  if (createHash('sha256').update(data).digest('hex') !== sha.toLowerCase()) throw new AppError(422, 'blok-checksum klopt niet');
  const have = num(t.up_bytes);
  const size = num(t.size);
  if (offset > have) throw new AppError(409, JSON.stringify({ received: have }));
  if (offset + data.length > size) throw new AppError(422, 'blok valt buiten de bestandsgrootte');
  if (offset + data.length <= have) return have; // resend of a block we already have
  const fh = await open(stagePath(t.id), offset === 0 && have === 0 ? 'w' : 'r+');
  try { await fh.write(data, 0, data.length, offset); } finally { await fh.close(); }
  await query('UPDATE file_transfers SET up_bytes = $2, updated_at = now() WHERE id = $1', [t.id, offset + data.length]);
  return offset + data.length;
}

export async function uploadDone(t: Transfer, sha: string, size: number): Promise<void> {
  if (size !== num(t.size) || num(t.up_bytes) !== size) throw new AppError(422, `niet alles ontvangen (${num(t.up_bytes)} van ${num(t.size)} bytes)`);
  const got = await hashFile(stagePath(t.id));
  if (got !== sha.toLowerCase()) {
    await finish(t, 'failed', 'checksum na uploaden klopt niet (bestand gewijzigd of beschadigd)');
    throw new AppError(422, 'checksum klopt niet');
  }
  await setT(t.id, { sha256: got, status: 'downloading' });
  void advance(t.id);
}

export async function downloadProgress(t: Transfer, bytes: number): Promise<void> {
  await query('UPDATE file_transfers SET down_bytes = $2, updated_at = now() WHERE id = $1', [t.id, Math.min(bytes, num(t.size))]);
}

export async function downloadDone(t: Transfer, sha: string): Promise<void> {
  if (sha.toLowerCase() !== t.sha256) { await finish(t, 'failed', 'checksum op het doel klopt niet'); throw new AppError(422, 'checksum klopt niet'); }
  await setT(t.id, { down_bytes: num(t.size) });
  await finish(t, 'done');
}

export async function resetStaging(id: string): Promise<void> { await truncate(stagePath(id), 0).catch(() => undefined); }

// ── Sweeper: resume stalled transfers, fail hopeless ones, remove orphaned staging files ──

export function startTransferSweeper(): void {
  setInterval(async () => {
    try {
      const act = await query<Transfer>(`SELECT * FROM file_transfers WHERE status IN ('queued','uploading','downloading')`);
      for (const t of act.rows) {
        const idle = Date.now() - new Date(t.updated_at).getTime();
        const devId = t.status === 'downloading' ? t.dst_device_id : t.src_device_id;
        if (idle > GIVE_UP_MS) { await finish(t, 'failed', 'geen voortgang meer (apparaat 24 uur niet bereikbaar)'); continue; }
        if (idle < STALE_MS && t.status !== 'queued') continue;
        const d = devId ? await dev.getDevice(t.user_id, devId) : null;
        if (!d?.online) continue; // wait; the agent resumes by itself
        if (t.attempts >= 6) { await finish(t, 'failed', 'geen voortgang na meerdere pogingen'); continue; }
        await query('UPDATE file_transfers SET attempts = attempts + 1, updated_at = now() WHERE id = $1', [t.id]);
        void advance(t.id);
      }
      const ids = new Set(act.rows.map((t) => t.id));
      for (const f of readdirSync(STAGE_DIR)) {
        const id = f.replace(/\.bin$/, '');
        if (ids.has(id) || running.has(id)) continue;
        const p = join(STAGE_DIR, f);
        if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) await rm(p, { force: true, recursive: true });
      }
    } catch (e) { console.error('[transfers] sweeper:', e); }
  }, 30_000).unref();
}

export async function listTransfers(userId: string, limit = 30): Promise<Transfer[]> {
  return (await query<Transfer>('SELECT * FROM file_transfers WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit])).rows;
}
