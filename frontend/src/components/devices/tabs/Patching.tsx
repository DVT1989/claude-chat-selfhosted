'use client';

/**
 * Patching (OS and software) and the software inventory of one device.
 * Windows: Windows Update COM API, winget, the Uninstall keys in the registry and Store packages.
 * Mac: softwareupdate, Homebrew and system_profiler. Installs and removals run as server tasks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { api, Badge, Device, execOn, fmtDate, ghost, parseJson, primary, queueTasks, Task } from '../shared';
import { Card, Chips, Col, DataTable, ErrorText, fmtBytes, MenuItem, OutputBox, psq, Pulse, Refreshed, relTime, RowMenu, shq, useLoad } from '../ui';

// ── Helpers ──────────────────────────────────────────────────

const arr = <T,>(v: T[] | T | null | undefined): T[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
/** Newest task with this tool (the server lists tasks newest first). */
const latestTask = (tasks: Task[], tool: string) => tasks.find((t) => t.tool === tool);
const isBusy = (t?: Task) => !!t && (t.status === 'queued' || t.status === 'running');
const taskDetail = (t?: Task) => (t?.result?.output || t?.result?.error || '').trim().split(/\r?\n/).slice(-15).join('\n');

function TaskBadge({ t, doneText }: { t?: Task; doneText: string }) {
  if (!t) return null;
  if (t.status === 'queued') return <Badge tone="muted">In wachtrij</Badge>;
  if (t.status === 'running') return <Badge tone="warn">Bezig</Badge>;
  if (t.status === 'done') return <Badge tone="ok">{doneText}</Badge>;
  if (t.status === 'cancelled') return <Badge tone="muted">Geannuleerd</Badge>;
  return <Badge tone="bad">{t.status === 'interrupted' ? 'Onderbroken' : 'Mislukt'}</Badge>;
}

/** Calls cb when the last running task with this tool prefix finishes (to rescan). */
function useOnFinished(tasks: Task[], prefix: string, cb: () => void) {
  const running = tasks.some((t) => t.tool?.startsWith(prefix) && isBusy(t));
  const was = useRef(false);
  const ref = useRef(cb);
  useEffect(() => { ref.current = cb; });
  useEffect(() => { if (was.current && !running) ref.current(); was.current = running; }, [running]);
  return running;
}

const queueErr = (e: unknown) => alert((e as Error).message);

// ══ OS patches ═══════════════════════════════════════════════

interface WuUpdate {
  id: string; title: string; kb?: string; cats?: string[] | string; sev?: string | null; cves?: string[] | string; reboot?: number;
  published?: string; size?: number; downloaded?: boolean; input?: boolean; uninstallable?: boolean; hidden?: boolean;
}
interface WuHistory { id: string; title: string; date: string; code: number; hr?: number; cats?: string[] | string; client?: string }

type OsState = 'pending' | 'rejected' | 'installed' | 'failed';
interface OsRow {
  key: string; id: string; title: string; kb: string; cats: string; sev: string; cves: string[]; reboot: string;
  published?: string; installed?: string; size?: number; uninstallable?: boolean | null; state: OsState; by?: string; hr?: number;
}

const WIN_OS_SCAN = `$ErrorActionPreference = 'Stop'
$s = New-Object -ComObject Microsoft.Update.Session
$se = $s.CreateUpdateSearcher()
$r = $se.Search("IsInstalled=0 and Type='Software'")
$list = @(foreach ($u in $r.Updates) { @{ id = $u.Identity.UpdateID; title = $u.Title; kb = (@($u.KBArticleIDs) -join ','); cats = @($u.Categories | ForEach-Object { $_.Name }); sev = $u.MsrcSeverity; cves = @($u.CveIDs); reboot = [int]$u.InstallationBehavior.RebootBehavior; published = $u.LastDeploymentChangeTime.ToString('o'); size = [int64]$u.MaxDownloadSize; downloaded = [bool]$u.IsDownloaded; input = [bool]$u.InstallationBehavior.CanRequestUserInput; uninstallable = [bool]$u.IsUninstallable; hidden = [bool]$u.IsHidden } })
$n = $se.GetTotalHistoryCount()
$hist = @()
if ($n -gt 0) { $hist = @($se.QueryHistory(0, [math]::Min($n, 300)) | Where-Object { $_.Operation -eq 1 -and $_.Title } | ForEach-Object { @{ id = $_.UpdateIdentity.UpdateID; title = $_.Title; date = $_.Date.ToString('o'); code = [int]$_.ResultCode; hr = [int64]$_.HResult; client = [string]$_.ClientApplicationID; cats = @($_.Categories | ForEach-Object { $_.Name }) } }) }
ConvertTo-Json -Compress -Depth 4 -InputObject @{ updates = $list; history = $hist }`;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const winInstall = (id: string) => `$ErrorActionPreference = 'Stop'
$s = New-Object -ComObject Microsoft.Update.Session
$s.ClientApplicationID = 'Claude Chat'
$r = $s.CreateUpdateSearcher().Search("UpdateID='${id}'")
if ($r.Updates.Count -eq 0) { 'Update niet gevonden (al geinstalleerd?)'; exit 1 }
$c = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $r.Updates) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; if ($u.IsHidden) { $u.IsHidden = $false }; [void]$c.Add($u); "Update: $($u.Title)" }
$d = $s.CreateUpdateDownloader(); $d.Updates = $c; [void]$d.Download()
$i = $s.CreateUpdateInstaller(); $i.Updates = $c; $res = $i.Install()
"Resultaatcode $($res.ResultCode) (2 = gelukt, 3 = gelukt met fouten), herstart nodig: $($res.RebootRequired)"
if ($res.ResultCode -ne 2 -and $res.ResultCode -ne 3) { exit 1 }`;

const winHide = (id: string, hide: boolean) => `$ErrorActionPreference = 'Stop'
$s = New-Object -ComObject Microsoft.Update.Session
$r = $s.CreateUpdateSearcher().Search("UpdateID='${id}'")
if ($r.Updates.Count -eq 0) { 'Update niet gevonden'; exit 1 }
foreach ($u in $r.Updates) { $u.IsHidden = $${hide ? 'true' : 'false'} }
'${hide ? 'Geweigerd (verborgen)' : 'Weigering opgeheven'}'`;

