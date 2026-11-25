/**
 * App update for admins: compare the project checkout (PROJECT_DIR) with its GitHub branch and,
 * when there are new commits, pull them (fast-forward only) and rebuild the touched services with
 * selfupdate (a detached helper container, so it survives the backend restart).
 * Local edits (uncommitted) are kept: they are stashed, the update is pulled and the stash is put back. When
 * that conflicts, a privileged Claude run merges the conflicting files (new functions from GitHub plus the own
 * edits); if markers remain, everything goes back to the old commit with the local edits as they were.
 * Private repos need UPDATE_GITHUB_TOKEN in .env; public repos (claude-chat-selfhosted) need nothing.
 */
import { execFile, spawn } from 'child_process';
import { chmodSync, chownSync, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'fs';
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
  phase: string | null; lastError: string | null;
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
let phase: string | null = null;
let lastError: string | null = null;

async function target(): Promise<{ remote: string; branch: string; url: string }> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = (await git(['config', `branch.${branch}.remote`]).catch(() => '')) || (await git(['remote'])).split('\n')[0] || 'origin';
  const url = await git(['remote', 'get-url', remote]);
  return { remote, branch, url };
}

export async function updateStatus(): Promise<UpdateStatus> {
  if (updating && Date.now() - updatingSince > 40 * 60_000) updating = false;
  const base: UpdateStatus = { available: false, reason: null, repo: null, branch: null, current: null, latest: null, behind: 0, ahead: 0, dirty: 0, incoming: [], services: [], updating, phase: updating ? phase : null, lastError, checkedAt: new Date().toISOString() };
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
      // group-writable: the admin chat runs as another uid with gid 0
      if (!st.isSymbolicLink() && !(st.mode & 0o020)) chmodSync(p, (st.mode & 0o7777) | 0o020);
      if (st.isDirectory()) for (const c of readdirSync(p)) walk(join(p, c));
    } catch { /* ignore */ }
  };
  for (const p of paths) walk(p);
}

function selfupdate(services: string[]): Promise<void> {
  // --force: the admin chose to update now; selfupdate detaches, so this returns right away
  return new Promise<void>((resolve, reject) => {
    const p = spawn('selfupdate', ['--force', ...services], { env: { ...process.env, PROJECT_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `selfupdate exit ${code}`))));
  });
}

const MARKER = /^(<<<<<<< |=======$|>>>>>>> )/m;

/** Files that still hold conflict markers. */
function withMarkers(files: string[]): string[] {
  return files.filter((f) => { try { return MARKER.test(readFileSync(join(dir, f), 'utf8')); } catch { return false; } });
}

/** Let a privileged Claude run (as the admin who clicked) merge the conflicting files. */
async function claudeMerge(userId: string, files: string[], from: string, to: string): Promise<void> {
  const { runTask, getAdminWorkspace } = await import('./claudeCode');
  const prompt = [
    `[Automatische app-update] Na git pull (${from.slice(0, 7)} -> ${to.slice(0, 7)}) in ${dir} gaf het terugzetten van de lokale wijzigingen (git stash pop) conflicten in:`,
    ...files.map((f) => `- ${join(dir, f)}`),
    '',
    'Los elk conflict op door beide kanten samen te voegen: houd de nieuwe functies en fixes van GitHub (Updated upstream) en houd de eigen lokale bewerkingen (Stashed changes). Kies alleen een kant als ze echt hetzelfde doen; dan de vollediger versie.',
    'Regels: wijzig alleen deze bestanden, haal alle conflictmarkeringen weg, maak geen .bak, geen commit, geen git stash/reset/checkout, geen selfupdate of docker compose up/restart.',
    'Controleer daarna dat de code compileert: bij backend-bestanden `docker compose -f ' + join(dir, 'docker-compose.yml') + ' build backend`, bij frontend-bestanden hetzelfde met frontend. Herstel fouten die door het samenvoegen komen.',
    'Eindig met een verslag van hooguit 5 regels: per bestand wat je samenvoegde.',
  ].join('\n');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25 * 60_000);
  try {
    await runTask(userId, prompt, null, () => { /* events not needed */ }, ac.signal, undefined, getAdminWorkspace(userId), 'nl', undefined, undefined, { privileged: true });
  } finally { clearTimeout(timer); }
}

