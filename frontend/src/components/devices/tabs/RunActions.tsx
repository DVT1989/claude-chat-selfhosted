'use client';

/**
 * Header actions of the device page: Uitvoeren (automation, patching, maintenance, alerts, reboot),
 * Verbinden (terminal in a chosen context), Maken (scheduled task). Everything that changes the
 * device asks for confirmation and runs through the audited exec route or the task queue.
 */
import { useEffect, useMemo, useState } from 'react';
import { alertsOf, api, Device, scopeHeaders, execOn, ExecResult, ghost, primary, queueTasks } from '../shared';
import { ErrorText, Field, Icon, iconBtn, iconBtnPrimary, inputCls, Menu, MenuItem, Modal, OutputBox, psq, shq } from '../ui';
import { RemoteDesktop } from '../RemoteDesktop';

export interface TermPreset { shell: string; runas: 'system' | 'user'; bits: 32 | 64 }

interface Script { id: string; name: string; description: string | null; os: string; shell: string; runas: 'system' | 'user'; timeout_sec: number; content: string }

type Dialog =
  | { kind: 'script' } | { kind: 'adhoc'; initial?: Partial<Script> } | { kind: 'install' } | { kind: 'runapp' } | { kind: 'transfer' }
  | { kind: 'maintenance' } | { kind: 'rebootLater' } | { kind: 'scheduled' } | null;

const toLocalInput = (t: Date) => new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const shellsFor = (isWin: boolean): Array<[string, string]> => (isWin ? [['powershell', 'PowerShell'], ['cmd', 'CMD'], ['pwsh', 'PowerShell 7']] : [['zsh', 'zsh'], ['bash', 'bash']]);

const MAINT: Array<{ id: string; label: string; detail: string; win?: string; mac?: string; timeout?: number; confirm?: string }> = [
  { id: 'shutdown', label: 'Afsluiten', detail: 'Over 1 minuut', win: 'shutdown.exe /s /t 60 /c "Afsluiten via Claude Chat"; "Afsluiten over 60 seconden"', mac: 'shutdown -h +1 && echo "Afsluiten over 1 minuut"', confirm: 'Afsluiten? Daarna is het apparaat offline.' },
  { id: 'abort', label: 'Herstart annuleren', detail: 'Geplande herstart of afsluiting stoppen', win: 'shutdown.exe /a; "Geannuleerd"', mac: 'killall shutdown 2>/dev/null; echo "Geannuleerd"' },
  { id: 'av-update', label: 'Defender bijwerken', detail: 'Nieuwste definities', timeout: 600, win: 'Update-MpSignature; (Get-MpComputerStatus).AntivirusSignatureLastUpdated' },
  { id: 'av-scan', label: 'Defender snelle scan', detail: 'Enkele minuten', timeout: 1800, win: 'Start-MpScan -ScanType QuickScan; $t = Get-MpThreatDetection; if ($t) { $t | Format-List | Out-String } else { "Geen bedreigingen gevonden" }' },
  { id: 'dns', label: 'DNS-cache legen', detail: 'Bij naamproblemen', win: 'Clear-DnsClientCache; "DNS-cache geleegd"', mac: 'dscacheutil -flushcache; killall -HUP mDNSResponder; echo "DNS-cache geleegd"' },
  { id: 'temp', label: 'Tijdelijke bestanden opruimen', detail: 'Windows- en gebruikers-temp', timeout: 600,
    win: `$before = (Get-PSDrive C).Free
Get-ChildItem 'C:\\Windows\\Temp', 'C:\\Users\\*\\AppData\\Local\\Temp' -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
"Vrijgekomen: $([math]::Round(((Get-PSDrive C).Free - $before) / 1MB)) MB"`, mac: 'rm -rf /private/var/folders/*/*/T/* 2>/dev/null; echo "Opgeruimd"' },
  { id: 'sfc', label: 'Systeembestanden controleren', detail: 'sfc /scannow, duurt lang', timeout: 1800, win: 'sfc.exe /scannow 2>&1 | Out-String' },
  { id: 'gpupdate', label: 'Groepsbeleid bijwerken', detail: 'gpupdate /force', timeout: 300, win: 'gpupdate.exe /force 2>&1 | Out-String' },
];

