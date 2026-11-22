'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import ClaudeLogo from '@/components/ClaudeLogo';
import { AgentAvatar } from '@/components/chat/AgentBubble';
import { tasksApi, type AgentDef, type TaskAssist, type TaskDef, type TaskInput, type TaskRunResult } from '@/lib/api';
import FreqPicker, { EMPTY_FREQ, freqFrom, freqTo, type Freq } from './FreqPicker';

type Step = 'idea' | 'freq' | 'summary';
type Executor = { kind: 'claude' } | { kind: 'agent'; id: string } | { kind: 'new' };

const EXAMPLES = [
  'Zet elke werkdag om 8 uur een overzicht klaar van mijn ongelezen mail, met wat dringend is.',
  'Controleer elke vrijdag om 16:00 of mijn uren van deze week compleet zijn in FocusTrack.',
  'Kijk elke maandagochtend of er Windows-updates openstaan op mijn apparaten.',
];

const field = 'w-full px-3.5 py-2.5 rounded-control bg-(--input) border border-(--border) text-(--text) text-sm placeholder-(--muted) outline-none focus:border-(--accent) transition-colors';

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `vandaag ${time}`;
  if (diff === 1) return `morgen ${time}`;
  if (diff === -1) return `gisteren ${time}`;
  return `${d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function Stepper({ step, withFreq }: { step: Step; withFreq: boolean }) {
  const steps: Array<[Step, string]> = [['idea', 'Wat'], ...(withFreq ? [['freq', 'Wanneer'] as [Step, string]] : []), ['summary', 'Controleren']];
  const at = steps.findIndex(([s]) => s === step);
  return (
    <div className="flex items-center gap-2 w-full sm:w-auto pl-9 sm:pl-0">
      {steps.map(([s, label], i) => (
        <div key={s} className="flex items-center gap-2 min-w-0">
          <span className={clsx('w-6 h-6 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0 transition-all duration-300',
            i < at ? 'bg-(--accent-strong) text-white' : i === at ? 'border-2 border-(--accent) text-(--accent)' : 'border border-(--border) text-(--muted)')}>
            {i < at ? <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg> : i + 1}
          </span>
          <span className={clsx('text-xs hidden sm:inline', i === at ? 'text-(--text) font-medium' : 'text-(--muted)')}>{label}</span>
          {i < steps.length - 1 && <span className={clsx('w-5 sm:w-8 h-px transition-colors duration-300', i < at ? 'bg-(--accent)' : 'bg-(--border)')} />}
        </div>
      ))}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center tw-fade">
      <ClaudeLogo className="w-10 h-10 animate-[spin_6s_linear_infinite]" />
      <p className="text-sm text-(--text)">{text}</p>
      <span className="typing-dots"><i /><i /><i /></span>
    </div>
  );
}

/** The switch used on this page (same look as the Leerlus switch). */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className="ll-switch disabled:opacity-50" />;
}

/**
 * New task in plain language: Haiku proposes name, prompt, frequency and who should do it (an
 * existing agent, a new agent, or Claude itself). No frequency in the text: the picker asks for it.
 * Also the edit form for an existing task (starts at the summary). Saves only on Opslaan.
 */
export default function TaskWizard({ agents, initial, preset, onSaved, onCancel }: {
  agents: AgentDef[];
  /** edit an existing task */
  initial?: TaskDef | null;
  /** from a suggestion: text, a known schedule and the pattern it came from (runs the analysis at once) */
  preset?: { text: string; cron: string; schedule_text: string; source_pattern: string } | null;
  onSaved: (t: TaskDef) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>(initial ? 'summary' : 'idea');
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  const [text, setText] = useState(preset?.text ?? '');
  const [advice, setAdvice] = useState<TaskAssist | null>(null);
  const [askedFreq, setAskedFreq] = useState(false);
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [freq, setFreq] = useState<Freq>(initial ? (freqFrom(initial.cron, initial.run_at, initial.schedule_text) ?? EMPTY_FREQ) : EMPTY_FREQ);
  const [exec, setExec] = useState<Executor>(initial?.agent_id ? { kind: 'agent', id: initial.agent_id } : { kind: 'claude' });
  const [autonomous, setAutonomous] = useState(initial?.autonomous ?? false);
  const [showPrompt, setShowPrompt] = useState(!!initial);
  const [showAgentPrompt, setShowAgentPrompt] = useState(false);
  const [preview, setPreview] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<TaskDef | null>(initial ?? null);
  const [tried, setTried] = useState<TaskRunResult | null>(null);
  const started = useRef(false);

  const go = (s: Step, d: 'fwd' | 'back' = 'fwd') => { setDir(d); setStep(s); };
  const sched = freqTo(freq);

  // next run times for the summary (cheap: no model call)
  useEffect(() => {
    if (step !== 'summary' || !sched) { setPreview([]); return; }
    if (!sched.cron) { setPreview(sched.run_at ? [sched.run_at] : []); return; }
    const t = setTimeout(() => { tasksApi.preview(sched.cron!).then((r) => setPreview(r.next_runs)).catch(() => setPreview([])); }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, sched?.cron, sched?.run_at]);

  async function analyse(input = text) {
    setBusy('Claude bekijkt je taak…'); setError('');
    try {
      const a = await tasksApi.assist(input);
      setAdvice(a);
      setName(a.name); setPrompt(a.prompt);
      setExec(a.advice === 'bestaand' && a.agent_id ? { kind: 'agent', id: a.agent_id } : a.advice === 'nieuw' && a.new_agent.name ? { kind: 'new' } : { kind: 'claude' });
      const fromPreset = preset?.cron ? freqFrom(preset.cron, null, preset.schedule_text) : null;
      const fromText = a.has_schedule ? freqFrom(a.cron || null, a.run_at || null, a.schedule_text) : null;
      const f = fromPreset ?? fromText;
      if (f) { setFreq(f); setAskedFreq(false); go('summary'); } else { setAskedFreq(true); go('freq'); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  // a suggestion opens straight into the analysis
  useEffect(() => {
    if (preset && !started.current) { started.current = true; void analyse(preset.text); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function body(enabled: boolean): TaskInput | null {
    if (!sched) { setError('Kies wanneer de taak moet draaien'); return null; }
    if (!name.trim() || prompt.trim().length < 3) { setError('Geef de taak een naam en een opdracht'); return null; }
    return {
      name: name.trim(), prompt: prompt.trim(), ...sched, timezone: 'Europe/Amsterdam', enabled, autonomous,
      agent_id: exec.kind === 'agent' ? exec.id : null,
      ...(exec.kind === 'new' && advice ? { new_agent: advice.new_agent } : {}),
      ...(preset?.source_pattern && !saved ? { source_pattern: preset.source_pattern } : {}),
    };
  }

  /** Create or update; a new agent is made only once (after that it is a normal agent). */
  async function persist(enabled: boolean): Promise<TaskDef | null> {
    const b = body(enabled);
    if (!b) return null;
    if (saved) {
      const { new_agent: _n, source_pattern: _s, ...patch } = b;
      const r = await tasksApi.update(saved.id, exec.kind === 'new' ? { ...patch, agent_id: saved.agent_id } : patch);
      setSaved(r.task);
      return r.task;
    }
    const r = await tasksApi.create(b);
    setSaved(r.task);
    if (exec.kind === 'new' && r.task.agent_id) setExec({ kind: 'agent', id: r.task.agent_id });
    return r.task;
  }

  async function tryNow() {
    setBusy('De taak wordt gestart…'); setError(''); setTried(null);
    try {
      // a trial run needs the task (and its conversation); a new task stays off until Opslaan
      const t = await persist(saved ? saved.enabled : false);
      if (!t) return;
      const r = await tasksApi.run(t.id);
      setTried(r.result);
      setSaved(r.tasks.find((x) => x.id === t.id) ?? t);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  async function save() {
    setBusy('Opslaan…'); setError('');
    try {
      // a new task is switched on by Opslaan; an edited one keeps its state
      const t = await persist(initial ? initial.enabled : true);
      if (t) onSaved(t);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const chosenAgent = exec.kind === 'agent' ? agentOf(exec.id) : null;
  const newAgent = advice?.new_agent;

  return (
    <div className="rounded-card border border-(--border) overflow-hidden pop-in" style={{ background: 'color-mix(in srgb, var(--g-bg-base) 88%, transparent)' }}>
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-(--border)">
        <ClaudeLogo className="w-6 h-6" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-(--text)">{initial ? `${initial.name} bewerken` : 'Nieuwe taak'}</p>
          <p className="text-xs text-(--muted)">{initial ? 'Wijzigingen gelden vanaf de volgende run.' : 'Er wordt pas iets aangezet als jij op Opslaan drukt.'}</p>
        </div>
        {!initial && <Stepper step={step} withFreq={askedFreq} />}
      </div>

      <div className="p-5 space-y-4 overflow-hidden">
        {busy ? <Thinking text={busy} /> : (
          <div key={step} className={dir === 'fwd' ? 'tw-step-fwd' : 'tw-step-back'}>
            {step === 'idea' && (
              <div className="space-y-4">
                <label className="block space-y-2">
                  <span className="text-sm text-(--text)">Wat moet er automatisch gebeuren, en wanneer?</span>
                  <textarea autoFocus className={`${field} min-h-[120px] text-[15px] leading-relaxed`} value={text} onChange={(e) => setText(e.target.value)}
                    placeholder="Gewoon in je eigen woorden. Noem je een moment of frequentie, dan neemt Claude die over." />
                </label>
                {!text && (
                  <div className="space-y-2">
                    <p className="text-xs text-(--muted)">Of begin met een voorbeeld</p>
                    <div className="flex flex-col gap-2">
                      {EXAMPLES.map((ex, i) => (
                        <button key={ex} type="button" onClick={() => setText(ex)} style={{ '--i': i } as React.CSSProperties}
                          className="wa-row-in text-left text-sm text-(--muted) hover:text-(--text) rounded-lg border border-dashed border-(--border) hover:border-(--muted) px-3 py-2 transition-colors">{ex}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === 'freq' && (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-(--text)">Wanneer moet {name || 'de taak'} draaien?</p>
                  <p className="text-xs text-(--muted) mt-0.5">Er stond geen moment in je beschrijving.</p>
                </div>
                <FreqPicker value={freq} onChange={setFreq} />
              </div>
            )}

            {step === 'summary' && (
              <div className="space-y-4">
                {/* who does it: the agent advice */}
                {advice && (
                  <div className="rounded-xl px-4 py-3 border-l-4 border-(--accent)" style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}>
                    <p className="text-xs font-medium text-(--accent) mb-1">
                      {advice.advice === 'bestaand' ? 'Advies: een bestaande agent' : advice.advice === 'nieuw' ? 'Advies: een nieuwe agent' : 'Advies: een losse taak'}
                    </p>
                    <p className="text-sm text-(--text)">{advice.advice_reason}</p>
                  </div>
                )}

                {exec.kind === 'new' && newAgent && (
                  <div className="rounded-xl border border-(--border) overflow-hidden tw-fade">
                    <div className="flex items-center gap-3 p-4">
                      <AgentAvatar name={newAgent.name} color={newAgent.color} className="w-11 h-11 text-base" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold" style={{ color: newAgent.color }}>{newAgent.name} <span className="text-xs font-normal text-(--muted)">nieuwe agent</span></p>
                        <p className="text-xs text-(--muted)">{newAgent.description}</p>
                      </div>
                    </div>
                    <div className="border-t border-(--border) px-4 py-2.5">
                      <button type="button" onClick={() => setShowAgentPrompt((o) => !o)} className="flex items-center gap-2 text-xs text-(--muted) hover:text-(--text)">
                        <svg className={clsx('w-3 h-3 transition-transform', !showAgentPrompt && '-rotate-90')} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        Instructies van {newAgent.name}
                      </button>
                      <div className={clsx('ll-fold', !showAgentPrompt && 'is-shut')}>
                        <div><pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-(--text) font-mono bg-(--well) rounded-lg p-3">{newAgent.prompt}</pre></div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-(--border) divide-y divide-(--border)">
                  <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="text-xs text-(--muted) w-28 shrink-0">Naam</span>
                    <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Bijv. Mailoverzicht ochtend" />
                  </div>
                  <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="text-xs text-(--muted) w-28 shrink-0">Uitvoerder</span>
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {exec.kind === 'agent' && chosenAgent ? <AgentAvatar name={chosenAgent.name} avatar={chosenAgent.avatar} color={chosenAgent.color} className="w-7 h-7 text-[11px]" />
                        : exec.kind === 'new' && newAgent ? <AgentAvatar name={newAgent.name} color={newAgent.color} className="w-7 h-7 text-[11px]" />
                        : <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: 'color-mix(in srgb, #D97757 15%, transparent)' }}><ClaudeLogo className="w-4 h-4" /></span>}
                      <select className={field} value={exec.kind === 'agent' ? exec.id : exec.kind}
                        onChange={(e) => { const v = e.target.value; setExec(v === 'claude' ? { kind: 'claude' } : v === 'new' ? { kind: 'new' } : { kind: 'agent', id: v }); }}>
                        <option value="claude">Claude zelf</option>
                        {!saved && newAgent?.name && <option value="new">{newAgent.name} (nieuwe agent)</option>}
                        {agents.filter((a) => a.is_active || (exec.kind === 'agent' && exec.id === a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="px-4 py-3 flex flex-col sm:flex-row gap-2">
                    <span className="text-xs text-(--muted) w-28 shrink-0 sm:pt-1.5">Wanneer</span>
                    <div className="flex-1 min-w-0 space-y-2">
                      <FreqPicker value={freq} onChange={setFreq} />
                      {preview.length > 0 && <p className="text-xs text-(--muted) tw-fade">Volgende keer: {preview.map(fmtWhen).join(', ')}</p>}
                    </div>
                  </div>
                  <div className="px-4 py-3">
                    <button type="button" onClick={() => setShowPrompt((o) => !o)} className="flex items-center gap-2 text-xs text-(--muted) hover:text-(--text)">
                      <svg className={clsx('w-3 h-3 transition-transform', !showPrompt && '-rotate-90')} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      Opdracht {showPrompt ? '' : `(${prompt.split('\n').length} regels)`}
                    </button>
                    <div className={clsx('ll-fold', !showPrompt && 'is-shut')}>
                      <div><textarea className={`${field} mt-2 font-mono text-[13px]`} rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></div>
                    </div>
                  </div>
                  <div className="px-4 py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-(--text)">Zelf uitvoeren</p>
                      <p className="text-xs text-(--muted)">{autonomous
                        ? 'De taak doet het werk zelf. Verwijderen, herstarten en beveiliging blijven een voorstel.'
                        : 'De taak onderzoekt alleen en eindigt met een voorstel. Met Uitvoeren in de melding of het gesprek keur je het goed.'}</p>
                    </div>
                    <Switch on={autonomous} onChange={setAutonomous} label="Zelf uitvoeren" />
                  </div>
                </div>

                {tried && (
                  <div role="status" className="rounded-xl px-4 py-3 border border-(--border) flex items-center gap-3">
                    <span className={clsx('w-2 h-2 rounded-full shrink-0', tried.status === 'opgeschoven' || tried.status === 'overgeslagen' ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse')} />
                    <p className="text-sm text-(--text) flex-1">{tried.message}</p>
                    {(tried.conversationId || saved?.conversation_id) && (
                      <Link href={`/chat/${tried.conversationId ?? saved?.conversation_id}`} className="text-sm text-(--accent) hover:underline shrink-0">Meekijken</Link>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      </div>

      {!busy && (
        <div className="flex flex-wrap items-center gap-2 px-5 py-4 border-t border-(--border)">
          <button type="button" onClick={onCancel} className="px-3 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">{saved && !initial ? 'Sluiten' : 'Annuleren'}</button>
          {!initial && step !== 'idea' && (
            <button type="button" onClick={() => go(step === 'summary' && askedFreq ? 'freq' : 'idea', 'back')} className="px-3 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">Terug</button>
          )}
          <div className="flex-1" />
          {step === 'idea' && (
            <button type="button" disabled={text.trim().length < 3} onClick={() => void analyse()}
              className="flex items-center gap-2 px-4 py-2 rounded-control bg-(--accent-strong) hover:brightness-110 text-white text-sm font-medium disabled:opacity-40 transition-colors">
              <span className="claude-white inline-flex"><ClaudeLogo className="w-4 h-4" /></span>Verder
            </button>
          )}
          {step === 'freq' && (
            <button type="button" disabled={!sched} onClick={() => go('summary')} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-40">Verder</button>
          )}
          {step === 'summary' && (
            <>
              <button type="button" onClick={() => void tryNow()} className="px-4 py-2 rounded-lg border border-(--border) text-sm text-(--text) hover:border-(--accent) transition-colors">Nu proberen</button>
              <button type="button" onClick={() => void save()} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium">
                {exec.kind === 'new' && !saved ? 'Agent maken en taak toevoegen' : 'Opslaan'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
