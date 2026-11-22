'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

interface Tenant {
  id: string; name: string; is_active: boolean; test_status: string | null; test_message: string | null;
  config: { tenantId: string; tenantName: string; account: string };
}
interface Login { userCode: string; verificationUri: string; expiresAt: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/m365${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const btn = 'text-sm font-medium px-4 py-2 rounded-lg transition-[filter,transform,background-color] duration-150 active:scale-[0.97] disabled:opacity-50';

export default function M365Page() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [state, setState] = useState<'idle' | 'waiting' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => api<{ tenants: Tenant[] }>('/tenants').then((r) => setTenants(r.tenants)).catch((e) => { setState('error'); setMessage(e.message); });
  useEffect(() => { void load(); return () => { if (timer.current) clearInterval(timer.current); }; }, []);

  async function start() {
    setMessage(''); setState('waiting');
    try {
      const l = await api<Login>('/login', { method: 'POST' });
      setLogin(l);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => {
        const s = await api<{ status: string; message: string | null; tenantName: string | null }>('/login').catch(() => null);
        if (!s || s.status === 'pending') return;
        if (timer.current) clearInterval(timer.current);
        if (s.status === 'done') { setState('done'); setMessage(`${s.tenantName} is gekoppeld.`); setLogin(null); void load(); }
        else { setState('error'); setMessage(s.message ?? 'Inloggen mislukt.'); setLogin(null); }
      }, 2500);
    } catch (e) {
      setState('error'); setMessage((e as Error).message);
    }
  }

  async function remove(t: Tenant) {
    if (!confirm(`Koppeling met ${t.config.tenantName} verwijderen?`)) return;
    await api(`/tenants/${t.id}`, { method: 'DELETE' }).catch(() => undefined);
    void load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-(--text)">Microsoft 365</h1>
        <p className="text-sm text-(--muted) mt-1">
          Lezen, plus Intune-apps uitrollen en bestanden in OneDrive en SharePoint schrijven, alleen op jouw verzoek. Na nieuwe rechten de tenant opnieuw koppelen.
        </p>
      </div>

      {message && (
        <div className={clsx('rounded-lg px-4 py-3 text-sm border',
          state === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-green-500/10 border-green-500/30 text-green-500')}>
          {message}
        </div>
      )}

      <section className="rounded-xl border border-(--border) bg-(--input) divide-y divide-(--border)">
        {tenants?.length === 0 && <p className="px-4 py-4 text-sm text-(--muted)">Nog geen tenants gekoppeld.</p>}
        {tenants?.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-4 py-3">
            <span className="w-8 h-8 rounded-lg bg-sky-600 text-white flex items-center justify-center shrink-0">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z" /></svg>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-(--text) truncate">{t.config.tenantName}</p>
              <p className="text-xs text-(--muted) truncate">{t.config.account} · {t.config.tenantId}</p>
              {t.test_status === 'error' && <p className="text-xs text-red-400 mt-0.5">{t.test_message ?? 'Opnieuw inloggen nodig'}</p>}
            </div>
            <span className={clsx('text-[0.7rem] px-2 py-0.5 rounded-full shrink-0',
              t.test_status === 'error' ? 'bg-red-500/15 text-red-400' : 'bg-green-500/15 text-green-500')}>
              {t.test_status === 'error' ? 'Verlopen' : 'Actief'}
            </span>
            <button onClick={() => void remove(t)} className="text-xs text-(--muted) hover:text-red-400 transition-colors px-2 py-1">Verwijderen</button>
          </div>
        ))}
      </section>

      <section className="rounded-card border border-(--border) bg-(--input) p-4 space-y-4">
        {!login ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-(--text)">Tenant koppelen of een verlopen login vernieuwen</p>
            <button onClick={() => void start()} disabled={state === 'waiting'} className={clsx(btn, 'shrink-0 whitespace-nowrap bg-(--accent-strong) text-white hover:brightness-95')}>
              {state === 'waiting' ? 'Even geduld…' : 'Tenant koppelen'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-(--text)">1. Open <a className="text-(--accent) underline" href={login.verificationUri} target="_blank" rel="noreferrer">{login.verificationUri.replace('https://', '')}</a> en vul deze code in:</p>
            <button
              onClick={() => { void navigator.clipboard.writeText(login.userCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="w-full rounded-xl border border-dashed border-(--border) py-4 font-mono text-2xl tracking-[0.3em] text-(--text) hover:bg-(--bg)/50 transition-colors active:scale-[0.99]"
              title="Kopiëren"
            >
              {login.userCode}
              <span className="block text-xs font-sans tracking-normal text-(--muted) mt-1">{copied ? 'Gekopieerd' : 'Klik om te kopiëren'}</span>
            </button>
            <p className="text-sm text-(--text)">2. Log in met een beheerder van de tenant en geef toestemming (ook namens de organisatie).</p>
            <p className="text-xs text-(--muted) flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" />
              Wacht op je login · code geldig tot {new Date(login.expiresAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
