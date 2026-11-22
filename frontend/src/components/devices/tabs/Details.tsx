'use client';

/**
 * Details tab (NinjaOne-style): processor, memory, volumes, network, open ports, hardware, services, event log.
 * Every section loads lazily on first open, via one script on the device that prints JSON (Windows) or text (Mac).
 */
import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { api, Badge, Device, execOn, ExecResult, ghost, parseJson, UsageBar } from '../shared';
import { Card, Chips, Col, DataTable, ErrorText, fmtBytes, fmtRate, KV, OutputBox, Pulse, psq, Refreshed, relTime, RowMenu, shq, Sparkline, SubNav, useLoad } from '../ui';

type Section = 'cpu' | 'mem' | 'vol' | 'net' | 'ports' | 'hw' | 'svc' | 'events';

// ── Helpers ──────────────────────────────────────────────────

/** ConvertTo-Json turns a one-element array into an object: always give an array back. */
function arr<T>(v: T | T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

async function runJson<T>(d: Device, script: string, tool: string, timeout = 90): Promise<T> {
  const r = await execOn(d.id, script, { tool, timeout });
  const v = parseJson<T>(r.output);
  if (v == null) throw new Error(r.error || r.output.slice(0, 400) || 'Geen gegevens ontvangen');
  return v;
}

async function runText(d: Device, script: string, tool: string, timeout = 90): Promise<string> {
  const r = await execOn(d.id, script, { tool, timeout });
  if (!r.ok && !r.output) throw new Error(r.error || 'Mislukt');
  return r.output;
}

const gb = (b: number | null | undefined) => (b == null || Number.isNaN(b) ? '' : `${(b / 1073741824).toFixed(1)} GB`);
const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);
const yesNo = (v: boolean | null | undefined) => (v == null ? '' : v ? 'Ja' : 'Nee');
const ARCH: Record<number, string> = { 0: 'x86', 5: 'ARM', 6: 'Itanium', 9: 'x64', 12: 'ARM64' };

interface HistItem {
  t: number; cpu: number; memPct: number; memUsedGB: number; memTotalGB: number;
  disks: Array<{ drive: string; pct: number; usedGB: number; sizeGB: number }>;
  net: Array<{ name: string; rx: number; tx: number; ipv4?: string }>; diskBusy?: number;
}

/** Live samples from the server (one hour kept there), every 20 s while the section is open. */
function useMetrics(d: Device, active: boolean): HistItem[] {
  const [h, setH] = useState<HistItem[]>([]);
  useEffect(() => {
    if (!active || !d.online) return;
    let stop = false;
    const tick = async () => {
      try { const r = await api<{ online: boolean; history: HistItem[] }>(`/${d.id}/metrics`); if (!stop) setH(r.history); } catch { /* keep last */ }
    };
    void tick();
    const t = setInterval(tick, 20_000);
    return () => { stop = true; clearInterval(t); };
  }, [d.id, d.online, active]);
  return h;
}

function Chart({ label, values, values2, max, right }: { label: string; values: number[]; values2?: number[]; max?: number; right?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-(--muted)"><span className="flex-1">{label} · Afgelopen uur</span>{right}</div>
      <Sparkline values={values} values2={values2} max={max} height={80} className="rounded-lg border border-(--border) bg-(--bg)" />
    </div>
  );
}

async function killProc(d: Device, pid: number, name: string, reload: () => void) {
  if (!confirm(`${name} (${pid}) beëindigen op ${d.name}?`)) return;
  const cmd = d.os === 'windows' ? `Stop-Process -Id ${pid} -Force -ErrorAction Stop; "Proces ${pid} beëindigd"` : `kill -9 ${pid} && echo "Proces ${pid} beëindigd"`;
  const r: ExecResult = await execOn(d.id, cmd, { tool: 'kill' }).catch((e: Error) => ({ ok: false, output: '', error: e.message }));
  if (!r.ok) alert(r.error || r.output);
  reload();
}

/** Header line of a section: title + refreshed + button. */
function Head({ title, at, busy, load, children }: { title: string; at: number | null; busy: boolean; load: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-base font-semibold text-(--text) flex-1 min-w-0">{title}</h3>
      {children}
      <Refreshed at={at} busy={busy} onRefresh={load} />
    </div>
  );
}

/** "key=value" lines (Mac scripts). */
function kvLines(out: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const l of out.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return o;
}

// ── Processor ────────────────────────────────────────────────

const WIN_CPU = `$ErrorActionPreference = 'SilentlyContinue'
$p = @(Get-CimInstance Win32_Processor)
$c = $p[0]
$logical = ($p | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
$procs = @(Get-Process)
$l1 = (Get-CimInstance Win32_CacheMemory | Where-Object { $_.Level -eq 3 } | Measure-Object -Property InstalledSize -Sum).Sum
$perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 10)
$top = @($perf | ForEach-Object { @{ pid = [int]$_.IDProcess; name = $_.Name; threads = [int]$_.ThreadCount; cpu = [math]::Round($_.PercentProcessorTime / [math]::Max(1, $logical), 1) } })
ConvertTo-Json -Compress -Depth 4 -InputObject @{
  name = ("" + $c.Name).Trim(); load = [math]::Round(($p | Measure-Object -Property LoadPercentage -Average).Average)
  speed = [int]$c.CurrentClockSpeed; maxSpeed = [int]$c.MaxClockSpeed; sockets = $p.Count
  cores = ($p | Measure-Object -Property NumberOfCores -Sum).Sum; logical = $logical
  l1 = $l1; l2 = [int]$c.L2CacheSize; l3 = [int]$c.L3CacheSize; arch = [int]$c.Architecture
  virt = $c.VirtualizationFirmwareEnabled; socket = $c.SocketDesignation; maker = $c.Manufacturer
  processes = $procs.Count; threads = ($procs | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum
  handles = ($procs | Measure-Object -Property Handles -Sum).Sum; top = $top
}`;
const MAC_CPU = `echo "name=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
echo "cores=$(sysctl -n hw.physicalcpu)"; echo "logical=$(sysctl -n hw.logicalcpu)"
echo "maxSpeed=$(sysctl -n hw.cpufrequency_max 2>/dev/null)"; echo "l2=$(sysctl -n hw.l2cachesize 2>/dev/null)"; echo "l3=$(sysctl -n hw.l3cachesize 2>/dev/null)"
echo "arch=$(uname -m)"; echo "processes=$(ps -A | tail -n +2 | wc -l | tr -d ' ')"; echo "threads=$(ps -M -A | tail -n +2 | wc -l | tr -d ' ')"
echo "load=$(sysctl -n vm.loadavg)"
echo ---TOP---
ps -Ao pid=,pcpu=,comm= -r | head -10`;

interface CpuInfo {
  name: string; load: number; speed: number; maxSpeed: number; sockets: number; cores: number; logical: number;
  l1?: number; l2: number; l3: number; arch: number; virt?: boolean | null; socket?: string; maker?: string;
  processes: number; threads: number; handles: number; top: Array<{ pid: number; name: string; threads: number; cpu: number }> | { pid: number; name: string; threads: number; cpu: number };
}
interface TopRow { pid: number; name: string; threads?: number; cpu: number }

