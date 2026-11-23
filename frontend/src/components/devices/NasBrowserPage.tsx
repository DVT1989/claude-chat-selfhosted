'use client';
// Page of the virtual "Browser (NAS)" device: a Chromium on the server that you can take over (2FA etc.) and Claude can drive.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RemoteDesktop } from './RemoteDesktop';
import { api, Badge, Device, DeviceIcon, ghost, primary } from './shared';
import { Icon } from './ui';

interface PwItem { id: string; host: string; username: string; updated_at: string }

/** Saved logins of the Browser (NAS): view, show the password after a click, delete. */
function Passwords() {
  const [items, setItems] = useState<PwItem[] | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const t = timers.current;
    api<{ passwords: PwItem[] }>('/nas-passwords').then((r) => setItems(r.passwords)).catch((e: Error) => { setErr(e.message); setItems([]); });
    return () => { Object.values(t).forEach(clearTimeout); };
  }, []);
  const hide = (id: string) => { clearTimeout(timers.current[id]); setShown((s) => { const n = { ...s }; delete n[id]; return n; }); };
  const reveal = async (id: string) => {
    if (shown[id] !== undefined) { hide(id); return; }
    try {
      const r = await api<{ password: string }>(`/nas-passwords/${id}/reveal`, { method: 'POST' });
      setShown((s) => ({ ...s, [id]: r.password }));
      timers.current[id] = setTimeout(() => hide(id), 15_000);
    } catch (e) { setErr((e as Error).message); }
  };
  const del = async (id: string) => {
    try { await api(`/nas-passwords/${id}`, { method: 'DELETE' }); hide(id); setConfirm(null); setItems((l) => (l ?? []).filter((x) => x.id !== id)); }
    catch (e) { setErr((e as Error).message); }
  };
  const ibtn = 'inline-flex items-center justify-center h-9 min-w-9 px-2 rounded-[10px] text-(--text) hover:bg-[color-mix(in_srgb,var(--text)_9%,transparent)] transition-colors max-sm:h-11 max-sm:min-w-11';
  return (
    <section className="rounded-xl border border-(--border) bg-(--input) p-4 space-y-3" aria-label="Opgeslagen wachtwoorden">
      <div className="flex items-center gap-2">
        <Icon name="key" className="w-[18px] h-[18px] text-(--accent)" />
        <h3 className="text-sm font-semibold text-(--text)">Opgeslagen wachtwoorden</h3>
      </div>
      <p className="text-xs text-(--muted)">De browser vraagt na het inloggen of hij het wachtwoord mag bewaren. Opgeslagen versleuteld; Claude ziet alleen de gebruikersnaam, nooit het wachtwoord.</p>
      {err && <p className="text-xs text-red-400" role="alert">{err}</p>}
      {items === null ? <p className="text-sm text-(--muted)">Laden…</p> : items.length === 0 ? <p className="text-sm text-(--muted)">Nog niets opgeslagen.</p> : (
        <ul className="divide-y divide-(--border)">
          {items.map((it) => (
            <li key={it.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1 basis-52">
                <div className="text-sm text-(--text) truncate">{it.host}</div>
                <div className="text-xs text-(--muted) truncate">{it.username}</div>
              </div>
              <code className={`text-xs px-2 py-1 rounded-md bg-(--bg) border border-(--border) text-(--text) break-all transition-all duration-200 ease-out motion-reduce:transition-none ${shown[it.id] !== undefined ? 'opacity-100' : 'opacity-0 hidden'}`}>{shown[it.id]}</code>
              <div className="flex items-center gap-1 ml-auto">
                {confirm === it.id ? (
                  <>
                    <button className={`${ghost} h-9 max-sm:h-11 !px-3 text-[13px]`} onClick={() => setConfirm(null)}>Annuleren</button>
                    <button className="inline-flex items-center justify-center h-9 max-sm:h-11 px-3 rounded-[10px] text-[13px] font-semibold bg-red-600 text-white hover:brightness-95" onClick={() => void del(it.id)}>Verwijderen</button>
                  </>
                ) : (
                  <>
                    <button className={ibtn} onClick={() => void reveal(it.id)} aria-pressed={shown[it.id] !== undefined} title={shown[it.id] !== undefined ? 'Verbergen' : 'Wachtwoord tonen'} aria-label={shown[it.id] !== undefined ? 'Wachtwoord verbergen' : 'Wachtwoord tonen'}><Icon name="eye" /></button>
                    <button className={ibtn} onClick={() => setConfirm(it.id)} title="Verwijderen" aria-label={`Account ${it.username} verwijderen`}><Icon name="trash" /></button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function NasBrowserPage({ id }: { id: string }) {
  const [d, setD] = useState<Device | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { setD((await api<{ device: Device }>(`/${id}`)).device); } catch (e) { setErr((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (err) return <div className="space-y-3"><Link href="/settings/apparaten" className="text-sm text-(--accent)">Apparaten</Link><p className="text-sm text-red-400">{err}</p></div>;
  if (!d) return <p className="text-sm text-(--muted)">Laden…</p>;
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-1 text-xs text-(--muted)">
        <Link href="/settings/apparaten" className="hover:text-(--text)">Apparaten</Link>
        <span>/</span><span className="text-(--text)">{d.display_name || d.name}</span>
      </nav>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-(--border) bg-(--input) p-3">
        <span className="w-11 h-11 rounded-xl bg-sky-600 text-white flex items-center justify-center shrink-0"><DeviceIcon os={d.os} className="w-6 h-6" /></span>
        <div className="flex-1 min-w-[12rem]">
          <h2 className="text-xl font-semibold text-(--text) truncate">{d.display_name || d.name}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-(--muted)"><Badge tone="ok">Altijd beschikbaar</Badge><span>Chromium op de server</span></div>
        </div>
        <button className={`${primary} max-sm:w-full max-sm:min-h-[44px] inline-flex items-center justify-center gap-2`} onClick={() => setOpen(true)}>
          <Icon name="monitor" className="w-[18px] h-[18px]" />Openen
        </button>
      </div>
      <div className="rounded-xl border border-(--border) bg-(--input) p-4 text-sm text-(--muted) space-y-2">
        <p>Deze browser draait op de server, ook als je pc uit staat. Je blijft ingelogd: cookies blijven bewaard tussen sessies.</p>
        <p>Open hem om zelf in te loggen (bijvoorbeeld met 2FA). Daarna kan Claude hem gebruiken om pagina's te lezen en te bedienen.</p>
        <p>De browser sluit zichzelf na 15 minuten zonder gebruik en start opnieuw zodra je hem opent.</p>
      </div>
      <Passwords />
      {open && <RemoteDesktop d={d} onClose={() => setOpen(false)} />}
    </div>
  );
}
