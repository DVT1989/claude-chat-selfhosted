'use client';

import { useEffect, useState } from 'react';
import { messenger, type MessengerStatus, type MessengerSettings } from '@/lib/api';

type Channel = 'telegram' | 'whatsapp';
const LABEL: Record<Channel, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' };
type BoolKey = Exclude<keyof MessengerSettings, 'recipientsPerHour'>;
const key = (kind: 'claude' | 'relay' | 'mirror', c: Channel) =>
  `${kind}${c === 'telegram' ? 'Telegram' : 'Whatsapp'}` as BoolKey;

/** Options for this channel together with the other one (Telegram and WhatsApp). */
export default function MessengerLink({ channel }: { channel: Channel }) {
  const other: Channel = channel === 'telegram' ? 'whatsapp' : 'telegram';
  const [st, setSt] = useState<MessengerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [perHour, setPerHour] = useState('');

  function apply(s: MessengerStatus) { setSt(s); setPerHour(String(s.settings.recipientsPerHour)); }
  useEffect(() => { messenger.status().then(apply).catch((e) => setError((e as Error).message)); }, []);

  async function save(patch: Partial<MessengerSettings>) {
    setBusy(true); setError('');
    try { apply(await messenger.save(patch)); }
    catch (e) { setError((e as Error).message); if (st) setPerHour(String(st.settings.recipientsPerHour)); }
    finally { setBusy(false); }
  }
  const toggle = (k: BoolKey, v: boolean) => save({ [k]: v });
  function savePerHour() {
    const n = Number(perHour.trim());
    if (!st || perHour.trim() === '' || n === st.settings.recipientsPerHour) { if (st) setPerHour(String(st.settings.recipientsPerHour)); return; }
    void save({ recipientsPerHour: n });
  }

  if (!st) return error ? <p className="text-xs text-red-400 mt-4">{error}</p> : null;
  const otherState = st.channels.find((c) => c.channel === other);

  const rows: Array<{ k: BoolKey; title: string; hint?: string }> = [
    { k: key('claude', channel), title: `Claude mag berichten sturen via ${LABEL[channel]}`,
      hint: `Op jouw verzoek, alleen naar je eigen chat.` },
    { k: key('relay', channel), title: `Doorsturen vanuit ${LABEL[other]} toestaan`,
      hint: `Met /${channel} <tekst> in ${LABEL[other]} komt het bericht hier binnen.` },
    { k: key('mirror', channel), title: `${LABEL[other]}-gesprekken hier meelezen` },
    { k: 'syncActive', title: 'Eén actief gesprek voor beide kanalen',
      hint: '/resume en /nieuw gelden voor beide.' },
  ];
  if (channel === 'whatsapp') {
    rows.splice(1, 0, { k: 'contactsWhatsapp', title: 'Claude mag ook naar andere contacten sturen',
      hint: 'Op jouw verzoek, vanaf jouw account, naar elk nummer. Blijft aan tot je hem uitzet. Gelogd in audit log.' });
  }
  const disabled = (k: BoolKey) => busy || (k === 'contactsWhatsapp' && !st.settings.claudeWhatsapp);

  return (
    <div className="bg-(--input) border border-(--border) rounded-card p-4 mt-6 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-(--text)">Samen met {LABEL[other]}</h2>
        <p className="text-xs text-(--muted) mt-0.5">
          {LABEL[other]}: {otherState?.ready ? 'verbonden' : (otherState?.reason ?? 'onbekend')}
        </p>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="divide-y divide-(--border)">
        {rows.map((r) => (
          <label key={r.k} className="flex items-start justify-between gap-4 py-2.5 cursor-pointer">
            <span className="min-w-0">
              <span className="block text-sm text-(--text)">{r.title}</span>
              {r.hint && <span className="block text-xs text-(--muted) mt-0.5">{r.hint}</span>}
            </span>
            <input type="checkbox" className="w-4 h-4 mt-0.5 accent-(--accent) shrink-0" checked={st.settings[r.k]} disabled={disabled(r.k)}
              onChange={(e) => void toggle(r.k, e.target.checked)} />
          </label>
        ))}
        {channel === 'whatsapp' && st.settings.contactsWhatsapp && (
          <div className="flex items-start justify-between gap-4 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm text-(--text)">Verschillende ontvangers per uur</span>
              <span className="block text-xs text-(--muted) mt-0.5">0 = onbeperkt. Telt alleen nieuwe ontvangers.</span>
            </span>
            <input type="number" min={0} max={10000} step={1} inputMode="numeric" disabled={busy}
              className="w-20 shrink-0 bg-(--bg) border border-(--border) rounded-lg px-2 py-1 text-sm text-(--text) text-right focus:outline-none focus:border-(--accent)"
              value={perHour} onChange={(e) => setPerHour(e.target.value)} onBlur={savePerHour}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          </div>
        )}
      </div>
    </div>
  );
}
