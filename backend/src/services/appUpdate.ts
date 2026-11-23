/**
 * App update for admins: compare the project checkout (PROJECT_DIR) with its GitHub branch and,
 * when there are new commits, pull them (fast-forward only) and rebuild the touched services with
 * selfupdate (a detached helper container, so it survives the backend restart).
 * Private repos need UPDATE_GITHUB_TOKEN in .env; public repos (claude-chat-selfhosted) need nothing.
 */
import { execFile, spawn } from 'child_process';
import { chownSync, existsSync, lstatSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';

const dir = config.projectDir;

function git(args: string[], timeout = 30_000): Promise<string> {
  const token = (process.env.UPDATE_GITHUB_TOKEN || '').trim();
  const auth = token ? ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'safe.directory=*', ...auth, '-C', dir, ...args], {
      timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).replace(/x-access-token:[^@\s]+/g, '***').trim().split('\n').slice(-2).join(' ')));
      else resolve(stdout.trim());
    });
  });
}

export interface UpdateCommit { sha: string; subject: string; date: string }
export interface UpdateStatus {
  available: boolean; reason: string | null;
  repo: string | null; branch: string | null;
  current: UpdateCommit | null; latest: UpdateCommit | null;
  behind: number; ahead: number; dirty: number;
  incoming: UpdateCommit[]; services: string[];
  updating: boolean; checkedAt: string;
}

const commit = (line: string): UpdateCommit => { const [sha, date, ...s] = line.split('\x1f'); return { sha: sha.slice(0, 7), date, subject: s.join('\x1f') }; };
const FMT = '--format=%H\x1f%cI\x1f%s';

/** Services to rebuild for these changed paths. */
export function servicesFor(files: string[]): string[] {
  const s = new Set<string>();
  for (const f of files) {
    if (f.startsWith('backend/') || f.startsWith('database/') || f.startsWith('shared-skills/') || f.startsWith('signing/')) s.add('backend');
    else if (f.startsWith('frontend/')) s.add('frontend');
    else if (f.startsWith('nginx/')) s.add('nginx');
    else if (f === 'docker-compose.yml') { s.add('backend'); s.add('frontend'); }
  }
  return ['backend', 'frontend', 'nginx'].filter((x) => s.has(x));
}

let updating = false;
let updatingSince = 0;

async function target(): Promise<{ remote: string; branch: string; url: string }> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = (await git(['config', `branch.${branch}.remote`]).catch(() => '')) || (await git(['remote'])).split('\n')[0] || 'origin';
  const url = await git(['remote', 'get-url', remote]);
  return { remote, branch, url };
}

export async function updateStatus(): Promise<UpdateStatus> {
  if (updating && Date.now() - updatingSince > 20 * 60_000) updating = false;
  const base: UpdateStatus = { available: false, reason: null, repo: null, branch: null, current: null, latest: null, behind: 0, ahead: 0, dirty: 0, incoming: [], services: [], updating, checkedAt: new Date().toISOString() };
  if (!existsSync(join(dir, '.git'))) return { ...base, reason: `${dir} is geen git-checkout; installeer met git clone om bij te kunnen werken.` };
  let t: { remote: string; branch: string; url: string };
  try { t = await target(); } catch (e) { return { ...base, reason: `Git-gegevens niet te lezen: ${(e as Error).message}` }; }
  const repo = t.url.replace(/^https?:\/\/[^@]*@/, 'https://').replace(/\.git$/, '').replace(/^https:\/\/github\.com\//, '');
  const current = commit(await git(['log', '-1', FMT]));
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no']).catch(() => '')).split('\n').filter(Boolean).length;
  const out = { ...base, repo, branch: t.branch, current, dirty };
  try { await git(['fetch', '--quiet', t.remote, t.branch], 45_000); }
  catch (e) {
    const msg = (e as Error).message;
    const priv = /could not read|Authentication|403|404|terminal prompts/i.test(msg);
    return { ...out, reason: priv ? 'GitHub niet bereikbaar zonder toegang (privé-repo). Zet UPDATE_GITHUB_TOKEN in .env om te kunnen controleren.' : `GitHub niet bereikbaar: ${msg}` };
  }
  const ref = `${t.remote}/${t.branch}`;
  const latest = commit(await git(['log', '-1', FMT, ref]));
  const [behind, ahead] = (await git(['rev-list', '--left-right', '--count', `${ref}...HEAD`])).split(/\s+/).map(Number);
  const incoming = behind ? (await git(['log', FMT, '-n', '15', `HEAD..${ref}`])).split('\n').filter(Boolean).map(commit) : [];
  const services = behind ? servicesFor((await git(['diff', '--name-only', `HEAD...${ref}`])).split('\n').filter(Boolean)) : [];
  return { ...out, available: true, latest, behind, ahead, incoming, services };
}

/** Give files git just wrote (as root) back to the owner of the checkout. */
function chownBack(paths: string[], uid: number, gid: number): void {
  const walk = (p: string) => {
    try {
      const st = lstatSync(p);
      if (st.uid !== uid || st.gid !== gid) chownSync(p, uid, gid);
      if (st.isDirectory()) for (const c of readdirSync(p)) walk(join(p, c));
    } catch { /* ignore */ }
  };
  for (const p of paths) walk(p);
}

export async function runUpdate(): Promise<{ message: string; services: string[] }> {
  if (updating) throw new AppError(409, 'Er loopt al een update');
  const s = await updateStatus();
  if (!s.available) throw new AppError(400, s.reason ?? 'Bijwerken kan hier niet');
  if (!s.behind) throw new AppError(400, 'Je hebt al de laatste versie');
  if (s.ahead) throw new AppError(409, `Deze installatie heeft ${s.ahead} eigen commit(s) die niet op GitHub staan; bijwerken zou die overschrijven. Werk handmatig bij (git pull).`);
  if (s.dirty) throw new AppError(409, `Er zijn ${s.dirty} lokaal gewijzigde bestanden. Zet die eerst opzij (git stash) of commit ze.`);
  updating = true; updatingSince = Date.now();
  try {
    const owner = statSync(dir);
    const before = await git(['rev-parse', 'HEAD']);
    const t = await target();
    await git(['pull', '--ff-only', '--quiet', t.remote, t.branch], 120_000);
    const changed = (await git(['diff', '--name-only', before, 'HEAD'])).split('\n').filter(Boolean).map((f) => join(dir, f));
    if (process.getuid?.() === 0) chownBack([join(dir, '.git'), ...changed], owner.uid, owner.gid);
    const services = s.services;
    if (!services.length) { updating = false; return { message: 'Bijgewerkt; er hoefde niets opnieuw gebouwd te worden.', services }; }
    // --force: the admin chose to update now; selfupdate detaches, so this returns right away
    await new Promise<void>((resolve, reject) => {
      const p = spawn('selfupdate', ['--force', ...services], { env: { ...process.env, PROJECT_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `selfupdate exit ${code}`))));
    });
    return { message: `Bijgewerkt naar ${s.latest?.sha}. ${services.join(' en ')} wordt opnieuw gebouwd; de app herstart over een paar minuten.`, services };
  } catch (e) {
    updating = false;
    throw e instanceof AppError ? e : new AppError(500, `Bijwerken mislukt: ${(e as Error).message}`);
  }
}
