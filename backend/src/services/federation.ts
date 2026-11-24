/**
 * Federation between two claude-chat installations.
 *
 * - Inbound: another installation reads (and, with a two-way key, writes) our data through /federation/*
 *   with an API key (stored hashed, shown once). Outbound: a "peer" (URL + key of the other side) that we sync with.
 * - Per item we keep the origin (installation id, remote id, hash) in federation_origin, so nothing is imported twice.
 * - Conflict (changed locally AND remotely since the last sync): never overwritten, listed in federation_conflicts.
 * - Never exported: passwords, tokens, credentials_enc of connectors, sessions, settings, Claude accounts.
 *   Message tool output and conversation metadata (session ids, device ids) are left out as well.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync, rmSync, chownSync } from 'fs';
import { join, dirname, normalize, sep } from 'path';
import { tmpdir } from 'os';
import { query } from '../db';
import { config } from '../config';
import { encrypt, decrypt, hashToken } from './crypto';
import { AppError } from '../middleware/errorHandler';
import { uniqueSlug } from './agents';
import { listOwnSkills, installSkillDir, isValidSkillName } from './userSkills';
import { computeNext } from './tasks';
import { getUserWorkspace, ensureProjectDir } from './claudeCode';
import { filesKind, profileKind } from './federationFiles';

export const KINDS = ['projects', 'agents', 'skills', 'memories', 'lessons', 'tasks', 'conversations', 'files', 'profile'] as const;
export type KindName = typeof KINDS[number];
export const KIND_LABEL: Record<KindName, string> = {
  projects: 'Projecten', agents: 'Agents', skills: 'Skills', memories: 'Geheugen', lessons: 'Lessen', tasks: 'Taken', conversations: 'Gesprekken', files: 'Bestanden', profile: 'Profiel',
};
export const FEDERATION_VERSION = 1;
const NIL = '00000000-0000-0000-0000-000000000000';
const MAX_SKILL_TOTAL = 1024 * 1024;

// ── schema ────────────────────────────────────────────────────

export async function ensureFederationSchema(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS federation_self (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL DEFAULT 'Deze installatie')`);
  await query(`CREATE TABLE IF NOT EXISTS federation_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('read','readwrite')),
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ)`);
  await query(`CREATE TABLE IF NOT EXISTS federation_peers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      api_key_enc TEXT NOT NULL,
      remote_install_id TEXT,
      remote_name TEXT,
      direction TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      nightly BOOLEAN NOT NULL DEFAULT TRUE,
      kinds JSONB NOT NULL DEFAULT '{}',
      cursors JSONB NOT NULL DEFAULT '{}',
      push_cursors JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'new',
      status_message TEXT,
      last_sync_at TIMESTAMPTZ,
      last_nightly_on DATE,
      last_result JSONB,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await query(`CREATE TABLE IF NOT EXISTS federation_origin (
      install_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      local_id TEXT NOT NULL,
      remote_hash TEXT NOT NULL,
      local_hash TEXT NOT NULL,
      pushed BOOLEAN NOT NULL DEFAULT FALSE,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (install_id, kind, remote_id))`);
  await query('CREATE INDEX IF NOT EXISTS federation_origin_local_idx ON federation_origin (kind, local_id)');
  await query(`CREATE TABLE IF NOT EXISTS federation_conflicts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      install_id TEXT NOT NULL,
      install_name TEXT,
      peer_id UUID REFERENCES federation_peers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      local_id TEXT,
      owner_id UUID,
      name TEXT NOT NULL DEFAULT '',
      remote_item JSONB NOT NULL,
      local_preview JSONB,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS federation_conflicts_open_idx ON federation_conflicts (install_id, kind, remote_id) WHERE status = 'open'`);
  await query('ALTER TABLE federation_peers ADD COLUMN IF NOT EXISTS all_users BOOLEAN NOT NULL DEFAULT FALSE');
  if (!(await query('SELECT 1 FROM federation_self')).rowCount) {
    await query('INSERT INTO federation_self (name) VALUES ($1)', [process.env.FEDERATION_NAME || 'Deze installatie']);
  }
}

export async function selfInfo(): Promise<{ id: string; name: string }> {
  const r = await query<{ id: string; name: string }>('SELECT id::text, name FROM federation_self LIMIT 1');
  return r.rows[0];
}
export async function setSelfName(name: string): Promise<void> {
  await query('UPDATE federation_self SET name = $1', [name.trim().slice(0, 80) || 'Deze installatie']);
}

// ── API keys (inbound) ────────────────────────────────────────

export interface FedKey { id: string; name: string; direction: 'read' | 'readwrite'; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export async function createKey(adminId: string, name: string, direction: 'read' | 'readwrite'): Promise<{ key: string; item: FedKey }> {
  const key = `fedk_${randomBytes(24).toString('hex')}`;
  const r = await query<FedKey>(
    `INSERT INTO federation_keys (name, direction, key_hash, key_prefix, created_by) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, direction, key_prefix, created_at, last_used_at, revoked_at`,
    [name.trim().slice(0, 80), direction, hashToken(key), key.slice(0, 9), adminId]);
  return { key, item: r.rows[0] };
}
export async function listKeys(): Promise<FedKey[]> {
  return (await query<FedKey>('SELECT id, name, direction, key_prefix, created_at, last_used_at, revoked_at FROM federation_keys ORDER BY created_at DESC')).rows;
}
export async function revokeKey(id: string): Promise<boolean> {
  return ((await query('UPDATE federation_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id])).rowCount ?? 0) > 0;
}
export async function authKey(token: string): Promise<{ id: string; direction: 'read' | 'readwrite'; created_by: string | null; name: string } | null> {
  if (!token.startsWith('fedk_') || token.length > 80) return null;
  const r = await query<{ id: string; direction: 'read' | 'readwrite'; created_by: string | null; name: string }>(
    'SELECT id, direction, created_by, name FROM federation_keys WHERE key_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
  if (!r.rows[0]) return null;
  void query('UPDATE federation_keys SET last_used_at = now() WHERE id = $1', [r.rows[0].id]).catch(() => {});
  return r.rows[0];
}

// ── hashing ───────────────────────────────────────────────────

/** ids that differ per installation are not part of an item's hash */
const SKIP_KEYS = new Set(['rid', 'project_rid']);
function canon(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) if (!SKIP_KEYS.has(k)) o[k] = canon((v as Record<string, unknown>)[k]);
    return o;
  }
  return v ?? null;
}
export function hashData(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(canon(data))).digest('hex');
}

// ── item model ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;
export interface RawItem { id: string; ts: string; owner_email: string | null; data: Data }
export interface Item extends RawItem { hash: string; origin?: { install: string; id: string } | null }

export interface ApplyCtx {
  installId: string;
  installName: string;
  /** label to add to the item (only when it goes to the fallback admin) */
  label: string | null;
  ts: string;
  /** fetches the bytes of an attachment of the remote conversation */
  attachment: (a: { rid: string; name: string }) => Promise<Buffer | null>;
}

