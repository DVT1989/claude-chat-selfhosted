'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useFocusParam } from '@/components/useFocusParam';

interface LogItem {
  id: string; kind: 'memory' | 'lesson'; action: 'add' | 'update' | 'archive' | 'merge'; target_id: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; note: string | null;
  created_at: string; reverted_at: string | null; conversation_id: string | null; conversation_title: string | null;
}
interface Proposal {
  id: string; name: string; description: string; body: string; script_name: string | null; script_lang: string | null;
  script_content: string | null; reason: string; status: 'open' | 'goedgekeurd' | 'afgewezen'; installed_name: string | null;
  created_at: string; seen: number | null;
}
interface Ctx {
  created_at: string; claude_md_tokens: number; memory_tokens: number; lessons_tokens: number; global_md_tokens: number;
  skills_tokens: number; skills_count: number; agents_tokens: number; total_tokens: number; budget: number; trimmed: string[];
}
interface Overview {
  settings: { learn: boolean; budgetTokens: number | null };
  budget: { tokens: number; default: number; min: number; max: number };
  log: LogItem[]; proposals: Proposal[];
  patterns: Array<{ key: string; summary: string; count: number; last_seen: string }>;
  runs: Array<{ kind: string; status: string; saved: number; skipped: number; error: string | null; started_at: string }>;
  context: { recent: Ctx[]; week: { total: number | null; core: number | null; runs: number; trimmed_runs: number } };
  busy: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/assistant${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
  return d as T;
}

const fmtDate = (s: string) => new Date(s).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const n = (x: number | null | undefined) => (x ?? 0).toLocaleString('nl-NL');
const card = 'rounded-xl border border-(--border) bg-(--input)';
const btn = 'px-3 py-1.5 rounded-lg border border-(--border) text-sm text-(--text) hover:border-(--muted) disabled:opacity-50 transition-colors';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={clsx('w-4 h-4 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-90')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

const ACTION: Record<string, string> = { add: 'nieuw', update: 'bijgewerkt', archive: 'gearchiveerd', merge: 'samengevoegd' };

function LogRow({ e, onReverted }: { e: LogItem; onReverted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const text = String(e.after?.content ?? e.after?.lesson ?? '');
  const prev = e.action === 'update' ? String(e.before?.content ?? '') : e.action === 'merge' ? ((e.before?.texts as string[] | undefined) ?? []).join(' / ') : '';
  const topic = String(e.after?.topic ?? '');
  async function revert() {
    setBusy(true); setErr('');
    try { await api(`/log/${e.id}/revert`, { method: 'POST' }); onReverted(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className={clsx('ll-done flex items-start gap-3 px-4 py-3', e.reverted_at && 'is-off')}>
      <span className={clsx('mt-0.5 shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium',
        e.kind === 'lesson' ? 'text-amber-500 bg-[color-mix(in_srgb,#f59e0b_14%,var(--g-bg-base))]' : 'text-pink-500 bg-[color-mix(in_srgb,#ec4899_14%,var(--g-bg-base))]')}>
        {e.kind === 'lesson' ? 'Les' : 'Geheugen'}
      </span>
      <div className="flex-1 min-w-0">
        <p className={clsx('text-sm text-(--text) whitespace-pre-wrap break-words', e.reverted_at && 'line-through decoration-(--muted)')}>{text}</p>
        {prev && <p className="text-xs text-(--muted) mt-1 break-words"><span className="opacity-70">Was: </span>{prev}</p>}
        <p className="text-xs text-(--muted) mt-1">
          {ACTION[e.action] ?? e.action}{topic && <> · {topic}</>}{e.note && <> · {e.note}</>} · {fmtDate(e.created_at)}
          {e.conversation_id && <> · <Link href={`/chat/${e.conversation_id}`} className="hover:text-(--text) underline-offset-2 hover:underline">{e.conversation_title || 'gesprek'}</Link></>}
        </p>
        {err && <p className="text-xs text-red-400 mt-1">{err}</p>}
      </div>
      {e.reverted_at
        ? <span className="text-xs text-(--muted) shrink-0">Teruggedraaid</span>
        : <button onClick={() => void revert()} disabled={busy} className="text-xs text-(--muted) hover:text-(--text) shrink-0 disabled:opacity-50">Terugdraaien</button>}
    </div>
  );
}

function ProposalCard({ p, onDone }: { p: Proposal; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState('');
  async function decide(what: 'approve' | 'reject') {
    setBusy(true); setErr('');
    try {
      const d = await api<{ name?: string }>(`/proposals/${p.id}/${what}`, { method: 'POST' });
      setGone(true);
      setTimeout(() => onDone(what === 'approve' ? `Skill ${d.name} staat klaar en werkt vanaf je volgende bericht.` : 'Voorstel afgewezen.'), 320);
    } catch (x) { setErr((x as Error).message); setBusy(false); }
  }
  const decided = p.status !== 'open';
  return (
    <div className={clsx('ll-fold', gone && 'is-shut')}>
      <div>
        <div className={clsx(card, 'p-4 space-y-3', decided && 'opacity-60')}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-1 min-w-[200px]">
              <p className="text-sm font-medium text-(--text)">{p.name}
                {p.script_name && <span className="ml-2 px-1.5 py-0.5 rounded text-[11px] text-(--muted) border border-(--border)">met script</span>}
              </p>
              <p className="text-sm text-(--muted) mt-0.5">{p.description}</p>
              {p.reason && <p className="text-xs text-(--muted) mt-1">{p.reason}{p.seen ? ` · ${p.seen}x gezien` : ''}</p>}
            </div>
            {decided ? (
              <span className="text-xs text-(--muted)">{p.status === 'goedgekeurd' ? `Goedgekeurd als ${p.installed_name}` : 'Afgewezen'}</span>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => void decide('reject')} disabled={busy} className={btn}>Afwijzen</button>
                <button onClick={() => void decide('approve')} disabled={busy} className="px-3 py-1.5 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">Goedkeuren</button>
              </div>
            )}
          </div>
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-xs text-(--muted) hover:text-(--text)" aria-expanded={open}>
            <Chevron open={open} /> {open ? 'Verberg inhoud' : 'Bekijk SKILL.md' + (p.script_name ? ' en script' : '')}
          </button>
          <div className={clsx('ll-fold', !open && 'is-shut')}>
            <div className="space-y-2">
              <pre className="text-xs text-(--text) whitespace-pre-wrap break-words rounded-lg border border-(--border) p-3 max-h-80 overflow-auto bg-[color-mix(in_srgb,var(--text)_4%,var(--g-bg-base))]">{p.body}</pre>
              {p.script_content && (
                <>
                  <p className="text-xs text-(--muted)">scripts/{p.script_name}</p>
                  <pre className="text-xs text-(--text) whitespace-pre overflow-auto rounded-lg border border-(--border) p-3 max-h-80 bg-[color-mix(in_srgb,var(--text)_4%,var(--g-bg-base))]">{p.script_content}</pre>
                </>
              )}
            </div>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
        </div>
      </div>
    </div>
  );
}

/** One stacked bar: what a run's context costs, against the budget. Every part also has a text label. */
function BudgetBar({ c, budget }: { c: Ctx; budget: number }) {
  const rest = Math.max(0, c.claude_md_tokens - c.memory_tokens - c.lessons_tokens);
  const parts = [
    { label: 'CLAUDE.md', v: rest, color: '#64748b' },
    { label: 'Geheugen', v: c.memory_tokens, color: '#ec4899' },
    { label: 'Lessen', v: c.lessons_tokens, color: '#f59e0b' },
    { label: 'Globale CLAUDE.md', v: c.global_md_tokens, color: '#94a3b8' },
    { label: `Skills (${c.skills_count})`, v: c.skills_tokens, color: '#8b5cf6' },
    { label: 'Agents', v: c.agents_tokens, color: '#6366f1' },
  ].filter((x) => x.v > 0);
  const core = c.claude_md_tokens + c.global_md_tokens;
  const scale = Math.max(c.total_tokens, budget) * 1.05;
  return (
    <div className="space-y-3">
      <div className="relative h-3 rounded-full overflow-hidden flex gap-[2px] bg-[color-mix(in_srgb,var(--text)_8%,var(--g-bg-base))]">
        {parts.map((x) => <span key={x.label} className="ll-seg h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(x.v / scale) * 100}%`, background: x.color }} title={`${x.label}: ${n(x.v)} tokens`} />)}
        <span aria-hidden className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-(--text) opacity-70" style={{ left: `${(budget / scale) * 100}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((x) => (
          <span key={x.label} className="flex items-center gap-1.5 text-xs text-(--muted)">
            <span className="w-2 h-2 rounded-full" style={{ background: x.color }} />{x.label} <span className="text-(--text) tabular-nums">{n(x.v)}</span>
          </span>
        ))}
      </div>
      <p className="text-xs text-(--muted)">
        Kern (CLAUDE.md-bestanden) <span className={clsx('tabular-nums', core > budget ? 'text-red-400' : 'text-(--text)')}>{n(core)}</span> van {n(budget)} tokens; met skills en agents {n(c.total_tokens)}. Streep = budget. Schatting: tekens / 3,5.
        {c.trimmed?.length > 0 && <> Ingekort: {c.trimmed.join('; ')}.</>}
      </p>
    </div>
  );
}

/** The learning loop: what it saved (with undo), skill proposals and the token budget per run. */
export default function LeerlusPage() {
  const [d, setD] = useState<Overview | null>(null);
  useFocusParam(!!d);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [budget, setBudget] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await api<Overview>('');
      setD(o);
      setBudget((b) => b || String(o.budget.tokens));
      return o;
    } catch (e) { setErr((e as Error).message); return null; }
  }, []);
  useEffect(() => { void load(); return () => { if (poll.current) clearInterval(poll.current); }; }, [load]);

  /** After "now": follow the run for up to two minutes. */
  function follow() {
    if (poll.current) clearInterval(poll.current);
    let left = 24;
    poll.current = setInterval(async () => {
      const o = await load();
      if (--left <= 0 || (o && !o.busy && left < 22)) { clearInterval(poll.current!); poll.current = null; }
    }, 5000);
  }

  async function patch(body: Record<string, unknown>) {
    setSaving(true); setErr('');
    try { await api('/settings', { method: 'PATCH', body: JSON.stringify(body) }); await load(); }
    catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  }
  async function run(path: string, msg: string) {
    setErr(''); setNote('');
    try {
      const r = await api<{ started: boolean; waiting?: string }>(path, { method: 'POST' });
      setNote(r.started ? msg : `Nu niet: ${r.waiting}.`);
      if (r.started) follow();
    } catch (e) { setErr((e as Error).message); }
  }

  const open = d?.proposals.filter((p) => p.status === 'open') ?? [];
  const decided = d?.proposals.filter((p) => p.status !== 'open') ?? [];
  const week = d?.log.filter((e) => !e.reverted_at && Date.now() - new Date(e.created_at).getTime() < 7 * 864e5).length ?? 0;
  const last = d?.context.recent[0];
  const logShown = showAll ? d?.log ?? [] : (d?.log ?? []).slice(0, 15);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[240px]">
          <h1 className="text-xl font-semibold text-(--text)">Leerlus</h1>
          <p className="text-sm text-(--muted)">Na een afgerond gesprek leest Claude Haiku het gesprek terug en bewaart feiten en voorkeuren in je geheugen en technische lessen in de gedeelde kennis. Taken die vaker terugkomen worden een voorstel voor een skill. Alles hieronder kun je terugdraaien.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void run('/learn/run', 'De leerlus loopt; de resultaten verschijnen hieronder.')} disabled={!d || d.busy} className={btn}>Nu leren</button>
          <button onClick={() => void run('/cleanup/run', 'Opruimen loopt.')} disabled={!d || d.busy} className={btn}>Nu opruimen</button>
        </div>
      </div>

