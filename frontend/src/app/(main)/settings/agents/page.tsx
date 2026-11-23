'use client';

import { useEffect, useRef, useState } from 'react';
import { agentsApi, claudeAuth, models as modelsApi, type AgentDef, type AgentInput, type AgentTraining, type ClaudeAccountInfo, type ShareTargets } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { Bar, time as fmtTime } from '@/components/ClaudeAccounts';
import clsx from 'clsx';
import { AgentAvatar, setAgentsCache } from '@/components/chat/AgentBubble';
import AgentWizard from '@/components/agents/AgentWizard';
import ClaudeLogo from '@/components/ClaudeLogo';

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
 * usage) or a chosen set. Only shown with two or more linked accounts.
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
  return (
    <div className="space-y-2">
      <span className="text-xs text-(--muted)">Claude-account</span>
      <div className="flex gap-1 p-1 rounded-xl border border-(--border) bg-(--bg) max-w-sm" role="radiogroup">
        <button type="button" role="radio" aria-checked={mode === 'all'} className={seg(mode === 'all')}
          onClick={() => { setMode('all'); onChange(null); }}>Alle accounts</button>
        <button type="button" role="radio" aria-checked={mode === 'pick'} className={seg(mode === 'pick')}
          onClick={() => setMode('pick')}>Kies accounts</button>
      </div>
      <div className={clsx('ll-fold', mode !== 'pick' && 'is-shut')}>
        <div>
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
                  {x.usableAt && <span className="tr-line self-start text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">vol, weer bruikbaar om {fmtTime(x.usableAt)}</span>}
                  <Bar label="verbruik" pct={x.usage ? pct : undefined} />
                </label>
              );
            })}
          </div>
          {gone.map((s) => <p key={s} className="tr-line mt-2 text-xs text-amber-500">Account {s + 1} (niet meer gekoppeld): deze agent gebruikt dan alle accounts.</p>)}
          {!chosen.length && <p className="mt-2 text-xs text-(--muted)">Niets gekozen: bij opslaan gebruikt deze agent alle accounts.</p>}
        </div>
      </div>
      {mode === 'all' && <p className="tr-line text-xs text-(--muted)">Claude verdeelt automatisch op basis van verbruik. Geldt voor werkplekken en automatische taken van deze agent.</p>}
      {full && <p className="tr-line text-xs text-amber-500">Alle gekozen accounts zitten aan hun limiet. Deze agent wacht tot Account {full.slot + 1} om {fmtTime(full.usableAt)} weer vrij is.</p>}
    </div>
  );
}

function AgentForm({ initial, modelOptions, accounts, onSave, onCancel, onDelete, isNew }: {
  initial: AgentInput; modelOptions: Array<{ id: string; label: string }>; accounts: ClaudeAccountInfo[];
  onSave: (a: AgentInput) => Promise<void>; onCancel: () => void; onDelete?: () => Promise<void>; isNew?: boolean;
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
    <form onSubmit={submit} className="rounded-card border border-(--border) bg-(--input) p-4 space-y-4">
      <button type="button" onClick={() => setWizard(true)}
        className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left border border-(--claude)/30 hover:border-(--claude)/70 transition-colors"
        style={{ background: 'color-mix(in srgb, var(--claude) 8%, transparent)' }}>
        <ClaudeLogo className="w-6 h-6 shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-(--text)">{isNew || !a.prompt ? 'Uitwerken met Claude' : 'Verbeteren met Claude'}</span>
          <span className="block text-xs text-(--muted)">Beschrijf je idee, beantwoord een paar vragen en Claude vult alles in, inclusief het model.</span>
        </span>
        <svg className="w-4 h-4 text-(--muted) shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m9 5 7 7-7 7" /></svg>
      </button>
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
          <div className="flex flex-wrap items-center gap-1.5">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => set({ color: c })} aria-label={c}
                className={`w-5 h-5 rounded-full ${a.color === c ? 'ring-2 ring-offset-2 ring-offset-(--input) ring-(--text)' : ''}`} style={{ backgroundColor: c }} />
            ))}
            {a.avatar && <button type="button" onClick={() => set({ avatar: null })} className="ml-2 text-xs text-(--muted) hover:underline">Afbeelding weghalen</button>}
          </div>
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
          placeholder="Wie is deze agent, hoe werkt hij, waar let hij op, hoe antwoordt hij?" required />
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
        <label className="flex items-center gap-2 text-sm text-(--text)">
          <input type="checkbox" checked={a.is_active} onChange={(e) => set({ is_active: e.target.checked })} />
          Actief
        </label>
      </div>

      {byClaude.has('model') && modelReason && <p className="text-xs text-(--muted) -mt-2">{modelReason}</p>}
      {accounts.length >= 2 && <AccountPicker slots={a.account_slots} accounts={accounts} onChange={(s) => set({ account_slots: s })} />}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">{busy ? 'Opslaan…' : 'Opslaan'}</button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">Annuleren</button>
        {onDelete && (
          <button type="button" disabled={busy} className="ml-auto text-sm text-red-400 hover:underline"
            onClick={async () => { if (confirm(`${a.name || 'Deze agent'} verwijderen?`)) { setBusy(true); try { await onDelete(); } finally { setBusy(false); } } }}>
            Verwijderen
          </button>
        )}
      </div>
    </form>
  );
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Training on earlier conversations: a button (prominent while the agent has never been trained), a
 * progress bar while it runs, and the knowledge block to read, edit, retrain or undo.
 */