export interface Kind {
  /** only for users that exist here (matched on e-mail): items of unknown owners are skipped instead of going to the fallback admin */
  ownerOnly?: boolean;
  list(after: [string, string] | null, limit: number, owner?: string): Promise<RawItem[]>;
  one(localId: string): Promise<RawItem | null>;
  count(): Promise<{ count: number; latest: string | null }>;
  create(owner: string, d: Data, c: ApplyCtx): Promise<string>;
  update(localId: string, d: Data, c: ApplyCtx): Promise<void>;
  /** natural duplicate of a new item: 'link' = same thing, use it; 'conflict' = compare first */
  find?(owner: string, d: Data): Promise<string | null>;
  natural?: 'link' | 'conflict';
  ownerOf(localId: string): Promise<string | null>;
  name(d: Data): string;
}

const TS = (c: string) => `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const lab = (s: string, c: ApplyCtx) => (c.label ? `${s} [${c.label}]` : s);

interface DbDef {
  from: string; id: string; ts: string; where?: string; fields: string; table: string; ownerCol: string;
  map: (r: Record<string, Data>) => Data | Promise<Data>;
}
function dbKind(def: DbDef, impl: Pick<Kind, 'create' | 'update' | 'find' | 'natural' | 'name'>): Kind {
  const sel = `SELECT ${def.id}::text AS id, ${TS(def.ts)} AS ts, u.email AS owner_email, ${def.fields} FROM ${def.from}`;
  const build = async (rows: Array<Record<string, Data>>): Promise<RawItem[]> => {
    const out: RawItem[] = [];
    for (const r of rows) out.push({ id: r.id, ts: r.ts, owner_email: r.owner_email, data: await def.map(r) });
    return out;
  };
  return {
    async list(after, limit, owner) {
      const params: unknown[] = [after?.[0] ?? '-infinity', after?.[1] ?? NIL, limit];
      let w = `(${def.ts}, ${def.id}) > ($1::timestamptz, $2::uuid)${def.where ? ` AND ${def.where}` : ''}`;
      if (owner) { params.push(owner); w += ` AND lower(u.email) = lower($4)`; }
      return build((await query(`${sel} WHERE ${w} ORDER BY ${def.ts}, ${def.id} LIMIT $3`, params)).rows);
    },
    async one(localId) {
      const rows = (await query(`${sel} WHERE ${def.id} = $1::uuid${def.where ? ` AND ${def.where}` : ''}`, [localId])).rows;
      return (await build(rows))[0] ?? null;
    },
    async count() {
      const r = await query<{ n: string; latest: string | null }>(
        `SELECT count(*) AS n, ${TS(`max(${def.ts})`)} AS latest FROM ${def.from} WHERE ${def.where ?? 'true'}`);
      return { count: Number(r.rows[0].n), latest: r.rows[0].latest };
    },
    async ownerOf(localId) {
      const r = await query(`SELECT ${def.ownerCol} AS o FROM ${def.table} WHERE id = $1::uuid`, [localId]);
      return r.rows[0]?.o ?? null;
    },
    ...impl,
  };
}

const kinds: Record<Exclude<KindName, 'skills' | 'files' | 'profile'>, Kind> = {
  projects: dbKind({
    table: 'projects', from: 'projects p LEFT JOIN users u ON u.id = p.user_id', id: 'p.id', ts: 'p.updated_at', ownerCol: 'user_id',
    fields: 'p.name, p.color, p.icon, p.instructions',
    map: (r) => ({ name: r.name, color: r.color, icon: r.icon, instructions: r.instructions }),
  }, {
    name: (d) => d.name,
    async create(owner, d, c) {
      const r = await query<{ id: string }>('INSERT INTO projects (user_id, name, color, icon, instructions) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [owner, lab(d.name, c), d.color ?? 'terracotta', d.icon ?? 'folder', d.instructions ?? '']);
      try { ensureProjectDir(owner, { id: r.rows[0].id, name: d.name, instructions: d.instructions ?? '' }); } catch { /* dir is made on first use */ }
      return r.rows[0].id;
    },
    async update(id, d, c) {
      const r = await query<{ user_id: string }>('UPDATE projects SET name=$2, color=$3, icon=$4, instructions=$5, updated_at=now() WHERE id=$1 RETURNING user_id',
        [id, lab(d.name, c), d.color ?? 'terracotta', d.icon ?? 'folder', d.instructions ?? '']);
      if (r.rows[0]) try { ensureProjectDir(r.rows[0].user_id, { id, name: d.name, instructions: d.instructions ?? '' }); } catch { /* ignore */ }
    },
  }),

  agents: dbKind({
    table: 'agents', from: 'agents a LEFT JOIN users u ON u.id = a.user_id', id: 'a.id', ts: 'a.updated_at', ownerCol: 'user_id',
    fields: 'a.name, a.description, a.prompt, a.model, a.avatar, a.color, a.is_active, a.knowledge',
    map: (r) => ({ name: r.name, description: r.description, prompt: r.prompt, model: r.model, avatar: r.avatar, color: r.color, is_active: r.is_active, knowledge: r.knowledge }),
  }, {
    name: (d) => d.name,
    async create(owner, d, c) {
      const name = lab(d.name, c);
      const slug = await uniqueSlug(owner, name);
      const r = await query<{ id: string }>(
        `INSERT INTO agents (user_id, name, slug, description, prompt, model, avatar, color, is_active, knowledge)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [owner, name, slug, d.description ?? '', d.prompt ?? '', d.model ?? 'inherit', d.avatar ?? null, d.color ?? '#6366f1', d.is_active ?? true, d.knowledge ?? null]);
      return r.rows[0].id;
    },
    async update(id, d, c) {
      await query(`UPDATE agents SET name=$2, description=$3, prompt=$4, model=$5, avatar=$6, color=$7, is_active=$8, knowledge=$9, updated_at=now() WHERE id=$1`,
        [id, lab(d.name, c), d.description ?? '', d.prompt ?? '', d.model ?? 'inherit', d.avatar ?? null, d.color ?? '#6366f1', d.is_active ?? true, d.knowledge ?? null]);
    },
  }),

  memories: dbKind({
    table: 'user_memories', from: 'user_memories m LEFT JOIN users u ON u.id = m.user_id', id: 'm.id', ts: 'm.updated_at', ownerCol: 'user_id',
    where: 'm.archived_at IS NULL', fields: 'm.topic, m.content, m.tags, m.pinned',
    map: (r) => ({ topic: r.topic, content: r.content, tags: r.tags, pinned: r.pinned }),
  }, {
    name: (d) => `${d.topic}: ${String(d.content).slice(0, 60)}`,
    natural: 'link',
    async find(owner, d) {
      const r = await query('SELECT id FROM user_memories WHERE user_id = $1 AND md5(lower(content)) = md5(lower($2))', [owner, d.content]);
      return r.rows[0]?.id ?? null;
    },
    async create(owner, d, c) {
      const tags = c.label ? `${d.tags ?? ''},herkomst:${c.label}`.replace(/^,/, '') : (d.tags ?? '');
      const r = await query<{ id: string }>(
        'INSERT INTO user_memories (user_id, topic, content, tags, pinned) VALUES ($1,$2,$3,$4,$5) RETURNING id', [owner, d.topic, d.content, tags, !!d.pinned]);
      return r.rows[0].id;
    },
    async update(id, d, c) {
      const tags = c.label ? `${d.tags ?? ''},herkomst:${c.label}`.replace(/^,/, '') : (d.tags ?? '');
      await query('UPDATE user_memories SET topic=$2, content=$3, tags=$4, pinned=$5, updated_at=now() WHERE id=$1', [id, d.topic, d.content, tags, !!d.pinned]);
    },
  }),

  lessons: dbKind({
    table: 'shared_lessons', from: 'shared_lessons l LEFT JOIN users u ON u.id = l.user_id', id: 'l.id', ts: 'l.created_at', ownerCol: 'user_id',
    fields: 'l.topic, l.lesson', map: (r) => ({ topic: r.topic, lesson: r.lesson }),
  }, {
    name: (d) => `${d.topic}: ${String(d.lesson).slice(0, 70)}`,
    natural: 'link',
    async find(_o, d) { return (await query('SELECT id FROM shared_lessons WHERE lower(lesson) = lower($1)', [d.lesson])).rows[0]?.id ?? null; },
    async create(owner, d) {
      const r = await query<{ id: string }>('INSERT INTO shared_lessons (topic, lesson, user_id) VALUES ($1,$2,$3) RETURNING id', [d.topic, d.lesson, owner]);
      return r.rows[0].id;
    },
    async update(id, d) { await query('UPDATE shared_lessons SET topic=$2, lesson=$3 WHERE id=$1', [id, d.topic, d.lesson]); },
  }),

  tasks: dbKind({
    table: 'scheduled_tasks', from: 'scheduled_tasks t LEFT JOIN users u ON u.id = t.user_id', id: 't.id', ts: 't.updated_at', ownerCol: 'user_id',
    fields: `t.name, t.prompt, t.cron, t.schedule_text, t.run_at, t.timezone, t.autonomous,
             (SELECT a.slug FROM agents a WHERE a.id = t.agent_id) AS agent_slug`,
    map: (r) => ({ name: r.name, prompt: r.prompt, cron: r.cron, schedule_text: r.schedule_text, run_at: r.run_at, timezone: r.timezone, autonomous: r.autonomous, agent_slug: r.agent_slug }),
  }, {
    name: (d) => d.name,
    // imported tasks are always off; the user switches them on after checking
    async create(owner, d, c) {
      const agent = d.agent_slug ? (await query('SELECT id FROM agents WHERE user_id = $1 AND slug = $2', [owner, d.agent_slug])).rows[0]?.id ?? null : null;
      const r = await query<{ id: string }>(
        `INSERT INTO scheduled_tasks (user_id, name, prompt, agent_id, cron, schedule_text, run_at, timezone, enabled, autonomous, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,NULL) RETURNING id`,
        [owner, lab(d.name, c), d.prompt, agent, d.cron ?? null, d.schedule_text ?? '', d.cron ? null : (d.run_at ?? null), d.timezone ?? 'Europe/Amsterdam', !!d.autonomous]);
      return r.rows[0].id;
    },
    async update(id, d, c) {
      const row = (await query('SELECT user_id, enabled FROM scheduled_tasks WHERE id = $1', [id])).rows[0];
      if (!row) return;
      const agent = d.agent_slug ? (await query('SELECT id FROM agents WHERE user_id = $1 AND slug = $2', [row.user_id, d.agent_slug])).rows[0]?.id ?? null : null;
      const runAt = d.cron ? null : (d.run_at ?? null);
      const next = row.enabled ? computeNext({ cron: d.cron ?? null, run_at: runAt, timezone: d.timezone ?? 'Europe/Amsterdam' }) : null;
      await query(`UPDATE scheduled_tasks SET name=$2, prompt=$3, agent_id=$4, cron=$5, schedule_text=$6, run_at=$7, timezone=$8, autonomous=$9,
                   next_run_at = CASE WHEN enabled THEN $10 ELSE NULL END, updated_at=now() WHERE id=$1`,
        [id, lab(d.name, c), d.prompt, agent, d.cron ?? null, d.schedule_text ?? '', runAt, d.timezone ?? 'Europe/Amsterdam', !!d.autonomous, next]);
    },
  }),

  conversations: dbKind({
    table: 'conversations', from: 'conversations c LEFT JOIN users u ON u.id = c.user_id', id: 'c.id', ts: 'c.updated_at', ownerCol: 'user_id',
    where: `c.status <> 'deleted' AND c.metadata->>'isSystem' IS NULL AND c.metadata->>'device_log' IS NULL AND c.metadata->>'deviceTerminal' IS NULL
            AND c.metadata->>'delegation_id' IS NULL AND c.metadata->>'device_id' IS NULL`,
    fields: 'c.title, c.model, c.created_at, c.project_id::text AS project_rid',
    async map(r) {
      const atts = (await query('SELECT id::text AS rid, original_name AS name, mime_type AS mime, size_bytes AS size FROM conversation_attachments WHERE conversation_id = $1 ORDER BY created_at, original_name, id', [r.id])).rows;
      const idx = new Map(atts.map((a, i) => [a.rid as string, i]));
      const msgs = (await query('SELECT role, content, token_count, created_at, metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at, id', [r.id])).rows;
      return {
        title: r.title, model: r.model, created_at: r.created_at, project_rid: r.project_rid, attachments: atts,
        messages: msgs.map((m) => {
          const md = (m.metadata ?? {}) as Record<string, Data>;
          const att = Array.isArray(md.attachments) ? (md.attachments as Array<{ id: string }>).map((a) => idx.get(a.id)).filter((x): x is number => x !== undefined) : [];
          return { role: m.role, content: m.content, token_count: m.token_count, created_at: m.created_at, source: md.source ?? null, auto: md.auto ?? null, interrupted: md.interrupted ?? null, att };
        }),
      };
    },
  }, {
    name: (d) => d.title,
    async create(owner, d, c) {
      const project = d.project_rid ? await mapped(c.installId, 'projects', d.project_rid) : null;
      const r = await query<{ id: string }>(
        `INSERT INTO conversations (user_id, title, model, project_id, metadata, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [owner, c.label ? `[${c.label}] ${d.title}` : d.title, d.model, project, JSON.stringify({ imported_from: c.installName }), d.created_at, c.ts]);
      await writeConversation(r.rows[0].id, owner, d, c);
      return r.rows[0].id;
    },
    async update(id, d, c) {
      const row = (await query('SELECT user_id FROM conversations WHERE id = $1', [id])).rows[0];
      if (!row) return;
      const project = d.project_rid ? await mapped(c.installId, 'projects', d.project_rid) : null;
      await query('UPDATE conversations SET title=$2, model=$3, project_id=$4, updated_at=$5 WHERE id=$1',
        [id, c.label ? `[${c.label}] ${d.title}` : d.title, d.model, project, c.ts]);
      await query('DELETE FROM messages WHERE conversation_id = $1', [id]);
      await writeConversation(id, row.user_id, d, c);
    },
  }),
};

async function mapped(installId: string, kind: string, remoteId: string): Promise<string | null> {
  return (await query('SELECT local_id FROM federation_origin WHERE install_id = $1 AND kind = $2 AND remote_id = $3', [installId, kind, remoteId])).rows[0]?.local_id ?? null;
}

const safeName = (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);

/** attachments (files + rows) and messages of an imported conversation */
async function writeConversation(convId: string, owner: string, d: Data, c: ApplyCtx): Promise<void> {
  const local: Array<{ id: string; mime_type: string; size_bytes: number; original_name: string } | null> = [];
  for (const a of (d.attachments ?? []) as Array<{ rid: string; name: string; mime: string; size: number }>) {
    const known = await mapped(c.installId, 'attachments', a.rid);
    const have = known ? (await query('SELECT id::text, original_name, mime_type, size_bytes FROM conversation_attachments WHERE id = $1 AND conversation_id = $2', [known, convId])).rows[0] : null;
    if (have) { local.push({ id: have.id, mime_type: have.mime_type, size_bytes: have.size_bytes, original_name: have.original_name }); continue; }
    const buf = await c.attachment(a);
    if (!buf) throw new Error(`Bijlage ${a.name} niet beschikbaar`);
    const stored = `${randomUUID()}_${safeName(a.name)}`;
    const dir = join(getUserWorkspace(owner), 'attachments', convId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, stored), buf);
    const r = await query<{ id: string }>(
      `INSERT INTO conversation_attachments (conversation_id, user_id, original_name, stored_name, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [convId, owner, a.name, stored, a.mime, buf.length]);
    await query(`INSERT INTO federation_origin (install_id, kind, remote_id, local_id, remote_hash, local_hash) VALUES ($1,'attachments',$2,$3,'','')
                 ON CONFLICT (install_id, kind, remote_id) DO UPDATE SET local_id = EXCLUDED.local_id`, [c.installId, a.rid, r.rows[0].id]);
    local.push({ id: r.rows[0].id, mime_type: a.mime, size_bytes: buf.length, original_name: a.name });
  }
  const msgs = (d.messages ?? []) as Array<{ role: string; content: string; token_count: number; created_at: string; source?: string; auto?: unknown; interrupted?: unknown; att?: number[] }>;
  for (let i = 0; i < msgs.length; i += 200) {
    const part = msgs.slice(i, i + 200);
    const meta = part.map((m) => {
      const md: Record<string, unknown> = {};
      if (m.source) md.source = m.source;
      if (m.auto != null) md.auto = m.auto;
      if (m.interrupted != null) md.interrupted = m.interrupted;
      const atts = (m.att ?? []).map((x) => local[x]).filter(Boolean);
      if (atts.length) md.attachments = atts;
      return JSON.stringify(md);
    });
    await query(
      `INSERT INTO messages (conversation_id, role, content, token_count, metadata, created_at)
       SELECT $1::uuid, r, c, t, m::jsonb, ts FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::timestamptz[]) AS x(r, c, t, m, ts)`,
      [convId, part.map((m) => m.role), part.map((m) => m.content), part.map((m) => m.token_count ?? 0), meta, part.map((m) => m.created_at)]);
  }
}

// ── skills (files in the user's ~/.claude/skills) ─────────────

const homeOf = (userId: string) => join(config.claudeHomesRoot, `user-${userId}`);

function readSkillFiles(dir: string): { files: Record<string, string>; ts: number } | null {
  const files: Record<string, string> = {};
  let total = 0; let ts = 0; let n = 0;
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel))) {
      if (e.startsWith('.') || e === '__pycache__' || e === 'node_modules') continue;
      const p = join(dir, rel, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(join(rel, e)); continue; }
      if (st.size > 200 * 1024 || ++n > 200) continue;
      total += st.size; if (total > MAX_SKILL_TOTAL) throw new Error('Skill te groot');
      files[join(rel, e).split(sep).join('/')] = readFileSync(p).toString('base64');
      ts = Math.max(ts, st.mtimeMs);
    }
  };
  try { walk(''); } catch { return null; }
  return files['SKILL.md'] ? { files, ts } : null;
}
const sortFiles = (f: Record<string, string>) => Object.fromEntries(Object.keys(f).sort().map((k) => [k, f[k]]));

