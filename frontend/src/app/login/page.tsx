'use client';

import { Suspense, useEffect, useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from '@/lib/i18n';
import { auth } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import type { User } from '@/types';
import ClaudeLogo from '@/components/ClaudeLogo';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setUser = useAuthStore((s) => s.setUser);
  const t = useTranslations('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const reden = searchParams.get('reden');
  const notice = reden === 'totp-aan' ? 'Tweestapsverificatie staat aan. Je bent overal uitgelogd: log opnieuw in met je code.'
    : reden === 'totp-uit' ? 'Tweestapsverificatie staat uit. Je bent overal uitgelogd: log opnieuw in.'
    : reden === 'verlopen' ? 'Je sessie is verlopen. Log opnieuw in.' : '';
  const [loading, setLoading] = useState(false);
  const [needsTotp, setNeedsTotp] = useState(reden === 'totp-aan');
  const [totpCode, setTotpCode] = useState('');
  const [remember, setRemember] = useState(true);

  // Already signed in? An iOS home-screen app can land here because its first request went out
  // without the cookie; this same-site call does carry it (and turns an old Strict cookie into Lax).
  useEffect(() => {
    let alive = true;
    auth.me()
      .then((res) => {
        if (!alive) return;
        setUser((res as { user: User }).user);
        const from = searchParams.get('from');
        router.replace(from && from.startsWith('/') && !from.startsWith('//') ? from : '/chat');
      })
      .catch(() => { /* not signed in: show the form */ });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await auth.login(email, password, needsTotp ? totpCode : undefined, remember) as { user: User };
      setUser(res.user);
      const from = searchParams.get('from') ?? '/chat';
      router.push(from);
    } catch (err) {
      const msg = (err as Error).message;
      const errAny = err as { data?: { requires_totp?: boolean }; requires_totp?: boolean };
      if (errAny?.data?.requires_totp || errAny?.requires_totp || /TOTP/i.test(msg)) {
        setNeedsTotp(true);
        setError(needsTotp ? t('codeWrong') : '');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      {/* Logo */}
      <div className="text-center mb-8">
        <div className="glass-panel w-[72px] h-[72px] rounded-[22px] flex items-center justify-center mx-auto mb-5">
          <ClaudeLogo className="w-11 h-11 relative z-10" />
        </div>
        <h1 className="text-2xl font-semibold text-(--text)">{t('title')}</h1>
        <p className="text-(--muted) text-sm mt-1">{t('subtitle')}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-card border border-(--card-border) bg-(--card-bg) shadow-(--card-shadow) backdrop-blur-xl p-5">
        {notice && !error && (
          <div className="bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) text-sm motion-safe:animate-[ccFadeIn_.2s_ease-out]">
            {notice}
          </div>
        )}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm text-(--muted) mb-1.5">{t('username')}</label>
          <input
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3
                       text-(--text) placeholder-(--muted) text-sm
                       focus:outline-none focus:border-(--accent) focus:ring-1 focus:ring-(--accent)
                       transition-colors"
            placeholder={t('username')}
          />
        </div>

        <div>
          <label className="block text-sm text-(--muted) mb-1.5">{t('password')}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3
                       text-(--text) placeholder-(--muted) text-sm
                       focus:outline-none focus:border-(--accent) focus:ring-1 focus:ring-(--accent)
                       transition-colors"
            placeholder="••••••••"
          />
        </div>

        {needsTotp && (
          <div>
            <label className="block text-sm text-(--muted) mb-1.5">{t('totpLabel')}</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              required
              autoFocus
              autoComplete="one-time-code"
              className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) placeholder-(--muted) text-sm focus:outline-none focus:border-(--accent) focus:ring-1 focus:ring-(--accent) transition-colors tracking-widest text-center"
              placeholder="000000"
            />
            <p className="text-xs text-(--muted) mt-1.5">6-cijferige code uit jouw authenticator app</p>
          </div>
        )}

        <label className="flex items-center justify-between gap-3 py-1 cursor-pointer select-none">
          <span>
            <span className="block text-sm text-(--text)">{t('remember')}</span>
            <span className="block text-xs text-(--muted)">90 dagen ingelogd blijven op dit apparaat</span>
          </span>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="ios-switch" />
        </label>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-(--accent-strong) hover:brightness-110 disabled:opacity-50
                     text-white font-medium py-3 rounded-lg text-sm
                     transition-colors focus:outline-none focus:ring-2 focus:ring-(--accent) focus:ring-offset-2 focus:ring-offset-(--bg)"
        >
          {loading ? t('submitting') : t('submit')}
        </button>
      </form>

    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-(--bg) px-4 pt-safe pb-safe">
      <Suspense fallback={
        <div className="w-12 h-12 rounded-full border-2 border-(--accent) border-t-transparent animate-spin" />
      }>
        <LoginForm />
      </Suspense>
    </div>
  );
}
