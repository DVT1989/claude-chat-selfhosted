import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, basename } from 'path';
import { execFileSync } from 'child_process';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { parseFrontmatter, slugify, isValidSkillName, installSkillDir } from './userSkills';

/**
 * Import skills from a public GitHub repository: download the repo tarball, find every folder
 * with a SKILL.md under the given path and copy those folders (with their scripts and files)
 * into the user's ~/.claude/skills.
 */

const MAX_TARBALL_BYTES = 60 * 1024 * 1024;
const MAX_SKILL_DIR_BYTES = 15 * 1024 * 1024;
const MAX_SKILLS = 100;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', '__pycache__']);

export interface GithubRef { owner: string; repo: string; ref: string | null; path: string }

/**
 * Accepts: owner/repo, https://github.com/owner/repo(.git), .../tree/<ref>/<path>, .../blob/<ref>/<path>/SKILL.md
 * (a ref containing slashes is not supported: the first segment after tree/blob is taken as the ref).
 */
export function parseGithubUrl(input: string): GithubRef {
  const raw = input.trim().replace(/\/+$/, '');
  let rest: string;
  const m = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (m) rest = m[1];
  else if (/^[\w.-]+\/[\w.-]+$/.test(raw)) rest = raw;
  else throw new Error('Geef een GitHub-link, bijvoorbeeld https://github.com/eigenaar/repo');
  const parts = rest.split(/[?#]/)[0].split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('In de link ontbreekt de repo-naam.');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('Ongeldige eigenaar of repo-naam.');
  let ref: string | null = null;
  let path = '';
  if (parts[2] === 'tree' || parts[2] === 'blob') {
    ref = parts[3] ?? null;
    let p = parts.slice(4);
    if (parts[2] === 'blob' && p.length && /\.md$/i.test(p[p.length - 1])) p = p.slice(0, -1);
    path = p.join('/');
  }
  if (ref && !/^[\w.\-]+$/.test(ref)) throw new Error('Ongeldige branch of tag in de link.');
  if (path.split('/').some((s) => s === '..')) throw new Error('Ongeldig pad in de link.');
  return { owner, repo, ref, path };
}

export function sourceUrl(r: GithubRef, skillPath: string): string {
  const p = skillPath ? `/${skillPath}` : '';
  return `https://github.com/${r.owner}/${r.repo}/tree/${r.ref ?? 'HEAD'}${p}`;
}

export function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isDirectory()) total += dirSize(p);
    else total += st.size;
  }
  return total;
}

/** Folders under root that contain a SKILL.md (nested skills inside a skill are not searched). */
export function findSkillDirs(root: string, depth = 0): string[] {
  if (depth > 6 || !existsSync(root)) return [];
  if (existsSync(join(root, 'SKILL.md'))) return [root];
  const out: string[] = [];
  for (const e of readdirSync(root)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(root, e);
    try { if (lstatSync(p).isDirectory()) out.push(...findSkillDirs(p, depth + 1)); } catch { /* skip */ }
  }
  return out;
}

