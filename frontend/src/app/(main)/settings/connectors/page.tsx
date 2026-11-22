'use client';

import { useState, useEffect, FormEvent, Suspense } from 'react';
import EmptyState from '@/components/ui/EmptyState';
import { NavIcons } from '@/components/navItems';
import { useTranslations } from '@/lib/i18n';
import { connectors as connApi } from '@/lib/api';
import type { Connector } from '@/types';
import BrowserConnectorCard from '@/components/devices/BrowserConnectorCard';

const CONNECTOR_TYPES = [
  { value: 'git',    label: 'Git',       fields: [{ key: 'url',  label: 'Repository URL', type: 'text' }],                                                                credFields: [{ key: 'token', label: 'Access Token', type: 'password' }, { key: 'username', label: 'Gebruikersnaam', type: 'text' }] },
  { value: 'github', label: 'GitHub',    fields: [],                                                                                                                       credFields: [{ key: 'token', label: 'Token (github.com/settings/tokens)', type: 'password' }] },
  { value: 'ssh',    label: 'SSH',       fields: [{ key: 'host', label: 'Host', type: 'text' }, { key: 'port', label: 'Poort', type: 'number' }],                         credFields: [{ key: 'username', label: 'Gebruikersnaam', type: 'text' }, { key: 'password', label: 'Wachtwoord', type: 'password' }, { key: 'sudo_password', label: 'Sudo wachtwoord (optioneel)', type: 'password', optional: true }] },
  { value: 'sftp',   label: 'SFTP',      fields: [{ key: 'host', label: 'Host', type: 'text' }, { key: 'port', label: 'Poort (standaard 22)', type: 'number' }, { key: 'dir', label: 'Startmap (optioneel)', type: 'text' }], credFields: [{ key: 'username', label: 'Gebruikersnaam', type: 'text' }, { key: 'password', label: 'Wachtwoord (of private key hieronder)', type: 'password', optional: true }, { key: 'private_key', label: 'Private key (optioneel, plak de hele sleutel)', type: 'textarea', optional: true }] },
  { value: 'ftp',    label: 'FTP',       fields: [{ key: 'host', label: 'Host', type: 'text' }],                                                                          credFields: [{ key: 'username', label: 'Gebruikersnaam', type: 'text' }, { key: 'password', label: 'Wachtwoord', type: 'password' }] },
  { value: 'smb',    label: 'SMB/Samba', fields: [{ key: 'host', label: 'Host', type: 'text' }, { key: 'share', label: 'Share naam', type: 'text' }],                     credFields: [{ key: 'username', label: 'Gebruikersnaam', type: 'text' }, { key: 'password', label: 'Wachtwoord', type: 'password' }] },
  { value: 'focustrack', label: 'FocusTrack', fields: [{ key: 'url', label: 'Serveradres, bijv. https://focustrack.example.com', type: 'text' }],                         credFields: [{ key: 'key', label: 'Koppelingssleutel (AIO-site › API-sleutels › soort Koppeling)', type: 'password' }] },
  { value: 'python', label: 'Python',    fields: [],                                                                                                                       credFields: [] },
] as const;

type ConnectorTypeValue = (typeof CONNECTOR_TYPES)[number]['value'];

