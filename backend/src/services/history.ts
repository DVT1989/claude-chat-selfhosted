/**
 * Search in the user's own earlier conversations (messages table), so Claude can look up how
 * something was done before instead of asking again. Full text with Dutch stemming on an
 * expression index (no extra column, no table rewrite). Strictly per user: the conversation must
 * belong to the user id the per-run memory token maps to.
 */
import { query } from '../db';
import { scrubIfSecret } from './agentTraining';  // circular import, only used at call time

/** Same expression in the index and in every query, otherwise Postgres cannot use the index. */
const TSV = "to_tsvector('dutch', left(m.content, 100000))";

export async function ensureHistorySchema(): Promise<void> {
  // 3k messages build in a second or two; CONCURRENTLY is not allowed inside the migration flow
  await query(`CREATE INDEX IF NOT EXISTS messages_content_fts_idx ON messages USING GIN (to_tsvector('dutch', left(content, 100000)))`);
}

export interface HistoryHit {
  conversation_id: string; message_id: string; title: string; role: string; date: string; snippet: string;
}

const words = (q: string) => q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 10) ?? [];

/**
 * Hits ranked by relevance with a little weight for recency; at most two per conversation so one
 * long chat does not fill the list. All words must match; when nothing does, any word.
 */
export async function searchHistory(userId: string, q: string, opts: { limit?: number; role?: 'user' | 'assistant' | null; excludeConversation?: string | null; since?: string | null } = {}): Promise<HistoryHit[]> {
  const w = words(q);
  if (!w.length) return [];
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
  for (const op of [' & ', ' | ']) {
    if (op === ' | ' && w.length === 1) break;
    const tsq = w.map((x) => `${x}:*`).join(op);
    const r = await query<HistoryHit & { rank: number }>(
      `SELECT m.conversation_id, m.id AS message_id, COALESCE(c.title, '') AS title, m.role,
              to_char(m.created_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD HH24:MI') AS date,
              ts_headline('dutch', left(m.content, 100000), q,
                'MaxWords=28, MinWords=10, MaxFragments=2, FragmentDelimiter=" … ", StartSel=«, StopSel=»') AS snippet,
              ts_rank(${TSV}, q) * (1 + 1 / (1 + extract(epoch FROM now() - m.created_at) / 2592000)) AS rank
       FROM messages m JOIN conversations c ON c.id = m.conversation_id, to_tsquery('dutch', $2) q
       WHERE c.user_id = $1 AND c.status <> 'deleted' AND ${TSV} @@ q
         AND ($3::text IS NULL OR m.role = $3) AND ($4::uuid IS NULL OR m.conversation_id <> $4)
         AND ($5::date IS NULL OR m.created_at >= $5::date)
       ORDER BY rank DESC LIMIT $6`,
      [userId, tsq, opts.role ?? null, opts.excludeConversation ?? null, opts.since ?? null, limit * 4]);
    if (!r.rows.length) continue;
    const per = new Map<string, number>();
    const out: HistoryHit[] = [];
    for (const h of r.rows) {
      const n = per.get(h.conversation_id) ?? 0;
      if (n >= 2) continue;
      per.set(h.conversation_id, n + 1);
      out.push({ conversation_id: h.conversation_id, message_id: h.message_id, title: h.title.slice(0, 80), role: h.role, date: h.date,
        snippet: scrubIfSecret(h.snippet.replace(/\s+/g, ' ').trim()).slice(0, 320) });
      if (out.length >= limit) break;
    }
    return out;
  }
  return [];
}

/** A few messages around one hit (or the start of the conversation), each cut short. */
export async function conversationExcerpt(userId: string, conversationId: string, aroundMessageId: string | null, n = 6, maxChars = 1500): Promise<{ title: string; messages: Array<{ id: string; role: string; date: string; content: string }> } | null> {
  const c = await query<{ title: string }>(`SELECT COALESCE(title, '') AS title FROM conversations WHERE id = $1 AND user_id = $2 AND status <> 'deleted'`, [conversationId, userId]);
  if (!c.rows[0]) return null;
  const size = Math.min(Math.max(n, 2), 20);
  const rows = (await query<{ id: string; role: string; date: string; content: string }>(
    `WITH ordered AS (
       SELECT id, role, content, created_at, row_number() OVER (ORDER BY created_at, id) AS rn
       FROM messages WHERE conversation_id = $1 AND content <> ''
     ), anchor AS (SELECT COALESCE((SELECT rn FROM ordered WHERE id = $2::uuid), 1) AS rn)
     SELECT o.id, o.role, to_char(o.created_at AT TIME ZONE 'Europe/Amsterdam', 'YYYY-MM-DD HH24:MI') AS date, left(o.content, $4) AS content
     FROM ordered o, anchor a WHERE o.rn BETWEEN a.rn - ($3 / 2) AND a.rn + ($3 / 2) ORDER BY o.rn`,
    [conversationId, aroundMessageId, size, maxChars])).rows;
  return { title: c.rows[0].title, messages: rows.map((r) => ({ ...r, content: scrubIfSecret(r.content) })) };
}

/**
 * Conversations that match any of the terms (a term of several words is a phrase), most relevant
 * first: the summed rank of their matching messages, damped by the length of the conversation so
 * one huge chat about everything does not top every list. Used to train an agent on its own field.
 */
export async function rankConversations(userId: string, terms: string[], limit = 25): Promise<Array<{ conversation_id: string; title: string; score: number }>> {
  const parts = [...new Set(terms.map((t) => words(t).map((x) => `${x}:*`).join(' <-> ')).filter(Boolean))].slice(0, 30);
  if (!parts.length) return [];
  const r = await query<{ conversation_id: string; title: string; score: number }>(
    `SELECT m.conversation_id, max(COALESCE(c.title, '')) AS title, (sum(ts_rank(${TSV}, q)) / sqrt(max(n.total)))::float AS score
     FROM messages m JOIN conversations c ON c.id = m.conversation_id, to_tsquery('dutch', $2) q,
       LATERAL (SELECT count(*) AS total FROM messages x WHERE x.conversation_id = m.conversation_id) n
     WHERE c.user_id = $1 AND c.status <> 'deleted' AND ${TSV} @@ q
     GROUP BY m.conversation_id ORDER BY score DESC LIMIT $3`,
    [userId, parts.map((p) => `(${p})`).join(' | '), Math.min(Math.max(limit, 1), 1000)]);
  return r.rows;
}
