'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { admin, type AppUpdateStatus } from '@/lib/api';

const day = (iso: string) => new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Admins only: is this installation on the latest commit of its GitHub branch, and if not, update
 * (git pull + rebuild of the touched services). While the backend restarts, it keeps polling.
 */
export default function AppUpdate() {
  const [s, setS] = useState<AppUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [waiting, setWaiting] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  async function check() {
    setChecking(true); setErr('');
    try { setS(await admin.updateStatus()); } catch (e) { setErr((e as Error).message); } finally { setChecking(false); }
  }
  useEffect(() => { void check(); return () => { if (poll.current) clearInterval(poll.current); }; }, []);

  async function update() {
    if (!s?.latest || !confirm(`Bijwerken naar ${s.latest.sha}? De app herstart; lopende antwoorden en agents worden afgebroken.`)) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await admin.runUpdate();
      setMsg(r.message);
      if (!r.services.length) { void check(); return; }
      setWaiting(true);
      const target = s.latest.sha;
      // the backend goes down during the rebuild; wait until it answers on the new version
      poll.current = setInterval(async () => {
        try {
          const n = await admin.updateStatus();
          if (n.lastError && !n.updating) { setS(n); setWaiting(false); setMsg(''); setErr(n.lastError); if (poll.current) clearInterval(poll.current); return; }
          setS(n);
          if (n.current?.sha === target && !n.updating) { setS(n); setWaiting(false); setMsg(`Bijgewerkt naar ${target}. Herlaad de pagina voor de nieuwe versie.`); if (poll.current) clearInterval(poll.current); }
        } catch { /* backend restarting */ }
      }, 10_000);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const upToDate = s?.available && s.behind === 0;
  return (
    <div>
      <label className="block text-sm text-(--muted) mb-1.5">App-versie</label>
      <div className="rounded-lg border border-(--border) bg-(--input) p-3 space-y-2">
        {!s && !err && <div className="h-10 rounded bg-(--border)/40 animate-pulse" />}
        {s && (
          <div className="tr-line flex flex-wrap items-center gap-2 text-sm">
            <span className={clsx('w-2 h-2 rounded-full shrink-0', !s.available ? 'bg-(--muted)' : upToDate ? 'bg-emerald-500' : 'bg-amber-500')} />
            <span className="text-(--text)">
              {!s.available ? 'Controle niet mogelijk' : upToDate ? 'Je hebt de laatste versie' : `Update beschikbaar: ${s.behind} nieuwe wijziging${s.behind === 1 ? '' : 'en'}`}
            </span>
            {s.current && <span className="text-xs text-(--muted) font-mono">{s.current.sha} · {day(s.current.date)}</span>}
          </div>
        )}
        {s?.repo && <p className="text-xs text-(--muted)">{s.repo} ({s.branch}){s.ahead ? ` · ${s.ahead} eigen commit(s) niet op GitHub` : ''}{s.dirty ? ` · ${s.dirty} lokaal gewijzigd (blijven behouden)` : ''}</p>}
        {s?.reason && <p className="tr-line text-xs text-amber-500">{s.reason}</p>}
        {!!s?.incoming.length && (
          <ul className="tr-line text-xs space-y-1 max-h-40 overflow-y-auto">
            {s.incoming.map((c) => (
              <li key={c.sha} className="flex gap-2"><span className="font-mono text-(--muted) shrink-0">{c.sha}</span><span className="text-(--text)">{c.subject}</span></li>
            ))}
          </ul>
        )}
        {msg && <p className="tr-line text-xs text-emerald-500">{msg}{waiting ? ` ${s?.phase ?? 'Bezig met bouwen en herstarten'}…` : ''}</p>}
        {err && <p className="tr-line text-xs text-red-400">{err}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" onClick={() => void check()} disabled={checking || busy || waiting}
            className="px-3 py-1.5 rounded-lg border border-(--border) text-sm text-(--text) hover:border-(--accent) transition-colors disabled:opacity-50">
            {checking ? 'Controleren…' : 'Opnieuw controleren'}
          </button>
          {s?.available && s.behind > 0 && (
            <button type="button" onClick={() => void update()} disabled={busy || waiting || s.updating || !!s.ahead}
              className="tr-line px-3 py-1.5 rounded-lg bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">
              {busy ? 'Starten…' : waiting || s.updating ? 'Bijwerken…' : 'Bijwerken'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
