'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { googleSc, conversations as convApi } from '@/lib/api';
import { useChatStore } from '@/lib/store';
import { ghost, primary, api as devApi, type Device } from '@/components/devices/shared';

type Status = Awaited<ReturnType<typeof googleSc.status>>;

export function GoogleLogo({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

const link = 'text-(--accent-text) underline underline-offset-2 hover:brightness-110';
const field = 'w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-sm text-(--text) outline-none focus:border-(--accent)';

/** Koppelingen: tegel 'Google Search Console'. Gebruiker: inloggen met Google. Beheerder: instelwizard voor de OAuth-client. */
export default function GoogleSearchConsoleCard({ connected, onChanged, embedded = false }: { connected: boolean; onChanged: () => void; embedded?: boolean }) {
  const router = useRouter();
  const addConversation = useChatStore((s) => s.addConversation);
  const [st, setSt] = useState<Status | null>(null);
  const [wizard, setWizard] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'' | 'login' | 'save' | 'claude'>('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [copied, setCopied] = useState(false);
  const [chromes, setChromes] = useState<Device[] | null>(null);

  const load = useCallback(async () => {
    try { setSt(await googleSc.status()); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // alleen voor de beheerder: heeft hij een gekoppelde Chrome waarmee Claude de Google-app kan aanmaken?
  useEffect(() => {
    if (!st?.isAdmin) return;
    devApi<{ devices: Device[] }>('').then((r) => setChromes(r.devices.filter((d) => d.os === 'browser'))).catch(() => setChromes([]));
  }, [st?.isAdmin]);

  // terugkeer van Google: ?google=ok|error&msg=...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const g = q.get('google');
    if (!g) return;
    const msg = q.get('msg') ?? '';
    if (g === 'ok') { setOk(msg || 'Verbonden met Google'); onChanged(); } else setErr(msg || 'Inloggen met Google mislukt');
    window.history.replaceState(null, '', window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login() {
    setErr(''); setOk(''); setBusy('login');
    try { window.location.href = (await googleSc.login()).url; }
    catch (e) { setErr((e as Error).message); setBusy(''); }
  }

  async function save() {
    setErr(''); setOk(''); setBusy('save');
    try {
      await googleSc.saveConfig(clientId.trim(), secret.trim());
      setSecret(''); setClientId(''); setWizard(false); setOk('Opgeslagen. Gebruikers kunnen nu inloggen met Google.');
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  async function removeConfig() {
    if (!confirm('Google-instellingen verwijderen? Bestaande koppelingen werken dan niet meer tot je ze opnieuw instelt.')) return;
    try { await googleSc.clearConfig(); await load(); } catch (e) { setErr((e as Error).message); }
  }

  async function askClaude() {
    setErr(''); setBusy('claude');
    try {
      const { prompt } = await googleSc.setupPrompt();
      const res = await convApi.create({ title: 'Google Search Console instellen' });
      addConversation(res.conversation);
      await convApi.enqueue(res.conversation.id, prompt);
      router.push(`/chat/${res.conversation.id}`);
    } catch (e) { setErr((e as Error).message); setBusy(''); }
  }

  async function copyUri() {
    if (!st) return;
    try { await navigator.clipboard.writeText(st.redirectUri); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ }
  }

  if (!st) return null;
  const showWizard = st.isAdmin && (!st.configured || wizard);

  return (
    <section className={embedded ? 'space-y-3' : 'mb-6 rounded-card border border-(--border) bg-(--input) p-4 space-y-3 wa-row-in'}>
      <div className="flex items-start gap-3">
        {!embedded && <span className="mt-0.5 shrink-0"><GoogleLogo /></span>}
        <div className="flex-1 min-w-0">
          {!embedded && <div className="text-sm font-medium text-(--text)">Google Search Console</div>}
          <p className="text-xs text-(--muted)">
            Claude analyseert de zoekwoorden en pagina&apos;s van jouw sites voor SEO. Alleen lezen, met jouw eigen Google-account.
          </p>
          {!st.configured && !st.isAdmin && <p className="text-xs text-(--muted) mt-1.5">Nog niet ingesteld, vraag de beheerder.</p>}
        </div>
        {st.configured && (
          <button onClick={login} disabled={busy === 'login'}
            className="shrink-0 inline-flex items-center gap-2 text-sm font-medium px-3.5 py-2 rounded-lg bg-white text-[#1f1f1f] border border-[#dadce0] hover:brightness-95 active:scale-[0.97] transition-[filter,transform] duration-150 disabled:opacity-60">
            <GoogleLogo className="w-4 h-4" />
            <span>{connected ? 'Opnieuw inloggen' : 'Inloggen met Google'}</span>
          </button>
        )}
      </div>

      {st.configured && st.isAdmin && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-(--muted)">
          <span className="w-2 h-2 rounded-full bg-(--ok) shrink-0" />
          <span>OAuth-client ingesteld</span>
          <span className="font-mono truncate max-w-[16rem]" title={st.clientId ?? ''}>{st.clientId}</span>
          <span className="ml-auto flex gap-1.5">
            <button className={ghost} onClick={() => setWizard((v) => !v)} aria-expanded={wizard}>{wizard ? 'Sluiten' : 'Instellingen'}</button>
            <button className={`${ghost} text-red-400`} onClick={removeConfig}>Verwijderen</button>
          </span>
        </div>
      )}

      {ok && <div className="text-xs text-green-400">{ok}</div>}
      {err && <div className="text-xs text-red-400">{err}</div>}

      {showWizard && (
        <div className="user-edit space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-(--muted) flex-1 min-w-[12rem]">
              Eenmalig voor de hele installatie, door de beheerder. Doe het zelf in 6 stappen{chromes?.length ? ', of laat Claude het in jouw Chrome doen.' : '.'}
              {chromes && chromes.length === 0 && <span className="block mt-1">Koppel eerst Chrome (Koppeling toevoegen, Browser) als Claude het voor je moet instellen.</span>}
              {!!chromes?.length && !chromes.some((c) => c.online) && <span className="block mt-1">Je Chrome is offline. Open Chrome om Claude het te laten doen.</span>}
            </p>
            {!!chromes?.length && (
              <button className={`${primary} motion-safe:animate-[ccFadeIn_.2s_ease-out]`} onClick={askClaude} disabled={busy === 'claude' || !chromes.some((c) => c.online)}>
                {busy === 'claude' ? 'Bezig...' : 'Laat Claude het instellen'}
              </button>
            )}
            <style>{'@keyframes ccFadeIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}'}</style>
          </div>
          <ol className="list-decimal pl-5 space-y-1.5 text-xs text-(--muted)">
            <li><a className={link} href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Maak een privé-project</a> in Google Cloud (geen organisatie nodig).</li>
            <li><a className={link} href="https://console.cloud.google.com/apis/library/searchconsole.googleapis.com" target="_blank" rel="noreferrer">Zet de Search Console API aan</a> in dat project.</li>
            <li><a className={link} href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Consent screen</a>: type External, appnaam naar keuze. Voeg bij Data Access alleen de scope <span className="font-mono text-(--text) break-all">{st.scope}</span> toe.</li>
            <li><a className={link} href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noreferrer">Maak een client</a>: type Web application, met deze redirect-URI:
              <div className="flex items-center gap-2 mt-1.5">
                <code className="flex-1 min-w-0 truncate bg-(--bg) border border-(--border) rounded-lg px-2.5 py-1.5 text-(--text)" title={st.redirectUri}>{st.redirectUri}</code>
                <button className={ghost} onClick={copyUri}>{copied ? 'Gekopieerd' : 'Kopieer'}</button>
              </div>
            </li>
            <li><a className={link} href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">Publiceer de app</a> (Publish app, status In production), anders verlopen de tokens na 7 dagen.</li>
            <li>Vul hieronder het Client ID en de Client secret in.</li>
          </ol>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="block text-xs text-(--muted) mb-1">Client ID</span>
              <input className={field} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123...apps.googleusercontent.com" spellCheck={false} autoComplete="off" /></label>
            <label className="block"><span className="block text-xs text-(--muted) mb-1">Client secret</span>
              <input className={field} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={st.configured ? '••••••• (nieuw invullen om te wijzigen)' : ''} autoComplete="new-password" /></label>
          </div>
          <div className="flex gap-2">
            <button className={primary} onClick={save} disabled={busy === 'save' || !clientId.trim() || !secret.trim()}>Opslaan</button>
            {st.configured && <button className={ghost} onClick={() => setWizard(false)}>Annuleren</button>}
          </div>
        </div>
      )}
    </section>
  );
}
