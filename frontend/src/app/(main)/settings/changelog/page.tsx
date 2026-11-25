'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import EmptyState from '@/components/ui/EmptyState';
import { NavIcons } from '@/components/navItems';

type Day = { title: string; items: string[] };

/** Split CHANGELOG.md into days (## heading) with their bullet lines; text before the first heading is ignored. */
function parse(text: string): Day[] {
  const days: Day[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) days.push({ title: line.slice(3).trim(), items: [] });
    else if (line.startsWith('- ') && days.length) days[days.length - 1].items.push(line.slice(2).trim());
  }
  return days;
}

export default function ChangelogPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    if (user && user.role !== 'admin') router.replace('/settings');
  }, [user, router]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/changelog', { credentials: 'include' });
        const data = await res.json() as { text?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Fout bij laden');
        setText(data.text ?? '');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const days = useMemo(() => {
    const all = parse(text);
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all
      .map((d) => ({ ...d, items: d.items.filter((i) => `${d.title} ${i}`.toLowerCase().includes(needle)) }))
      .filter((d) => d.items.length);
  }, [text, q]);

  if (!user || user.role !== 'admin') return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text)]">Wijzigingen</h1>
        <p className="text-sm text-[var(--muted)] mt-1">Wat er in de app is gebouwd of aangepast, nieuwste bovenaan. De assistent houdt dit bij na elke uitrol.</p>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken"
        className="w-full rounded-control border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]" />
      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading ? <p className="text-sm text-[var(--muted)]">Laden…</p>
        : days.length === 0 ? <EmptyState icon={NavIcons.changelog('w-6 h-6')} title={q ? 'Niets gevonden' : 'Nog geen wijzigingen vastgelegd'} />
        : days.map((d) => (
          <section key={d.title} className="space-y-2">
            <h2 className="text-sm font-semibold text-[var(--text)]">{d.title}</h2>
            <ul className="space-y-2">
              {d.items.map((i, k) => (
                <li key={k} className="rounded-card border border-[var(--border)] px-4 py-3 text-sm text-[var(--text)] leading-relaxed">{i}</li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
