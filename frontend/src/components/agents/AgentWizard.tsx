'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import ClaudeLogo from '@/components/ClaudeLogo';
import { agentAssist, type AssistDraft, type AssistQuestion } from '@/lib/api';
import { AgentAvatar } from '@/components/chat/AgentBubble';

type Step = 'idea' | 'questions' | 'draft';
type Answer = { picked: string[]; other: string };

const EXAMPLES = [
  'Een mail-assistent die mijn inbox doorneemt, belangrijke mails samenvat en conceptantwoorden in mijn stijl klaarzet.',
  'Een netwerkexpert die bij storingen bij klanten de firewall, VPN en Wi-Fi uitzoekt en concreet zegt wat er mis is.',
  'Een Intune-specialist die apparaten controleert op updates, BitLocker en compliance en een kort rapport geeft.',
];

const MODEL_LABEL: Record<AssistDraft['model'], string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

const field = 'w-full px-3.5 py-2.5 rounded-control bg-(--input) border border-(--border) text-(--text) text-sm placeholder-(--muted) outline-none focus:border-(--accent) transition-colors';

function Stepper({ step }: { step: Step }) {
  const steps: Array<[Step, string]> = [['idea', 'Idee'], ['questions', 'Vragen'], ['draft', 'Voorstel']];
  const at = steps.findIndex(([s]) => s === step);
  return (
    <div className="flex items-center gap-2 w-full sm:w-auto pl-9 sm:pl-0">
      {steps.map(([s, label], i) => (
        <div key={s} className="flex items-center gap-2 min-w-0">
          <span className={clsx('w-6 h-6 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0 transition-colors',
            i < at ? 'bg-(--accent-strong) text-white' : i === at ? 'border-2 border-(--accent) text-(--accent)' : 'border border-(--border) text-(--muted)')}>
            {i < at ? (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
            ) : i + 1}
          </span>
          <span className={clsx('text-xs hidden sm:inline', i === at ? 'text-(--text) font-medium' : 'text-(--muted)')}>{label}</span>
          {i < steps.length - 1 && <span className={clsx('w-6 sm:w-10 h-px', i < at ? 'bg-(--accent)' : 'bg-(--border)')} />}
        </div>
      ))}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <ClaudeLogo className="w-10 h-10 animate-[spin_6s_linear_infinite]" />
      <p className="text-sm text-(--text)">{text}</p>
      <span className="typing-dots"><i /><i /><i /></span>
    </div>
  );
}

function QuestionCard({ q, a, onChange, index }: { q: AssistQuestion; a: Answer; onChange: (a: Answer) => void; index: number }) {
  const toggle = (label: string) => {
    const has = a.picked.includes(label);
    onChange({ ...a, picked: q.multi ? (has ? a.picked.filter((x) => x !== label) : [...a.picked, label]) : (has ? [] : [label]) });
  };
  const done = a.picked.length > 0 || a.other.trim().length > 0;
  return (
    <div className={clsx('rounded-card border p-4 space-y-3 transition-colors', done ? 'border-(--accent)/50' : 'border-(--border)')}
      style={{ background: 'color-mix(in srgb, var(--g-bg-base) 70%, transparent)' }}>
      <div className="flex gap-3">
        <span className={clsx('w-6 h-6 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0 mt-0.5',
          done ? 'bg-(--accent-strong) text-white' : 'bg-(--border) text-(--muted)')}>{index + 1}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-(--text)">{q.question}</p>
          {q.why && <p className="text-xs text-(--muted) mt-0.5">{q.why}</p>}
          {q.multi && <p className="text-[11px] text-(--muted) mt-1">Meerdere keuzes mogelijk</p>}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 pl-9">
        {q.options.map((o) => {
          const on = a.picked.includes(o.label);
          return (
            <button key={o.label} type="button" onClick={() => toggle(o.label)}
              className={clsx('text-left rounded-lg border px-3 py-2 transition-all',
                on ? 'border-(--accent) bg-(--accent)/10' : 'border-(--border) hover:border-(--muted)')}>
              <span className="flex items-center gap-2">
                <span className={clsx('w-4 h-4 shrink-0 flex items-center justify-center border transition-colors',
                  q.multi ? 'rounded' : 'rounded-full', on ? 'bg-(--accent-strong) border-(--accent) text-white' : 'border-(--muted)')}>
                  {on && <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>}
                </span>
                <span className="text-sm text-(--text)">{o.label}</span>
              </span>
              {o.detail && <span className="block text-xs text-(--muted) mt-1 pl-6">{o.detail}</span>}
            </button>
          );
        })}
      </div>
      <div className="pl-9">
        <input value={a.other} onChange={(e) => onChange({ ...a, other: e.target.value })} placeholder="Anders of aanvulling, typ het hier"
          className="w-full bg-transparent border-b border-(--border) focus:border-(--accent) outline-none text-sm text-(--text) placeholder-(--muted) py-1.5" />
      </div>
    </div>
  );
}