async function skillItems(): Promise<RawItem[]> {
  const users = (await query<{ id: string; email: string }>('SELECT id::text, email FROM users WHERE is_active')).rows;
  const out: RawItem[] = [];
  for (const u of users) {
    const home = homeOf(u.id);
    if (!existsSync(home)) continue;
    for (const s of listOwnSkills(home)) {
      const r = readSkillFiles(join(home, '.claude', 'skills', s.name));
      if (r) out.push({ id: `${u.id}/${s.name}`, ts: new Date(r.ts).toISOString(), owner_email: u.email, data: { name: s.name, files: sortFiles(r.files) } });
    }
  }
  return out.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts.localeCompare(b.ts)));
}

const skills: Kind = {
  async list(after, limit, owner) {
    let all = await skillItems();
    if (owner) all = all.filter((i) => i.owner_email?.toLowerCase() === owner.toLowerCase());
    if (after) all = all.filter((i) => i.ts > after[0] || (i.ts === after[0] && i.id > after[1]));
    return all.slice(0, limit);
  },
  async one(localId) { return (await skillItems()).find((i) => i.id === localId) ?? null; },
  async count() { const a = await skillItems(); return { count: a.length, latest: a.length ? a[a.length - 1].ts : null }; },
  async ownerOf(localId) { return localId.split('/')[0] ?? null; },
  name: (d) => d.name,
  natural: 'conflict',
  async find(owner, d) { return existsSync(join(homeOf(owner), '.claude', 'skills', d.name, 'SKILL.md')) && !lstatSync(join(homeOf(owner), '.claude', 'skills', d.name)).isSymbolicLink() ? `${owner}/${d.name}` : null; },
  async create(owner, d) { writeSkill(owner, d); return `${owner}/${d.name}`; },
  async update(id, d) { writeSkill(id.split('/')[0], d); },
};

