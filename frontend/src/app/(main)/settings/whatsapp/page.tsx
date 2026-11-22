'use client';

import { useEffect, useState } from 'react';
import { whatsapp, type WhatsAppStatus } from '@/lib/api';
import MessengerLink from '@/components/settings/MessengerLink';

const primary = 'bg-(--accent-strong) hover:brightness-90 text-white text-sm font-medium px-4 py-2 rounded-control transition-[filter] disabled:opacity-50';
const secondary = 'text-sm px-4 py-2 rounded-lg border border-(--border) text-(--text) hover:bg-(--border) transition-colors disabled:opacity-50';

export default function WhatsAppSettingsPage() {
  const [st, setSt] = useState<WhatsAppStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try { setSt(await whatsapp.status()); } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  // While waiting for the QR / the scan, refresh so the code and "gekoppeld" appear by themselves
  const waiting = !!st?.enabled && (!st.linked || st.status === 'connecting');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(t);
  }, [waiting]);

  async function run(action: () => Promise<WhatsAppStatus>, ok: string) {
    setBusy(true); setError(''); setNotice('');
    try { setSt(await action()); if (ok) setNotice(ok); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const statusText = !st ? ''
    : st.linked ? `Gekoppeld aan ${st.name ? `${st.name} (${st.phone})` : st.phone}${st.enabled ? '' : ', uitgeschakeld'}.`
    : st.qr ? 'Scan de QR-code met WhatsApp op je telefoon.'
    : st.enabled ? 'QR-code wordt opgehaald…'
    : 'Niet gekoppeld.';

  return (
    <div className="w-full">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-(--text)">WhatsApp</h1>
        <p className="text-sm text-(--muted) mt-0.5">Bericht aan jezelf sturen; Claude antwoordt in die chat.</p>
      </div>

      {notice && <div className="mb-4 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3 text-green-400 text-sm" role="status">{notice}</div>}
      {error && <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm" role="alert">{error}</div>}

      {st && (
        <div className="bg-(--input) border border-(--border) rounded-card p-4 mb-6">
          <div className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st.linked && st.enabled && st.status === 'ok' ? 'bg-green-500' : st.linked ? 'bg-amber-500' : 'bg-(--muted)'}`} aria-hidden />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-(--text) truncate">
                {st.linked ? (st.name ? `${st.name} · ${st.phone}` : st.phone ?? 'WhatsApp') : 'Niet gekoppeld'}
              </p>
              {(st.statusMessage && st.status !== 'ok') ? (
                <p className={`text-xs mt-0.5 ${st.status === 'error' || st.status === 'loggedout' ? 'text-red-400' : 'text-(--muted)'}`}>{st.statusMessage}</p>
              ) : st.linked ? (
                <p className="text-xs text-(--muted) mt-0.5 tabular-nums">{st.contacts.total} contacten{st.enabled ? '' : ' · uitgeschakeld'}</p>
              ) : null}
            </div>
            {st.linked && (
              <input type="checkbox" className="ios-switch shrink-0" checked={st.enabled} disabled={busy} aria-label="WhatsApp aan"
                title={st.enabled ? 'WhatsApp uitzetten' : 'WhatsApp aanzetten'}
                onChange={(e) => void run(() => whatsapp.save({ enabled: e.target.checked }), e.target.checked ? 'WhatsApp aangezet.' : 'WhatsApp uitgezet.')} />
            )}
          </div>

          {st.linked ? (
            <div className="flex flex-wrap gap-2 mt-4">
              <button className={secondary} disabled={busy || !st.enabled || st.status !== 'ok'}
                onClick={() => void run(() => whatsapp.syncContacts(), 'Contacten gesynchroniseerd.')}>
                Synchroniseren
              </button>
              <button className={secondary + ' hover:!text-red-400'} disabled={busy}
                onClick={() => {
                  if (confirm('WhatsApp ontkoppelen? Het apparaat verdwijnt ook uit Gekoppelde apparaten op je telefoon.')) {
                    void run(() => whatsapp.unlink(), 'Ontkoppeld.');
                  }
                }}>
                Ontkoppelen
              </button>
            </div>
          ) : st.qr ? (
            <div className="mt-4 flex flex-col items-start gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={st.qr} alt="WhatsApp QR-code" width={256} height={256} className="w-64 h-64 rounded-lg bg-white p-2" />
              <p className="text-xs text-(--muted)">WhatsApp → Gekoppelde apparaten → Apparaat koppelen.</p>
              <button className={secondary} disabled={busy} onClick={() => void run(() => whatsapp.save({ enabled: false }), '')}>Annuleren</button>
            </div>
          ) : (
            <div className="mt-4">
              <button className={primary} disabled={busy || (st.enabled && st.status === 'connecting')}
                onClick={() => void run(() => whatsapp.save({ enabled: true }), '')}>
                {st.status === 'qr_expired' || st.status === 'loggedout' ? 'Nieuwe QR-code' : 'Koppel WhatsApp'}
              </button>
            </div>
          )}
        </div>
      )}

      <MessengerLink channel="whatsapp" />
    </div>
  );
}
