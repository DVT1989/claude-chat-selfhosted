import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync, chownSync, renameSync } from 'fs';
import { join } from 'path';
import { query } from '../db';
import { getSharedProjectDir } from './claudeCode';
import { runUidOf } from './runUsers';
import { logProjectEvent } from './sharedProjects';

/**
 * geheugen.md in the project dir: a synchronised copy of the project memory (the database is the source).
 * Format, one section per item:
 *   ## id:<uuid> | topic: klant | pinned: ja|nee
 *   text (lines that start with "## " are written as "\## ")
 * A new item: a section "## nieuw | topic: klant". Delete an item: remove its section. Without the title line the file is invalid and restored.
 * Conflict: when the database and the file both changed since the last sync the database wins and the file edit is kept as geheugen.conflict.md.
 */
const TITLE = '# Projectgeheugen';
const HINT = '<!-- Kopie van het projectgeheugen (database = bron). Bewerk de tekst onder een kop, voeg een item toe met een kop "## nieuw | topic: klant", verwijder een item door de sectie te wissen. -->';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

interface Item { id: string; topic: string; pinned: boolean; content: string }

function render(items: Item[]): string {
  const body = items.map((m) => `## id:${m.id} | topic: ${m.topic} | pinned: ${m.pinned ? 'ja' : 'nee'}\n${m.content.trim().replace(/^## /gm, '\\## ')}\n`);
  return [TITLE, '', HINT, '', ...body].join('\n');
}

export function parseMemoryFile(text: string): { id: string | null; topic: string | null; pinned: boolean | null; content: string }[] | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some((l) => l.trim() === TITLE)) return null;
  const out: { id: string | null; topic: string | null; pinned: boolean | null; content: string[] }[] = [];
  const head = /^## (?:id:([0-9a-fA-F-]{36})|nieuw)\s*(?:\|\s*topic:\s*([^|]*?))?\s*(?:\|\s*pinned:\s*(ja|nee))?\s*$/;
  let cur: (typeof out)[number] | null = null;
  for (const l of lines) {
    if (l.startsWith('## ')) {
      const m = head.exec(l);
      if (!m) return null; // unknown heading: do not guess
      cur = { id: m[1]?.toLowerCase() ?? null, topic: m[2]?.trim() || null, pinned: m[3] ? m[3] === 'ja' : null, content: [] };
      out.push(cur);
    } else if (cur) cur.content.push(l.replace(/^\\## /, '## '));
  }
  return out.map((o) => ({ ...o, content: o.content.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim() }));
}

async function target(projectId: string): Promise<{ path: string; uid: number | null; gid: number | null } | null> {
  const p = (await query<{ user_id: string; gid: number | null }>('SELECT user_id, gid FROM projects WHERE id = $1', [projectId])).rows[0];
  if (!p || p.gid == null) return null; // only shared projects use the project memory
  const dir = getSharedProjectDir(projectId);
  if (!existsSync(dir)) return null;
  let uid: number | null = null;
  try { uid = runUidOf(p.user_id); } catch { /* not loaded */ }
  return { path: join(dir, 'geheugen.md'), uid, gid: p.gid };
}

function put(path: string, text: string, t: { uid: number | null; gid: number | null }): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, text, { mode: 0o660 });
  if (t.uid != null && t.gid != null) { try { chownSync(tmp, t.uid, t.gid); } catch { /* best effort */ } }
  try { chmodSync(tmp, 0o660); } catch { /* ignore */ }
  renameSync(tmp, path);
}

const chain = new Map<string, Promise<void>>();
/** One sync at a time per project; safe to call after every change, after a run, and from the poller. */
export function syncProjectMemory(projectId: string): Promise<void> {
  const next = (chain.get(projectId) ?? Promise.resolve()).then(() => doSync(projectId)).catch((e) => console.error('[memory-file]', projectId, (e as Error).message));
  chain.set(projectId, next);
  void next.finally(() => { if (chain.get(projectId) === next) chain.delete(projectId); });
  return next;
}

async function dbItems(projectId: string): Promise<Item[]> {
  return (await query<Item>('SELECT id, topic, pinned, content FROM project_memory WHERE project_id = $1 ORDER BY pinned DESC, created_at, id', [projectId])).rows;
}

