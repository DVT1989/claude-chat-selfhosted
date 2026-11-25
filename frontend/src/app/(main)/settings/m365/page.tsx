'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { agentsApi, type AgentDef } from '@/lib/api';
import { AgentAvatar } from '@/components/chat/AgentBubble';
import { M365LevelSeg, M365_LEVELS, type M365Level } from '@/components/M365Level';

interface Tenant {
  id: string; name: string; is_active: boolean; test_status: string | null; test_message: string | null;
  config: { tenantId: string; tenantName: string; account: string; agent_access?: Record<string, M365Level> };
}
interface Login { userCode: string; verificationUri: string; expiresAt: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/m365${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const btn = 'text-sm font-medium px-4 py-2 rounded-lg transition-[filter,transform,background-color] duration-150 active:scale-[0.97] disabled:opacity-50';

/** One agent with access: avatar, name and a two-step segment; saved at once, check mark on success. */
function AccessRow({ agent, level, onSet }: { agent: AgentDef; level: M365Level; onSet: (l: M365Level) => Promise<void> }) {
  const [ok, setOk] = useState(false);
  const [error, setError] = useState(false);
  async function pick(l: M365Level) {
    if (l === level) return;
    setError(false);
    try { await onSet(l); setOk(true); setTimeout(() => setOk(false), 1200); }
    catch { setError(true); setTimeout(() => setError(false), 4000); }
  }
  return (
    <div className="m3-row px-3 sm:px-1 py-1.5">
      <div className="flex items-center gap-3 min-h-9">
        <AgentAvatar name={agent.name} avatar={agent.avatar} color={agent.color} className="w-7 h-7 text-[11px] shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-(--text) truncate">{agent.name}</p>
          <p className="sm:hidden text-xs text-(--muted)">{M365_LEVELS.find((l) => l.v === level)?.full}</p>
        </div>
        <svg className={clsx('m3-ok w-3.5 h-3.5 shrink-0', ok && 'is-on')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12 5 5 9-10" /></svg>
        <M365LevelSeg value={level} onPick={(l) => void pick(l)} label={`Toegang ${agent.name}`} iconsOnMobile />
      </div>
      <div className={clsx('ll-fold', !error && 'is-shut')}>
        <div><p className="text-xs text-red-700 dark:text-red-400 pt-1 pl-10">Opslaan mislukt, probeer opnieuw</p></div>
      </div>
    </div>
  );
}

/** Agents with access to this tenant (switch under Instellingen > Agents > Koppelingen) and their level; "Lezen" gets a token with only read rights. */
function AgentAccess({ tenant, agents }: { tenant: Tenant; agents: AgentDef[] }) {
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<Record<string, M365Level>>(tenant.config.agent_access ?? {});
  const withAccess = agents.filter((a) => access[a.id]);
  const nRead = withAccess.filter((a) => access[a.id] === 'read').length;
  const summary = withAccess.length ? `${nRead} lezen, ${withAccess.length - nRead} lezen en schrijven` : 'geen agent heeft toegang';
  async function set(id: string, l: M365Level) {
    const next = { ...access, [id]: l };
    await api(`/tenants/${tenant.id}/access`, { method: 'PUT', body: JSON.stringify({ access: next }) });
    setAccess(next);
  }
  return (
    <div className="px-4 pb-3 -mt-1">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1.5 text-xs text-(--muted) hover:text-(--text) transition-colors">
        <svg className={clsx('m3-chev w-3.5 h-3.5', open && 'is-open')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
        Rechten per agent: {summary}
      </button>
      <div className={clsx('ll-fold', !open && 'is-shut')} inert={!open}>
        <div>
          {withAccess.length ? (
            <div className="divide-y divide-(--border) -mx-3 sm:mx-0 pt-1">
              {withAccess.map((a) => <AccessRow key={a.id} agent={a} level={access[a.id]} onSet={(l) => set(a.id, l)} />)}
            </div>
          ) : (
            <p className="text-sm text-(--muted) py-2">Geen agent heeft toegang. Geef toegang via <a href="/settings/agents" className="underline underline-offset-2 hover:text-(--text)">Instellingen &gt; Agents &gt; Koppelingen</a>.</p>
          )}
          <p className="text-xs text-(--muted) pt-2 pb-1">Een agent heeft toegang zodra je hem bij Instellingen &gt; Agents &gt; Koppelingen aanzet; standaard mag hij alleen lezen. Lezen: alleen bekijken. Lezen en schrijven: ook wijzigen. Afgedwongen: een agent zonder toegang krijgt het token niet en wordt geblokkeerd, ook als hulpagent in de gewone chat. Jouw eigen Claude houdt volledige toegang.</p>
        </div>
      </div>
    </div>
  );
}

export default function M365Page() {
  const [agents, setAgents] = useState<AgentDef[]>([]);
  useEffect(() => { agentsApi.list().then((r) => setAgents(r.agents.filter((a) => !a.shared_by))).catch(() => {}); }, []);
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
          <div key={t.id}>
          <div className="flex items-center gap-3 px-4 py-3">
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
          <AgentAccess tenant={t} agents={agents} />
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