const winUninstallKb = (kb: string) => `$p = Start-Process -FilePath "$env:SystemRoot\\System32\\wusa.exe" -ArgumentList '/uninstall', '/kb:${kb}', '/quiet', '/norestart' -Wait -PassThru
"wusa exitcode $($p.ExitCode) (0 = gelukt, 3010 = gelukt, herstart nodig, 2359303 = niet geinstalleerd)"
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { exit 1 }`;

const kbOf = (title: string, kb?: string) => (kb ? kb.split(',')[0] : (title.match(/KB(\d{5,8})/i)?.[1] ?? ''));
const hex = (hr?: number) => (hr ? `0x${(hr >>> 0).toString(16).toUpperCase().padStart(8, '0')}` : '');
const REBOOT = ['Nee', 'Ja', 'Mogelijk'];
const SEV: Record<string, string> = { Critical: 'Kritiek', Important: 'Belangrijk', Moderate: 'Gemiddeld', Low: 'Laag' };

function OsStateBadge({ r, t }: { r: OsRow; t?: Task }) {
  if (t && (isBusy(t) || (t.status !== 'done' && r.state === 'pending'))) return <TaskBadge t={t} doneText="Geïnstalleerd" />;
  if (r.state === 'installed') return <Badge tone="ok">Geïnstalleerd</Badge>;
  if (r.state === 'failed') return <Badge tone="bad">Mislukt</Badge>;
  if (r.state === 'rejected') return <Badge tone="muted">Geweigerd</Badge>;
  return <Badge tone="warn">In behandeling</Badge>;
}

export function OsPatches({ d, tasks, reload }: { d: Device; tasks: Task[]; reload: () => void }) {
  if (d.os === 'darwin') return <MacOsPatches d={d} tasks={tasks} reload={reload} />;
  return <WinOsPatches d={d} tasks={tasks} reload={reload} />;
}

type OsFilter = 'pending' | 'approved' | 'rejected' | 'installed' | 'failed';

