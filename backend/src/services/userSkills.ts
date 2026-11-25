import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, readlinkSync, symlinkSync, writeFileSync, chownSync, cpSync } from 'fs';
import { join } from 'path';
import { query } from '../db';
import { chownRun, chownRunTree } from './runUsers';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';

/**
 * A user's own skills: real folders in ~/.claude/skills (shared skills are symlinks there, see
 * linkSharedSkills in claudeCode.ts, which leaves real folders alone). Claude Code picks them up
 * on the next message.
 */

/** Marker in a skill folder that is a copy of a skill another admin shares (homes are private, so no symlinks). */
const SHARED_COPY_MARK = '.shared-copy';
export const MAX_SKILL_BYTES = 200 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** source: GitHub folder the skill was imported from (from .source.json), if any */
export interface OwnSkill { name: string; description: string; sizeKB: number; updatedAt: string; source?: string }

export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

/** "Mijn Skill!" -> "mijn-skill" */
export function slugify(input: string): string {
  return input.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** Reads `name` and `description` from a SKILL.md YAML frontmatter block (simple key: value lines). */
export function parseFrontmatter(md: string): { name?: string; description?: string; body: string; hasFrontmatter: boolean } {
  const m = md.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: md, hasFrontmatter: false };
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try { v = v.startsWith('"') ? JSON.parse(v) as string : v.slice(1, -1).replace(/''/g, "'"); } catch { v = v.slice(1, -1); }
    }
    out[kv[1] as 'name' | 'description'] = v;
  }
  return { ...out, body: m[2], hasFrontmatter: true };
}

export function buildSkillMd(name: string, description: string, body: string): string {
  // JSON string quoting is valid YAML and survives colons, quotes and '#'
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description.replace(/\s+/g, ' ').trim())}\n---\n\n${body.trim()}\n`;
}

export interface SkillInput { name?: string; description?: string; instructions?: string; skillMd?: string }

/** Turns form fields or an uploaded SKILL.md into a validated name + file content. Throws with a Dutch message. */
export function prepareSkill(input: SkillInput): { name: string; content: string } {
  let name = (input.name ?? '').trim();
  let description = (input.description ?? '').trim();
  let body = input.instructions ?? '';
  if (input.skillMd && input.skillMd.trim()) {
    const fm = parseFrontmatter(input.skillMd);
    name = name || fm.name || '';
    description = description || fm.description || '';
    body = fm.body;
  }
  name = slugify(name);
  if (!isValidSkillName(name)) throw new Error('Geef de skill een naam (letters, cijfers en streepjes).');
  if (!description) throw new Error('Geef een beschrijving: daaraan ziet Claude wanneer de skill nodig is.');
  if (!body.trim()) throw new Error('De skill heeft nog geen instructies.');
  const content = buildSkillMd(name, description, body);
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new Error('De skill is te groot (max 200 KB).');
  return { name, content };
}

function skillsDir(home: string): string {
  return join(home, '.claude', 'skills');
}

export function listOwnSkills(home: string): OwnSkill[] {
  const dir = skillsDir(home);
  if (!existsSync(dir)) return [];
  const out: OwnSkill[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    try {
      if (lstatSync(p).isSymbolicLink() || !lstatSync(p).isDirectory() || existsSync(join(p, SHARED_COPY_MARK))) continue;
      const file = join(p, 'SKILL.md');
      if (!existsSync(file)) continue;
      const fm = parseFrontmatter(readFileSync(file, 'utf8'));
      const st = statSync(file);
      let source: string | undefined;
      try { source = (JSON.parse(readFileSync(join(p, '.source.json'), 'utf8')) as { url?: string }).url; } catch { /* own-made skill */ }
      out.push({ name: entry, description: fm.description ?? '', sizeKB: Math.max(1, Math.round(st.size / 1024)), updatedAt: st.mtime.toISOString(), source });
    } catch { /* skip unreadable entries */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Writes ~/.claude/skills/<name>/SKILL.md. A shared skill with the same name is replaced for this user only. */
export function saveOwnSkill(home: string, name: string, content: string): void {
  if (!isValidSkillName(name)) throw new Error('Ongeldige naam');
  const dir = skillsDir(home);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chownRun(join(home, '.claude'));
    chownRun(dir);
  }
  const target = join(dir, name);
  try { if (lstatSync(target).isSymbolicLink()) unlinkSync(target); } catch { /* not there yet */ }
  if (!existsSync(target)) {
    mkdirSync(target, { mode: 0o755 });
    chownRun(target);
  }
  const file = join(target, 'SKILL.md');
  writeFileSync(file, content, { mode: 0o644 });
  chownRun(file);
}

/** Copies a whole skill folder (SKILL.md plus scripts/files) to ~/.claude/skills/<name>, replacing what was there. */
export function installSkillDir(home: string, name: string, srcDir: string): void {
  if (!isValidSkillName(name)) throw new Error('Ongeldige naam');
  const dir = skillsDir(home);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chownRun(join(home, '.claude'));
    chownRun(dir);
  }
  const target = join(dir, name);
  try {
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
    else rmSync(target, { recursive: true, force: true });
  } catch { /* not there yet */ }
  cpSync(srcDir, target, { recursive: true, verbatimSymlinks: true });
  chownRunTree(target);
}

/** Removes an own skill. Shared skills (symlinks) cannot be removed this way. Returns false when not found. */
export function deleteOwnSkill(home: string, name: string): boolean {
  if (!isValidSkillName(name)) return false;
  const target = join(skillsDir(home), name);
  try {
    if (lstatSync(target).isSymbolicLink()) return false;
  } catch { return false; }
  rmSync(target, { recursive: true, force: true });
  return true;
}

// ── Sharing by admins ───────────────────────────────────────────
export interface SharedSkill { name: string; description: string; owner: string; sizeKB: number; updatedAt: string }

const homeOf = (userId: string) => join(config.claudeHomesRoot, `user-${userId}`);

export interface SkillShare { visibility: 'private' | 'selected' | 'all'; users: string[]; groups: string[] }

export async function ensureSkillSharingSchema(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS shared_skills (
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, name))`);
  // existing rows keep meaning "everyone"
  await query(`ALTER TABLE shared_skills ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'all',
    ADD COLUMN IF NOT EXISTS share_users UUID[] NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS share_groups UUID[] NOT NULL DEFAULT '{}'`);
}

