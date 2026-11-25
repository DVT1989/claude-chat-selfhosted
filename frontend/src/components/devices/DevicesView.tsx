'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { api, ago, getAllUsers, setAllUsers, alertsOf, Badge, btn, Device, DeviceIcon, diskUsedPct, ghost, osLabel, primary, UsageBar } from './shared';

interface Enroll { code: string; expiresAt: string; windowsUrl: string; macCommand: string }
interface ListResponse { devices: Device[]; settings: { requireTotp: boolean }; totpEnabled: boolean; latestAgent: string | null; isAdmin: boolean }

/** Koppelingen tab: one line per device with rename, on/off, agent update and unlink. */
function ManageRow({ d, latest, onChanged, showOwner }: { d: Device; latest: string | null; onChanged: () => void; showOwner: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true); setErr(''); setNote('');
    try { await fn(); if (done) setNote(done); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const isNas = d.os === 'nasbrowser';
  const outdated = !isNas && !!latest && !!d.agent_version && d.agent_version !== latest;
  const mb = 'max-sm:min-h-[44px] max-sm:px-2.5 whitespace-nowrap justify-center';
  return (
    <div className="px-4 py-3.5">
      <div className="sm:flex sm:items-center sm:gap-2">
        <div className="flex items-start gap-2.5 sm:flex-1 min-w-0">
          <span className={clsx('w-2 h-2 rounded-full shrink-0 mt-1.5 sm:mt-0 sm:self-center', d.online ? 'bg-(--ok)' : 'bg-(--muted)/50')} />
          <div className="flex-1 min-w-0">
            <div className={clsx('text-sm font-medium truncate', d.enabled ? 'text-(--text)' : 'text-(--muted)')}>{d.name}</div>
            <div className="text-xs text-(--muted) line-clamp-2 sm:line-clamp-1 break-words">
              {osLabel(d.os)} · {d.os === 'nasbrowser' ? 'altijd beschikbaar' : <>{d.online ? 'online' : `offline, ${ago(d.last_seen_at)}`} · agent {d.agent_version ?? '?'}</>}{showOwner && d.owner ? ` · ${d.owner}` : ''}
            </div>
          </div>
        </div>
        <div className="mt-3 sm:mt-0 grid grid-cols-3 gap-2 sm:flex sm:items-center sm:justify-end">
          {outdated && (
            <button className={`${primary} ${mb} col-span-3`} disabled={busy || !d.online} onClick={() => act(() => api(`/${d.id}/update`, { method: 'POST' }), 'Update gestart; de agent komt zo terug met de nieuwe versie.')}>
              Bijwerken naar {latest}
            </button>
          )}
          {!isNas && <button className={`${ghost} ${mb}`} disabled={busy} onClick={() => {
            const name = prompt('Naam', d.name)?.trim();
            if (name && name !== d.name) void act(() => api(`/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }));
          }}>Naam</button>}
          <button className={`${ghost} ${mb}`} disabled={busy} onClick={() => act(() => api(`/${d.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !d.enabled }) }))}>
            {d.enabled ? 'Uitschakelen' : 'Inschakelen'}
          </button>
          {!isNas && <button className={`${btn} ${mb} border border-(--bad)/30 text-(--bad) hover:bg-red-500/10`} disabled={busy} onClick={() => {
            if (confirm(`${d.name} ontkoppelen? De agent stopt daarna; verwijder hem via Apps & onderdelen (Mac: uninstall.sh).`)) void act(() => api(`/${d.id}`, { method: 'DELETE' }));
          }}>Ontkoppelen</button>}
        </div>
      </div>
      {err && <p className="text-xs text-(--bad) mt-1">{err}</p>}
      {note && <p className="text-xs text-(--ok) mt-1">{note}</p>}
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // fade at the right edge while there is more code to swipe to (hint that the block scrolls)
  const [more, setMore] = useState(false);
  const measure = () => { const el = ref.current; if (el) setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 2); };
  useEffect(() => { measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }, [text]);
  function copy() {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const fallback = () => {
      const el = ref.current; if (!el) return;
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
      try { if (document.execCommand('copy')) done(); } catch { /* ignore */ }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <code ref={ref} onScroll={measure} className={clsx('block min-w-0 sm:flex-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden text-xs bg-(--bg) border border-(--border) rounded-lg px-3 py-2.5 text-(--text) select-all',
        more && '[-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-32px),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%-32px),transparent)]')}>{text}</code>
      <button className={`${ghost} max-sm:min-h-[44px] justify-center`} onClick={copy}>
        {copied ? 'Gekopieerd' : 'Kopieer'}
      </button>
    </div>
  );
}

type Filter = 'all' | 'online' | 'offline' | 'attention';

/** NinjaOne-style device table: status, OS, user, disk, security, updates, alerts. Click a row for details. */
function MonitorTable({ devices, latest, showOwner }: { devices: Device[]; latest: string | null; showOwner: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  useEffect(() => { const v = new URLSearchParams(window.location.search).get('q'); if (v) setQ(v); }, []);
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(() => devices
    .map((d) => ({ d, alerts: alertsOf(d, latest) }))
    .filter(({ d, alerts }) =>
      (filter === 'all' || (filter === 'online' && d.online) || (filter === 'offline' && !d.online) || (filter === 'attention' && alerts.length > 0))
      && (!q || [d.name, d.display_name, d.org, d.location, d.assigned_user, d.inventory?.user, d.inventory?.model, d.last_ip, ...(d.inventory?.ips ?? [])].some((v) => v?.toLowerCase().includes(q.toLowerCase()))))
    // favorites first, then by name
    .sort((a, b) => Number(!!b.d.favorite) - Number(!!a.d.favorite)),
  [devices, latest, q, filter]);
  const count = (f: Filter) => devices.filter((d) => f === 'all' || (f === 'online' && d.online) || (f === 'offline' && !d.online) || (f === 'attention' && alertsOf(d, latest).length > 0)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {([['all', 'Alle'], ['online', 'Online'], ['offline', 'Offline'], ['attention', 'Aandacht']] as Array<[Filter, string]>).map(([f, label]) => (
          <button key={f} onClick={() => setFilter(f)}
            className={clsx('text-xs px-3 py-1.5 rounded-full border transition-colors', filter === f ? 'bg-(--accent-strong) border-(--accent-strong) text-white' : 'border-(--border) text-(--muted) hover:text-(--text)')}>
            {label} <span className="tabular-nums opacity-70">{count(f)}</span>
          </button>
        ))}
        <div className="hidden sm:block flex-1" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken" aria-label="Apparaten zoeken"
          className="w-full sm:w-48 bg-(--input) border border-(--border) rounded-lg px-3 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent)" />
      </div>

      <div className="rounded-xl border border-(--border) bg-(--input) overflow-hidden">
        <div className="hidden lg:grid grid-cols-[minmax(12rem,2fr)_minmax(8rem,1.2fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(8rem,1fr)_minmax(10rem,1.6fr)] gap-3 px-4 py-2 text-[11px] uppercase tracking-wide text-(--muted) border-b border-(--border)">
          <span>Apparaat</span><span>Besturingssysteem</span><span>Gebruiker</span><span>Schijf</span><span>Laatst gezien</span><span>Aandacht</span>
        </div>
        {rows.length === 0 && <p className="px-4 py-4 text-sm text-(--muted)">Geen apparaten in deze selectie.</p>}
        {rows.map(({ d, alerts }) => {
          const inv = d.inventory;
          const disk = diskUsedPct(inv);
          return (
            <button key={d.id} onClick={() => router.push(`/settings/apparaten/${d.id}`)}
              className={clsx('w-full text-left grid gap-x-3 gap-y-1 px-4 py-3 border-b border-(--border) last:border-0 hover:bg-(--border)/40 transition-colors',
                'grid-cols-[1fr_auto] lg:grid-cols-[minmax(12rem,2fr)_minmax(8rem,1.2fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(8rem,1fr)_minmax(10rem,1.6fr)] items-center',
                !d.enabled && 'opacity-60')}>
              <span className="flex items-center gap-2.5 min-w-0">
                <span className="relative shrink-0">
                  <span className={clsx('w-8 h-8 rounded-lg text-white flex items-center justify-center', d.os === 'nasbrowser' ? 'bg-sky-600' : 'bg-indigo-500')}><DeviceIcon os={d.os} className="w-4 h-4" /></span>
                  <span className={clsx('absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-(--input)', d.online ? 'bg-green-500' : 'bg-zinc-400')} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-(--text) truncate">{d.favorite && <span className="text-yellow-500 mr-1" title="Favoriet">*</span>}{d.display_name || d.name}</span>
                  <span className="block text-xs text-(--muted) truncate">{[d.org, d.location, inv?.model, showOwner ? d.owner : null].filter(Boolean).join(' · ') || osLabel(d.os)}</span>
                </span>
              </span>
              <span className="lg:hidden justify-self-end flex gap-1">
                {alerts.length > 0 ? <Badge tone={alerts.some((a) => a.tone === 'bad') ? 'bad' : 'warn'}>{alerts.length}</Badge> : <Badge tone="ok">OK</Badge>}
              </span>
              <span className="hidden lg:block text-xs text-(--text) truncate">{inv?.os ?? d.os_name ?? osLabel(d.os)}</span>
              <span className="hidden lg:block text-xs text-(--text) truncate">{d.assigned_user || inv?.user || '-'}</span>
              <span className="hidden lg:flex items-center gap-2 text-xs">
                {inv?.disks?.length ? <><UsageBar pct={disk} className="flex-1" /><span className="tabular-nums text-(--muted) w-9 text-right">{disk}%</span></> : <span className="text-(--muted)">-</span>}
              </span>
              <span className="hidden lg:block text-xs text-(--muted)">{d.os === 'nasbrowser' ? <span className="text-(--ok)">Altijd beschikbaar</span> : d.online ? <span className="text-(--ok)">Online</span> : ago(d.last_seen_at)}</span>
              <span className="hidden lg:flex flex-wrap gap-1">
                {alerts.length === 0 ? <Badge tone="ok">In orde</Badge> : alerts.slice(0, 3).map((a) => <Badge key={a.text} tone={a.tone}>{a.text}</Badge>)}
                {alerts.length > 3 && <Badge tone="muted">+{alerts.length - 3}</Badge>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DevicesView({ mode }: { mode: 'monitor' | 'manage' }) {
  const manage = mode === 'manage';
  const [data, setData] = useState<ListResponse | null>(null);
  const [adding, setAdding] = useState(false);
  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [origin, setOrigin] = useState('');
  const known = useRef<Set<string>>(new Set());
  const [all, setAll] = useState(getAllUsers());
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const load = async () => {
    try { const r = await api<ListResponse>(''); setData(r); return r.devices; }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); return null; }
  };

  function toggleAll(v: boolean) { setAllUsers(v); setAll(v); void load(); }

  useEffect(() => {
    void load().then((d) => { if (d) known.current = new Set(d.map((x) => x.id)); });
    const t = setInterval(() => { void load(); }, 30_000);
    // live: on a device status change, and when the app comes back to the foreground (PWA)
    const now = () => { void load(); };
    const vis = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('cc:devices-changed', now);
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); window.removeEventListener('cc:devices-changed', now); document.removeEventListener('visibilitychange', vis); };
  }, []);

  // While a code is open: watch for the new device to show up
  useEffect(() => {
    if (!enroll) return;
    const t = setInterval(async () => {
      const list = await load();
      const fresh = list?.find((x) => !known.current.has(x.id));
      if (fresh) {
        known.current.add(fresh.id);
        setEnroll(null); setAdding(false);
        setMsg({ ok: true, text: `${fresh.name} is gekoppeld.` });
      }
    }, 4000);
    return () => clearInterval(t);
  }, [enroll]);

  // browsers (Chrome extension) are managed under Koppelingen, not listed as devices
  const devices = data?.devices?.filter((d) => d.os !== 'browser') ?? null;
  const online = devices?.filter((d) => d.online).length ?? 0;

  const [codeErr, setCodeErr] = useState('');
  async function makeCode(): Promise<boolean> {
    setCodeErr('');
    try { setEnroll(await api<Enroll>('/enroll-code', { method: 'POST', body: JSON.stringify({}) })); return true; }
    catch (e) { setCodeErr((e as Error).message); return false; }
  }
  function startAdd() {
    setAdding(true); setEnroll(null); setMsg(null); setCodeErr('');
    void makeCode();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-(--text)">Apparaten</h1>
          {devices && devices.length > 0 && <p className="text-sm text-(--muted)">{online} van {devices.length} online</p>}
        </div>
        {data?.isAdmin && (
          <label className="flex items-center gap-2 text-sm text-(--muted) cursor-pointer select-none">
            <span>Alle gebruikers</span>
            <button type="button" role="switch" aria-checked={all} aria-label="Alle gebruikers" onClick={() => toggleAll(!all)}
              className={clsx('relative w-11 h-6 rounded-full transition-colors shrink-0', all ? 'bg-(--accent)' : 'bg-(--border)')}>
              <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform', all ? 'translate-x-5.5' : 'translate-x-0.5')} />
            </button>
          </label>
        )}
        {manage
          ? !adding && <button className={primary} onClick={startAdd}>Toevoegen</button>
          : <Link href="/settings/agent" className={ghost}>Beheren</Link>}
      </div>

      {msg && (
        <div className={clsx('rounded-lg px-4 py-3 text-sm border', msg.ok ? 'bg-green-500/10 border-green-500/30 text-(--ok)' : 'bg-red-500/10 border-red-500/30 text-(--bad)')}>
          {msg.text}
        </div>
      )}


      {manage && adding && (
        <section className="rounded-card border border-(--border) bg-(--input) p-4 space-y-4">
          {!enroll ? (
            codeErr ? <div className="text-xs text-(--bad)">{codeErr}</div> : <div className="text-xs text-(--muted)">Koppelcode maken…</div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="text-xs text-(--muted)">Koppelcode, geldig tot {new Date(enroll.expiresAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</div>
                <div className="text-2xl font-semibold tracking-[0.2em] text-(--text) select-all">{enroll.code}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a href={enroll.windowsUrl} className={`${btn} inline-block bg-indigo-500 text-white hover:brightness-95`}>Windows-installer met deze code</a>
                <span className="text-xs text-(--muted)">Of kopieer de PowerShell- of Terminal-regel, de code staat er al in.</span>
              </div>
              <section className="min-w-0 grid gap-4 md:grid-cols-2">
                <div className="space-y-2 min-w-0">
                  <div className="text-sm font-medium text-(--text)">Windows</div>
                  <CopyLine text={`irm "${origin}/api/devices/download/windows.ps1?code=${enroll.code}" | iex`} />
                  <p className="text-xs text-(--muted) break-words">Plakken in PowerShell als administrator: installeert en koppelt zonder SmartScreen-meldingen. Opnieuw uitvoeren werkt als update.</p>
                  <a href={`/api/devices/download/windows?code=${encodeURIComponent(enroll.code)}`} className="text-xs text-(--accent) hover:underline">Of de installer downloaden{data?.latestAgent ? ` (${data.latestAgent})` : ''}</a>
                </div>
                <div className="space-y-2 min-w-0">
                  <div className="text-sm font-medium text-(--text)">Mac (Terminal)</div>
                  <CopyLine text={`curl -fsSL ${origin}/api/devices/download/mac | sudo bash -s -- ${enroll.code}`} />
                  <p className="text-xs text-(--muted)">Verwijderen: sudo /usr/local/claude-agent/uninstall.sh</p>
                </div>
              </section>
              <div className="flex items-center gap-2 text-xs text-(--muted)">
                <span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" /> Wacht op het apparaat…
                <div className="flex-1" />
                <button className={ghost} onClick={() => { setEnroll(null); setAdding(false); }}>Sluiten</button>
              </div>
            </div>
          )}
        </section>
      )}

      {devices?.length === 0 && !adding && (
        <p className="text-sm text-(--muted)">Nog geen apparaten.{!manage && <> <Link href="/settings/agent" className="text-(--accent) hover:underline">Toevoegen</Link></>}</p>
      )}

      {manage ? (
        devices && devices.length > 0 && (
          <section className="rounded-xl border border-(--border) bg-(--input) divide-y divide-(--border)">
            {devices.map((d) => <ManageRow key={d.id} d={d} latest={data?.latestAgent ?? null} onChanged={() => void load()} showOwner={all} />)}
          </section>
        )
      ) : (
        devices && devices.length > 0 && <MonitorTable devices={devices} latest={data?.latestAgent ?? null} showOwner={all} />
      )}

    </div>
  );
}