async function doUpdate(userId: string, s: UpdateStatus): Promise<{ message: string; services: string[] }> {
  const owner = statSync(dir);
  const before = await git(['rev-parse', 'HEAD']);
  const t = await target();
  let stashed = false;
  // files git rewrites as root go back to the checkout owner, so the admin chat (and the merge run) can edit them
  const local = (await git(['diff', '--name-only', 'HEAD']).catch(() => '')).split('\n').filter(Boolean);
  const giveBack = (files: string[]) => { if (process.getuid?.() === 0) chownBack([join(dir, '.git'), ...[...new Set([...local, ...files])].map((f) => join(dir, f))], owner.uid, owner.gid); };
  if (s.dirty) {
    phase = 'Lokale wijzigingen opzij zetten';
    await git(['stash', 'push', '-m', `auto voor update ${new Date().toISOString()}`]);
    stashed = true;
  }
  phase = 'Update binnenhalen';
  try { await git(['pull', '--ff-only', '--quiet', t.remote, t.branch], 120_000); }
  catch (e) { if (stashed) await git(['stash', 'pop']).catch(() => undefined); throw e; }
  const after = await git(['rev-parse', 'HEAD']);
  const changed = (await git(['diff', '--name-only', before, 'HEAD'])).split('\n').filter(Boolean);
  let merged: string[] = [];
  if (stashed) {
    phase = 'Lokale wijzigingen terugzetten';
    const popped = await git(['stash', 'pop']).then(() => true).catch(() => false);
    if (!popped) {
      merged = (await git(['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
      if (!merged.length) throw new Error('git stash pop mislukt zonder conflictbestanden; de wijzigingen staan nog in git stash list');
      giveBack(changed);
      phase = `Claude voegt ${merged.length} bestand(en) samen`;
      let left = merged;
      try { await claudeMerge(userId, merged, before, after); left = withMarkers(merged); }
      catch (e) { console.error('[update] claude merge failed:', (e as Error).message); }
      if (left.length) {
        // back to the old commit with the local edits exactly as they were (the stash is still there after a failed pop)
        phase = 'Terugdraaien';
        await git(['reset', '--hard', '--quiet', before]);
        await git(['stash', 'pop']);
        giveBack(changed);
        throw new Error(`Samenvoegen niet gelukt (${left.join(', ')}). Teruggezet naar ${before.slice(0, 7)} met je lokale wijzigingen.`);
      }
      await git(['reset', '-q']);
      await git(['stash', 'drop']);
    }
  }
  giveBack(changed);
  const services = s.services;
  const kept = s.dirty ? ` Je ${s.dirty} lokale wijziging(en) zijn behouden${merged.length ? `; Claude heeft ${merged.length} bestand(en) samengevoegd` : ''}.` : '';
  if (!services.length) return { message: `Bijgewerkt naar ${s.latest?.sha}; er hoefde niets opnieuw gebouwd te worden.${kept}`, services };
  phase = `${services.join(' en ')} opnieuw bouwen`;
  await selfupdate(services);
  return { message: `Bijgewerkt naar ${s.latest?.sha}.${kept} ${services.join(' en ')} wordt opnieuw gebouwd; de app herstart over een paar minuten.`, services };
}

export async function runUpdate(userId: string): Promise<{ message: string; services: string[] }> {
  if (updating) throw new AppError(409, 'Er loopt al een update');
  const s = await updateStatus();
  if (!s.available) throw new AppError(400, s.reason ?? 'Bijwerken kan hier niet');
  if (!s.behind) throw new AppError(400, 'Je hebt al de laatste versie');
  if (s.ahead) throw new AppError(409, `Deze installatie heeft ${s.ahead} eigen commit(s) die niet op GitHub staan; bijwerken zou die overschrijven. Werk handmatig bij (git pull).`);
  updating = true; updatingSince = Date.now(); lastError = null; phase = 'Starten';
  const finish = (e?: unknown) => {
    updating = false; phase = null;
    if (e) { lastError = e instanceof AppError ? e.message : `Bijwerken mislukt: ${(e as Error).message}`; console.error('[update]', lastError); }
  };
  if (!s.dirty) {
    try { const r = await doUpdate(userId, s); if (!r.services.length) finish(); return r; }
    catch (e) { finish(e); throw new AppError(500, lastError!); }
  }
  // with local edits the merge can take minutes (Claude): run in the background, the page polls the status
  void doUpdate(userId, s).then((r) => { if (!r.services.length) finish(); else phase = r.message; }).catch(finish);
  return { message: `Bijwerken gestart: je ${s.dirty} lokale wijziging(en) worden bewaard en zo nodig door Claude samengevoegd met de update.`, services: s.services.length ? s.services : ['pending'] };
}
