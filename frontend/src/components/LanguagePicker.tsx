'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/lib/store';
import { useLocale, useTranslations } from '@/lib/i18n';
import { auth as authApi, claudeAuth, i18nApi } from '@/lib/api';

interface Job { status: 'running' | 'done' | 'error'; done: number; total: number; code?: string; name?: string; error?: string; fallbackKeys: number }

/** Language choice (applies at once, no rebuild) and, with Claude linked, "Add language" which has Claude translate en.json. */
export default function LanguagePicker() {
  const t = useTranslations('settings.language');
  const { user, setUser } = useAuthStore();
  const { locale, setLocale } = useLocale();
  const [languages, setLanguages] = useState<{ code: string; name: string }[]>([{ code: 'en', name: 'English' }, { code: 'nl', name: 'Nederlands' }]);
  const [linked, setLinked] = useState(false);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = () => i18nApi.languages().then((r) => setLanguages(r.languages)).catch(() => {});
  useEffect(() => {
    reload();
    claudeAuth.status().then((r) => setLinked(r.status === 'authenticated')).catch(() => {});
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  async function choose(code: string) {
    setError('');
    await setLocale(code);
    try {
      const res = await authApi.updateProfile({ language: code });
      const updated = (res as { user?: typeof user }).user;
      if (updated) setUser(updated); else if (user) setUser({ ...user, language: code });
    } catch (e) { setError((e as Error).message); }
  }

  async function start() {
    setError(''); setJob({ status: 'running', done: 0, total: 0, fallbackKeys: 0 });
    try {
      const { jobId } = await i18nApi.generate(input.trim());
      timer.current = setInterval(async () => {
        try {
          const j = await i18nApi.job(jobId);
          setJob(j);
          if (j.status !== 'running') {
            if (timer.current) clearInterval(timer.current);
            if (j.status === 'done') { await reload(); setInput(''); setAdding(false); if (j.code) await choose(j.code); }
            else setError(j.error ?? t('failed'));
          }
        } catch { /* backend restarting: keep polling */ }
      }, 2500);
    } catch (e) { setJob(null); setError((e as Error).message); }
  }

  const running = job?.status === 'running';
  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div>
      <label className="block text-sm text-(--muted) mb-1.5">{t('label')}</label>
      <select value={locale} onChange={(e) => choose(e.target.value)}
        className="w-full bg-(--input) border border-(--border) rounded-lg px-4 py-3 text-(--text) text-sm focus:outline-none focus:border-(--accent)">
        {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
      </select>
      {linked && !adding && !running && (
        <button type="button" onClick={() => setAdding(true)} className="mt-2 text-sm text-(--accent) hover:underline">{t('add')}</button>
      )}
      {linked && (adding || running) && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)} disabled={running} placeholder={t('placeholder')} maxLength={40}
              className="flex-1 min-w-0 bg-(--input) border border-(--border) rounded-lg px-4 py-2.5 text-(--text) text-sm focus:outline-none focus:border-(--accent)" />
            <button type="button" onClick={start} disabled={running || input.trim().length < 2}
              className="px-4 py-2.5 rounded-lg bg-(--accent) text-white text-sm disabled:opacity-50">{t('generate')}</button>
            {!running && <button type="button" onClick={() => { setAdding(false); setError(''); }} className="px-3 py-2.5 text-sm text-(--muted)">{t('cancel')}</button>}
          </div>
          {running && (
            <div>
              <div className="h-1.5 rounded-full bg-(--border) overflow-hidden"><div className="h-full bg-(--accent) transition-all" style={{ width: `${Math.max(pct, 4)}%` }} /></div>
              <p className="text-xs text-(--muted) mt-1">{job?.total ? t('progress', { done: job.done, total: job.total }) : t('detecting')}</p>
            </div>
          )}
          <p className="text-xs text-(--muted)">{t('hint')}</p>
        </div>
      )}
      {job?.status === 'done' && job.fallbackKeys > 0 && <p className="text-xs text-(--muted) mt-1">{t('fallback', { n: job.fallbackKeys })}</p>}
      {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
    </div>
  );
}