function WinOsPatches({ d, tasks, reload }: { d: Device; tasks: Task[]; reload: () => void }) {
  const [filter, setFilter] = useState<OsFilter>('pending');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const akey = `os-approved:${d.id}`;
  const [approved, setApproved] = useState<string[]>([]);
  useEffect(() => { try { setApproved(JSON.parse(localStorage.getItem(akey) ?? '[]') as string[]); } catch { setApproved([]); } }, [akey]);
  const saveApproved = (v: string[]) => { setApproved(v); try { localStorage.setItem(akey, JSON.stringify(v)); } catch { /* full */ } };

  const { data, err, busy, load, at } = useLoad(async () => {
    const r = await execOn(d.id, WIN_OS_SCAN, { tool: 'view:os-scan', timeout: 600 });
    const v = parseJson<{ updates?: WuUpdate[] | WuUpdate; history?: WuHistory[] | WuHistory }>(r.output);
    if (!v) throw new Error(r.error || r.output.slice(0, 400) || 'Geen antwoord van Windows Update');
    return { updates: arr(v.updates), history: arr(v.history) };
  }, [d.id], { enabled: d.online });

  useOnFinished(tasks, 'os-', () => void load());

  const rows = useMemo<OsRow[]>(() => {
    if (!data) return [];
    const out: OsRow[] = data.updates.map((u) => ({
      key: `u:${u.id}`, id: u.id, title: u.title, kb: kbOf(u.title, u.kb), cats: arr(u.cats).join(', '), sev: u.sev ? SEV[u.sev] ?? u.sev : '',
      cves: arr(u.cves), reboot: REBOOT[u.reboot ?? 0] ?? '', published: u.published, size: u.size, uninstallable: u.uninstallable ?? null,
      state: u.hidden ? 'rejected' : 'pending',
    }));
    // newest first; a failure that later succeeded is not a failure any more
    const okIds = new Set<string>();
    const hist = [...data.history].sort((a, b) => b.date.localeCompare(a.date));
    for (const h of hist) {
      const ok = h.code === 2 || h.code === 3;
      if (!ok && (h.code !== 4 && h.code !== 5)) continue;
      if (!ok && okIds.has(h.id)) continue;
      if (ok) okIds.add(h.id);
      out.push({
        key: `h:${h.id}:${h.date}`, id: h.id, title: h.title, kb: kbOf(h.title), cats: arr(h.cats).join(', '), sev: '', cves: [], reboot: '',
        installed: h.date, uninstallable: null, state: ok ? 'installed' : 'failed', hr: h.hr,
        by: h.client === 'Claude Chat' ? 'Claude Chat' : h.client || '',
      });
    }
    return out;
  }, [data]);

  const approvedSet = new Set(approved);
  const shown = rows.filter((r) => (filter === 'approved' ? r.state === 'pending' && approvedSet.has(r.id) : r.state === filter));
  const count = (f: OsFilter) => rows.filter((r) => (f === 'approved' ? r.state === 'pending' && approvedSet.has(r.id) : r.state === f)).length;
  const taskOf = (r: OsRow) => latestTask(tasks, `os-patch:${r.id}`);

  async function install(list: OsRow[]) {
    const ok = list.filter((r) => GUID_RE.test(r.id) && !isBusy(taskOf(r)));
    if (!ok.length) return;
    if (!confirm(`${ok.length} ${ok.length === 1 ? 'update' : 'updates'} installeren op ${d.name}? Er volgt geen automatische herstart.`)) return;
    try {
      await queueTasks(d.id, ok.map((r) => ({
        command: winInstall(r.id), tool: `os-patch:${r.id}`, timeout: 1800,
        label: `Windows-update ${r.kb ? `KB${r.kb}` : r.title.slice(0, 80)} installeren`,
      })));
      setSel(new Set());
    } catch (e) { queueErr(e); }
    reload();
  }

  async function hide(r: OsRow, on: boolean) {
    if (!GUID_RE.test(r.id)) return;
    setMsg(null);
    const res = await execOn(d.id, winHide(r.id, on), { tool: on ? 'os-reject' : 'os-unreject', timeout: 300 }).catch((e) => ({ ok: false, output: '', error: (e as Error).message }));
    setMsg({ text: (res.output || res.error || '').trim(), bad: !res.ok });
    if (on) saveApproved(approved.filter((x) => x !== r.id));
    void load();
  }

  async function uninstall(r: OsRow) {
    if (!/^\d{5,8}$/.test(r.kb)) { alert('Geen KB-nummer bekend voor deze update.'); return; }
    if (!confirm(`KB${r.kb} verwijderen van ${d.name}? Daarna is meestal een herstart nodig.`)) return;
    try { await queueTasks(d.id, [{ command: winUninstallKb(r.kb), tool: `os-uninstall:${r.kb}`, label: `Windows-update KB${r.kb} verwijderen`, timeout: 1800 }]); } catch (e) { queueErr(e); }
    reload();
  }

  const selectable = filter === 'pending' || filter === 'approved' || filter === 'rejected';
  const cols: Col<OsRow>[] = [
    ...(selectable ? [{
      key: 'sel', label: '', width: '1.5rem', value: (r: OsRow) => (sel.has(r.key) ? 1 : 0),
      render: (r: OsRow) => (
        <input type="checkbox" checked={sel.has(r.key)} onClick={(e) => e.stopPropagation()}
          onChange={() => setSel((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })} />
      ),
    }] : []),
    { key: 'status', label: 'Status', width: '7.5rem', value: (r) => r.state, render: (r) => <OsStateBadge r={r} t={taskOf(r)} /> },
    { key: 'title', label: 'Patchnaam', width: 'minmax(16rem,3fr)', value: (r) => r.title },
    { key: 'kb', label: 'KB', width: '6rem', value: (r) => (r.kb ? `KB${r.kb}` : '') },
    { key: 'cat', label: 'Categorie', width: 'minmax(8rem,1fr)', value: (r) => r.cats },
    { key: 'sev', label: 'Ernst', width: '6rem', value: (r) => r.sev, render: (r) => (r.sev ? <span className={r.sev === 'Kritiek' ? 'text-red-400' : r.sev === 'Belangrijk' ? 'text-yellow-500' : ''}>{r.sev}</span> : '') },
    { key: 'cve', label: 'CVE', width: '4rem', align: 'right', value: (r) => r.cves.length || null, render: (r) => (r.cves.length ? <span title={r.cves.join('\n')}>{r.cves.length}</span> : '') },
    { key: 'reboot', label: 'Herstart vereist', width: '6.5rem', value: (r) => r.reboot },
    { key: 'pub', label: 'Publicatiedatum', width: '7.5rem', value: (r) => r.published ?? '', render: (r) => fmtDate(r.published) },
    { key: 'inst', label: 'Installatiedatum', width: '9rem', value: (r) => r.installed ?? '', render: (r) => relTime(r.installed) },
    { key: 'by', label: 'Geïnstalleerd door', width: '8rem', value: (r) => (taskOf(r)?.status === 'done' ? 'Claude Chat' : r.by ?? '') },
    { key: 'size', label: 'Grootte', width: '5rem', align: 'right', hidden: true, value: (r) => r.size ?? null, render: (r) => fmtBytes(r.size) },
    { key: 'hr', label: 'Foutcode', width: '6.5rem', hidden: true, value: (r) => hex(r.hr) },
    { key: 'unin', label: 'Verwijderen ondersteund', width: '7rem', value: (r) => (r.uninstallable == null ? '' : r.uninstallable ? 'Ja' : 'Nee') },
  ];

  const actions = (r: OsRow) => {
    const t = taskOf(r);
    const items: MenuItem[] = [];
    if (r.state === 'pending' || r.state === 'rejected') items.push({ label: 'Installeren', disabled: !d.online || isBusy(t), onClick: () => void install([r]) });
    if (r.state === 'pending') items.push(approvedSet.has(r.id)
      ? { label: 'Goedkeuring intrekken', onClick: () => saveApproved(approved.filter((x) => x !== r.id)) }
      : { label: 'Goedkeuren', onClick: () => saveApproved([...approved, r.id]) });
    if (r.state === 'pending') items.push({ label: 'Weigeren', detail: 'Verbergen in Windows Update', disabled: !d.online, onClick: () => void hide(r, true) });
    if (r.state === 'rejected') items.push({ label: 'Weigering opheffen', disabled: !d.online, onClick: () => void hide(r, false) });
    if (r.state === 'installed' && r.kb) items.push({ label: 'Verwijderen', danger: true, disabled: !d.online, onClick: () => void uninstall(r) });
    if (t?.result) items.push({ label: 'Uitvoer laatste taak', onClick: () => setMsg({ text: taskDetail(t) || 'Geen uitvoer.', bad: t.status === 'failed' }) });
    return items.length ? <RowMenu items={items} /> : null;
  };

  const selRows = shown.filter((r) => sel.has(r.key));
  const approvedRows = rows.filter((r) => r.state === 'pending' && approvedSet.has(r.id));
  const uninstallTasks = tasks.filter((t) => t.tool?.startsWith('os-uninstall:') && (isBusy(t) || Date.now() - new Date(t.createdAt).getTime() < 86400e3));

  return (
    <div className="space-y-4">
      {d.inventory?.rebootPending && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-500">Herstart in afwachting: een of meer updates worden pas actief na een herstart.</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Chips<OsFilter> value={filter} onChange={(f) => { setFilter(f); setSel(new Set()); }} items={[
          ['pending', `In behandeling (${count('pending')})`], ['approved', `Goedgekeurd (${count('approved')})`], ['rejected', `Geweigerd (${count('rejected')})`],
          ['installed', `Geïnstalleerd (${count('installed')})`], ['failed', `Mislukt (${count('failed')})`],
        ]} />
        <div className="flex-1" />
        <Refreshed at={at} busy={busy} />
        <button className={ghost} disabled={busy || !d.online} onClick={() => void load()}>{busy ? 'Zoeken…' : 'OS scan'}</button>
      </div>
      {!d.online && <p className="text-xs text-(--muted)">Offline: scannen en installeren werkt zodra het apparaat online is.</p>}
      {busy && !data && <Pulse text="Windows Update doorzoeken, dit kan enkele minuten duren…" />}
      <ErrorText err={err} />
      {msg && msg.text && <OutputBox text={msg.text} bad={msg.bad} />}
      {uninstallTasks.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {uninstallTasks.map((t) => <span key={t.id} className="inline-flex items-center gap-1.5 text-(--muted)">{t.label} <TaskBadge t={t} doneText="Verwijderd" /></span>)}
        </div>
      )}
      {data && (
        <DataTable<OsRow> id="os-patches" exportName={`os-patches-${d.name}`} cols={cols} rows={shown} rowKey={(r) => r.key} actions={actions}
          initialSort={filter === 'installed' || filter === 'failed' ? { key: 'inst', dir: -1 } : undefined}
          empty={filter === 'pending' ? 'Geen openstaande updates.' : 'Niets in deze lijst.'}
          toolbar={<>
            {selectable && selRows.length > 0 && <button className={primary} disabled={!d.online} onClick={() => void install(selRows)}>Geselecteerde installeren ({selRows.length})</button>}
            {filter === 'approved' && approvedRows.length > 0 && <button className={primary} disabled={!d.online} onClick={() => void install(approvedRows)}>Goedgekeurde installeren</button>}
            {filter === 'pending' && shown.length > 0 && <button className={ghost} disabled={!d.online} onClick={() => void install(shown)}>Alle installeren</button>}
          </>} />
      )}
    </div>
  );
}

