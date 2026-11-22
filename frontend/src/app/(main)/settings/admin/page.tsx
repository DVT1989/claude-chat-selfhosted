'use client';

import { useState, useEffect, FormEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from '@/lib/i18n';
import { admin } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import type { AdminSession } from '@/types';

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: 'user' | 'admin';
  is_active: boolean;
  conversation_count: string;
};

type Stats = { users: number; conversations: number; messages: number; totalTokens: number };

function fmt(n: number) { return n.toLocaleString('nl-NL'); }



export default function AdminUsersPage() {
  const t = useTranslations('settings.admin');
  const tCommon = useTranslations('common');
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create user form
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState('');

  // Stats
  const [stats, setStats] = useState<Stats | null>(null);

  // Sessions modal
  const [sessionsUser, setSessionsUser] = useState<UserRow | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // which user's edit panel is open, and the new password typed there
  const [editing, setEditing] = useState<string | null>(null);
  const [pwNew, setPwNew] = useState('');
  const [rowMsg, setRowMsg] = useState('');

  async function handleSetPassword(u: UserRow) {
    if (!confirm(`Nieuw wachtwoord instellen voor ${u.name || u.email}? Die wordt overal afgemeld.`)) return;
    try {
      await admin.updateUser(u.id, { password: pwNew });
      setPwNew('');
      setRowMsg('Wachtwoord ingesteld. Geef het door aan de gebruiker.');
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function loadStats() {
    try { setStats(await admin.getStats() as Stats); } catch { /* ignore */ }
  }

  async function openSessions(u: UserRow) {
    setSessionsUser(u);
    setSessions([]);
    setSessionsLoading(true);
    try {
      const r = await admin.listSessions(u.id);
      setSessions(r.sessions);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSessionsLoading(false);
    }
  }

  async function revokeAllSessions() {
    if (!sessionsUser) return;
    if (!confirm(`Alle sessies van ${sessionsUser.email} intrekken?`)) return;
    try {
      const r = await admin.revokeSessions(sessionsUser.id);
      alert(`${r.revoked} sessie(s) ingetrokken`);
      setSessions([]);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function loadUsers() {
    try {
      const res = await admin.listUsers();
      setUsers(res.users as UserRow[]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadUsers(); loadStats(); }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateMsg('');
    try {
      await admin.createUser({ username, name, password, role });
      setUsername('');
      setName('');
      setPassword('');
      setRole('user');
      setCreateMsg(t('createSuccess'));
      await loadUsers();
    } catch (err) {
      setCreateMsg(`✗ ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string, userEmail: string) {
    if (!confirm(t('deleteConfirm', { email: userEmail }))) return;
    try {
      await admin.deleteUser(id);
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleToggleRole(u: UserRow) {
    const next = u.role === 'admin' ? 'user' : 'admin';
    const label = next === 'admin' ? t('roleAdmin') : t('roleUser');
    if (!confirm(`${u.name || u.email} wordt ${label.toLowerCase()}. Die wordt op al zijn apparaten afgemeld. Doorgaan?`)) return;
    try {
      await admin.updateUser(u.id, { role: next });
      setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, role: next } : x));
    } catch (err) {
      alert((err as Error).message);
    }
  }

  async function handleToggleActive(id: string, current: boolean) {
    try {
      await admin.updateUser(id, { isActive: !current });
      setUsers((prev) => prev.map((u) => u.id === id ? { ...u, is_active: !current } : u));
    } catch (err) {
      alert((err as Error).message);
    }
  }

  if (loading) return <div className="text-(--muted) text-sm">{tCommon('loading')}</div>;

  return (
    <div className="space-y-8">
      {/* Stats */}
      <section>
        {/* wraps cleanly on phones: title on its own line, the two actions together below it */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-3">
          <h2 className="text-lg font-semibold text-(--text) whitespace-nowrap">Systeem statistieken</h2>
          <div className="flex items-center gap-2 shrink-0">
            <Link href="/settings/admin/logs" className="text-xs text-(--accent) hover:underline whitespace-nowrap">
              Auditlog bekijken
            </Link>
            <button onClick={loadStats} className="text-xs text-(--muted) hover:text-(--text) px-2 py-1 rounded hover:bg-(--input)">
              Vernieuwen
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Gebruikers', val: stats?.users },
            { label: 'Gesprekken', val: stats?.conversations },
            { label: 'Berichten', val: stats?.messages },
            { label: 'Totaal tokens', val: stats?.totalTokens },
          ].map((s) => (
            <div key={s.label} className="bg-(--input) border border-(--border) rounded-card p-4">
              <div className="text-xs text-(--muted) mb-1">{s.label}</div>
              <div className="text-xl font-semibold text-(--text)">
                {s.val === undefined ? '…' : fmt(s.val)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Sessions modal */}
      {sessionsUser && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center px-4" onClick={() => setSessionsUser(null)}>
          <div className="bg-(--bg) border border-(--border) rounded-card p-5 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-(--text)">Sessies — {sessionsUser.email}</h3>
              <button onClick={() => setSessionsUser(null)} className="text-(--muted) hover:text-(--text)">✕</button>
            </div>
            <button
              onClick={revokeAllSessions}
              disabled={sessions.length === 0}
              className="bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 text-red-400 text-xs px-3 py-1.5 rounded-lg mb-3"
            >
              Alle sessies intrekken
            </button>
            {sessionsLoading ? (
              <div className="text-(--muted) text-sm">Laden…</div>
            ) : sessions.length === 0 ? (
              <div className="text-(--muted) text-sm">Geen actieve sessies.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-(--border) text-left text-(--muted)">
                    <th className="py-2">Aangemaakt</th>
                    <th className="py-2">Verloopt</th>
                    <th className="py-2">IP</th>
                    <th className="py-2">User-Agent</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-b border-(--border) last:border-0">
                      <td className="py-2 text-(--muted)">{new Date(s.created_at).toLocaleString('nl-NL')}</td>
                      <td className="py-2 text-(--muted)">{new Date(s.expires_at).toLocaleString('nl-NL')}</td>
                      <td className="py-2 text-(--muted)">{s.ip_address ?? '—'}</td>
                      <td className="py-2 text-(--muted) truncate max-w-[200px]" title={s.user_agent ?? ''}>{s.user_agent ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Create user */}
      <section>
        <h2 className="text-lg font-semibold text-(--text) mb-4">{t('createUser')}</h2>
        <div className="bg-(--input) border border-(--border) rounded-card p-5">
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-(--muted) mb-1.5">{t('username')}</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  placeholder={t('usernamePlaceholder')}
                  className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2
                             text-(--text) text-sm focus:outline-none focus:border-(--accent)"
                />
              </div>
              <div>
                <label className="block text-xs text-(--muted) mb-1.5">{t('fullName')}</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder={t('fullNamePlaceholder')}
                  className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2
                             text-(--text) text-sm focus:outline-none focus:border-(--accent)"
                />
              </div>
              <div>
                <label className="block text-xs text-(--muted) mb-1.5">{t('password')}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder={t('passwordPlaceholder')}
                  className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2
                             text-(--text) text-sm focus:outline-none focus:border-(--accent)"
                />
              </div>
              <div>
                <label className="block text-xs text-(--muted) mb-1.5">{t('role')}</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
                  className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2
                             text-(--text) text-sm focus:outline-none focus:border-(--accent)"
                >
                  <option value="user">{t('roleUser')}</option>
                  <option value="admin">{t('roleAdmin')}</option>
                </select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={creating}
                className="bg-(--accent-strong) hover:brightness-110 disabled:opacity-50 text-white
                           text-sm font-medium px-5 py-2 rounded-lg transition-colors"
              >
                {creating ? t('creating') : t('createBtn')}
              </button>
              {createMsg && (
                <span className={`text-xs ${createMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
                  {createMsg}
                </span>
              )}
            </div>
          </form>
        </div>
      </section>

      {/* Users list */}
      <section>
        <h2 className="text-lg font-semibold text-(--text) mb-4">
          {t('usersTitle')}
          <span className="ml-2 text-sm font-normal text-(--muted)">({users.length})</span>
        </h2>
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm mb-4">
            {error}
          </div>
        )}
        <div className="space-y-2">
          {users.map((u, i) => {
            const self = u.id === currentUser?.id;
            const open = editing === u.id;
            return (
              <div key={u.id} className={`user-card wa-row-in ${open ? 'is-open' : ''}`} style={{ '--i': Math.min(i, 10) } as React.CSSProperties}>
                <button type="button" className="w-full flex items-center gap-3 text-left" aria-expanded={open}
                  onClick={() => { setEditing(open ? null : u.id); setPwNew(''); setRowMsg(''); }}>
                  <span className="user-initial" aria-hidden>{(u.name?.[0] ?? u.email[0] ?? '?').toUpperCase()}</span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-(--text) text-sm truncate">{u.name || u.email}</span>
                      {self && <span className="text-[11px] text-(--muted)">(jij)</span>}
                    </span>
                    <span className="block text-xs text-(--muted) truncate">{u.email} · {u.conversation_count} gesprekken</span>
                  </span>
                  <span className={`role-pill ${u.role === 'admin' ? 'is-admin' : ''}`}>{u.role === 'admin' ? t('roleAdmin') : t('roleUser')}</span>
                  {!u.is_active && <span className="role-pill is-off">Uit</span>}
                  <svg className={`w-4 h-4 text-(--muted) shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>

                {open && (
                  <div className="user-edit">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <p className="text-xs text-(--muted) mb-1.5">Rol</p>
                        <div className="sub-tabs">
                          {(['user', 'admin'] as const).map((r) => (
                            <button key={r} type="button" disabled={self || u.role === r}
                              onClick={() => void handleToggleRole(u)}
                              className={`sub-tab ${u.role === r ? 'sub-tab-on role-on' : ''}`}>
                              {r === 'admin' ? t('roleAdmin') : t('roleUser')}
                            </button>
                          ))}
                        </div>
                        {self && <p className="text-[11px] text-(--muted) mt-1.5">Je eigen rol kun je niet wijzigen.</p>}
                      </div>
                      <div>
                        <p className="text-xs text-(--muted) mb-1.5">Account</p>
                        <label className="flex items-center gap-3 h-11">
                          <input type="checkbox" className="ios-switch" checked={u.is_active} disabled={self}
                            onChange={() => handleToggleActive(u.id, u.is_active)} aria-label="Account actief" />
                          <span className="text-sm text-(--text)">{u.is_active ? 'Actief: kan inloggen' : 'Uitgeschakeld'}</span>
                        </label>
                      </div>
                    </div>

                    <div className="mt-4">
                      <p className="text-xs text-(--muted) mb-1.5">Nieuw wachtwoord instellen</p>
                      <div className="flex gap-2">
                        <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} minLength={8}
                          placeholder="Minimaal 8 tekens…" autoComplete="new-password" aria-label="Nieuw wachtwoord"
                          className="flex-1 min-w-0 bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm focus:outline-none focus:border-(--accent)" />
                        <button type="button" disabled={pwNew.length < 8} onClick={() => void handleSetPassword(u)}
                          className="px-3 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-40">
                          Instellen
                        </button>
                      </div>
                    </div>

                    {rowMsg && <p className="text-sm text-green-400 mt-3" role="status">{rowMsg}</p>}

                    <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-(--border)">
                      <button type="button" onClick={() => openSessions(u)}
                        className="text-sm px-3 py-2 rounded-lg border border-(--border) text-(--text) hover:bg-(--border) transition-colors">
                        Sessies bekijken
                      </button>
                      {!self && (
                        <button type="button" onClick={() => handleDelete(u.id, u.email)}
                          className="text-sm px-3 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors">
                          {t('deleteUser')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>    </div>
  );
}