async function doSync(projectId: string): Promise<void> {
  const t = await target(projectId);
  if (!t) return;
  const items = await dbItems(projectId);
  const dbText = render(items);
  const st = (await query<{ file_hash: string; db_hash: string }>('SELECT file_hash, db_hash FROM project_memory_sync WHERE project_id = $1', [projectId])).rows[0];
  const save = async (fileText: string) => {
    await query(`INSERT INTO project_memory_sync (project_id, file_hash, db_hash, synced_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (project_id) DO UPDATE SET file_hash = $2, db_hash = $3, synced_at = now()`, [projectId, sha(fileText), sha(dbText)]);
  };
  const fileText = existsSync(t.path) ? readFileSync(t.path, 'utf8') : null;
  if (fileText === null || !st) { put(t.path, dbText, t); await save(dbText); return; }
  const fileChanged = sha(fileText) !== st.file_hash;
  const dbChanged = sha(dbText) !== st.db_hash;
  if (!fileChanged) { if (dbChanged) { put(t.path, dbText, t); } await save(dbChanged ? dbText : fileText); return; }
  // the file was edited (by Claude in a run or by hand)
  const parsed = dbChanged ? null : parseMemoryFile(fileText);
  if (!parsed) {
    // conflict or an unreadable file: the database wins, keep the edit next to it
    const reason = dbChanged ? 'conflict' : 'ongeldig';
    try { writeFileSync(join(t.path, '..', 'geheugen.conflict.md'), fileText, { mode: 0o660 }); chownSync(join(t.path, '..', 'geheugen.conflict.md'), t.uid ?? 0, t.gid ?? 0); } catch { /* ignore */ }
    await logProjectEvent(projectId, null, 'memory.file_conflict', 'geheugen.md', { reason });
    put(t.path, dbText, t); await save(dbText); return;
  }
  const byId = new Map(items.map((m) => [m.id, m]));
  const seen = new Set<string>();
  let added = 0, changed = 0, removed = 0;
  const normTopic = (x: string | null) => (x ?? 'algemeen').trim().toLowerCase().replace(/[^a-z0-9à-ü_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'algemeen';
  for (const p of parsed) {
    if (p.content.length < 3) continue;
    const cur = p.id ? byId.get(p.id) : undefined;
    if (p.id && cur) {
      seen.add(p.id);
      const topic = p.topic ? normTopic(p.topic) : cur.topic;
      const pinned = p.pinned ?? cur.pinned;
      if (p.content !== cur.content.trim() || topic !== cur.topic || pinned !== cur.pinned) {
        await query('UPDATE project_memory SET content = $3, topic = $4, pinned = $5, updated_at = now() WHERE project_id = $1 AND id = $2', [projectId, p.id, p.content.slice(0, 4000), topic, pinned]);
        changed++;
      }
    } else if (!p.id) {
      const dup = await query('SELECT 1 FROM project_memory WHERE project_id = $1 AND lower(content) = lower($2)', [projectId, p.content]);
      if (!dup.rowCount) {
        await query(`INSERT INTO project_memory (project_id, content, topic, pinned, added_via) VALUES ($1,$2,$3,$4,'claude')`, [projectId, p.content.slice(0, 4000), normTopic(p.topic), p.pinned ?? false]);
        added++;
      }
    }
    // an id that is not in the database (removed meanwhile) is not resurrected
  }
  for (const m of items) if (!seen.has(m.id)) { await query('DELETE FROM project_memory WHERE project_id = $1 AND id = $2', [projectId, m.id]); removed++; }
  if (added || changed || removed) await logProjectEvent(projectId, null, 'memory.file', 'geheugen.md', { added, changed, removed });
  const fresh = render(await dbItems(projectId));
  put(t.path, fresh, t);
  await query(`INSERT INTO project_memory_sync (project_id, file_hash, db_hash, synced_at) VALUES ($1,$2,$3,now())
    ON CONFLICT (project_id) DO UPDATE SET file_hash = $2, db_hash = $3, synced_at = now()`, [projectId, sha(fresh), sha(fresh)]);
}

const mtimes = new Map<string, number>();
/** Poller: cheap mtime check per shared project; a changed file is read back. Also writes the file for projects that have none yet. */
export function startProjectMemoryWatcher(): void {
  const tick = async () => {
    try {
      const ps = (await query<{ id: string }>('SELECT id FROM projects WHERE gid IS NOT NULL')).rows;
      for (const p of ps) {
        const path = join(getSharedProjectDir(p.id), 'geheugen.md');
        let m = 0;
        try { m = statSync(path).mtimeMs; } catch { /* missing: sync writes it */ }
        if (mtimes.get(p.id) !== m || m === 0) { await syncProjectMemory(p.id); try { mtimes.set(p.id, statSync(path).mtimeMs); } catch { /* ignore */ } }
      }
    } catch (e) { console.error('[memory-file] watcher:', (e as Error).message); }
  };
  void tick();
  setInterval(tick, 20_000).unref();
}