function ConnectorsPage() {
  const t = useTranslations('settings.connectors');
  const tCommon = useTranslations('common');
  const [list, setList] = useState<Connector[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<ConnectorTypeValue>('git');
  const [configVals, setConfigVals] = useState<Record<string, string>>({});
  const [credVals, setCredVals] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; msg: string }>>({});

  async function load() {
    try {
      const res = await connApi.list();
      setList(res.connectors.filter((c) => (c.type as string) !== 'm365')); // tenants live under Microsoft 365
    } catch { /* ignore */ } finally { setLoaded(true); }
  }

  useEffect(() => { load(); }, []);

  const selectedType = CONNECTOR_TYPES.find((ct) => ct.value === type);

  function resetForm() {
    setName(''); setConfigVals({}); setCredVals({});
    setEditingId(null); setError('');
    setType('git');
  }

  function startEdit(conn: Connector) {
    if (conn.type === 'sudo') {
      // Legacy type — can't edit through new form. Suggest delete + recreate as SSH with sudo_password.
      setError('Oude sudo connector — verwijder en voeg toe aan een SSH connector via "Sudo wachtwoord" veld.');
      return;
    }
    setEditingId(conn.id);
    setName(conn.name);
    setType(conn.type as ConnectorTypeValue);
    const cfg: Record<string, string> = {};
    Object.entries(conn.config ?? {}).forEach(([k, v]) => { cfg[k] = String(v ?? ''); });
    setConfigVals(cfg);
    setCredVals({}); // credentials never returned — empty means "keep existing"
    setShowForm(true);
    setError('');
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const cfg: Record<string, unknown> = {};
      const credentials: Record<string, unknown> = {};
      selectedType?.fields.forEach((f) => { if (configVals[f.key]) cfg[f.key] = configVals[f.key]; });
      selectedType?.credFields.forEach((f) => { if (credVals[f.key]) credentials[f.key] = credVals[f.key]; });

      if (editingId) {
        // Edit: only send credentials if user filled at least one cred field
        const hasCreds = Object.keys(credentials).length > 0;
        await connApi.update(editingId, {
          name,
          config: cfg,
          ...(hasCreds ? { credentials } : {}),
        });
        setNotice('Connector bijgewerkt');
      } else {
        await connApi.create({
          name, type, config: cfg,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
        });
        setNotice('Connector toegevoegd');
      }
      resetForm();
      setShowForm(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleTest(id: string) {
    setTesting(id);
    try {
      const res = await connApi.test(id);
      setTestMsg((m) => ({ ...m, [id]: { ok: res.ok, msg: res.message } }));
      // the test button shows the result right away (✓ / ✗)
      setList((prev) => prev.map((c) => (c.id === id ? { ...c, test_status: res.ok ? 'ok' : 'error' } : c)));
    } catch (err) {
      setTestMsg((m) => ({ ...m, [id]: { ok: false, msg: (err as Error).message } }));
      setList((prev) => prev.map((c) => (c.id === id ? { ...c, test_status: 'error' } : c)));
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t('deleteConfirm'))) return;
    try {
      await connApi.delete(id);
      setList((l) => l.filter((c) => c.id !== id));
    } catch { /* ignore */ }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-(--text)">{t('title')}</h1>
        <button
          onClick={() => { if (showForm) { resetForm(); setShowForm(false); } else { resetForm(); setShowForm(true); } }}
          className="bg-(--accent-strong) hover:brightness-110 text-white text-sm font-medium px-4 py-2 rounded-control transition-colors"
        >
          {showForm ? tCommon('cancel') : t('add')}
        </button>
      </div>

      {notice && (
        <div className="mb-4 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3 text-green-400 text-sm">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      <BrowserConnectorCard />

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6 bg-(--input) border border-(--border) rounded-card p-4 space-y-3">
          <p className="text-xs text-(--muted) -mb-1">
            {editingId ? 'Connector bewerken' : 'Nieuwe connector'}
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-(--muted) mb-1">{t('name')}</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
                className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm focus:outline-none focus:border-(--accent)"
                placeholder={t('namePlaceholder')} />
            </div>
            <div>
              <label className="block text-xs text-(--muted) mb-1">{t('type')}</label>
              <select value={type} disabled={!!editingId}
                onChange={(e) => { setType(e.target.value as ConnectorTypeValue); setConfigVals({}); setCredVals({}); }}
                className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm focus:outline-none focus:border-(--accent) disabled:opacity-60">
                {CONNECTOR_TYPES.map((ct) => (
                  <option key={ct.value} value={ct.value}>{ct.label}</option>
                ))}
              </select>
            </div>
          </div>

          {selectedType?.fields.map((f) => (
            <div key={f.key}>
              <label className="block text-xs text-(--muted) mb-1">{f.label}</label>
              <input type={f.type} value={configVals[f.key] ?? ''} onChange={(e) => setConfigVals((v) => ({ ...v, [f.key]: e.target.value }))}
                className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm focus:outline-none focus:border-(--accent)" />
            </div>
          ))}

          {(selectedType?.credFields.length ?? 0) > 0 && (
            <>
              <p className="text-xs text-(--muted) border-t border-(--border) pt-2">
                {t('credentials')}
                {editingId && <span className="ml-2 italic">— leeg = ongewijzigd</span>}
              </p>
              {selectedType?.credFields.map((f) => (
                <div key={f.key}>
                  <label className="block text-xs text-(--muted) mb-1">{f.label}</label>
                  {f.type === 'textarea' ? (
                    <textarea rows={4}
                      value={credVals[f.key] ?? ''}
                      onChange={(e) => setCredVals((v) => ({ ...v, [f.key]: e.target.value }))}
                      placeholder={editingId ? '••••••• (ongewijzigd)' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                      spellCheck={false}
                      className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-xs font-mono focus:outline-none focus:border-(--accent)" />
                  ) : (
                  <input type={f.type}
                    value={credVals[f.key] ?? ''}
                    onChange={(e) => setCredVals((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={editingId ? '••••••• (ongewijzigd)' : ''}
                    className="w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm focus:outline-none focus:border-(--accent)" />
                  )}
                </div>
              ))}
            </>
          )}

          <div className="flex gap-2 pt-1">
            <button type="submit" className="bg-(--accent-strong) hover:brightness-110 text-white text-sm px-4 py-2 rounded-control transition-colors">
              {editingId ? 'Opslaan' : t('save')}
            </button>
            <button type="button" onClick={() => { resetForm(); setShowForm(false); }} className="text-(--muted) hover:text-(--text) text-sm px-4 py-2 rounded-lg transition-colors">
              {tCommon('cancel')}
            </button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {loaded && list.length === 0 && (
          <EmptyState icon={NavIcons.connectors('w-5 h-5')} title="Nog geen connectoren"
            text={t('empty').replace('Sudo of Python', 'Sudo, Python of FocusTrack')}
            action={showForm ? undefined : { label: 'Connector toevoegen', onClick: () => { resetForm(); setShowForm(true); } }} />
        )}

        {list.map((conn, i) => (
          <div key={conn.id} className="conn-row wa-row-in" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}>
            <span className="conn-type" aria-hidden>{conn.type.slice(0, 3).toUpperCase()}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium text-(--text) text-sm truncate">{conn.name}</span>
                <span className="hidden sm:inline text-[11px] text-(--muted) uppercase tracking-wide shrink-0">{conn.type}</span>
              </div>
              {testMsg[conn.id] && (
                <p className={`text-xs mt-0.5 truncate ${testMsg[conn.id].ok ? 'text-green-400' : 'text-red-400'}`} title={testMsg[conn.id].msg}>
                  {testMsg[conn.id].msg}
                </p>
              )}
            </div>
            <button
              onClick={async () => {
                try {
                  await connApi.update(conn.id, { isActive: !conn.is_active } as never);
                  setList(prev => prev.map(c => c.id === conn.id ? { ...c, is_active: !c.is_active } : c));
                } catch (e) { setError((e as Error).message); }
              }}
              title={conn.is_active ? 'Connector uitschakelen' : 'Connector inschakelen'}
              className={`conn-state ${conn.is_active ? 'is-on' : ''}`}
            >
              <span className="conn-dot" aria-hidden />
              {conn.is_active ? 'Actief' : 'Uit'}
            </button>
            <div className="flex items-center gap-1 shrink-0">
              {/* the last test result is shown on the test button itself */}
              <button onClick={() => handleTest(conn.id)} disabled={testing === conn.id}
                aria-label={`${conn.name} testen`} title={conn.test_status === 'ok' ? 'Laatste test: OK. Opnieuw testen' : conn.test_status === 'error' ? 'Laatste test mislukt. Opnieuw testen' : 'Testen'}
                className={`icon-btn ${conn.test_status === 'ok' ? 'is-ok' : conn.test_status === 'error' ? 'is-err' : ''}`}>
                {testing === conn.id ? (
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.5" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
                ) : conn.test_status === 'ok' ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                ) : conn.test_status === 'error' ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                )}
              </button>
              <button onClick={() => startEdit(conn)} aria-label={`${conn.name} bewerken`} title="Bewerken" className="icon-btn">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
              </button>
              <button onClick={() => handleDelete(conn.id)} aria-label={`${conn.name} verwijderen`} title={tCommon('delete')} className="icon-btn is-danger">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ConnectorsSettings() {
  const tCommon = useTranslations('common');
  return (
    <Suspense fallback={<div className="animate-pulse text-(--muted) text-sm">{tCommon('loading')}</div>}>
      <ConnectorsPage />
    </Suspense>
  );
}
