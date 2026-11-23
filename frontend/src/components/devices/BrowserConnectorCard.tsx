'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ghost, primary, ago, type Device } from './shared';

interface Enroll { code: string; expiresAt: string }
interface ListResponse { devices: Device[]; settings: { requireTotp: boolean }; totpEnabled: boolean }

/** Koppelingen: tegel 'Browser (Chrome)': extensie downloaden, installeren en koppelen met een koppelcode. */
export default function BrowserConnectorCard({ mode = 'full', onlyId, onChanged }: { mode?: 'full' | 'add' | 'manage'; onlyId?: string; onChanged?: () => void } = {}) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [totp, setTotp] = useState('');
  const [open, setOpen] = useState(mode === 'add');
  const [err, setErr] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [delId, setDelId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await api<ListResponse>(''); setData(r); return r; } catch { return null; }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const browsers = (data?.devices ?? []).filter((d) => d.os === 'browser' && (!onlyId || d.id === onlyId));
  const needTotp = !!data?.totpEnabled && !!data?.settings.requireTotp;

  // While a code is open: close it as soon as a new browser shows up
  useEffect(() => {
    if (!enroll) return;
    const known = new Set(browsers.map((b) => b.id));
    const t = setInterval(async () => {
      const r = await load();
      if (r?.devices.some((d) => d.os === 'browser' && !known.has(d.id))) { setEnroll(null); onChanged?.(); }
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enroll]);

  async function makeCode() {
    setErr('');
    try { setEnroll(await api<Enroll>('/enroll-code', { method: 'POST', body: JSON.stringify({ totp_code: totp }) })); setTotp(''); }
    catch (e) { setErr((e as Error).message); }
  }

  async function rename(id: string) {
    const name = editName.trim();
    if (!name) { setEditId(null); return; }
    setErr('');
    try { await api(`/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); setEditId(null); await load(); onChanged?.(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function remove(id: string) {
    setErr('');
    try { await api(`/${id}`, { method: 'DELETE' }); setDelId(null); await load(); onChanged?.(); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <section className={mode === 'full' ? 'mb-6 rounded-card border border-(--border) bg-(--input) p-4 space-y-3' : 'space-y-3'}>
      {mode !== 'manage' && <div className="flex items-start gap-3">
        {mode === 'full' && <svg className="w-5 h-5 mt-0.5 text-(--accent) shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
        </svg>}
        <div className="flex-1 min-w-0">
          {mode === 'full' && <div className="text-sm font-medium text-(--text)">Browser (Chrome)</div>}
          <p className="text-xs text-(--muted)">Claude kan in jouw Chrome tabbladen lezen, navigeren, klikken, typen en een screenshot maken. Alleen na koppeling; interne pagina&apos;s (chrome://) worden nooit bediend.</p>
        </div>
        {mode === 'full' && <button className={open ? ghost : primary} onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Sluiten' : 'Browser toevoegen'}</button>}
      </div>}

      {mode !== 'add' && browsers.length > 0 && (
        <ul className="space-y-1.5">
          {browsers.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2 text-xs text-(--muted)">
              <span className={`w-2 h-2 rounded-full shrink-0 ${b.online ? 'bg-(--ok)' : 'bg-(--border)'}`} />
              {editId === b.id ? (
                <input autoFocus value={editName} maxLength={80} aria-label="Naam van de browser" onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void rename(b.id); if (e.key === 'Escape') setEditId(null); }}
                  className="min-w-0 w-44 bg-(--bg) border border-(--border) rounded-lg px-2 py-1 text-sm text-(--text) outline-none focus:border-(--accent)" />
              ) : <span className="text-(--text)">{b.name}</span>}
              <span>{b.online ? 'online' : `offline, ${ago(b.last_seen_at)}`}</span>
              <span className="ml-auto flex items-center gap-1.5">
                {editId === b.id ? (<>
                  <button className={ghost} onClick={() => void rename(b.id)}>Opslaan</button>
                  <button className={ghost} onClick={() => setEditId(null)}>Annuleren</button>
                </>) : delId === b.id ? (<>
                  <span className="text-(--text)">Verwijderen?</span>
                  <button className={`${ghost} text-red-400`} onClick={() => void remove(b.id)}>Ja, verwijderen</button>
                  <button className={ghost} onClick={() => setDelId(null)}>Nee</button>
                </>) : (<>
                  <button className={ghost} onClick={() => { setEditId(b.id); setEditName(b.name); setDelId(null); }}>Hernoemen</button>
                  <button className={ghost} onClick={() => { setDelId(b.id); setEditId(null); }}>Verwijderen</button>
                </>)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!open && err && <div className="text-xs text-red-400">{err}</div>}

      {open && (
        <div className="space-y-4 pt-1">
          <ol className="list-decimal pl-5 space-y-1 text-xs text-(--muted)">
            <li>Maak een koppelcode en download daarna de extensie: die zip koppelt zichzelf na het laden.</li>
            <li>Pak de zip uit en ga in Chrome naar <span className="font-mono text-(--text)">chrome://extensions</span> met Ontwikkelaarsmodus aan.</li>
            <li>Kies Uitgepakte extensie laden en selecteer de map. Klaar, geen code typen.</li>
            <li>Updates: de extensie meldt zelf een nieuwe versie. Pak die uit over dezelfde map en klik op vernieuwen.</li>
          </ol>
          <div className="flex flex-wrap items-end gap-3">
            {!enroll && <a href="/api/devices/download/browser-extension.zip" className={`${ghost} inline-block`}>Zonder code downloaden</a>}
            {!enroll && needTotp && (
              <label className="block">
                <span className="block text-xs text-(--muted) mb-1">TOTP-code</span>
                <input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric"
                  onKeyDown={(e) => { if (e.key === 'Enter' && totp.length === 6) void makeCode(); }}
                  className="w-32 bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-sm text-(--text) tracking-widest outline-none focus:border-(--accent)" />
              </label>
            )}
            {!enroll && <button className={primary} disabled={needTotp && totp.length !== 6} onClick={() => void makeCode()}>Koppelcode maken</button>}
          </div>
          {enroll && (
            <div>
              <div className="text-xs text-(--muted)">Koppelcode, geldig tot {new Date(enroll.expiresAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</div>
              <div className="text-2xl font-semibold tracking-[0.2em] text-(--text) select-all">{enroll.code}</div>
              <a href={`/api/devices/download/browser-extension.zip?code=${encodeURIComponent(enroll.code)}`} className={`${primary} inline-block mt-2 motion-safe:animate-[ccFadeIn_.2s_ease-out]`}>Extensie downloaden (koppelt zichzelf)</a>
              <style>{'@keyframes ccFadeIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}'}</style>
              <div className="flex items-center gap-2 text-xs text-(--muted) mt-1"><span className="w-2 h-2 rounded-full bg-(--accent) animate-pulse" /> Wacht op de browser…</div>
            </div>
          )}
          {err && <div className="text-xs text-red-400">{err}</div>}
        </div>
      )}
    </section>
  );
}