function writeSkill(owner: string, d: Data): void {
  if (!isValidSkillName(d.name)) throw new Error('Ongeldige skillnaam');
  const tmp = join(tmpdir(), `fedskill-${randomUUID()}`);
  try {
    let total = 0;
    for (const [rel, b64] of Object.entries(d.files as Record<string, string>)) {
      const p = normalize(rel);
      if (p.startsWith('..') || p.startsWith('/') || p.includes(`..${sep}`)) throw new Error('Ongeldig pad in skill');
      const buf = Buffer.from(b64, 'base64');
      total += buf.length; if (total > MAX_SKILL_TOTAL) throw new Error('Skill te groot');
      mkdirSync(dirname(join(tmp, p)), { recursive: true });
      writeFileSync(join(tmp, p), buf);
    }
    if (!existsSync(join(tmp, 'SKILL.md'))) throw new Error('SKILL.md ontbreekt');
    installSkillDir(homeOf(owner), d.name, tmp);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export const kindOf = (k: string): Kind => {
  if (!(KINDS as readonly string[]).includes(k)) throw new AppError(400, `Onbekende soort: ${k}`);
  return k === 'skills' ? skills : k === 'files' ? filesKind : k === 'profile' ? profileKind : kinds[k as Exclude<KindName, 'skills' | 'files' | 'profile'>];
};

// ── export ────────────────────────────────────────────────────

export function parseCursor(s: unknown): [string, string] | null {
  if (typeof s !== 'string' || !s.includes('|')) return null;
  const i = s.indexOf('|');
  return [s.slice(0, i), s.slice(i + 1)];
}
const mkCursor = (i: RawItem) => `${i.ts}|${i.id}`;

async function withOrigin(kind: string, items: RawItem[], requester: string | null): Promise<Item[]> {
  if (!items.length) return [];
  const rows = (await query<{ local_id: string; install_id: string; remote_id: string; local_hash: string }>(
    `SELECT local_id, install_id, remote_id, local_hash FROM federation_origin WHERE kind = $1 AND local_id = ANY($2::text[])`, [kind, items.map((i) => i.id)])).rows;
  const out: Item[] = [];
  for (const i of items) {
    const hash = hashData(i.data);
    const o = rows.filter((r) => r.local_id === i.id);
    // what the requester sent us itself and nobody changed since goes back to it only after a change
    if (requester && o.some((r) => r.install_id === requester && r.local_hash === hash)) continue;
    out.push({ ...i, hash, origin: o[0] ? { install: o[0].install_id, id: o[0].remote_id } : null });
  }
  return out;
}

export async function exportPage(kind: string, after: [string, string] | null, limit: number, requester: string | null, owner?: string): Promise<{ items: Item[]; next: string | null }> {
  const k = kindOf(kind);
  const n = Math.min(Math.max(limit || 20, 1), kind === 'conversations' ? 10 : kind === 'files' ? 8 : 100);
  const raw = await k.list(after, n, owner);
  const items = await withOrigin(kind, raw, requester);
  return { items, next: raw.length ? mkCursor(raw[raw.length - 1]) : null };
}

export async function manifest(direction: 'read' | 'readwrite'): Promise<Record<string, unknown>> {
  const me = await selfInfo();
  const out: Record<string, unknown> = {};
  for (const k of KINDS) out[k] = await kindOf(k).count();
  return { install_id: me.id, name: me.name, version: FEDERATION_VERSION, direction, kinds: out };
}

export function attachmentFile(row: { user_id: string; conversation_id: string; stored_name: string }): string {
  return join(getUserWorkspace(row.user_id), 'attachments', row.conversation_id, row.stored_name);
}

/** attachment of an exportable conversation, for streaming */
export async function findAttachment(id: string): Promise<{ path: string; name: string; mime: string; size: number } | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await query(
    `SELECT a.user_id, a.conversation_id, a.stored_name, a.original_name, a.mime_type, a.size_bytes FROM conversation_attachments a
     JOIN conversations c ON c.id = a.conversation_id
     WHERE a.id = $1 AND c.status <> 'deleted' AND c.metadata->>'isSystem' IS NULL AND c.metadata->>'device_log' IS NULL`, [id]);
  const a = r.rows[0];
  if (!a) return null;
  const path = attachmentFile(a as { user_id: string; conversation_id: string; stored_name: string });
  return existsSync(path) ? { path, name: a.original_name, mime: a.mime_type, size: a.size_bytes } : null;
}

// staging for attachments that a remote installation pushes before the conversation
const stageDir = (installId: string) => join(config.workspaceRoot, '.federation-staging', safeName(installId));
export function stageAttachment(installId: string, rid: string, buf: Buffer): void {
  const d = stageDir(installId); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, safeName(rid)), buf);
}
function stagedAttachment(installId: string, rid: string): Buffer | null {
  const p = join(stageDir(installId), safeName(rid));
  return existsSync(p) ? readFileSync(p) : null;
}

