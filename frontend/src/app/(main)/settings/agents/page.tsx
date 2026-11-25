'use client';

import { useEffect, useRef, useState } from 'react';
import { agentsApi, connectors as connApi, claudeAuth, models as modelsApi, type AgentDef, type AgentInput, type AgentTraining, type ClaudeAccountInfo, type ShareTargets } from '@/lib/api';
import { Bar, time as fmtTime } from '@/components/ClaudeAccounts';
import clsx from 'clsx';
import { AgentAvatar, setAgentsCache } from '@/components/chat/AgentBubble';
import AgentWizard from '@/components/agents/AgentWizard';
import ClaudeLogo from '@/components/ClaudeLogo';
import { M365LevelSeg, type M365Level } from '@/components/M365Level';

const field = 'w-full px-3.5 py-2.5 rounded-control bg-(--input) border border-(--border) text-(--text) text-sm placeholder-(--muted) outline-none focus:border-(--accent) transition-colors';
const COLORS = ['#6366f1', '#a855f7', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#64748b'];
const EMPTY: AgentInput = { name: '', description: '', prompt: '', model: 'inherit', avatar: null, color: COLORS[0], is_active: true };

/** Photo → square 256px JPEG data URL, small enough to store with the agent. */
function toAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 256, c = document.createElement('canvas');
      c.width = size; c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Afbeelding niet te lezen'));
    img.src = URL.createObjectURL(file);
  });
}

/** Small tag next to a field that Claude filled in */
function ByClaude({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded-full text-[11px] font-medium text-(--claude-text)" style={{ background: 'color-mix(in srgb, var(--claude) 14%, transparent)' }}>
      <ClaudeLogo className="w-2.5 h-2.5" />door Claude
    </span>
  );
}

/** "Account 2" or "Account 1 + 3" for the chosen slots; null = all accounts. */
const slotsLabel = (slots: number[] | null | undefined) => (slots?.length ? `Account ${slots.map((s) => s + 1).join(' + ')}` : null);

/** The account (of the chosen ones) that frees up first, when all chosen accounts are full; else null. */
function allFull(slots: number[] | null | undefined, accounts: ClaudeAccountInfo[]): ClaudeAccountInfo | null {
  const chosen = accounts.filter((x) => slots?.includes(x.slot));
  if (!chosen.length || !chosen.every((x) => x.usableAt)) return null;
  return chosen.reduce((b, x) => (Date.parse(x.usableAt!) < Date.parse(b.usableAt!) ? x : b));
}

/**
 * Which Claude accounts this agent may use in its own runs (workplaces, tasks): all (automatic, by
 * usage) or a chosen set. With one linked account a single line without choice.
 */
function AccountPicker({ slots, accounts, onChange }: { slots: number[] | null | undefined; accounts: ClaudeAccountInfo[]; onChange: (s: number[] | null) => void }) {
  const [mode, setMode] = useState<'all' | 'pick'>(slots?.length ? 'pick' : 'all');
  const chosen = slots ?? [];
  const gone = chosen.filter((s) => !accounts.some((x) => x.slot === s));
  const full = mode === 'pick' ? allFull(slots, accounts) : null;
  const toggle = (s: number) => {
    const n = chosen.includes(s) ? chosen.filter((x) => x !== s) : [...chosen, s].sort((x, y) => x - y);
    onChange(n.length ? n : null);
  };
  const seg = (on: boolean) => clsx('flex-1 px-3 py-1.5 rounded-lg text-sm transition-colors duration-200',
    on ? 'bg-(--accent-strong) text-white shadow-sm' : 'text-(--muted) hover:text-(--text)');
  // one linked account: nothing to choose, one line
  if (accounts.length === 1) {
    const x = accounts[0];
    return <p className="text-xs text-(--muted)">Claude-account: <span className="text-(--text)">Account {x.slot + 1}{x.email ? ` (${x.email})` : ''}</span>. Het enige gekoppelde account.</p>;
  }
  return (
    <div className="space-y-2">
      <span className="text-xs text-(--muted)">Claude-account</span>
      <div className="flex gap-1 p-1 rounded-xl border border-(--border) bg-(--bg) max-w-sm" role="radiogroup">
        <button type="button" role="radio" aria-checked={mode === 'all'} className={seg(mode === 'all')}
          onClick={() => { setMode('all'); onChange(null); }}>Automatisch</button>
        <button type="button" role="radio" aria-checked={mode === 'pick'} className={seg(mode === 'pick')}
          onClick={() => setMode('pick')}>Vast account</button>
      </div>
      <div className={clsx('ll-fold', mode !== 'pick' && 'is-shut')}>
        <div>
          <p className="text-xs text-(--muted) pb-1">Kies één of meer accounts. Bij meer dan één verdeelt Claude daartussen.</p>
          <div className="grid gap-2 sm:grid-cols-2 pt-1">
            {accounts.map((x) => {
              const on = chosen.includes(x.slot);
              const pct = Math.max(x.usage?.session?.pct ?? 0, x.usage?.weekly?.pct ?? 0);
              return (
                <label key={x.slot} className={clsx('min-h-11 rounded-xl border px-3 py-2 cursor-pointer transition-colors duration-200 flex flex-col gap-1.5',
                  on ? 'border-(--accent) bg-(--accent)/10' : 'border-(--border) bg-(--bg) hover:border-(--accent)/50')}>
                  <span className="flex items-center gap-2 min-w-0">
                    <input type="checkbox" checked={on} onChange={() => toggle(x.slot)} />
                    <span className="text-sm font-medium text-(--text) shrink-0">Account {x.slot + 1}</span>
                    {x.email && <span className="text-xs text-(--muted) truncate">{x.email}</span>}
                  </span>
                  {x.usableAt && <span className="tr-line self-start text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-(--bad) border border-red-500/30">vol, weer bruikbaar om {fmtTime(x.usableAt)}</span>}
                  <Bar label="verbruik" pct={x.usage ? pct : undefined} />
                </label>
              );
            })}
          </div>
          {gone.map((s) => <p key={s} className="tr-line mt-2 text-xs text-(--warn)">Account {s + 1} (niet meer gekoppeld): deze agent gebruikt dan alle accounts.</p>)}
          {!chosen.length && <p className="mt-2 text-xs text-(--muted)">Niets gekozen: bij opslaan gebruikt deze agent alle accounts.</p>}
        </div>
      </div>
      {mode === 'all' && <p className="tr-line text-xs text-(--muted)">Claude verdeelt automatisch op basis van verbruik. Geldt voor werkplekken en automatische taken van deze agent.</p>}
      {full && <p className="tr-line text-xs text-(--warn)">Alle gekozen accounts zitten aan hun limiet. Deze agent wacht tot Account {full.slot + 1} om {fmtTime(full.usableAt)} weer vrij is.</p>}
    </div>
  );
}

