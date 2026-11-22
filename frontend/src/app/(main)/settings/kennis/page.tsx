'use client';

import { useEffect, useState } from 'react';
import { useFocusParam } from '@/components/useFocusParam';

interface Lesson { id: string; topic: string; lesson: string; created_at: string; author: string | null }

/** Shared knowledge: technical lessons Claude learned about the app and connectors, for every account. */
export default function KennisPage() {
  const [list, setList] = useState<Lesson[] | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const load = () => fetch('/api/lessons', { credentials: 'include' }).then(async (r) => {
    const d = await r.json(); if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`); setList(d.lessons);
  }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);

  async function remove(l: Lesson) {
    if (!confirm('Deze les verwijderen?')) return;
    await fetch(`/api/lessons/${l.id}`, { method: 'DELETE', credentials: 'include' });
    void load();
  }

  const shown = (list ?? []).filter((l) => !q || `${l.topic} ${l.lesson}`.toLowerCase().includes(q.toLowerCase()));
  const topics = [...new Set(shown.map((l) => l.topic))];
  useFocusParam(!!list);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-(--text)">Gedeelde kennis</h1>
          <p className="text-sm text-(--muted)">Technische lessen voor alle accounts. Persoonlijke zaken staan in de eigen memory per account.</p>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken"
          className="w-48 bg-(--input) border border-(--border) rounded-lg px-3 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent)" />
      </div>
      {err && <p className="text-sm text-red-400">{err}</p>}
      {list && !list.length && <p className="text-sm text-(--muted)">Nog niets geleerd.</p>}
      {topics.map((t) => (
        <section key={t} className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-(--muted)">{t}</h2>
          <div className="rounded-xl border border-(--border) bg-(--input) divide-y divide-(--border)">
            {shown.filter((l) => l.topic === t).map((l) => (
              <div key={l.id} data-focus-id={l.id} className="flex items-start gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-(--text)">{l.lesson}</p>
                  <p className="text-xs text-(--muted) mt-0.5">{new Date(l.created_at).toLocaleDateString('nl-NL')}{l.author ? ` · via ${l.author}` : ''}</p>
                </div>
                <button onClick={() => void remove(l)} className="text-xs text-red-400 hover:underline shrink-0">Verwijderen</button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