function Processor({ d, active }: { d: Device; active: boolean }) {
  const isWin = d.os === 'windows';
  const hist = useMetrics(d, active);
  const { data, err, busy, load, at } = useLoad(async () => {
    if (isWin) {
      const c = await runJson<CpuInfo>(d, WIN_CPU, 'view:details-cpu');
      return { c, top: arr(c.top) as TopRow[], kv: null as Record<string, string> | null };
    }
    const out = await runText(d, MAC_CPU, 'view:details-cpu');
    const [a, b = ''] = out.split('---TOP---');
    const top: TopRow[] = b.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
      .map((p) => ({ pid: Number(p[0]), cpu: Number(p[1]), name: p.slice(2).join(' ').split('/').pop() ?? '' }));
    return { c: null as CpuInfo | null, top, kv: kvLines(a) };
  }, [d.id]);
  const c = data?.c;
  const kv = data?.kv;
  const cols: Col<TopRow>[] = [
    { key: 'pid', label: 'PID', value: (r) => r.pid, width: '5rem' },
    { key: 'name', label: 'Proces', value: (r) => r.name, width: 'minmax(10rem,2fr)' },
    ...(isWin ? [{ key: 'threads', label: 'Threads', value: (r: TopRow) => r.threads ?? null, align: 'right' as const, width: '5rem' }] : []),
    { key: 'cpu', label: 'CPU', value: (r) => r.cpu, render: (r) => `${r.cpu}%`, align: 'right', width: '5rem' },
  ];
  const mhz = (v?: number | string) => (v ? (Number(v) > 100000 ? `${(Number(v) / 1e9).toFixed(2)} GHz` : `${(Number(v) / 1000).toFixed(2)} GHz`) : '');
  const kb = (v?: number | string) => (v ? (Number(v) > 65536 ? fmtBytes(Number(v)) : `${v} KB`) : '');
  const last = hist.at(-1);
  return (
    <div className="space-y-4">
      <Head title={c?.name || kv?.name || 'Processor'} at={at} busy={busy} load={() => void load()} />
      <ErrorText err={err} />
      <Card>
        <Chart label="Gebruik" values={hist.map((h) => h.cpu)} max={100} right={last ? <span className="text-(--text) tabular-nums">{last.cpu}%</span> : null} />
        {c && (
          <KV cols={2} rows={[
            ['Gebruik', `${c.load}%`], ['Snelheid', mhz(c.speed)], ['Max. snelheid', mhz(c.maxSpeed)], ['Processen', c.processes],
            ['Threads', c.threads], ['Handles', c.handles], ['Sockets', c.sockets], ['Fysieke kernen', c.cores], ['Logische processors', c.logical],
            ['L1-cache', kb(c.l1)], ['L2-cache', kb(c.l2)], ['L3-cache', kb(c.l3)], ['Architectuur', ARCH[c.arch] ?? String(c.arch)],
            ['Virtualisatie', c.virt == null ? '' : c.virt ? 'Ingeschakeld' : 'Uitgeschakeld'], ['Socket', c.socket ?? ''], ['Fabrikant', c.maker ?? ''],
          ]} />
        )}
        {kv && (
          <KV cols={2} rows={[
            ['Fysieke kernen', kv.cores], ['Logische processors', kv.logical], ['Max. snelheid', mhz(kv.maxSpeed)], ['L2-cache', kb(kv.l2)],
            ['L3-cache', kb(kv.l3)], ['Architectuur', kv.arch], ['Processen', kv.processes], ['Threads', kv.threads], ['Belasting', kv.load],
          ]} />
        )}
        {busy && !data && <Pulse text="Ophalen…" />}
      </Card>
      <Card title="Top 10 processen (CPU)">
        <DataTable id="details-cpu-top" cols={cols} rows={data?.top ?? []} rowKey={(r) => String(r.pid)} search={false} pageSize={10}
          actions={(r) => <RowMenu items={[{ label: 'Beëindigen', danger: true, onClick: () => void killProc(d, r.pid, r.name, () => void load()) }]} />} />
      </Card>
    </div>
  );
}

// ── Memory ───────────────────────────────────────────────────

const WIN_MEM = `$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$pm = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$phys = @(Get-CimInstance Win32_PhysicalMemory)
$cap = ($phys | Measure-Object -Property Capacity -Sum).Sum
$visible = [int64]$os.TotalVisibleMemorySize * 1024
$slots = (Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object -Property MemoryDevices -Sum).Sum
$mods = @($phys | ForEach-Object { @{ slot = $_.DeviceLocator; bank = $_.BankLabel; size = [int64]$_.Capacity; speed = [int]$_.Speed; configured = [int]$_.ConfiguredClockSpeed; maker = ("" + $_.Manufacturer).Trim(); part = ("" + $_.PartNumber).Trim() } })
$wsp = @{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $wsp[[int]$_.IDProcess] = [int64]$_.WorkingSetPrivate }
$top = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 | ForEach-Object { $priv = $wsp[[int]$_.Id]; @{ pid = $_.Id; name = $_.ProcessName; commit = [int64]$_.PrivateMemorySize64; ws = [int64]$_.WorkingSet64; shared = [int64]($_.WorkingSet64 - $priv); priv = [int64]$priv } })
ConvertTo-Json -Compress -Depth 4 -InputObject @{
  total = $visible; installed = [int64]$cap; inUse = [int64]($visible - [int64]$os.FreePhysicalMemory * 1024)
  available = [int64]$pm.AvailableBytes; committed = [int64]$pm.CommittedBytes; commitLimit = [int64]$pm.CommitLimit
  paged = [int64]$pm.PoolPagedBytes; nonPaged = [int64]$pm.PoolNonpagedBytes
  cached = [int64]$pm.StandbyCacheCoreBytes + [int64]$pm.StandbyCacheNormalPriorityBytes + [int64]$pm.StandbyCacheReserveBytes + [int64]$pm.ModifiedPageListBytes
  reserved = [int64]([math]::Max(0, $cap - $visible)); slots = [int]$slots; used = $phys.Count; modules = $mods; top = $top
}`;
const MAC_MEM = `echo "total=$(sysctl -n hw.memsize)"
vm_stat
echo ---TOP---
ps -Ao pid=,rss=,comm= -m | head -10`;

interface MemMod { slot: string; bank: string; size: number; speed: number; configured: number; maker: string; part: string }
interface MemTop { pid: number; name: string; commit?: number; ws: number; shared?: number; priv?: number }
interface MemInfo {
  total: number; installed: number; inUse: number; available: number; committed: number; commitLimit: number; paged: number; nonPaged: number;
  cached: number; reserved: number; slots: number; used: number; modules: MemMod[] | MemMod; top: MemTop[] | MemTop;
}