function TrainPanel({ agent }: { agent: AgentDef }) {
  const [t, setT] = useState<AgentTraining | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const running = t?.state === 'wachten' || t?.state === 'bezig';
  const trained = !!(t?.trained_at ?? agent.trained_at);
  const take = (x: AgentTraining) => { setT(x); setDraft(x.knowledge ?? ''); };

  useEffect(() => { agentsApi.trainStatus(agent.id).then(take).catch(() => {}); }, [agent.id]);
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

  return (
    <div className="px-4 pb-3 -mt-1 space-y-2">
      {running ? (
        <div className="tr-line space-y-1.5" role="status">
          <div className="tr-track"><div className={clsx('tr-fill', (!t?.total || t?.state === 'wachten') && 'is-idle')} style={{ width: `${Math.max(pct, 4)}%` }} /></div>
          <p className="text-xs text-(--muted)">Trainen: {label}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {trained ? (
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="tr-line flex items-center gap-1.5 text-xs text-(--muted) hover:text-(--text) transition-colors">
              <svg className={clsx('tr-chev w-3.5 h-3.5', open && 'is-open')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
              Getraind op {fmtDate((t?.trained_at ?? agent.trained_at)!)} met {t?.trained_conversations ?? agent.trained_conversations ?? 0} gesprekken
            </button>
          ) : (
            <button type="button" onClick={start} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control bg-(--accent-strong) text-white text-xs font-medium disabled:opacity-50">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>
              Trainen
            </button>
          )}
          {trained ? (
            <button type="button" onClick={start} disabled={busy}
              className="ml-auto px-2.5 py-1 rounded-control border border-(--border) text-xs text-(--muted) hover:text-(--text) hover:border-(--accent) transition-colors disabled:opacity-50">Trainen</button>
          ) : <span className="text-xs text-(--muted)">Leert van je eerdere gesprekken over dit vakgebied.</span>}
          {t?.state === 'fout' && <span className="tr-line text-xs text-red-400">Training mislukt: {t.error}</span>}
        </div>
      )}
      {err && <p className="text-xs text-red-400">{err}</p>}

      <div className={clsx('ll-fold', !(open && trained && !running) && 'is-shut')}>
        <div>
          <div className="tr-knowledge rounded-xl border border-(--border) p-3 space-y-2 mt-1">
            <span className="block text-xs text-(--muted)">Wat {agent.name} al weet (uit eerdere gesprekken). Staat in zijn prompt; je kunt het hier aanpassen.</span>
            <textarea className={`${field} font-mono text-[13px]`} rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={12000} />
            <div className="flex flex-wrap items-center gap-2">
              {dirty && <button type="button" disabled={busy} onClick={() => act(() => agentsApi.setKnowledge(agent.id, draft))}
                className="px-3 py-1.5 rounded-control bg-(--accent-strong) text-white text-xs font-medium disabled:opacity-50">Opslaan</button>}
              <button type="button" disabled={busy} onClick={start}
                className="px-3 py-1.5 rounded-control border border-(--border) text-xs text-(--text) hover:border-(--accent) transition-colors disabled:opacity-50">Opnieuw trainen</button>
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


/** Admins: who may use this agent. Saves on every change; shared agents run with each user's own account. */
function SharePanel({ agent, onChange }: { agent: AgentDef; onChange: (list: AgentDef[]) => void }) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<ShareTargets | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const vis = agent.visibility ?? 'private';
  const users = agent.share_users ?? [], groups = agent.share_groups ?? [];

  useEffect(() => { if (open && !targets) agentsApi.shareTargets().then(setTargets).catch((e) => setErr((e as Error).message)); }, [open, targets]);

  async function save(v: 'private' | 'selected' | 'all', u: string[], g: string[]) {
    setBusy(true); setErr('');
    try { onChange((await agentsApi.share(agent.id, v, u, g)).agents); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const flip = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const summary = vis === 'all' ? 'Gedeeld met iedereen'
    : vis === 'selected' ? `Gedeeld met ${[users.length && `${users.length} ${users.length === 1 ? 'gebruiker' : 'gebruikers'}`, groups.length && `${groups.length} ${groups.length === 1 ? 'groep' : 'groepen'}`].filter(Boolean).join(' en ') || 'niemand (nog niets gekozen)'}`
    : 'Alleen ik';
  const seg = (on: boolean) => clsx('flex-1 px-3 py-1.5 rounded-lg text-sm transition-colors duration-200 disabled:opacity-60',
    on ? 'bg-(--accent-strong) text-white shadow-sm' : 'text-(--muted) hover:text-(--text)');
  const chip = (on: boolean) => clsx('min-h-11 rounded-xl border px-3 py-2 cursor-pointer transition-colors duration-200 flex items-center gap-2 text-sm text-(--text)',
    on ? 'border-(--accent) bg-(--accent)/10' : 'border-(--border) bg-(--bg) hover:border-(--accent)/50');

  return (
    <div className="px-4 pb-3 -mt-1">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="tr-line flex items-center gap-1.5 text-xs text-(--muted) hover:text-(--text) transition-colors">
        <svg className={clsx('tr-chev w-3.5 h-3.5', open && 'is-open')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
        Delen: {summary}
      </button>
      <div className={clsx('ll-fold', !open && 'is-shut')}>
        <div>
          <div className="space-y-2 pt-2">
            <div className="flex gap-1 p-1 rounded-xl border border-(--border) bg-(--bg) max-w-md" role="radiogroup" aria-label="Zichtbaarheid">
              {([['private', 'Alleen ik'], ['selected', 'Kiezen'], ['all', 'Iedereen']] as const).map(([v, label]) => (
                <button key={v} type="button" role="radio" aria-checked={vis === v} disabled={busy} className={seg(vis === v)}
                  onClick={() => vis !== v && void save(v, users, groups)}>{label}</button>
              ))}
            </div>
            <div className={clsx('ll-fold', vis !== 'selected' && 'is-shut')}>
              <div className="space-y-2">
                {!targets && !err && <div className="h-11 rounded-xl bg-(--bg) animate-pulse" />}
                {targets && !!targets.groups.length && (
                  <div className="space-y-1">
                    <span className="text-xs text-(--muted)">Groepen</span>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {targets.groups.map((g) => (
                        <label key={g.id} className={chip(groups.includes(g.id))}>
                          <input type="checkbox" checked={groups.includes(g.id)} disabled={busy} onChange={() => void save('selected', users, flip(groups, g.id))} />
                          <span className="truncate">{g.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {targets && (
                  <div className="space-y-1">
                    <span className="text-xs text-(--muted)">Gebruikers</span>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {targets.users.map((u) => (
                        <label key={u.id} className={chip(users.includes(u.id))}>
                          <input type="checkbox" checked={users.includes(u.id)} disabled={busy} onChange={() => void save('selected', flip(users, u.id), groups)} />
                          <span className="truncate">{u.name}</span>
                        </label>
                      ))}
                      {!targets.users.length && <p className="text-sm text-(--muted)">Geen andere gebruikers.</p>}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <p className="tr-line text-xs text-(--muted)">
              {vis === 'private' ? 'Alleen jij ziet en gebruikt deze agent.'
                : 'Anderen zien hem als "Gedeeld door jou", alleen-lezen, en kunnen hem voor zichzelf aan- of uitzetten. Hij draait met hun eigen account, koppelingen en apparaten; jouw kennisblok en accountkeuze gelden daar niet. Wijzig je de agent, dan krijgt iedereen die versie.'}
            </p>
            {err && <p className="text-xs text-red-400">{err}</p>}
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
  const [modelOptions, setModelOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [err, setErr] = useState('');
  const [accounts, setAccounts] = useState<ClaudeAccountInfo[]>([]);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [switching, setSwitching] = useState<string | null>(null);

  const apply = (agents: AgentDef[]) => { setList(agents); setAgentsCache(agents); setEditing(null); };
  useEffect(() => {
    agentsApi.list().then((r) => { setList(r.agents); setAgentsCache(r.agents); }).catch((e) => setErr((e as Error).message));
    claudeAuth.accounts().then((r) => setAccounts(r.accounts)).catch(() => {});
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
          <button onClick={() => setEditing('new')} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium">Nieuwe agent</button>
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
          <div key={a.id} style={{ '--i': Math.min(i, 10) } as React.CSSProperties}
            className={clsx('wa-row-in rounded-xl border border-(--border) bg-(--input) flex items-center gap-3 px-4 py-3 transition-opacity duration-200', !a.is_active && 'opacity-70')}>
            <AgentAvatar name={a.name} avatar={a.avatar} color={a.color} className="w-10 h-10 text-sm" />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-(--text)">{a.name}</span>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-(--accent)/10 text-(--accent)">Gedeeld door {a.shared_by}</span>
                {!a.is_active && <span className="text-xs px-1.5 py-0.5 rounded bg-(--border) text-(--muted)">uit</span>}
              </div>
              <p className="text-xs text-(--muted) line-clamp-2">{a.description}</p>
            </div>
            <button type="button" role="switch" aria-checked={a.is_active} aria-label={`${a.name} voor mezelf ${a.is_active ? 'uitzetten' : 'aanzetten'}`}
              disabled={switching === a.id} className="ll-switch disabled:opacity-50"
              onClick={async () => {
                setSwitching(a.id); setErr('');
                try { const r = await agentsApi.setMine(a.id, !a.is_active); setList(r.agents); setAgentsCache(r.agents); } catch (e) { setErr((e as Error).message); } finally { setSwitching(null); }
              }} />
          </div>
        ) : editing === a.id ? (
          <AgentForm key={a.id} initial={toInput(a)} modelOptions={modelOptions} accounts={accounts} onCancel={() => setEditing(null)}
            onSave={async (x) => apply((await agentsApi.update(a.id, x)).agents)}
            onDelete={async () => apply((await agentsApi.remove(a.id)).agents)} />
        ) : (
          <div key={a.id} style={{ '--i': Math.min(i, 10) } as React.CSSProperties}
            className="wa-row-in rounded-xl border border-(--border) bg-(--input) hover:border-(--accent) transition-colors">
            <button onClick={() => setEditing(a.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left">
              <AgentAvatar name={a.name} avatar={a.avatar} color={a.color} className="w-10 h-10 text-sm" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-(--text)">{a.name}</span>
                  <span className="text-xs text-(--muted)">{a.model === 'inherit' ? 'model van het gesprek' : a.model}</span>
                  {!a.is_active && <span className="text-xs px-1.5 py-0.5 rounded bg-(--border) text-(--muted)">uit</span>}
                  {accounts.length >= 2 && slotsLabel(a.account_slots) && (
                    <span className="tr-line inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-(--border) text-(--muted)"
                      title={allFull(a.account_slots, accounts) ? 'Alle gekozen accounts zitten aan hun limiet' : undefined}>
                      {allFull(a.account_slots, accounts) && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                      {slotsLabel(a.account_slots)}
                    </span>
                  )}
                </div>
                <p className="text-xs text-(--muted) truncate">{a.description}</p>
              </div>
            </button>
            <TrainPanel agent={a} />
            {isAdmin && <SharePanel agent={a} onChange={(l) => { setList(l); setAgentsCache(l); }} />}
          </div>
        ))}
      </div>
    </div>
  );
}
