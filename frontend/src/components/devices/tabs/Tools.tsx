'use client';

/**
 * Tools (NinjaOne 3.6): remote registry, task manager, file browser and service manager, live via the agent.
 * Reads use tool "view:*" (kept out of the activity feed), changes use a plain tool name and ask first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Badge, Device, execOn, ghost, parseJson, primary, scopeHeaders } from '../shared';
import {
  Col, DataTable, ErrorText, Field, fmtBytes, inputCls, Modal, Chips, MenuItem, psq, Pulse, Refreshed, relTime, RowMenu, shq, SubNav, useLoad,
} from '../ui';

type ToolTab = 'registry' | 'processes' | 'files' | 'services';

const arr = <T,>(v: T[] | T | null | undefined): T[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Runs a read script; throws with the device's error text when it fails or prints no JSON. */
async function readJson<T>(d: Device, command: string, tool: string, timeout = 60): Promise<T> {
  const r = await execOn(d.id, command, { tool, timeout, shell: d.os === 'windows' ? 'powershell' : 'zsh' });
  const v = parseJson<T>(r.output);
  if (v == null || (!r.ok && !r.output.trim().match(/^[[{]/))) throw new Error((r.error || r.output || 'Geen antwoord').trim().slice(0, 1500));
  return v;
}

/** Runs a change; shows the error and returns false when it fails. */
async function mutate(d: Device, tool: string, command: string, timeout = 120): Promise<boolean> {
  try {
    const r = await execOn(d.id, command, { tool, timeout, shell: d.os === 'windows' ? 'powershell' : 'zsh' });
    if (!r.ok) { alert((r.error || r.output || 'Mislukt').trim().slice(0, 2000)); return false; }
    return true;
  } catch (e) { alert((e as Error).message); return false; }
}

// ── Registry ─────────────────────────────────────────────────

const HIVES: Record<string, string> = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER', HKCR: 'HKEY_CLASSES_ROOT', HKU: 'HKEY_USERS', HKCC: 'HKEY_CURRENT_CONFIG' };
const ROOTS: Array<[string, string]> = [
  ['HKEY_CLASSES_ROOT', 'HKEY_CLASSES_ROOT'], ['HKEY_CURRENT_CONFIG', 'HKEY_CURRENT_CONFIG'], ['HKEY_CURRENT_USER', 'HKEY_CURRENT_USER (SYSTEM)'],
  ['HKEY_LOCAL_MACHINE', 'HKEY_LOCAL_MACHINE'], ['HKEY_USERS', 'HKEY_USERS'],
];
const KINDS = ['String', 'ExpandString', 'DWord', 'QWord', 'MultiString', 'Binary'] as const;
type Kind = typeof KINDS[number];
const KIND_LABEL: Record<string, string> = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', DWord: 'REG_DWORD', QWord: 'REG_QWORD', MultiString: 'REG_MULTI_SZ', Binary: 'REG_BINARY', None: 'REG_NONE', Unknown: 'REG_UNKNOWN' };

/** "HKLM\Software", "Computer\HKEY_...", "HKLM:\..." and "Registry::..." all become "HKEY_LOCAL_MACHINE\Software". */
function normReg(p: string): string {
  let s = p.trim().replace(/^Computer\\/i, '').replace(/^Registry::/i, '').replace(/\//g, '\\').replace(/\\+$/, '');
  const m = s.match(/^([^\\:]+):?(\\.*)?$/);
  if (m && HIVES[m[1].toUpperCase()]) s = HIVES[m[1].toUpperCase()] + (m[2] ?? '');
  else if (m) s = m[1].toUpperCase() + (m[2] ?? '');
  return s;
}
const regParent = (p: string) => (p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : p);

interface RegValue { name: string; kind: string; data: string; raw?: string }
interface RegKey { path: string; subkeys: string[]; values: RegValue[]; labels: Record<string, string> }

const regRead = (path: string) => String.raw`$ErrorActionPreference = 'Stop'
$p = ${psq(path)}
$k = Get-Item -LiteralPath ('Registry::' + $p)
$vals = @(foreach ($n in $k.GetValueNames()) {
  $kind = "$($k.GetValueKind($n))"
  $v = $k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
  $raw = $null
  if ($v -is [byte[]]) { $data = ($v | ForEach-Object { $_.ToString('x2') }) -join ' ' }
  elseif ($v -is [string[]]) { $data = $v -join [char]10 }
  elseif ($kind -eq 'DWord') { $u = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$v), 0); $data = '0x{0:x8} ({0})' -f $u; $raw = "$u" }
  elseif ($kind -eq 'QWord') { $u = [BitConverter]::ToUInt64([BitConverter]::GetBytes([int64]$v), 0); $data = '0x{0:x16} ({0})' -f $u; $raw = "$u" }
  else { $data = "$v" }
  @{ name = $n; kind = $kind; data = $data; raw = $raw }
})
$subs = @($k.GetSubKeyNames() | Sort-Object)
$labels = @{}
if ($p -eq 'HKEY_USERS') {
  foreach ($s in $subs) {
    $sid = $s -replace '_Classes$', ''
    $pi = (Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid) -ErrorAction SilentlyContinue).ProfileImagePath
    if ($pi) { $labels[$s] = (Split-Path $pi -Leaf) + $(if ($s -like '*_Classes') { ' (Classes)' } else { '' }) }
    elseif ($sid -eq 'S-1-5-18') { $labels[$s] = 'SYSTEM' } elseif ($sid -eq 'S-1-5-19') { $labels[$s] = 'LOCAL SERVICE' } elseif ($sid -eq 'S-1-5-20') { $labels[$s] = 'NETWORK SERVICE' } elseif ($sid -eq '.DEFAULT') { $labels[$s] = 'Standaardgebruiker' }
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @{ path = $p; subkeys = $subs; values = $vals; labels = $labels }`;

const regSet = (path: string, name: string, kind: Kind, data: string, oldName: string | null) => String.raw`$ErrorActionPreference = 'Stop'
$p = 'Registry::' + ${psq(path)}
$s = ${psq(data)}
$kind = ${psq(kind)}
switch ($kind) {
  'DWord' { $v = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$s.Trim()), 0) }
  'QWord' { $v = [BitConverter]::ToInt64([BitConverter]::GetBytes([uint64]$s.Trim()), 0) }
  'MultiString' { $v = [string[]]($s -split '\r?\n') }
  'Binary' { $h = $s -replace '[^0-9a-fA-F]', ''; if ($h.Length % 2) { $h = '0' + $h }; $v = [byte[]]@(for ($i = 0; $i -lt $h.Length; $i += 2) { [Convert]::ToByte($h.Substring($i, 2), 16) }) }
  default { $v = $s }
}
New-ItemProperty -LiteralPath $p -Name ${psq(name)} -PropertyType $kind -Value $v -Force | Out-Null
${oldName != null && oldName !== name ? `Remove-ItemProperty -LiteralPath $p -Name ${psq(oldName)} -Force` : ''}
'Opgeslagen'`;

function Registry({ d }: { d: Device }) {
  const [sel, setSel] = useState('HKEY_LOCAL_MACHINE');
  const [pathInput, setPathInput] = useState('HKEY_LOCAL_MACHINE');
  const [children, setChildren] = useState<Record<string, string[]>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingNode, setLoadingNode] = useState('');
  const [edit, setEdit] = useState<{ orig: string | null; name: string; kind: Kind; data: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchKey = useCallback(async (path: string): Promise<RegKey> => {
    const k = await readJson<RegKey>(d, regRead(path), 'view:registry', 60);
    const key: RegKey = { path: k.path ?? path, subkeys: arr(k.subkeys), values: arr(k.values), labels: (k.labels && typeof k.labels === 'object' && !Array.isArray(k.labels)) ? k.labels : {} };
    setChildren((c) => ({ ...c, [path]: key.subkeys }));
    if (Object.keys(key.labels).length) setLabels((l) => { const n = { ...l }; for (const [s, v] of Object.entries(key.labels)) n[`${path}\\${s}`] = v; return n; });
    return key;
  }, [d]);

  const { data, err, busy, load, at } = useLoad(() => fetchKey(sel), [sel, fetchKey]);

  function go(path: string) {
    const p = normReg(path);
    if (!p) return;
    setSel(p); setPathInput(p);
    // open every ancestor in the tree
    setExpanded((e) => { const n = new Set(e); const parts = p.split('\\'); for (let i = 1; i <= parts.length; i++) n.add(parts.slice(0, i).join('\\')); return n; });
    let acc = '';
    for (const part of p.split('\\').slice(0, -1)) { acc = acc ? `${acc}\\${part}` : part; const a = acc; if (!children[a]) void fetchKey(a).catch(() => undefined); }
  }

  async function toggle(path: string) {
    const open = expanded.has(path);
    setExpanded((e) => { const n = new Set(e); if (open) n.delete(path); else n.add(path); return n; });
    if (!open && !children[path]) {
      setLoadingNode(path);
      try { await fetchKey(path); } catch (e) { alert((e as Error).message); }
      setLoadingNode('');
    }
  }

  function node(path: string, label: string, depth: number): React.ReactNode {
    const open = expanded.has(path);
    const kids = children[path];
    return (
      <div key={path}>
        <div className={clsx('flex items-center gap-1 rounded-md pr-2 cursor-pointer whitespace-nowrap', sel === path ? 'bg-(--accent)/15 text-(--text)' : 'text-(--muted) hover:text-(--text) hover:bg-(--border)/40')}
          style={{ paddingLeft: depth * 12 + 4 }}>
          <button className="w-4 text-center shrink-0" onClick={() => void toggle(path)} aria-label={open ? 'Inklappen' : 'Uitklappen'}>
            {kids && kids.length === 0 ? '' : open ? '-' : '+'}
          </button>
          <button className="text-left py-0.5 truncate" onClick={() => go(path)} title={path}>{label}</button>
          {loadingNode === path && <span className="w-1.5 h-1.5 rounded-full bg-(--accent) animate-pulse" />}
        </div>
        {open && kids?.map((k) => node(`${path}\\${k}`, labels[`${path}\\${k}`] ? `${k} (${labels[`${path}\\${k}`]})` : k, depth + 1))}
      </div>
    );
  }

  async function addKey() {
    const name = prompt(`Nieuwe sleutel onder ${sel}`)?.trim();
    if (!name) return;
    if (await mutate(d, 'registry-key-add', `New-Item -Path ('Registry::' + ${psq(`${sel}\\${name}`)}) -Force -ErrorAction Stop | Out-Null; 'Sleutel gemaakt'`)) {
      await fetchKey(sel).catch(() => undefined);
      void load();
    }
  }
  async function deleteKey() {
    if (!sel.includes('\\')) { alert('Een hoofdsleutel kan niet verwijderd worden.'); return; }
    if (!confirm(`Sleutel ${sel} met alle subsleutels en waarden verwijderen?`)) return;
    if (await mutate(d, 'registry-key-delete', `Remove-Item -LiteralPath ('Registry::' + ${psq(sel)}) -Recurse -Force -ErrorAction Stop; 'Verwijderd'`)) {
      const parent = regParent(sel);
      await fetchKey(parent).catch(() => undefined);
      go(parent);
    }
  }
  async function deleteValue(v: RegValue) {
    if (!confirm(`Waarde "${v.name || '(Standaard)'}" in ${sel} verwijderen?`)) return;
    if (await mutate(d, 'registry-value-delete', `Remove-ItemProperty -LiteralPath ('Registry::' + ${psq(sel)}) -Name ${psq(v.name)} -Force -ErrorAction Stop; 'Verwijderd'`)) void load();
  }
  async function save() {
    if (!edit) return;
    const kind = edit.kind;
    if ((kind === 'DWord' || kind === 'QWord') && !/^\s*(0x[0-9a-f]+|\d+)\s*$/i.test(edit.data)) { alert('Geef een getal op (decimaal of 0x-hex).'); return; }
    if (!confirm(`${edit.orig == null ? 'Waarde toevoegen' : 'Waarde wijzigen'}: ${edit.name || '(Standaard)'} in ${sel}?`)) return;
    setSaving(true);
    const ok = await mutate(d, 'registry-set', regSet(sel, edit.name, kind, edit.data, edit.orig));
    setSaving(false);
    if (ok) { setEdit(null); void load(); }
  }

  const cols: Col<RegValue>[] = [
    { key: 'name', label: 'Naam', value: (v) => v.name || '(Standaard)', width: 'minmax(10rem,1.2fr)' },
    { key: 'kind', label: 'Type', value: (v) => KIND_LABEL[v.kind] ?? v.kind, width: '8rem' },
    { key: 'data', label: 'Gegevens', value: (v) => v.data, width: 'minmax(12rem,2fr)', render: (v) => <span className="font-mono">{v.data.replace(/\n/g, ' | ')}</span> },
  ];
  const crumbs = sel.split('\\');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(pathInput); }}
          className={clsx(inputCls, 'flex-1 min-w-64 font-mono text-xs')} placeholder="HKLM\SOFTWARE\Microsoft" spellCheck={false} />
        <button className={ghost} onClick={() => go(pathInput)}>Ga naar</button>
        <Refreshed at={at} busy={busy} onRefresh={() => void load()} />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-(--muted)">\</span>}
            <button className={clsx('hover:underline', i === crumbs.length - 1 ? 'text-(--text) font-medium' : 'text-(--accent)')} onClick={() => go(crumbs.slice(0, i + 1).join('\\'))}>{c}</button>
          </span>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-[18rem_1fr]">
        <div className="rounded-xl border border-(--border) bg-(--input) p-2 text-xs font-mono overflow-auto max-h-[65vh]">
          {ROOTS.map(([p, l]) => node(p, l, 0))}
        </div>
        <div className="space-y-2 min-w-0">
          <ErrorText err={err} />
          {busy && !data && <Pulse text="Sleutel laden…" />}
          <DataTable id="registry-values" cols={cols} rows={data ? data.values : []} rowKey={(v) => v.name || '(default)'}
            exportName="register" empty="Geen waarden in deze sleutel." initialSort={{ key: 'name', dir: 1 }}
            onRowClick={(v) => setEdit({ orig: v.name, name: v.name, kind: (KINDS as readonly string[]).includes(v.kind) ? v.kind as Kind : 'String', data: v.raw ?? v.data })}
            toolbar={<>
              <button className={ghost} onClick={() => setEdit({ orig: null, name: '', kind: 'String', data: '' })}>Waarde toevoegen</button>
              <button className={ghost} onClick={() => void addKey()}>Sleutel toevoegen</button>
              <button className={clsx(ghost, 'text-red-400')} disabled={!sel.includes('\\')} onClick={() => void deleteKey()}>Sleutel verwijderen</button>
            </>}
            actions={(v) => <RowMenu items={[
              { label: 'Bewerken', onClick: () => setEdit({ orig: v.name, name: v.name, kind: (KINDS as readonly string[]).includes(v.kind) ? v.kind as Kind : 'String', data: v.raw ?? v.data }) },
              { label: 'Verwijderen', danger: true, onClick: () => void deleteValue(v) },
            ]} />} />
          {data && data.subkeys.length > 0 && <p className="text-xs text-(--muted)">{data.subkeys.length} subsleutels; klik in de boom om ze te openen.</p>}
        </div>
      </div>
      {edit && (
        <Modal title={edit.orig == null ? 'Waarde toevoegen' : 'Waarde bewerken'} onClose={() => setEdit(null)}
          footer={<>
            <button className={ghost} onClick={() => setEdit(null)}>Annuleren</button>
            <button className={primary} disabled={saving} onClick={() => void save()}>{saving ? 'Opslaan…' : 'Opslaan'}</button>
          </>}>
          <p className="text-xs text-(--muted) font-mono break-all">{sel}</p>
          <Field label="Naam" hint="Leeg = (Standaard)">
            <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className={clsx(inputCls, 'w-full')} />
          </Field>
          <Field label="Type">
            <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as Kind })} className={clsx(inputCls, 'w-full')}>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </Field>
          <Field label="Gegevens" hint={edit.kind === 'DWord' || edit.kind === 'QWord' ? 'Decimaal of hex (0x1F)' : edit.kind === 'MultiString' ? 'Een waarde per regel' : edit.kind === 'Binary' ? 'Hex-bytes, bijvoorbeeld 01 af 3c' : undefined}>
            {edit.kind === 'MultiString' || edit.kind === 'Binary'
              ? <textarea rows={6} value={edit.data} onChange={(e) => setEdit({ ...edit, data: e.target.value })} className={clsx(inputCls, 'w-full font-mono text-xs')} spellCheck={false} />
              : <input value={edit.data} onChange={(e) => setEdit({ ...edit, data: e.target.value })} className={clsx(inputCls, 'w-full font-mono text-xs')} spellCheck={false} />}
          </Field>
        </Modal>
      )}
    </div>
  );
}

