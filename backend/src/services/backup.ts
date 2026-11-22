import { spawn, execFileSync } from 'child_process';
import {
  mkdirSync, existsSync, writeFileSync, readFileSync,
  readdirSync, statSync, rmSync, createWriteStream, createReadStream,
} from 'fs';
import { join } from 'path';
import { query } from '../db';

// Project dir is bind-mounted at the same path as on the host, so docker -v paths match.
export const PROJECT_DIR = process.env.PROJECT_DIR ?? '/volume1/docker/claude-chat';
export const BACKUP_ROOT = join(PROJECT_DIR, 'backups');
// Host path of BACKUP_ROOT: docker run -v is resolved by the host daemon, not inside this container.
export const HOST_BACKUP_ROOT = process.env.HOST_BACKUP_ROOT ?? BACKUP_ROOT;
const DEFAULT_KEEP = 7;
const POSTGRES_CONTAINER = 'claude-chat-postgres-1';
const BACKEND_CONTAINER = 'claude-chat-backend-1';
const PG_USER = 'claudechat';
const PG_DB = 'claudechat';

export interface BackupManifest {
  timestamp: string;
  postgresVersion: string;
  dumpSizeBytes: number;
  configSizeBytes: number;
  workspaceSizeBytes: number;
  homesSizeBytes: number;
  status: 'ok' | 'error';
  error?: string;
}

export interface BackupEntry {
  name: string;
  manifest: BackupManifest;
}

function backupDirName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

function getPostgresVersion(): string {
  try {
    const out = execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '--version'], { encoding: 'utf8' });
    return out.trim().split('\n')[0];
  } catch {
    return 'unknown';
  }
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

async function runPgDump(dumpPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(dumpPath);
    const pg = spawn('docker', ['exec', POSTGRES_CONTAINER, 'pg_dump', '-U', PG_USER, '-d', PG_DB]);
    pg.stdout.pipe(out);
    let stderr = '';
    pg.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    pg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code}: ${stderr.trim()}`));
    });
  });
}


function archiveVolume(volumeName: string, outPath: string): void {

// Use a throwaway alpine container to stream a tarball of the volume contents.

// -v ${volumeName}:/data:ro mounts the named volume read-only so backup is consistent.

// -v ${dir}:/out provides a writable spot for the archive.
  try {
    execFileSync('docker', [
      'run', '--rm',
      '-v', `${volumeName}:/data:ro`,
      '-v', `${HOST_BACKUP_ROOT}:/out`,
      'alpine:3',
      'sh', '-c', `cd /data && tar -czf /out/${outPath} . 2>/dev/null || true`,
    ]);
  } catch (err) {
    console.error(`[backup] archiveVolume(${volumeName}) failed:`, (err as Error).message);
  }
}

export function deleteBackup(name: string): void {

// Path safety: refuse anything that resolves outside BACKUP_ROOT
  if (!/^[\w\-]+$/.test(name)) throw new Error('Invalid backup name');
  const dir = join(BACKUP_ROOT, name);
  if (!existsSync(dir)) throw new Error(`Backup not found: ${name}`);
  rmSync(dir, { recursive: true, force: true });
  console.log(`[backup] Deleted backup: ${name}`);
}

async function restoreVolume(volumeName: string, archiveRelPath: string): Promise<void> {

// Wipe + repopulate the volume from a tarball.
  if (!existsSync(join(BACKUP_ROOT, archiveRelPath))) {
    console.warn(`[backup] Volume archive missing, skipping: ${archiveRelPath}`);
    return;
  }
  execFileSync('docker', [
    'run', '--rm',
    '-v', `${volumeName}:/data`,
    '-v', `${HOST_BACKUP_ROOT}:/out:ro`,
    'alpine:3',
    'sh', '-c', `rm -rf /data/* /data/.[!.]* 2>/dev/null; tar -xzf /out/${archiveRelPath} -C /data`,
  ]);
}

function createConfigArchive(configPath: string): void {
  const files: string[] = [];
  for (const f of ['.env', 'docker-compose.yml', 'nginx/default.conf']) {
    if (existsSync(join(PROJECT_DIR, f))) files.push(f);
  }
  if (files.length === 0) return;
  execFileSync('tar', ['-czf', configPath, '-C', PROJECT_DIR, ...files]);
}

async function runPsqlRestore(dumpPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const psql = spawn('docker', ['exec', '-i', POSTGRES_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB]);
    const src = createReadStream(dumpPath);
    src.pipe(psql.stdin);
    let stderr = '';
    psql.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    psql.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql restore exited ${code}: ${stderr.trim()}`));
    });
  });
}

function dropAndRecreateDb(): void {
  // Connect to the 'postgres' admin DB so we are not attached to the DB we are about to drop.
  // Terminate any other live connections (e.g. backend pool) before DROP, otherwise PG errors:
  //   "database is being accessed by other users".
  execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-c',
    `REVOKE CONNECT ON DATABASE ${PG_DB} FROM PUBLIC;`]);
  execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-c',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PG_DB}' AND pid <> pg_backend_pid();`]);
  execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-c',
    `DROP DATABASE IF EXISTS ${PG_DB};`]);
  execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-c',
    `CREATE DATABASE ${PG_DB};`]);
  execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '-U', PG_USER, '-d', 'postgres', '-c',
    `GRANT CONNECT ON DATABASE ${PG_DB} TO PUBLIC;`]);
}

export function restartBackend(): void {
  execFileSync('docker', ['restart', BACKEND_CONTAINER]);
}

/** Retention, changeable without rebuild: UPDATE/INSERT system_config key 'backup_keep'. */
async function backupKeep(): Promise<number> {
  try {
    const r = await query<{ value: string }>("SELECT value FROM system_config WHERE key = 'backup_keep'");
    const n = parseInt(r.rows[0]?.value ?? '', 10);
    if (n >= 1 && n <= 365) return n;
  } catch { /* table missing or db down: default */ }
  return DEFAULT_KEEP;
}