      {d && (
        <div className={clsx(card, 'flex items-center gap-3 px-4 py-3')}>
          <div className="flex-1">
            <p className="text-sm text-(--text)">Automatisch leren</p>
            <p className="text-xs text-(--muted)">{d.busy ? 'Bezig met een gesprek...' : 'Na 20 minuten stilte, of na 12 beurten. Alleen als er geen gesprek loopt en je abonnement ruimte heeft.'}</p>
          </div>
          <button role="switch" aria-checked={d.settings.learn} aria-label="Automatisch leren" disabled={saving}
            onClick={() => void patch({ learn: !d.settings.learn })} className="ll-switch" />
        </div>
      )}

      {note && <p className="text-sm text-(--text)" role="status">{note}</p>}
      {err && <p className="text-sm text-red-400" role="alert">{err}</p>}

      {d && (
        <div className="grid grid-cols-3 gap-3">
          {([['Opgeslagen deze week', n(week)], ['Open voorstellen', n(open.length)], ['Context per run (gem.)', d.context.week.total ? `${n(d.context.week.total)} t` : '-']] as const).map(([l, v], i) => (
            <div key={l} className={clsx(card, 'px-4 py-3 wa-row-in')} style={{ '--i': i } as React.CSSProperties}>
              <p className="text-2xl font-semibold text-(--text) tabular-nums">{v}</p>
              <p className="text-xs text-(--muted)">{l}</p>
            </div>
          ))}
        </div>
      )}