/** Sharing of this owner's skills, by skill name (skills that are not shared are absent). */
export async function sharedNamesOf(ownerId: string): Promise<Map<string, SkillShare>> {
  const r = await query<{ name: string; visibility: string; share_users: string[]; share_groups: string[] }>(
    'SELECT name, visibility, share_users::text[] AS share_users, share_groups::text[] AS share_groups FROM shared_skills WHERE owner_id = $1', [ownerId]);
  return new Map(r.rows.map((x) => [x.name, { visibility: x.visibility === 'selected' ? 'selected' : 'all', users: x.share_users ?? [], groups: x.share_groups ?? [] } as SkillShare]));
}

/** Set who can use one of the owner's own skills: nobody (private), chosen users/groups, or everyone. */
export async function setSkillShare(ownerId: string, name: string, s: SkillShare): Promise<void> {
  if (!isValidSkillName(name)) throw new AppError(404, 'Skill niet gevonden');
  if (s.visibility === 'private') {
    await query('DELETE FROM shared_skills WHERE owner_id = $1 AND name = $2', [ownerId, name]);
    return;
  }
  const own = listOwnSkills(homeOf(ownerId)).some((x) => x.name === name);
  if (!own) throw new AppError(404, 'Skill niet gevonden');
  const users = s.visibility === 'selected' ? [...new Set(s.users)].filter((u) => u !== ownerId) : [];
  const groups = s.visibility === 'selected' ? [...new Set(s.groups)] : [];
  if (users.length) {
    const r = await query('SELECT 1 FROM users WHERE id = ANY($1::uuid[])', [users]);
    if (r.rowCount !== users.length) throw new AppError(400, 'Onbekende gebruiker');
  }
  if (groups.length) {
    const r = await query('SELECT 1 FROM user_groups WHERE id = ANY($1::uuid[])', [groups]);
    if (r.rowCount !== groups.length) throw new AppError(400, 'Onbekende groep');
  }
  await query(`INSERT INTO shared_skills (owner_id, name, visibility, share_users, share_groups) VALUES ($1,$2,$3,$4::uuid[],$5::uuid[])
    ON CONFLICT (owner_id, name) DO UPDATE SET visibility = EXCLUDED.visibility, share_users = EXCLUDED.share_users, share_groups = EXCLUDED.share_groups`,
    [ownerId, name, s.visibility, users, groups]);
}

