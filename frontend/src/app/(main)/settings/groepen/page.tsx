'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import EmptyState from '@/components/ui/EmptyState';
import { NavIcons } from '@/components/navItems';
import { useAuthStore } from '@/lib/store';
import { groupsApi, type UserGroup } from '@/lib/api';

const field = 'w-full px-3.5 py-2.5 rounded-control bg-(--input) border border-(--border) text-(--text) text-sm placeholder-(--muted) outline-none focus:border-(--accent) transition-colors';

type Person = { id: string; name: string };

/** Name + members of one group (or a new one). */
function GroupForm({ initial, people, onSave, onCancel, onDelete }: {
  initial: { name: string; members: string[] }; people: Person[];
  onSave: (name: string, members: string[]) => Promise<void>; onCancel: () => void; onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [members, setMembers] = useState<string[]>(initial.members);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await onSave(name.trim(), members); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="tr-line rounded-card border border-(--border) bg-(--input) p-4 space-y-3">
      <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Naam van de groep" maxLength={60} required autoFocus />
      <div className="grid gap-2 sm:grid-cols-2">
        {people.map((p) => {
          const on = members.includes(p.id);
          return (
            <label key={p.id} className={clsx('min-h-11 rounded-xl border px-3 py-2 cursor-pointer transition-colors duration-200 flex items-center gap-2 text-sm text-(--text)',
              on ? 'border-(--accent) bg-(--accent)/10' : 'border-(--border) bg-(--bg) hover:border-(--accent)/50')}>
              <input type="checkbox" checked={on} onChange={() => toggle(p.id)} />
              <span className="truncate">{p.name}</span>
            </label>
          );
        })}
        {!people.length && <p className="text-sm text-(--muted)">Geen gebruikers.</p>}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">{busy ? 'Opslaan…' : 'Opslaan'}</button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-(--muted) hover:text-(--text)">Annuleren</button>
        {onDelete && (
          <button type="button" disabled={busy} className="ml-auto text-sm text-red-400 hover:underline"
            onClick={async () => { if (confirm(`Groep ${initial.name} verwijderen?`)) { setBusy(true); try { await onDelete(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } } }}>
            Verwijderen
          </button>
        )}
      </div>
    </form>
  );
}

/** Beheer: simple user groups (admins only). Groups are used to share agents. */
export default function GroupsPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [groups, setGroups] = useState<UserGroup[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { if (user && user.role !== 'admin') router.replace('/settings'); }, [user, router]);
  useEffect(() => {
    if (user?.role !== 'admin') return;
    groupsApi.list().then((r) => { setGroups(r.groups); setPeople(r.users); }).catch((e) => setErr((e as Error).message));
  }, [user]);
  if (!user || user.role !== 'admin') return null;

  const apply = (g: UserGroup[]) => { setGroups(g); setEditing(null); };
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? '?';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-(--text)">Groepen</h1>
          <p className="text-sm text-(--muted)">Zet gebruikers in een groep om er sneller iets mee te delen, bijvoorbeeld een agent.</p>
        </div>
        {editing !== 'new' && (
          <button onClick={() => setEditing('new')} className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium">Nieuwe groep</button>
        )}
      </div>
      {err && <p className="text-sm text-red-400">{err}</p>}

      {editing === 'new' && (
        <GroupForm initial={{ name: '', members: [] }} people={people} onCancel={() => setEditing(null)}
          onSave={async (n, m) => apply((await groupsApi.create(n, m)).groups)} />
      )}

      {groups && !groups.length && editing !== 'new' && (
        <EmptyState icon={NavIcons.users('w-5 h-5')} title="Nog geen groepen" text="Een groep is een lijstje gebruikers met een naam."
          action={{ label: 'Groep maken', onClick: () => setEditing('new') }} />
      )}

      <div className="space-y-3">
        {(groups ?? []).map((g, i) => editing === g.id ? (
          <GroupForm key={g.id} initial={{ name: g.name, members: g.members }} people={people} onCancel={() => setEditing(null)}
            onSave={async (n, m) => apply((await groupsApi.update(g.id, n, m)).groups)}
            onDelete={async () => apply((await groupsApi.remove(g.id)).groups)} />
        ) : (
          <button key={g.id} onClick={() => setEditing(g.id)} style={{ '--i': Math.min(i, 10) } as React.CSSProperties}
            className="wa-row-in w-full text-left rounded-xl border border-(--border) bg-(--input) hover:border-(--accent) transition-colors px-4 py-3">
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-(--text)">{g.name}</span>
              <span className="text-xs text-(--muted)">{g.members.length} {g.members.length === 1 ? 'lid' : 'leden'}</span>
            </span>
            {g.members.length > 0 && <span className="block text-xs text-(--muted) truncate mt-0.5">{g.members.map(nameOf).join(', ')}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
