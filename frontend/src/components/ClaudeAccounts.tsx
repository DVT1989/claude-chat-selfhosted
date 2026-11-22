'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { claudeAuth, type ClaudeAccountInfo } from '@/lib/api';

const time = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const t = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
  if (d.getTime() - Date.now() < 20 * 3_600_000) return t;
  return `${d.toLocaleDateString('nl-NL', { weekday: 'short', timeZone: 'Europe/Amsterdam' })} ${t}`;
};

function Bar({ label, pct, resetAt }: { label: string; pct: number | undefined; resetAt?: string | null }) {
  const p = Math.round(pct ?? 0);
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-baseline justify-between text-[11px] text-(--muted)">
        <span>{label}</span><span className="tabular-nums text-(--text)">{pct === undefined ? '–' : `${p}%`}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-(--border) overflow-hidden">
        <div className={clsx('h-full rounded-full', p >= 95 ? 'bg-red-500' : p >= 80 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.max(2, p)}%` }} />
      </div>
      {resetAt && <p className="mt-1 text-[11px] text-(--muted) tabular-nums">reset {time(resetAt)}</p>}
    </div>
  );
}

/**
 * Several Claude subscriptions: account 1 is used until it is at 95% (session or week), then the
 * next account with room takes over; conversations are shared, so they just continue.
 */
export default function ClaudeAccounts() {
  const [accounts, setAccounts] = useState<ClaudeAccountInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  function load() {
    claudeAuth.accounts().then((r) => setAccounts(r.accounts)).catch((e: Error) => setError(e.message));
  }
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);

  // all accounts full: the one that frees up first (a waiting answer continues there)
  const firstFree = accounts && accounts.length > 1 && accounts.every((a) => a.usableAt)
    ? accounts.reduce((b, a) => (Date.parse(a.usableAt!) < Date.parse(b.usableAt!) ? a : b)).slot
    : null;

  async function startAdd() {
    setError(''); setMsg(''); setBusy(true);
    try {
      const r = await claudeAuth.start(true);
      setUrl(r.url); setAdding(true);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function submit() {
    if (!code.trim()) return;
    setError(''); setBusy(true);
    try {
      await claudeAuth.submitCode(code.trim());
      setAdding(false); setUrl(null); setCode('');
      setMsg('Account toegevoegd.');
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function remove(a: ClaudeAccountInfo) {
    if (!confirm(`Account ${a.slot + 1}${a.email ? ` (${a.email})` : ''} ontkoppelen? Je gesprekken blijven bewaard.`)) return;
    try { await claudeAuth.removeAccount(a.slot); load(); } catch (e) { alert((e as Error).message); }
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-semibold text-(--text)">Claude-abonnementen</h2>
          <p className="text-sm text-(--muted) mt-1 max-w-2xl">
            Account 1 eerst; bij 95% sessie of week neemt het volgende account het over.
          </p>
        </div>
        {!adding && (
          <button onClick={() => void startAdd()} disabled={busy}
            className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">
            + Abonnement toevoegen
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-card border border-(--border) bg-(--input) p-5 mb-4 space-y-3">
          <p className="text-sm text-(--text)">
            Log in met het <strong>andere</strong> Claude-account in het venster dat net openging
            {url && <> (<a href={url} target="_blank" rel="noreferrer" className="text-(--accent) underline">opnieuw openen</a>)</>}.
            Kopieer daarna de code en plak die hier.
          </p>
          <div className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code#state…" autoComplete="off" spellCheck={false}
              aria-label="Inlogcode van het tweede account"
              className="flex-1 min-w-0 px-3.5 py-2.5 rounded-control bg-(--bg) border border-(--border) text-(--text) text-sm font-mono outline-none focus:border-(--accent)" />
            <button onClick={() => void submit()} disabled={busy || !code.trim()}
              className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">
              {busy ? 'Koppelen…' : 'Koppelen'}
            </button>
            <button onClick={() => { setAdding(false); setUrl(null); setCode(''); }} className="px-3 py-2 text-sm text-(--muted) hover:text-(--text)">Annuleren</button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      {msg && <p className="text-sm text-green-400 mb-3">{msg}</p>}

      {accounts === null ? (
        <div className="h-16 rounded-card bg-(--input) animate-pulse" />
      ) : (
        <ul className="rounded-card border border-(--border) divide-y divide-(--border) overflow-hidden">
          {accounts.map((a) => (
            <li key={a.slot} className="px-4 py-3 bg-(--input)">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-(--text)">Account {a.slot + 1}</span>
                    {a.active && <span className="text-[11px] px-2 py-0.5 rounded-full bg-(--accent)/15 text-(--accent) border border-(--accent)/30">in gebruik</span>}
                    {a.usableAt && <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">vol, weer bruikbaar om {time(a.usableAt)}</span>}
                    {a.usableAt && firstFree === a.slot && <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">eerst weer vrij</span>}
                    {a.plan && <span className="text-[11px] text-(--muted) uppercase tracking-wide">{a.plan}</span>}
                  </div>
                  {a.email && <p className="text-xs text-(--muted) truncate mt-0.5">{a.email}</p>}
                </div>
                {a.slot > 0 && (
                  <button onClick={() => void remove(a)} className="shrink-0 text-xs text-(--muted) hover:text-red-400 px-2 py-1 rounded hover:bg-red-500/10">
                    Ontkoppelen
                  </button>
                )}
              </div>
              <div className="flex gap-4 mt-2.5">
                <Bar label="Sessie" pct={a.usage?.session?.pct} resetAt={a.usage?.session?.resetAt} />
                <Bar label="Week" pct={a.usage?.weekly?.pct} resetAt={a.usage?.weekly?.resetAt} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
