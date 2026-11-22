'use client';

import { useEffect, useMemo, useState } from 'react';
import { MarkdownBlock, getToolSummary } from '@/components/chat/MessageBubble';
import { api, Badge, Device } from '../shared';
import { Chips, Col, DataTable, ErrorText, inputCls, Modal, OutputBox, Refreshed, relTime, tzLabel, useLoad } from '../ui';

export interface Activity { id: string; action: string; metadata: Record<string, unknown>; created_at: string; user_name: string | null; ip_address: string | null }

type Group = 'all' | 'remote' | 'tools' | 'software';

const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Activity group, status and description from an audit row (NinjaOne-style columns). */
export function describe(a: Activity): { group: string; status: string; tone: 'ok' | 'bad' | 'muted' | 'warn'; text: string; kind: Group } {
  const m = a.metadata ?? {};
  const src = s(m.source);
  const ok = m.ok === undefined ? null : m.ok === true;
  const tone = ok === null ? 'muted' : ok ? 'ok' : 'bad';
  const done = ok === null ? 'Geregistreerd' : ok ? 'Voltooid' : 'Mislukt';
  const cmd = s(m.command).split('\n').filter((l) => !/^if \(-not \(Get-Command winget/.test(l))[0]?.slice(0, 160) ?? '';
  switch (a.action) {
    case 'device.enroll': return { group: 'Agent', status: 'Gekoppeld', tone: 'ok', text: `Apparaat gekoppeld (${s(m.os)})`, kind: 'all' };
    case 'device.update_agent': return { group: 'Agent', status: done, tone, text: `Agent bijwerken vanaf ${s(m.from)}`, kind: 'software' };
    case 'device.uninstall': return { group: 'Agent', status: 'Verwijderd', tone: 'warn', text: 'Agent verwijderd', kind: 'all' };
    case 'device.update': return { group: 'Instellingen', status: 'Gewijzigd', tone: 'muted', text: Object.keys(m).filter((k) => k !== 'device').join(', '), kind: 'all' };
    case 'device.maintenance': return { group: 'Onderhoudsmodus', status: m.maintenance_until ? 'Ingeschakeld' : 'Beëindigd', tone: 'warn', text: m.maintenance_until ? `Tot ${new Date(s(m.maintenance_until)).toLocaleString('nl-NL')}${m.maintenance_reason ? `: ${s(m.maintenance_reason)}` : ''}` : 'Onderhoudsmodus beëindigd', kind: 'all' };
    case 'device.alerts_reset': return { group: 'Waarschuwingen', status: 'Opnieuw ingesteld', tone: 'muted', text: (m.alerts_ack as string[] | undefined)?.join(', ') ?? '', kind: 'all' };
    case 'device.claude': return { group: 'Claude', status: 'Sessie', tone: 'ok', text: `${s(m.question).replace(/\s+/g, ' ').slice(0, 140)}${Number(m.actions) ? ` (${s(m.actions)} acties)` : ''}`, kind: 'remote' };
    case 'device.note': return { group: 'Opmerking', status: 'Toegevoegd', tone: 'muted', text: s(m.text), kind: 'all' };
    case 'device.file.read': return { group: 'Bestanden', status: done, tone, text: `Gedownload: ${s(m.path)}`, kind: 'tools' };
    case 'device.file.write': return { group: 'Bestanden', status: done, tone, text: `Geüpload: ${s(m.path)} (${s(m.bytes)} bytes)`, kind: 'tools' };
    case 'device.task': return { group: taskGroup(src), status: 'In wachtrij', tone: 'muted', text: `${s(m.label)}${m.runAt ? `, gepland ${new Date(s(m.runAt)).toLocaleString('nl-NL')}` : ''}`, kind: kindOf(src) };
    case 'device.view': return { group: 'Bekijken', status: done, tone, text: src.replace(/^view:/, ''), kind: 'tools' };
    case 'device.exec': {
      if (src === 'console' || !src) return { group: m.runas === 'user' ? 'Remote shell (gebruiker)' : 'Remote shell', status: done, tone, text: cmd, kind: 'remote' };
      if (src.startsWith('task:')) return { group: taskGroup(src), status: done, tone, text: src.slice(5).replace(/^(update|install|uninstall|os-patch|script):/, '$1: '), kind: kindOf(src) };
      return { group: toolGroup(src.slice(5)), status: done, tone, text: `${src.slice(5)}${cmd ? `: ${cmd}` : ''}`, kind: kindOf(src) };
    }
    default: return { group: a.action.replace(/^device\./, ''), status: done, tone, text: cmd || src, kind: 'all' };
  }
}
function kindOf(src: string): Group {
  const t = src.replace(/^(task|tool):/, '');
  if (/^(update|install|uninstall|software-update|os-patch|os-update|wu-|winget|upgrades)/.test(t)) return 'software';
  if (/^(registry|file|kill|service|process)/.test(t)) return 'tools';
  return 'remote';
}
function taskGroup(src: string): string {
  const t = src.replace(/^task:/, '');
  if (t.startsWith('os-patch') || t.startsWith('os-update') || t.startsWith('wu-')) return 'Patching besturingssysteem';
  if (t.startsWith('update:') || t.startsWith('software-update')) return 'Patching software';
  if (t.startsWith('install:')) return 'Software installeren';
  if (t.startsWith('uninstall:')) return 'Software verwijderen';
  if (t.startsWith('script') || t.includes('script')) return 'Script';
  if (t.startsWith('reboot')) return 'Herstart';
  return 'Taak';
}
function toolGroup(t: string): string {
  if (t.startsWith('registry')) return 'Extern register';
  if (t.startsWith('file')) return 'Bestandsbrowser';
  if (t.startsWith('service')) return 'Servicemanager';
  if (t === 'kill' || t.startsWith('process')) return 'Taakbeheer';
  if (t.startsWith('reboot')) return 'Herstart';
  if (t.includes('script')) return 'Script';
  return 'Actie';
}

export default function Activities({ d }: { d: Device }) {
  const [days, setDays] = useState('7');
  const [group, setGroup] = useState<Group>('all');
  const [status, setStatus] = useState('');
  const [user, setUser] = useState('');
  const [views, setViews] = useState(false);
  const [open, setOpen] = useState<Activity | null>(null);
  const { data, err, busy, load, at } = useLoad(() => api<{ activities: Activity[] }>(`/${d.id}/activities?days=${days}${views ? '&views=1' : ''}`).then((r) => r.activities), [d.id, days, views]);
  const rows = useMemo(() => (data ?? []).map((a) => ({ a, x: describe(a) })).filter(({ a, x }) =>
    (group === 'all' || x.kind === group) && (!status || x.status === status) && (!user || a.user_name === user)), [data, group, status, user]);
  const statuses = [...new Set((data ?? []).map((a) => describe(a).status))];
  const users = [...new Set((data ?? []).map((a) => a.user_name).filter(Boolean) as string[])];
  type R = (typeof rows)[number];
  const cols: Col<R>[] = [
    { key: 'group', label: 'Activiteitengroep', value: (r) => r.x.group, width: '12rem' },
    { key: 'status', label: 'Status', value: (r) => r.x.status, width: '8rem', render: (r) => <Badge tone={r.x.tone}>{r.x.status}</Badge> },
    { key: 'text', label: 'Beschrijving', value: (r) => r.x.text, width: 'minmax(14rem,2fr)' },
    { key: 'user', label: 'Gebruiker', value: (r) => r.a.user_name ?? '', width: '9rem' },
    { key: 'date', label: 'Datum', value: (r) => r.a.created_at, width: '11rem', render: (r) => relTime(r.a.created_at) },
    { key: 'ip', label: 'IP', value: (r) => r.a.ip_address ?? '', width: '8rem', hidden: true },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chips items={[['all', 'Alles'], ['remote', 'Externe besturing'], ['tools', 'Tools op afstand'], ['software', 'Software toegevoegd/verwijderd/bijgewerkt']]} value={group} onChange={setGroup} />
        <div className="flex-1" />
        <Refreshed at={at} busy={busy} onRefresh={() => void load()} />
      </div>
      <ErrorText err={err} />
      <DataTable id="activities" exportName={`activiteiten-${d.name}`} cols={cols} rows={rows} rowKey={(r) => r.a.id} onRowClick={(r) => setOpen(r.a)}
        empty="Geen activiteiten in deze periode."
        toolbar={<>
          <select value={days} onChange={(e) => setDays(e.target.value)} className={inputCls}>
            {[['1', 'Afgelopen dag'], ['7', 'Afgelopen week'], ['30', 'Afgelopen maand'], ['90', 'Afgelopen 3 maanden'], ['365', 'Afgelopen jaar']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}><option value="">Alle statussen</option>{statuses.map((x) => <option key={x}>{x}</option>)}</select>
          <select value={user} onChange={(e) => setUser(e.target.value)} className={inputCls}><option value="">Alle gebruikers</option>{users.map((x) => <option key={x}>{x}</option>)}</select>
          <label className="flex items-center gap-1.5 text-xs text-(--muted)"><input type="checkbox" checked={views} onChange={(e) => setViews(e.target.checked)} />Leesacties</label>
          <span className="text-xs text-(--muted)">{tzLabel}</span>
        </>} />
      {open && open.action === 'device.claude' && (
        <Modal title="Claude op dit apparaat" onClose={() => setOpen(null)} wide>
          <ClaudeSession deviceId={d.id} a={open} />
        </Modal>
      )}
      {open && open.action !== 'device.claude' && (
        <Modal title={describe(open).group} onClose={() => setOpen(null)} wide>
          <p className="text-xs text-(--muted)">{new Date(open.created_at).toLocaleString('nl-NL')} · {open.user_name ?? 'systeem'}{open.ip_address ? ` · ${open.ip_address}` : ''}</p>
          <OutputBox text={JSON.stringify(open.metadata, null, 2)} />
        </Modal>
      )}
    </div>
  );
}

type Ev = { type: string; text?: string; toolName?: string; toolInput?: unknown };

/** One Claude session on this device: what was asked, what Claude did on the device and what it answered. */
function ClaudeSession({ deviceId, a }: { deviceId: string; a: Activity }) {
  const [msgs, setMsgs] = useState<Array<{ id: string; role: string; content: string; created_at: string }> | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ messages: Array<{ id: string; role: string; content: string; created_at: string }> }>(`/${deviceId}/claude/${s(a.metadata.conversation_id)}`)
      .then((r) => setMsgs(r.messages)).catch((e) => setErr((e as Error).message));
  }, [deviceId, a]);
  const parse = (c: string): Ev[] => { if (c.startsWith('[')) { try { const x = JSON.parse(c) as Ev[]; if (Array.isArray(x)) return x; } catch { /* plain */ } } return [{ type: 'text', text: c }]; };
  return (
    <div className="space-y-3">
      <p className="text-xs text-(--muted)">{new Date(a.created_at).toLocaleString('nl-NL')} · {a.user_name ?? 'onbekend'} · {s(a.metadata.turns)} {Number(a.metadata.turns) === 1 ? 'vraag' : 'vragen'}, {s(a.metadata.actions)} acties</p>
      {err && <p className="text-sm text-red-400">{err}</p>}
      {!msgs && !err && <p className="text-sm text-(--muted)">Laden…</p>}
      <div className="space-y-3 max-h-[65vh] overflow-y-auto pr-1">
        {(msgs ?? []).map((m, i) => m.role === 'user' ? (
          <div key={m.id} className="wa-row-in flex justify-end" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}>
            <div className="max-w-[85%] rounded-2xl rounded-tr-md px-3.5 py-2 text-sm text-(--text) whitespace-pre-wrap" style={{ background: 'var(--user-bubble)' }}>
              {m.content}
              <span className="block text-[11px] text-(--muted) text-right mt-1">{new Date(m.created_at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
        ) : (
          <div key={m.id} className="wa-row-in space-y-1.5" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}>
            {parse(m.content).map((e, j) => e.type === 'tool_use' ? (
              <div key={j} className="flex items-start gap-2 text-xs text-(--muted) font-mono">
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-(--border) text-[11px] uppercase tracking-wide">{e.toolName}</span>
                <span className="break-all line-clamp-2">{getToolSummary(e.toolName ?? '', e.toolInput) ?? ''}</span>
              </div>
            ) : e.type === 'text' && e.text?.trim() ? (
              <div key={j} className="rounded-2xl rounded-tl-md px-3.5 py-2 border border-(--border)" style={{ background: 'var(--card-bg)' }}>
                <MarkdownBlock text={e.text} />
              </div>
            ) : null)}
          </div>
        ))}
      </div>
    </div>
  );
}