const WU_INSTALL = `$s = New-Object -ComObject Microsoft.Update.Session; $u = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates
if ($u.Count -eq 0) { 'Geen updates beschikbaar'; return }
$d = $s.CreateUpdateDownloader(); $d.Updates = $u; $d.Download() | Out-Null
$i = $s.CreateUpdateInstaller(); $i.Updates = $u; $res = $i.Install()
"Resultaatcode $($res.ResultCode) (2 = gelukt), herstart nodig: $($res.RebootRequired)"; $u | ForEach-Object { " - $($_.Title)" }`;
const WINGET_ALL = 'winget upgrade --all --silent --include-unknown --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-String -Width 400';
const BREW_ALL = 'U="$(stat -f%Su /dev/console)"; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; command -v brew >/dev/null && sudo -u "$U" brew upgrade 2>&1 || echo "Homebrew niet gevonden"';

export function RunActions({ d, reloadTasks, onDevice, openTab, openTerminal }: {
  d: Device; reloadTasks: () => void; onDevice: (d: Device) => void; openTab: (tab: string) => void; openTerminal: (p: TermPreset) => void;
}) {
  const isWin = d.os === 'windows';
  const [dialog, setDialog] = useState<Dialog>(null);
  const [quick, setQuick] = useState<{ label: string; r: ExecResult | null } | null>(null);
  const [remote, setRemote] = useState(false);
  const isMac = d.os === 'darwin';
  const canRemote = (isWin || isMac) && d.online;
  const off = !d.online;

  async function run(label: string, command: string, opts: { confirm?: string; timeout?: number; tool: string }) {
    if (opts.confirm && !confirm(`${opts.confirm} (${d.name})`)) return;
    if ((opts.timeout ?? 120) > 120) {
      await queueTasks(d.id, [{ command, label, tool: opts.tool, timeout: opts.timeout }]).catch((e) => alert((e as Error).message));
      reloadTasks();
      return;
    }
    setQuick({ label, r: null });
    const r = await execOn(d.id, command, { tool: opts.tool, timeout: opts.timeout ?? 120 }).catch((e) => ({ ok: false, output: '', error: (e as Error).message }));
    setQuick({ label, r });
  }
  async function patch(body: Record<string, unknown>) {
    try { onDevice((await api<{ device: Device }>(`/${d.id}`, { method: 'PATCH', body: JSON.stringify(body) })).device); } catch (e) { alert((e as Error).message); }
  }

  const runMenu: MenuItem[] = [
    { label: 'Automatisering', items: [
      { label: 'Script', detail: 'Uit je scriptbibliotheek', onClick: () => setDialog({ kind: 'script' }), disabled: off },
      { label: 'Eigen script', detail: 'Ad-hoc uitvoeren', onClick: () => setDialog({ kind: 'adhoc' }), disabled: off },
      { label: 'Applicatie installeren', detail: isWin ? 'Via winget' : 'Via Homebrew', onClick: () => setDialog({ kind: 'install' }), disabled: off },
      { label: 'Applicatie uitvoeren', detail: 'Programma starten', onClick: () => setDialog({ kind: 'runapp' }), disabled: off },
      { label: 'Bestandsoverdracht', detail: 'Bestand naar het apparaat sturen', onClick: () => setDialog({ kind: 'transfer' }), disabled: off },
    ] },
    { label: 'Patching', items: [
      { label: 'Software scan', onClick: () => openTab('patching:software') },
      { label: 'Software update', detail: 'Alle apps bijwerken', disabled: off, onClick: () => void run('Alle apps bijwerken', isWin ? WINGET_ALL : BREW_ALL, { confirm: 'Alle apps bijwerken?', timeout: 1800, tool: 'software-update-all' }) },
      { label: 'OS scan', onClick: () => openTab('patching:os') },
      { label: 'OS update', detail: 'Alle beschikbare updates installeren', disabled: off, onClick: () => void run(isWin ? 'Windows-updates installeren' : 'macOS-updates installeren', isWin ? WU_INSTALL : 'softwareupdate -ia 2>&1', { confirm: 'Alle beschikbare OS-updates installeren (zonder automatische herstart)?', timeout: 1800, tool: 'os-update-all' }) },
    ] },
    { label: 'Onderhoudsmodus', items: [
      { label: 'Configureren', detail: 'Waarschuwingen tijdelijk onderdrukken', onClick: () => setDialog({ kind: 'maintenance' }) },
      ...(d.maintenance_until && new Date(d.maintenance_until) > new Date() ? [{ label: 'Beëindigen', onClick: () => void patch({ maintenance_until: null, maintenance_reason: null }) }] : []),
    ] },
    { label: 'Waarschuwingen opnieuw instellen', detail: 'Actieve waarschuwingen wegzetten', onClick: () => {
      const all = alertsOf(d, null, { all: true }).map((a) => a.text);
      if (!all.length) { alert('Geen actieve waarschuwingen.'); return; }
      if (confirm(`${all.length} waarschuwing(en) wegzetten? Ze komen terug als de situatie verandert.`)) void patch({ alerts_ack: all });
    } },
    { label: 'Onderhoud', items: MAINT.filter((a) => (isWin ? a.win : a.mac)).map((a) => ({
      label: a.label, detail: a.detail, disabled: off,
      onClick: () => void run(a.label, (isWin ? a.win : a.mac)!, { confirm: a.confirm, timeout: a.timeout, tool: a.id }),
    })) },
    { label: 'Opnieuw opstarten', items: [
      { label: 'Nu herstarten', detail: 'Over 1 minuut, met melding', disabled: off, danger: true, onClick: () => void run('Herstarten', isWin ? 'shutdown.exe /r /t 60 /c "Herstart via Claude Chat"; "Herstart over 60 seconden"' : 'shutdown -r +1 && echo "Herstart over 1 minuut"', { confirm: 'Nu herstarten?', tool: 'reboot' }) },
      { label: 'Later herstarten', detail: 'Plannen', onClick: () => setDialog({ kind: 'rebootLater' }) },
    ] },
  ];

  const ctx: Array<[string, 'system' | 'user', 32 | 64]> = isWin
    ? [['Systeem 64-bit', 'system', 64], ['Systeem 32-bit', 'system', 32], ['Aangemelde gebruiker 64-bit', 'user', 64], ['Aangemelde gebruiker 32-bit', 'user', 32]]
    : [['root', 'system', 64], ['Aangemelde gebruiker', 'user', 64]];
  const connectMenu: MenuItem[] = [
    ...(isWin || isMac ? [{ label: 'Extern bureaublad', detail: 'Meekijken en overnemen', disabled: !canRemote, onClick: () => setRemote(true) }] : []),
    ...(isWin ? [['powershell', 'PowerShell'], ['cmd', 'CMD']] : [['zsh', 'zsh'], ['bash', 'bash']]).map(([sh, l]) => ({
      label: l, disabled: off, items: ctx.map(([cl, runas, bits]) => ({ label: cl, onClick: () => openTerminal({ shell: sh, runas, bits }) })),
    })),
  ];

  return (
    <>
      {(isWin || isMac) && (
        <button className={iconBtnPrimary} disabled={!canRemote} onClick={() => setRemote(true)} title={off ? 'Meekijken (apparaat is offline)' : 'Meekijken en overnemen'} aria-label="Meekijken">
          <Icon name="monitor" />
        </button>
      )}
      <Menu label={<Icon name="play" />} caret={false} title="Uitvoeren" items={runMenu} buttonClass={iconBtn} />
      <Menu label={<Icon name="terminal" />} caret={false} title="Verbinden" items={connectMenu} disabled={off} buttonClass={iconBtn} />
      <Menu label={<Icon name="plus" />} caret={false} title="Maken" align="right" items={[{ label: 'Geplande taak', detail: 'Script op een tijdstip', onClick: () => setDialog({ kind: 'scheduled' }) }]} buttonClass={iconBtn} />
      {remote && <RemoteDesktop d={d} onClose={() => setRemote(false)} />}

      {quick && (
        <Modal title={quick.label} onClose={() => setQuick(null)} footer={<button className={ghost} onClick={() => setQuick(null)}>Sluiten</button>}>
          {quick.r ? <OutputBox text={quick.r.output || quick.r.error || (quick.r.ok ? 'Klaar.' : 'Mislukt.')} bad={!quick.r.ok} /> : <p className="text-(--muted)">Bezig…</p>}
        </Modal>
      )}
      {dialog?.kind === 'script' && <ScriptLibrary d={d} onClose={() => setDialog(null)} onEdit={(s) => setDialog({ kind: 'adhoc', initial: s })} reloadTasks={reloadTasks} />}
      {dialog?.kind === 'adhoc' && <AdHoc d={d} initial={dialog.initial} onClose={() => setDialog(null)} reloadTasks={reloadTasks} />}
      {dialog?.kind === 'scheduled' && <AdHoc d={d} scheduled onClose={() => setDialog(null)} reloadTasks={reloadTasks} />}
      {dialog?.kind === 'install' && <InstallApp d={d} onClose={() => setDialog(null)} reloadTasks={reloadTasks} />}
      {dialog?.kind === 'runapp' && <RunApp d={d} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'transfer' && <Transfer d={d} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'maintenance' && <Maintenance d={d} onClose={() => setDialog(null)} onSave={(b) => { void patch(b); setDialog(null); }} />}
      {dialog?.kind === 'rebootLater' && <RebootLater d={d} onClose={() => setDialog(null)} reloadTasks={reloadTasks} />}
    </>
  );
}

