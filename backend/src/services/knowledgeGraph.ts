import { query } from '../db';
import { getUserHomeDir } from './claudeCode';
import { listOwnSkills } from './userSkills';

/**
 * Swarm: everything the assistant knows about one user as a small graph for the settings page.
 * Facts, lessons, own skills, skill proposals, recurring tasks and the conversations the
 * learning loop learned from. Short fields only; text is capped so the payload stays small.
 */

export type GraphKind = 'memory' | 'lesson' | 'skill' | 'proposal' | 'task' | 'chat';
export interface GraphNode {
  id: string; kind: GraphKind; label: string; topic: string; weight: number; date: string | null;
  text?: string; pinned?: boolean; archived?: boolean; status?: string; ref?: string; tags?: string;
}
export interface GraphEdge { a: string; b: string; kind: 'learned' | 'topic' | 'tag' | 'flow' }

const MAX_MEMORY = 1500;
const MAX_LESSONS = 600;
const MAX_CHATS = 200;
const TEXT_MAX = 600;

const cut = (s: string, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function buildGraph(userId: string, isAdmin: boolean): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; at: string }> {
  const [mem, les, pats, props, chats, learned] = await Promise.all([
    query<{ id: string; topic: string; content: string; tags: string; pinned: boolean; use_count: number; updated_at: string; archived_at: string | null }>(
      `SELECT id, topic, content, tags, pinned, use_count, updated_at, archived_at FROM user_memories
       WHERE user_id = $1 ORDER BY pinned DESC, use_count DESC, updated_at DESC LIMIT ${MAX_MEMORY}`, [userId]),
    // the lessons page is admin-only; other users only see the lessons they contributed themselves
    query<{ id: string; topic: string; lesson: string; created_at: string }>(
      `SELECT id, topic, lesson, created_at FROM shared_lessons ${isAdmin ? '' : 'WHERE user_id = $1'}
       ORDER BY created_at DESC LIMIT ${MAX_LESSONS}`, isAdmin ? [] : [userId]),
    query<{ id: string; key: string; summary: string; count: number; last_seen: string }>(
      'SELECT id, key, summary, count, last_seen FROM task_patterns WHERE user_id = $1 ORDER BY count DESC, last_seen DESC LIMIT 60', [userId]),
    query<{ id: string; pattern_id: string | null; name: string; description: string; status: string; installed_name: string | null; created_at: string }>(
      `SELECT id, pattern_id, name, description, status, installed_name, created_at FROM skill_proposals
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60`, [userId]),
    query<{ id: string; title: string | null; n: number; last: string }>(
      `SELECT c.id, c.title, count(*)::int AS n, max(l.created_at) AS last
       FROM learn_log l JOIN conversations c ON c.id = l.conversation_id AND c.user_id = $1
       WHERE l.user_id = $1 AND l.reverted_at IS NULL
       GROUP BY c.id, c.title ORDER BY last DESC LIMIT ${MAX_CHATS}`, [userId]),
    query<{ conversation_id: string; kind: string; target_id: string }>(
      `SELECT DISTINCT conversation_id, kind, target_id FROM learn_log
       WHERE user_id = $1 AND reverted_at IS NULL AND conversation_id IS NOT NULL AND target_id IS NOT NULL`, [userId]),
  ]);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const m of mem.rows) {
    nodes.push({ id: `m:${m.id}`, kind: 'memory', label: cut(m.content, 80), topic: m.topic, weight: m.use_count, date: iso(m.updated_at),
      text: cut(m.content, TEXT_MAX), tags: m.tags || undefined, pinned: m.pinned || undefined, archived: m.archived_at ? true : undefined });
  }
  for (const l of les.rows) {
    nodes.push({ id: `l:${l.id}`, kind: 'lesson', label: cut(l.lesson, 80), topic: l.topic, weight: 1, date: iso(l.created_at), text: cut(l.lesson, TEXT_MAX) });
  }
  let skills: ReturnType<typeof listOwnSkills> = [];
  try { skills = listOwnSkills(getUserHomeDir(userId)); } catch { /* no home yet */ }
  for (const s of skills) {
    nodes.push({ id: `s:${s.name}`, kind: 'skill', label: s.name, topic: 'skills', weight: 2, date: s.updatedAt ?? null, text: cut(s.description, TEXT_MAX), ref: s.name });
  }
  for (const t of pats.rows) {
    nodes.push({ id: `t:${t.id}`, kind: 'task', label: cut(t.key, 60), topic: 'taken', weight: t.count, date: iso(t.last_seen), text: cut(t.summary, TEXT_MAX), ref: t.key });
  }
  for (const p of props.rows) {
    nodes.push({ id: `p:${p.id}`, kind: 'proposal', label: p.name, topic: 'skills', weight: 1, date: iso(p.created_at), text: cut(p.description, TEXT_MAX), status: p.status });
  }
  for (const c of chats.rows) {
    nodes.push({ id: `c:${c.id}`, kind: 'chat', label: cut(c.title || 'Gesprek zonder titel', 60), topic: 'gesprekken', weight: c.n, date: iso(c.last) });
  }

  const has = new Set(nodes.map((n) => n.id));
  const add = (a: string, b: string, kind: GraphEdge['kind']) => { if (a !== b && has.has(a) && has.has(b)) edges.push({ a, b, kind }); };

  // conversation -> what was learned from it
  for (const r of learned.rows) add(`c:${r.conversation_id}`, `${r.kind === 'lesson' ? 'l' : 'm'}:${r.target_id}`, 'learned');
  // task -> proposal -> installed skill
  for (const p of props.rows) {
    if (p.pattern_id) add(`t:${p.pattern_id}`, `p:${p.id}`, 'flow');
    if (p.installed_name) add(`p:${p.id}`, `s:${p.installed_name}`, 'flow');
  }

  // Same topic: a short chain around the heaviest fact of each topic (hub + up to 2 neighbours each),
  // not every pair, so it stays a cluster and never a web.
  const byTopic = new Map<string, GraphNode[]>();
  for (const n of nodes) if (n.kind === 'memory' || n.kind === 'lesson') {
    const k = `${n.kind}|${n.topic}`;
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k)!.push(n);
  }
  for (const list of byTopic.values()) {
    list.sort((x, y) => Number(!!y.pinned) - Number(!!x.pinned) || y.weight - x.weight);
    for (let i = 1; i < list.length; i++) add(list[Math.floor((i - 1) / 2)].id, list[i].id, 'topic');
  }
  // Shared tag across topics: at most one tag line per fact, max 60 in total
  const firstWithTag = new Map<string, string>();
  const tagged = new Set<string>();
  let tagEdges = 0;
  for (const n of nodes) {
    if (n.kind !== 'memory' || !n.tags || tagEdges >= 60) continue;
    for (const tag of n.tags.toLowerCase().split(/[,\s]+/).filter((t) => t.length > 2)) {
      const other = firstWithTag.get(tag);
      if (!other) { firstWithTag.set(tag, n.id); continue; }
      const o = nodes.find((x) => x.id === other);
      if (o && o.topic !== n.topic && !tagged.has(n.id)) { add(other, n.id, 'tag'); tagged.add(n.id); tagEdges++; break; }
    }
  }
  for (const n of nodes) delete n.tags;

  return { nodes, edges, at: new Date().toISOString() };
}