// ── Task manager ─────────────────────────────────────────────

interface Proc { pid: number; name: string; cpu: number; ws: number; priv: number | null; user: string | null; path: string | null; threads: number | null }

const PROCS_WIN = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
if (-not $cores) { $cores = 1 }
$perf = @{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | ForEach-Object { $perf[[int]$_.IDProcess] = [double]$_.PercentProcessorTime }
ConvertTo-Json -Compress -InputObject @(Get-Process -IncludeUserName | Where-Object { $_.Id -ne 0 } | ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName; cpu = [math]::Round([double]$perf[[int]$_.Id] / $cores, 1); ws = [int64]$_.WorkingSet64; priv = [int64]$_.PrivateMemorySize64; user = $_.UserName; path = $_.Path; threads = $_.Threads.Count } })`;
const PROCS_MAC = 'ps -Ao pid=,pcpu=,rss=,user=,comm=';

function TaskManager({ d, openFolder }: { d: Device; openFolder: (p: string) => void }) {
  const isWin = d.os === 'windows';
  const [auto, setAuto] = useState(false);
  const { data, err, busy, load, at } = useLoad(async (): Promise<Proc[]> => {
    if (isWin) return arr(await readJson<Proc[]>(d, PROCS_WIN, 'view:processes', 60));
    const r = await execOn(d.id, PROCS_MAC, { tool: 'view:processes', timeout: 60, shell: 'zsh' });
    if (!r.ok && !r.output) throw new Error(r.error || 'Mislukt');
    return r.output.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 5).map((p) => {
      const path = p.slice(4).join(' ');
      return { pid: Number(p[0]), cpu: Number(p[1]), ws: Number(p[2]) * 1024, priv: null, user: p[3], path, name: path.split('/').pop() ?? path, threads: null };
    });
  }, [d.id]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [auto, load]);

  async function kill(p: Proc, tree: boolean) {
    if (!confirm(`${tree ? 'Procesboom van' : 'Proces'} ${p.name} (${p.pid}) geforceerd beëindigen?`)) return;
    const cmd = isWin
      ? (tree ? `taskkill.exe /PID ${p.pid} /T /F; exit $LASTEXITCODE` : `Stop-Process -Id ${p.pid} -Force -ErrorAction Stop; "Proces ${p.pid} beëindigd"`)
      : (tree ? `pkill -9 -P ${p.pid}; kill -9 ${p.pid} && echo "Proces ${p.pid} beëindigd"` : `kill -9 ${p.pid} && echo "Proces ${p.pid} beëindigd"`);
    if (await mutate(d, tree ? 'kill-tree' : 'kill', cmd)) void load();
  }

  const cols: Col<Proc>[] = [
    { key: 'pid', label: 'PID', value: (p) => p.pid, align: 'right', width: '4.5rem' },
    { key: 'name', label: 'Naam', value: (p) => p.name, width: 'minmax(10rem,1.2fr)', render: (p) => <span className="text-(--text)">{p.name}</span> },
    { key: 'cpu', label: 'CPU %', value: (p) => p.cpu, align: 'right', width: '5rem' },
    { key: 'ws', label: 'Werkset', value: (p) => p.ws, align: 'right', width: '6rem', render: (p) => fmtBytes(p.ws) },
    { key: 'priv', label: 'Privé geheugen', value: (p) => p.priv, align: 'right', width: '7rem', render: (p) => fmtBytes(p.priv), hidden: !isWin },
    { key: 'user', label: 'Gebruikersnaam', value: (p) => p.user, width: 'minmax(8rem,0.8fr)' },
    { key: 'threads', label: 'Threads', value: (p) => p.threads, align: 'right', width: '5rem', hidden: !isWin },
    { key: 'path', label: 'Pad', value: (p) => p.path, width: 'minmax(12rem,1.5fr)', render: (p) => <span className="text-(--muted)">{p.path}</span> },
  ];

  return (
    <div className="space-y-2">
      <ErrorText err={err} />
      <DataTable id={`processes-${isWin ? 'win' : 'mac'}`} cols={cols} rows={data ?? []} rowKey={(p) => String(p.pid)} exportName="processen"
        initialSort={{ key: 'cpu', dir: -1 }} empty={busy ? 'Laden…' : 'Geen processen.'}
        toolbar={<>
          <label className="flex items-center gap-1.5 text-xs text-(--muted)"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Elke 10 s vernieuwen</label>
          <Refreshed at={at} busy={busy} onRefresh={() => void load()} />
        </>}
        actions={(p) => <RowMenu items={[
          { label: 'Beëindigen', danger: true, onClick: () => void kill(p, false) },
          { label: 'Procesboom beëindigen', danger: true, onClick: () => void kill(p, true) },
          { label: 'Map openen in Bestandsbrowser', disabled: !p.path, onClick: () => { if (!p.path) return; const dir = p.path.replace(isWin ? /\\[^\\]*$/ : /\/[^/]*$/, ''); openFolder(isWin && /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir || '/'); } },
        ]} />} />
    </div>
  );
}

// ── File browser ─────────────────────────────────────────────

interface FileRow { name: string; full?: string; dir: boolean; size: number | null; mtime: string | number | null; attr?: string }
interface Drive { name: string; used?: number | null; free?: number | null; label?: string | null }

const DRIVES_WIN = String.raw`ConvertTo-Json -Compress -InputObject @(Get-PSDrive -PSProvider FileSystem | ForEach-Object { @{ name = $_.Root; used = [int64]$_.Used; free = [int64]$_.Free; label = $_.Description } })`;
const listWin = (p: string) => String.raw`$ErrorActionPreference = 'Stop'
$items = @(Get-ChildItem -LiteralPath ${psq(p)} -Force -ErrorAction Stop | Select-Object -First 2000)
ConvertTo-Json -Compress -InputObject @($items | ForEach-Object { @{ name = $_.Name; dir = $_.PSIsContainer; size = $(if ($_.PSIsContainer) { $null } else { [int64]$_.Length }); mtime = $_.LastWriteTime.ToUniversalTime().ToString('o'); attr = "$($_.Attributes)" } })`;
const searchWin = (p: string, term: string) => String.raw`$items = @(Get-ChildItem -LiteralPath ${psq(p)} -Recurse -Force -Filter ${psq(`*${term}*`)} -ErrorAction SilentlyContinue | Select-Object -First 200)
ConvertTo-Json -Compress -InputObject @($items | ForEach-Object { @{ name = $_.Name; full = $_.FullName; dir = $_.PSIsContainer; size = $(if ($_.PSIsContainer) { $null } else { [int64]$_.Length }); mtime = $_.LastWriteTime.ToUniversalTime().ToString('o'); attr = "$($_.Attributes)" } })`;
const MAC_EMIT = String.raw`n=0; printf '['
emit() {
  e=$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')
  s=$(stat -f '%z %m' -- "$1" 2>/dev/null); sz=$(echo $s | cut -d' ' -f1); mt=$(echo $s | cut -d' ' -f2)
  [ -z "$sz" ] && sz=0; [ -z "$mt" ] && mt=0
  if [ -d "$1" ]; then dr=true; else dr=false; fi
  [ $n -gt 0 ] && printf ','
  n=$((n+1))
  printf '{"name":"%s","full":"%s","dir":%s,"size":%s,"mtime":%s}' "$e" "$e" "$dr" "$sz" "$mt"
}
`;
const listMac = (p: string) => String.raw`cd -- ${shq(p)} || exit 1
${MAC_EMIT}for f in *(ND[1,2000]); do emit "$f" "$f"; done
printf ']'`;
const searchMac = (p: string, term: string) => String.raw`${MAC_EMIT}find ${shq(p)} -maxdepth 8 -iname ${shq(`*${term}*`)} 2>/dev/null | head -200 | while IFS= read -r f; do emit "$f" "$f"; done
printf ']'`;

const MAX_DOWNLOAD = 10 * 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;

function FileBrowser({ d, path, setPath }: { d: Device; path: string; setPath: (p: string) => void }) {
  const isWin = d.os === 'windows';
  const sep = isWin ? '\\' : '/';
  const [pathInput, setPathInput] = useState(path);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState<string | null>(null); // active search term
  const [busyMsg, setBusyMsg] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => { setPathInput(path); setSel(new Set()); setSearching(null); }, [path]);

  const join = useCallback((dir: string, name: string) => (dir.endsWith(sep) ? dir + name : dir + sep + name), [sep]);
  const fullOf = useCallback((r: FileRow) => r.full ?? join(path, r.name), [join, path]);

  const drives = useLoad(async (): Promise<Drive[]> => {
    if (!isWin) return [{ name: '/' }, { name: '/Users' }, { name: '/Applications' }, { name: '/Volumes' }];
    return arr(await readJson<Drive[]>(d, DRIVES_WIN, 'view:files', 60));
  }, [d.id], { enabled: path === '' });

  const list = useLoad(async (): Promise<FileRow[]> => {
    if (!path) return [];
    if (searching) return arr(await readJson<FileRow[]>(d, isWin ? searchWin(path, searching) : searchMac(path, searching), 'view:files-search', 300));
    return arr(await readJson<FileRow[]>(d, isWin ? listWin(path) : listMac(path), 'view:files', 90));
  }, [d.id, path, searching], { enabled: path !== '' });

  function up() {
    if (!path) return;
    if (isWin) {
      if (/^[A-Za-z]:\\?$/.test(path)) { setPath(''); return; }
      const p = path.replace(/\\+$/, '');
      const parent = p.slice(0, p.lastIndexOf('\\'));
      setPath(/^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent || '');
    } else {
      if (path === '/') { setPath(''); return; }
      const p = path.replace(/\/+$/, '');
      setPath(p.slice(0, p.lastIndexOf('/')) || '/');
    }
  }
  function goInput() {
    let p = pathInput.trim();
    if (isWin && /^[A-Za-z]:$/.test(p)) p += '\\';
    setPath(p);
  }

  const rows = list.data ?? [];
  const selected = rows.filter((r) => sel.has(fullOf(r)));

  async function download(r: FileRow) {
    if (r.dir) return;
    if ((r.size ?? 0) > MAX_DOWNLOAD) { alert(`${r.name} is ${fmtBytes(r.size)}; downloaden kan tot 10 MB.`); return; }
    setBusyMsg(`${r.name} downloaden…`);
    try {
      const res = await fetch(`/api/devices/${d.id}/file?path=${encodeURIComponent(fullOf(r))}`, { credentials: 'include', headers: scopeHeaders() });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { alert((e as Error).message); }
    setBusyMsg('');
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !path) return;
    const list2 = [...files];
    const big = list2.find((f) => f.size > MAX_UPLOAD);
    if (big) { alert(`${big.name} is ${fmtBytes(big.size)}; uploaden kan tot 20 MB.`); return; }
    const existing = new Set(rows.map((r) => r.name.toLowerCase()));
    const clash = list2.filter((f) => existing.has(f.name.toLowerCase()));
    if (!confirm(`${list2.length} bestand(en) uploaden naar ${path}?${clash.length ? `\nOverschrijft: ${clash.map((f) => f.name).join(', ')}` : ''}`)) return;
    for (const f of list2) {
      setBusyMsg(`${f.name} uploaden…`);
      try {
        const res = await fetch(`/api/devices/${d.id}/file?path=${encodeURIComponent(join(path, f.name))}`, {
          method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream', ...scopeHeaders() }, body: f,
        });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      } catch (e) { alert(`${f.name}: ${(e as Error).message}`); break; }
    }
    setBusyMsg('');
    if (upload.current) upload.current.value = '';
    void list.load();
  }

  async function newFolder() {
    const name = prompt(`Nieuwe map in ${path}`)?.trim();
    if (!name) return;
    const full = join(path, name);
    const cmd = isWin ? `New-Item -ItemType Directory -Path ${psq(full)} -ErrorAction Stop | Out-Null; 'Map gemaakt'` : `mkdir -- ${shq(full)} && echo "Map gemaakt"`;
    if (await mutate(d, 'file-mkdir', cmd)) void list.load();
  }
  async function rename(r: FileRow) {
    const name = prompt('Nieuwe naam', r.name)?.trim();
    if (!name || name === r.name) return;
    if (!confirm(`${r.name} hernoemen naar ${name}?`)) return;
    const full = fullOf(r);
    const cmd = isWin
      ? `Rename-Item -LiteralPath ${psq(full)} -NewName ${psq(name)} -ErrorAction Stop; 'Hernoemd'`
      : `mv -- ${shq(full)} ${shq(full.slice(0, full.lastIndexOf('/') + 1) + name)} && echo "Hernoemd"`;
    if (await mutate(d, 'file-rename', cmd)) void list.load();
  }
  async function remove(items: FileRow[]) {
    if (!items.length) return;
    const names = items.map((r) => r.name);
    if (!confirm(`${items.length === 1 ? names[0] : `${items.length} items`} definitief verwijderen${items.some((r) => r.dir) ? ' (mappen met alle inhoud)' : ''}?\n${names.slice(0, 15).join('\n')}${names.length > 15 ? '\n…' : ''}`)) return;
    const paths = items.map(fullOf);
    const cmd = isWin
      ? `Remove-Item -LiteralPath @(${paths.map(psq).join(', ')}) -Recurse -Force -ErrorAction Stop; '${items.length} verwijderd'`
      : `rm -rf -- ${paths.map(shq).join(' ')} && echo "${items.length} verwijderd"`;
    if (await mutate(d, 'file-delete', cmd, 300)) { setSel(new Set()); void list.load(); }
  }

  const toggleSel = (r: FileRow) => setSel((s) => { const n = new Set(s); const k = fullOf(r); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allSel = rows.length > 0 && rows.every((r) => sel.has(fullOf(r)));
  const typeOf = (r: FileRow) => {
    if (r.dir) return 'Map';
    const i = r.name.lastIndexOf('.');
    return i > 0 ? `${r.name.slice(i + 1).toUpperCase()}-bestand` : 'Bestand';
  };
  const mtimeIso = (r: FileRow) => (r.mtime == null ? null : typeof r.mtime === 'number' ? new Date(r.mtime * 1000).toISOString() : r.mtime);

  const cols: Col<FileRow>[] = [
    { key: 'sel', label: 'Selectie', value: () => '', width: '2rem', render: (r) => (
      <input type="checkbox" checked={sel.has(fullOf(r))} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(r)} />
    ) },
    { key: 'name', label: 'Naam', value: (r) => (searching ? r.full ?? r.name : r.name), width: 'minmax(14rem,2fr)', render: (r) => (
      <span className="inline-flex items-center gap-2 min-w-0">
        {r.dir
          ? <svg className="w-4 h-4 shrink-0 text-yellow-500" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
          : <svg className="w-4 h-4 shrink-0 text-(--muted)" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" /><path d="M14 3v6h6" /></svg>}
        <span className={clsx('truncate', r.dir ? 'text-(--text) font-medium' : 'text-(--text)', /Hidden|System/.test(r.attr ?? '') && 'opacity-60')}>{searching ? r.full ?? r.name : r.name}</span>
      </span>
    ) },
    { key: 'mtime', label: 'Laatst bijgewerkt', value: (r) => mtimeIso(r), width: '11rem', render: (r) => relTime(mtimeIso(r)) },
    { key: 'size', label: 'Grootte', value: (r) => (r.dir ? null : r.size), align: 'right', width: '6rem', render: (r) => (r.dir ? '' : fmtBytes(r.size)) },
    { key: 'type', label: 'Type', value: (r) => typeOf(r), width: '8rem' },
    { key: 'attr', label: 'Kenmerken', value: (r) => r.attr ?? '', width: '9rem', hidden: true },
  ];

  const crumbs = useMemo(() => {
    if (!path) return [] as Array<[string, string]>;
    if (isWin) {
      const parts = path.replace(/\\+$/, '').split('\\');
      return parts.map((p, i) => [i === 0 ? `${p}\\` : p, i === 0 ? `${p}\\` : parts.slice(0, i + 1).join('\\')] as [string, string]);
    }
    const parts = path.split('/').filter(Boolean);
    return [['/', '/'] as [string, string], ...parts.map((p, i) => [p, `/${parts.slice(0, i + 1).join('/')}`] as [string, string])];
  }, [path, isWin]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className={ghost} disabled={!path} onClick={up} title="Omhoog">Omhoog</button>
        <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') goInput(); }}
          className={clsx(inputCls, 'flex-1 min-w-64 font-mono text-xs')} placeholder={isWin ? 'C:\\Users' : '/Users'} spellCheck={false} />
        <button className={ghost} onClick={goInput}>Ga naar</button>
        <Refreshed at={path ? list.at : drives.at} busy={path ? list.busy : drives.busy} onRefresh={() => void (path ? list.load() : drives.load())} />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button className={clsx('hover:underline', path ? 'text-(--accent)' : 'text-(--text) font-medium')} onClick={() => setPath('')}>{isWin ? 'Stations' : 'Locaties'}</button>
        {crumbs.map(([label, p], i) => (
          <span key={p} className="flex items-center gap-1">
            <span className="text-(--muted)">{i === 0 ? '›' : sep}</span>
            <button className={clsx('hover:underline', i === crumbs.length - 1 ? 'text-(--text) font-medium' : 'text-(--accent)')} onClick={() => setPath(p)}>{label}</button>
          </span>
        ))}
        {searching && <span className="ml-2 text-(--muted)">zoekresultaten voor &quot;{searching}&quot; <button className="text-(--accent) hover:underline" onClick={() => setSearching(null)}>wissen</button></span>}
      </div>
      {busyMsg && <Pulse text={busyMsg} />}

      {!path ? (
        <div className="space-y-2">
          <ErrorText err={drives.err} />
          {drives.busy && !drives.data && <Pulse text="Stations laden…" />}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {(drives.data ?? []).map((dr) => {
              const total = (dr.used ?? 0) + (dr.free ?? 0);
              const pct = total ? Math.round(((dr.used ?? 0) / total) * 100) : 0;
              return (
                <button key={dr.name} onClick={() => setPath(dr.name)} className="text-left rounded-xl border border-(--border) bg-(--input) px-4 py-3 hover:border-(--accent)/60 space-y-1.5">
                  <div className="text-sm font-medium text-(--text)">{dr.name}{dr.label && dr.label !== dr.name ? <span className="text-(--muted) font-normal"> {dr.label}</span> : null}</div>
                  {total > 0 && <>
                    <div className="h-1.5 rounded-full bg-(--border) overflow-hidden"><div className={clsx('h-full rounded-full', pct > 90 ? 'bg-red-400' : pct > 75 ? 'bg-yellow-500' : 'bg-indigo-500')} style={{ width: `${pct}%` }} /></div>
                    <div className="text-xs text-(--muted)">{fmtBytes(dr.free)} vrij van {fmtBytes(total)}</div>
                  </>}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <ErrorText err={list.err} />
          <DataTable id={`files-${isWin ? 'win' : 'mac'}`} cols={cols} rows={rows} rowKey={fullOf} exportName="bestanden" pageSize={100}
            initialSort={{ key: 'type', dir: 1 }} empty={list.busy ? 'Laden…' : searching ? 'Niets gevonden.' : 'Lege map.'}
            onRowClick={(r) => { if (r.dir) setPath(fullOf(r)); }}
            toolbar={<>
              <button className={ghost} disabled={!rows.length} onClick={() => setSel(allSel ? new Set() : new Set(rows.map(fullOf)))}>{allSel ? 'Niets selecteren' : 'Alles selecteren'}</button>
              {selected.length > 0 && <button className={clsx(ghost, 'text-red-400')} onClick={() => void remove(selected)}>Verwijderen ({selected.length})</button>}
              {selected.length === 1 && !selected[0].dir && <button className={ghost} onClick={() => void download(selected[0])}>Downloaden</button>}
              <button className={ghost} disabled={!!searching} onClick={() => upload.current?.click()}>Uploaden</button>
              <input ref={upload} type="file" multiple className="hidden" onChange={(e) => void uploadFiles(e.target.files)} />
              <button className={ghost} disabled={!!searching} onClick={() => void newFolder()}>Nieuwe map</button>
              <span className="flex items-center gap-1">
                <input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && term.trim()) setSearching(term.trim()); }}
                  placeholder="Zoeken in submappen" className={clsx(inputCls, 'w-44')} />
                <button className={ghost} disabled={!term.trim()} onClick={() => setSearching(term.trim())}>Zoek</button>
              </span>
            </>}
            actions={(r) => <RowMenu items={[
              ...(r.dir ? [{ label: 'Openen', onClick: () => setPath(fullOf(r)) }] : [{ label: 'Downloaden', detail: 'Tot 10 MB', onClick: () => void download(r) }]),
              ...(searching ? [{ label: 'Map openen', onClick: () => setPath(fullOf(r).slice(0, fullOf(r).lastIndexOf(sep)) || sep) }] : []),
              { label: 'Hernoemen', onClick: () => void rename(r) },
              { label: 'Verwijderen', danger: true, onClick: () => void remove([r]) },
            ] as MenuItem[]} />} />
        </>
      )}
    </div>
  );
}

// ── Service manager ──────────────────────────────────────────

interface Svc { name: string; display: string; status: string; start: string; logon?: string | null; desc?: string | null; pid?: string }

const SVCS_WIN = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$cim = @{}; Get-CimInstance Win32_Service | ForEach-Object { $cim[$_.Name] = $_ }
ConvertTo-Json -Compress -InputObject @(Get-Service | ForEach-Object { $c = $cim[$_.Name]; $st = "$($_.StartType)"; if ($c -and $c.DelayedAutoStart -and $st -eq 'Automatic') { $st = 'AutomaticDelayed' }; @{ name = $_.Name; display = $_.DisplayName; status = "$($_.Status)"; start = $st; logon = $c.StartName; desc = $c.Description } })`;
const START_LABEL: Record<string, string> = { Automatic: 'Automatisch', AutomaticDelayed: 'Automatisch (vertraagd)', Manual: 'Handmatig', Disabled: 'Uitgeschakeld', Boot: 'Boot', System: 'Systeem' };
const START_SC: Array<[string, string]> = [['Automatic', 'auto'], ['AutomaticDelayed', 'delayed-auto'], ['Manual', 'demand'], ['Disabled', 'disabled']];
const STATUS_LABEL: Record<string, string> = { Running: 'Actief', Stopped: 'Gestopt', StartPending: 'Starten…', StopPending: 'Stoppen…', Paused: 'Gepauzeerd' };