// ── applying incoming items ───────────────────────────────────

export type ApplyResult = 'created' | 'updated' | 'unchanged' | 'conflict' | 'error';
export interface IncomingOpts {
  install: { id: string; name: string };
  kind: string;
  item: Item;
  fallbackAdmin: string;
  peerId: string | null;
  /** for pulls: fetch attachment bytes from the peer; for pushes: the staging dir is used */
  fetchAttachment?: (rid: string) => Promise<Buffer | null>;
  /** user chose "remote" for a conflict */
  force?: boolean;
  pushed?: boolean;
}

async function resolveOwner(email: string | null, fallback: string): Promise<{ id: string; fallback: boolean }> {
  if (email) {
    const r = await query<{ id: string }>('SELECT id::text FROM users WHERE lower(email) = lower($1) AND is_active', [email]);
    if (r.rows[0]) return { id: r.rows[0].id, fallback: false };
  }
  return { id: fallback, fallback: true };
}

async function setOrigin(installId: string, kind: string, remoteId: string, localId: string, remoteHash: string, pushed = false): Promise<void> {
  const cur = await kindOf(kind).one(localId);
  await query(
    `INSERT INTO federation_origin (install_id, kind, remote_id, local_id, remote_hash, local_hash, pushed) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (install_id, kind, remote_id) DO UPDATE SET local_id = EXCLUDED.local_id, remote_hash = EXCLUDED.remote_hash,
       local_hash = EXCLUDED.local_hash, synced_at = now()`,
    [installId, kind, remoteId, localId, remoteHash, cur ? hashData(cur.data) : '', pushed]);
}

