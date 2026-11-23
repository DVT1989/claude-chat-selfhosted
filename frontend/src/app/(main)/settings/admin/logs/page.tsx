'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { admin } from '@/lib/api';
import type { AuditLog } from '@/types';

const PAGE_SIZE = 50;

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await admin.getLogs(PAGE_SIZE, offset);
      setLogs(r.logs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-(--text)">Auditlog</h1>
        <Link href="/settings/admin" className="text-xs text-(--accent) hover:underline">
          ← Terug naar admin
        </Link>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm mb-4">
          {error}
        </div>
      )}

      <div className="bg-(--input) border border-(--border) rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-(--border) text-left text-(--muted)">
              <th className="px-3 py-2">Tijd</th>
              <th className="px-3 py-2">Gebruiker</th>
              <th className="px-3 py-2">Actie</th>
              <th className="px-3 py-2">Doel</th>
              <th className="px-3 py-2">IP</th>
              <th className="px-3 py-2">Metadata</th>
            </tr>
          </thead>
          <tbody>
            {loading && logs.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-(--muted) text-center">Laden…</td></tr>
            )}
            {!loading && logs.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-(--muted) text-center">Geen logs.</td></tr>
            )}
            {logs.map((l) => {
              const isOpen = expanded === l.id;
              const meta = l.metadata && Object.keys(l.metadata).length > 0 ? l.metadata : null;
              return (
                <tr key={l.id} className="border-b border-(--border) last:border-0 align-top">
                  <td className="px-3 py-2 text-(--muted) whitespace-nowrap">
                    {new Date(l.created_at).toLocaleString('nl-NL')}
                  </td>
                  <td className="px-3 py-2 text-(--text)">
                    {l.email ?? l.user_id?.slice(0, 8) ?? '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-(--text)">{l.action}</td>
                  <td className="px-3 py-2 text-(--muted)">
                    {l.target_type ?? '—'}{l.target_id ? `:${l.target_id.slice(0, 8)}` : ''}
                  </td>
                  <td className="px-3 py-2 text-(--muted)">{l.ip_address ?? '—'}</td>
                  <td className="px-3 py-2 text-(--muted)">
                    {meta ? (
                      <button
                        onClick={() => setExpanded(isOpen ? null : l.id)}
                        className="text-(--accent) hover:underline"
                      >
                        {isOpen ? 'verberg' : 'toon'}
                      </button>
                    ) : '—'}
                    {isOpen && meta && (
                      <pre className="mt-2 p-2 bg-(--bg) border border-(--border) rounded text-[11px] overflow-auto max-w-[400px]">
                        {JSON.stringify(meta, null, 2)}
                      </pre>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4">
        <button
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          disabled={offset === 0}
          className="text-xs text-(--muted) hover:text-(--text) px-3 py-1.5 rounded border border-(--border) hover:bg-(--input) disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ← Vorige
        </button>
        <span className="text-xs text-(--muted)">
          rij {offset + 1}–{offset + logs.length}
        </span>
        <button
          onClick={() => setOffset(offset + PAGE_SIZE)}
          disabled={logs.length < PAGE_SIZE}
          className="text-xs text-(--muted) hover:text-(--text) px-3 py-1.5 rounded border border-(--border) hover:bg-(--input) disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Volgende →
        </button>
      </div>
    </div>
  );
}
