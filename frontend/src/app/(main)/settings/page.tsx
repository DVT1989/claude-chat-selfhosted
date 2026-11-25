'use client';

import LanguagePicker from '@/components/LanguagePicker';
import { useState, FormEvent, useEffect, useRef } from 'react';
import { useAuthStore } from '@/lib/store';
import { auth as authApi, models as modelsApi, totp as totpApi, push as pushApi } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';
import type { User, ModelOption } from '@/types';
import UserAvatar from '@/components/UserAvatar';
import AppUpdate from '@/components/settings/AppUpdate';
import { syncDevicePush, subscribeDevice, setPushOptOut } from '@/lib/pushClient';

const DEFAULT_ACCENT = '#CC785C';
const THEME_MODES = [
  { id: 'light',  label: 'Licht' },
  { id: 'dark',   label: 'Donker' },
  { id: 'system', label: 'Systeem' },
] as const;
type ThemeMode = typeof THEME_MODES[number]['id'];

function resizeImageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      // 256px so the large settings avatar stays sharp on retina; cover-crop fills the circle
      const SIZE = 256;
      const canvas = document.createElement('canvas');
      canvas.width = SIZE; canvas.height = SIZE;
      const ctx = canvas.getContext('2d')!;
      const ratio = Math.max(SIZE / img.width, SIZE / img.height);
      const w = img.width * ratio, h = img.height * ratio;
      ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}