// ── Mac: softwareupdate ──────────────────────────────────────

interface MacUpd { label: string; title: string; version: string; size: string; recommended: string; action: string }
interface MacHist { name: string; version: string; date: string }

const MAC_OS_SCAN = 'softwareupdate -l 2>&1; echo ---H---; softwareupdate --history 2>&1';

function parseMacOs(out: string): { avail: MacUpd[]; hist: MacHist[] } {
  const [a, h = ''] = out.split('---H---');
  const avail: MacUpd[] = [];
  for (const m of a.matchAll(/\* Label: (.+)\n\s*Title: ([^,]+), Version: ([^,]+)(?:, Size: ([^,]+))?(?:, Recommended: (\w+))?(?:, Action: (\w+))?/g)) {
    avail.push({ label: m[1].trim(), title: m[2].trim(), version: m[3].trim(), size: (m[4] ?? '').trim(), recommended: m[5] ?? '', action: m[6] ?? '' });
  }
  const lines = h.split('\n');
  const sep = lines.findIndex((l) => /^-{5,}/.test(l.trim()));
  const hist: MacHist[] = [];
  for (const l of lines.slice(sep + 1)) {
    const p = l.trim().split(/\s{2,}/);
    if (p.length >= 3) hist.push({ name: p[0], version: p[1], date: p.slice(2).join(' ') });
  }
  return { avail, hist };
}