async function downloadTarball(r: GithubRef, file: string): Promise<void> {
  const url = `https://api.github.com/repos/${r.owner}/${r.repo}/tarball${r.ref ? `/${encodeURIComponent(r.ref)}` : ''}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'claude-chat-skill-import', Accept: 'application/vnd.github+json' }, redirect: 'follow' });
  if (res.status === 404) throw new Error('Repo of branch niet gevonden (alleen publieke repos worden ondersteund).');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub weigert even (limiet bereikt). Probeer het over een tijdje opnieuw.');
  if (!res.ok || !res.body) throw new Error(`GitHub gaf HTTP ${res.status}.`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_TARBALL_BYTES) throw new Error('De repo is te groot om te importeren (max 60 MB).');
  let seen = 0;
  const body = Readable.fromWeb(res.body as import('stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_TARBALL_BYTES) body.destroy(new Error('De repo is te groot om te importeren (max 60 MB).'));
  });
  await finished(body.pipe(createWriteStream(file)));
}

export interface ImportResult { imported: { name: string; source: string }[]; skipped: { path: string; reason: string }[] }

export async function importFromGithub(home: string, input: string): Promise<ImportResult> {
  const r = parseGithubUrl(input);
  const work = mkdtempSync(join(tmpdir(), 'skill-import-'));
  try {
    const tgz = join(work, 'repo.tgz');
    await downloadTarball(r, tgz);
    const ex = join(work, 'x');
    mkdirSync(ex);
    // GNU tar strips leading '/' and refuses '..' members by default; symlinks are removed right after
    execFileSync('tar', ['-xzf', tgz, '-C', ex, '--no-same-owner', '--no-same-permissions'], { stdio: 'pipe' });
    execFileSync('find', [ex, '-type', 'l', '-delete']);
    const top = readdirSync(ex)[0];
    if (!top) throw new Error('Lege repo.');
    const repoRoot = join(ex, top);
    const searchRoot = join(repoRoot, r.path);
    if (!existsSync(searchRoot) || !statSync(searchRoot).isDirectory()) throw new Error(`Map "${r.path}" bestaat niet in de repo.`);

    const dirs = findSkillDirs(searchRoot);
    if (dirs.length === 0) throw new Error('Geen skills gevonden: er staat geen SKILL.md in deze map of de mappen eronder.');
    if (dirs.length > MAX_SKILLS) throw new Error(`Te veel skills in één keer (${dirs.length}); kies een submap.`);

    const result: ImportResult = { imported: [], skipped: [] };
    const used = new Set<string>();
    for (const dir of dirs) {
      const rel = relative(repoRoot, dir).split('\\').join('/');
      const fm = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      const name = slugify(fm.name || basename(dir));
      if (!isValidSkillName(name)) { result.skipped.push({ path: rel || '/', reason: 'geen geldige naam' }); continue; }
      if (used.has(name)) { result.skipped.push({ path: rel, reason: `naam "${name}" komt dubbel voor` }); continue; }
      if (!fm.description) { result.skipped.push({ path: rel || '/', reason: 'SKILL.md heeft geen description' }); continue; }
      if (dirSize(dir) > MAX_SKILL_DIR_BYTES) { result.skipped.push({ path: rel, reason: 'map is groter dan 15 MB' }); continue; }
      const source = sourceUrl(r, rel);
      writeFileSync(join(dir, '.source.json'), JSON.stringify({ url: source, importedAt: new Date().toISOString() }, null, 2));
      installSkillDir(home, name, dir);
      used.add(name);
      result.imported.push({ name, source });
    }
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_ZIP_UNPACKED = 100 * 1024 * 1024;

/**
 * Import skills from an uploaded .skill or .zip (as exported by Claude Desktop): unpack, find every folder with
 * a SKILL.md and install it with its assets (scripts, references, assets). Symlinks are removed, paths outside the
 * target are skipped by unzip, and the unpacked size is limited.
 */
export function importFromZip(home: string, data: Buffer, filename: string): ImportResult {
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) throw new Error('Dit is geen geldig .skill- of .zip-bestand.');
  if (data.length > MAX_ZIP_BYTES) throw new Error('Het bestand is te groot (max 30 MB).');
  const work = mkdtempSync(join(tmpdir(), 'skill-zip-'));
  try {
    const zip = join(work, 'in.zip');
    writeFileSync(zip, data);
    const info = execFileSync('unzip', ['-Z', '-t', zip], { stdio: 'pipe', timeout: 30000 }).toString();
    const total = Number(info.match(/([\d]+) bytes uncompressed/)?.[1] ?? 0);
    if (!total || total > MAX_ZIP_UNPACKED) throw new Error('Het bestand is leeg of te groot na uitpakken (max 100 MB).');
    const ex = join(work, 'x');
    mkdirSync(ex);
    try { execFileSync('unzip', ['-q', '-o', zip, '-d', ex], { stdio: 'pipe', timeout: 60000 }); }
    catch (e) {
      // exit code 1 = warnings only (for example skipped unsafe paths): continue; anything else = broken archive
      if ((e as { status?: number }).status !== 1) throw new Error('Uitpakken mislukt: het bestand is beschadigd.');
    }
    execFileSync('find', [ex, '-type', 'l', '-delete']);
    execFileSync('find', [ex, '-name', '__MACOSX', '-prune', '-exec', 'rm', '-rf', '{}', ';']);
    const dirs = findSkillDirs(ex);
    if (dirs.length === 0) throw new Error('Geen skill gevonden: er zit geen SKILL.md in dit bestand.');
    if (dirs.length > MAX_SKILLS) throw new Error(`Te veel skills in één bestand (${dirs.length}).`);
    const fallback = basename(filename).replace(/\.(skill|zip)$/i, '');
    const result: ImportResult = { imported: [], skipped: [] };
    const used = new Set<string>();
    for (const dir of dirs) {
      const rel = relative(ex, dir).split('\\').join('/');
      const fm = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      const name = slugify(fm.name || (dir === ex ? fallback : basename(dir)));
      if (!isValidSkillName(name)) { result.skipped.push({ path: rel || '/', reason: 'geen geldige naam' }); continue; }
      if (used.has(name)) { result.skipped.push({ path: rel, reason: `naam "${name}" komt dubbel voor` }); continue; }
      if (!fm.description) { result.skipped.push({ path: rel || '/', reason: 'SKILL.md heeft geen description' }); continue; }
      if (dirSize(dir) > MAX_SKILL_DIR_BYTES) { result.skipped.push({ path: rel, reason: 'map is groter dan 15 MB' }); continue; }
      installSkillDir(home, name, dir);
      used.add(name);
      result.imported.push({ name, source: '' });
    }
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
