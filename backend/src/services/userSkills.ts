import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, chownSync, cpSync } from 'fs';
import { join } from 'path';

/**
 * A user's own skills: real folders in ~/.claude/skills (shared skills are symlinks there, see
 * linkSharedSkills in claudeCode.ts, which leaves real folders alone). Claude Code picks them up
 * on the next message.
 */

const CLAUDE_UID = 1001;
const CLAUDE_GID = 1001;
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
      if (lstatSync(p).isSymbolicLink() || !lstatSync(p).isDirectory()) continue;
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
    chownSync(join(home, '.claude'), CLAUDE_UID, CLAUDE_GID);
    chownSync(dir, CLAUDE_UID, CLAUDE_GID);
  }
  const target = join(dir, name);
  try { if (lstatSync(target).isSymbolicLink()) unlinkSync(target); } catch { /* not there yet */ }
  if (!existsSync(target)) {
    mkdirSync(target, { mode: 0o755 });
    chownSync(target, CLAUDE_UID, CLAUDE_GID);
  }
  const file = join(target, 'SKILL.md');
  writeFileSync(file, content, { mode: 0o644 });
  chownSync(file, CLAUDE_UID, CLAUDE_GID);
}

/** Copies a whole skill folder (SKILL.md plus scripts/files) to ~/.claude/skills/<name>, replacing what was there. */
export function installSkillDir(home: string, name: string, srcDir: string): void {
  if (!isValidSkillName(name)) throw new Error('Ongeldige naam');
  const dir = skillsDir(home);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chownSync(join(home, '.claude'), CLAUDE_UID, CLAUDE_GID);
    chownSync(dir, CLAUDE_UID, CLAUDE_GID);
  }
  const target = join(dir, name);
  try {
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
    else rmSync(target, { recursive: true, force: true });
  } catch { /* not there yet */ }
  cpSync(srcDir, target, { recursive: true, verbatimSymlinks: true });
  chownTree(target);
}

function chownTree(p: string): void {
  chownSync(p, CLAUDE_UID, CLAUDE_GID);
  if (lstatSync(p).isDirectory()) for (const e of readdirSync(p)) chownTree(join(p, e));
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
