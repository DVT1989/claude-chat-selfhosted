/**
 * Shared lessons: technical things Claude learned about this app and its connectors (what went
 * wrong and what works), for every account. No personal data: that stays in each account's own
 * Claude memory. Each run gets the lessons of the connectors it has, so the token cost stays small.
 */
import { randomBytes } from 'crypto';
import { query } from '../db';
import { redis } from '../redis';

export interface Lesson { id: string; topic: string; lesson: string; created_at: string; author: string | null }

const MAX_PER_RUN = 40;
const TOKEN_TTL_SEC = 6 * 3600;
const tokenKey = (t: string) => `lessons:claude:${t}`;

/** Topics that always apply; the rest only when the run has that connector. */
const ALWAYS = new Set(['app', 'algemeen', 'chat', 'git', 'security']);

export async function ensureLessonsSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS shared_lessons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      topic TEXT NOT NULL,
      lesson TEXT NOT NULL,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS shared_lessons_text_idx ON shared_lessons (lower(lesson))');
}

export async function listLessons(): Promise<Lesson[]> {
  const r = await query<Lesson>(
    `SELECT l.id, l.topic, l.lesson, l.created_at, u.name AS author
     FROM shared_lessons l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.topic, l.created_at`);
  return r.rows;
}

/** Lessons for one run: general ones plus those of the connector types it has. */
export async function lessonsFor(types: string[]): Promise<Array<{ topic: string; lesson: string }>> {
  const want = new Set([...ALWAYS, ...types]);
  const all = await listLessons();
  return all.filter((l) => want.has(l.topic)).slice(-MAX_PER_RUN).map(({ topic, lesson }) => ({ topic, lesson }));
}

export async function addLesson(userId: string, topic: string, lesson: string): Promise<'added' | 'exists'> {
  const r = await query(
    `INSERT INTO shared_lessons (topic, lesson, user_id) VALUES ($1, $2, $3) ON CONFLICT (lower(lesson)) DO NOTHING`,
    [topic, lesson, userId]);
  return (r.rowCount ?? 0) > 0 ? 'added' : 'exists';
}

/** Same as addLesson, with the id (new or existing) so the learning loop can log and undo it. */
export async function addLessonWithId(userId: string, topic: string, lesson: string): Promise<{ result: 'added' | 'exists'; id: string }> {
  const r = await query<{ id: string }>(
    `INSERT INTO shared_lessons (topic, lesson, user_id) VALUES ($1, $2, $3) ON CONFLICT (lower(lesson)) DO NOTHING RETURNING id`,
    [topic, lesson, userId]);
  if (r.rows[0]) return { result: 'added', id: r.rows[0].id };
  const ex = await query<{ id: string }>('SELECT id FROM shared_lessons WHERE lower(lesson) = lower($1)', [lesson]);
  return { result: 'exists', id: ex.rows[0]?.id ?? '' };
}

export async function deleteLesson(id: string): Promise<void> {
  await query('DELETE FROM shared_lessons WHERE id = $1', [id]);
}

export async function issueLessonToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await redis.set(tokenKey(token), userId, 'EX', TOKEN_TTL_SEC);
  return token;
}

export async function userForLessonToken(token: string): Promise<string | null> {
  if (!token || token.length < 20) return null;
  return redis.get(tokenKey(token));
}
