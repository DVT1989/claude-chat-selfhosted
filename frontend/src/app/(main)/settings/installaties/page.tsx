'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import EmptyState from '@/components/ui/EmptyState';
import { NavIcons } from '@/components/navItems';
import { useAuthStore } from '@/lib/store';

const API = '/api/federation/admin';
const KINDS: Array<[string, string]> = [
  ['agents', 'Agents'], ['skills', 'Skills'], ['memories', 'Eigen geheugen'], ['lessons', 'Gedeelde lessen'],
  ['tasks', 'Taken'], ['projects', 'Projecten'], ['conversations', 'Gesprekken'],
];

type Peer = {
  id: string; name: string; url: string; remote_name: string | null; direction: string | null; enabled: boolean; nightly: boolean; all_users: boolean;
  kinds: Record<string, boolean>; status: string; status_message: string | null; last_sync_at: string | null;
  last_result: Record<string, { created: number; updated: number; conflicts: number; errors: number; pushed: number }> | null; open_conflicts: number;
};
type Key = { id: string; name: string; direction: 'read' | 'readwrite'; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
type Conflict = { id: string; install_name: string | null; kind: string; name: string; remote: unknown; local: unknown };

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method, credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Fout ${res.status}`);
  return data;
}

const fmt = (d: string | null) => d ? new Date(d).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'nog niet';
const card = 'bg-[var(--input)] border border-[var(--border)] rounded-xl p-4';
const btn = 'text-sm px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--input)] hover:bg-[var(--border)] text-[var(--text)] transition-colors disabled:opacity-50';
const field = 'w-full bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]';

function Badge({ p }: { p: Peer }) {
  const m: Record<string, [string, string]> = {
    ok: ['Verbonden', 'bg-green-500/15 text-green-400 border-green-500/30'],
    syncing: ['Bezig…', 'bg-blue-500/15 text-blue-400 border-blue-500/30'],
    conflicts: ['Conflicten', 'bg-amber-500/15 text-amber-400 border-amber-500/30'],
    error: ['Fout', 'bg-red-500/15 text-red-400 border-red-500/30'],
    new: ['Nieuw', 'bg-[var(--border)] text-[var(--muted)] border-[var(--border)]'],
  };
  const [t, c] = m[p.status] ?? m.new;
  return <span className={`text-xs border px-2 py-0.5 rounded-full ${c}`} title={p.status_message ?? ''}>{t}</span>;
}

export default function InstallatiesPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [self, setSelf] = useState<{ id: string; name: string } | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyForm, setKeyForm] = useState({ name: '', direction: 'read' });
  const [peerForm, setPeerForm] = useState({ name: '', url: '', apiKey: '', allUsers: false });
  const [open, setOpen] = useState<string | null>(null);
  const [selfName, setSelfName] = useState('');

  useEffect(() => { if (user && user.role !== 'admin') router.replace('/settings'); }, [user, router]);

  const load = useCallback(async () => {
    try {
      const [s, p, k, c] = await Promise.all([
        api<{ id: string; name: string }>('/self'), api<{ peers: Peer[] }>('/peers'), api<{ keys: Key[] }>('/keys'), api<{ conflicts: Conflict[] }>('/conflicts'),
      ]);
      setSelf(s); setSelfName((v) => v || s.name); setPeers(p.peers); setKeys(k.keys); setConflicts(c.conflicts);
    } catch (e) { setMsg(`Fout: ${(e as Error).message}`); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!peers.some((p) => p.status === 'syncing')) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [peers, load]);

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id); setMsg('');
    try { await fn(); setMsg(`✓ ${ok}`); } catch (e) { setMsg(`Fout: ${(e as Error).message}`); }
    setBusy(null); await load();
  }

  if (!user || user.role !== 'admin') return null;
  const live = keys.filter((k) => !k.revoked_at);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text)]">Installaties</h1>
        <p className="text-sm text-[var(--muted)] mt-1">Koppel een andere claude-chat en synchroniseer wat je aanvinkt, elke nacht en op afroep.</p>
      </div>

      {msg && (
        <div role="status" className={`rounded-lg px-4 py-3 text-sm ${msg.startsWith('✓') ? 'bg-green-500/10 border border-green-500/30 text-green-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>{msg}</div>
      )}

      {loading ? <div className="text-[var(--muted)] text-sm">Laden…</div> : (<>
        {conflicts.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-amber-400">Conflicten ({conflicts.length})</h2>
            <p className="text-xs text-[var(--muted)]">Aan beide kanten gewijzigd. Er is niets overschreven; kies welke versie blijft.</p>
            {conflicts.map((c, i) => (
              <div key={c.id} className={`${card} wa-row-in`} style={{ ['--i' as string]: i }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm text-[var(--text)]"><span className="text-[var(--muted)]">{KINDS.find((k) => k[0] === c.kind)?.[1] ?? c.kind}</span> · {c.name}
                    <span className="text-xs text-[var(--muted)]"> · van {c.install_name}</span></div>
                  <div className="flex gap-2">
                    <button className={btn} disabled={busy === c.id} onClick={() => run(c.id, () => api(`/conflicts/${c.id}/resolve`, 'POST', { choice: 'local' }), 'Lokale versie behouden')}>Lokaal houden</button>
                    <button className={btn} disabled={busy === c.id} onClick={() => run(c.id, () => api(`/conflicts/${c.id}/resolve`, 'POST', { choice: 'remote' }), 'Externe versie overgenomen')}>Extern overnemen</button>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-3 mt-3">
                  {([['Lokaal', c.local], ['Extern', c.remote]] as const).map(([t, v]) => (
                    <div key={t}>
                      <div className="text-xs text-[var(--muted)] mb-1">{t}</div>
                      <pre className="text-xs bg-[var(--bg)] border border-[var(--border)] rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[var(--text)]">{preview(v)}</pre>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-[var(--text)]">Gekoppelde installaties</h2>
          {peers.length === 0 && (
            <EmptyState icon={NavIcons.federation('w-5 h-5')} title="Nog geen installaties gekoppeld"
              text="Maak op de andere installatie een sleutel aan en vul hieronder de URL en de sleutel in." />
          )}
          {peers.map((p, i) => (
            <div key={p.id} className={`${card} wa-row-in`} style={{ ['--i' as string]: i }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-[var(--text)]">{p.name}</span><Badge p={p} />
                    {p.direction && <span className="text-xs text-[var(--muted)]">{p.direction === 'readwrite' ? 'tweerichting' : 'alleen lezen'}</span>}
                    {p.open_conflicts > 0 && <span className="text-xs text-amber-400">{p.open_conflicts} conflict(en)</span>}
                  </div>
                  <div className="text-xs text-[var(--muted)] mt-0.5 truncate">{p.url} · laatste sync: {fmt(p.last_sync_at)}</div>
                  {p.status === 'error' && p.status_message && <div className="text-xs text-red-400 mt-1">{p.status_message}</div>}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button className={btn} disabled={busy === p.id || p.status === 'syncing'} onClick={() => run(p.id, () => api(`/peers/${p.id}/sync`, 'POST', {}), 'Synchronisatie klaar')}>
                    {busy === p.id || p.status === 'syncing' ? 'Bezig…' : 'Nu synchroniseren'}
                  </button>
                  <button className={btn} onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Sluiten' : 'Instellingen'}</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3">
                {KINDS.map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1.5 text-sm text-[var(--text)] cursor-pointer">
                    <input type="checkbox" checked={!!p.kinds[k]} onChange={(e) => run(p.id, () => api(`/peers/${p.id}`, 'PATCH', { kinds: { [k]: e.target.checked } }), `${label} ${e.target.checked ? 'aan' : 'uit'}`)} />
                    {label}
                  </label>
                ))}
                <label className="flex items-center gap-1.5 text-sm text-[var(--muted)] cursor-pointer">
                  <input type="checkbox" checked={p.nightly} onChange={(e) => run(p.id, () => api(`/peers/${p.id}`, 'PATCH', { nightly: e.target.checked }), 'Nachtelijke sync bijgewerkt')} />
                  Elke nacht
                </label>
                <label className="flex items-center gap-1.5 text-sm text-[var(--muted)] cursor-pointer">
                  <input type="checkbox" checked={p.all_users} onChange={(e) => {
                    const on = e.target.checked;
                    if (on && !confirm(`Ook agents, skills, geheugen, taken, projecten en gesprekken van andere gebruikers synchroniseren met ${p.name}?`)) return;
                    void run(p.id, () => api(`/peers/${p.id}`, 'PATCH', { allUsers: on }), on ? 'Alle gebruikers gaan mee' : 'Alleen jouw items gaan mee');
                  }} />
                  Ook andere gebruikers
                </label>
              </div>
              {p.last_result && (
                <div className="text-xs text-[var(--muted)] mt-2">
                  Laatste run: {Object.entries(p.last_result).map(([k, r]) => `${KINDS.find((x) => x[0] === k)?.[1] ?? k} +${r.created} ~${r.updated}${r.pushed ? ` ↑${r.pushed}` : ''}${r.conflicts ? ` !${r.conflicts}` : ''}${r.errors ? ` fout ${r.errors}` : ''}`).join(' · ') || 'niets nieuws'}
                </div>
              )}
              {open === p.id && (
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-[var(--border)]">
                  <button className={btn} onClick={() => run(p.id, () => api(`/peers/${p.id}/test`, 'POST'), 'Verbinding werkt')}>Test verbinding</button>
                  <button className={btn} onClick={() => run(p.id, () => api(`/peers/${p.id}`, 'PATCH', { enabled: !p.enabled }), p.enabled ? 'Gepauzeerd' : 'Hervat')}>{p.enabled ? 'Pauzeren' : 'Hervatten'}</button>
                  <button className={`${btn} text-red-400`} onClick={() => { if (confirm(`Koppeling met ${p.name} verwijderen? Al geïmporteerde items blijven staan.`)) void run(p.id, () => api(`/peers/${p.id}`, 'DELETE'), 'Koppeling verwijderd'); }}>Verwijderen</button>
                </div>
              )}
            </div>
          ))}
          <form className={`${card} space-y-2`} onSubmit={(e) => { e.preventDefault(); void run('peer', async () => { await api('/peers', 'POST', peerForm); setPeerForm({ name: '', url: '', apiKey: '', allUsers: false }); }, 'Installatie gekoppeld'); }}>
            <div className="text-sm text-[var(--text)]">Installatie koppelen</div>
            <div className="grid sm:grid-cols-3 gap-2">
              <input className={field} placeholder="Naam" value={peerForm.name} onChange={(e) => setPeerForm({ ...peerForm, name: e.target.value })} required />
              <input className={field} placeholder="URL, bijv. https://chat.voorbeeld.nl" value={peerForm.url} onChange={(e) => setPeerForm({ ...peerForm, url: e.target.value })} required />
              <input className={field} placeholder="Sleutel (fedk_…)" type="password" autoComplete="off" value={peerForm.apiKey} onChange={(e) => setPeerForm({ ...peerForm, apiKey: e.target.value })} required />
            </div>
            <label className="flex items-start gap-2 text-sm text-[var(--text)] cursor-pointer">
              <input type="checkbox" className="mt-1" checked={peerForm.allUsers} onChange={(e) => setPeerForm({ ...peerForm, allUsers: e.target.checked })} />
              <span>Ook items van andere gebruikers synchroniseren<span className="block text-xs text-[var(--muted)]">Uit: alleen jouw eigen agents, skills, geheugen, taken, projecten en gesprekken. Lessen gaan altijd mee.</span></span>
            </label>
            <button className={btn} disabled={busy === 'peer'}>{busy === 'peer' ? 'Koppelen…' : 'Koppelen'}</button>
          </form>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-[var(--text)]">Sleutels voor andere installaties</h2>
          <p className="text-xs text-[var(--muted)]">Geef een sleutel aan de andere kant om deze installatie te laten lezen (en bij tweerichting ook te schrijven). Hij wordt maar één keer getoond.</p>
          {self && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
              <span>Naam van deze installatie:</span>
              <input className={`${field} !w-48 !py-1`} value={selfName} onChange={(e) => setSelfName(e.target.value)} />
              <button className={btn} disabled={!selfName.trim() || selfName === self.name} onClick={() => run('self', () => api('/self', 'PATCH', { name: selfName }), 'Naam opgeslagen')}>Opslaan</button>
            </div>
          )}
          {newKey && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm" role="status">
              <div className="text-amber-400 mb-1">Bewaar deze sleutel nu, hij wordt niet opnieuw getoond:</div>
              <code className="block break-all text-[var(--text)] select-all">{newKey}</code>
              <button className={`${btn} mt-2`} onClick={() => { void navigator.clipboard?.writeText(newKey); setNewKey(null); }}>Kopieer en sluit</button>
            </div>
          )}
          {live.map((k, i) => (
            <div key={k.id} className={`${card} wa-row-in flex flex-wrap items-center justify-between gap-2`} style={{ ['--i' as string]: i }}>
              <div className="text-sm text-[var(--text)]">{k.name} <span className="text-xs text-[var(--muted)]">· {k.key_prefix}… · {k.direction === 'readwrite' ? 'tweerichting' : 'alleen lezen'} · laatst gebruikt: {fmt(k.last_used_at)}</span></div>
              <button className={`${btn} text-red-400`} onClick={() => { if (confirm(`Sleutel ${k.name} intrekken?`)) void run(k.id, () => api(`/keys/${k.id}`, 'DELETE'), 'Sleutel ingetrokken'); }}>Intrekken</button>
            </div>
          ))}
          <form className={`${card} space-y-2`} onSubmit={(e) => { e.preventDefault(); void run('key', async () => { const r = await api<{ key: string }>('/keys', 'POST', keyForm); setNewKey(r.key); setKeyForm({ name: '', direction: 'read' }); }, 'Sleutel aangemaakt'); }}>
            <div className="text-sm text-[var(--text)]">Nieuwe sleutel</div>
            <div className="grid sm:grid-cols-3 gap-2">
              <input className={field} placeholder="Voor welke installatie?" value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} required />
              <select className={field} value={keyForm.direction} onChange={(e) => setKeyForm({ ...keyForm, direction: e.target.value })}>
                <option value="read">Eenrichting: de ander mag alleen lezen</option>
                <option value="readwrite">Tweerichting: de ander mag lezen en schrijven</option>
              </select>
              <button className={btn} disabled={busy === 'key'}>Sleutel maken</button>
            </div>
          </form>
        </section>
      </>)}
    </div>
  );
}

function preview(v: unknown): string {
  if (v == null) return '(niet meer aanwezig)';
  const o = { ...(v as Record<string, unknown>) };
  if (Array.isArray(o.messages)) o.messages = `${o.messages.length} berichten`;
  if (o.files && typeof o.files === 'object') o.files = Object.keys(o.files as object);
  return JSON.stringify(o, null, 1).slice(0, 2000);
}
