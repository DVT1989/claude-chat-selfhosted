'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from '@/lib/i18n';
import { claudeAuth, models as modelsApi } from '@/lib/api';
import ClaudeAccounts from '@/components/ClaudeAccounts';
import { useAuthStore } from '@/lib/store';

type AuthStatus = 'authenticated' | 'not_configured' | 'error' | 'loading';

export default function ClaudeCodeSettings() {
  const t = useTranslations('settings.claude');
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelsMsg, setModelsMsg] = useState('');

  async function handleRefreshModels() {
    setRefreshingModels(true);
    setModelsMsg('');
    try {
      const res = await modelsApi.refresh();
      setModelsMsg(`Lijst bijgewerkt — ${res.count} versies gevonden`);
    } catch (err) {
      setModelsMsg(`Fout: ${(err as Error).message}`);
    } finally {
      setRefreshingModels(false);
    }
  }

  async function loadStatus() {
    try {
      const res = await claudeAuth.status();
      setStatus(res.status);
    } catch {
      setStatus('error');
    }
  }

  useEffect(() => {
    loadStatus();
    return () => {
      stopPolling();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await claudeAuth.status();
        if (res.status === 'authenticated') {
          stopPolling();
          setStatus('authenticated');
          setAuthUrl(null);
          setManualCode('');
          setMsg('✓ Succesvol ingelogd!');
        }
      } catch { /* keep polling */ }
    }, 2500);
  }

  async function handleStart() {
    setStarting(true);
    setMsg('');
    setAuthUrl(null);
    setManualCode('');
    try {
      const { url } = await claudeAuth.start();
      setAuthUrl(url);
      startPolling();
    } catch (err) {
      setMsg(`✗ ${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  async function handleSubmitCode() {
    if (!manualCode.trim()) return;
    setSubmitting(true);
    setMsg('');
    try {
      await claudeAuth.submitCode(manualCode.trim());
      stopPolling();
      setManualCode('');
      setAuthUrl(null);
      setStatus('authenticated');
      setMsg('✓ Succesvol ingelogd!');
    } catch (err) {
      setMsg(`✗ ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    if (!confirm(t('disconnectConfirm'))) return;
    stopPolling();
    try {
      await claudeAuth.logout();
      setStatus('not_configured');
      setAuthUrl(null);
      setMsg('✓ Uitgelogd');
    } catch (err) {
      setMsg(`✗ ${(err as Error).message}`);
    }
  }

  return (
    <>
    <div className="space-y-8">
      <section>
        <h1 className="text-lg font-semibold text-(--text) mb-6">{t('title')}</h1>

        <div className="bg-(--input) border border-(--border) rounded-card p-5 space-y-5">

          {/* Status */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-(--text)">{t('status')}</h3>
            {status === 'loading' && <span className="text-xs text-(--muted)">Laden…</span>}
            {status === 'authenticated' && (
              <span className="text-xs bg-green-500/15 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full font-medium">
                {t('authenticated')}
              </span>
            )}
            {(status === 'not_configured' || status === 'error') && (
              <span className="text-xs bg-(--border) text-(--muted) border border-(--border) px-2 py-0.5 rounded-full">
                {t('notAuthenticated')}
              </span>
            )}
          </div>

          {/* Authenticated */}
          {status === 'authenticated' && !authUrl && (
            <div className="space-y-3">
              <button onClick={handleLogout}
                className="text-sm text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg
                           border border-red-500/30 hover:border-red-500 transition-colors">
                {t('disconnect')}
              </button>
            </div>
          )}

          {/* Not configured — login button */}
          {(status === 'not_configured' || status === 'error') && !authUrl && (
            <div className="space-y-3">
              <button onClick={handleStart} disabled={starting}
                className="bg-(--accent-strong) hover:brightness-110 disabled:opacity-50 text-white
                           text-sm font-medium px-5 py-2.5 rounded-lg transition-colors">
                {starting ? 'Bezig…' : t('connect')}
              </button>
            </div>
          )}

          {/* Auth in progress — link + code input */}
          {authUrl && (
            <div className="space-y-4">
              {/* Step 1 */}
              <div className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-(--accent-strong) text-white text-xs flex items-center justify-center font-medium">1</span>
                <div className="flex-1 min-w-0 space-y-2">
                  <p className="text-sm text-(--text) break-words">
                    Open de link en log in met je claude.ai account.
                  </p>
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs bg-(--accent-strong) hover:brightness-110
                               text-white px-3 py-1.5 min-h-10 sm:min-h-0 rounded-lg transition-colors"
                  >
                    Inloggen bij Claude ↗
                  </a>
                </div>
              </div>

              {/* Step 2 */}
              <div className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-(--border) text-(--muted) text-xs flex items-center justify-center font-medium">2</span>
                <div className="flex-1 min-w-0 space-y-2">
                  <p className="text-sm text-(--text) break-words">
                    Klik na het inloggen op Authorize, kopieer de lange code (met #) en plak hem hieronder. Niet de cijfercode uit je mail.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="text"
                      value={manualCode}
                      onChange={(e) => setManualCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitCode(); }}
                      placeholder="Plak de code hier…"
                      autoComplete="off" autoCapitalize="none" spellCheck={false}
                      className="w-full min-w-0 sm:flex-1 bg-(--bg) border border-(--border) rounded-lg px-3 py-2.5 sm:py-2
                                 text-(--text) text-base sm:text-sm font-mono focus:outline-none focus:border-(--accent)"
                    />
                    <button
                      onClick={handleSubmitCode}
                      disabled={submitting || !manualCode.trim()}
                      className="bg-(--accent-strong) hover:brightness-110 disabled:opacity-50 text-white
                                 text-sm px-4 py-2 rounded-lg transition-colors w-full sm:w-auto sm:shrink-0 min-h-11 sm:min-h-0">
                      {submitting ? 'Bezig…' : 'Bevestigen'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {msg && (
            <p className={`text-xs ${msg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
              {msg}
            </p>
          )}

          {/* Retry button when auth is in progress */}
          {authUrl && (
            <button onClick={handleStart} disabled={starting}
              className="text-xs text-(--muted) hover:text-(--text) transition-colors py-2 sm:py-0">
              ↺ Opnieuw beginnen
            </button>
          )}
        </div>
      </section>

    </div>


      {status === 'authenticated' && <ClaudeAccounts />}

      {isAdmin && (
        <section className="mt-8">
          <h2 className="text-xl font-semibold text-(--text) mb-4">Beschikbare modellen</h2>
          <div className="bg-(--input) border border-(--border) rounded-card p-5 flex items-center justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <p className="text-sm font-medium text-(--text)">Lijst verversen</p>
              <p className="text-xs text-(--muted)">Na een Claude Code update</p>
              {modelsMsg && (
                <p className={`text-xs mt-1 ${modelsMsg.startsWith('Fout') ? 'text-red-400' : 'text-green-400'}`}>
                  {modelsMsg}
                </p>
              )}
            </div>
            <button
              onClick={handleRefreshModels}
              disabled={refreshingModels}
              className="shrink-0 bg-(--accent-strong) hover:opacity-90 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-control transition-opacity whitespace-nowrap"
            >
              {refreshingModels ? 'Scannen…' : 'Nu verversen'}
            </button>
          </div>
        </section>
      )}

    </>
  );
}
