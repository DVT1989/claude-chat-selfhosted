'use client';

import { useEffect, useState, FormEvent } from 'react';
import { telegram, type TelegramStatus } from '@/lib/api';
import MessengerLink from '@/components/settings/MessengerLink';

const input = 'w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm focus:outline-none focus:border-(--accent)';
const primary = 'bg-(--accent-strong) hover:brightness-90 text-white text-sm font-medium px-4 py-2 rounded-control transition-[filter] disabled:opacity-50';
const secondary = 'text-sm px-4 py-2 rounded-lg border border-(--border) text-(--text) hover:bg-(--border) transition-colors disabled:opacity-50';

export default function TelegramSettingsPage() {
  const [st, setSt] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pair, setPair] = useState<{ code: string; expiresAt: string; link: string | null } | null>(null);

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const botName = st?.botName ?? null;
  const avatar = st?.botAvatar ?? null;

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      const url = await resizeToDataUrl(file, 256);
      await run(() => telegram.save({ botAvatar: url }), 'Avatar opgeslagen.');
    } catch (e) { setError((e as Error).message); }
  }

  async function load() {
    try { setSt(await telegram.status()); } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  // While waiting for /start, refresh so "gekoppeld" appears by itself
  useEffect(() => {
    if (!st?.enabled || st.paired) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [st?.enabled, st?.paired]);

  async function makePairCode() {
    setBusy(true); setError('');
    try { setPair(await telegram.pairCode()); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  useEffect(() => { if (st?.paired) setPair(null); }, [st?.paired]);

  async function run(action: () => Promise<TelegramStatus>, ok: string) {
    setBusy(true); setError(''); setNotice('');
    try { setSt(await action()); setNotice(ok); setToken(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function saveToken(e: FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    void run(() => telegram.save({ botToken: token.trim(), enabled: true }), 'Bot opgeslagen en aangezet. Stuur nu /start naar je bot.');
  }

  return (
    <div className="w-full">
      <div className="flex items-center gap-4 mb-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {avatar
          ? <img src={avatar} alt={botName ?? 'Telegram-bot'} width={64} height={64} className="w-16 h-16 rounded-full shrink-0 object-cover" />
          : <div className="w-16 h-16 rounded-full shrink-0 bg-(--border) flex items-center justify-center text-(--muted) text-xl font-semibold">{(botName ?? 'T').slice(0, 1).toUpperCase()}</div>}
        <h1 className="text-xl font-semibold text-(--text)">{botName ? `Telegram · ${botName}` : 'Telegram'}</h1>
      </div>

      {notice && <div className="mb-4 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3 text-green-400 text-sm">{notice}</div>}
      {error && <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">{error}</div>}

      {st && (
        <div className="bg-(--input) border border-(--border) rounded-card p-4 mb-6 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-(--text)">
                {st.botUsername ? `@${st.botUsername}` : 'Nog geen bot'}
              </p>
              <p className="text-xs text-(--muted) mt-0.5">
                {!st.hasToken ? 'Volg de stappen hieronder.'
                  : !st.enabled ? 'Uitgeschakeld.'
                  : st.paired ? `Gekoppeld aan ${st.chatName ?? 'je Telegram-account'}.`
                  : 'Nog niet gekoppeld. Maak hieronder een koppellink.'}
              </p>
              {st.status === 'error' && st.statusMessage && <p className="text-xs text-red-400 mt-1">{st.statusMessage}</p>}
            </div>
            {st.hasToken && (
              <label className="flex items-center gap-2 text-sm text-(--text) shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 accent-(--accent)"
                  checked={st.enabled}
                  disabled={busy}
                  onChange={(e) => void run(() => telegram.save({ enabled: e.target.checked }), e.target.checked ? 'Telegram aangezet.' : 'Telegram uitgezet.')}
                />
                Aan
              </label>
            )}
          </div>
          {st.hasToken && st.enabled && !st.paired && (
            <div className="border-t border-(--border) pt-3 space-y-2">
              {!pair ? (
                <button className={primary} disabled={busy} onClick={() => void makePairCode()}>Koppellink maken</button>
              ) : (
                <>
                  {pair.link && (
                    <a className={primary + ' inline-block'} href={pair.link} target="_blank" rel="noreferrer">Open {botName ?? 'je bot'} in Telegram</a>
                  )}
                  <p className="text-xs text-(--muted)">
                    Of stuur zelf <code className="text-(--text)">/start {pair.code}</code> naar je bot. Eenmalig geldig tot{' '}
                    {new Date(pair.expiresAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.
                  </p>
                </>
              )}
            </div>
          )}
          {st.paired && (
            <button className={secondary} disabled={busy}
              onClick={() => void run(() => telegram.unpair(), 'Ontkoppeld. Stuur /start om opnieuw te koppelen.')}>
              Ontkoppelen
            </button>
          )}
        </div>
      )}

      {st && (
        <div className="bg-(--input) border border-(--border) rounded-card p-4 mb-6 space-y-3">
          <p className="text-sm font-medium text-(--text)">Naam en avatar van je bot</p>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => telegram.save({ botName: (nameDraft ?? botName ?? '').trim() }), 'Botnaam opgeslagen.'); setNameDraft(null); }}>
            <input className={input} maxLength={64} placeholder="Naam van je bot" value={nameDraft ?? botName ?? ''} onChange={(e) => setNameDraft(e.target.value)} />
            <button type="submit" className={secondary} disabled={busy || nameDraft === null}>Opslaan</button>
          </form>
          <label className="block text-xs text-(--muted)">
            Avatar (png, jpeg of webp)
            <input type="file" accept="image/png,image/jpeg,image/webp" className="block mt-1 text-sm text-(--text)"
              onChange={(e) => { void pickAvatar(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
      )}

      <form onSubmit={saveToken} className="bg-(--input) border border-(--border) rounded-card p-4 space-y-4">
        <ol className="text-sm text-(--text) space-y-2 list-decimal pl-5">
          <li>Open <a className="text-(--accent) underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> in Telegram, stuur <code>/newbot</code>, kies een gebruikersnaam (eindigt op <code>bot</code>) en kopieer de token.</li>
          <li>Plak de token hieronder en klik op Opslaan.</li>
          <li>Profielfoto: stuur <code>/setuserpic</code> naar @BotFather, kies je bot en stuur {avatar ? <a className="text-(--accent) underline" href={avatar} download="bot-avatar">deze afbeelding</a> : 'je afbeelding (hieronder in te stellen)'}.</li>
          <li>Klik op <strong>Koppellink maken</strong> en open de link in Telegram (of stuur <code>/start &lt;code&gt;</code>).</li>
        </ol>
        <div>
          <label className="block text-xs text-(--muted) mb-1">Bot-token{st?.hasToken ? ' (leeg = huidige houden)' : ''}</label>
          <input className={input} type="password" autoComplete="off" placeholder="123456789:AA..." value={token}
            onChange={(e) => setToken(e.target.value)} />
        </div>
        <button type="submit" className={primary} disabled={busy || !token.trim()}>Opslaan</button>
        <div className="text-xs text-(--muted) border-t border-(--border) pt-3 space-y-1">
          <p><code>/resume</code> — je recente gesprekken · <code>/resume &lt;nr&gt;</code> — verder in een gesprek</p>
          <p><code>/nieuw</code> — nieuw gesprek · <code>/status</code> — actief gesprek</p>
          <p><code>/whatsapp &lt;tekst&gt;</code> — bericht doorsturen naar je WhatsApp</p>
        </div>
      </form>

      <MessengerLink channel="telegram" />
    </div>
  );
}

/** Scales an image down to a square (max px) and returns a webp data URL. */
async function resizeToDataUrl(file: File, px: number): Promise<string> {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('Kan deze afbeelding niet lezen.'); });
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = Math.min(px, side);
  c.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.85);
}