function ServiceManager({ d }: { d: Device }) {
  const isWin = d.os === 'windows';
  const [only, setOnly] = useState<'all' | 'Running' | 'Stopped'>('all');
  const [rowBusy, setRowBusy] = useState('');
  const { data, err, busy, load, at } = useLoad(async (): Promise<Svc[]> => {
    if (isWin) return arr(await readJson<Svc[]>(d, SVCS_WIN, 'view:services', 90));
    const r = await execOn(d.id, 'launchctl list', { tool: 'view:services', timeout: 60, shell: 'zsh' });
    if (!r.ok && !r.output) throw new Error(r.error || 'Mislukt');
    return r.output.split('\n').slice(1).map((l) => l.split('\t')).filter((p) => p.length >= 3)
      .map((p) => ({ name: p[2], display: p[2], status: p[0] !== '-' ? 'Running' : 'Stopped', start: '', pid: p[0], desc: p[1] !== '0' && p[1] !== '-' ? `laatste exit ${p[1]}` : '' }));
  }, [d.id]);

  async function act(s: Svc, action: 'start' | 'stop' | 'restart') {
    const verb = action === 'start' ? 'starten' : action === 'stop' ? 'stoppen' : 'herstarten';
    if (!confirm(`Service ${s.display} ${verb}?`)) return;
    setRowBusy(s.name);
    const n = psq(s.name);
    const cmd = isWin
      ? (action === 'start' ? `Start-Service -Name ${n} -ErrorAction Stop` : action === 'stop' ? `Stop-Service -Name ${n} -Force -ErrorAction Stop` : `Restart-Service -Name ${n} -Force -ErrorAction Stop`) + `; (Get-Service -Name ${n}).Status`
      : action === 'start' ? `launchctl start ${shq(s.name)} && echo gestart` : action === 'stop' ? `launchctl stop ${shq(s.name)} && echo gestopt` : `launchctl kickstart -k ${shq(`system/${s.name}`)} && echo herstart`;
    if (await mutate(d, `service-${action}`, cmd)) await load();
    setRowBusy('');
  }
  async function startType(s: Svc, type: string, sc: string) {
    if (!confirm(`Opstarttype van ${s.display} wijzigen naar ${START_LABEL[type]}?`)) return;
    setRowBusy(s.name);
    if (await mutate(d, 'service-starttype', `sc.exe config ${psq(s.name)} start= ${sc}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`)) await load();
    setRowBusy('');
  }

  const rows = (data ?? []).filter((s) => only === 'all' || s.status === only);
  const cols: Col<Svc>[] = [
    { key: 'display', label: 'Naam', value: (s) => `${s.display} ${s.display !== s.name ? s.name : ''}`.trim(), width: 'minmax(14rem,1.5fr)', render: (s) => (
      <span className="block min-w-0"><span className="block truncate text-(--text)">{s.display}</span>{s.display !== s.name && <span className="block truncate text-[11px] text-(--muted)">{s.name}</span>}</span>
    ) },
    { key: 'status', label: 'Status', value: (s) => STATUS_LABEL[s.status] ?? s.status, width: '7rem', render: (s) => (
      rowBusy === s.name ? <Pulse /> : <Badge tone={s.status === 'Running' ? 'ok' : s.status === 'Stopped' ? 'muted' : 'warn'}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
    ) },
    ...(isWin ? [
      { key: 'start', label: 'Opstarttype', value: (s: Svc) => START_LABEL[s.start] ?? s.start, width: '10rem' },
      { key: 'logon', label: 'Inloggen als', value: (s: Svc) => s.logon ?? '', width: 'minmax(8rem,0.8fr)' },
    ] : [{ key: 'pid', label: 'PID', value: (s: Svc) => s.pid ?? '', width: '5rem' }]),
    { key: 'desc', label: 'Beschrijving', value: (s) => s.desc ?? '', width: 'minmax(12rem,2fr)', render: (s) => <span className="text-(--muted)">{s.desc}</span> },
  ];

  return (
    <div className="space-y-2">
      <ErrorText err={err} />
      <DataTable id={`services-${isWin ? 'win' : 'mac'}`} cols={cols} rows={rows} rowKey={(s) => s.name} exportName="services"
        initialSort={{ key: 'display', dir: 1 }} empty={busy ? 'Laden…' : 'Geen services.'}
        toolbar={<>
          <Chips items={[['all', 'Alle'], ['Running', 'Actief'], ['Stopped', 'Gestopt']]} value={only} onChange={setOnly} />
          <Refreshed at={at} busy={busy} onRefresh={() => void load()} />
        </>}
        actions={(s) => <RowMenu items={[
          { label: 'Starten', disabled: s.status === 'Running' || rowBusy === s.name, onClick: () => void act(s, 'start') },
          { label: 'Stoppen', danger: true, disabled: s.status !== 'Running' || rowBusy === s.name, onClick: () => void act(s, 'stop') },
          { label: 'Herstarten', disabled: s.status !== 'Running' || rowBusy === s.name, onClick: () => void act(s, 'restart') },
          ...(isWin ? [{ label: 'Opstarttype wijzigen', items: START_SC.map(([type, sc]) => ({ label: START_LABEL[type], disabled: s.start === type, onClick: () => void startType(s, type, sc) })) }] : []),
        ]} />} />
    </div>
  );
}