// ── Dialogs ──────────────────────────────────────────────────

function ScriptLibrary({ d, onClose, onEdit, reloadTasks }: { d: Device; onClose: () => void; onEdit: (s: Script) => void; reloadTasks: () => void }) {
  const [list, setList] = useState<Script[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const load = () => api<{ scripts: Script[] }>('/scripts').then((r) => setList(r.scripts)).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);
  const rows = (list ?? []).filter((s) => s.os === (d.os === 'windows' ? 'windows' : 'darwin') && (!q || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  async function start(s: Script) {
    if (!confirm(`"${s.name}" uitvoeren op ${d.name}?`)) return;
    try { await queueTasks(d.id, [{ command: s.content, shell: s.shell, label: `Script: ${s.name}`, tool: `script:${s.name}`, timeout: s.timeout_sec, runas: s.runas }]); reloadTasks(); onClose(); }
    catch (e) { setErr((e as Error).message); }
  }
  return (
    <Modal title="Script uitvoeren" onClose={onClose} wide footer={<><button className={ghost} onClick={() => onEdit({ id: '', name: '', description: '', os: d.os ?? 'windows', shell: '', runas: 'system', timeout_sec: 600, content: '' })}>Nieuw script</button><button className={ghost} onClick={onClose}>Sluiten</button></>}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken" className={`${inputCls} w-full`} />
      <ErrorText err={err} />
      {!list ? <p className="text-(--muted)">Laden…</p> : !rows.length ? <p className="text-(--muted)">Nog geen scripts voor {d.os === 'windows' ? 'Windows' : 'macOS'}. Maak er een met Nieuw script of sla een eigen script op.</p> : (
        <div className="rounded-xl border border-(--border) divide-y divide-(--border)">
          {rows.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-(--text) truncate">{s.name}</div>
                <div className="text-xs text-(--muted) truncate">{s.description || s.content.split('\n')[0]} · {s.runas === 'user' ? 'gebruiker' : 'systeem'} · {s.shell || 'standaard'}</div>
              </div>
              <button className="text-xs text-(--muted) hover:text-(--text)" onClick={() => onEdit(s)}>Bewerken</button>
              <button className="text-xs text-red-400 hover:underline" onClick={async () => { if (confirm(`Script "${s.name}" verwijderen?`)) { await api(`/scripts/${s.id}`, { method: 'DELETE' }); void load(); } }}>Verwijderen</button>
              <button className={primary} disabled={!d.online} onClick={() => void start(s)}>Uitvoeren</button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function AdHoc({ d, initial, scheduled, onClose, reloadTasks }: { d: Device; initial?: Partial<Script>; scheduled?: boolean; onClose: () => void; reloadTasks: () => void }) {
  const isWin = d.os === 'windows';
  const [name, setName] = useState(initial?.name ?? '');
  const [desc, setDesc] = useState(initial?.description ?? '');
  const [shell, setShell] = useState(initial?.shell || (isWin ? 'powershell' : 'zsh'));
  const [runas, setRunas] = useState<'system' | 'user'>(initial?.runas ?? 'system');
  const [timeout, setTimeoutSec] = useState(initial?.timeout_sec ?? 600);
  const [content, setContent] = useState(initial?.content ?? '');
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 3600e3)));
  const [mode, setMode] = useState<'now' | 'task'>('task');
  const [res, setRes] = useState<ExecResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    if (!name.trim()) { setErr('Geef het script een naam.'); return; }
    const body = { name: name.trim(), description: desc || null, os: isWin ? 'windows' : 'darwin', shell, runas, timeout, content };
    try {
      if (initial?.id) await api(`/scripts/${initial.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/scripts', { method: 'POST', body: JSON.stringify(body) });
      setErr(''); alert('Opgeslagen in de bibliotheek.');
    } catch (e) { setErr((e as Error).message); }
  }
  async function go() {
    if (!content.trim()) return;
    setErr(''); setRes(null);
    const label = scheduled ? `Gepland: ${name || content.split('\n')[0].slice(0, 60)}` : `Script: ${name || content.split('\n')[0].slice(0, 60)}`;
    if (scheduled) {
      const t = new Date(when);
      if (Number.isNaN(t.getTime()) || t.getTime() < Date.now() - 60_000) { setErr('Kies een tijdstip in de toekomst.'); return; }
      if (!confirm(`Script plannen op ${t.toLocaleString('nl-NL')} op ${d.name}?`)) return;
      try { await queueTasks(d.id, [{ command: content, shell, label, tool: 'scheduled-script', timeout, runas, runAt: t.toISOString() }]); reloadTasks(); onClose(); } catch (e) { setErr((e as Error).message); }
      return;
    }
    if (!confirm(`Script uitvoeren op ${d.name} als ${runas === 'user' ? 'aangemelde gebruiker' : isWin ? 'SYSTEM' : 'root'}?`)) return;
    if (mode === 'task') {
      try { await queueTasks(d.id, [{ command: content, shell, label, tool: 'adhoc-script', timeout, runas }]); reloadTasks(); onClose(); } catch (e) { setErr((e as Error).message); }
      return;
    }
    setBusy(true);
    try { setRes(await execOn(d.id, content, { shell, runas, timeout: Math.min(timeout, 600), tool: 'adhoc-script' })); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <Modal title={scheduled ? 'Geplande taak' : initial?.id ? `Script: ${initial.name}` : 'Eigen script'} onClose={onClose} wide footer={<>
      <button className={ghost} onClick={() => void save()} disabled={!content.trim()}>{initial?.id ? 'Wijzigingen opslaan' : 'Opslaan in bibliotheek'}</button>
      <button className={ghost} onClick={onClose}>Sluiten</button>
      <button className={primary} disabled={busy || !content.trim() || !d.online && !scheduled} onClick={() => void go()}>{busy ? 'Bezig…' : scheduled ? 'Plannen' : 'Uitvoeren'}</button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Naam"><input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} w-full`} placeholder="Bijvoorbeeld: Wekelijkse controle backup" /></Field>
        <Field label="Omschrijving"><input value={desc ?? ''} onChange={(e) => setDesc(e.target.value)} className={`${inputCls} w-full`} /></Field>
        <Field label="Shell"><select value={shell} onChange={(e) => setShell(e.target.value)} className={`${inputCls} w-full`}>{shellsFor(isWin).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Uitvoeren als"><select value={runas} onChange={(e) => setRunas(e.target.value as 'system' | 'user')} className={`${inputCls} w-full`}>
          <option value="system">{isWin ? 'SYSTEM' : 'root'}</option><option value="user">Aangemelde gebruiker</option></select></Field>
        <Field label="Time-out (seconden)"><input type="number" min={5} max={1800} value={timeout} onChange={(e) => setTimeoutSec(Math.min(1800, Math.max(5, Number(e.target.value) || 600)))} className={`${inputCls} w-full`} /></Field>
        {scheduled ? (
          <Field label="Tijdstip"><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={`${inputCls} w-full`} /></Field>
        ) : (
          <Field label="Wijze" hint="Als taak loopt het door als je de app sluit."><select value={mode} onChange={(e) => setMode(e.target.value as 'now' | 'task')} className={`${inputCls} w-full`}>
            <option value="task">Als taak (wachtrij)</option><option value="now">Direct, uitvoer hier tonen</option></select></Field>
        )}
      </div>
      <Field label="Script"><textarea value={content} onChange={(e) => setContent(e.target.value)} rows={12} spellCheck={false} className={`${inputCls} w-full font-mono text-xs`} /></Field>
      <ErrorText err={err} />
      {res && <OutputBox text={res.output || res.error || (res.ok ? 'Klaar.' : 'Mislukt.')} bad={!res.ok} />}
    </Modal>
  );
}

interface Pkg { name: string; id: string; version: string; source?: string }
function parseSearch(out: string): Pkg[] {
  const lines = out.split(/\r?\n|\r/);
  const sep = lines.findIndex((l) => /^-{20,}\s*$/.test(l.trim()));
  if (sep < 1) return [];
  const starts = [...lines[sep - 1].matchAll(/\S+/g)].map((m) => m.index ?? 0);
  if (starts.length < 3) return [];
  const col = (l: string, i: number) => l.slice(starts[i], starts[i + 1] ?? undefined).trim();
  return lines.slice(sep + 1).filter((l) => l.trim() && l.length >= starts[2]).map((l) => ({ name: col(l, 0), id: col(l, 1), version: col(l, 2), source: starts.length > 4 ? col(l, 4) : col(l, 3) })).filter((p) => p.id);
}

function InstallApp({ d, onClose, reloadTasks }: { d: Device; onClose: () => void; reloadTasks: () => void }) {
  const isWin = d.os === 'windows';
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Pkg[] | null>(null);
  const [raw, setRaw] = useState('');
  const [err, setErr] = useState('');
  async function search() {
    if (!q.trim()) return;
    setBusy(true); setErr(''); setRows(null); setRaw('');
    try {
      const cmd = isWin ? `winget search ${psq(q.trim())} --accept-source-agreements --disable-interactivity 2>&1 | Out-String -Width 400`
        : `U="$(stat -f%Su /dev/console)"; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; command -v brew >/dev/null || { echo "Homebrew niet gevonden"; exit 1; }; sudo -u "$U" brew search ${shq(q.trim())} 2>&1`;
      const r = await execOn(d.id, cmd, { tool: 'view:app-search', timeout: 120 });
      if (isWin) { const p = parseSearch(r.output); setRows(p); if (!p.length) setRaw(r.output || r.error || ''); }
      else setRows(r.output.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('==>')).map((n) => ({ name: n, id: n, version: '' })));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  async function install(p: Pkg) {
    if (!confirm(`${p.name} installeren op ${d.name}?`)) return;
    const cmd = isWin
      ? `winget install --id ${psq(p.id)} --exact --silent --scope machine --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-String -Width 400\nif ($LASTEXITCODE -ne 0) { winget install --id ${psq(p.id)} --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-String -Width 400 }\nexit $LASTEXITCODE`
      : `U="$(stat -f%Su /dev/console)"; PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; sudo -u "$U" brew install ${shq(p.id)} 2>&1`;
    try { await queueTasks(d.id, [{ command: cmd, label: `${p.name} installeren`, tool: `install:${p.id}`, timeout: 1800 }]); reloadTasks(); onClose(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <Modal title="Applicatie installeren" onClose={onClose} wide footer={<button className={ghost} onClick={onClose}>Sluiten</button>}>
      <div className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} placeholder={isWin ? 'Zoeken in winget, bijv. 7zip of Microsoft.Teams' : 'Zoeken in Homebrew'} className={`${inputCls} flex-1`} autoFocus />
        <button className={primary} disabled={busy || !q.trim()} onClick={() => void search()}>{busy ? 'Zoeken…' : 'Zoeken'}</button>
      </div>
      <ErrorText err={err} />
      {raw && <OutputBox text={raw} />}
      {rows && !rows.length && !raw && <p className="text-(--muted)">Niets gevonden.</p>}
      {rows && rows.length > 0 && (
        <div className="rounded-xl border border-(--border) divide-y divide-(--border) max-h-[50vh] overflow-y-auto">
          {rows.slice(0, 100).map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2">
              <div className="flex-1 min-w-0"><div className="text-(--text) truncate">{p.name}</div><div className="text-xs text-(--muted) truncate">{p.id}{p.version ? ` · ${p.version}` : ''}{p.source ? ` · ${p.source}` : ''}</div></div>
              <button className={ghost} onClick={() => void install(p)}>Installeren</button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function RunApp({ d, onClose }: { d: Device; onClose: () => void }) {
  const isWin = d.os === 'windows';
  const [path, setPath] = useState('');
  const [args, setArgs] = useState('');
  const [asUser, setAsUser] = useState(true);
  const [res, setRes] = useState<ExecResult | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!path.trim() || !confirm(`${path} starten op ${d.name}?`)) return;
    setBusy(true);
    const cmd = isWin
      ? `$p = Start-Process -FilePath ${psq(path.trim())}${args.trim() ? ` -ArgumentList ${psq(args.trim())}` : ''} -PassThru; "Gestart, PID $($p.Id)"`
      : asUser ? `open -a ${shq(path.trim())}${args.trim() ? ` --args ${args.trim()}` : ''} && echo "Gestart"` : `${shq(path.trim())} ${args.trim()} >/dev/null 2>&1 & echo "Gestart, PID $!"`;
    try { setRes(await execOn(d.id, cmd, { tool: 'run-app', runas: asUser ? 'user' : 'system', timeout: 60 })); } catch (e) { setRes({ ok: false, output: '', error: (e as Error).message }); }
    setBusy(false);
  }
  return (
    <Modal title="Applicatie uitvoeren" onClose={onClose} footer={<><button className={ghost} onClick={onClose}>Sluiten</button><button className={primary} disabled={busy || !path.trim() || !d.online} onClick={() => void go()}>{busy ? 'Bezig…' : 'Starten'}</button></>}>
      <Field label={isWin ? 'Programma' : 'App of pad'}><input value={path} onChange={(e) => setPath(e.target.value)} className={`${inputCls} w-full font-mono`} placeholder={isWin ? 'notepad.exe of C:\\Program Files\\App\\app.exe' : 'Safari of /usr/local/bin/tool'} /></Field>
      <Field label="Argumenten"><input value={args} onChange={(e) => setArgs(e.target.value)} className={`${inputCls} w-full font-mono`} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={asUser} onChange={(e) => setAsUser(e.target.checked)} />In de sessie van de aangemelde gebruiker (zichtbaar op het bureaublad)</label>
      {res && <OutputBox text={res.output || res.error || ''} bad={!res.ok} />}
    </Modal>
  );
}

function Transfer({ d, onClose }: { d: Device; onClose: () => void }) {
  const isWin = d.os === 'windows';
  const [file, setFile] = useState<File | null>(null);
  const [dir, setDir] = useState(isWin ? 'C:\\Temp' : '/tmp');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  async function go() {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setErr('Maximaal 20 MB.'); return; }
    const sep = isWin ? '\\' : '/';
    const target = `${dir.replace(/[\\/]+$/, '')}${sep}${file.name}`;
    setBusy(true); setErr(''); setMsg('');
    try {
      await execOn(d.id, isWin ? `New-Item -ItemType Directory -Force -Path ${psq(dir)} | Out-Null` : `mkdir -p ${shq(dir)}`, { tool: 'file-mkdir', timeout: 30 });
      const res = await fetch(`/api/devices/${d.id}/file?path=${encodeURIComponent(target)}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream', ...scopeHeaders() }, body: file });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      setMsg(`Opgeslagen als ${target}`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  return (
    <Modal title="Bestandsoverdracht" onClose={onClose} footer={<><button className={ghost} onClick={onClose}>Sluiten</button><button className={primary} disabled={busy || !file || !d.online} onClick={() => void go()}>{busy ? 'Versturen…' : 'Versturen'}</button></>}>
      <Field label="Bestand (max 20 MB)"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" /></Field>
      <Field label="Doelmap op het apparaat"><input value={dir} onChange={(e) => setDir(e.target.value)} className={`${inputCls} w-full font-mono`} /></Field>
      <ErrorText err={err} />
      {msg && <p className="text-xs text-green-500">{msg}</p>}
    </Modal>
  );
}

function Maintenance({ d, onClose, onSave }: { d: Device; onClose: () => void; onSave: (b: Record<string, unknown>) => void }) {
  const [hours, setHours] = useState('4');
  const [until, setUntil] = useState(() => toLocalInput(new Date(Date.now() + 4 * 3600e3)));
  const [reason, setReason] = useState(d.maintenance_reason ?? '');
  const end = useMemo(() => (hours === 'custom' ? new Date(until) : new Date(Date.now() + Number(hours) * 3600e3)), [hours, until]);
  return (
    <Modal title="Onderhoudsmodus" onClose={onClose} footer={<><button className={ghost} onClick={onClose}>Annuleren</button><button className={primary} onClick={() => onSave({ maintenance_until: end.toISOString(), maintenance_reason: reason || null })}>Inschakelen</button></>}>
      <p className="text-(--muted)">Waarschuwingen en gezondheidsstatus van {d.name} worden tot het eindtijdstip niet getoond. Acties blijven gewoon werken.</p>
      <Field label="Duur"><select value={hours} onChange={(e) => setHours(e.target.value)} className={`${inputCls} w-full`}>
        {[['1', '1 uur'], ['4', '4 uur'], ['8', '8 uur'], ['24', '1 dag'], ['72', '3 dagen'], ['168', '1 week'], ['custom', 'Tot tijdstip']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select></Field>
      {hours === 'custom' && <Field label="Tot"><input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className={`${inputCls} w-full`} /></Field>}
      <Field label="Reden"><input value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputCls} w-full`} placeholder="Bijvoorbeeld: hardware vervangen" /></Field>
      <p className="text-xs text-(--muted)">Tot {end.toLocaleString('nl-NL')}</p>
    </Modal>
  );
}

function RebootLater({ d, onClose, reloadTasks }: { d: Device; onClose: () => void; reloadTasks: () => void }) {
  const isWin = d.os === 'windows';
  const [when, setWhen] = useState(() => { const t = new Date(); t.setDate(t.getDate() + (t.getHours() >= 22 ? 1 : 0)); t.setHours(22, 0, 0, 0); return toLocalInput(t); });
  const [err, setErr] = useState('');
  async function go() {
    const t = new Date(when);
    if (Number.isNaN(t.getTime()) || t.getTime() < Date.now()) { setErr('Kies een tijdstip in de toekomst.'); return; }
    const cmd = isWin ? 'shutdown.exe /r /t 120 /c "Geplande herstart via Claude Chat over 2 minuten"; "Herstart over 2 minuten"' : 'shutdown -r +2 && echo "Herstart over 2 minuten"';
    try { await queueTasks(d.id, [{ command: cmd, label: `Herstarten (gepland ${t.toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })})`, tool: 'reboot-scheduled', timeout: 60, runAt: t.toISOString() }]); reloadTasks(); onClose(); }
    catch (e) { setErr((e as Error).message); }
  }
  return (
    <Modal title="Later herstarten" onClose={onClose} footer={<><button className={ghost} onClick={onClose}>Annuleren</button><button className={primary} onClick={() => void go()}>Plannen</button></>}>
      <Field label="Tijdstip" hint="De gebruiker krijgt 2 minuten van tevoren een melding. Is het apparaat dan offline, dan mislukt de taak."><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={`${inputCls} w-full`} /></Field>
      <ErrorText err={err} />
    </Modal>
  );
}