/** Share (or stop sharing) one of the owner's own skills with everyone (old on/off switch). */
export async function setSkillShared(ownerId: string, name: string, shared: boolean): Promise<void> {
  await setSkillShare(ownerId, name, { visibility: shared ? 'all' : 'private', users: [], groups: [] });
}

/**
 * Skills other admins share with this user (everyone, or chosen users/groups), as folders in their home. Own skills of the user win on
 * a name clash, and the first sharer wins between two admins. Only skills that still exist are returned.
 */
export async function listSharedSkills(userId: string): Promise<Array<SharedSkill & { dir: string }>> {
  const r = await query<{ owner_id: string; name: string; owner: string }>(
    `SELECT s.owner_id, s.name, u.name AS owner FROM shared_skills s JOIN users u ON u.id = s.owner_id
     WHERE s.owner_id <> $1 AND u.is_active
       AND (s.visibility = 'all' OR (s.visibility = 'selected' AND ($1::uuid = ANY(s.share_users)
            OR EXISTS (SELECT 1 FROM user_group_members m WHERE m.user_id = $1 AND m.group_id = ANY(s.share_groups)))))
     ORDER BY s.created_at`, [userId]);
  const mine = new Set(listOwnSkills(homeOf(userId)).map((x) => x.name));
  const seen = new Set<string>();
  const out: Array<SharedSkill & { dir: string }> = [];
  for (const row of r.rows) {
    if (mine.has(row.name) || seen.has(row.name)) continue;
    const dir = join(homeOf(row.owner_id), '.claude', 'skills', row.name);
    try {
      if (lstatSync(dir).isSymbolicLink()) continue;
      const file = join(dir, 'SKILL.md');
      const st = statSync(file);
      out.push({ name: row.name, owner: row.owner, description: parseFrontmatter(readFileSync(file, 'utf8')).description ?? '',
        sizeKB: Math.max(1, Math.round(st.size / 1024)), updatedAt: st.mtime.toISOString(), dir });
      seen.add(row.name);
    } catch { /* skill gone: skip */ }
  }
  return out;
}

/**
 * Link the skills shared by admins into <home>/.claude/skills (symlinks to the owner's folder, so the
 * owner's edits reach everyone). Real folders (own skills) and NAS-synced links are left alone; links
 * that are no longer shared are removed.
 */
export async function linkUserSharedSkills(userId: string, home: string): Promise<void> {
  try {
    const wanted = new Map((await listSharedSkills(userId)).map((s) => [s.name, s.dir]));
    const target = join(home, '.claude', 'skills');
    if (!existsSync(target)) {
      if (!wanted.size) return;
      mkdirSync(target, { recursive: true, mode: 0o755 });
      chownRun(join(home, '.claude'));
      chownRun(target);
    }
    for (const name of readdirSync(target)) {
      const p = join(target, name);
      const st = lstatSync(p);
      // old style: symlink into the owner's home (unreadable now that homes are private) or a copy that is no longer shared
      if (st.isSymbolicLink()) {
        if (readlinkSync(p).startsWith(config.claudeHomesRoot)) unlinkSync(p);
      } else if (st.isDirectory() && existsSync(join(p, SHARED_COPY_MARK)) && !wanted.has(name)) {
        rmSync(p, { recursive: true, force: true });
      }
    }
    for (const [name, dir] of wanted) {
      const link = join(target, name);
      try {
        const st = lstatSync(link);
        if (!st.isDirectory() || st.isSymbolicLink() || !existsSync(join(link, SHARED_COPY_MARK))) continue; // real own skill / NAS link: leave alone
      } catch { /* not there yet */ }
      // copy (the owner's edits reach everyone at the next run)
      rmSync(link, { recursive: true, force: true });
      cpSync(dir, link, { recursive: true, verbatimSymlinks: false, dereference: true });
      writeFileSync(join(link, SHARED_COPY_MARK), dir);
      chownRunTree(link);
    }
  } catch (err) {
    console.error('[skills] could not link skills shared by admins:', (err as Error).message);
  }
}