// ── Tab ──────────────────────────────────────────────────────

export default function Tools({ d }: { d: Device }) {
  const isWin = d.os === 'windows';
  const [tab, setTab] = useState<ToolTab>(isWin ? 'registry' : 'processes');
  const [filesPath, setFilesPath] = useState('');
  // sub tools stay mounted once opened, so switching keeps the current folder or key
  const [visited, setVisited] = useState<Set<ToolTab>>(new Set([tab]));
  useEffect(() => { setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))); }, [tab]);

  const items: Array<[ToolTab, string]> = [
    ...(isWin ? [['registry', 'Extern register'] as [ToolTab, string]] : []),
    ['processes', 'Taakbeheer'], ['files', 'Bestandsbrowser'], ['services', 'Servicemanager'],
  ];
  const openFolder = (p: string) => { setFilesPath(p); setTab('files'); };

  if (!d.online) return <p className="text-sm text-(--muted)">{d.name} is offline; de tools werken zodra het apparaat online is.</p>;
  return (
    <div className="flex flex-col md:flex-row gap-4">
      <SubNav items={items} value={tab} onChange={setTab} />
      <div className="flex-1 min-w-0">
        {visited.has('registry') && isWin && <div className={tab === 'registry' ? '' : 'hidden'}><Registry d={d} /></div>}
        {visited.has('processes') && <div className={tab === 'processes' ? '' : 'hidden'}><TaskManager d={d} openFolder={openFolder} /></div>}
        {visited.has('files') && <div className={tab === 'files' ? '' : 'hidden'}><FileBrowser d={d} path={filesPath} setPath={setFilesPath} /></div>}
        {visited.has('services') && <div className={tab === 'services' ? '' : 'hidden'}><ServiceManager d={d} /></div>}
      </div>
    </div>
  );
}