/** Keep the newest N successful backups; failed ones (or without manifest) go as soon as a newer one succeeded. */
async function pruneOldBackups(current: string): Promise<void> {
  if (!existsSync(BACKUP_ROOT)) return;
  const keep = await backupKeep();
  const status = (d: string): string => {
    try { return (JSON.parse(readFileSync(join(BACKUP_ROOT, d, 'manifest.json'), 'utf8')) as BackupManifest).status; }
    catch { return 'missing'; }
  };
  const dirs = readdirSync(BACKUP_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(d) && statSync(join(BACKUP_ROOT, d)).isDirectory())
    .sort()
    .reverse();
  const ok = dirs.filter((d) => status(d) === 'ok');
  const remove = [
    ...ok.slice(keep),
    ...dirs.filter((d) => d < current && status(d) !== 'ok'),
  ];
  for (const old of remove) {
    rmSync(join(BACKUP_ROOT, old), { recursive: true, force: true });
    console.log(`[backup] Pruned old backup: ${old}`);
  }
}

export async function createBackup(): Promise<BackupEntry> {
  mkdirSync(BACKUP_ROOT, { recursive: true });
  const name = backupDirName();
  const dir = join(BACKUP_ROOT, name);
  mkdirSync(dir, { recursive: true });

  const dumpPath = join(dir, 'dump.sql');
  const configPath = join(dir, 'config.tar.gz');
  const manifestPath = join(dir, 'manifest.json');

  let manifest: BackupManifest;

  const workspacePath = join(dir, 'workspace.tar.gz');
  const homesPath = join(dir, 'homes.tar.gz');

  try {
    const postgresVersion = getPostgresVersion();
    await runPgDump(dumpPath);
    createConfigArchive(configPath);
    archiveVolume('claude-chat_workspace_data', `${name}/workspace.tar.gz`);
    archiveVolume('claude-chat_home_data', `${name}/homes.tar.gz`);
    manifest = {
      timestamp: new Date().toISOString(),
      postgresVersion,
      dumpSizeBytes: fileSize(dumpPath),
      configSizeBytes: fileSize(configPath),
      workspaceSizeBytes: fileSize(workspacePath),
      homesSizeBytes: fileSize(homesPath),
      status: 'ok',
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[backup] Created backup: ${name} (${manifest.dumpSizeBytes} bytes)`);
    await pruneOldBackups(name);
  } catch (err) {
    manifest = {
      timestamp: new Date().toISOString(),
      postgresVersion: 'unknown',
      dumpSizeBytes: 0,
      configSizeBytes: 0,
      workspaceSizeBytes: 0,
      homesSizeBytes: 0,
      status: 'error',
      error: (err as Error).message,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.error(`[backup] Backup failed: ${(err as Error).message}`);
  }

  return { name, manifest };
}

export function listBackups(): BackupEntry[] {
  if (!existsSync(BACKUP_ROOT)) return [];
  return readdirSync(BACKUP_ROOT)
    .filter((d) => existsSync(join(BACKUP_ROOT, d, 'manifest.json')))
    .sort()
    .reverse()
    .map((name) => {
      const manifest = JSON.parse(readFileSync(join(BACKUP_ROOT, name, 'manifest.json'), 'utf8')) as BackupManifest;
      return { name, manifest };
    });
}

export async function restoreBackup(name: string): Promise<void> {
  if (!/^[\w\-]+$/.test(name)) throw new Error('Invalid backup name');
  const dir = join(BACKUP_ROOT, name);
  const manifestPath = join(dir, 'manifest.json');
  const dumpPath = join(dir, 'dump.sql');

  if (!existsSync(dir)) throw new Error(`Backup not found: ${name}`);
  if (!existsSync(manifestPath)) throw new Error('Manifest missing');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  if (manifest.status !== 'ok') throw new Error('Cannot restore a failed backup');
  if (!existsSync(dumpPath)) throw new Error('dump.sql missing');

  console.log(`[backup] Starting restore: ${name}`);
  dropAndRecreateDb();
  await runPsqlRestore(dumpPath);
  await restoreVolume('claude-chat_workspace_data', `${name}/workspace.tar.gz`);
  await restoreVolume('claude-chat_home_data', `${name}/homes.tar.gz`);
  // Caller restarts the backend (this process) after responding: see routes/admin.ts.
  console.log(`[backup] Restore complete: ${name}`);
}