function AgentForm({ initial, modelOptions, accounts, onSave, onCancel, onDelete, isNew, embedded, readOnly }: {
  initial: AgentInput; modelOptions: Array<{ id: string; label: string }>; accounts: ClaudeAccountInfo[];
  onSave: (a: AgentInput) => Promise<void>; onCancel: () => void; onDelete?: () => Promise<void>; isNew?: boolean; embedded?: boolean;
  /** shared agent: same fields as when editing, but greyed out */
  readOnly?: boolean;
}) {
  const [a, setA] = useState<AgentInput>(initial);
  // new agents start in the wizard; the form is always one click away
  const [wizard, setWizard] = useState(!!isNew);
  const [byClaude, setByClaude] = useState<Set<string>>(new Set());
  const [modelReason, setModelReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<AgentInput>) => {
    setA((x) => ({ ...x, ...p }));
    // a field the user edits is no longer "by Claude"
    setByClaude((b) => { const n = new Set(b); Object.keys(p).forEach((k) => n.delete(k)); return n; });
  };

  if (wizard) {
    return (
      <AgentWizard
        current={isNew ? null : { name: a.name, description: a.description, prompt: a.prompt, model: a.model }}
        onCancel={() => (isNew && !a.name ? onCancel() : setWizard(false))}
        onApply={(d) => {
          setA((x) => ({ ...x, name: d.name, description: d.description, prompt: d.prompt, model: d.model, color: x.avatar ? x.color : d.color }));
          setByClaude(new Set(['name', 'description', 'prompt', 'model']));
          setModelReason(d.model_reason);
          setWizard(false);
        }}
      />
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await onSave(a); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className={embedded ? 'space-y-4 pt-3' : 'rounded-card border border-(--border) bg-(--input) p-4 space-y-4'}>
      <fieldset disabled={readOnly} className={clsx('space-y-4 min-w-0', readOnly && 'ak-ro')}>
      {!readOnly && <button type="button" onClick={() => setWizard(true)}
        className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left border border-(--claude)/30 hover:border-(--claude)/70 transition-colors"
        style={{ background: 'color-mix(in srgb, var(--claude) 8%, transparent)' }}>
        <ClaudeLogo className="w-6 h-6 shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-(--text)">{isNew || !a.prompt ? 'Uitwerken met Claude' : 'Verbeteren met Claude'}</span>
          <span className="block text-xs text-(--muted)">Beschrijf je idee, beantwoord een paar vragen en Claude vult alles in, inclusief het model.</span>
        </span>
        <svg className="w-4 h-4 text-(--muted) shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m9 5 7 7-7 7" /></svg>
      </button>}
      <div className="flex items-center gap-4">
        <button type="button" onClick={() => fileRef.current?.click()} className="relative group shrink-0" title="Afbeelding kiezen">
          <AgentAvatar name={a.name || '?'} avatar={a.avatar} color={a.color} className="w-16 h-16 text-lg" />
          <span className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-[11px] text-white">Wijzig</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { try { set({ avatar: await toAvatar(f) }); } catch (err) { setError((err as Error).message); } } }} />
        <div className="flex-1 min-w-0 space-y-2">
          {byClaude.has('name') && <ByClaude show />}
          <input className={field} value={a.name} onChange={(e) => set({ name: e.target.value })} placeholder="Naam, bijv. Netwerkexpert" maxLength={60} required />
          {!readOnly && <div className="flex flex-wrap items-center gap-1.5">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => set({ color: c })} aria-label={c}
                className={`w-5 h-5 rounded-full ${a.color === c ? 'ring-2 ring-offset-2 ring-offset-(--input) ring-(--text)' : ''}`} style={{ backgroundColor: c }} />
            ))}
            {a.avatar && <button type="button" onClick={() => set({ avatar: null })} className="ml-2 text-xs text-(--muted) hover:underline">Afbeelding weghalen</button>}
          </div>}
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-(--muted)">Wanneer inzetten (hiermee kiest Claude deze agent)<ByClaude show={byClaude.has('description')} /></span>
        <textarea className={field} rows={2} value={a.description} onChange={(e) => set({ description: e.target.value })}
          placeholder="Bijv. vragen over netwerken, firewalls, VPN en Wi-Fi bij klanten" required />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-(--muted)">Eigen prompt<ByClaude show={byClaude.has('prompt')} /></span>
        <textarea className={`${field} font-mono text-[13px]`} rows={8} value={a.prompt} onChange={(e) => set({ prompt: e.target.value })}
          placeholder={readOnly ? 'Geen prompt beschikbaar' : 'Wie is deze agent, hoe werkt hij, waar let hij op, hoe antwoordt hij?'} required={!readOnly} />
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-(--text)">
          Model
          <select className="bg-(--input) border border-(--border) rounded-lg px-2 py-1.5 text-sm text-(--text)" value={a.model} onChange={(e) => set({ model: e.target.value })}>
            <option value="inherit">Zelfde als het gesprek</option>
            {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <ByClaude show={byClaude.has('model')} />
        </label>
        {!readOnly && <label className="flex items-center gap-2 text-sm text-(--text)">
          <input type="checkbox" checked={a.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
          Actief
        </label>}
      </div>
      </fieldset>

      {byClaude.has('model') && modelReason && <p className="text-xs text-(--muted) -mt-2">{modelReason}</p>}
      {isNew && accounts.length >= 1 && <AccountPicker slots={a.account_slots} accounts={accounts} onChange={(s) => set({ account_slots: s })} />}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {readOnly ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-(--muted) flex-1">Alleen bekijken: de eigenaar beheert deze agent.</p>
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">Sluiten</button>
        </div>
      ) : <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">{busy ? 'Opslaan…' : 'Opslaan'}</button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">Annuleren</button>
        {onDelete && (
          <button type="button" disabled={busy} className="ml-auto text-sm text-red-400 hover:underline"
            onClick={async () => { if (confirm(`${a.name || 'Deze agent'} verwijderen?`)) { setBusy(true); try { await onDelete(); } finally { setBusy(false); } } }}>
            Verwijderen
          </button>
        )}
      </div>}
    </form>
  );
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

