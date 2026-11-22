'use client';

import { useEffect, useMemo, useState } from 'react';
import EmptyState from '@/components/ui/EmptyState';
import { NavIcons } from '@/components/navItems';
import clsx from 'clsx';
import { useFocusParam } from '@/components/useFocusParam';

interface Memory {
  id: string; topic: string; content: string; tags: string; pinned: boolean;
  use_count: number; last_used_at: string | null; created_at: string; updated_at: string;
  archived_at?: string | null; archive_reason?: string | null;
}

const field = 'w-full px-3.5 py-2.5 rounded-control bg-(--input) border border-(--border) text-(--text) text-sm placeholder-(--muted) outline-none focus:border-(--accent) transition-colors';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/memory${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
  return d as T;
}

function PinIcon({ on }: { on: boolean }) {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5M9 10.8V4h6v6.8l2.5 2.7V17h-11v-3.5Z" />
    </svg>
  );
}

function Item({ m, onChange }: { m: Memory; onChange: (list: Memory[]) => void }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(m.content);
  const [topic, setTopic] = useState(m.topic);
  const [busy, setBusy] = useState(false);
  const patch = async (body: Partial<Memory>) => {
    setBusy(true);
    try { onChange((await api<{ memories: Memory[] }>(`/${m.id}`, { method: 'PATCH', body: JSON.stringify(body) })).memories); setEdit(false); }
    finally { setBusy(false); }
  };
  return (
    <div className="group flex items-start gap-3 px-4 py-3">
      <button onClick={() => void patch({ pinned: !m.pinned })} disabled={busy}
        title={m.pinned ? 'Losmaken' : 'Vastzetten: altijd in elk gesprek'}
        className={clsx('mt-0.5 shrink-0 transition-colors', m.pinned ? 'text-(--accent)' : 'text-(--muted) opacity-40 group-hover:opacity-100 hover:text-(--text)')}>
        <PinIcon on={m.pinned} />
      </button>
      <div className="flex-1 min-w-0">
        {edit ? (
          <div className="space-y-2">
            <textarea className={field} rows={Math.min(10, Math.max(2, text.split('\n').length + 1))} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex items-center gap-2">
              <input className={`${field} max-w-40 py-1.5`} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="topic" />
              <button onClick={() => void patch({ content: text, topic })} disabled={busy} className="px-3 py-1.5 rounded-control bg-(--accent-strong) text-white text-sm">Opslaan</button>
              <button onClick={() => { setEdit(false); setText(m.content); setTopic(m.topic); }} className="px-3 py-1.5 text-sm text-(--muted) hover:text-(--text)">Annuleren</button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-(--text) whitespace-pre-wrap break-words cursor-text" onClick={() => setEdit(true)}>{m.content}</p>
        )}
        <p className="text-xs text-(--muted) mt-1">
          {m.archived_at && <span className="mr-2 text-amber-500" title="Niet meer in de kern van elk gesprek, wel opzoekbaar. Komt terug zodra het weer gebruikt wordt.">{m.archive_reason === 'samengevoegd' ? 'samengevoegd' : 'gearchiveerd'}</span>}
          {m.tags && <span className="mr-2">{m.tags}</span>}
          {m.use_count > 0 ? `${m.use_count}x gebruikt` : 'nog niet gebruikt'}
          {m.last_used_at && `, laatst ${new Date(m.last_used_at).toLocaleDateString('nl-NL')}`}
          <span className="mx-1">·</span>bijgewerkt {new Date(m.updated_at).toLocaleDateString('nl-NL')}
        </p>
      </div>
      {!edit && (
        <button disabled={busy} onClick={async () => { if (confirm('Dit uit het geheugen verwijderen?')) onChange((await api<{ memories: Memory[] }>(`/${m.id}`, { method: 'DELETE' })).memories); }}
          className="text-xs text-red-400 hover:underline shrink-0 opacity-60 group-hover:opacity-100">Verwijderen</button>
      )}
    </div>
  );
}