export async function applyIncoming(o: IncomingOpts): Promise<{ result: ApplyResult; local_id: string | null; error?: string }> {
  const k = kindOf(o.kind);
  const { item } = o;
  try {
    if (hashData(item.data) !== item.hash) return { result: 'error', local_id: null, error: 'Hash klopt niet' };
    const me = await selfInfo();
    const owner = await resolveOwner(item.owner_email, o.fallbackAdmin);
    if (k.ownerOnly && owner.fallback) return { result: 'unchanged', local_id: null };
    const ctx: ApplyCtx = {
      installId: o.install.id, installName: o.install.name, label: owner.fallback ? o.install.name : null, ts: item.ts,
      attachment: async (a) => (o.fetchAttachment ? o.fetchAttachment(a.rid) : stagedAttachment(o.install.id, a.rid)),
    };
    let row = (await query<{ local_id: string; remote_hash: string; local_hash: string }>(
      'SELECT local_id, remote_hash, local_hash FROM federation_origin WHERE install_id = $1 AND kind = $2 AND remote_id = $3', [o.install.id, o.kind, item.id])).rows[0];

    // our own item coming back (a pushed item whose answer was lost): link it, import nothing
    if (!row && item.origin && item.origin.install === me.id && o.install.id !== me.id) {
      const mine = await k.one(item.origin.id);
      if (mine) { await setOrigin(o.install.id, o.kind, item.id, item.origin.id, item.hash, true); return { result: 'unchanged', local_id: item.origin.id }; }
    }
    // same thing already here without origin (shared memory text, lesson, skill name)
    if (!row && k.find) {
      const ex = await k.find(owner.id, item.data);
      if (ex) {
        const cur = await k.one(ex);
        if (cur && hashData(cur.data) === item.hash) { await setOrigin(o.install.id, o.kind, item.id, ex, item.hash); return { result: 'unchanged', local_id: ex }; }
        if (k.natural === 'link') { await setOrigin(o.install.id, o.kind, item.id, ex, item.hash); return { result: 'unchanged', local_id: ex }; }
        if (!o.force) return conflict(o, ex, owner.id, cur);
        await k.update(ex, item.data, ctx); await setOrigin(o.install.id, o.kind, item.id, ex, item.hash, o.pushed);
        return { result: 'updated', local_id: ex };
      }
    }
    if (!row) {
      const id = await k.create(owner.id, item.data, ctx);
      await setOrigin(o.install.id, o.kind, item.id, id, item.hash, o.pushed);
      return { result: 'created', local_id: id };
    }
    const cur = await k.one(row.local_id);
    if (!cur) {
      // deleted here: only comes back when the other side changed it since
      if (row.remote_hash === item.hash && !o.force) return { result: 'unchanged', local_id: null };
      const id = await k.create(owner.id, item.data, ctx);
      await query('DELETE FROM federation_origin WHERE install_id = $1 AND kind = $2 AND remote_id = $3', [o.install.id, o.kind, item.id]);
      await setOrigin(o.install.id, o.kind, item.id, id, item.hash, o.pushed);
      return { result: 'created', local_id: id };
    }
    const curHash = hashData(cur.data);
    const localChanged = curHash !== row.local_hash;
    const remoteChanged = item.hash !== row.remote_hash;
    if (!remoteChanged && !o.force) return { result: 'unchanged', local_id: row.local_id };
    if (curHash === item.hash) { await setOrigin(o.install.id, o.kind, item.id, row.local_id, item.hash); return { result: 'unchanged', local_id: row.local_id }; }
    if (localChanged && !o.force) return conflict(o, row.local_id, owner.id, cur);
    await k.update(row.local_id, item.data, ctx);
    await setOrigin(o.install.id, o.kind, item.id, row.local_id, item.hash, row.local_id ? o.pushed : false);
    return { result: 'updated', local_id: row.local_id };
  } catch (e) {
    return { result: 'error', local_id: null, error: (e as Error).message };
  }
}

async function conflict(o: IncomingOpts, localId: string, ownerId: string, cur: RawItem | null): Promise<{ result: ApplyResult; local_id: string | null }> {
  const k = kindOf(o.kind);
  await query(
    `INSERT INTO federation_conflicts (install_id, install_name, peer_id, kind, remote_id, local_id, owner_id, name, remote_item, local_preview)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (install_id, kind, remote_id) WHERE status = 'open'
     DO UPDATE SET remote_item = EXCLUDED.remote_item, local_preview = EXCLUDED.local_preview, name = EXCLUDED.name`,
    [o.install.id, o.install.name, o.peerId, o.kind, o.item.id, localId, ownerId, k.name(o.item.data).slice(0, 200), JSON.stringify(o.item), cur ? JSON.stringify(cur.data) : null]);
  return { result: 'conflict', local_id: localId };
}

// ── conflicts ─────────────────────────────────────────────────

export async function listConflicts(status = 'open'): Promise<Array<Record<string, unknown>>> {
  const r = await query(
    `SELECT id, install_id, install_name, peer_id, kind, name, local_id, remote_item->'data' AS remote, local_preview AS local, status, resolution, created_at
     FROM federation_conflicts WHERE status = $1 ORDER BY created_at DESC LIMIT 200`, [status]);
  return r.rows;
}

export async function resolveConflict(id: string, choice: 'local' | 'remote'): Promise<void> {
  const c = (await query('SELECT * FROM federation_conflicts WHERE id = $1 AND status = \'open\'', [id])).rows[0];
  if (!c) throw new AppError(404, 'Conflict niet gevonden');
  const item = c.remote_item as Item;
  const k = kindOf(c.kind);
  if (choice === 'remote') {
    const peer = c.peer_id ? await getPeer(c.peer_id) : null;
    const res = await applyIncoming({
      install: { id: c.install_id, name: c.install_name ?? '' }, kind: c.kind, item, fallbackAdmin: c.owner_id, peerId: c.peer_id, force: true,
      fetchAttachment: peer ? (rid) => peerBuffer(peer, `/attachments/${rid}`) : undefined,
    });
    if (res.result === 'error') throw new AppError(500, res.error ?? 'Importeren mislukt');
  } else if (c.local_id) {
    // keep ours: remember that we have seen this remote version, so it is not reported again until it changes
    await setOrigin(c.install_id, c.kind, item.id, c.local_id, item.hash);
  }
  void k;
  await query(`UPDATE federation_conflicts SET status = 'resolved', resolution = $2, resolved_at = now() WHERE id = $1`, [id, choice]);
  await query(`UPDATE federation_conflicts SET status = 'resolved', resolution = 'vervangen', resolved_at = now() WHERE install_id = $1 AND kind = $2 AND remote_id = $3 AND status = 'open'`, [c.install_id, c.kind, item.id]);
}

// ── peers (outbound) ──────────────────────────────────────────

export interface Peer {
  id: string; name: string; url: string; api_key_enc: string; remote_install_id: string | null; remote_name: string | null; direction: string | null;
  enabled: boolean; nightly: boolean; all_users: boolean; kinds: Record<string, boolean>; cursors: Record<string, string>; push_cursors: Record<string, string>;
  status: string; status_message: string | null; last_sync_at: string | null; last_result: Record<string, Record<string, number>> | null; created_by: string | null;
}

export async function getPeer(idOrName: string): Promise<Peer> {
  const isId = /^[0-9a-f-]{36}$/.test(idOrName);
  const r = await query<Peer>(isId ? 'SELECT * FROM federation_peers WHERE id = $1' : 'SELECT * FROM federation_peers WHERE lower(name) = lower($1)', [idOrName]);
  if (!r.rows[0]) throw new AppError(404, 'Installatie niet gevonden');
  return r.rows[0];
}

export async function listPeers(): Promise<Array<Omit<Peer, 'api_key_enc'> & { open_conflicts: number }>> {
  const r = await query(
    `SELECT p.id, p.name, p.url, p.remote_install_id, p.remote_name, p.direction, p.enabled, p.nightly, p.all_users, p.kinds, p.status, p.status_message,
            p.last_sync_at, p.last_result, (SELECT count(*)::int FROM federation_conflicts c WHERE c.peer_id = p.id AND c.status = 'open') AS open_conflicts
     FROM federation_peers p ORDER BY p.created_at`);
  return r.rows as never;
}