function DraftCard({ d }: { d: AssistDraft }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-(--border) overflow-hidden" style={{ background: 'color-mix(in srgb, var(--g-bg-base) 70%, transparent)' }}>
      <div className="flex items-center gap-3 p-4">
        <AgentAvatar name={d.name} color={d.color} className="w-12 h-12 text-base" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold" style={{ color: d.color }}>{d.name}</p>
          <p className="text-sm text-(--muted)">{d.summary}</p>
        </div>
      </div>
      <div className="border-t border-(--border) divide-y divide-(--border)">
        <div className="px-4 py-3 flex gap-3">
          <span className="text-xs text-(--muted) w-24 shrink-0 pt-0.5">Model</span>
          <div className="min-w-0">
            <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-(--accent)/15 text-(--accent)">{MODEL_LABEL[d.model]}</span>
            <p className="text-xs text-(--muted) mt-1">{d.model_reason}</p>
          </div>
        </div>
        <div className="px-4 py-3 flex gap-3">
          <span className="text-xs text-(--muted) w-24 shrink-0 pt-0.5">Wanneer inzetten</span>
          <p className="text-sm text-(--text) min-w-0">{d.description}</p>
        </div>
        <div className="px-4 py-3">
          <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-xs text-(--muted) hover:text-(--text)">
            <svg className={clsx('w-3 h-3 transition-transform', !open && '-rotate-90')} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            Prompt bekijken ({d.prompt.split('\n').length} regels)
          </button>
          {open && <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-(--text) font-mono bg-(--well) rounded-lg p-3">{d.prompt}</pre>}
        </div>
      </div>
    </div>
  );
}

/**
 * Claude works an idea out into a complete agent: it analyses the idea, asks the open points as
 * clickable questions, then proposes name, model, "when to use" and the full prompt. Nothing is
 * saved here; onApply fills the form and the user saves it.
 */