/** Personal memory: what Claude remembers about this user, shared by all its sessions and accounts. */
export default function GeheugenPage() {
  const [list, setList] = useState<Memory[] | null>(null);
  const [q, setQ] = useState('');
  const [topic, setTopic] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [nText, setNText] = useState('');
  const [nTopic, setNTopic] = useState('user');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<{ memories: Memory[] }>('').then((d) => setList(d.memories)).catch((e) => setErr((e as Error).message)); }, []);

  const topics = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of list ?? []) c.set(m.topic, (c.get(m.topic) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);
  const shown = (list ?? []).filter((m) => (!topic || m.topic === topic) && (!q || `${m.topic} ${m.tags} ${m.content}`.toLowerCase().includes(q.toLowerCase())));
  const groups = [...new Set(shown.map((m) => m.topic))];
  const pinned = (list ?? []).filter((m) => m.pinned).length;
  useFocusParam(!!list);

  async function doImport() {
    setBusy(true); setNote(''); setErr('');
    try {
      const d = await api<{ added: number; existing: number; memories: Memory[] }>('/import', { method: 'POST' });
      setList(d.memories);
      setNote(d.added ? `${d.added} herinneringen overgenomen uit de memory-bestanden${d.existing ? `, ${d.existing} stonden er al` : ''}.` : 'Niets nieuws gevonden in de memory-bestanden.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const d = await api<{ memories: Memory[] }>('', { method: 'POST', body: JSON.stringify({ topic: nTopic, content: nText }) });
      setList(d.memories); setNText(''); setAdding(false);
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[240px]">
          <h1 className="text-xl font-semibold text-(--text)">Geheugen</h1>
          <p className="text-sm text-(--muted)">Wat Claude over jou onthoudt. Al je sessies en Claude-accounts lezen en schrijven hierin. Alleen de vastgezette en meest gebruikte feiten gaan elk gesprek mee; de rest zoekt Claude op wanneer hij het nodig heeft.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void doImport()} disabled={busy} className="px-3 py-2 rounded-lg border border-(--border) text-sm text-(--text) hover:border-(--muted) disabled:opacity-50">Importeren uit bestanden</button>
          <button onClick={() => setAdding((a) => !a)} className="px-3 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium">Toevoegen</button>
        </div>
      </div>

      {list && (
        <div className="grid grid-cols-3 gap-3">
          {[['Herinneringen', list.length], ['Onderwerpen', topics.length], ['Vastgezet', pinned]].map(([l, n]) => (
            <div key={l} className="rounded-xl border border-(--border) bg-(--input) px-4 py-3">
              <p className="text-2xl font-semibold text-(--text)">{n}</p>
              <p className="text-xs text-(--muted)">{l}</p>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <form onSubmit={add} className="rounded-card border border-(--border) bg-(--input) p-4 space-y-3">
          <textarea autoFocus className={field} rows={3} value={nText} onChange={(e) => setNText(e.target.value)} placeholder="Bijv. Bij klant X staat de firewall op een FortiGate 60F, beheer via ..." required />
          <div className="flex items-center gap-2">
            <input className={`${field} max-w-40 py-1.5`} value={nTopic} onChange={(e) => setNTopic(e.target.value)} placeholder="topic" />
            <button type="submit" disabled={busy} className="px-3 py-1.5 rounded-control bg-(--accent-strong) text-white text-sm">Opslaan</button>
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-1.5 text-sm text-(--muted) hover:text-(--text)">Annuleren</button>
          </div>
        </form>
      )}

      {note && <p className="text-sm text-(--text)">{note}</p>}
      {err && <p className="text-sm text-red-400">{err}</p>}

      {!!list?.length && (
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken"
            className="w-48 bg-(--input) border border-(--border) rounded-lg px-3 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent)" />
          <button onClick={() => setTopic(null)} className={clsx('px-2.5 py-1 rounded-full text-xs border transition-colors', !topic ? 'border-(--accent) text-(--accent)' : 'border-(--border) text-(--muted) hover:text-(--text)')}>Alles</button>
          {topics.map(([t, n]) => (
            <button key={t} onClick={() => setTopic(topic === t ? null : t)}
              className={clsx('px-2.5 py-1 rounded-full text-xs border transition-colors', topic === t ? 'border-(--accent) text-(--accent)' : 'border-(--border) text-(--muted) hover:text-(--text)')}>
              {t} <span className="opacity-60">{n}</span>
            </button>
          ))}
        </div>
      )}

      {list && !list.length && !adding && (
        <EmptyState icon={NavIcons.memory('w-5 h-5')} title="Het geheugen is nog leeg"
          text="Claude vult het vanzelf tijdens gesprekken. Je kunt ook zelf een feit toevoegen of je memory-bestanden importeren."
          action={{ label: 'Feit toevoegen', onClick: () => setAdding(true) }} />
      )}

      {groups.map((g) => (
        <section key={g} className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-(--muted)">{g}</h2>
          <div className="rounded-xl border border-(--border) bg-(--input) divide-y divide-(--border)">
            {shown.filter((m) => m.topic === g).map((m, i) => <div key={m.id} data-focus-id={m.id} className="wa-row-in" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}><Item m={m} onChange={setList} /></div>)}
          </div>
        </section>
      ))}
    </div>
  );
}