function MacOsPatches({ d, tasks, reload }: { d: Device; tasks: Task[]; reload: () => void }) {
  const [filter, setFilter] = useState<'pending' | 'installed'>('pending');
  const { data, err, busy, load, at } = useLoad(async () => {
    const r = await execOn(d.id, MAC_OS_SCAN, { tool: 'view:os-scan', timeout: 600 });
    return parseMacOs(r.output);
  }, [d.id], { enabled: d.online });
  useOnFinished(tasks, 'os-', () => void load());

  async function install(list: MacUpd[]) {
    if (!list.length || !confirm(`${list.length} macOS-${list.length === 1 ? 'update' : 'updates'} installeren op ${d.name}? Er volgt geen automatische herstart.`)) return;
    try {
      await queueTasks(d.id, list.map((u) => ({ command: `softwareupdate -i ${shq(u.label)} 2>&1`, tool: `os-patch:${u.label}`.slice(0, 120), label: `${u.title} ${u.version} installeren`, timeout: 1800 })));
    } catch (e) { queueErr(e); }
    reload();
  }

  const availCols: Col<MacUpd>[] = [
    { key: 'status', label: 'Status', width: '7.5rem', value: () => 'pending', render: (u) => latestTask(tasks, `os-patch:${u.label}`.slice(0, 120)) ? <TaskBadge t={latestTask(tasks, `os-patch:${u.label}`.slice(0, 120))} doneText="Geïnstalleerd" /> : <Badge tone="warn">In behandeling</Badge> },
    { key: 'title', label: 'Patchnaam', width: 'minmax(14rem,2fr)', value: (u) => u.title },
    { key: 'version', label: 'Versie', width: '7rem', value: (u) => u.version },
    { key: 'size', label: 'Grootte', width: '6rem', value: (u) => u.size },
    { key: 'rec', label: 'Aanbevolen', width: '6rem', value: (u) => (u.recommended === 'YES' ? 'Ja' : u.recommended ? 'Nee' : '') },
    { key: 'reboot', label: 'Herstart vereist', width: '7rem', value: (u) => (u.action === 'restart' ? 'Ja' : 'Nee') },
  ];
  const histCols: Col<MacHist>[] = [
    { key: 'status', label: 'Status', width: '7.5rem', value: () => 'installed', render: () => <Badge tone="ok">Geïnstalleerd</Badge> },
    { key: 'name', label: 'Patchnaam', width: 'minmax(14rem,2fr)', value: (h) => h.name },
    { key: 'version', label: 'Versie', width: '7rem', value: (h) => h.version },
    { key: 'date', label: 'Installatiedatum', width: '10rem', value: (h) => h.date },
  ];

  return (
    <div className="space-y-4">
      {d.inventory?.rebootPending && <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-500">Herstart in afwachting.</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Chips value={filter} onChange={setFilter} items={[['pending', `In behandeling (${data?.avail.length ?? 0})`], ['installed', `Geïnstalleerd (${data?.hist.length ?? 0})`]]} />
        <div className="flex-1" />
        <Refreshed at={at} busy={busy} />
        <button className={ghost} disabled={busy || !d.online} onClick={() => void load()}>{busy ? 'Zoeken…' : 'OS scan'}</button>
      </div>
      {busy && !data && <Pulse text="softwareupdate doorzoeken…" />}
      <ErrorText err={err} />
      {data && filter === 'pending' && (
        <DataTable<MacUpd> id="mac-os-patches" exportName={`os-patches-${d.name}`} cols={availCols} rows={data.avail} rowKey={(u) => u.label} empty="Geen openstaande updates."
          toolbar={data.avail.length > 0 ? <button className={ghost} disabled={!d.online} onClick={() => void install(data.avail)}>Alle installeren</button> : undefined}
          actions={(u) => <RowMenu items={[{ label: 'Installeren', disabled: !d.online || isBusy(latestTask(tasks, `os-patch:${u.label}`.slice(0, 120))), onClick: () => void install([u]) }]} />} />
      )}
      {data && filter === 'installed' && (
        <DataTable<MacHist> id="mac-os-history" exportName={`os-history-${d.name}`} cols={histCols} rows={data.hist} rowKey={(h) => `${h.name}:${h.version}:${h.date}`} />
      )}
    </div>
  );
}

// ══ Software patches (winget / Homebrew / Apple) ═════════════

interface Upd { name: string; id: string; version: string; available: string; source?: string }

/** winget's table: column starts from the header line above the dashes (works in any language). */
function parseWinget(out: string): Upd[] {
  const lines = out.split(/\r?\n|\r/);
  const sep = lines.findIndex((l) => /^-{20,}\s*$/.test(l.trim()));
  if (sep < 1) return [];
  const starts = [...lines[sep - 1].matchAll(/\S+/g)].map((m) => m.index ?? 0);
  if (starts.length < 4) return [];
  const col = (l: string, i: number) => l.slice(starts[i], starts[i + 1] ?? undefined).trim();
  const rows: Upd[] = [];
  for (const l of lines.slice(sep + 1)) {
    if (l.length < starts[3] || /^-{20,}/.test(l.trim())) break; // footer ("9 upgrades available") or next table
    const r = { name: col(l, 0), id: col(l, 1), version: col(l, 2), available: col(l, 3), source: col(l, 4) };
    if (r.id && r.available) rows.push(r);
  }
  return rows;
}

/** Mac: Homebrew (JSON) plus Apple software updates (labels). */
function parseMac(out: string): Upd[] {
  const rows: Upd[] = [];
  const brew = parseJson<{ formulae?: Array<{ name: string; installed_versions: string[]; current_version: string }>; casks?: Array<{ name: string; installed_versions: string[] | string; current_version: string }> }>(out.split('---SU---')[0] ?? '');
  for (const f of [...(brew?.formulae ?? []), ...(brew?.casks ?? [])]) {
    rows.push({ name: f.name, id: `brew:${f.name}`, version: Array.isArray(f.installed_versions) ? f.installed_versions.join(', ') : String(f.installed_versions), available: f.current_version, source: 'brew' });
  }
  const su = out.split('---SU---')[1] ?? '';
  for (const m of su.matchAll(/\* Label: (.+)\n\s*Title: ([^,]+), Version: ([^,]+)/g)) {
    rows.push({ name: m[2].trim(), id: `su:${m[1].trim()}`, version: '', available: m[3].trim(), source: 'Apple' });
  }
  return rows;
}

const WIN_CHECK = 'winget upgrade --include-unknown --accept-source-agreements --disable-interactivity 2>&1 | Out-String -Width 400';
const MAC_CHECK = `U="$(stat -f%Su /dev/console)"; command -v brew >/dev/null 2>&1 || PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; command -v brew >/dev/null 2>&1 && sudo -u "$U" brew outdated --json=v2 2>/dev/null; echo; echo ---SU---; softwareupdate -l 2>&1`;
function upgradeCmd(isWin: boolean, u: Upd): string {
  if (isWin) return `winget upgrade --id ${psq(u.id)} --exact --silent --include-unknown --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-String -Width 400\nexit $LASTEXITCODE`;
  if (u.id.startsWith('brew:')) return `U="$(stat -f%Su /dev/console)"; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; sudo -u "$U" brew upgrade ${shq(u.id.slice(5))} 2>&1`;
  return `softwareupdate -i ${shq(u.id.slice(3))} 2>&1`;
}

function SwRow({ reg, k, name, sub, right, children }: { reg: (k: string) => (el: HTMLElement | null) => void; k: string; name: string; sub: React.ReactNode; right?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div ref={reg(k)} className="relative px-4 py-3 bg-(--input)">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-(--text) truncate">{name}</div>
          <div className="text-xs text-(--muted) truncate tabular-nums">{sub}</div>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

type SwFilter = 'pending' | 'installed' | 'failed';

export function SoftwarePatches({ d, tasks, reload }: { d: Device; tasks: Task[]; reload: () => void }) {
  const isWin = d.os === 'windows';
  const [filter, setFilter] = useState<SwFilter>('pending');
  const [upds, setUpds] = useState<Upd[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [openDetail, setOpenDetail] = useState('');

  // newest task per package (tool "update:<id>")
  const latest = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks) if (t.tool?.startsWith('update:') && !m.has(t.tool.slice(7))) m.set(t.tool.slice(7), t);
    return m;
  }, [tasks]);

  const check = useCallback(async () => {
    if (!d.online) return;
    setChecking(true); setCheckErr('');
    try {
      const r = await execOn(d.id, isWin ? WIN_CHECK : MAC_CHECK, { tool: 'view:updates-check', timeout: 300 });
      const list = isWin ? parseWinget(r.output) : parseMac(r.output);
      if (!list.length && !r.ok) setCheckErr(r.error || r.output.slice(0, 300));
      setUpds(list);
      setCheckedAt(Date.now());
    } catch (e) { setCheckErr((e as Error).message); }
    setChecking(false);
  }, [d.id, d.online, isWin]);
  useEffect(() => { void check(); }, [check]);

  // when the last update finishes: search again (finished ones drop off) and refresh the inventory
  const running = useOnFinished(tasks, 'update:', () => {
    void check();
    void api(`/${d.id}/refresh`, { method: 'POST' }).catch(() => undefined);
  });

  async function update(list: Upd[]) {
    try {
      await queueTasks(d.id, list.map((u) => ({ command: upgradeCmd(isWin, u), label: `${u.name} bijwerken naar ${u.available}`, tool: `update:${u.id}`, timeout: 1800 })));
    } catch (e) { setCheckErr((e as Error).message); }
    reload();
  }

  const pending = (upds ?? []).filter((u) => latest.get(u.id)?.status !== 'done');
  const installed = [...latest.values()].filter((t) => t.status === 'done');
  const failed = [...latest.entries()].filter(([, t]) => t.status === 'failed' || t.status === 'interrupted');

  // FLIP: rows that move (an update above finished) slide into place
  const rows = useRef(new Map<string, HTMLElement>());
  const rects = useRef(new Map<string, DOMRect>());
  const reg = (key: string) => (el: HTMLElement | null) => { if (el) rows.current.set(key, el); else rows.current.delete(key); };
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    for (const [key, el] of rows.current) {
      const r = el.getBoundingClientRect();
      next.set(key, r);
      const prev = rects.current.get(key);
      if (prev && Math.abs(prev.top - r.top) > 2) {
        el.animate([{ transform: `translateY(${prev.top - r.top}px)`, boxShadow: '0 8px 24px rgba(0,0,0,.25)' }, { transform: 'none', boxShadow: 'none' }],
          { duration: 650, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    }
    rects.current = next;
  });

  const detail = (key: string, t?: Task) => openDetail === key && t && (
    <pre className="mt-2 text-xs whitespace-pre-wrap break-words rounded-lg bg-(--bg) border border-(--border) p-2 max-h-48 overflow-auto font-mono">{taskDetail(t) || 'Geen uitvoer.'}</pre>
  );
  const retryable = pending.filter((u) => !isBusy(latest.get(u.id)) && !u.id.endsWith('…'));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chips<SwFilter> value={filter} onChange={setFilter} items={[
          ['pending', `In behandeling (${upds ? pending.length : '…'})`], ['installed', `Geïnstalleerd (${installed.length})`], ['failed', `Mislukt (${failed.length})`],
        ]} />
        <div className="flex-1" />
        <Refreshed at={checkedAt} busy={checking} />
        <button className={ghost} disabled={checking || running || !d.online} onClick={() => void check()}>{checking ? 'Zoeken…' : 'Software scan'}</button>
        {filter === 'pending' && retryable.length > 1 && (
          <button className={primary} disabled={!d.online} onClick={() => void update(retryable)}>Alles bijwerken</button>
        )}
      </div>
      <ErrorText err={checkErr} />
      {!d.online && <p className="text-xs text-(--muted)">Offline: zoeken en bijwerken werkt zodra het apparaat online is.</p>}

      {filter === 'pending' && (
        <>
          {checking && !upds && <Pulse text="Zoeken naar updates…" />}
          {upds && !pending.length && <p className="text-sm text-(--muted)">Alles is up-to-date.</p>}
          {pending.length > 0 && (
            <div className="rounded-xl border border-(--border) bg-(--input) divide-y divide-(--border) overflow-hidden">
              {pending.map((u) => {
                const t = latest.get(u.id);
                return (
                  <SwRow reg={reg} key={`pkg:${u.id}`} k={`pkg:${u.id}`} name={u.name}
                    sub={<>{u.version ? `${u.version} → ` : ''}<span className="text-(--text)">{u.available}</span>{u.source && u.source !== 'winget' ? ` · ${u.source}` : ''}</>}
                    right={isBusy(t) ? (
                      <span className="text-xs text-(--muted) flex items-center gap-2 shrink-0"><span className={clsx('w-2 h-2 rounded-full', t!.status === 'queued' ? 'bg-zinc-400' : 'bg-(--accent) animate-pulse')} />{t!.status === 'queued' ? 'In wachtrij' : 'Bijwerken…'}</span>
                    ) : t && t.status !== 'done' && t.status !== 'cancelled' ? (
                      <span className="flex items-center gap-3 shrink-0">
                        <button className="text-xs text-red-400 hover:underline" onClick={() => setOpenDetail(openDetail === u.id ? '' : u.id)}>Mislukt</button>
                        <button className={ghost} disabled={!d.online} onClick={() => void update([u])}>Opnieuw</button>
                      </span>
                    ) : (
                      <button className={clsx(ghost, 'rounded-full px-4')} disabled={!d.online || u.id.endsWith('…')} onClick={() => void update([u])}>Bijwerken</button>
                    )}>
                    {detail(u.id, t)}
                  </SwRow>
                );
              })}
            </div>
          )}
        </>
      )}

      {filter === 'installed' && (
        <div className="rounded-xl border border-(--border) bg-(--input) divide-y divide-(--border) overflow-hidden">
          {!installed.length && <p className="px-4 py-3 text-xs text-(--muted)">Nog niets bijgewerkt via Claude Chat (laatste 7 dagen).</p>}
          {installed.map((t) => (
            <SwRow reg={reg} key={`done:${t.id}`} k={`done:${t.id}`} name={t.label} sub={relTime(t.finishedAt)}
              right={<button className="text-xs text-green-500 shrink-0 hover:underline" onClick={() => setOpenDetail(openDetail === t.id ? '' : t.id)}>Bijgewerkt</button>}>
              {detail(t.id, t)}
            </SwRow>
          ))}
        </div>
      )}

      {filter === 'failed' && (
        <div className="rounded-xl border border-(--border) bg-(--input) divide-y divide-(--border) overflow-hidden">
          {!failed.length && <p className="px-4 py-3 text-xs text-(--muted)">Geen mislukte updates.</p>}
          {failed.map(([id, t]) => {
            const u = (upds ?? []).find((x) => x.id === id);
            return (
              <SwRow reg={reg} key={`fail:${t.id}`} k={`fail:${t.id}`} name={t.label} sub={relTime(t.finishedAt)}
                right={<span className="flex items-center gap-3 shrink-0">
                  <button className="text-xs text-red-400 hover:underline" onClick={() => setOpenDetail(openDetail === t.id ? '' : t.id)}>Details</button>
                  {u && <button className={ghost} disabled={!d.online} onClick={() => void update([u])}>Opnieuw</button>}
                </span>}>
                {detail(t.id, t)}
              </SwRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══ Software inventory ═══════════════════════════════════════

interface SwApp {
  key: string; name: string; version: string; publisher: string; arch: string; system: boolean; date: string; sizeKB: number;
  source: string; uninstall: string; quiet: string; msi: boolean; scope: string; store: boolean; path?: string; brew?: boolean;
}

const WIN_SOFTWARE = `$ErrorActionPreference = 'SilentlyContinue'
$roots = @(@{ p = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; a = 'x64'; s = 'Machine' }, @{ p = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; a = 'x86'; s = 'Machine' })
Get-ChildItem 'Registry::HKEY_USERS' | Where-Object { $_.PSChildName -match '^S-1-5-21-[\\d-]+$' } | ForEach-Object { $roots += @{ p = "Registry::HKEY_USERS\\$($_.PSChildName)\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"; a = ''; s = $_.PSChildName } }
$out = @(foreach ($r in $roots) { Get-ChildItem $r.p | ForEach-Object { $k = Get-ItemProperty $_.PSPath; if (-not $k.DisplayName) { return }; @{ key = $_.PSChildName; name = [string]$k.DisplayName; version = [string]$k.DisplayVersion; publisher = [string]$k.Publisher; date = [string]$k.InstallDate; sizeKB = [int64]$k.EstimatedSize; system = (([int]$k.SystemComponent -eq 1) -or [bool]$k.ParentKeyName); uninstall = [string]$k.UninstallString; quiet = [string]$k.QuietUninstallString; msi = ([int]$k.WindowsInstaller -eq 1); arch = $r.a; scope = $r.s; store = $false } } })
$out += @(Get-AppxPackage -AllUsers -PackageTypeFilter Main | Where-Object { -not $_.IsFramework -and $_.SignatureKind -eq 'Store' } | ForEach-Object { @{ key = $_.PackageFullName; name = [string]$_.Name; version = [string]$_.Version; publisher = [string]$_.Publisher; date = ''; sizeKB = 0; system = $false; uninstall = ''; quiet = ''; msi = $false; arch = [string]$_.Architecture; scope = 'Machine'; store = $true } })
ConvertTo-Json -Compress -InputObject $out`;

const MAC_SOFTWARE = `F=/tmp/cc-apps-$$.json
system_profiler SPApplicationsDataType -json -detailLevel mini 2>/dev/null > "$F"
osascript -l JavaScript -e 'ObjC.import("Foundation"); var s = $.NSString.stringWithContentsOfFileEncodingError("'"$F"'", $.NSUTF8StringEncoding, null).js; JSON.stringify((JSON.parse(s).SPApplicationsDataType || []).map(function (a) { return { name: a._name, version: a.version || "", source: a.obtained_from || "", date: a.lastModified || "", path: a.path || "", arch: a.arch_kind || "" }; }))'
rm -f "$F"
echo
echo ---BREW---
U="$(stat -f%Su /dev/console)"; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
command -v brew >/dev/null 2>&1 && sudo -u "$U" brew list --versions 2>/dev/null`;

const MAC_SRC: Record<string, string> = { mac_app_store: 'App Store', apple: 'Apple', identified_developer: 'Ontwikkelaar', unknown: 'Onbekend' };
const isoDate = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);
const msiGuid = (a: SwApp) => (/^\{[0-9A-F-]{36}\}$/i.test(a.key) ? a.key : (a.uninstall.match(/\{[0-9A-F-]{36}\}/i)?.[0] ?? ''));
const uninstallTool = (a: SwApp) => `uninstall:${a.name}`.slice(0, 120);

function winUninstallCmd(a: SwApp): string {
  if (a.store) return `Get-AppxPackage -AllUsers -Name ${psq(a.name)} | Remove-AppxPackage -AllUsers -ErrorAction Stop; 'Verwijderd'`;
  const guid = msiGuid(a);
  if (a.msi && guid) return `$p = Start-Process -FilePath msiexec.exe -ArgumentList '/x', ${psq(guid)}, '/qn', '/norestart' -Wait -PassThru
"msiexec exitcode $($p.ExitCode) (0 = gelukt, 3010 = gelukt, herstart nodig)"
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { exit $p.ExitCode }`;
  if (a.quiet) return `$f = Join-Path $env:TEMP ('cc-un-' + [guid]::NewGuid().ToString('N') + '.cmd')
Set-Content -Path $f -Value ${psq(a.quiet)} -Encoding Default
& cmd.exe /c $f 2>&1 | Out-String -Width 400
$c = $LASTEXITCODE
Remove-Item $f -Force -ErrorAction SilentlyContinue
"exitcode $c"
if ($c -ne 0 -and $c -ne 3010) { exit $c }`;
  return `winget uninstall --name ${psq(a.name)} --exact --silent --accept-source-agreements --disable-interactivity 2>&1 | Out-String -Width 400
exit $LASTEXITCODE`;
}

function macUninstallCmd(a: SwApp): string | null {
  if (a.brew) return `U="$(stat -f%Su /dev/console)"; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; sudo -u "$U" brew uninstall ${shq(a.name)} 2>&1`;
  if (a.path && /^\/Applications\/.+\.app$/.test(a.path)) return `rm -rf ${shq(a.path)} && echo Verwijderd: ${shq(a.path)}`;
  return null;
}

export function SoftwareInventory({ d, tasks, reload }: { d: Device; tasks: Task[]; reload: () => void }) {
  const isWin = d.os === 'windows';
  const [sys, setSys] = useState<'hide' | 'all'>('hide');
  const { data, err, busy, load, at } = useLoad(async (): Promise<{ apps: SwApp[]; live: boolean }> => {
    if (!d.online) {
      // offline: last inventory the agent sent
      const r = await api<{ device: Device }>(`/${d.id}`);
      return { live: false, apps: (r.device.inventory?.apps ?? []).map((a, i) => ({
        key: `inv:${i}`, name: a.name, version: a.version ?? '', publisher: a.publisher ?? '', arch: '', system: false, date: '', sizeKB: 0,
        source: '', uninstall: '', quiet: '', msi: false, scope: '', store: false,
      })) };
    }
    if (isWin) {
      const r = await execOn(d.id, WIN_SOFTWARE, { tool: 'view:software', timeout: 180 });
      const list = parseJson<Array<Omit<SwApp, 'source'>> | Omit<SwApp, 'source'>>(r.output);
      if (!list) throw new Error(r.error || r.output.slice(0, 300) || 'Geen gegevens');
      const seen = new Set<string>();
      const apps: SwApp[] = [];
      for (const a of arr<Omit<SwApp, 'source'>>(list)) {
        const k = `${a.scope}:${a.key}`;
        if (seen.has(k)) continue;
        seen.add(k);
        apps.push({
          ...a, date: isoDate(a.date ?? ''), publisher: a.store ? (a.publisher.match(/CN=([^,]+)/)?.[1] ?? a.publisher) : a.publisher,
          arch: a.scope !== 'Machine' && !a.arch ? 'gebruiker' : a.arch, source: a.store ? 'Store' : a.msi ? 'MSI' : 'EXE',
        });
      }
      return { apps, live: true };
    }
    const r = await execOn(d.id, MAC_SOFTWARE, { tool: 'view:software', timeout: 180 });
    const [json, brew = ''] = r.output.split('---BREW---');
    const list = parseJson<Array<{ name: string; version: string; source: string; date: string; path: string; arch: string }>>(json) ?? [];
    if (!list.length && !r.ok) throw new Error(r.error || r.output.slice(0, 300));
    const apps: SwApp[] = list.map((a) => ({
      key: a.path || a.name, name: a.name, version: a.version, publisher: a.source === 'apple' ? 'Apple' : '', arch: a.arch.replace(/^arch_/, ''),
      system: a.source === 'apple' || a.path.startsWith('/System/'), date: a.date, sizeKB: 0, source: MAC_SRC[a.source] ?? a.source,
      uninstall: '', quiet: '', msi: false, scope: 'Machine', store: a.source === 'mac_app_store', path: a.path,
    }));
    for (const l of brew.split('\n')) {
      const p = l.trim().split(/\s+/);
      if (p.length >= 2 && p[0]) apps.push({ key: `brew:${p[0]}`, name: p[0], version: p.slice(1).join(', '), publisher: '', arch: '', system: false, date: '', sizeKB: 0, source: 'Homebrew', uninstall: '', quiet: '', msi: false, scope: 'Machine', store: false, brew: true });
    }
    return { apps, live: true };
  }, [d.id, d.online, isWin]);

  useOnFinished(tasks, 'uninstall:', () => void load());

  async function remove(a: SwApp) {
    const cmd = isWin ? winUninstallCmd(a) : macUninstallCmd(a);
    if (!cmd) { alert('Deze app kan hier niet automatisch verwijderd worden.'); return; }
    if (!confirm(`${a.name}${a.version ? ` ${a.version}` : ''} verwijderen van ${d.name}?${isWin && !a.msi && !a.quiet && !a.store ? '\n\nGeen stille verwijderopdracht bekend: winget wordt geprobeerd.' : ''}`)) return;
    try { await queueTasks(d.id, [{ command: cmd, label: `${a.name} verwijderen`, tool: uninstallTool(a), timeout: 1800, shell: isWin ? 'powershell' : '' }]); } catch (e) { queueErr(e); }
    reload();
  }

  const apps = data?.apps ?? [];
  const rows = sys === 'all' ? apps : apps.filter((a) => !a.system);
  const cols: Col<SwApp>[] = [
    { key: 'pub', label: 'Uitgever', width: 'minmax(8rem,1fr)', value: (a) => a.publisher },
    { key: 'name', label: 'Software', width: 'minmax(14rem,2fr)', value: (a) => a.name },
    { key: 'ver', label: 'Versie', width: '8rem', value: (a) => a.version },
    { key: 'arch', label: 'Architectuur', width: '6.5rem', value: (a) => a.arch },
    { key: 'sys', label: 'Systeemcomponent', width: '7rem', value: (a) => (a.system ? 'Ja' : 'Nee') },
    { key: 'date', label: 'Installatiedatum', width: '8rem', value: (a) => a.date, render: (a) => (a.date ? fmtDate(a.date) : '') },
    { key: 'size', label: 'Grootte', width: '5.5rem', align: 'right', value: (a) => a.sizeKB || null, render: (a) => (a.sizeKB ? fmtBytes(a.sizeKB * 1024) : '') },
    { key: 'src', label: 'Bron', width: '6rem', value: (a) => a.source },
    { key: 'state', label: 'Status', width: '7rem', value: (a) => latestTask(tasks, uninstallTool(a))?.status ?? '', render: (a) => <TaskBadge t={latestTask(tasks, uninstallTool(a))} doneText="Verwijderd" /> },
    { key: 'cmd', label: 'Verwijderopdracht', width: 'minmax(10rem,2fr)', hidden: true, value: (a) => a.quiet || a.uninstall },
  ];

  return (
    <Card title={data ? `${rows.length} ${rows.length === 1 ? 'programma' : 'programma\'s'}${sys === 'hide' && apps.length !== rows.length ? ` (${apps.length - rows.length} systeemcomponenten verborgen)` : ''}` : 'Software'}
      right={<Refreshed at={at} busy={busy} onRefresh={() => void load()} />}>
      {!d.online && <p className="text-xs text-(--muted)">Offline: dit is de laatste inventaris van de agent. Verwijderen kan zodra het apparaat online is.</p>}
      {busy && !data && <Pulse text="Software ophalen…" />}
      <ErrorText err={err} />
      {data && (
        <DataTable<SwApp> id={isWin ? 'sw-inventory' : 'sw-inventory-mac'} exportName={`software-${d.name}`} cols={cols} rows={rows} rowKey={(a) => `${a.scope}:${a.key}`}
          initialSort={{ key: 'name', dir: 1 }}
          toolbar={<Chips value={sys} onChange={setSys} items={[['hide', 'Zonder systeemcomponenten'], ['all', 'Systeemcomponenten tonen']]} />}
          actions={data.live ? (a) => {
            const t = latestTask(tasks, uninstallTool(a));
            const can = isWin ? true : !!macUninstallCmd(a);
            return can ? <RowMenu items={[{ label: 'Verwijderen', danger: true, disabled: !d.online || isBusy(t), onClick: () => void remove(a) }]} /> : null;
          } : undefined} />
      )}
    </Card>
  );
}
