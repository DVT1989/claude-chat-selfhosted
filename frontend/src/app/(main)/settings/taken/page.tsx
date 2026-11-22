'use client';

import ClaudeLogo from '@/components/ClaudeLogo';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { AgentAvatar, setAgentsCache } from '@/components/chat/AgentBubble';
import TaskWizard, { Switch, fmtWhen } from '@/components/tasks/TaskWizard';
import { agentsApi, tasksApi, type AgentDef, type TaskDef, type TaskStatus, type TaskSuggestion } from '@/lib/api';

const STATUS: Record<TaskStatus, { label: string; cls: string }> = {
  bezig: { label: 'Bezig', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  wachtrij: { label: 'In de wachtrij', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  gelukt: { label: 'Gelukt', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  mislukt: { label: 'Mislukt', cls: 'text-red-400 bg-red-500/10 border-red-500/30' },
  opgeschoven: { label: 'Opgeschoven', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
  overgeslagen: { label: 'Overgeslagen', cls: 'text-(--muted) bg-(--border)/40 border-(--border)' },
};

const I = {
  play: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M7 4.5v15l12-7.5Z" /></svg>,
  edit: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>,
  chat: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></svg>,
  trash: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>,
  spark: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8Z" /><path d="M19 15v4M21 17h-4" /></svg>,
};

function Executor({ agent }: { agent: AgentDef | null | undefined }) {
  if (agent) return <AgentAvatar name={agent.name} avatar={agent.avatar} color={agent.color} className="w-10 h-10 text-sm" />;
  return (
    <span className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: 'color-mix(in srgb, var(--claude) 15%, var(--g-bg-base))' }}>
      <ClaudeLogo className="w-5 h-5" />
    </span>
  );
}

function TaskRow({ t, agent, index, onChange, onEdit }: {
  t: TaskDef; agent: AgentDef | null | undefined; index: number;
  onChange: (p: Promise<{ tasks: TaskDef[]; suggestions: TaskSuggestion[] }>, note?: (r: unknown) => string | null) => Promise<void>;
  onEdit: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = t.last_status ? STATUS[t.last_status] : null;
  const running = t.last_status === 'bezig' || t.last_status === 'wachtrij';
  const act = async (p: Promise<{ tasks: TaskDef[]; suggestions: TaskSuggestion[] }>, note?: (r: unknown) => string | null) => {
    setBusy(true);
    try { await onChange(p, note); } finally { setBusy(false); }
  };

  return (
    // the row folds away on delete
    <div className={clsx('ll-fold', gone && 'is-shut')}>
      <div>
        <div style={{ '--i': Math.min(index, 10) } as React.CSSProperties}
          className={clsx('wa-row-in tw-row rounded-card border border-(--border) p-4 space-y-3', !t.enabled && 'is-off')}
          >
          <div className="flex items-start gap-3">
            <Executor agent={agent} />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium text-(--text)">{t.name}</span>
                <span className="text-xs text-(--muted)">{agent ? agent.name : 'Claude'}</span>
              </div>
              <p className="text-xs text-(--muted) mt-0.5">
                {t.schedule_text}
                {t.enabled && t.next_run_at ? <> · volgende {fmtWhen(t.next_run_at)}</> : !t.enabled ? <> · uit</> : null}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 pt-0.5">
              <span className="text-xs text-(--muted) w-6 text-right" aria-hidden>{t.enabled ? 'Aan' : 'Uit'}</span>
              <Switch on={t.enabled} label={`Taak ${t.enabled ? 'staat aan' : 'staat uit'}`} disabled={busy}
                onChange={(v) => void act(tasksApi.update(t.id, { enabled: v }))} />
            </div>
          </div>

          {/* last result: crossfades when the status changes */}
          {status && (
            <div key={`${t.last_status}-${t.last_run_at}`} className="tw-fade flex items-start gap-2 pl-[52px]">
              <span className={clsx('inline-flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded-full border text-[11px] font-medium', status.cls)}>
                {running && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
                {status.label}
              </span>
              <p className="text-xs text-(--text) leading-relaxed min-w-0">
                {t.last_summary && !running ? t.last_summary : running ? 'Claude is ermee bezig.' : ''}
                {t.last_run_at && <span className="text-(--muted)"> · {fmtWhen(t.last_run_at)}</span>}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1 pl-[52px] -ml-2">
            <label className="flex items-center gap-2 text-xs text-(--muted) mr-auto pl-2 basis-full sm:basis-auto mb-1 sm:mb-0">
              <Switch on={t.autonomous} label="Zelf uitvoeren: voert uit zonder jouw goedkeuring" disabled={busy}
                onChange={(v) => void act(tasksApi.update(t.id, { autonomous: v }))} />
              <span className="leading-tight">
                <span className="text-(--text)">Zelf uitvoeren</span>
                <span className="block">voert uit zonder jouw goedkeuring</span>
              </span>
            </label>
            <button type="button" className="icon-btn" title="Nu uitvoeren" aria-label="Nu uitvoeren" disabled={busy || running}
              onClick={() => void act(tasksApi.run(t.id), (r) => (r as { result?: { message?: string } }).result?.message ?? null)}>{I.play}</button>
            <button type="button" className="icon-btn" title="Bewerken" aria-label="Bewerken" onClick={onEdit}>{I.edit}</button>
            {t.conversation_id ? (
              <Link href={`/chat/${t.conversation_id}`} className="icon-btn" title="Gesprek openen" aria-label="Gesprek openen">{I.chat}</Link>
            ) : (
              <span className="icon-btn opacity-40" title="Nog geen gesprek: de taak heeft nog niet gedraaid">{I.chat}</span>
            )}
            {confirm ? (
              <span className="pop-in inline-flex items-center gap-1 pl-1">
                <span className="text-xs text-(--muted)">Verwijderen?</span>
                <button type="button" className="px-2 py-1 rounded-md text-xs font-medium text-white bg-red-500/90 hover:bg-red-500"
                  onClick={() => { setGone(true); setTimeout(() => void act(tasksApi.remove(t.id)), 260); }}>Ja</button>
                <button type="button" className="px-2 py-1 rounded-md text-xs text-(--muted) hover:text-(--text)" onClick={() => setConfirm(false)}>Nee</button>
              </span>
            ) : (
              <button type="button" className="icon-btn is-danger" title="Verwijderen" aria-label="Verwijderen" onClick={() => setConfirm(true)}>{I.trash}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Automatic tasks: a prompt on a schedule, in its own conversation, by Claude or one of the agents. */
export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskDef[] | null>(null);
  const [suggestions, setSuggestions] = useState<TaskSuggestion[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [wizard, setWizard] = useState<{ mode: 'new' } | { mode: 'edit'; task: TaskDef } | { mode: 'suggest'; s: TaskSuggestion } | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const apply = (r: { tasks: TaskDef[]; suggestions: TaskSuggestion[] }) => { setTasks(r.tasks); setSuggestions(r.suggestions); };
  const load = useCallback(() => tasksApi.list().then(apply).catch((e) => setErr((e as Error).message)), []);

  useEffect(() => {
    void load();
    agentsApi.list().then((r) => { setAgents(r.agents); setAgentsCache(r.agents); }).catch(() => {});
  }, [load]);

  // while a task runs, follow its status
  const anyRunning = (tasks ?? []).some((t) => t.last_status === 'bezig' || t.last_status === 'wachtrij');
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [anyRunning, load]);

  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(''), 5000); return () => clearTimeout(id); }, [note]);

  async function change(p: Promise<{ tasks: TaskDef[]; suggestions: TaskSuggestion[] }>, msg?: (r: unknown) => string | null) {
    setErr('');
    try { const r = await p; apply(r); const m = msg?.(r); if (m) setNote(m); } catch (e) { setErr((e as Error).message); }
  }

  const agentOf = (id: string | null) => (id ? agents.find((a) => a.id === id) ?? null : null);
  const editingId = wizard?.mode === 'edit' ? wizard.task.id : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px]">
          <h1 className="text-xl font-semibold text-(--text)">Taken</h1>
          <p className="text-sm text-(--muted)">Opdrachten die Claude of een agent op vaste momenten uitvoert, elk in een eigen gesprek.</p>
        </div>
        {!wizard && (
          <button onClick={() => setWizard({ mode: 'new' })} className="pop-in px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium">Nieuwe taak</button>
        )}
      </div>

      {note && <p role="status" className="text-sm text-(--text) rounded-lg border border-(--border) px-3 py-2" style={{ background: 'color-mix(in srgb, var(--g-bg-base) 80%, transparent)' }}>{note}</p>}
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}

      {/* recurring work at fixed moments, found by the learning loop */}
      {!wizard && suggestions.length > 0 && (
        <div className="space-y-2">
          {suggestions.map((s, i) => (
            <div key={s.key} style={{ '--i': i } as React.CSSProperties}
              className="wa-row-in rounded-xl border border-dashed border-(--accent)/50 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
              >
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 " style={{ background: 'color-mix(in srgb, #D97757 14%, transparent)' }}><ClaudeLogo className="w-[18px] h-[18px]" /></span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-(--text)"><span className="font-medium">Automatiseren?</span> {s.summary}</p>
                  {/* the reason comes with its own full stop; strip it so there is no ".;" */}
                  <p className="text-xs text-(--muted) mt-0.5">{s.reason.replace(/[.;\s]+$/, '')}. Voorstel: {s.schedule_text.toLowerCase()}.</p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 shrink-0 pl-12 sm:pl-0">
                <button type="button" onClick={() => void change(tasksApi.dismissSuggestion(s.key))} className="px-3 py-1.5 rounded-lg text-sm text-(--muted) hover:text-(--text)">Nee</button>
                <button type="button" onClick={() => setWizard({ mode: 'suggest', s })} className="px-3 py-1.5 rounded-control bg-(--accent-strong) text-white text-sm font-medium">Automatiseren</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {wizard && wizard.mode !== 'edit' && (
        <TaskWizard agents={agents}
          preset={wizard.mode === 'suggest' ? { text: wizard.s.summary, cron: wizard.s.cron, schedule_text: wizard.s.schedule_text, source_pattern: wizard.s.key } : null}
          onCancel={() => { setWizard(null); void load(); }}
          onSaved={() => { setWizard(null); void load(); agentsApi.list().then((r) => { setAgents(r.agents); setAgentsCache(r.agents); }).catch(() => {}); }} />
      )}

      {tasks && !tasks.length && !wizard && (
        <div className="tw-fade rounded-xl border border-dashed border-(--border) px-6 py-10 text-center space-y-2">
          <p className="text-sm text-(--text)">Nog geen taken.</p>
          <p className="text-xs text-(--muted)">Bijvoorbeeld: elke werkdag om 8 uur een mailoverzicht, of elke vrijdag je uren controleren. Je kunt het ook in een chat vragen.</p>
        </div>
      )}

      <div className="space-y-3">
        {(tasks ?? []).map((t, i) => editingId === t.id ? (
          <TaskWizard key={t.id} agents={agents} initial={t} onCancel={() => setWizard(null)} onSaved={() => { setWizard(null); void load(); }} />
        ) : (
          <TaskRow key={t.id} t={t} index={i} agent={agentOf(t.agent_id)} onChange={change} onEdit={() => setWizard({ mode: 'edit', task: t })} />
        ))}
      </div>

    </div>
  );
}
