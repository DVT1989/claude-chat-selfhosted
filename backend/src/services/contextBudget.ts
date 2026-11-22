/**
 * Small core: how many tokens the context we build per run costs (CLAUDE.md with lessons and the
 * memory core, the skill list Claude Code shows, the agents prompt), a budget per user, and trimming
 * of the variable parts (lessons, memory core) when a run would go over it. Every run is logged.
 *
 * Token counts are an estimate (characters / 3.5, about right for Dutch text with commands): there
 * is no tokenizer offline and a count_tokens call per run would cost more than it saves.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { query } from '../db';

export const CHARS_PER_TOKEN = 3.5;
export const DEFAULT_BUDGET = 9000;
export const MIN_BUDGET = 2000;
export const MAX_BUDGET = 40000;

export const estimateTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

export async function ensureContextSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS context_sizes (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claude_md_tokens INTEGER NOT NULL,
      memory_tokens INTEGER NOT NULL DEFAULT 0,
      lessons_tokens INTEGER NOT NULL DEFAULT 0,
      global_md_tokens INTEGER NOT NULL DEFAULT 0,
      skills_tokens INTEGER NOT NULL DEFAULT 0,
      skills_count INTEGER NOT NULL DEFAULT 0,
      agents_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL,
      budget INTEGER NOT NULL,
      trimmed TEXT[] NOT NULL DEFAULT '{}'
    )`);
  await query('CREATE INDEX IF NOT EXISTS context_sizes_user_idx ON context_sizes (user_id, created_at DESC)');
}

/** Budget for the core of one run (CLAUDE.md files + memory + lessons), in tokens. */
export async function getBudget(userId: string): Promise<number> {
  const r = await query<{ b: string | null }>(`SELECT preferences->'assistant'->>'budgetTokens' AS b FROM users WHERE id = $1`, [userId]);
  const n = Number(r.rows[0]?.b);
  return Number.isFinite(n) && n >= MIN_BUDGET ? Math.min(n, MAX_BUDGET) : DEFAULT_BUDGET;
}

/** What Claude Code lists of the skills in <home>/.claude/skills: name + description per skill. */
export function skillListing(home: string): { chars: number; count: number } {
  const dir = join(home, '.claude', 'skills');
  let chars = 0, count = 0;
  try {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name, 'SKILL.md');
      try {
        if (!existsSync(f) || statSync(f).size > 1_000_000) continue;
        const fm = readFileSync(f, 'utf8').match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
        const desc = fm?.[1].match(/^description:\s*(.*)$/m)?.[1] ?? '';
        chars += name.length + desc.length + 4;
        count++;
      } catch { /* unreadable skill */ }
    }
  } catch { /* no skills dir */ }
  return { chars, count };
}

type Core = { core: Array<{ id: string; topic: string; content: string; pinned?: boolean }>; topics: unknown[]; total: number };
type LessonsCfg = { lessons?: Array<{ topic: string; lesson: string }>; memory?: Core; trimmed?: string[] };

/**
 * One trimming step on the lessons connector config, least valuable first. Returns what it did,
 * or null when nothing is left to trim (pinned facts and the five newest lessons always stay).
 */
export function trimStep(cfg: LessonsCfg): string | null {
  const core = cfg.memory?.core ?? [];
  const lessons = cfg.lessons ?? [];
  if (core.some((c) => c.content.length > 160)) {
    for (const c of core) if (c.content.length > 160) c.content = c.content.replace(/\s+/g, ' ').slice(0, 157) + '...';
    return 'kern ingekort tot 160 tekens per feit';
  }
  if (lessons.length > 20) { cfg.lessons = lessons.slice(-20); return `lessen ${lessons.length} -> 20`; }
  const loose = core.map((c, i) => ({ c, i })).filter((x) => !x.c.pinned);
  if (loose.length > 4) { core.splice(loose[loose.length - 1].i, 1); return 'kern: minst gebruikte feit eruit'; }
  if (lessons.length > 5) { cfg.lessons = lessons.slice(-Math.max(5, lessons.length - 5)); return `lessen ${lessons.length} -> ${cfg.lessons.length}`; }
  if (loose.length) { core.splice(loose[loose.length - 1].i, 1); return 'kern: minst gebruikte feit eruit'; }
  return null;
}

export interface ContextSize {
  claudeMdChars: number; memoryChars: number; lessonsChars: number; globalMdChars: number;
  skillsChars: number; skillsCount: number; agentsChars: number; budget: number; trimmed: string[];
}

/** Log one run's context size (table + one log line). Never throws. */
export async function recordContext(userId: string, conversationId: string | null, s: ContextSize): Promise<void> {
  const t = {
    md: estimateTokens(s.claudeMdChars), mem: estimateTokens(s.memoryChars), les: estimateTokens(s.lessonsChars),
    glob: estimateTokens(s.globalMdChars), sk: estimateTokens(s.skillsChars), ag: estimateTokens(s.agentsChars),
  };
  const total = t.md + t.glob + t.sk + t.ag;
  console.log(`[context] ${userId.slice(0, 8)} claude.md=${t.md}t (geheugen ${t.mem}t, lessen ${t.les}t) globaal=${t.glob}t skills=${t.sk}t/${s.skillsCount} agents=${t.ag}t totaal=${total}t budget=${s.budget}t${s.trimmed.length ? ` ingekort: ${s.trimmed.join('; ')}` : ''}`);
  try {
    await query(
      `INSERT INTO context_sizes (user_id, conversation_id, claude_md_tokens, memory_tokens, lessons_tokens, global_md_tokens, skills_tokens, skills_count, agents_tokens, total_tokens, budget, trimmed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [userId, conversationId, t.md, t.mem, t.les, t.glob, t.sk, s.skillsCount, t.ag, total, s.budget, s.trimmed]);
    // keep the table small: the last 500 runs per user are plenty for the overview
    if (Math.random() < 0.05) {
      await query(`DELETE FROM context_sizes WHERE user_id = $1 AND id < (SELECT id FROM context_sizes WHERE user_id = $1 ORDER BY id DESC OFFSET 500 LIMIT 1)`, [userId]);
    }
  } catch (err) {
    console.error('[context] log failed:', (err as Error).message);
  }
}