function Memory({ d, active }: { d: Device; active: boolean }) {
  const isWin = d.os === 'windows';
  const hist = useMetrics(d, active);
  const { data, err, busy, load, at } = useLoad(async () => {
    if (isWin) {
      const m = await runJson<MemInfo>(d, WIN_MEM, 'view:details-mem');
      return { m, top: arr(m.top), mods: arr(m.modules), mac: null as Array<[string, string]> | null };
    }
    const out = await runText(d, MAC_MEM, 'view:details-mem');
    const [a, b = ''] = out.split('---TOP---');
    const ps = Number(a.match(/page size of (\d+)/)?.[1] ?? 4096);
    const pages = (k: string) => Number(a.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] ?? 0) * ps;
    const total = Number(kvLines(a).total ?? 0);
    const mac: Array<[string, string]> = [
      ['Totaal', gb(total)], ['Vrij', gb(pages('Pages free'))], ['Actief', gb(pages('Pages active'))], ['Inactief', gb(pages('Pages inactive'))],
      ['Wired', gb(pages('Pages wired down'))], ['Gecomprimeerd', gb(pages('Pages occupied by compressor'))], ['Speculatief', gb(pages('Pages speculative'))],
    ];
    const top: MemTop[] = b.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
      .map((p) => ({ pid: Number(p[0]), ws: Number(p[1]) * 1024, name: p.slice(2).join(' ').split('/').pop() ?? '' }));
    return { m: null as MemInfo | null, top, mods: [] as MemMod[], mac };
  }, [d.id]);
  const m = data?.m;
  const last = hist.at(-1);
  const cols: Col<MemTop>[] = [
    { key: 'pid', label: 'PID', value: (r) => r.pid, width: '5rem' },
    { key: 'name', label: 'Proces', value: (r) => r.name, width: 'minmax(10rem,2fr)' },
    ...(isWin ? [{ key: 'commit', label: 'Doorvoeren', value: (r: MemTop) => r.commit ?? null, render: (r: MemTop) => fmtBytes(r.commit), align: 'right' as const, width: '6rem' }] : []),
    { key: 'ws', label: 'Werkset', value: (r) => r.ws, render: (r) => fmtBytes(r.ws), align: 'right', width: '6rem' },
    ...(isWin ? [
      { key: 'shared', label: 'Deelbaar', value: (r: MemTop) => r.shared ?? null, render: (r: MemTop) => fmtBytes(r.shared), align: 'right' as const, width: '6rem' },
      { key: 'priv', label: 'Geheugen', value: (r: MemTop) => r.priv ?? null, render: (r: MemTop) => fmtBytes(r.priv), align: 'right' as const, width: '6rem' },
    ] : []),
  ];
  return (
    <div className="space-y-4">
      <Head title={m ? `Geheugen ${gb(m.installed || m.total)}` : 'Geheugen'} at={at} busy={busy} load={() => void load()} />
      <ErrorText err={err} />
      <Card>
        <Chart label="Gebruik" values={hist.map((h) => h.memPct)} max={100}
          right={last ? <span className="text-(--text) tabular-nums">{last.memPct}% · {last.memUsedGB} / {last.memTotalGB} GB</span> : null} />
        {m && (
          <>
            <div className="flex items-center gap-2 text-xs"><UsageBar pct={pct(m.inUse, m.total)} className="flex-1" /><span className="tabular-nums text-(--muted)">{pct(m.inUse, m.total)}%</span></div>
            <KV cols={2} rows={[
              ['In gebruik', gb(m.inUse)], ['Beschikbaar', gb(m.available)], ['Doorgevoerd', `${gb(m.committed)} / ${gb(m.commitLimit)}`], ['In cache', gb(m.cached)],
              ['Paged pool', fmtBytes(m.paged)], ['Non-paged pool', fmtBytes(m.nonPaged)], ['Hardware gereserveerd', fmtBytes(m.reserved)],
              ['Gebruikte slots', m.slots ? `${m.used} van ${m.slots}` : String(m.used)],
              ['Snelheid', arr(m.modules)[0]?.configured || arr(m.modules)[0]?.speed ? `${arr(m.modules)[0].configured || arr(m.modules)[0].speed} MT/s` : ''],
            ]} />
          </>
        )}
        {data?.mac && <KV cols={2} rows={data.mac} />}
        {busy && !data && <Pulse text="Ophalen…" />}
      </Card>
      {(data?.mods.length ?? 0) > 0 && (
        <Card title="Modules">
          <div className="divide-y divide-(--border) text-xs">
            {data!.mods.map((x, i) => (
              <div key={`${x.slot}-${i}`} className="py-1.5 flex flex-wrap gap-x-4">
                <span className="text-(--text) w-28">{x.slot || x.bank}</span><span>{gb(x.size)}</span>
                <span className="text-(--muted)">{x.configured || x.speed ? `${x.configured || x.speed} MT/s` : ''}</span>
                <span className="text-(--muted)">{[x.maker, x.part].filter(Boolean).join(' ')}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card title="Top 10 processen (geheugen)">
        <DataTable id="details-mem-top" cols={cols} rows={data?.top ?? []} rowKey={(r) => String(r.pid)} search={false} pageSize={10}
          actions={(r) => <RowMenu items={[{ label: 'Beëindigen', danger: true, onClick: () => void killProc(d, r.pid, r.name, () => void load()) }]} />} />
      </Card>
    </div>
  );
}

// ── Volumes ──────────────────────────────────────────────────

const WIN_VOL = `$ErrorActionPreference = 'SilentlyContinue'
$bl = @{}
Get-BitLockerVolume | ForEach-Object { $bl[$_.MountPoint] = @{ protection = "$($_.ProtectionStatus)"; status = "$($_.VolumeStatus)"; pct = [int]$_.EncryptionPercentage; method = "$($_.EncryptionMethod)"; recovery = [bool](@($_.KeyProtector | Where-Object { "$($_.KeyProtectorType)" -eq 'RecoveryPassword' }).Count) } }
$pf = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { $_.Name.Substring(0, 2).ToUpper() })
$wv = @{}
Get-CimInstance Win32_Volume | ForEach-Object { if ($_.DriveLetter) { $wv[$_.DriveLetter] = $_ } }
$r1 = @{}; Get-CimInstance Win32_PerfRawData_PerfDisk_LogicalDisk | ForEach-Object { $r1[$_.Name] = $_ }
Start-Sleep -Milliseconds 1000
$r2 = @{}; Get-CimInstance Win32_PerfRawData_PerfDisk_LogicalDisk | ForEach-Object { $r2[$_.Name] = $_ }
$fmt = @{}; Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | ForEach-Object { $fmt[$_.Name] = $_ }
$vols = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=2' | ForEach-Object {
  $l = $_.DeviceID; $v = $wv[$l]; $a = $r1[$l]; $z = $r2[$l]; $f = $fmt[$l]
  $lat = 0
  if ($a -and $z) { $db = [double]$z.AvgDisksecPerTransfer_Base - [double]$a.AvgDisksecPerTransfer_Base; if ($db -gt 0 -and $z.Frequency_PerfTime) { $lat = [math]::Round((([double]$z.AvgDisksecPerTransfer - [double]$a.AvgDisksecPerTransfer) / [double]$z.Frequency_PerfTime) / $db * 1000, 2) } }
  @{ drive = $l; label = $_.VolumeName; type = [int]$_.DriveType; fs = $_.FileSystem; size = [int64]$_.Size; free = [int64]$_.FreeSpace
     compressed = [bool]$_.Compressed; indexing = [bool]$v.IndexingEnabled; automount = [bool]$v.Automount; pagefile = ($pf -contains $l)
     read = [int64]$f.DiskReadBytesPersec; write = [int64]$f.DiskWriteBytesPersec; busy = [int]$f.PercentDiskTime; latencyMs = $lat; bitlocker = $bl[$l] } })
ConvertTo-Json -Compress -Depth 4 -InputObject $vols`;
const MAC_VOL = `df -kP | tail -n +2
echo ---FV---
fdesetup status 2>&1`;

interface Vol {
  drive: string; label?: string; type: number; fs?: string; size: number; free: number; compressed?: boolean; indexing?: boolean; automount?: boolean;
  pagefile?: boolean; read?: number; write?: number; busy?: number; latencyMs?: number;
  bitlocker?: { protection: string; status: string; pct: number; method: string; recovery: boolean } | null;
}

function Volumes({ d, active }: { d: Device; active: boolean }) {
  const isWin = d.os === 'windows';
  const hist = useMetrics(d, active);
  const { data, err, busy, load, at } = useLoad(async () => {
    if (isWin) return { vols: arr(await runJson<Vol[] | Vol>(d, WIN_VOL, 'view:details-volumes')), fv: '' };
    const out = await runText(d, MAC_VOL, 'view:details-volumes');
    const [a, b = ''] = out.split('---FV---');
    const vols: Vol[] = a.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 6 && p[0].startsWith('/dev/'))
      .map((p) => ({ drive: p.slice(5).join(' '), label: p[0], type: 3, size: Number(p[1]) * 1024, free: Number(p[3]) * 1024 }));
    return { vols, fv: b.trim() };
  }, [d.id]);
  const busyVals = hist.map((h) => h.diskBusy ?? 0);
  return (
    <div className="space-y-4">
      <Head title="Schijfvolumes" at={at} busy={busy} load={() => void load()} />
      <ErrorText err={err} />
      {isWin && <Card><Chart label="Actieve tijd (alle schijven)" values={busyVals} max={100} right={hist.length ? <span className="text-(--text) tabular-nums">{busyVals.at(-1)}%</span> : null} /></Card>}
      {data?.fv && <Card title="FileVault"><p className="text-xs text-(--text)">{data.fv}</p></Card>}
      {busy && !data && <Pulse text="Ophalen…" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {(data?.vols ?? []).map((v) => {
          const used = v.size - v.free;
          const p = pct(used, v.size);
          const bl = v.bitlocker;
          const usedHist = hist.map((h) => h.disks.find((x) => x.drive === v.drive)?.pct ?? 0);
          const on = bl && /On/i.test(bl.protection);
          return (
            <Card key={v.drive} title={<>{v.drive}{v.label ? <span className="text-(--muted) font-normal"> {v.label}</span> : null}</>}
              right={bl ? <Badge tone={on ? (bl.recovery ? 'ok' : 'warn') : 'bad'}>BitLocker {on ? 'aan' : 'uit'}</Badge> : null}>
              <div className="flex items-center gap-2 text-xs"><UsageBar pct={p} className="flex-1" /><span className="tabular-nums text-(--muted)">{gb(used)} / {gb(v.size)} ({p}%)</span></div>
              {isWin && hist.length > 1 && <Sparkline values={usedHist} max={100} height={40} className="rounded-lg border border-(--border) bg-(--bg)" />}
              {bl && on && !bl.recovery && <p className="text-xs text-yellow-500">Ontbrekende herstelsleutel: dit volume heeft geen RecoveryPassword-protector.</p>}
              <KV cols={2} rows={[
                ['Type', v.type === 2 ? 'Verwisselbaar' : 'Lokaal'], ['Bestandssysteem', v.fs ?? ''], ['Vrij', gb(v.free)],
                ['Lezen', v.read != null ? fmtRate(v.read) : ''], ['Schrijven', v.write != null ? fmtRate(v.write) : ''],
                ['Actieve tijd', v.busy != null ? `${v.busy}%` : ''], ['Reactietijd', v.latencyMs != null ? `${v.latencyMs} ms` : ''],
                ['BitLocker', bl ? `${bl.status}${bl.pct < 100 ? ` (${bl.pct}%)` : ''}${bl.method && bl.method !== 'None' ? `, ${bl.method}` : ''}` : ''],
                ['Gecomprimeerd', yesNo(v.compressed)], ['Paginabestand', yesNo(v.pagefile)], ['Indexering', yesNo(v.indexing)], ['Automount', yesNo(v.automount)],
              ]} />
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Network ──────────────────────────────────────────────────

const WIN_NET = `$ErrorActionPreference = 'SilentlyContinue'
$out = @(Get-NetAdapter | ForEach-Object {
  $a = $_; $i = $a.ifIndex
  $ii = Get-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4
  @{ name = $a.Name; desc = $a.InterfaceDescription; status = "$($a.Status)"; mac = $a.MacAddress; media = "$($a.MediaType)"; phys = "$($a.PhysicalMediaType)"
     speed = "$($a.LinkSpeed)"; mtu = [int]$ii.NlMtu; dhcp = "$($ii.Dhcp)"; virtual = [bool]$a.Virtual
     ipv4 = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 | ForEach-Object { $_.IPAddress + '/' + $_.PrefixLength })
     ipv6 = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv6 | ForEach-Object { $_.IPAddress })
     gateway = @(Get-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' | ForEach-Object { $_.NextHop })
     dns = @((Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4).ServerAddresses) } })
ConvertTo-Json -Compress -Depth 4 -InputObject $out`;
const MAC_NET = `ifconfig
echo ---GW---
netstat -rn -f inet | grep default
echo ---DNS---
scutil --dns | grep nameserver | sort -u`;

interface Nic {
  name: string; desc: string; status: string; mac: string; media: string; phys: string; speed: string; mtu: number; dhcp: string; virtual: boolean;
  ipv4: string[] | string; ipv6: string[] | string; gateway: string[] | string; dns: string[] | string;
}
const join = (v: string[] | string | null | undefined) => arr(v).filter(Boolean).join(', ');

function Network({ d, active }: { d: Device; active: boolean }) {
  const isWin = d.os === 'windows';
  const hist = useMetrics(d, active);
  const [showDown, setShowDown] = useState(false);
  const { data, err, busy, load, at } = useLoad(async () => {
    if (isWin) return { nics: arr(await runJson<Nic[] | Nic>(d, WIN_NET, 'view:details-network')), raw: '' };
    return { nics: [] as Nic[], raw: await runText(d, MAC_NET, 'view:details-network') };
  }, [d.id]);
  const nics = (data?.nics ?? []).filter((n) => showDown || n.status === 'Up');
  return (
    <div className="space-y-4">
      <Head title="Netwerkadapters" at={at} busy={busy} load={() => void load()}>
        {isWin && <label className="text-xs text-(--muted) flex items-center gap-1.5"><input type="checkbox" checked={showDown} onChange={(e) => setShowDown(e.target.checked)} />Ook niet-verbonden</label>}
      </Head>
      <ErrorText err={err} />
      {busy && !data && <Pulse text="Ophalen…" />}
      {data?.raw && <OutputBox text={data.raw} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {nics.map((n) => {
          const rx = hist.map((h) => h.net.find((x) => x.name === n.name)?.rx ?? 0);
          const tx = hist.map((h) => h.net.find((x) => x.name === n.name)?.tx ?? 0);
          return (
            <Card key={n.name} title={<>{n.name}<span className="block text-xs font-normal text-(--muted) truncate">{n.desc}</span></>}
              right={<Badge tone={n.status === 'Up' ? 'ok' : 'muted'}>{n.status === 'Up' ? 'Verbonden' : n.status}</Badge>}>
              {n.status === 'Up' && (
                <Chart label="Doorvoer (ontvangen, verzenden gestippeld)" values={rx} values2={tx}
                  right={hist.length ? <span className="text-(--text) tabular-nums">{fmtRate(rx.at(-1) ?? 0)} / {fmtRate(tx.at(-1) ?? 0)}</span> : null} />
              )}
              <KV rows={[
                ['MAC-adres', n.mac], ['Verbindingstype', [n.phys, n.media].filter((x) => x && x !== 'Unspecified').join(', ')], ['Linksnelheid', n.speed],
                ['MTU', n.mtu || ''], ['IPv4', join(n.ipv4)], ['Gateway', join(n.gateway)], ['DNS-servers', join(n.dns)], ['IPv6', join(n.ipv6)],
                ['DHCP', n.dhcp === 'Enabled' ? 'Ja' : n.dhcp === 'Disabled' ? 'Nee' : ''], ['Virtueel', n.virtual ? 'Ja' : ''],
              ]} />
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Open ports ───────────────────────────────────────────────

const WIN_PORTS = `$ErrorActionPreference = 'SilentlyContinue'
$pn = @{}; Get-Process | ForEach-Object { $pn[[int]$_.Id] = $_.ProcessName }
$svc = @{}; Get-CimInstance Win32_Service -Filter "State='Running'" | ForEach-Object { $k = [int]$_.ProcessId; if (-not $svc[$k]) { $svc[$k] = $_.Name } }
$tcp = @(Get-NetTCPConnection -State Listen | ForEach-Object { $o = [int]$_.OwningProcess; @{ port = [int]$_.LocalPort; proto = 'TCP'; addr = $_.LocalAddress; state = 'Luisteren'; pid = $o; proc = $pn[$o]; svc = $svc[$o] } })
$udp = @(Get-NetUDPEndpoint | ForEach-Object { $o = [int]$_.OwningProcess; @{ port = [int]$_.LocalPort; proto = 'UDP'; addr = $_.LocalAddress; state = ''; pid = $o; proc = $pn[$o]; svc = $svc[$o] } })
ConvertTo-Json -Compress -InputObject @($tcp + $udp)`;
const MAC_PORTS = `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | tail -n +2; echo ---UDP---; lsof -nP -iUDP 2>/dev/null | tail -n +2`;

interface Port { port: number; proto: string; addr: string; state: string; pid: number; proc?: string; svc?: string }

function Ports({ d }: { d: Device }) {
  const isWin = d.os === 'windows';
  const { data, err, busy, load, at } = useLoad(async (): Promise<Port[]> => {
    if (isWin) return arr(await runJson<Port[] | Port>(d, WIN_PORTS, 'view:details-ports'));
    const out = await runText(d, MAC_PORTS, 'view:details-ports');
    const [tcp, udp = ''] = out.split('---UDP---');
    const parse = (txt: string, proto: string): Port[] => txt.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 9).map((p) => {
      const name = p[8];
      const i = name.lastIndexOf(':');
      return { proto, pid: Number(p[1]), proc: p[0], addr: name.slice(0, i), port: Number(name.slice(i + 1)), state: proto === 'TCP' ? 'Luisteren' : '' };
    });
    const seen = new Set<string>();
    return [...parse(tcp, 'TCP'), ...parse(udp, 'UDP')].filter((p) => { const k = `${p.proto}${p.addr}${p.port}${p.pid}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }, [d.id]);
  const cols: Col<Port>[] = [
    { key: 'port', label: 'Poort', value: (r) => r.port, width: '5rem' },
    { key: 'proto', label: 'Protocol', value: (r) => r.proto, width: '5rem' },
    { key: 'addr', label: 'Adres', value: (r) => r.addr, width: 'minmax(8rem,1fr)' },
    { key: 'state', label: 'Status', value: (r) => r.state, width: '6rem' },
    { key: 'proc', label: 'Service (proces)', value: (r) => [r.svc, r.proc].filter(Boolean).join(' '), render: (r) => <>{r.svc && r.svc !== r.proc ? <span className="text-(--text)">{r.svc} </span> : null}<span className="text-(--muted)">{r.proc}</span></>, width: 'minmax(10rem,1.5fr)' },
    { key: 'pid', label: 'PID', value: (r) => r.pid, width: '5rem', align: 'right' },
  ];
  return (
    <div className="space-y-4">
      <Head title="Open poorten" at={at} busy={busy} load={() => void load()} />
      <ErrorText err={err} />
      <DataTable id="details-ports" cols={cols} rows={data ?? []} rowKey={(r) => `${r.proto}-${r.addr}-${r.port}-${r.pid}`} initialSort={{ key: 'port', dir: 1 }}
        empty={busy ? 'Ophalen…' : 'Geen open poorten.'} exportName={`poorten-${d.name}`} />
    </div>
  );
}

// ── Hardware ─────────────────────────────────────────────────

const WIN_HW = `$ErrorActionPreference = 'SilentlyContinue'
function D($x) { if ($x) { ([datetime]$x).ToString('o') } else { $null } }
$pd = @(Get-PhysicalDisk | ForEach-Object { @{ id = "$($_.DeviceId)"; model = $_.FriendlyName; serial = ("" + $_.SerialNumber).Trim(); size = [int64]$_.Size; bus = "$($_.BusType)"; media = "$($_.MediaType)"; health = "$($_.HealthStatus)"; status = "$($_.OperationalStatus)" } })
$dd = @(Get-CimInstance Win32_DiskDrive | ForEach-Object { @{ id = "$($_.Index)"; model = $_.Model; serial = ("" + $_.SerialNumber).Trim(); size = [int64]$_.Size; iface = $_.InterfaceType; partitions = [int]$_.Partitions; status = $_.Status } })
$cd = @(Get-CimInstance Win32_CDROMDrive | ForEach-Object { @{ name = $_.Name; drive = $_.Drive; loaded = [bool]$_.MediaLoaded } })
$pf = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { @{ name = $_.Name; sizeMB = [int]$_.AllocatedBaseSize; usedMB = [int]$_.CurrentUsage; peakMB = [int]$_.PeakUsage } })
$vc = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; driver = $_.DriverVersion; date = (D $_.DriverDate); w = [int]$_.CurrentHorizontalResolution; h = [int]$_.CurrentVerticalResolution; ram = [int64]$_.AdapterRAM } })
$pa = @(Get-Partition | ForEach-Object { $dl = ''; if ($_.DriveLetter -and [int][char]$_.DriveLetter -ne 0) { $dl = "$($_.DriveLetter):" }; @{ disk = [int]$_.DiskNumber; index = [int]$_.PartitionNumber; type = "$($_.Type)"; boot = [bool]$_.IsBoot; system = [bool]$_.IsSystem; active = [bool]$_.IsActive; primary = ("$($_.MbrType)" -ne '' -or "$($_.GptType)" -ne ''); offset = [int64]$_.Offset; size = [int64]$_.Size; letter = $dl } })
$bb = Get-CimInstance Win32_BaseBoard
$bi = Get-CimInstance Win32_BIOS
$tpm = Get-Tpm
$tspec = (Get-CimInstance -Namespace 'root/cimv2/security/microsofttpm' -ClassName Win32_Tpm).SpecVersion
$sb = $null; try { $sb = Confirm-SecureBootUEFI -ErrorAction Stop } catch { $sb = $null }
ConvertTo-Json -Compress -Depth 4 -InputObject @{
  physical = $pd; drives = $dd; optical = $cd; pagefile = $pf; video = $vc; partitions = $pa
  board = @{ maker = $bb.Manufacturer; product = $bb.Product; version = $bb.Version; serial = $bb.SerialNumber }
  bios = @{ maker = $bi.Manufacturer; version = $bi.SMBIOSBIOSVersion; smbios = "$($bi.SMBIOSMajorVersion).$($bi.SMBIOSMinorVersion)"; date = (D $bi.ReleaseDate); serial = $bi.SerialNumber }
  tpm = @{ present = [bool]$tpm.TpmPresent; ready = [bool]$tpm.TpmReady; version = $tpm.ManufacturerVersion; spec = $tspec }
  secureBoot = $sb
}`;
const MAC_HW = `system_profiler SPHardwareDataType SPDisplaysDataType SPStorageDataType -json 2>/dev/null`;

interface PhysDisk { id: string; model: string; serial: string; size: number; bus?: string; media?: string; health?: string; status?: string; iface?: string; partitions?: number }
interface Partition { disk: number; index: number; type: string; boot: boolean; system: boolean; active: boolean; primary: boolean; offset: number; size: number; letter: string }
interface HwInfo {
  physical: PhysDisk[] | PhysDisk; drives: PhysDisk[] | PhysDisk; optical: Array<{ name: string; drive: string; loaded: boolean }> | { name: string; drive: string; loaded: boolean };
  pagefile: Array<{ name: string; sizeMB: number; usedMB: number; peakMB: number }> | { name: string; sizeMB: number; usedMB: number; peakMB: number };
  video: Array<{ name: string; driver: string; date: string | null; w: number; h: number; ram: number }> | { name: string; driver: string; date: string | null; w: number; h: number; ram: number };
  partitions: Partition[] | Partition;
  board: { maker?: string; product?: string; version?: string; serial?: string };
  bios: { maker?: string; version?: string; smbios?: string; date?: string | null; serial?: string };
  tpm: { present: boolean; ready: boolean; version?: string; spec?: string };
  secureBoot: boolean | null;
}
type MacProfile = Record<string, Array<Record<string, unknown>>>;

const fmtD = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function MacHardware({ p }: { p: MacProfile }) {
  const labels: Record<string, string> = { SPHardwareDataType: 'Hardware', SPDisplaysDataType: 'Beeldschermen en videokaart', SPStorageDataType: 'Opslag' };
  const flat = (o: Record<string, unknown>): Array<[string, React.ReactNode]> => Object.entries(o)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => [k.replace(/^(sppci_|spdisplays_|sp_|machine_)/, '').replace(/_/g, ' '), String(v)]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Object.entries(p).flatMap(([type, items]) => (items ?? []).map((it, i) => (
        <Card key={`${type}-${i}`} title={`${labels[type] ?? type}${typeof it._name === 'string' ? `: ${it._name}` : ''}`}>
          <KV rows={flat(it)} />
          {Array.isArray(it.spdisplays_ndrvs) && (it.spdisplays_ndrvs as Array<Record<string, unknown>>).map((s, j) => <KV key={j} rows={flat(s)} />)}
        </Card>
      )))}
    </div>
  );
}

function Hardware({ d }: { d: Device }) {
  const isWin = d.os === 'windows';
  const { data, err, busy, load, at } = useLoad(async () => {
    if (isWin) return { hw: await runJson<HwInfo>(d, WIN_HW, 'view:details-hardware', 120), mac: null as MacProfile | null };
    return { hw: null as HwInfo | null, mac: await runJson<MacProfile>(d, MAC_HW, 'view:details-hardware', 120) };
  }, [d.id]);
  const hw = data?.hw;
  const disks = useMemo(() => {
    if (!hw) return [] as PhysDisk[];
    const dd = arr(hw.drives);
    const pd = arr(hw.physical);
    return (dd.length ? dd : pd).map((x) => ({ ...pd.find((p) => p.id === x.id), ...x, bus: pd.find((p) => p.id === x.id)?.bus, media: pd.find((p) => p.id === x.id)?.media, health: pd.find((p) => p.id === x.id)?.health ?? x.status }));
  }, [hw]);
  const partCols: Col<Partition>[] = [
    { key: 'disk', label: 'Schijf', value: (r) => r.disk, width: '4rem' },
    { key: 'index', label: 'Index', value: (r) => r.index, width: '4rem' },
    { key: 'letter', label: 'Station', value: (r) => r.letter, width: '4rem' },
    { key: 'type', label: 'Type', value: (r) => r.type, width: 'minmax(7rem,1fr)' },
    { key: 'boot', label: 'Opstartbaar', value: (r) => (r.boot || r.system ? 'Ja' : 'Nee'), width: '6rem' },
    { key: 'active', label: 'Actief', value: (r) => (r.active ? 'Ja' : 'Nee'), width: '4rem' },
    { key: 'offset', label: 'Offset', value: (r) => r.offset, render: (r) => fmtBytes(r.offset), align: 'right', width: '6rem' },
    { key: 'size', label: 'Grootte', value: (r) => r.size, render: (r) => fmtBytes(r.size), align: 'right', width: '6rem' },
  ];
  return (
    <div className="space-y-4">
      <Head title="Hardware en diversen" at={at} busy={busy} load={() => void load()} />
      <ErrorText err={err} />
      {busy && !data && <Pulse text="Ophalen…" />}
      {data?.mac && <MacHardware p={data.mac} />}
      {hw && (
        <>
          <Card title="Fysieke schijven">
            <div className="divide-y divide-(--border)">
              {disks.map((x) => (
                <div key={x.id} className="py-2 first:pt-0 last:pb-0 space-y-1">
                  <div className="flex items-center gap-2 text-sm text-(--text)">
                    <span className="flex-1 min-w-0 truncate">{x.model}</span>
                    {x.health && <Badge tone={/healthy|ok/i.test(x.health) ? 'ok' : 'bad'}>{/healthy/i.test(x.health) ? 'Gezond' : x.health}</Badge>}
                  </div>
                  <KV cols={2} rows={[['Grootte', gb(x.size)], ['Interface', [x.bus, x.iface].filter((v) => v && v !== 'Unknown').join(' / ')], ['Type', x.media && x.media !== 'Unspecified' ? x.media : ''], ['Serienummer', x.serial], ['Partities', x.partitions ?? '']]} />
                </div>
              ))}
            </div>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Moederbord en BIOS">
              <KV rows={[
                ['Moederbord', [hw.board.maker, hw.board.product].filter(Boolean).join(' ')], ['Versie', hw.board.version ?? ''], ['Serienummer bord', hw.board.serial ?? ''],
                ['BIOS', [hw.bios.maker, hw.bios.version].filter(Boolean).join(' ')], ['SMBIOS', hw.bios.smbios ?? ''], ['BIOS-datum', fmtD(hw.bios.date)], ['Serienummer', hw.bios.serial ?? ''],
                ['TPM', hw.tpm.present ? `${hw.tpm.ready ? 'Gereed' : 'Niet gereed'}${hw.tpm.spec ? `, spec ${hw.tpm.spec.split(',')[0]}` : ''}${hw.tpm.version ? `, firmware ${hw.tpm.version}` : ''}` : 'Niet aanwezig'],
                ['Secure Boot', hw.secureBoot == null ? 'Niet ondersteund' : hw.secureBoot ? 'Aan' : 'Uit'],
              ]} />
            </Card>
            <Card title="Videokaart">
              {arr(hw.video).map((v, i) => (
                <KV key={i} rows={[['Naam', v.name], ['Driver', `${v.driver ?? ''}${v.date ? ` (${fmtD(v.date)})` : ''}`], ['Resolutie', v.w ? `${v.w} x ${v.h}` : ''], ['Geheugen', v.ram > 0 ? fmtBytes(v.ram) : '']]} />
              ))}
            </Card>
            <Card title="Paginabestand">
              {arr(hw.pagefile).length === 0 ? <p className="text-xs text-(--muted)">Geen paginabestand.</p> : arr(hw.pagefile).map((p) => (
                <KV key={p.name} rows={[['Bestand', p.name], ['Grootte', `${p.sizeMB} MB`], ['In gebruik', `${p.usedMB} MB`], ['Piek', `${p.peakMB} MB`]]} />
              ))}
            </Card>
            <Card title="Optische stations">
              {arr(hw.optical).length === 0 ? <p className="text-xs text-(--muted)">Geen.</p> : arr(hw.optical).map((o) => (
                <KV key={o.name} rows={[['Naam', o.name], ['Station', o.drive], ['Media', o.loaded ? 'Geplaatst' : 'Leeg']]} />
              ))}
            </Card>
          </div>
          <Card title="Partities">
            <DataTable id="details-partitions" cols={partCols} rows={arr(hw.partitions)} rowKey={(r) => `${r.disk}-${r.index}`} search={false} pageSize={25} exportName={`partities-${d.name}`} />
          </Card>
        </>
      )}
    </div>
  );
}

// ── Services ─────────────────────────────────────────────────

const WIN_SVC = `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Service | ForEach-Object { @{ name = $_.Name; display = $_.DisplayName; state = $_.State; start = $_.StartMode; delayed = [bool]$_.DelayedAutoStart; account = $_.StartName; pid = [int]$_.ProcessId } })`;
const MAC_SVC = `launchctl list | tail -n +2`;

interface Svc { name: string; display: string; state: string; start: string; delayed?: boolean; account?: string; pid?: number }
const STATE: Record<string, string> = { Running: 'Actief', Stopped: 'Gestopt', 'Start Pending': 'Starten…', 'Stop Pending': 'Stoppen…', Paused: 'Gepauzeerd' };
const START: Record<string, string> = { Auto: 'Automatisch', Manual: 'Handmatig', Disabled: 'Uitgeschakeld', Boot: 'Boot', System: 'Systeem' };

function Services({ d }: { d: Device }) {
  const isWin = d.os === 'windows';
  const [only, setOnly] = useState<'all' | 'Running' | 'Stopped'>('all');
  const [rowBusy, setRowBusy] = useState('');
  const { data, err, busy, load, at } = useLoad(async (): Promise<Svc[]> => {
    if (isWin) return arr(await runJson<Svc[] | Svc>(d, WIN_SVC, 'view:details-services'));
    const out = await runText(d, MAC_SVC, 'view:details-services');
    return out.split('\n').map((l) => l.split('\t')).filter((p) => p.length >= 3)
      .map((p) => ({ name: p[2], display: p[2], state: p[0] !== '-' ? 'Running' : 'Stopped', start: p[1] === '0' || p[1] === '-' ? '' : `exit ${p[1]}`, pid: p[0] !== '-' ? Number(p[0]) : undefined }));
  }, [d.id]);
  async function act(s: Svc, a: 'start' | 'stop' | 'restart') {
    setRowBusy(s.name);
    const cmd = isWin
      ? `${a === 'start' ? 'Start' : a === 'stop' ? 'Stop' : 'Restart'}-Service -Name ${psq(s.name)}${a === 'start' ? '' : ' -Force'} -ErrorAction Stop; (Get-Service -Name ${psq(s.name)}).Status`
      : a === 'stop' ? `launchctl stop ${shq(s.name)} && echo gestopt` : `launchctl kickstart -k system/${shq(s.name)} 2>&1 || launchctl start ${shq(s.name)}`;
    const r: ExecResult = await execOn(d.id, cmd, { tool: `service-${a}` }).catch((e: Error) => ({ ok: false, output: '', error: e.message }));
    setRowBusy('');
    if (!r.ok) alert(r.error || r.output);
    void load();
  }
  const rows = (data ?? []).filter((s) => only === 'all' || s.state === only);
  const cols: Col<Svc>[] = [
    { key: 'display', label: 'Displaynaam', value: (r) => r.display, width: 'minmax(12rem,2fr)', render: (r) => <span className="text-(--text)">{r.display}</span> },
    { key: 'name', label: 'Naam', value: (r) => r.name, width: 'minmax(8rem,1fr)' },
    { key: 'state', label: 'Status', value: (r) => STATE[r.state] ?? r.state, width: '6rem',
      render: (r) => <span className="inline-flex items-center gap-1.5"><span className={clsx('w-2 h-2 rounded-full', r.state === 'Running' ? 'bg-green-500' : 'bg-zinc-400')} />{rowBusy === r.name ? 'Bezig…' : STATE[r.state] ?? r.state}</span> },
    { key: 'start', label: 'Opstarttype', value: (r) => `${START[r.start] ?? r.start}${r.delayed && r.start === 'Auto' ? ' (vertraagd)' : ''}`, width: '9rem' },
    ...(isWin ? [{ key: 'account', label: 'Inloggen als', value: (r: Svc) => r.account ?? '', width: 'minmax(8rem,1fr)' }] : []),
  ];
  return (
    <div className="space-y-4">
      <Head title={isWin ? 'Windows-services' : 'Services (launchd)'} at={at} busy={busy} load={() => void load()} />
      <ErrorText err={err} />
      <DataTable id={`details-services-${d.os}`} cols={cols} rows={rows} rowKey={(r) => r.name} empty={busy ? 'Ophalen…' : 'Geen services.'} exportName={`services-${d.name}`}
        toolbar={<Chips items={[['all', 'Alle'], ['Running', 'Actief'], ['Stopped', 'Gestopt']]} value={only} onChange={setOnly} />}
        actions={(r) => (
          <RowMenu items={r.state === 'Running'
            ? [{ label: 'Herstarten', onClick: () => void act(r, 'restart') }, { label: 'Stoppen', danger: true, onClick: () => { if (confirm(`${r.display} stoppen?`)) void act(r, 'stop'); } }]
            : [{ label: 'Starten', onClick: () => void act(r, 'start') }]} />
        )} />
    </div>
  );
}

// ── Event log ────────────────────────────────────────────────

interface Ev { time: string; log: string; source: string; id: number; level: number; msg: string }
interface EvGroup { key: string; id: number; source: string; level: number; msg: string; count: number; last: string; log: string }
const LEVEL: Record<number, string> = { 1: 'Kritiek', 2: 'Fout', 3: 'Waarschuwing' };
const levelTone = (l: number) => (l === 1 ? 'text-red-400' : l === 2 ? 'text-orange-400' : 'text-yellow-500');

const winEvents = (days: number, warn: boolean) => `try { $e = Get-WinEvent -FilterHashtable @{ LogName = 'System', 'Application'; Level = ${warn ? '1, 2, 3' : '1, 2'}; StartTime = (Get-Date).AddDays(-${days}) } -MaxEvents 1500 -ErrorAction Stop } catch { $e = @() }
ConvertTo-Json -Compress -InputObject @($e | ForEach-Object { $m = ("" + $_.Message).Split([char]10)[0].Trim(); if ($m.Length -gt 300) { $m = $m.Substring(0, 300) }; @{ time = $_.TimeCreated.ToString('o'); log = $_.LogName; source = $_.ProviderName; id = [int]$_.Id; level = [int]$_.Level; msg = $m } })`;
const macEvents = (hours: number) => `log show --last ${hours}h --style compact --predicate 'messageType == error OR messageType == fault' 2>/dev/null | tail -300`;

function Events({ d, ask }: { d: Device; ask: (q: string, ctx?: string) => Promise<void> }) {
  const isWin = d.os === 'windows';
  const [days, setDays] = useState<'1' | '2' | '7'>('2');
  const [warn, setWarn] = useState(false);
  const [view, setView] = useState<'group' | 'all'>('group');
  const [level, setLevel] = useState<'all' | '1' | '2' | '3'>('all');
  const { data, err, busy, load, at } = useLoad(async () => {
    if (isWin) return { list: arr(await runJson<Ev[] | Ev>(d, winEvents(Number(days), warn), 'view:events', 120)), raw: '' };
    return { list: [] as Ev[], raw: await runText(d, macEvents(days === '7' ? 24 : Number(days)), 'view:events', 120) };
  }, [d.id, days, warn]);
  const list = (data?.list ?? []).filter((e) => level === 'all' || e.level === Number(level));
  const groups = useMemo(() => {
    const m = new Map<string, EvGroup>();
    for (const e of list) {
      const key = `${e.source}|${e.id}`;
      const g = m.get(key);
      if (!g) m.set(key, { key, id: e.id, source: e.source, level: e.level, msg: e.msg, count: 1, last: e.time, log: e.log });
      else { g.count++; if (e.time > g.last) { g.last = e.time; g.msg = e.msg; } g.level = Math.min(g.level, e.level); }
    }
    return [...m.values()];
  }, [list]);
  const counts = { 1: 0, 2: 0, 3: 0 } as Record<number, number>;
  for (const e of data?.list ?? []) counts[e.level] = (counts[e.level] ?? 0) + 1;
  const ctx = () => (isWin ? groups.slice(0, 60).map((g) => `${g.last} ${LEVEL[g.level] ?? g.level} ${g.log} ${g.source} ${g.id} (${g.count}x): ${g.msg}`).join('\n') : data?.raw ?? '');
  const lvl = (l: number) => <span className={levelTone(l)}>{LEVEL[l] ?? l}</span>;
  const groupCols: Col<EvGroup>[] = [
    { key: 'id', label: 'Event-ID', value: (r) => r.id, width: '5rem' },
    { key: 'source', label: 'Bron', value: (r) => r.source, width: 'minmax(8rem,1fr)' },
    { key: 'level', label: 'Type', value: (r) => r.level, render: (r) => lvl(r.level), width: '7rem' },
    { key: 'msg', label: 'Bericht', value: (r) => r.msg, width: 'minmax(16rem,3fr)' },
    { key: 'count', label: 'Voorvallen', value: (r) => r.count, align: 'right', width: '6rem' },
    { key: 'last', label: 'Laatst', value: (r) => r.last, render: (r) => relTime(r.last), width: '10rem' },
  ];
  const allCols: Col<Ev>[] = [
    { key: 'time', label: 'Tijd', value: (r) => r.time, render: (r) => relTime(r.time), width: '10rem' },
    { key: 'level', label: 'Type', value: (r) => r.level, render: (r) => lvl(r.level), width: '7rem' },
    { key: 'log', label: 'Logboek', value: (r) => r.log, width: '6rem' },
    { key: 'source', label: 'Bron', value: (r) => r.source, width: 'minmax(8rem,1fr)' },
    { key: 'id', label: 'Event-ID', value: (r) => r.id, width: '5rem' },
    { key: 'msg', label: 'Bericht', value: (r) => r.msg, width: 'minmax(16rem,3fr)' },
  ];
  return (
    <div className="space-y-4">
      <Head title="Gebeurtenislogboek" at={at} busy={busy} load={() => void load()}>
        <button className={ghost} disabled={!data} onClick={() => void ask('Analyseer deze gebeurtenissen uit het logboek: wat is ernstig en wat moet ik doen?', ctx())}>Laat Claude analyseren</button>
      </Head>
      <div className="flex flex-wrap items-center gap-3">
        <Chips items={isWin ? [['1', '1 dag'], ['2', '2 dagen'], ['7', '7 dagen']] : [['1', '1 uur'], ['2', '2 uur'], ['7', '24 uur']]} value={days} onChange={setDays} />
        {isWin && <>
          <Chips items={[['group', 'Gegroepeerd'], ['all', 'Alles']]} value={view} onChange={setView} />
          <Chips items={[['all', 'Alle typen'], ['1', `Kritiek (${counts[1]})`], ['2', `Fouten (${counts[2]})`], ...(warn ? [['3', `Waarschuwingen (${counts[3]})`] as ['3', string]] : [])]} value={level} onChange={setLevel} />
          <label className="text-xs text-(--muted) flex items-center gap-1.5"><input type="checkbox" checked={warn} onChange={(e) => { setWarn(e.target.checked); if (!e.target.checked && level === '3') setLevel('all'); }} />Waarschuwingen</label>
        </>}
      </div>
      <ErrorText err={err} />
      {isWin ? (view === 'group'
        ? <DataTable id="details-events-group" cols={groupCols} rows={groups} rowKey={(r) => r.key} initialSort={{ key: 'last', dir: -1 }} empty={busy ? 'Ophalen…' : 'Geen gebeurtenissen.'} exportName={`logboek-${d.name}`} />
        : <DataTable id="details-events-all" cols={allCols} rows={list} rowKey={(r) => `${r.time}-${r.source}-${r.id}-${r.msg.slice(0, 20)}`} initialSort={{ key: 'time', dir: -1 }} empty={busy ? 'Ophalen…' : 'Geen gebeurtenissen.'} exportName={`logboek-${d.name}`} />)
        : busy && !data ? <Pulse text="Ophalen…" /> : <OutputBox text={data?.raw || 'Geen fouten.'} />}
    </div>
  );
}

// ── Tab ──────────────────────────────────────────────────────

const ALIAS: Record<string, Section> = { cpu: 'cpu', memory: 'mem', mem: 'mem', disks: 'vol', vol: 'vol', network: 'net', net: 'net', ports: 'ports', hardware: 'hw', hw: 'hw', services: 'svc', svc: 'svc', events: 'events' };

export default function Details({ d, ask, section }: { d: Device; ask: (q: string, ctx?: string) => Promise<void>; section?: string }) {
  const isWin = d.os === 'windows';
  const [sec, setSec] = useState<Section>(ALIAS[section ?? ''] ?? 'cpu');
  useEffect(() => { const s = ALIAS[section ?? '']; if (s) setSec(s); }, [section]);
  // sections stay mounted once opened (lazy first load, no reload when switching back)
  const [visited, setVisited] = useState<Set<Section>>(new Set(['cpu']));
  useEffect(() => { setVisited((v) => (v.has(sec) ? v : new Set(v).add(sec))); }, [sec]);
  const items: Array<[Section, string]> = [
    ['cpu', 'Processor'], ['mem', 'Geheugen'], ['vol', 'Schijfvolumes'], ['net', 'Netwerkadapters'], ['ports', 'Open poorten'],
    ['hw', 'Hardware en diversen'], ['svc', isWin ? 'Windows-services' : 'Services'], ['events', 'Gebeurtenislogboek'],
  ];
  if (!d.online) return <p className="text-sm text-(--muted)">{d.name} is offline; details zijn beschikbaar zodra het apparaat online is.</p>;
  const node = (s: Section): React.ReactNode => {
    switch (s) {
      case 'cpu': return <Processor d={d} active={sec === 'cpu'} />;
      case 'mem': return <Memory d={d} active={sec === 'mem'} />;
      case 'vol': return <Volumes d={d} active={sec === 'vol'} />;
      case 'net': return <Network d={d} active={sec === 'net'} />;
      case 'ports': return <Ports d={d} />;
      case 'hw': return <Hardware d={d} />;
      case 'svc': return <Services d={d} />;
      case 'events': return <Events d={d} ask={ask} />;
    }
  };
  return (
    <div className="flex flex-col md:flex-row gap-4">
      <SubNav items={items} value={sec} onChange={setSec} />
      <div className="flex-1 min-w-0">
        {items.map(([s]) => (visited.has(s) ? <div key={s} className={sec === s ? '' : 'hidden'}>{node(s)}</div> : null))}
      </div>
    </div>
  );
}