      {d && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-(--muted)">Skill-voorstellen</h2>
          {open.length === 0 && (
            <div className="rounded-xl border border-dashed border-(--border) px-6 py-6 text-center">
              <p className="text-sm text-(--muted)">Geen open voorstellen. Een taak die ongeveer drie keer terugkomt, wordt hier een voorstel.</p>
            </div>
          )}
          {open.map((p, i) => <div key={p.id} data-focus-id={`p-${p.id}`} className="wa-row-in" style={{ '--i': i } as React.CSSProperties}><ProposalCard p={p} onDone={(m) => { setNote(m); void load(); }} /></div>)}
          {decided.length > 0 && <div className="space-y-2">{decided.map((p) => <div key={p.id} data-focus-id={`p-${p.id}`}><ProposalCard p={p} onDone={() => void load()} /></div>)}</div>}
          {d.patterns.length > 0 && (
            <div className={clsx(card, 'px-4 py-3 space-y-2')}>
              <p className="text-xs text-(--muted)">Terugkerende taken (bij 3 keer volgt een voorstel)</p>
              {d.patterns.map((t, i) => (
                <div key={t.key} data-focus-id={`t-${t.key}`} className="flex items-center gap-3 wa-row-in" style={{ '--i': i } as React.CSSProperties}>
                  <span className="flex gap-0.5 shrink-0" aria-label={`${t.count} keer gezien`}>
                    {[0, 1, 2].map((k) => <span key={k} className={clsx('w-1.5 h-3 rounded-full', k < t.count ? 'bg-(--accent)' : 'bg-[color-mix(in_srgb,var(--text)_15%,var(--g-bg-base))]')} />)}
                  </span>
                  <p className="text-sm text-(--text) truncate flex-1" title={t.summary}>{t.key}</p>
                  <span className="text-xs text-(--muted) tabular-nums">{t.count}x</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {d && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-(--muted)">Tokenbudget per run</h2>
          <div className={clsx(card, 'p-4 space-y-4')}>
            {last ? <BudgetBar c={last} budget={d.budget.tokens} /> : <p className="text-sm text-(--muted)">Nog geen metingen: die komen bij je volgende bericht.</p>}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <label htmlFor="ll-budget" className="text-sm text-(--text)">Budget kern</label>
              <input id="ll-budget" type="number" inputMode="numeric" min={d.budget.min} max={d.budget.max} step={500} value={budget} onChange={(e) => setBudget(e.target.value)}
                className="w-28 bg-(--input) border border-(--border) rounded-lg px-3 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent) tabular-nums" />
              <span className="text-xs text-(--muted)">tokens</span>
              <button disabled={saving || !budget || Number(budget) === d.budget.tokens} onClick={() => void patch({ budgetTokens: Number(budget) })} className={btn}>Opslaan</button>
              {d.settings.budgetTokens !== null && <button disabled={saving} onClick={() => { setBudget(String(d.budget.default)); void patch({ budgetTokens: null }); }} className="text-xs text-(--muted) hover:text-(--text)">Standaard ({n(d.budget.default)})</button>}
            </div>
            <p className="text-xs text-(--muted)">Boven het budget worden eerst de geheugenfeiten ingekort, dan minder lessen en minder niet-vastgezette feiten meegestuurd. De rest blijft opzoekbaar. {d.context.week.runs > 0 && `Afgelopen week ${n(d.context.week.runs)} runs, ${n(d.context.week.trimmed_runs)} ingekort.`}</p>
          </div>
        </section>
      )}

      {d && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-(--muted)">Recent opgeslagen</h2>
          {d.log.length === 0 ? (
            <div className="rounded-xl border border-dashed border-(--border) px-6 py-6 text-center">
              <p className="text-sm text-(--muted)">Nog niets geleerd. Na je volgende afgeronde gesprek verschijnt hier wat er bewaard is.</p>
            </div>
          ) : (
            <div className={clsx(card, 'divide-y divide-(--border)')}>
              {logShown.map((e, i) => <div key={e.id} className="wa-row-in" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}><LogRow e={e} onReverted={() => void load()} /></div>)}
            </div>
          )}
          {d.log.length > 15 && <button onClick={() => setShowAll((s) => !s)} className="text-xs text-(--muted) hover:text-(--text)">{showAll ? 'Minder tonen' : `Alles tonen (${d.log.length})`}</button>}
          {d.runs.length > 0 && (
            <p className="text-xs text-(--muted)">
              Laatste run: {d.runs[0].kind}, {d.runs[0].status}, {fmtDate(d.runs[0].started_at)}
              {d.runs[0].status === 'ok' && ` (${d.runs[0].saved} opgeslagen, ${d.runs[0].skipped} overgeslagen)`}
              {d.runs[0].error && ` (${d.runs[0].error.slice(0, 140)})`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
