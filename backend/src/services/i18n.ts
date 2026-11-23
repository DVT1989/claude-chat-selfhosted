import { readFileSync } from 'fs';
import { join } from 'path';
import { query } from '../db';
import { runStructured } from './claudeCode';
import { config } from '../config';

const PROJECT_DIR = config.projectDir;
const MESSAGES_DIR = join(PROJECT_DIR, 'frontend', 'messages');

export const BUILTIN: Record<string, string> = { en: 'English', nl: 'Nederlands' };
export const CODE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

const names = new Map<string, string>();

export async function ensureTranslationsTable(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS translations (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, messages JSONB NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query("ALTER TABLE users ALTER COLUMN language SET DEFAULT 'en'");
  await refreshNames();
}

export async function refreshNames(): Promise<void> {
  const r = await query<{ code: string; name: string }>('SELECT code, name FROM translations');
  names.clear();
  for (const x of r.rows) names.set(x.code, x.name);
}

/** English name of a language for "Always respond in ..." (generated languages: the stored name). */
export function languageLabel(code?: string | null): string {
  if (!code || code === 'nl') return 'Dutch';
  if (code === 'en') return 'English';
  return names.get(code) ?? 'English';
}

export async function isKnownLanguage(code: string): Promise<boolean> {
  if (BUILTIN[code]) return true;
  return (await query('SELECT 1 FROM translations WHERE code = $1', [code])).rows.length > 0;
}

export async function listLanguages(): Promise<{ code: string; name: string }[]> {
  const r = await query<{ code: string; name: string }>('SELECT code, name FROM translations ORDER BY name');
  return [...Object.entries(BUILTIN).map(([code, name]) => ({ code, name })), ...r.rows.filter((x) => !BUILTIN[x.code])];
}

export async function getMessages(code: string): Promise<Record<string, unknown> | null> {
  const r = await query<{ messages: Record<string, unknown> }>('SELECT messages FROM translations WHERE code = $1', [code]);
  return r.rows[0]?.messages ?? null;
}

function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof obj === 'string') out[prefix] = obj;
  return out;
}

function unflatten(flat: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(flat)) {
    const parts = path.split('.');
    let cur = root;
    parts.slice(0, -1).forEach((p) => { cur = (cur[p] = (cur[p] as Record<string, unknown>) ?? {}) as Record<string, unknown>; });
    cur[parts[parts.length - 1]] = v;
  }
  return root;
}

const placeholders = (s: string) => (s.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort().join(',');

export interface Job { id: string; userId: string; input: string; code?: string; name?: string; status: 'running' | 'done' | 'error'; done: number; total: number; error?: string; fallbackKeys: number; updated: number }
const jobs = new Map<string, Job>();

export function getJob(id: string, userId: string): Job | null {
  const j = jobs.get(id);
  return j && j.userId === userId ? j : null;
}

export function startGeneration(userId: string, input: string): Job {
  for (const j of jobs.values()) if (j.userId === userId && j.status === 'running') return j;
  const job: Job = { id: Math.random().toString(36).slice(2, 10), userId, input, status: 'running', done: 0, total: 0, fallbackKeys: 0, updated: Date.now() };
  jobs.set(job.id, job);
  void run(job).catch((e) => { job.status = 'error'; job.error = e instanceof Error ? e.message : String(e); job.updated = Date.now(); });
  for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.updated > 3600_000) jobs.delete(id);
  return job;
}

const CHUNK = 70;

async function run(job: Job): Promise<void> {
  // 1. which language is meant (any spelling, any language)
  const id = await runStructured<{ valid: boolean; code: string; name: string }>(job.userId, {
    system: 'You identify a human language from user input. Reply only in the requested JSON.',
    prompt: `The user typed: "${job.input.slice(0, 60)}". valid: true if this is a real human language. code: lowercase ISO 639-1 code (or ISO 639-3 if there is no 639-1 code). name: the English name of the language (for example "German").`,
    schema: { type: 'object', additionalProperties: false, required: ['valid', 'code', 'name'], properties: { valid: { type: 'boolean' }, code: { type: 'string' }, name: { type: 'string' } } },
    model: 'haiku', timeoutMs: 60_000, action: 'i18n',
  });
  const code = id.code.toLowerCase().trim();
  if (!id.valid || !CODE_RE.test(code)) throw new Error(`"${job.input}" is geen herkenbare taal`);
  if (BUILTIN[code]) throw new Error(`${BUILTIN[code]} is al beschikbaar`);
  job.code = code; job.name = id.name.slice(0, 60);

  // 2. translate en.json in chunks, keep placeholders, fall back to English per key on failure
  const en = flatten(JSON.parse(readFileSync(join(MESSAGES_DIR, 'en.json'), 'utf8')));
  const keys = Object.keys(en);
  job.total = keys.length;
  const result: Record<string, string> = {};
  const system = `You translate the user interface of a chat app from English to ${id.name}. Keep the meaning short and natural for a UI. Keep placeholders such as {name} or {count} exactly as they are (do not translate or remove them). Keep "Claude", "Claude Code", product names, emoji, URLs and technical terms (SSH, FTP, OAuth) as they are. Keep leading or trailing spaces and punctuation like … where the source has them. Reply only in the requested JSON.`;
  const schema = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'text'], properties: { key: { type: 'string' }, text: { type: 'string' } } } } } };
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    let pending = part;
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const out = await runStructured<{ items: { key: string; text: string }[] }>(job.userId, {
        system, schema, model: 'haiku', timeoutMs: 240_000, action: 'i18n',
        prompt: `Translate the value of each item to ${id.name}. Return every key unchanged.\n${JSON.stringify(pending.map((k) => ({ key: k, text: en[k] })))}`,
      });
      for (const it of out.items ?? []) {
        if (en[it.key] !== undefined && typeof it.text === 'string' && it.text.trim() && placeholders(it.text) === placeholders(en[it.key])) result[it.key] = it.text;
      }
      pending = pending.filter((k) => result[k] === undefined);
    }
    for (const k of pending) { result[k] = en[k]; job.fallbackKeys++; }
    job.done = Math.min(keys.length, i + part.length);
    job.updated = Date.now();
  }
  const messages = unflatten(result);
  JSON.parse(JSON.stringify(messages)); // must be valid JSON
  await query(
    `INSERT INTO translations (code, name, messages, created_by) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, messages = EXCLUDED.messages, updated_at = NOW()`,
    [code, job.name, JSON.stringify(messages), job.userId]);
  await refreshNames();
  job.status = 'done'; job.updated = Date.now();
}