export default function ProfileSettings() {
  const t = useTranslations('settings.profile');
  const tCommon = useTranslations('common');
  const { user, setUser } = useAuthStore();

  const [name, setName] = useState(user?.name ?? '');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [avatarPreview, setAvatarPreview] = useState<string | null>(user?.avatar ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [themeMode, setThemeMode] = useState<ThemeMode>((user?.theme_mode as ThemeMode) ?? 'system');
  const [accentColor, setAccentColor] = useState<string>(user?.accent_color ?? DEFAULT_ACCENT);
  const [hexInput, setHexInput] = useState<string>(user?.accent_color ?? DEFAULT_ACCENT);
  const [selectedModel, setSelectedModel] = useState<string>(user?.default_model ?? '');
  const [spellOn, setSpellOn] = useState(user?.preferences?.spellcheck !== false);
  const [spellLang, setSpellLang] = useState<'nl' | 'en' | 'auto'>(user?.preferences?.spell_lang ?? 'nl');
  const [bgMotion, setBgMotion] = useState<boolean>(user?.preferences?.bg_motion ?? true);
  const [promptSuggest, setPromptSuggest] = useState<boolean>(user?.preferences?.prompt_suggestions ?? false);
  const [remoteNotice, setRemoteNotice] = useState<boolean>(user?.preferences?.remote_notice ?? true);
  const [renderHosts, setRenderHosts] = useState<string>(user?.preferences?.render_hosts ?? '');
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<string>('sonnet');

  // 2FA state
  const [totpQr, setTotpQr] = useState<string | null>(null);
  const [totpSecret, setTotpSecret] = useState<string>('');
  const [totpVerifyCode, setTotpVerifyCode] = useState('');
  const [totpDisablePw, setTotpDisablePw] = useState('');
  const [totpMsg, setTotpMsg] = useState('');
  const [totpErr, setTotpErr] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);

  // Push notifications
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState('');

  useEffect(() => {
    const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    setPushSupported(supported);
    // The device's own subscription counts, not the server row (that can outlive a cleared cache)
    if (supported) syncDevicePush().then(setPushEnabled).catch(() => setPushEnabled(false));
  }, []);


  async function handleEnablePush() {
    setPushBusy(true); setPushMsg('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setPushMsg('Toestemming geweigerd. Sta notificaties toe in browser instellingen.');
        return;
      }
      await subscribeDevice();
      setPushOptOut(false);
      setPushEnabled(true);
      setPushMsg('Notificaties geactiveerd');
    } catch (e) {
      setPushMsg(`Fout: ${(e as Error).message}`);
    } finally { setPushBusy(false); }
  }

  async function handleDisablePush() {
    setPushBusy(true); setPushMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await pushApi.unsubscribe(sub.endpoint).catch(() => {});
        await sub.unsubscribe();
      }
      setPushOptOut(true);
      setPushEnabled(false);
      setPushMsg('Notificaties uitgeschakeld');
    } catch (e) {
      setPushMsg(`Fout: ${(e as Error).message}`);
    } finally { setPushBusy(false); }
  }

  const [pwaDiag, setPwaDiag] = useState<Record<string, string>>({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const standalone = window.matchMedia('(display-mode: standalone)').matches;
    const navStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
    // Read env() value via a probe element
    const probe = document.createElement('div');
    probe.style.paddingBottom = 'env(safe-area-inset-bottom)';
    document.body.appendChild(probe);
    const computedSafe = getComputedStyle(probe).paddingBottom;
    document.body.removeChild(probe);
    setPwaDiag({
      'display-mode standalone': String(standalone),
      'navigator.standalone (iOS)': String(navStandalone),
      'window.innerHeight': String(window.innerHeight) + 'px',
      'window.outerHeight': String(window.outerHeight) + 'px',
      'screen.height': String(window.screen.height) + 'px',
      'safe-area-inset-bottom': computedSafe,
      'visualViewport.height': String(window.visualViewport?.height ?? 'n/a') + 'px',
      'userAgent': window.navigator.userAgent,
    });
  }, []);

  async function handleClearCache() {
    if (!confirm('Cache wissen + service worker opnieuw registreren? App herlaadt.')) return;
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      try { localStorage.clear(); } catch { /* ignore */ }
      try { sessionStorage.clear(); } catch { /* ignore */ }
      // Force reload, bypass http cache
      window.location.reload();
    } catch (e) {
      alert('Cache wissen mislukt: ' + (e as Error).message);
    }
  }

  async function handleTestPush() {
    setPushMsg('Test bericht verstuurd…');
    try {
      await pushApi.test();
      setPushMsg('✓ Test verstuurd (controleer notificatie)');
    } catch (e) {
      setPushMsg(`Fout: ${(e as Error).message}`);
    }
  }

  async function startTotpSetup() {
    setTotpErr(''); setTotpMsg(''); setTotpBusy(true);
    try {
      const r = await totpApi.setup();
      setTotpQr(r.qrDataUrl);
      setTotpSecret(r.secret);
    } catch (e) {
      setTotpErr((e as Error).message);
    } finally { setTotpBusy(false); }
  }
  async function confirmTotp() {
    setTotpErr(''); setTotpBusy(true);
    try {
      await totpApi.enable(totpVerifyCode);
      // every session is signed out now, this one too: log in again with the code
      setUser(null);
      window.location.href = '/login?reden=totp-aan';
      return;
    } catch (e) {
      setTotpErr((e as Error).message);
    } finally { setTotpBusy(false); }
  }
  async function cancelTotp() {
    try { await totpApi.cancelSetup(); } catch { /* ignore */ }
    setTotpQr(null); setTotpSecret(''); setTotpVerifyCode(''); setTotpErr('');
  }
  async function disableTotp() {
    setTotpErr(''); setTotpBusy(true);
    try {
      await totpApi.disable(totpDisablePw);
      setUser(null);
      window.location.href = '/login?reden=totp-uit';
      return;
    } catch (e) {
      setTotpErr((e as Error).message);
    } finally { setTotpBusy(false); }
  }
  useEffect(() => {
    if (user?.theme_mode) setThemeMode(user.theme_mode as ThemeMode);
    if (user?.accent_color) { setAccentColor(user.accent_color); setHexInput(user.accent_color); }
  }, [user?.theme_mode, user?.accent_color]);
  useEffect(() => {    setSelectedModel(user?.default_model ?? '');  }, [user?.default_model]);
  useEffect(() => {
    modelsApi.list().then(({ models, default: def }) => {
      setModelOptions(models);
      setDefaultModelId(def);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) {
      authApi.me().then((res) => setUser((res as { user: User }).user)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    let resolved: 'light' | 'dark';
    if (themeMode === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const h = () => { document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light'; };
      mq.addEventListener('change', h);
      document.documentElement.dataset.theme = resolved;
      return () => mq.removeEventListener('change', h);
    }
    resolved = themeMode;
    document.documentElement.dataset.theme = resolved;
  }, [themeMode]);
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accentColor || DEFAULT_ACCENT);
  }, [accentColor]);

  // Save the mode right away, so it is kept without pressing Opslaan
  function chooseThemeMode(m: ThemeMode) {
    setThemeMode(m);
    try { localStorage.setItem('theme_mode', m); } catch { /* ignore */ }
    if (!user || m === user.theme_mode) return;
    authApi.updateProfile({ theme_mode: m })
      .then((res) => { const u = (res as { user?: User }).user; setUser(u ?? { ...user, theme_mode: m }); })
      .catch(() => {});
  }

  function handleHexChange(v: string) {
    let val = v.trim();
    if (val && !val.startsWith('#')) val = '#' + val;
    setHexInput(val);
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      setAccentColor(val.toUpperCase());
    }
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      setAvatarPreview(dataUrl);
    } catch { /* ignore */ }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(''); setError('');
    setLoading(true);
    try {
      const newDefaultModel = selectedModel === '' ? null : selectedModel;
      const currentDefaultModel = user?.default_model ?? null;
      const res = await authApi.updateProfile({
        name: name || undefined,
        ...(newPw ? { password: newPw, currentPassword: currentPw } : {}),
        theme_mode: themeMode !== user?.theme_mode ? themeMode : undefined,
        accent_color: accentColor !== (user?.accent_color ?? DEFAULT_ACCENT) ? accentColor : undefined,
        avatar: avatarPreview !== user?.avatar ? (avatarPreview ?? null) : undefined,
        default_model: newDefaultModel !== currentDefaultModel ? newDefaultModel : undefined,
        preferences: { spellcheck: spellOn, spell_lang: spellLang, bg_motion: bgMotion, remote_notice: remoteNotice, prompt_suggestions: promptSuggest, render_hosts: renderHosts },
      });
      const updated = (res as { ok: boolean; user?: User }).user;
      if (updated && user) setUser(updated);
      else if (user) setUser({ ...user, name: name || null });
      setMsg(t('saved'));
      setCurrentPw(''); setNewPw('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-(--text) mb-6">{t('title')}</h1>

      <form onSubmit={handleSubmit} className="space-y-6 w-full">
        {msg && <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3 text-green-400 text-sm">{msg}</div>}
        {error && <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">{error}</div>}

        {/* Two columns on wide screens: personal + look on the left, security + app on the right */}
        <div className="grid gap-x-12 gap-y-6 lg:grid-cols-2 items-start">
        <div className="space-y-6 min-w-0">
        <h2 className="text-xs font-medium uppercase tracking-wide text-(--muted)">Persoonlijk en weergave</h2>

        {/* Avatar */}
        <div>
          <label className="block text-sm text-(--muted) mb-3">{t('avatar')}</label>
          <div className="flex items-center gap-4">
            <UserAvatar size="lg" user={{ avatar: avatarPreview, name: user?.name ?? null, email: user?.email ?? '' }} />
            <div className="flex gap-3">
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className="text-sm text-(--accent) hover:underline">
                {t('avatarChoose')}
              </button>
              {avatarPreview && (
                <button type="button" onClick={() => setAvatarPreview(null)}
                  className="text-sm text-red-400 hover:underline">
                  {t('avatarRemove')}
                </button>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
          </div>
        </div>

        <hr className="border-(--border)" />

        {/* Name */}
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">{t('name')}</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) text-sm focus:outline-none focus:border-(--accent)"
            placeholder={t('namePlaceholder')} />
        </div>

        <hr className="border-(--border)" />

        {/* Language */}
        <LanguagePicker />

        {/* Spelling check in the chat composer */}
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">Spellingcontrole</label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" role="switch" aria-checked={spellOn} onClick={() => setSpellOn((v) => !v)}
              className={`relative w-11 h-6 rounded-full transition-colors ${spellOn ? 'bg-(--accent)' : 'bg-(--border)'}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${spellOn ? 'translate-x-5' : ''}`} />
            </button>
            <span className="text-sm text-(--text)">{spellOn ? 'Aan' : 'Uit'}</span>
            <select value={spellLang} onChange={(e) => setSpellLang(e.target.value as 'nl' | 'en' | 'auto')} disabled={!spellOn} aria-label="Taal van de spellingcontrole"
              className="w-full max-w-full min-w-0 sm:w-auto sm:flex-1 bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) text-sm focus:outline-none focus:border-(--accent) disabled:opacity-50">
              <option value="nl">Nederlands</option>
              <option value="en">Engels</option>
              <option value="auto">Automatisch (taal van browser of toetsenbord)</option>
            </select>
          </div>
          <p className="text-xs text-(--muted) mt-1.5">Rode lijntjes onder fouten in het invoerveld van de chat. Op de iPhone volgt de controle ook de taal van je toetsenbord.</p>
        </div>

        {/* Theme mode */}
        <div>
          <label className="block text-sm text-(--muted) mb-3">Thema</label>
          <div className="grid grid-cols-3 gap-2">
            {THEME_MODES.map((m) => (
              <button key={m.id} type="button" onClick={() => chooseThemeMode(m.id)}
                className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-[border-color,background-color,color] ${
                  themeMode === m.id
                    ? 'border-(--accent) ring-1 ring-(--accent)'
                    : 'border-(--border) hover:border-(--muted)'
                }`}>
                {m.id === 'light' && (
                  <svg className="w-5 h-5 text-(--text)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                )}
                {m.id === 'dark' && (
                  <svg className="w-5 h-5 text-(--text)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                )}
                {m.id === 'system' && (
                  <svg className="w-5 h-5 text-(--text)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                )}
                <span className="text-xs text-(--text)">{m.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Accent color */}
        <div>
          <label className="block text-sm text-(--muted) mb-3">Accentkleur</label>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => { setAccentColor(DEFAULT_ACCENT); setHexInput(DEFAULT_ACCENT); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-[border-color,background-color,color] ${
                  accentColor.toUpperCase() === DEFAULT_ACCENT
                    ? 'border-(--accent) ring-1 ring-(--accent)'
                    : 'border-(--border) hover:border-(--muted)'
                }`}>
                <div className="w-4 h-4 rounded-full" style={{ backgroundColor: DEFAULT_ACCENT }} />
                <span className="text-xs text-(--text)">Standaard (Oranje)</span>
              </button>
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-(--border)">
                <input type="color" value={accentColor}
                  onChange={(e) => { setAccentColor(e.target.value.toUpperCase()); setHexInput(e.target.value.toUpperCase()); }}
                  className="w-6 h-6 rounded cursor-pointer bg-transparent border-0 p-0"
                  style={{ background: 'none' }} />
                <span className="text-xs text-(--text)">Kleurwiel</span>
              </div>
              <input type="text" value={hexInput} onChange={(e) => handleHexChange(e.target.value)}
                maxLength={7} placeholder="#CC785C"
                className="bg-(--input) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-xs font-mono w-28 uppercase focus:outline-none focus:border-(--accent)" />
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg bg-(--input) border border-(--border)">
              <div className="w-8 h-8 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />
              <div className="flex-1">
                <p className="text-xs text-(--muted)">Voorbeeld</p>
                <p className="text-sm" style={{ color: accentColor }}>Geaccentueerde tekst en knoppen</p>
              </div>
              <button type="button" disabled
                className="text-white text-xs px-3 py-1.5 rounded-lg" style={{ backgroundColor: accentColor }}>
                Knop
              </button>
            </div>
          </div>
        </div>

        {/* Moving background */}
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">Bewegende achtergrond</label>
          <div className="flex items-center gap-3">
            <button type="button" role="switch" aria-checked={bgMotion} onClick={() => setBgMotion((v) => !v)}
              className={`relative w-11 h-6 rounded-full transition-colors ${bgMotion ? 'bg-(--accent)' : 'bg-(--border)'}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${bgMotion ? 'translate-x-5' : ''}`} />
            </button>
            <span className="text-sm text-(--text)">{bgMotion ? 'Aan: de gekleurde bollen bewegen rustig' : 'Uit: stilstaande achtergrond'}</span>
          </div>
        </div>

        {/* Prompt suggestions as ghost text in the composer */}
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">Promptsuggesties</label>
          <div className="flex items-center gap-3">
            <button type="button" role="switch" aria-checked={promptSuggest} onClick={() => setPromptSuggest((v) => !v)}
              className={`relative w-11 h-6 rounded-full transition-colors ${promptSuggest ? 'bg-(--accent)' : 'bg-(--border)'}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${promptSuggest ? 'translate-x-5' : ''}`} />
            </button>
            <span className="text-sm text-(--text)">{promptSuggest ? 'Aan: na een antwoord verschijnt een voorstel in het invoerveld (Tab of tik om over te nemen)' : 'Uit: geen voorstellen'}</span>
          </div>
        </div>

        {/* Hosts list for screenshots of sites on this Docker host */}
        <div>
          <label htmlFor="render-hosts" className="block text-sm text-(--muted) mb-1.5">Hostlijst voor screenshots</label>
          <textarea id="render-hosts" value={renderHosts} onChange={(e) => setRenderHosts(e.target.value)} rows={4} maxLength={4000} spellCheck={false}
            placeholder={'# DOEL NAAM [NAAM ...]\nhttp://docker-host:8080 mijnsite.nl www.mijnsite.nl\n192.168.1.20 test.klant.nl'}
            className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) text-sm font-mono focus:outline-none focus:border-(--accent) transition-colors" />
          <p className="mt-1.5 text-xs text-(--muted)">Zoals een hosts-bestand: Claude opent deze domeinen bij een screenshot op het opgegeven adres, zodat je een site op deze server of in het netwerk test voordat de DNS omgaat. docker-host is de server zelf; voeg :poort toe en eventueel http:// of https://.</p>
        </div>

        {/* Remote desktop: notice on the PC */}
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">Melding bij meekijken</label>
          <div className="flex items-center gap-3">
            <button type="button" role="switch" aria-checked={remoteNotice} onClick={() => setRemoteNotice((v) => !v)}
              className={`relative w-11 h-6 rounded-full transition-colors ${remoteNotice ? 'bg-(--accent)' : 'bg-(--border)'}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${remoteNotice ? 'translate-x-5' : ''}`} />
            </button>
            <span className="text-sm text-(--text)">{remoteNotice ? `Aan: op de pc staat "${(user?.name ?? '').split(' ')[0] || 'Jij'} kijkt mee"` : 'Uit: geen melding op de pc'}</span>
          </div>
        </div>

        <hr className="border-(--border)" />

        {/* Default model */}
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">Standaard model</label>
          <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) text-sm focus:outline-none focus:border-(--accent)">
            <option value="">Systeem default ({defaultModelId})</option>
            {modelOptions.filter(m => m.category === 'alias').map(m => (
              <option key={m.id} value={m.id}>{m.label} — {m.description}</option>
            ))}
            <optgroup label="Specifieke versies">
              {modelOptions.filter(m => m.category === 'full').map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </optgroup>
          </select>
        </div>

        </div>
        <div className="space-y-6 min-w-0">
        <h2 className="text-xs font-medium uppercase tracking-wide text-(--muted)">Beveiliging en app</h2>

        {/* 2FA */}
        <div>
          <label className="block text-sm text-(--muted) mb-3">Tweestapsverificatie (TOTP)</label>

          {totpMsg && <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 text-green-400 text-xs mb-2">{totpMsg}</div>}
          {totpErr && <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-xs mb-2">{totpErr}</div>}

          {!user?.totp_enabled && !totpQr && (
            <button type="button" onClick={startTotpSetup} disabled={totpBusy}
              className="bg-(--accent-strong) hover:opacity-90 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-control transition-opacity">
              {totpBusy ? 'Bezig…' : 'Activeren'}
            </button>
          )}

          {!user?.totp_enabled && totpQr && (
            <div className="bg-(--input) border border-(--border) rounded-card p-4 space-y-3">
              <p className="text-xs text-(--muted)">Scan deze QR met jouw authenticator app:</p>
              <img src={totpQr} alt="TOTP QR code" className="w-48 h-48 bg-white rounded-lg p-2" />
              <div>
                <p className="text-xs text-(--muted) mb-1">Of voer handmatig in:</p>
                <code className="block text-xs text-(--text) bg-(--bg) border border-(--border) rounded px-2 py-1 break-all">{totpSecret}</code>
              </div>
              <div>
                <label className="block text-xs text-(--muted) mb-1.5">6-cijferige code uit app</label>
                <input type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                  value={totpVerifyCode}
                  onChange={(e) => setTotpVerifyCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-(--input) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm tracking-widest text-center focus:outline-none focus:border-(--accent)"
                  placeholder="000000" />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={confirmTotp} disabled={totpBusy || totpVerifyCode.length !== 6}
                  className="bg-(--accent-strong) hover:opacity-90 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-control">
                  {totpBusy ? 'Bezig…' : 'Bevestigen'}
                </button>
                <button type="button" onClick={cancelTotp} disabled={totpBusy}
                  className="bg-(--border) hover:bg-(--input) text-(--text) text-sm px-4 py-2 rounded-lg">
                  Annuleren
                </button>
              </div>
            </div>
          )}

          {user?.totp_enabled && (
            <div className="bg-(--input) border border-(--border) rounded-card p-4 space-y-3">
              <p className="text-sm text-green-400">Actief</p>
              <div>
                <label className="block text-xs text-(--muted) mb-1.5">Wachtwoord (om uit te schakelen)</label>
                <input type="password" value={totpDisablePw} onChange={(e) => setTotpDisablePw(e.target.value)}
                  className="w-full bg-(--input) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm focus:outline-none focus:border-(--accent)" />
              </div>
              <button type="button" onClick={disableTotp} disabled={totpBusy || !totpDisablePw}
                className="bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 text-red-400 text-sm px-4 py-2 rounded-lg">
                {totpBusy ? 'Bezig…' : 'Uitschakelen'}
              </button>
            </div>
          )}
        </div>

        <hr className="border-(--border)" />

        {/* Push notifications */}
        <div>
          <label className="block text-sm text-(--muted) mb-3">Notificaties</label>

          {pushMsg && (
            <div className={`rounded-lg px-3 py-2 text-xs mb-2 ${
              pushMsg.startsWith('Fout')
                ? 'bg-red-500/10 border border-red-500/30 text-red-400'
                : 'bg-green-500/10 border border-green-500/30 text-green-400'
            }`}>{pushMsg}</div>
          )}

          {!pushSupported ? (
            <p className="text-xs text-(--muted) italic">
              Geen Web Push in deze browser. iOS: eerst via Safari toevoegen aan beginscherm.
            </p>
          ) : pushEnabled ? (
            <div className="flex gap-2 flex-wrap">
              <button type="button" onClick={handleTestPush} disabled={pushBusy}
                className="text-sm px-4 py-2 rounded-lg bg-(--input) hover:bg-(--border) border border-(--border) text-(--text)">
                Test bericht
              </button>
              <button type="button" onClick={handleDisablePush} disabled={pushBusy}
                className="text-sm px-4 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400">
                {pushBusy ? 'Bezig…' : 'Uitschakelen'}
              </button>
            </div>
          ) : (
            <button type="button" onClick={handleEnablePush} disabled={pushBusy}
              className="bg-(--accent-strong) hover:opacity-90 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-control transition-opacity">
              {pushBusy ? 'Bezig…' : 'Activeren'}
            </button>
          )}
        </div>

        <hr className="border-(--border)" />

        {/* App update against GitHub (admin only) */}
        {user?.role === 'admin' && <AppUpdate />}
        {user?.role === 'admin' && <hr className="border-(--border)" />}

        {/* PWA diagnose (admin only) */}
        {user?.role === 'admin' && (
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">PWA diagnose</label>
          <div className="bg-(--input) border border-(--border) rounded-lg p-3 text-xs font-mono space-y-1">
            {Object.entries(pwaDiag).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-(--muted) shrink-0">{k}:</span>
                <span className="text-(--text) break-all">{v}</span>
              </div>
            ))}
          </div>
        </div>)}

        {/* (separator only when the admin-only block above is shown) */}
        {user?.role === 'admin' && <hr className="border-(--border)" />}

        {/* App data / cache */}
        <div>
          <label className="block text-sm text-(--muted) mb-3">App data</label>
          <button type="button" onClick={handleClearCache}
            className="text-sm px-4 py-2 rounded-lg bg-(--input) hover:bg-(--border) border border-(--border) text-(--text)">
            Cache wissen + herladen
          </button>
        </div>

        <hr className="border-(--border)" />

        {/* Password */}
        <p className="text-sm text-(--muted)">{t('changePassword')}</p>
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">{t('currentPassword')}</label>
          <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)}
            className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) text-sm focus:outline-none focus:border-(--accent)"
            placeholder={t('currentPasswordPlaceholder')} />
        </div>
        <div>
          <label className="block text-sm text-(--muted) mb-1.5">{t('newPassword')}</label>
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} minLength={8}
            className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) text-sm focus:outline-none focus:border-(--accent)"
            placeholder={t('newPasswordPlaceholder')} />
        </div>

        </div>
        </div>

        <button type="submit" disabled={loading}
          className="bg-(--accent-strong) hover:opacity-90 disabled:opacity-50 text-white font-medium px-6 py-2.5 rounded-control text-sm transition-opacity">
          {loading ? tCommon('saving') : tCommon('save')}
        </button>
      </form>

      {/* Phones have no rail with the logout button, so Afmelden lives here */}
      <div className="md:hidden mt-10 pt-6 border-t border-(--border)">
        <button
          type="button"
          onClick={async () => { try { await authApi.logout(); } finally { setUser(null); window.location.href = '/login'; } }}
          className="w-full flex items-center justify-center gap-2 h-12 rounded-xl border border-red-500/30 bg-red-500/10 text-red-400 text-[15px] font-medium active:bg-red-500/20"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" />
          </svg>
          Afmelden
        </button>
      </div>
    </div>
  );
}
