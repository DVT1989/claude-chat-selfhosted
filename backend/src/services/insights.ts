/**
 * Insights for Coach (the agent that looks back on how the work went every night) and the proposals
 * that come out of it. Coach runs as a normal (non-privileged) subagent, so it only reaches this via
 * HTTP with the per-run memory token (routes/insights.ts), like memory, history and tasks.
 *
 * buildInsights: compact statistics of one user over a period, per conversation and per agent:
 * duration, tool steps, failed tools, repeated commands, interruptions, tokens, agent rounds,
 * signs of repetition or frustration in the user's messages and the slowest runs. Kept under ~20 KB.
 *
 * agent_proposals: what Coach proposes (prompt, model, description of an agent, or something else).
 * Apply changes the agent and keeps the value it had, so revert puts exactly that back. Skill
 * proposals go into the existing skill_proposals (approved under Assistent like the learning loop's).
 */
import { query } from '../db';
import { AppError } from '../middleware/errorHandler';
import { similarity, approveProposal as approveSkillProposal, rejectProposal as rejectSkillProposal } from './learning';

export async function ensureInsightsSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS agent_proposals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK (kind IN ('prompt', 'model', 'description', 'skill', 'other')),
      title TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      before TEXT,
      after TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'rejected', 'reverted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_at TIMESTAMPTZ
    )`);
  await query('CREATE INDEX IF NOT EXISTS agent_proposals_user_idx ON agent_proposals (user_id, status, created_at DESC)');
  // kind 'other': the delegation to Builder that carries it out; the proposal becomes 'applied' when that delegation is done
  await query('ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS delegation_id UUID');
}

// ── Statistics ──────────────────────────────────────────────
type Ev = Record<string, unknown> & { type?: string };
interface Row { id: string; conversation_id: string; title: string; role: string; content: string; metadata: Record<string, unknown> | null; created_at: Date }

const FRUSTRATION: Array<[RegExp, string]> = [
  [/duurt?e? (zo |erg |te |best )?lang/i, 'duurde lang'],
  [/nog (steeds|altijd)/i, 'nog steeds'],
  [/werkt (nog |weer |nu )?(steeds )?niet|doet het (nog )?niet/i, 'werkt niet'],
  [/(dat|dit) had ik (toch )?al|ik (zei|vroeg|schreef) (toch|al|net)/i, 'dat had ik al'],
  [/(weer|opnieuw) (hetzelfde|fout|mis)|alweer/i, 'weer fout'],
  [/niet wat ik (vroeg|bedoel)|lees (nou |nu )?(eens )?(goed|wat ik)/i, 'niet gelezen'],
  [/waarom (duurt|doe|doet|stopt|stopte)/i, 'waarom'],
];

const parseEvents = (content: string): Ev[] | null => {
  if (!content.startsWith('[')) return null;
  try { const j = JSON.parse(content); return Array.isArray(j) ? j as Ev[] : null; } catch { return null; }
};
const normCmd = (c: unknown) => String(c ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const sec = (ms: number) => Math.round(ms / 1000);

interface RunStat { conv: string; msg: string; at: Date; dur: number | null; steps: number; errs: number; repeats: number; agents: string[]; stopped: boolean }
interface ConvStat { id: string; title: string; runs: number; dur: number; steps: number; errs: number; repeats: number; agentRounds: number;
  interrupts: Record<string, number>; tin: number; tout: number; cost: number; userMsgs: number; frustration: number }
interface AgentStat { name: string; rounds: number; errors: number; interrupted: number; steps: number; toolErrors: number; durs: number[]; convs: Set<string>; reportChars: number; resumed: number }

export async function buildInsights(userId: string, since: Date, until: Date): Promise<Record<string, unknown>> {
  const rows = (await query<Row>(
    `SELECT m.id, m.conversation_id, COALESCE(c.title, '') AS title, m.role, left(m.content, 400000) AS content, m.metadata, m.created_at
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = $1 AND c.status <> 'deleted' AND m.created_at >= $2 AND m.created_at < $3
     ORDER BY m.conversation_id, m.created_at LIMIT 4000`, [userId, since, until])).rows;
  const usage = (await query<{ conversation_id: string | null; created_at: Date; input_tokens: number; output_tokens: number; cost_usd: string; action: string; metadata: { cache_read?: number; cache_creation?: number } | null }>(
    `SELECT conversation_id, created_at, input_tokens, output_tokens, cost_usd, action, metadata FROM usage_logs
     WHERE user_id = $1 AND created_at >= $2 AND created_at < $3::timestamptz + interval '6 hours' ORDER BY created_at`, [userId, since, until])).rows;

  // tokens per action (chat, chat-partial, learn, training, task_summary, delegation_summary, assist) incl. cache, also without a conversation
  const tokensByAction: Record<string, { calls: number; input: number; output: number; cache_read: number; cache_creation: number; cost_usd: number }> = {};
  for (const u of usage) {
    if (u.created_at >= until) continue;
    const t = tokensByAction[u.action] ??= { calls: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 0 };
    t.calls++; t.input += u.input_tokens; t.output += u.output_tokens;
    t.cache_read += u.metadata?.cache_read ?? 0; t.cache_creation += u.metadata?.cache_creation ?? 0; t.cost_usd = Math.round((t.cost_usd + (Number(u.cost_usd) || 0)) * 1e4) / 1e4;
  }
  const usageBy = new Map<string, typeof usage>();
  for (const u of usage) if (u.conversation_id) (usageBy.get(u.conversation_id) ?? usageBy.set(u.conversation_id, []).get(u.conversation_id)!).push(u);

  const convs = new Map<string, ConvStat>();
  const agents = new Map<string, AgentStat>();
  const runs: RunStat[] = [];
  const frustration: Array<{ conversation_id: string; at: string; signal: string; text: string }> = [];
  const repeatedCmds = new Map<string, { times: number; convs: Set<string> }>();
  const totals = { interrupts: {} as Record<string, number> };
  const bump = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };

  // per conversation, in order
  let i = 0;
  while (i < rows.length) {
    const convId = rows[i].conversation_id;
    const list: Row[] = [];
    while (i < rows.length && rows[i].conversation_id === convId) list.push(rows[i++]);
    const cs: ConvStat = { id: convId, title: list[0].title, runs: 0, dur: 0, steps: 0, errs: 0, repeats: 0, agentRounds: 0, interrupts: {}, tin: 0, tout: 0, cost: 0, userMsgs: 0, frustration: 0 };
    convs.set(convId, cs);
    const cmdsInConv = new Map<string, number>();
    const recentUser: string[] = [];
    const logs = (usageBy.get(convId) ?? []).slice();
    for (const u of logs) { cs.tin += u.input_tokens; cs.tout += u.output_tokens; cs.cost += Number(u.cost_usd) || 0; }

    list.forEach((m, k) => {
      const meta = m.metadata ?? {};
      if (m.role === 'user') {
        if (meta.auto) { bump(cs.interrupts, `auto_${String(meta.auto)}`); bump(totals.interrupts, `auto_${String(meta.auto)}`); return; }
        cs.userMsgs++;
        const text = m.content.replace(/\s+/g, ' ').trim();
        if (/^This session is being continued|<system-reminder>|^\[Request interrupted/.test(text)) return;   // generated, not typed
        let signal = FRUSTRATION.find(([re]) => re.test(text))?.[1] ?? '';
        if (!signal && text.length > 15 && recentUser.some((p) => similarity(p, text) >= 0.7)) signal = 'herhaalde vraag';
        if (signal) { cs.frustration++; frustration.push({ conversation_id: convId, at: m.created_at.toISOString(), signal, text: clip(text, 160) }); }
        recentUser.push(text); if (recentUser.length > 3) recentUser.shift();
        return;
      }
      if (m.role !== 'assistant') return;
      cs.runs++;
      const evs = parseEvents(m.content) ?? [];
      const oldTools = Array.isArray(meta.tools) ? meta.tools as Array<{ name?: string; input?: { command?: string }; result?: unknown }> : [];
      let steps = 0, errs = 0, repeats = 0;
      const names: string[] = [];
      const cmdsInRun = new Map<string, number>();
      const countCmd = (c: string) => { if (!c) return; cmdsInRun.set(c, (cmdsInRun.get(c) ?? 0) + 1); cmdsInConv.set(c, (cmdsInConv.get(c) ?? 0) + 1); };
      for (const t of oldTools) { steps++; countCmd(normCmd(t.input?.command)); }
      const results = new Map<string, Ev>();
      for (const e of evs) if (e.type === 'agent_result') results.set(String(e.toolUseId), e);
      for (const e of evs) {
        if (e.type === 'tool_use') {
          steps++;
          if (e.err) errs++;
          const inp = (e.toolInput ?? {}) as { command?: string };
          countCmd(normCmd(inp.command));
        } else if (e.type === 'agent_start') {
          const name = String(e.agentName ?? '?');
          names.push(name);
          cs.agentRounds++;
          const a = agents.get(name) ?? agents.set(name, { name, rounds: 0, errors: 0, interrupted: 0, steps: 0, toolErrors: 0, durs: [], convs: new Set(), reportChars: 0, resumed: 0 }).get(name)!;
          a.rounds++; a.convs.add(convId);
          if (e.resumed) a.resumed++;
          a.steps += Number(e.steps) || 0;
          a.toolErrors += Number(e.errs) || 0;
          errs += Number(e.errs) || 0;
          steps += Number(e.steps) || 0;
          const r = results.get(String(e.toolUseId));
          if (r) {
            if (r.isError) a.errors++;
            a.reportChars += String(r.content ?? '').length;
            const t0 = Date.parse(String(e.t0 ?? e.at ?? '')), t1 = Date.parse(String(r.t1 ?? ''));
            if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) a.durs.push(t1 - t0);
          } else if (!meta.streaming) a.interrupted++;
        } else if (e.type === 'agent_interrupted') {
          const why = String(e.reason ?? 'limit');
          bump(cs.interrupts, `agent_${why}`); bump(totals.interrupts, `agent_${why}`);
        } else if (e.type === 'rate_limited') {
          bump(cs.interrupts, 'limit'); bump(totals.interrupts, 'limit');
        }
      }
      for (const n of cmdsInRun.values()) if (n > 1) repeats += n - 1;
      if (meta.interrupted) { bump(cs.interrupts, 'restart'); bump(totals.interrupts, 'restart'); }
      if (meta.error) {
        const why = /token|oauth|401|auth/i.test(String(meta.error)) ? 'token' : 'error';
        bump(cs.interrupts, why); bump(totals.interrupts, why);
        errs++;
      }
      // duration: from the start of the answer to its usage log (written when the run ends), else the next message
      const start = m.created_at.getTime();
      const nextAssistant = list.slice(k + 1).find((x) => x.role === 'assistant')?.created_at.getTime() ?? Infinity;
      const log = logs.find((u) => u.created_at.getTime() >= start && u.created_at.getTime() <= nextAssistant);
      let dur: number | null = null;
      if (log) { dur = log.created_at.getTime() - start; logs.splice(logs.indexOf(log), 1); }
      if (dur !== null && dur > 6 * 3600_000) dur = null;
      const stopped = !log && !meta.error && !meta.streaming && !meta.interrupted;   // no usage log: stopped, or a source without logging
      if (dur !== null) cs.dur += dur;
      cs.steps += steps; cs.errs += errs; cs.repeats += repeats;
      runs.push({ conv: convId, msg: m.id, at: m.created_at, dur, steps, errs, repeats, agents: [...new Set(names)], stopped });
    });
    for (const [c, n] of cmdsInConv) if (n > 1) {
      const r = repeatedCmds.get(c) ?? repeatedCmds.set(c, { times: 0, convs: new Set() }).get(c)!;
      r.times += n; r.convs.add(convId);
    }
  }

  const [learn, taskRuns] = await Promise.all([
    query<{ kind: string; status: string; n: number; chars: number; err: string | null }>(
      `SELECT kind, status, count(*)::int AS n, sum(input_chars)::int AS chars, max(error) AS err FROM learn_runs
       WHERE user_id = $1 AND started_at >= $2 AND started_at < $3 GROUP BY kind, status ORDER BY n DESC LIMIT 20`, [userId, since, until]),
    query<{ name: string; kind: string; status: string; n: number; avg_s: number | null; max_s: number | null; conv: string | null; err: string | null }>(
      `SELECT t.name, r.kind, r.status, count(*)::int AS n, round(avg(extract(epoch FROM r.finished_at - r.started_at)))::int AS avg_s,
              round(max(extract(epoch FROM r.finished_at - r.started_at)))::int AS max_s, max(r.conversation_id::text) AS conv, max(left(r.error, 160)) AS err
       FROM task_runs r JOIN scheduled_tasks t ON t.id = r.task_id
       WHERE r.user_id = $1 AND r.started_at >= $2 AND r.started_at < $3 GROUP BY t.name, r.kind, r.status ORDER BY n DESC LIMIT 20`, [userId, since, until]),
  ]);

  // agent durations: from t0/t1 where stored, else the runs the agent took part in
  const agentRunDur = new Map<string, number[]>();
  for (const r of runs) if (r.dur !== null) for (const n of r.agents) (agentRunDur.get(n) ?? agentRunDur.set(n, []).get(n)!).push(r.dur);
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

  const convList = [...convs.values()];
  const tot = convList.reduce((o, c) => ({
    steps: o.steps + c.steps, errs: o.errs + c.errs, repeats: o.repeats + c.repeats, rounds: o.rounds + c.agentRounds,
    tin: o.tin + c.tin, tout: o.tout + c.tout, cost: o.cost + c.cost, user: o.user + c.userMsgs, runs: o.runs + c.runs,
  }), { steps: 0, errs: 0, repeats: 0, rounds: 0, tin: 0, tout: 0, cost: 0, user: 0, runs: 0 });
  const timed = runs.filter((r) => r.dur !== null).map((r) => r.dur!);
  const sorted = [...timed].sort((a, b) => a - b);

  const score = (c: ConvStat) => c.dur / 60_000 + c.errs * 3 + c.repeats * 2 + c.frustration * 5 + Object.values(c.interrupts).reduce((a, b) => a + b, 0) * 3;
  const convOut = (c: ConvStat) => ({
    id: c.id, title: clip(c.title, 60), runs: c.runs, dur_s: sec(c.dur), steps: c.steps, tool_errors: c.errs, repeated_cmds: c.repeats,
    agent_rounds: c.agentRounds, interrupts: Object.keys(c.interrupts).length ? c.interrupts : undefined,
    tokens_in: c.tin, tokens_out: c.tout, user_msgs: c.userMsgs, frustration: c.frustration || undefined,
  });

  const out: Record<string, unknown> = {
    period: { since: since.toISOString(), until: until.toISOString() },
    notes: 'dur_s per run = start antwoord tot usage-log (einde run); runs zonder usage-log (gestopt of bron zonder logging) hebben geen duur. tokens_in is zonder cache (cache staat per action in tokens_by_action, sinds 21-11-2026). Laptop-imports hebben geen usage. Tool-fouten en agent-stappen worden pas sinds 21-11-2026 opgeslagen (err, steps, errs, t0/t1); oudere runs tellen daar 0.',
    totals: {
      conversations: convList.length, runs: tot.runs, user_msgs: tot.user, tool_steps: tot.steps, tool_errors: tot.errs, repeated_cmds: tot.repeats,
      agent_rounds: tot.rounds, interrupts: totals.interrupts, tokens_in: tot.tin, tokens_out: tot.tout,
      run_dur_s: sorted.length ? { median: sec(sorted[Math.floor(sorted.length / 2)]), p90: sec(sorted[Math.floor(sorted.length * 0.9)]), max: sec(sorted[sorted.length - 1]) } : null,
      runs_without_usage_log: runs.filter((r) => r.stopped).length,
      tokens_by_action: tokensByAction,
    },
    agents: [...agents.values()].sort((a, b) => b.rounds - a.rounds).map((a) => ({
      name: a.name, rounds: a.rounds, conversations: a.convs.size, resumed: a.resumed || undefined, errors: a.errors, interrupted: a.interrupted,
      tool_steps: a.steps, tool_errors: a.toolErrors, avg_dur_s: a.durs.length ? sec(avg(a.durs)!) : undefined,
      avg_run_dur_s: agentRunDur.has(a.name) ? sec(avg(agentRunDur.get(a.name)!)!) : undefined, avg_report_chars: Math.round(a.reportChars / Math.max(1, a.rounds)),
    })),
    slowest_runs: runs.filter((r) => r.dur !== null).sort((a, b) => b.dur! - a.dur!).slice(0, 10).map((r) => ({
      conversation_id: r.conv, message_id: r.msg, title: clip(convs.get(r.conv)?.title ?? '', 50), at: r.at.toISOString().slice(0, 16), dur_s: sec(r.dur!),
      steps: r.steps, tool_errors: r.errs || undefined, repeated_cmds: r.repeats || undefined, agents: r.agents.length ? r.agents : undefined,
    })),
    conversations: convList.sort((a, b) => score(b) - score(a)).slice(0, 25).map(convOut),
    repeated_commands: [...repeatedCmds.entries()].sort((a, b) => b[1].times - a[1].times).slice(0, 10)
      .map(([cmd, r]) => ({ cmd: clip(cmd, 140), times: r.times, conversations: [...r.convs].slice(0, 3) })),
    frustration: frustration.slice(-15),
    learn_runs: learn.rows.map((r) => ({ kind: r.kind, status: r.status, n: r.n, input_chars: r.chars, error: r.err ? clip(r.err, 120) : undefined })),
    task_runs: taskRuns.rows.map((r) => ({ task: r.name, kind: r.kind, status: r.status, n: r.n, avg_s: r.avg_s, max_s: r.max_s, conversation_id: r.conv, error: r.err ?? undefined })),
  };
  return shrink(out);
}

/** Keep the answer small (~20 KB): fewer conversations and messages first, then shorter texts. */
function shrink(o: Record<string, unknown>): Record<string, unknown> {
  const size = () => Buffer.byteLength(JSON.stringify(o));
  const cut = (k: string, n: number) => { if (Array.isArray(o[k]) && (o[k] as unknown[]).length > n) o[k] = (o[k] as unknown[]).slice(0, n); };
  for (const [k, n] of [['conversations', 15], ['frustration', 10], ['repeated_commands', 6], ['conversations', 10], ['agents', 12], ['frustration', 5], ['task_runs', 10], ['learn_runs', 8], ['conversations', 5]] as const) {
    if (size() <= 20_000) break;
    cut(k, n);
  }
  if (size() > 20_000) o.truncated = true;
  return o;
}

// ── Proposals ───────────────────────────────────────────────
export type ProposalKind = 'prompt' | 'model' | 'description' | 'skill' | 'other';
export interface Proposal {
  id: string; agent_id: string | null; agent_name: string | null; agent_color: string | null; kind: ProposalKind; title: string; reason: string;
  evidence: string; before: string | null; after: string | null; status: string; created_at: string; applied_at: string | null;
  delegation_id: string | null; delegation_status: string | null;
}

const FIELD: Partial<Record<ProposalKind, 'prompt' | 'model' | 'description'>> = { prompt: 'prompt', model: 'model', description: 'description' };
const MODEL_RE = /^(inherit|opus|sonnet|haiku|claude-[a-z0-9.-]{3,60})$/;

function validValue(kind: ProposalKind, v: string): void {
  if (kind === 'model' && !MODEL_RE.test(v)) throw new AppError(400, 'model: inherit, haiku, sonnet, opus of een claude-modelnaam');
  if (kind === 'description' && (v.trim().length < 5 || v.length > 1000)) throw new AppError(400, 'description: 5 tot 1000 tekens');
  if (kind === 'prompt' && (v.trim().length < 5 || v.length > 20_000)) throw new AppError(400, 'prompt: 5 tot 20000 tekens');
}

/** Find an agent of this user by id, slug or name. */
async function findAgent(userId: string, ref: string): Promise<{ id: string; prompt: string; model: string; description: string } | null> {
  const r = await query<{ id: string; prompt: string; model: string; description: string }>(
    `SELECT id, prompt, model, description FROM agents WHERE user_id = $1
       AND (id::text = $2 OR slug = $2 OR lower(name) = lower($2) OR slug = 'agent-' || lower($2)) LIMIT 1`, [userId, ref.trim()]);
  return r.rows[0] ?? null;
}

export interface NewProposal {
  agent?: string | null; kind: ProposalKind; title: string; reason?: string; evidence?: string; after?: string | null;
  skill?: { name: string; description: string; body: string } | null;
}

export async function createProposal(userId: string, p: NewProposal): Promise<{ id: string; table: 'agent_proposals' | 'skill_proposals'; existing?: boolean }> {
  if (p.kind === 'skill') {
    const s = p.skill;
    if (!s?.name || !s.description || !s.body) throw new AppError(400, 'skill: geef skill {name, description, body}');
    const { isValidSkillName } = await import('./userSkills');
    const { hasSecret } = await import('./learning');
    if (!isValidSkillName(s.name)) throw new AppError(400, 'skill.name: kleine letters, cijfers en streepjes');
    if (hasSecret(s.body)) throw new AppError(400, 'skill.body bevat iets dat op een geheim lijkt');
    const dup = await query<{ id: string }>(`SELECT id FROM skill_proposals WHERE user_id = $1 AND name = $2 AND status = 'open'`, [userId, s.name]);
    if (dup.rows[0]) return { id: dup.rows[0].id, table: 'skill_proposals', existing: true };
    const r = await query<{ id: string }>(
      `INSERT INTO skill_proposals (user_id, name, description, body, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, s.name, s.description.slice(0, 1000), s.body.slice(0, 20_000), clip(`Coach: ${p.title}. ${p.reason ?? ''}`.trim(), 500)]);
    return { id: r.rows[0].id, table: 'skill_proposals' };
  }
  const field = FIELD[p.kind];
  let agentId: string | null = null, before: string | null = null;
  if (p.agent) {
    const a = await findAgent(userId, p.agent);
    if (!a) throw new AppError(404, `Agent "${p.agent}" niet gevonden`);
    agentId = a.id;
    if (field) before = a[field];
  }
  if (field) {
    if (!agentId) throw new AppError(400, `${p.kind}: geef agent (naam, slug of id)`);
    if (p.after == null) throw new AppError(400, `${p.kind}: geef after (de volledige nieuwe waarde)`);
    validValue(p.kind, p.after);
    if (p.after === before) throw new AppError(400, 'after is gelijk aan de huidige waarde');
  }
  const dup = await query<{ id: string }>(
    `SELECT id FROM agent_proposals WHERE user_id = $1 AND status = 'open' AND kind = $2 AND agent_id IS NOT DISTINCT FROM $3
       AND (after IS NOT DISTINCT FROM $4 OR (after IS NULL AND title = $5)) LIMIT 1`, [userId, p.kind, agentId, p.after ?? null, p.title]);
  if (dup.rows[0]) return { id: dup.rows[0].id, table: 'agent_proposals', existing: true };
  const r = await query<{ id: string }>(
    `INSERT INTO agent_proposals (user_id, agent_id, kind, title, reason, evidence, before, after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [userId, agentId, p.kind, p.title.slice(0, 200), (p.reason ?? '').slice(0, 2000), (p.evidence ?? '').slice(0, 4000), before, p.after ?? null]);
  return { id: r.rows[0].id, table: 'agent_proposals' };
}

export async function listProposals(userId: string, opts: { status?: string | null; limit?: number } = {}): Promise<Proposal[]> {
  return (await query<Proposal>(
    `SELECT p.id, p.agent_id, a.name AS agent_name, a.color AS agent_color, p.kind, p.title, p.reason, p.evidence, p.before, p.after, p.status, p.created_at, p.applied_at,
       p.delegation_id, d.status AS delegation_status
     FROM agent_proposals p LEFT JOIN agents a ON a.id = p.agent_id LEFT JOIN agent_delegations d ON d.id = p.delegation_id
     WHERE p.user_id = $1 AND ($2::text IS NULL OR p.status = $2) AND (p.status IN ('open', 'applied') OR p.created_at > now() - interval '30 days')
     ORDER BY (p.status = 'open') DESC, p.created_at DESC LIMIT $3`, [userId, opts.status ?? null, Math.min(opts.limit ?? 50, 100)])).rows;
}

async function getOwn(userId: string, id: string) {
  const p = (await query<{ id: string; agent_id: string | null; kind: ProposalKind; before: string | null; after: string | null; status: string }>(
    'SELECT id, agent_id, kind, before, after, status FROM agent_proposals WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!p) throw new AppError(404, 'Voorstel niet gevonden');
  return p;
}

/** Is this id a skill proposal (skill_proposals) instead of an agent proposal? */
async function isSkillProposal(userId: string, id: string): Promise<boolean> {
  if ((await query('SELECT 1 FROM agent_proposals WHERE id = $1 AND user_id = $2', [id, userId])).rows[0]) return false;
  return !!(await query('SELECT 1 FROM skill_proposals WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
}

export interface ApplyResult { status: 'applied' | 'delegated'; delegation_id?: string; note?: string }

/**
 * Apply: change the agent and keep what it was at this moment, so revert puts exactly that back.
 * Skill proposals (skill_proposals) are approved right away. Kind 'other' cannot be applied by itself:
 * it goes to Builder as a delegation and becomes 'applied' when that delegation is done.
 */
export async function applyProposal(userId: string, id: string): Promise<ApplyResult> {
  if (await isSkillProposal(userId, id)) {
    const name = await approveSkillProposal(userId, id).catch((e) => { throw new AppError(400, (e as Error).message); });
    return { status: 'applied', note: `skill ${name} geinstalleerd` };
  }
  const p = await getOwn(userId, id);
  if (p.status !== 'open' && p.status !== 'reverted') throw new AppError(400, 'Dit voorstel is al verwerkt');
  const field = FIELD[p.kind];
  if (field) {
    if (!p.agent_id) throw new AppError(400, 'De agent bestaat niet meer');
    if (p.after == null) throw new AppError(400, 'Voorstel zonder nieuwe waarde');
    validValue(p.kind, p.after);
    const cur = (await query<Record<string, string>>(`SELECT ${field} AS v FROM agents WHERE id = $1 AND user_id = $2`, [p.agent_id, userId])).rows[0];
    if (!cur) throw new AppError(400, 'De agent bestaat niet meer');
    await query(`UPDATE agents SET ${field} = $1, updated_at = now() WHERE id = $2 AND user_id = $3`, [p.after, p.agent_id, userId]);
    await query(`UPDATE agent_proposals SET status = 'applied', applied_at = now(), before = $2 WHERE id = $1`, [id, cur.v]);
    return { status: 'applied' };
  }
  // other: a build assignment for Builder
  const full = (await query<{ title: string; reason: string; evidence: string; after: string | null; delegation_id: string | null; ds: string | null; agent: string | null }>(
    `SELECT p.title, p.reason, p.evidence, p.after, p.delegation_id, d.status AS ds, a.name AS agent
       FROM agent_proposals p LEFT JOIN agent_delegations d ON d.id = p.delegation_id LEFT JOIN agents a ON a.id = p.agent_id WHERE p.id = $1`, [id])).rows[0];
  if (full.delegation_id && full.ds && full.ds !== 'failed') throw new AppError(409, `Builder werkt hier al aan (delegatie ${full.delegation_id}, status ${full.ds})`);
  const { createDelegation } = await import('./delegations');
  const prompt = [
    'Dit is een verbetervoorstel van Coach (prestaties van het agentteam) dat niet automatisch is toe te passen. Voer het uit.',
    `Titel: ${full.title}`,
    full.agent ? `Betreft agent: ${full.agent}` : '',
    full.reason ? `Reden: ${full.reason}` : '',
    full.evidence ? `Onderbouwing: ${full.evidence}` : '',
    full.after ? `Voorgestelde uitwerking:\n${full.after}` : '',
    'Werk volgens je gewone regels (backup, bouwen, testen, uitrol, commit en push). Sluit af met kort wat je deed en wat open staat; Coach markeert het voorstel pas als toegepast als jij klaar bent.',
  ].filter(Boolean).join('\n');
  const d = await createDelegation(userId, { agent: 'Builder', task: `Coach-voorstel: ${full.title}`, prompt }, null);
  await query('UPDATE agent_proposals SET delegation_id = $2 WHERE id = $1', [id, d.id]);
  return { status: 'delegated', delegation_id: d.id, note: 'Aan Builder gegeven; het voorstel wordt applied zodra die delegatie klaar is' };
}

export async function rejectProposal(userId: string, id: string): Promise<void> {
  if (await isSkillProposal(userId, id)) {
    if (!await rejectSkillProposal(userId, id)) throw new AppError(400, 'Alleen een open voorstel kan worden afgewezen');
    return;
  }
  const p = await getOwn(userId, id);
  if (p.status !== 'open') throw new AppError(400, 'Alleen een open voorstel kan worden afgewezen');
  await query(`UPDATE agent_proposals SET status = 'rejected' WHERE id = $1`, [id]);
}

export async function revertProposal(userId: string, id: string): Promise<void> {
  if (await isSkillProposal(userId, id)) throw new AppError(400, 'Een geinstalleerde skill draai je niet hier terug; verwijder hem onder Skills');
  const p = await getOwn(userId, id);
  if (p.status !== 'applied') throw new AppError(400, 'Alleen een toegepast voorstel kan worden teruggedraaid');
  const field = FIELD[p.kind];
  if (field) {
    if (!p.agent_id) throw new AppError(400, 'De agent bestaat niet meer');
    if (p.before == null) throw new AppError(400, 'Geen oude waarde bewaard');
    await query(`UPDATE agents SET ${field} = $1, updated_at = now() WHERE id = $2 AND user_id = $3`, [p.before, p.agent_id, userId]);
  }
  await query(`UPDATE agent_proposals SET status = 'reverted' WHERE id = $1`, [id]);
}
