'use client';

import { useState, useEffect } from 'react';
import EmptyState from '@/components/ui/EmptyState';
import { NavIcons } from '@/components/navItems';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';

type BackupManifest = {
  timestamp: string;
  postgresVersion: string;
  dumpSizeBytes: number;
  configSizeBytes: number;
  workspaceSizeBytes?: number;
  homesSizeBytes?: number;
  status: 'ok' | 'error';
  error?: string;
};
type BackupEntry = { name: string; manifest: BackupManifest };

export default function BackupsPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (user && user.role !== 'admin') router.replace('/settings');
  }, [user, router]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/backups', { credentials: 'include' });
      const data = await res.json() as { backups?: BackupEntry[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Fout bij laden backups');
      setBackups(data.backups ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate() {
    setCreating(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/backups/now', { method: 'POST', credentials: 'include' });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Backup mislukt');
      await load();
      setMsg('✓ Backup aangemaakt');
    } catch (e) {
      setMsg(`Fout: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleRestore(name: string) {
    if (!confirm(`Backup ${name} terugzetten? Dit overschrijft alle huidige data.`)) return;
    setRestoring(name);
    setMsg('');
    try {
      const res = await fetch(`/api/admin/backups/${encodeURIComponent(name)}/restore`, {
        method: 'POST', credentials: 'include',
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Restore mislukt');
      setMsg('✓ Database teruggezet. Backend herstart.');
    } catch (e) {
      setMsg(`Fout: ${(e as Error).message}`);
    } finally {
      setRestoring(null);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Backup ${name} verwijderen? Dit kan niet ongedaan gemaakt worden.`)) return;
    setMsg('');
    try {
      const res = await fetch(`/api/admin/backups/${encodeURIComponent(name)}`, {
        method: 'DELETE', credentials: 'include',
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Verwijderen mislukt');
      await load();
      setMsg(`✓ Backup ${name} verwijderd`);
    } catch (e) {
      setMsg(`Fout: ${(e as Error).message}`);
    }
  }

  if (!user || user.role !== 'admin') return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text)]">Backups</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            Dagelijks om 03:00, max 7.
          </p>
        </div>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="shrink-0 bg-[var(--input)] hover:bg-[var(--border)] disabled:opacity-50 border border-[var(--border)]
                     text-[var(--text)] text-sm font-medium px-4 py-2 rounded-lg transition-colors whitespace-nowrap"
        >
          {creating ? 'Backup maken…' : 'Nu backup maken'}
        </button>
      </div>

      {msg && (
        <div className={`rounded-lg px-4 py-3 text-sm ${
          msg.startsWith('✓')
            ? 'bg-green-500/10 border border-green-500/30 text-green-400'
            : 'bg-red-500/10 border border-red-500/30 text-red-400'
        }`}>
          {msg}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-[var(--muted)] text-sm">Laden…</div>
      ) : backups.length === 0 ? (
        <EmptyState icon={NavIcons.backups('w-5 h-5')} title="Nog geen backups"
          text="Elke nacht om 03:00 wordt er automatisch een gemaakt. Je kunt er ook nu een maken."
          action={{ label: creating ? 'Backup maken…' : 'Nu backup maken', onClick: () => void handleCreate(), disabled: creating }} />
      ) : (
        <div className="bg-[var(--input)] border border-[var(--border)] rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--muted)]">Datum</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--muted)]">Database</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--muted)]">Werkruimtes</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--muted)]">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => {
                const date = new Date(b.manifest.timestamp);
                const formatted = date.toLocaleString('nl-NL', {
                  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                });
                const dbSize = b.manifest.dumpSizeBytes > 0
                  ? (b.manifest.dumpSizeBytes / 1_048_576).toFixed(1) + ' MB' : '—';
                const wsSize = (b.manifest.workspaceSizeBytes ?? 0) > 0
                  ? ((b.manifest.workspaceSizeBytes ?? 0) / 1_048_576).toFixed(1) + ' MB' : '—';
                return (
                  <tr key={b.name} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-3 text-[var(--text)]">{formatted}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{dbSize}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{wsSize}</td>
                    <td className="px-4 py-3">
                      {b.manifest.status === 'ok' ? (
                        <span className="text-xs bg-green-500/15 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full">OK</span>
                      ) : (
                        <span className="text-xs bg-red-500/15 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-full" title={b.manifest.error}>Fout</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-1">
                        <a
                          href={`/api/admin/backups/${encodeURIComponent(b.name)}/download`}
                          download={`backup-${b.name}.tar.gz`}
                          className="text-xs text-[var(--muted)] hover:text-[var(--text)] px-2 py-1 rounded
                                     hover:bg-[var(--input)] transition-colors"
                        >
                          Downloaden
                        </a>
                        <button
                          onClick={() => handleRestore(b.name)}
                          disabled={b.manifest.status !== 'ok' || restoring !== null}
                          className="text-xs text-[var(--accent)] hover:opacity-80 px-2 py-1 rounded
                                     hover:bg-[var(--accent)]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {restoring === b.name ? 'Terugzetten…' : 'Terugzetten'}
                        </button>
                        <button
                          onClick={() => handleDelete(b.name)}
                          disabled={restoring !== null}
                          className="text-xs text-red-400 hover:opacity-80 px-2 py-1 rounded
                                     hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Verwijderen
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