function peerBase(p: { url: string }): string {
  const u = p.url.trim().replace(/\/+$/, '');
  return u.endsWith('/federation') ? u : `${u}/api/federation`;
}

async function peerRequest(p: Peer, path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
  const me = await selfInfo();
  const res = await fetch(peerBase(p) + path, {
    method: init.method ?? 'GET', body: init.body, signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${decrypt(p.api_key_enc)}`, 'x-federation-install': me.id, 'x-federation-name': encodeURIComponent(me.name), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* no json */ }
    throw new Error(res.status === 401 ? 'Sleutel ongeldig of ingetrokken' : `${msg} (${path.split('?')[0]})`);
  }
  return res;
}
export async function peerJson<T>(p: Peer, path: string, init?: Parameters<typeof peerRequest>[2]): Promise<T> { return (await peerRequest(p, path, init)).json() as Promise<T>; }
async function peerBuffer(p: Peer, path: string): Promise<Buffer | null> {
  try { return Buffer.from(await (await peerRequest(p, path)).arrayBuffer()); } catch { return null; }
}

export async function createPeer(adminId: string, b: { name: string; url: string; apiKey: string; allUsers?: boolean }): Promise<string> {
  if (!/^https?:\/\//i.test(b.url)) throw new AppError(400, 'URL moet met http:// of https:// beginnen');
  const r = await query<{ id: string }>('INSERT INTO federation_peers (name, url, api_key_enc, created_by, all_users) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [b.name.trim().slice(0, 80), b.url.trim(), encrypt(b.apiKey.trim()), adminId, !!b.allUsers]);
  try { await testPeer(r.rows[0].id); } catch { /* status shows it */ }
  return r.rows[0].id;
}

export async function testPeer(id: string): Promise<{ name: string; direction: string; kinds: Record<string, { count: number }> }> {
  const p = await getPeer(id);
  try {
    const m = await peerJson<{ install_id: string; name: string; direction: string; version: number; kinds: Record<string, { count: number }> }>(p, '/manifest');
    if (m.version !== FEDERATION_VERSION) throw new Error(`Andere federatieversie (${m.version})`);
    await query(`UPDATE federation_peers SET remote_install_id = $2, remote_name = $3, direction = $4, status = CASE WHEN status IN ('new','error') THEN 'ok' ELSE status END,
                 status_message = CASE WHEN status IN ('new','error') THEN NULL ELSE status_message END WHERE id = $1`, [id, m.install_id, m.name, m.direction]);
    return m;
  } catch (e) {
    await query(`UPDATE federation_peers SET status = 'error', status_message = $2 WHERE id = $1`, [id, (e as Error).message.slice(0, 300)]);
    throw new AppError(502, (e as Error).message);
  }
}

export async function updatePeer(id: string, b: { name?: string; url?: string; apiKey?: string; enabled?: boolean; nightly?: boolean; allUsers?: boolean; kinds?: Record<string, boolean> }): Promise<void> {
  const p = await getPeer(id);
  const kindsNew = { ...p.kinds };
  for (const k of KINDS) if (b.kinds && typeof b.kinds[k] === 'boolean') kindsNew[k] = b.kinds[k];
  await query(`UPDATE federation_peers SET name = $2, url = $3, api_key_enc = $4, enabled = $5, nightly = $6, kinds = $7 WHERE id = $1`,
    [id, b.name?.trim().slice(0, 80) || p.name, b.url?.trim() || p.url, b.apiKey?.trim() ? encrypt(b.apiKey.trim()) : p.api_key_enc, b.enabled ?? p.enabled, b.nightly ?? p.nightly, JSON.stringify(kindsNew)]);
  // widening the scope: start over so older items of other users come along too
  if (typeof b.allUsers === 'boolean' && b.allUsers !== p.all_users) {
    await query(`UPDATE federation_peers SET all_users = $2${b.allUsers ? ", cursors = '{}', push_cursors = '{}'" : ''} WHERE id = $1`, [id, b.allUsers]);
  }
}

export async function deletePeer(id: string): Promise<void> {
  const p = await getPeer(id);
  await query('DELETE FROM federation_conflicts WHERE peer_id = $1', [id]);
  if (p.remote_install_id) await query('DELETE FROM federation_origin WHERE install_id = $1', [p.remote_install_id]);
  await query('DELETE FROM federation_peers WHERE id = $1', [id]);
}

// ── sync ──────────────────────────────────────────────────────

const running = new Set<string>();
type Stat = { created: number; updated: number; conflicts: number; errors: number; pushed: number };
const newStat = (): Stat => ({ created: 0, updated: 0, conflicts: 0, errors: 0, pushed: 0 });
const count = (s: Stat, r: ApplyResult) => { if (r === 'created') s.created++; else if (r === 'updated') s.updated++; else if (r === 'conflict') s.conflicts++; else if (r === 'error') s.errors++; };

export interface SyncOpts { kinds?: string[]; owner?: string; manual?: boolean; push?: boolean }

export async function syncPeer(idOrName: string, opts: SyncOpts = {}): Promise<Record<string, Stat>> {
  let p = await getPeer(idOrName);
  if (running.has(p.id)) throw new AppError(409, 'Synchronisatie loopt al');
  running.add(p.id);
  const result: Record<string, Stat> = {};
  try {
    await query(`UPDATE federation_peers SET status = 'syncing', status_message = NULL WHERE id = $1`, [p.id]);
    await testPeer(p.id);
    p = await getPeer(p.id);
    const me = await selfInfo();
    const remote = { id: p.remote_install_id as string, name: p.remote_name || p.name };
    const wanted = (opts.kinds?.length ? opts.kinds : KINDS.filter((k) => p.kinds[k])) as string[];
    const cursors = { ...p.cursors }; const pushCursors = { ...p.push_cursors };
    let failed = '';
    // without all_users only the items of the admin who made the link go along (lessons are shared knowledge, always all)
    const creatorEmail = p.all_users || !p.created_by ? undefined
      : (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [p.created_by])).rows[0]?.email;
    for (const kind of KINDS.filter((k) => wanted.includes(k))) {
      const st = (result[kind] = newStat());
      const scope = opts.owner ?? (kind === 'lessons' ? undefined : creatorEmail);
      let after = opts.owner ? null : parseCursor(cursors[kind]);
      for (let page = 0; page < 500; page++) {
        const qs = `?limit=${kind === 'conversations' ? 10 : kind === 'files' ? 8 : 50}${after ? `&after=${encodeURIComponent(`${after[0]}|${after[1]}`)}` : ''}${scope ? `&owner=${encodeURIComponent(scope)}` : ''}`;
        const data = await peerJson<{ items: Item[]; next: string | null }>(p, `/export/${kind}${qs}`);
        let stop = false;
        for (const item of data.items) {
          const r = await applyIncoming({ install: remote, kind, item, fallbackAdmin: p.created_by as string, peerId: p.id, fetchAttachment: (rid) => peerBuffer(p, `/attachments/${rid}`) });
          count(st, r.result);
          if (r.result === 'error') { failed = `${KIND_LABEL[kind as KindName]}: ${r.error}`; stop = true; break; }
        }
        if (stop) break;
        if (!data.next || !data.items.length && data.next === `${after?.[0]}|${after?.[1]}`) { if (data.next && !opts.owner) cursors[kind] = data.next; break; }
        after = parseCursor(data.next);
        if (!opts.owner) cursors[kind] = data.next;
        if (data.items.length === 0 && !after) break;
      }
      // two-way key: send what is new or changed here
      if ((opts.push ?? true) && p.direction === 'readwrite' && !failed) {
        try { await pushKind(p, me, kind, st, pushCursors, scope, !!opts.owner); } catch (e) { failed = `${KIND_LABEL[kind as KindName]} versturen: ${(e as Error).message}`; }
      }
      if (failed) break;
    }
    const conflicts = Object.values(result).reduce((n, s) => n + s.conflicts, 0);
    await query(
      `UPDATE federation_peers SET status = $2, status_message = $3, last_sync_at = now(), last_result = $4, cursors = $5, push_cursors = $6 WHERE id = $1`,
      [p.id, failed ? 'error' : conflicts ? 'conflicts' : 'ok', failed || null, JSON.stringify(result), JSON.stringify(cursors), JSON.stringify(pushCursors)]);
    return result;
  } catch (e) {
    await query(`UPDATE federation_peers SET status = 'error', status_message = $2 WHERE id = $1`, [p.id, (e as Error).message.slice(0, 300)]);
    throw e;
  } finally { running.delete(p.id); }
}

async function pushKind(p: Peer, me: { id: string; name: string }, kind: string, st: Stat, cursors: Record<string, string>, owner?: string, oneOff = false): Promise<void> {
  const k = kindOf(kind);
  let after = oneOff ? null : parseCursor(cursors[kind]);
  for (let page = 0; page < 500; page++) {
    const pageN = kind === 'conversations' ? 5 : kind === 'files' ? 6 : 40;
    const raw = await k.list(after, pageN, owner);
    if (!raw.length) break;
    const rows = (await query<{ local_id: string; install_id: string; local_hash: string; pushed: boolean }>(
      'SELECT local_id, install_id, local_hash, pushed FROM federation_origin WHERE kind = $1 AND local_id = ANY($2::text[])', [kind, raw.map((i) => i.id)])).rows;
    const send: Item[] = [];
    for (const i of raw) {
      const hash = hashData(i.data);
      const mine = rows.filter((r) => r.install_id === p.remote_install_id && r.local_id === i.id);
      const foreign = rows.some((r) => r.local_id === i.id && !mine.length); // came from a third installation: stays there
      if (foreign && !rows.some((r) => r.pushed)) continue;
      if (mine.some((r) => !r.pushed)) continue; // pulled from this peer: it is the source
      if (mine.some((r) => r.local_hash === hash)) continue; // pushed before, unchanged
      send.push({ ...i, hash });
    }
    for (const item of send) {
      if (kind === 'conversations') {
        for (const a of (item.data.attachments ?? []) as Array<{ rid: string; name: string }>) {
          const f = await findAttachment(a.rid);
          if (!f) continue;
          await peerRequest(p, `/attachments/${a.rid}`, { method: 'PUT', body: new Uint8Array(readFileSync(f.path)), headers: { 'Content-Type': 'application/octet-stream' } });
        }
      }
      const res = await peerJson<{ results: Array<{ id: string; result: ApplyResult; local_id: string | null; error?: string }> }>(p, `/import/${kind}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ install: { id: me.id, name: me.name }, items: [item] }),
      });
      const r = res.results[0];
      if (!r) continue;
      if (r.result === 'error') throw new Error(r.error ?? 'fout bij de andere installatie');
      count(st, r.result === 'created' || r.result === 'updated' ? 'unchanged' : r.result);
      if (r.result === 'created' || r.result === 'updated') st.pushed++;
      if (r.local_id && r.result !== 'conflict') await setOrigin(p.remote_install_id as string, kind, r.local_id, item.id, item.hash, true);
    }
    after = parseCursor(mkCursor(raw[raw.length - 1]));
    if (!oneOff) cursors[kind] = mkCursor(raw[raw.length - 1]);
    if (raw.length < pageN) break;
  }
}

