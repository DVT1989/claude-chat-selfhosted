'use client';

import { useState } from 'react';
import { api, Device, ghost, primary } from '../shared';
import { Card, ErrorText, Field, inputCls, KV, relTime, useLoad } from '../ui';

const patchDevice = (d: Device, body: Record<string, unknown>) =>
  api<{ device: Device }>(`/${d.id}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.device);

export const ROLES = ['Windows Workstation', 'Windows Laptop', 'Windows Server', 'Mac Workstation', 'Mac Laptop', 'Virtuele machine', 'Overig'];

/** Standard custom fields (NinjaOne "Standaard velden"); free fields can be added below them. */
export const STD_FIELDS: Array<{ key: string; label: string; type: 'text' | 'date' | 'number' | 'textarea' }> = [
  { key: 'asset_tag', label: 'Assetnummer', type: 'text' },
  { key: 'warranty_start', label: 'Garantie vanaf', type: 'date' },
  { key: 'warranty_end', label: 'Garantie tot', type: 'date' },
  { key: 'purchase_date', label: 'Aankoopdatum', type: 'date' },
  { key: 'supplier', label: 'Leverancier', type: 'text' },
  { key: 'cost', label: 'Aanschafprijs (EUR)', type: 'number' },
  { key: 'description', label: 'Omschrijving', type: 'textarea' },
];

export function GeneralSettings({ d, onDevice }: { d: Device; onDevice: (d: Device) => void }) {
  const [f, setF] = useState({ name: d.name, display_name: d.display_name ?? '', role: d.role ?? '', org: d.org ?? '', location: d.location ?? '', assigned_user: d.assigned_user ?? '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setF({ ...f, [k]: e.target.value }); setOk(false); };
  async function save() {
    setBusy(true); setErr('');
    try { onDevice(await patchDevice(d, { ...f, name: f.name.trim() || d.name })); setOk(true); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Apparaatinformatie">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Apparaatnaam"><input value={f.name} onChange={set('name')} className={`${inputCls} w-full`} /></Field>
          <Field label="Displaynaam" hint="Optioneel, getoond in plaats van de naam"><input value={f.display_name} onChange={set('display_name')} className={`${inputCls} w-full`} /></Field>
          <Field label="Rol"><select value={f.role} onChange={set('role')} className={`${inputCls} w-full`}><option value="">Automatisch</option>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Field label="Toegewezen gebruiker"><input value={f.assigned_user} onChange={set('assigned_user')} className={`${inputCls} w-full`} placeholder={d.inventory?.user ?? ''} /></Field>
          <Field label="Organisatie"><input value={f.org} onChange={set('org')} className={`${inputCls} w-full`} /></Field>
          <Field label="Locatie"><input value={f.location} onChange={set('location')} className={`${inputCls} w-full`} /></Field>
        </div>
        <ErrorText err={err} />
        <div className="flex items-center gap-3">
          <button className={primary} disabled={busy} onClick={() => void save()}>{busy ? 'Opslaan…' : 'Opslaan'}</button>
          {ok && <span className="text-xs text-green-500">Opgeslagen</span>}
        </div>
      </Card>
      <Card title="Agent en koppeling">
        <KV rows={[
          ['Hostnaam', d.hostname], ['Agentversie', d.agent_version], ['Gekoppeld', relTime(d.created_at)], ['Laatst gezien', relTime(d.last_seen_at)],
          ['Extern IP', d.last_ip], ['Eigenaar', d.owner], ['Status', d.enabled ? 'Ingeschakeld' : 'Uitgeschakeld'],
        ]} />
        <div className="flex flex-wrap gap-2">
          <button className={ghost} onClick={async () => { try { onDevice(await patchDevice(d, { enabled: !d.enabled })); } catch (e) { setErr((e as Error).message); } }}>{d.enabled ? 'Uitschakelen' : 'Inschakelen'}</button>
          <a className={ghost} href="/settings/apparaten">Koppelingen beheren</a>
        </div>
      </Card>
    </div>
  );
}

export function CustomFields({ d, onDevice }: { d: Device; onDevice: (d: Device) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(d.custom ?? {}).map(([k, v]) => [k, v == null ? '' : String(v)])));
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const std = new Set(STD_FIELDS.map((x) => x.key));
  const extra = Object.keys(vals).filter((k) => !std.has(k));
  async function save(next = vals) {
    setBusy(true); setErr('');
    const custom = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '').map(([k, v]) => [k, v]));
    try { onDevice(await patchDevice(d, { custom })); setOk(true); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  const set = (k: string, v: string) => { setVals({ ...vals, [k]: v }); setOk(false); };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Standaard velden">
        <div className="grid gap-3 sm:grid-cols-2">
          {STD_FIELDS.map((fd) => (
            <Field key={fd.key} label={fd.label}>
              {fd.type === 'textarea'
                ? <textarea value={vals[fd.key] ?? ''} onChange={(e) => set(fd.key, e.target.value)} rows={3} className={`${inputCls} w-full`} />
                : <input type={fd.type} value={vals[fd.key] ?? ''} onChange={(e) => set(fd.key, e.target.value)} className={`${inputCls} w-full`} />}
            </Field>
          ))}
        </div>
      </Card>
      <Card title="Eigen velden">
        {!extra.length && <p className="text-xs text-(--muted)">Nog geen eigen velden.</p>}
        <div className="space-y-2">
          {extra.map((k) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-40 shrink-0 text-xs text-(--muted) truncate" title={k}>{k}</span>
              <input value={vals[k]} onChange={(e) => set(k, e.target.value)} className={`${inputCls} flex-1`} />
              <button className="text-xs text-red-400 hover:underline" onClick={() => { const n = { ...vals }; delete n[k]; setVals(n); void save(n); }}>Verwijderen</button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="Nieuw veld, bijv. Kantoor" className={`${inputCls} flex-1`} />
          <button className={ghost} disabled={!newKey.trim() || newKey.trim() in vals} onClick={() => { set(newKey.trim(), ''); setNewKey(''); }}>Toevoegen</button>
        </div>
      </Card>
      <div className="lg:col-span-2 flex items-center gap-3">
        <button className={primary} disabled={busy} onClick={() => void save()}>{busy ? 'Opslaan…' : 'Opslaan'}</button>
        {ok && <span className="text-xs text-green-500">Opgeslagen</span>}
        <ErrorText err={err} />
      </div>
    </div>
  );
}

interface Note { id: string; body: string; created_at: string; user_id: string; user_name: string | null }

export function Notes({ d, onChanged }: { d: Device; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const { data, load } = useLoad(() => api<{ notes: Note[] }>(`/${d.id}/notes`).then((r) => r.notes), [d.id]);
  async function add() {
    if (!text.trim()) return;
    try { await api(`/${d.id}/notes`, { method: 'POST', body: JSON.stringify({ body: text.trim() }) }); setText(''); void load(); onChanged(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="space-y-3 max-w-3xl">
      <div className="space-y-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={`Opmerking over ${d.name}`} className={`${inputCls} w-full`}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add(); }} />
        <div className="flex items-center gap-2"><button className={primary} disabled={!text.trim()} onClick={() => void add()}>Toevoegen</button><span className="text-xs text-(--muted)">Ctrl+Enter</span><ErrorText err={err} /></div>
      </div>
      {data && !data.length && <p className="text-xs text-(--muted)">Nog geen opmerkingen.</p>}
      <div className="space-y-2">
        {(data ?? []).map((n) => (
          <div key={n.id} className="rounded-xl border border-(--border) bg-(--input) px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-(--muted)">
              <span className="text-(--text) font-medium">{n.user_name ?? 'Onbekend'}</span><span>{relTime(n.created_at)}</span><div className="flex-1" />
              <button className="text-red-400 hover:underline" onClick={async () => { if (confirm('Opmerking verwijderen?')) { await api(`/${d.id}/notes/${n.id}`, { method: 'DELETE' }).catch(() => undefined); void load(); onChanged(); } }}>Verwijderen</button>
            </div>
            <p className="text-sm text-(--text) whitespace-pre-wrap break-words mt-1">{n.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