export default function AgentWizard({ current, onApply, onCancel }: {
  current?: { name: string; description: string; prompt: string; model: string } | null;
  onApply: (d: AssistDraft) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>('idea');
  const [idea, setIdea] = useState('');
  const [summary, setSummary] = useState('');
  const [questions, setQuestions] = useState<AssistQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [history, setHistory] = useState<Array<{ question: string; answer: string }>>([]);
  const [draft, setDraft] = useState<AssistDraft | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const answered = useMemo(() => questions.filter((q) => (answers[q.id]?.picked.length ?? 0) > 0 || answers[q.id]?.other.trim()).length, [questions, answers]);

  /** The answers of this round as text for Claude; skipped questions mean "you choose". */
  const collect = () => questions.map((q) => {
    const a = answers[q.id] ?? { picked: [], other: '' };
    const picked = a.picked.map((l) => { const o = q.options.find((x) => x.label === l); return o?.detail ? `${l} (${o.detail})` : l; });
    const parts = [...picked, ...(a.other.trim() ? [a.other.trim()] : [])];
    return { question: q.question, answer: parts.length ? parts.join('; ') : 'Geen voorkeur, kies zelf wat het beste past.' };
  });

  async function call(r: number, all: Array<{ question: string; answer: string }>, label: string) {
    setBusy(label); setError('');
    try {
      const out = await agentAssist({ idea, current: current ?? null, answers: all, round: r });
      setRound(r);
      if (out.summary) setSummary(out.summary);
      if (out.draft) setDraft(out.draft);
      setQuestions(out.questions ?? []);
      setAnswers({});
      setStep(out.draft && !(out.questions ?? []).length ? 'draft' : 'questions');
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(null); }
  }

  const next = () => {
    const all = [...history, ...collect()];
    setHistory(all);
    void call(Math.min(round + 1, 2), all, round === 0 ? 'Claude schrijft het voorstel…' : 'Claude werkt het voorstel bij…');
  };

  return (
    <div className="rounded-card border border-(--border) overflow-hidden" style={{ background: 'color-mix(in srgb, var(--g-bg-base) 85%, transparent)' }}>
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-(--border)">
        <ClaudeLogo className="w-6 h-6" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-(--text)">{current ? 'Verbeteren met Claude' : 'Uitwerken met Claude'}</p>
          <p className="text-xs text-(--muted)">Er wordt pas iets opgeslagen als jij op Opslaan drukt.</p>
        </div>
        <Stepper step={step} />
      </div>

      <div className="p-5 space-y-4">
        {busy ? <Thinking text={busy} /> : step === 'idea' ? (
          <>
            <label className="block space-y-2">
              <span className="text-sm text-(--text)">{current ? `Wat wil je verbeteren aan ${current.name}?` : 'Beschrijf wat deze agent moet doen'}</span>
              <textarea autoFocus className={`${field} min-h-[140px] text-[15px] leading-relaxed`} value={idea} onChange={(e) => setIdea(e.target.value)}
                placeholder={current ? 'Bijv. hij moet eerst vragen voor hij iets aanpast, en korter antwoorden. Leeg laten mag: dan kijkt Claude zelf wat ontbreekt.' : 'Gewoon in je eigen woorden: wat moet hij doen, voor wie, waar let hij op?'} />
            </label>
            {!current && !idea && (
              <div className="space-y-2">
                <p className="text-xs text-(--muted)">Of begin met een voorbeeld</p>
                <div className="flex flex-col gap-2">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} type="button" onClick={() => setIdea(ex)}
                      className="text-left text-sm text-(--muted) hover:text-(--text) rounded-lg border border-dashed border-(--border) hover:border-(--muted) px-3 py-2 transition-colors">{ex}</button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : step === 'questions' ? (
          <>
            {draft && round >= 1 ? (
              <div className="space-y-2">
                <p className="text-xs text-(--muted)">Voorstel tot nu toe</p>
                <DraftCard d={draft} />
                <p className="text-sm text-(--text) pt-2">Nog een paar dingen om het af te maken:</p>
              </div>
            ) : summary && (
              <div className="rounded-xl px-4 py-3 border-l-4 border-(--accent)" style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}>
                <p className="text-xs font-medium text-(--accent) mb-1">Dit begrijp ik ervan</p>
                <p className="text-sm text-(--text) leading-relaxed">{summary}</p>
              </div>
            )}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full bg-(--border) overflow-hidden">
                <div className="h-full bg-(--accent) transition-all duration-300" style={{ width: `${questions.length ? (answered / questions.length) * 100 : 0}%` }} />
              </div>
              <span className="text-xs text-(--muted) shrink-0">{answered} van {questions.length} beantwoord</span>
            </div>
            <div className="space-y-3">
              {questions.map((q, i) => (
                <div key={q.id} className="wa-row-in" style={{ '--i': i } as React.CSSProperties}><QuestionCard q={q} index={i} a={answers[q.id] ?? { picked: [], other: '' }}
                  onChange={(a) => setAnswers((x) => ({ ...x, [q.id]: a }))} /></div>
              ))}
            </div>
            {answered < questions.length && <p className="text-xs text-(--muted)">Vragen die je overslaat, vult Claude zelf in zoals het hem het beste lijkt.</p>}
          </>
        ) : draft && (
          <>
            <p className="text-sm text-(--text)">Dit is het voorstel. Neem het over in het formulier; daar kun je alles nog aanpassen en een afbeelding kiezen.</p>
            <DraftCard d={draft} />
          </>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {!busy && (
        <div className="flex flex-wrap items-center gap-2 px-5 py-4 border-t border-(--border)">
          <button type="button" onClick={onCancel} className="px-3 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">Annuleren</button>
          {step !== 'idea' && (
            <button type="button" onClick={() => { setStep('idea'); setQuestions([]); setHistory([]); setDraft(null); setRound(0); }}
              className="px-3 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">Opnieuw beginnen</button>
          )}
          <div className="flex-1" />
          {step === 'idea' && (
            <button type="button" disabled={!idea.trim() && !current} onClick={() => void call(0, [], 'Claude analyseert je idee…')}
              className="flex items-center gap-2 px-4 py-2 rounded-control bg-(--accent-strong) hover:brightness-110 text-white text-sm font-medium disabled:opacity-40 transition-colors">
              <span className="claude-white inline-flex"><ClaudeLogo className="w-4 h-4" /></span>
              Analyseren
            </button>
          )}
          {step === 'questions' && (
            <>
              {draft && round >= 1 && (
                <button type="button" onClick={() => setStep('draft')} className="px-3 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">Overslaan</button>
              )}
              <button type="button" onClick={next}
                className="flex items-center gap-2 px-4 py-2 rounded-control bg-(--accent-strong) hover:brightness-110 text-white text-sm font-medium transition-colors">
                <span className="claude-white inline-flex"><ClaudeLogo className="w-4 h-4" /></span>
                {round === 0 ? 'Voorstel maken' : 'Voorstel bijwerken'}
              </button>
            </>
          )}
          {step === 'draft' && draft && (
            <button type="button" onClick={() => onApply(draft)} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium">Overnemen in formulier</button>
          )}
        </div>
      )}
    </div>
  );
}