/** On-demand import (admin chat): items of one kind whose name contains `match`, regardless of the checkboxes. */
export async function importOnDemand(idOrName: string, kind: string, match: string): Promise<Array<{ name: string; result: ApplyResult; error?: string }>> {
  const p = await testPeer(idOrName).then(() => getPeer(idOrName));
  const k = kindOf(kind);
  const needle = match.trim().toLowerCase();
  if (!needle) throw new AppError(400, 'match ontbreekt');
  const remote = { id: p.remote_install_id as string, name: p.remote_name || p.name };
  const out: Array<{ name: string; result: ApplyResult; error?: string }> = [];
  let after: [string, string] | null = null;
  for (let page = 0; page < 500; page++) {
    const data: { items: Item[]; next: string | null } = await peerJson(p, `/export/${kind}?limit=${kind === 'conversations' ? 10 : kind === 'files' ? 8 : 50}${after ? `&after=${encodeURIComponent(`${after[0]}|${after[1]}`)}` : ''}`);
    for (const item of data.items) {
      const name = k.name(item.data);
      if (!name.toLowerCase().includes(needle)) continue;
      const r = await applyIncoming({ install: remote, kind, item, fallbackAdmin: p.created_by as string, peerId: p.id, fetchAttachment: (rid) => peerBuffer(p, `/attachments/${rid}`) });
      out.push({ name: name.slice(0, 80), result: r.result, error: r.error });
    }
    if (!data.next || !data.items.length) break;
    after = parseCursor(data.next);
  }
  return out;
}

// ── nightly ───────────────────────────────────────────────────

export function startFederationScheduler(): void {
  setInterval(() => {
    void (async () => {
      const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
      if (t.getHours() !== 3 || t.getMinutes() < 30) return;
      const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      const due = (await query<{ id: string }>(
        `SELECT id FROM federation_peers WHERE enabled AND nightly AND (last_nightly_on IS NULL OR last_nightly_on < $1::date)`, [today])).rows;
      for (const d of due) {
        await query('UPDATE federation_peers SET last_nightly_on = $2::date WHERE id = $1', [d.id, today]);
        await syncPeer(d.id).catch((e) => console.error('[federation] nightly sync failed:', (e as Error).message));
      }
    })().catch((e) => console.error('[federation] scheduler:', e));
  }, 5 * 60_000);
  console.log('✓ Federation scheduler started (nightly 03:30)');
}

/** removes everything federation knows about an installation id (used when a peer is deleted and by tests) */
export async function forgetInstall(installId: string): Promise<void> {
  await query('DELETE FROM federation_origin WHERE install_id = $1', [installId]);
}
void chownSync; void statSync;