const Chev = ({ open }: { open: boolean }) => (
  <svg className={clsx('tr-chev w-4 h-4 shrink-0', open && 'is-open')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
);

/** One option row: label (and hint) left, control right; stacks under 480 px unless inline (button or switch). */
function Row({ label, hint, inline, onClick, expanded, children }: { label: string; hint?: string; inline?: boolean; onClick?: () => void; expanded?: boolean; children?: React.ReactNode }) {
  const inner = (
    <>
      <div className="ak-k">{label}{hint && <small>{hint}</small>}</div>
      <div className="ak-v">{children}</div>
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} aria-expanded={expanded} className={clsx('ak-row is-btn', inline && 'is-inl')}>{inner}</button>
    : <div className={clsx('ak-row', inline && 'is-inl')}>{inner}</div>;
}

const btnMain = 'px-3 py-1.5 rounded-control bg-(--accent-strong) text-white text-xs font-medium disabled:opacity-50';
const btnLine = 'px-3 py-1.5 rounded-control border border-(--border) text-xs text-(--text) hover:border-(--accent) transition-colors disabled:opacity-50';

/**
 * Training on earlier conversations: row with button, progress bar while it runs, and the knowledge block
 * (ll-fold) to read, edit, retrain or undo.
 */
function TrainTab({ agent, onDone }: { agent: AgentDef; onDone: () => void }) {
  const [t, setT] = useState<AgentTraining | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const running = t?.state === 'wachten' || t?.state === 'bezig';
  const wasRunning = useRef(false);
  const trained = !!(t?.trained_at ?? agent.trained_at);
  const take = (x: AgentTraining) => { setT(x); setDraft(x.knowledge ?? ''); };

  useEffect(() => { agentsApi.trainStatus(agent.id).then(take).catch(() => {}); }, [agent.id]);
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current) { wasRunning.current = false; onDone(); }
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => { agentsApi.trainStatus(agent.id).then(take).catch(() => {}); }, 2000);
    return () => clearInterval(iv);
  }, [running, agent.id]);

  async function act(fn: () => Promise<AgentTraining>) {
    setBusy(true); setErr('');
    try { take(await fn()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const start = () => act(() => agentsApi.train(agent.id));

  const pct = t && t.total ? Math.round((t.done / t.total) * 100) : 0;
  const label = !t ? '' : t.state === 'wachten' ? `Wacht: ${t.waiting ?? 'even geduld'}`
    : !t.total ? 'Passende gesprekken zoeken…'
    : t.done >= t.total ? 'Kennis samenvoegen…' : `${t.done} van ${t.total} gesprekken`;
  const dirty = draft.trim() !== (t?.knowledge ?? '').trim();
  const hint = trained ? `Getraind op ${fmtDate((t?.trained_at ?? agent.trained_at)!)} met ${t?.trained_conversations ?? agent.trained_conversations ?? 0} gesprekken` : 'Leert van je eerdere gesprekken over dit vakgebied';

  return (
    <div>
      <Row label="Training" hint={hint} inline>
        <button type="button" onClick={start} disabled={busy || running} className={trained ? btnLine : btnMain}>Trainen</button>
      </Row>
      {running && (
        <div className="tr-line space-y-1.5 py-3 border-b border-(--border)" role="status">
          <div className="tr-track"><div className={clsx('tr-fill', (!t?.total || t?.state === 'wachten') && 'is-idle')} style={{ width: `${Math.max(pct, 4)}%` }} /></div>
          <p className="text-xs text-(--muted)">Trainen: {label}</p>
        </div>
      )}
      {t?.state === 'fout' && !running && <p className="tr-line text-xs text-(--bad) py-2">Training mislukt: {t.error}</p>}
      {err && <p className="text-xs text-(--bad) py-2">{err}</p>}
      {trained && !running && (
        <Row label="Kennis" hint={`Wat ${agent.name} al weet`} inline onClick={() => setOpen((o) => !o)} expanded={open}><Chev open={open} /></Row>
      )}
      <div className={clsx('ll-fold', !(open && trained && !running) && 'is-shut')}>
        <div>
          <div className="space-y-2 py-3">
            <span className="block text-xs text-(--muted)">Uit eerdere gesprekken. Staat in zijn prompt; je kunt het hier aanpassen.</span>
            <textarea className={`${field} font-mono text-[13px]`} rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={12000} />
            <div className="flex flex-wrap items-center gap-2">
              {dirty && <button type="button" disabled={busy} onClick={() => act(() => agentsApi.setKnowledge(agent.id, draft))} className={btnMain}>Opslaan</button>}
              <button type="button" disabled={busy} onClick={start} className={btnLine}>Opnieuw trainen</button>
              <button type="button" disabled={busy || !t?.can_revert}
                onClick={() => { if (confirm('Terug naar de vorige versie van het kennisblok?')) void act(() => agentsApi.revertKnowledge(agent.id)); }}
                className="px-3 py-1.5 rounded-control text-xs text-(--muted) hover:text-(--text) transition-colors disabled:opacity-40">Vorige versie terugzetten</button>
              <span className="ml-auto text-[11px] text-(--muted)">{draft.length} tekens</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const pick = (on: boolean) => clsx('min-h-9 rounded-full border px-3 py-1 cursor-pointer transition-colors duration-200 inline-flex items-center gap-2 text-sm text-(--text) max-w-full',
  on ? 'border-(--accent) bg-(--accent)/10' : 'border-(--border) bg-(--bg) hover:border-(--accent)/50');

const CONN_TYPES: Record<string, { label: string; icon: React.ReactNode }> = {
  m365: { label: 'Microsoft 365', icon: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></> },
  gripp: { label: 'Gripp', icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> },
  ssh: { label: 'SSH', icon: <><path d="m5 8 4 4-4 4" /><path d="M12 17h7" /><rect x="2" y="3" width="20" height="18" rx="2.5" /></> },
  focustrack: { label: 'Focustrack', icon: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 1.5M9 2h6" /></> },
  icloud: { label: 'iCloud', icon: <path d="M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.4 1.6A3.7 3.7 0 0 1 17.5 18z" /> },
};
const plug = <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>;
const connType = (t: string) => CONN_TYPES[t] ?? { label: t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/[-_]/g, ' ') : 'Koppeling', icon: plug };

async function m365Api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/m365${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Connectors this agent may use: one row per connector with a switch (the switch is the access). For a shared agent they work for everyone who uses it. */
function ConnectorsTab({ agent, limited, onChange }: { agent: AgentDef; limited: string[]; onChange: (list: AgentDef[]) => void }) {
  const [conns, setConns] = useState<{ id: string; name: string; type: string }[] | null>(null);
  const [levels, setLevels] = useState<Record<string, M365Level>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ids = agent.connector_ids ?? [];
  const shared = (agent.visibility ?? 'private') !== 'private';
  const loadLevels = () => m365Api<{ tenants: { id: string; config: { agent_access?: Record<string, M365Level> } }[] }>('/tenants')
    .then((r) => setLevels(Object.fromEntries(r.tenants.map((t) => [t.id, t.config.agent_access?.[agent.id] ?? 'read'])))).catch(() => { /* levels optional */ });
  useEffect(() => { agentsApi.myConnectors().then((r) => setConns(r.connectors)).catch((e) => setErr((e as Error).message)); void loadLevels(); }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(next: string[]) {
    setBusy(true); setErr('');
    try { onChange((await agentsApi.setConnectors(agent.id, next)).agents); await loadLevels(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function setLevel(id: string, level: M365Level) {
    const prev = levels[id];
    setLevels((l) => ({ ...l, [id]: level })); setErr('');
    try { await m365Api(`/tenants/${id}/access/${agent.id}`, { method: 'PUT', body: JSON.stringify({ level }) }); }
    catch (e) { setLevels((l) => ({ ...l, [id]: prev })); setErr((e as Error).message); }
  }
  const nOn = conns ? conns.filter((c) => ids.includes(c.id)).length : 0;
  return (
    <div className="pt-3">
      <p className="text-xs text-(--muted)">Waar {agent.name} bij mag. Zet een koppeling aan om toegang te geven.{conns && conns.length > 0 && <span className="ml-1 tabular-nums">{nOn} van {conns.length} aan</span>}</p>
      {shared && ids.length > 0 && <p className="text-xs text-(--warn) mt-2">Deze agent is gedeeld: iedereen die hem gebruikt kan via de agent bij deze connectoren, ook SSH met sudo. Zorg dat de instellingen van de connector daarop zijn afgestemd.</p>}
      {!conns && !err && <div className="h-11 rounded-xl bg-(--bg) animate-pulse mt-2" />}
      {conns && !conns.length && <p className="text-xs text-(--muted) mt-2">Je hebt nog geen actieve connectoren.</p>}
      {conns && !!conns.length && (
        <div className="cn-niv mt-1 divide-y divide-(--border)">
          {conns.map((c) => {
            const on = ids.includes(c.id);
            const t = connType(c.type);
            const m365 = c.type === 'm365';
            return (
              <div key={c.id}>
                <div className="cn-row">
                  <span className={clsx('cn-tile', on && 'is-on')} aria-hidden>
                    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">{t.icon}</svg>
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-(--text) truncate">{c.name}</p>
                    <p className="text-xs text-(--muted) truncate">{t.label}</p>
                  </div>
                  <button type="button" role="switch" aria-checked={on} aria-label={`${c.name} voor ${agent.name} ${on ? 'uitzetten' : 'aanzetten'}`} disabled={busy}
                    className="ll-switch disabled:opacity-50" onClick={() => void save(on ? ids.filter((x) => x !== c.id) : [...ids, c.id])} />
                </div>
                {m365 && (
                  <div className={clsx('ll-fold cn-fold', !on && 'is-shut')} inert={!on}>
                    <div>
                      <div className="cn-niv-in">
                        <span className="text-xs text-(--muted) shrink-0">Niveau</span>
                        <M365LevelSeg value={levels[c.id] ?? 'read'} onPick={(l) => void setLevel(c.id, l)} label={`Niveau ${c.name}`} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {limited.length > 0 && <p className="text-xs text-(--muted) mt-2">Beperkt tot deze agent: {limited.join(', ')}.</p>}
      {err && <p className="text-xs text-(--bad) mt-2">{err}</p>}
    </div>
  );
}

/** Claude account(s) for this agent; saves directly on every change. */
function AccountTab({ agent, accounts, save }: { agent: AgentDef; accounts: ClaudeAccountInfo[]; save: (s: number[] | null) => Promise<void> }) {
  const [err, setErr] = useState('');
  if (!accounts.length) return <p className="text-xs text-(--muted) pt-3">Er is nog geen Claude-account gekoppeld.</p>;
  return (
    <div className="pt-3 space-y-2">
      <AccountPicker slots={agent.account_slots} accounts={accounts} onChange={(s) => { setErr(''); save(s).catch((e) => setErr((e as Error).message)); }} />
      {err && <p className="text-xs text-(--bad)">{err}</p>}
    </div>
  );
}

/** For the recipient: which account a shared agent runs on. Display only, no usage figures or e-mail. */
function RecipientChip({ agent }: { agent: AgentDef }) {
  const owner = agent.shared_by ?? '';
  const st = agent.owner_account_state;
  const ownerAcct = agent.share_account === 'owner';
  const v = !ownerAcct ? 'own' : st?.full ? (agent.share_fallback === false ? 'blocked' : 'fallback') : 'owner';
  const text = v === 'own' ? 'Gebruikt je eigen account'
    : v === 'owner' ? `Werkplekken en taken gebruiken het abonnement van ${owner}`
    : v === 'fallback' ? `Account van ${owner} vol: werkplekken en taken gebruiken tijdelijk je eigen account`
    : `Werkplekken en taken tijdelijk niet beschikbaar${st?.usableAt ? `, weer bruikbaar om ${fmtTime(st.usableAt)}` : ''}`;
  const tone = v === 'fallback' ? 'text-(--warn)' : v === 'blocked' ? 'text-(--bad)' : 'text-(--muted)';
  return (
    <span key={v} className={clsx('tr-line mt-1.5 inline-flex items-start gap-1 text-[11px] leading-snug px-2 py-0.5 rounded-full', tone)}
      style={{ background: 'color-mix(in srgb, var(--text) 8%, transparent)' }}>
      <svg className="w-3 h-3 shrink-0 mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {v === 'own' ? <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></> : <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9m-3 3 3 3" /></>}
      </svg>
      {text}
    </span>
  );
}

/** When the owner's account(s) for this agent are all full: the moment the first one frees up; else null. */
function ownFullAt(slots: number[] | null | undefined, accounts: ClaudeAccountInfo[]): string | null {
  const list = slots?.length ? accounts.filter((x) => slots.includes(x.slot)) : accounts;
  if (!list.length || !list.every((x) => x.usableAt)) return null;
  return list.map((x) => x.usableAt!).sort()[0];
}

/** Owner: who may use this agent. Saves on every change; shared agents run with each user's own account. */
function ShareTab({ agent, accounts, onEditAccount, onChange }: { agent: AgentDef; accounts: ClaudeAccountInfo[]; onEditAccount: () => void; onChange: (list: AgentDef[]) => void }) {
  const [adv, setAdv] = useState(false);
  const [targets, setTargets] = useState<ShareTargets | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const vis = agent.visibility ?? 'private';
  const users = agent.share_users ?? [], groups = agent.share_groups ?? [];

  useEffect(() => { agentsApi.shareTargets().then(setTargets).catch((e) => setErr((e as Error).message)); }, []);

  const mode = agent.share_account ?? 'user';
  const fallback = agent.share_fallback ?? true;
  async function save(v: 'private' | 'selected' | 'all', u: string[], g: string[], extra: { account_mode?: 'user' | 'owner'; fallback?: boolean } = {}) {
    setBusy(true); setErr('');
    try { onChange((await agentsApi.share(agent.id, v, u, g, extra)).agents); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const flip = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const fullAt = ownFullAt(agent.account_slots, accounts);
  const chosen = (agent.account_slots ?? []).map((sl) => accounts.find((x) => x.slot === sl)).filter(Boolean) as ClaudeAccountInfo[];
  const chosenLabel = !agent.account_slots?.length ? 'Automatisch uit al je accounts'
    : chosen.length === 1 ? `Account ${chosen[0].slot + 1}${chosen[0].email ? ` (${chosen[0].email})` : ''}` : slotsLabel(agent.account_slots);
  const radio = (on: boolean) => clsx('rounded-xl border transition-colors duration-200', on ? 'border-(--accent) bg-(--accent)/10' : 'border-(--border) bg-(--bg) hover:border-(--accent)/50');
  const seg = (on: boolean) => clsx('px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors duration-200 disabled:opacity-60',
    on ? 'bg-(--accent-strong) text-white shadow-sm' : 'text-(--muted) hover:text-(--text)');

  return (
    <div>
      <Row label="Zichtbaarheid" hint="Wie mag deze agent gebruiken">
        <div className="inline-flex gap-0.5 p-0.5 rounded-xl border border-(--border) bg-(--bg)" role="radiogroup" aria-label="Zichtbaarheid">
          {([['private', 'Alleen ik'], ['selected', 'Kiezen'], ['all', 'Iedereen']] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={vis === v} disabled={busy} className={seg(vis === v)}
              onClick={() => vis !== v && void save(v, users, groups)}>{label}</button>
          ))}
        </div>
      </Row>
      <div className={clsx('ll-fold', vis !== 'selected' && 'is-shut')}>
        <div>
          {!targets && !err && <div className="h-11 my-2 rounded-xl bg-(--bg) animate-pulse" />}
          {targets && !!targets.groups.length && (
            <Row label="Groepen">
              <div className="flex flex-wrap gap-2 sm:justify-end">
                {targets.groups.map((g) => (
                  <label key={g.id} className={pick(groups.includes(g.id))}>
                    <input type="checkbox" checked={groups.includes(g.id)} disabled={busy} onChange={() => void save('selected', users, flip(groups, g.id))} />
                    <span className="truncate">{g.name}</span>
                  </label>
                ))}
              </div>
            </Row>
          )}
          {targets && (
            <Row label="Gebruikers">
              <div className="flex flex-wrap gap-2 sm:justify-end">
                {targets.users.map((u) => (
                  <label key={u.id} className={pick(users.includes(u.id))}>
                    <input type="checkbox" checked={users.includes(u.id)} disabled={busy} onChange={() => void save('selected', flip(users, u.id), groups)} />
                    <span className="truncate">{u.name}</span>
                  </label>
                ))}
                {!targets.users.length && <span className="text-sm text-(--muted)">Geen andere gebruikers</span>}
              </div>
            </Row>
          )}
        </div>
      </div>
      <div className={clsx('ll-fold', vis === 'private' && 'is-shut')}>
        <div>
          <Row label="Account bij gebruik door anderen" hint="Geavanceerd" onClick={() => setAdv((o) => !o)} expanded={adv}>
            <span>{mode === 'owner' ? 'Mijn abonnement' : 'Eigen account van de gebruiker'}</span>
            <Chev open={adv} />
          </Row>
          <div className={clsx('ll-fold', !adv && 'is-shut')}>
            <div className="space-y-2 py-3">
              <div className="space-y-2 max-w-xl" role="radiogroup" aria-label="Account bij gebruik door anderen">
                <div className={radio(mode === 'user')}>
                  <button type="button" role="radio" aria-checked={mode === 'user'} disabled={busy} className="w-full min-h-11 p-3 text-left"
                    onClick={() => mode !== 'user' && void save(vis, users, groups, { account_mode: 'user' })}>
                    <span className="block text-sm font-medium text-(--text)">Eigen account van de gebruiker</span>
                    <span className="block text-xs text-(--muted)">Iedereen gebruikt zijn eigen abonnement.</span>
                  </button>
                </div>
                <div className={radio(mode === 'owner')}>
                  <button type="button" role="radio" aria-checked={mode === 'owner'} disabled={busy} className="w-full min-h-11 p-3 text-left"
                    onClick={() => mode !== 'owner' && void save(vis, users, groups, { account_mode: 'owner' })}>
                    <span className="block text-sm font-medium text-(--text)">Mijn gekoppelde abonnement</span>
                    <span className="block text-xs text-(--muted)">Werkplekken en taken van deze agent draaien op jouw account en tellen mee voor je limiet. Gewone gesprekken blijven op het eigen account van de gebruiker.</span>
                  </button>
                  <div className={clsx('ll-fold', mode !== 'owner' && 'is-shut')}>
                    <div>
                      <p className="px-3 pb-3 text-xs text-(--muted)">
                        <span className="text-(--text)">{chosenLabel}</span>
                        {' · '}
                        <button type="button" onClick={onEditAccount} className="underline underline-offset-2 hover:text-(--text)">Wijzig op het tabblad Account</button>
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className={clsx('ll-fold', mode !== 'owner' && 'is-shut')}>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 text-sm text-(--text) cursor-pointer min-h-11 max-w-xl">
                    <input type="checkbox" checked={fallback} disabled={busy} onChange={() => void save(vis, users, groups, { fallback: !fallback })} />
                    Als mijn account vol is: werkplekken en taken op het eigen account van de gebruiker laten draaien
                  </label>
                  {!fallback && <p className="tr-line text-xs text-(--muted)">Gebruikers wachten dan tot {fullAt ? fmtTime(fullAt) : 'je account weer ruimte heeft'}.</p>}
                  {mode === 'owner' && vis === 'all' && <p className="tr-line text-xs text-(--warn)">Dit geldt voor iedereen met toegang.</p>}
                  {mode === 'owner' && fullAt && (fallback
                    ? <p className="tr-line text-xs text-(--warn)">Je account zit aan zijn limiet tot {fmtTime(fullAt)}. Gebruikers vallen terug op hun eigen account.</p>
                    : <p className="tr-line text-xs text-(--bad)">Gebruikers kunnen de agent tot {fmtTime(fullAt)} niet gebruiken.</p>)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="tr-line text-xs text-(--muted) pt-3">
        {vis === 'private' ? 'Alleen jij ziet en gebruikt deze agent.'
          : 'Anderen zien hem als "Gedeeld door jou", alleen-lezen, en kunnen hem voor zichzelf aan- of uitzetten. Hij draait met hun eigen koppelingen en apparaten; jouw kennisblok gebruikt hij niet. Onder Geavanceerd kies je welk Claude-account hij gebruikt. Wijzig je de agent, dan krijgt iedereen die versie.'}
      </p>
      {err && <p className="text-xs text-(--bad) pt-2">{err}</p>}
    </div>
  );
}

const TABS = [['general', 'Algemeen'], ['train', 'Training'], ['conn', 'Koppelingen'], ['account', 'Account'], ['share', 'Delen']] as const;
type Tab = (typeof TABS)[number][0];
const penIcon = <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>;

/** Closed card: avatar, name, model, description and chips; the pencil opens the option field with tabs below. */
function AgentCard({ a, i, open, onToggle, accounts, limited, modelOptions, toInput, setLists, onSaved, onDeleted, refresh }: {
  a: AgentDef; i: number; open: boolean; onToggle: () => void; accounts: ClaudeAccountInfo[]; limited: string[]; modelOptions: Array<{ id: string; label: string }>;
  toInput: (a: AgentDef) => AgentInput; setLists: (l: AgentDef[]) => void; onSaved: (l: AgentDef[]) => void; onDeleted: (l: AgentDef[]) => void; refresh: () => void;
}) {
  const [tab, setTab] = useState<Tab>('general');
  const [seen, setSeen] = useState(open);
  useEffect(() => { if (open) setSeen(true); }, [open]);
  const vis = a.visibility ?? 'private';
  const nShare = (a.share_users?.length ?? 0) + (a.share_groups?.length ?? 0);
  const shareText = vis === 'all' ? 'Gedeeld met iedereen' : vis === 'selected' ? `Gedeeld met ${nShare}` : null;
  const full = allFull(a.account_slots, accounts);
  const nConn = Math.max(a.connector_ids?.length ?? 0, limited.length);
  const chip = 'inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-(--muted)';

  return (
    <div style={{ '--i': Math.min(i, 10) } as React.CSSProperties} className={clsx('wa-row-in ak-card', open && 'is-open')}>
      <div className="flex items-center gap-3 pl-4 pr-2 py-3">
        <AgentAvatar name={a.name} avatar={a.avatar} color={a.color} className="w-10 h-10 text-sm shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-semibold text-(--text) truncate max-w-[60%]">{a.name}</span>
            <span className="text-xs text-(--muted) whitespace-nowrap truncate min-w-0">{a.model === 'inherit' ? 'model van het gesprek' : a.model}</span>
          </div>
          <p className="text-xs text-(--muted) truncate mt-0.5">{a.description}</p>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {!a.is_active && <span className={chip}>Uit</span>}
            {shareText && <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-(--accent)/12 text-(--accent-text)">{shareText}</span>}
            {accounts.length >= 2 && slotsLabel(a.account_slots) && (
              <span className={chip} title={full ? 'Alle gekozen accounts zitten aan hun limiet' : undefined}>
                {full && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                {slotsLabel(a.account_slots)}
              </span>
            )}
            {a.trained_at && <span className={chip}>Getraind</span>}
            {nConn > 0 && <span className={chip}>Connectoren {nConn}</span>}
          </div>
        </div>
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label="Bewerken" className={clsx('icon-btn ak-pen', open && 'is-on')}>{penIcon}</button>
      </div>
      <div className={clsx('ll-fold', !open && 'is-shut')}>
        <div>
          <div className="ak-panel">
            {seen && (
              <>
                <div className="ak-tabs" role="tablist">
                  {TABS.map(([k, label]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={clsx('ak-tab', tab === k && 'is-on')}>{label}</button>
                  ))}
                </div>
                <div key={tab} className="ak-fade pt-1" role="tabpanel">
                  {tab === 'general' && (
                    <AgentForm embedded initial={toInput(a)} modelOptions={modelOptions} accounts={accounts} onCancel={onToggle}
                      onSave={async (x) => onSaved((await agentsApi.update(a.id, x)).agents)}
                      onDelete={async () => onDeleted((await agentsApi.remove(a.id)).agents)} />
                  )}
                  {tab === 'train' && <TrainTab agent={a} onDone={refresh} />}
                  {tab === 'conn' && <ConnectorsTab agent={a} limited={limited} onChange={setLists} />}
                  {tab === 'account' && <AccountTab agent={a} accounts={accounts} save={async (s) => setLists((await agentsApi.update(a.id, { ...toInput(a), account_slots: s })).agents)} />}
                  {tab === 'share' && <ShareTab agent={a} accounts={accounts} onEditAccount={() => setTab('account')} onChange={setLists} />}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const eyeIcon = <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;

/** Agent shared with you: same card and fields as your own, opened read-only (greyed out); switch on/off for yourself. */
function SharedCard({ a, i, open, onToggle, modelOptions, accounts, toInput, busy, onSwitch }: {
  a: AgentDef; i: number; open: boolean; onToggle: () => void; modelOptions: Array<{ id: string; label: string }>; accounts: ClaudeAccountInfo[];
  toInput: (a: AgentDef) => AgentInput; busy: boolean; onSwitch: () => void;
}) {
  const [seen, setSeen] = useState(open);
  useEffect(() => { if (open) setSeen(true); }, [open]);
  const chip = 'inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--text)_8%,transparent)] text-(--muted)';
  return (
    <div style={{ '--i': Math.min(i, 10) } as React.CSSProperties} className={clsx('wa-row-in ak-card', open && 'is-open')}>
      <div className={clsx('flex items-center gap-3 pl-4 pr-2 py-3 transition-opacity duration-200', !a.is_active && !open && 'opacity-70')}>
        <AgentAvatar name={a.name} avatar={a.avatar} color={a.color} className="w-10 h-10 text-sm shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-semibold text-(--text) truncate max-w-[60%]">{a.name}</span>
            <span className="text-xs text-(--muted) whitespace-nowrap truncate min-w-0">{a.model === 'inherit' ? 'model van het gesprek' : a.model}</span>
          </div>
          <p className="text-xs text-(--muted) truncate mt-0.5">{a.description}</p>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-(--accent)/12 text-(--accent-text)">Gedeeld door {a.shared_by}</span>
            {!a.is_active && <span className={chip}>Uit</span>}
            {a.trained_at && <span className={chip}>Getraind</span>}
          </div>
          <RecipientChip agent={a} />
        </div>
        <button type="button" role="switch" aria-checked={a.is_active} aria-label={`${a.name} voor mezelf ${a.is_active ? 'uitzetten' : 'aanzetten'}`}
          disabled={busy} className="ll-switch disabled:opacity-50" onClick={onSwitch} />
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label="Bekijken" title="Bekijken" className={clsx('icon-btn ak-pen', open && 'is-on')}>{eyeIcon}</button>
      </div>
      <div className={clsx('ll-fold', !open && 'is-shut')}>
        <div>
          <div className="ak-panel">
            {seen && (
              <div className="ak-fade pt-1">
                <AgentForm embedded readOnly initial={toInput(a)} modelOptions={modelOptions} accounts={accounts} onCancel={onToggle} onSave={async () => undefined} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The user's own agents: each with a name, avatar, model and prompt; Claude calls them in when their task comes up. */
export default function AgentsPage() {
  const [list, setList] = useState<AgentDef[] | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [err, setErr] = useState('');
  const [accounts, setAccounts] = useState<ClaudeAccountInfo[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);

  const [conns, setConns] = useState<Array<{ name: string; type: string; agent_ids: string[] }>>([]);
  const setLists = (agents: AgentDef[]) => { setList(agents); setAgentsCache(agents); };
  const apply = (agents: AgentDef[]) => { setLists(agents); setEditing(null); };
  const refresh = () => { agentsApi.list().then((r) => setLists(r.agents)).catch(() => {}); };
  useEffect(() => {
    agentsApi.list().then((r) => { setList(r.agents); setAgentsCache(r.agents); }).catch((e) => setErr((e as Error).message));
    claudeAuth.accounts().then((r) => setAccounts(r.accounts)).catch(() => {});
    connApi.list().then((r) => setConns(r.connectors.filter((c) => c.is_active && Array.isArray(c.config?.agent_ids) && (c.config.agent_ids as string[]).length)
      .map((c) => ({ name: c.name, type: c.type, agent_ids: c.config.agent_ids as string[] })))).catch(() => {});
    modelsApi.list().then((r) => setModelOptions(r.models.filter((m) => m.id !== 'opusplan').map((m) => ({ id: m.id, label: m.label })))).catch(() => {});
  }, []);

  const toInput = (a: AgentDef): AgentInput => ({ name: a.name, description: a.description, prompt: a.prompt, model: a.model, avatar: a.avatar, color: a.color, is_active: a.is_active, account_slots: a.account_slots ?? null });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-(--text)">Agents</h1>
          <p className="text-sm text-(--muted)">Eigen helpers met een vaste taak. Komt die taak in een gesprek langs, dan haalt Claude de agent erbij en antwoordt hij in een eigen balonnetje. Je kunt er ook een aanroepen met @naam. Alleen zichtbaar voor jouw account.</p>
        </div>
        {editing !== 'new' && (
          <button onClick={() => { setEditing('new'); setOpenId(null); }} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium">Nieuwe agent</button>
        )}
      </div>
      {err && <p className="text-sm text-red-400">{err}</p>}

      {editing === 'new' && (
        <AgentForm isNew initial={EMPTY} modelOptions={modelOptions} accounts={accounts} onCancel={() => setEditing(null)}
          onSave={async (a) => apply((await agentsApi.create(a)).agents)} />
      )}

      {list && !list.length && editing !== 'new' && <p className="text-sm text-(--muted)">Nog geen agents.</p>}

      <div className="space-y-3">
        {(list ?? []).map((a, i) => a.shared_by ? (
          <SharedCard key={a.id} a={a} i={i} open={openId === a.id} onToggle={() => setOpenId((o) => (o === a.id ? null : a.id))}
            modelOptions={modelOptions} accounts={accounts} toInput={toInput} busy={switching === a.id}
            onSwitch={async () => {
              setSwitching(a.id); setErr('');
              try { const r = await agentsApi.setMine(a.id, !a.is_active); setLists(r.agents); } catch (e) { setErr((e as Error).message); } finally { setSwitching(null); }
            }} />
        ) : (
          <AgentCard key={a.id} a={a} i={i} open={openId === a.id} onToggle={() => setOpenId((o) => (o === a.id ? null : a.id))}
            accounts={accounts} limited={conns.filter((c) => c.agent_ids.includes(a.id)).map((c) => c.name)} modelOptions={modelOptions}
            toInput={toInput} setLists={setLists} onSaved={setLists} onDeleted={(l) => { setLists(l); setOpenId(null); }} refresh={refresh} />
        ))}
      </div>
    </div>
  );
}
