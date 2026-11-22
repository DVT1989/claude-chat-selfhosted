/**
 * Personal memory per user, in the database: every Claude run of that user (any linked
 * subscription, web, admin chat, Telegram/WhatsApp, agents) reads and writes it with a per-run
 * token. Only a small core goes into CLAUDE.md; the rest Claude searches when it needs it, so the
 * context does not grow with the memory. Strictly per user: the token maps to one user id.
 */
import { randomBytes } from 'crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { query } from '../db';
import { redis } from '../redis';

export interface Memory {
  id: string; topic: string; content: string; tags: string; pinned: boolean;
  use_count: number; last_used_at: string | null; created_at: string; updated_at: string;
  /** set by the cleanup job (services/learning.ts): out of the core, still searchable; never deleted */
  archived_at: string | null; archive_reason: string | null; merged_into: string | null;
}

const TOKEN_TTL_SEC = 12 * 3600;
const tokenKey = (t: string) => `memory:claude:${t}`;
const COLS = 'id, topic, content, tags, pinned, use_count, last_used_at, created_at, updated_at, archived_at, archive_reason, merged_into';

export async function ensureMemorySchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('dutch', topic || ' ' || tags), 'A') || setweight(to_tsvector('dutch', content), 'B')
      ) STORED
    )`);
  await query('CREATE INDEX IF NOT EXISTS user_memories_user_idx ON user_memories (user_id)');
  await query('CREATE INDEX IF NOT EXISTS user_memories_tsv_idx ON user_memories USING GIN (tsv)');
  await query('CREATE UNIQUE INDEX IF NOT EXISTS user_memories_text_idx ON user_memories (user_id, md5(lower(content)))');
  // cleanup job: long unused or merged facts leave the core but stay in the table (with a trail in learn_log)
  await query('ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
  await query('ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS archive_reason TEXT');
  await query('ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS merged_into UUID');
}

export async function issueMemoryToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redis.set(tokenKey(token), userId, 'EX', TOKEN_TTL_SEC);
  return token;
}

export async function userForMemoryToken(token: string): Promise<string | null> {
  if (!token || token.length > 100) return null;
  return redis.get(tokenKey(token));
}

const normTopic = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9à-ü_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'algemeen';

/** Search: full text (Dutch stemming), any of the words; falls back to a plain substring match. */
export async function searchMemories(userId: string, q: string, topic: string | null, limit: number, touch = true): Promise<Memory[]> {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 12) ?? [];
  const t = topic ? normTopic(topic) : null;
  let rows: Memory[];
  if (!words.length) {
    rows = (await query<Memory>(
      `SELECT ${COLS} FROM user_memories WHERE user_id = $1 AND merged_into IS NULL AND ($2::text IS NULL OR topic = $2)
       ORDER BY (archived_at IS NULL) DESC, pinned DESC, use_count DESC, updated_at DESC LIMIT $3`, [userId, t, limit])).rows;
  } else {
    const tsq = words.map((w) => `${w}:*`).join(' | ');
    rows = (await query<Memory>(
      `SELECT ${COLS} FROM user_memories, to_tsquery('dutch', $2) q
       WHERE user_id = $1 AND merged_into IS NULL AND ($3::text IS NULL OR topic = $3) AND tsv @@ q
       ORDER BY (archived_at IS NULL) DESC, ts_rank(tsv, q) DESC, use_count DESC LIMIT $4`, [userId, tsq, t, limit])).rows;
    if (!rows.length) {
      rows = (await query<Memory>(
        `SELECT ${COLS} FROM user_memories WHERE user_id = $1 AND merged_into IS NULL AND ($2::text IS NULL OR topic = $2)
         AND (content ILIKE $3 OR tags ILIKE $3 OR topic ILIKE $3) ORDER BY use_count DESC LIMIT $4`,
        [userId, t, `%${q.trim().slice(0, 100)}%`, limit])).rows;
    }
  }
  if (touch && rows.length) {
    // a fact archived only for being unused comes back as soon as it is used again
    await query(`UPDATE user_memories SET use_count = use_count + 1, last_used_at = now(),
                   archived_at = CASE WHEN archive_reason = 'ongebruikt' THEN NULL ELSE archived_at END,
                   archive_reason = CASE WHEN archive_reason = 'ongebruikt' THEN NULL ELSE archive_reason END
                 WHERE user_id = $1 AND id = ANY($2)`, [userId, rows.map((r) => r.id)]);
  }
  return rows;
}

export async function listMemories(userId: string): Promise<Memory[]> {
  return (await query<Memory>(`SELECT ${COLS} FROM user_memories WHERE user_id = $1 ORDER BY topic, pinned DESC, updated_at DESC`, [userId])).rows;
}

export async function topics(userId: string): Promise<Array<{ topic: string; count: number }>> {
  return (await query<{ topic: string; count: number }>(
    'SELECT topic, count(*)::int AS count FROM user_memories WHERE user_id = $1 AND merged_into IS NULL GROUP BY topic ORDER BY count DESC, topic', [userId])).rows;
}

export async function addMemory(userId: string, m: { topic: string; content: string; tags?: string; pinned?: boolean }): Promise<{ result: 'added' | 'exists'; id: string }> {
  const r = await query<{ id: string }>(
    `INSERT INTO user_memories (user_id, topic, content, tags, pinned) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, md5(lower(content))) DO NOTHING RETURNING id`,
    [userId, normTopic(m.topic), m.content.trim(), (m.tags ?? '').trim(), m.pinned ?? false]);
  if (r.rows[0]) return { result: 'added', id: r.rows[0].id };
  const ex = await query<{ id: string }>('SELECT id FROM user_memories WHERE user_id = $1 AND md5(lower(content)) = md5(lower($2))', [userId, m.content.trim()]);
  return { result: 'exists', id: ex.rows[0]?.id ?? '' };
}

export async function updateMemory(userId: string, id: string, m: { topic?: string; content?: string; tags?: string; pinned?: boolean }): Promise<boolean> {
  const r = await query(
    `UPDATE user_memories SET topic = COALESCE($3, topic), content = COALESCE($4, content), tags = COALESCE($5, tags),
       pinned = COALESCE($6, pinned), updated_at = now() WHERE user_id = $1 AND id = $2`,
    [userId, id, m.topic ? normTopic(m.topic) : null, m.content?.trim() ?? null, m.tags ?? null, m.pinned ?? null]);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  return ((await query('DELETE FROM user_memories WHERE user_id = $1 AND id = $2', [userId, id])).rowCount ?? 0) > 0;
}

/** What goes into CLAUDE.md: pinned facts plus the most used ones, and the topic list. */
export async function memoryCore(userId: string): Promise<{ core: Array<{ id: string; topic: string; content: string; pinned: boolean }>; topics: Array<{ topic: string; count: number }>; total: number }> {
  const core = (await query<{ id: string; topic: string; content: string; pinned: boolean }>(
    `SELECT id, topic, content, pinned FROM user_memories WHERE user_id = $1
     AND archived_at IS NULL ORDER BY pinned DESC, use_count DESC, updated_at DESC LIMIT 12`, [userId])).rows;
  const t = await topics(userId);
  return { core, topics: t, total: t.reduce((n, x) => n + x.count, 0) };
}

/**
 * One-time import of Claude Code's file memory (~/.claude/projects/<project>/memory/*.md) from the
 * user's own homes: the normal one, linked accounts and the admin home.
 */
export async function importFileMemories(userId: string, homes: string[]): Promise<{ added: number; existing: number }> {
  let added = 0, existing = 0;
  for (const home of homes) {
    const projects = join(home, '.claude', 'projects');
    if (!existsSync(projects)) continue;
    for (const p of readdirSync(projects)) {
      const dir = join(projects, p, 'memory');
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
        const raw = readFileSync(join(dir, f), 'utf8');
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        const get = (k: string) => fm?.[1].match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1].trim() ?? '';
        const body = (fm ? fm[2] : raw).trim();
        if (!body) continue;
        const desc = get('description');
        const content = (desc ? `${desc}\n\n${body}` : body).slice(0, 4000);
        const r = await addMemory(userId, { topic: get('type') || 'algemeen', content, tags: get('name') || f.replace(/\.md$/, '') });
        if (r.result === 'added') added++; else existing++;
      }
    }
  }
  return { added, existing };
}
