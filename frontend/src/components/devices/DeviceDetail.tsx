'use client';

/**
 * Device page, NinjaOne-style: header with health, favorite and the Uitvoeren / Verbinden / Maken menus,
 * then tabs Overzicht, Details, Patching, Software, Tools, Activiteiten, Terminal, Opmerkingen, Aangepast,
 * Instellingen. Everything runs through the agent (exec, read, write) and is audited server-side.
 */
import ClaudeLogo from '../ClaudeLogo';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { useChatStore } from '@/lib/store';
import { conversations as convApi } from '@/lib/api';
import {
  ago, alertsOf, api, Badge, cancelTask, Device, deviceTitle, DeviceIcon, execOn, fmtDate, ghost, health, inMaintenance, osLabel, parseJson, primary, Task, UsageBar,
} from './shared';
import { Card, Chips, ErrorText, fmtRate, Icon, iconBtn, KV, Refreshed, relTime, Sparkline, tzLabel, useLoad } from './ui';
import { RunActions, TermPreset } from './tabs/RunActions';
import Activities, { Activity, describe } from './tabs/Activities';
import { CustomFields, GeneralSettings, Notes } from './tabs/Settings';
import Details from './tabs/Details';
import Tools from './tabs/Tools';
import { OsPatches, SoftwareInventory, SoftwarePatches } from './tabs/Patching';

type Tab = 'overview' | 'details' | 'patching' | 'software' | 'tools' | 'activities' | 'terminal' | 'notes' | 'custom' | 'settings';
const TABS: Array<[Tab, string]> = [
  ['overview', 'Overzicht'], ['details', 'Details'], ['patching', 'Patching'], ['software', 'Software'], ['tools', 'Tools'],
  ['activities', 'Activiteiten'], ['terminal', 'Terminal'], ['notes', 'Opmerkingen'], ['custom', 'Aangepast'], ['settings', 'Instellingen'],
];
/** tabs that need the agent to answer (others show stored data) */
const LIVE: Tab[] = ['details', 'tools', 'terminal'];

const MAC_PERMS_STEPS = [
  'Meekijken op deze Mac vraagt twee toestemmingen. Doe dit op de Mac zelf:',
  '1. Open Systeeminstellingen > Privacy en beveiliging.',
  '2. Kies Schermopname en zet "claude-agent" aan (staat hij er niet? klik op + en kies /usr/local/claude-agent/claude-agent).',
  '3. Kies Toegankelijkheid en doe hetzelfde.',
  '4. Kies "Stop en heropen" als macOS dat vraagt. De melding verdwijnt binnen twee minuten.',
].join('\n');

/** Start a chat about this device: new conversation, the question runs at once (queue drains when idle). */
function useAskClaude(d: Device | null) {
  const router = useRouter();
  const addConversation = useChatStore((s) => s.addConversation);
  return useCallback(async (question: string, context?: string) => {
    if (!d) return;
    const res = await convApi.create({ title: `${d.name}: ${question.slice(0, 50)}` });
    addConversation(res.conversation);
    const msg = `Op apparaat "${d.name}" (id ${d.id}, ${osLabel(d.os)}): ${question}${context ? `\n\nContext:\n\`\`\`\n${context.slice(-6000)}\n\`\`\`` : ''}`;
    await convApi.enqueue(res.conversation.id, msg);
    router.push(`/chat/${res.conversation.id}`);
  }, [d, addConversation, router]);
}

/** Server-side tasks of this device; polls fast while something is queued or running. */
function useTasks(deviceId: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const busy = tasks.some((t) => t.status === 'queued' || t.status === 'running');
  const load = useCallback(async () => {
    try { setTasks((await api<{ tasks: Task[] }>(`/${deviceId}/tasks`)).tasks); } catch { /* keep last */ }
  }, [deviceId]);
  useEffect(() => {
    void load();
    const t = setInterval(load, busy ? 3000 : 20_000);
    return () => clearInterval(t);
  }, [load, busy]);
  return { tasks, busy, reload: load };
}

interface Line { kind: 'cmd' | 'out' | 'err' | 'info' | 'claude' | 'ccmd' | 'tool'; text: string }

/** The script Claude sends to the device: the heredoc body of its curl …/exec call. */
function deviceScript(bash: string): string | null {
  if (!/\/devices\/claude\/[^/\s"]+\/exec/.test(bash)) return null;
  const m = bash.match(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\s*$/m);
  return (m ? m[2] : bash).trim();
}

function Terminal({ d, preset }: { d: Device; preset: TermPreset | null }) {
  const isWin = d.os === 'windows';
  const [shell, setShell] = useState(preset?.shell ?? (isWin ? 'powershell' : 'zsh'));
  const [runas, setRunas] = useState<'system' | 'user'>(preset?.runas ?? 'system');
  const [bits, setBits] = useState<32 | 64>(preset?.bits ?? 64);
  const ctxLabel = `${runas === 'user' ? 'aangemelde gebruiker' : isWin ? 'SYSTEM' : 'root'}${isWin ? ` ${bits}-bit` : ''}`;
  const [mode, setMode] = useState<'cmd' | 'claude'>('cmd');
  useEffect(() => { if (preset) { setShell(preset.shell); setRunas(preset.runas); setBits(preset.bits); setMode('cmd'); } }, [preset]);
  const storeKey = `term:${d.id}`;
  const intro: Line = { kind: 'info', text: `${d.name} · Enter voert uit, pijltjes voor geschiedenis` };
  const [lines, setLines] = useState<Line[]>(() => {
    try { const v = sessionStorage.getItem(storeKey); if (v) return JSON.parse(v) as Line[]; } catch { /* ignore */ }
    return [intro];
  });
  useEffect(() => { try { sessionStorage.setItem(storeKey, JSON.stringify(lines.slice(-400))); } catch { /* full */ } }, [lines, storeKey]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<'' | 'cmd' | 'claude'>('');
  const hist = useRef<string[]>([]);
  const hi = useRef(-1);
  const end = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const convId = useRef<string | null>(null);
  const sentUpTo = useRef(0); // lines already shown to Claude
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines]);

  const add = (...l: Line[]) => setLines((x) => [...x, ...l]);
  const prompt = shell === 'cmd' ? 'C:\\>' : isWin ? 'PS>' : '%';

  async function runCommand(text: string) {
    if (text === 'clear' || text === 'cls') { setLines([]); sentUpTo.current = 0; return; }
    add({ kind: 'cmd', text: runas === 'user' || bits === 32 ? `[${ctxLabel}] ${text}` : text });
    setBusy('cmd');
    try {
      const r = await execOn(d.id, text, { shell, timeout: 600, runas, bits });
      add(...(r.output ? [{ kind: (r.ok ? 'out' : 'err') as Line['kind'], text: r.output.replace(/\s+$/, '') }] : []),
        ...(r.error ? [{ kind: 'err' as const, text: r.error }] : []),
        { kind: 'info', text: `exit ${r.exitCode ?? '?'} · ${((r.durationMs ?? 0) / 1000).toFixed(1)}s` });
    } catch (e) { add({ kind: 'err', text: (e as Error).message }); } finally { setBusy(''); }
  }

  /** Claude takes over this terminal: its commands and their output stream into the same window. */
  async function askClaude(question: string) {
    add({ kind: 'cmd', text: `Claude, ${question}` });
    setBusy('claude');
    const recent = lines.slice(sentUpTo.current).filter((l) => l.kind !== 'info' && l.kind !== 'claude')
      .map((l) => (l.kind === 'cmd' ? `${prompt} ${l.text}` : l.text)).join('\n').slice(-6000);
    sentUpTo.current = lines.length + 1;
    try {
      if (!convId.current) {
        const s = await api<{ conversationId: string; fresh: boolean }>(`/${d.id}/terminal-session`, { method: 'POST', body: '{}' });
        convId.current = s.conversationId;
      }
      const message = [
        `[Terminal op apparaat "${d.name}" (id ${d.id}, ${osLabel(d.os)}, shell ${shell}). Je neemt deze terminal over: voer de nodige commando's zelf uit op dit apparaat via de exec-route; de gebruiker ziet je commando's en de uitvoer live in de terminal. Houd je tekst kort en zakelijk, geen herhaling van uitvoer.]`,
        recent ? `Recente terminal-uitvoer:\n\`\`\`\n${recent}\n\`\`\`` : '',
        question,
      ].filter(Boolean).join('\n\n');

      const ctrl = new AbortController();
      abort.current = ctrl;
      const res = await fetch(`/api/conversations/${convId.current}/stream`, {
        method: 'POST', credentials: 'include', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, attachments: [] }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);

      const execTools = new Set<string>();
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let textOpen = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          let ev = ''; let data = '';
          for (const ln of part.split('\n')) { if (ln.startsWith('event: ')) ev = ln.slice(7).trim(); if (ln.startsWith('data: ')) data = ln.slice(6); }
          if (!data) continue;
          let o: Record<string, unknown>;
          try { o = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          if (ev === 'text' && typeof o.text === 'string') {
            const t = o.text;
            setLines((x) => {
              const last = x[x.length - 1];
              if (textOpen && last?.kind === 'claude') return [...x.slice(0, -1), { kind: 'claude', text: last.text + t }];
              return [...x, { kind: 'claude', text: t.replace(/^\s+/, '') }];
            });
            textOpen = true;
          } else if (ev === 'tool_use') {
            textOpen = false;
            const input = (o.toolInput ?? {}) as { command?: string; description?: string };
            const script = typeof input.command === 'string' ? deviceScript(input.command) : null;
            if (script) { execTools.add(String(o.toolUseId ?? '')); add({ kind: 'ccmd', text: script }); }
            else add({ kind: 'tool', text: `${String(o.toolName ?? 'tool')}: ${input.description ?? (input.command ?? '').split('\n')[0].slice(0, 160)}` });
          } else if (ev === 'tool_result') {
            textOpen = false;
            if (!execTools.has(String(o.toolUseId ?? ''))) continue;
            const raw = typeof o.content === 'string' ? o.content : JSON.stringify(o.content);
            const r = parseJson<{ ok?: boolean; output?: string; error?: string; exitCode?: number }>(raw);
            if (r) add(...(r.output ? [{ kind: (r.ok ? 'out' : 'err') as Line['kind'], text: r.output.replace(/\s+$/, '') }] : []), ...(r.error ? [{ kind: 'err' as const, text: r.error }] : []));
            else if (raw.trim()) add({ kind: 'out', text: raw.trim().slice(0, 4000) });
          } else if (ev === 'error' && typeof o.message === 'string') {
            add({ kind: 'err', text: o.message });
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') add({ kind: 'err', text: (e as Error).message });
      else add({ kind: 'info', text: 'Claude gestopt' });
    } finally {
      abort.current = null;
      setBusy('');
      sentUpTo.current = Number.MAX_SAFE_INTEGER; // set properly below
      setLines((x) => { sentUpTo.current = x.length; return x; });
    }
  }

  function stopClaude() {
    if (convId.current) void fetch(`/api/conversations/${convId.current}/stream/stop`, { method: 'POST', credentials: 'include' });
    abort.current?.abort();
  }

  async function run() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    hist.current = [text, ...hist.current.filter((h) => h !== text)].slice(0, 50);
    hi.current = -1;
    if (mode === 'claude') await askClaude(text); else await runCommand(text);
  }

  async function newSession() {
    stopClaude();
    convId.current = (await api<{ conversationId: string }>(`/${d.id}/terminal-session`, { method: 'POST', body: JSON.stringify({ fresh: true }) })).conversationId;
    setLines([intro]);
    sentUpTo.current = 0;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-(--border) overflow-hidden text-xs">
          {(['cmd', 'claude'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={clsx('px-3 py-1.5', mode === m ? 'bg-(--accent-strong) text-white' : 'text-(--muted) hover:text-(--text)')}>
              {m === 'cmd' ? 'Commando' : <span className="inline-flex items-center gap-1.5"><ClaudeLogo className="w-3.5 h-3.5 shrink-0" />Vraag Claude</span>}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-(--border) overflow-hidden text-xs">
          {(isWin ? [['powershell', 'PowerShell'], ['cmd', 'cmd'], ['pwsh', 'PowerShell 7']] : [['zsh', 'zsh'], ['bash', 'bash']]).map(([v, l]) => (
            <button key={v} onClick={() => setShell(v)} className={clsx('px-3 py-1.5', shell === v ? 'bg-(--accent-strong) text-white' : 'text-(--muted) hover:text-(--text)')}>{l}</button>
          ))}
        </div>
        {mode === 'cmd' && (
          <select value={`${runas}:${bits}`} onChange={(e) => { const [r, b] = e.target.value.split(':'); setRunas(r as 'system' | 'user'); setBits(Number(b) as 32 | 64); }}
            className="bg-(--input) border border-(--border) rounded-lg px-2 py-1.5 text-xs text-(--text)">
            {(isWin ? [['system:64', 'Systeem 64-bit'], ['system:32', 'Systeem 32-bit'], ['user:64', 'Aangemelde gebruiker 64-bit'], ['user:32', 'Aangemelde gebruiker 32-bit']] : [['system:64', 'root'], ['user:64', 'Aangemelde gebruiker']]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        <div className="flex-1" />
        {lines.some((l) => l.kind === 'err') && !busy && (
          <button className={ghost} onClick={() => { setMode('claude'); void askClaude('wat gaat hier mis? Zoek het uit en los het op.'); }}>Fout laten oplossen</button>
        )}
        <button className={ghost} disabled={!!busy && busy !== 'claude'} onClick={() => void newSession()} title="Wist het scherm en wat Claude van deze sessie weet">Nieuwe sessie</button>
      </div>
      <div className="rounded-xl border border-(--border) bg-[#0c0c10] text-[#e4e4e7] font-mono text-xs h-[55vh] overflow-y-auto p-3 space-y-1"
        onClick={() => document.getElementById(`term-in-${d.id}`)?.focus()}>
        {lines.map((l, i) => (
          <pre key={i} className={clsx('whitespace-pre-wrap break-words', {
            'text-sky-300': l.kind === 'cmd', 'text-red-400': l.kind === 'err', 'text-zinc-500': l.kind === 'info' || l.kind === 'tool',
            'text-[#e8a383] font-sans text-[13px] leading-relaxed': l.kind === 'claude', 'text-amber-300': l.kind === 'ccmd' })}>
            {l.kind === 'cmd' ? `${prompt} ${l.text}` : l.kind === 'ccmd' ? l.text.split('\n').map((x, j) => `${j === 0 ? `Claude ${prompt}` : ' '.repeat(`Claude ${prompt}`.length)} ${x}`).join('\n') : l.text}
          </pre>
        ))}
        {busy === 'cmd' && <div className="text-zinc-500">…</div>}
        {busy === 'claude' && <div className="text-[#e8a383] flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-[#e8a383] animate-pulse" />Claude werkt in de terminal…</div>}
        <div ref={end} />
      </div>
      <div className="flex items-center gap-2">
        <input id={`term-in-${d.id}`} value={input} onChange={(e) => setInput(e.target.value)} disabled={!!busy} autoComplete="off" spellCheck={false}
          placeholder={mode === 'cmd' ? (isWin ? 'Get-Service | Where Status -eq Stopped' : 'ls -la /Applications') : 'Bijvoorbeeld: waarom is deze pc traag? Of: ruim de schijf op'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void run(); }
            else if (e.key === 'ArrowUp' && hist.current.length) { e.preventDefault(); hi.current = Math.min(hi.current + 1, hist.current.length - 1); setInput(hist.current[hi.current]); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); hi.current = Math.max(hi.current - 1, -1); setInput(hi.current < 0 ? '' : hist.current[hi.current]); }
          }}
          className="flex-1 bg-(--input) border border-(--border) rounded-lg px-3 py-2 text-sm font-mono text-(--text) outline-none focus:border-(--accent)" />
        {busy === 'claude'
          ? <button className={ghost} onClick={stopClaude}>Stoppen</button>
          : <button className={primary} disabled={!!busy || !input.trim()} onClick={() => void run()}>{mode === 'cmd' ? 'Uitvoeren' : 'Vraag'}</button>}
      </div>
    </div>
  );
}


const TASK_LABEL: Record<Task['status'], string> = { queued: 'In wachtrij', running: 'Bezig', done: 'Voltooid', failed: 'Mislukt', interrupted: 'Onderbroken', cancelled: 'Geannuleerd' };

function TaskList({ d, tasks, reload, title = 'Taken', limit = 30 }: { d: Device; tasks: Task[]; reload: () => void; title?: string; limit?: number }) {
  const [open, setOpen] = useState('');
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-(--text)">{title} <span className="text-xs text-(--muted) font-normal">lopen door als je de app sluit</span></h3>
      {!tasks.length ? <p className="text-xs text-(--muted)">Geen lopende acties.</p> : (
        <div className="rounded-xl border border-(--border) divide-y divide-(--border) text-xs">
          {tasks.slice(0, limit).map((t) => (
            <div key={t.id} className="px-3 py-2">
              <div className="flex items-center gap-3">
                <span className={clsx('w-2 h-2 rounded-full shrink-0', {
                  'bg-(--accent) animate-pulse': t.status === 'running', 'bg-zinc-400': t.status === 'queued' || t.status === 'cancelled',
                  'bg-green-500': t.status === 'done', 'bg-red-400': t.status === 'failed', 'bg-yellow-500': t.status === 'interrupted' })} />
                <button className="flex-1 min-w-0 text-left truncate text-(--text)" onClick={() => setOpen(open === t.id ? '' : t.id)}>{t.label}</button>
                <span className="text-(--muted) shrink-0">
                  {TASK_LABEL[t.status]}{t.status === 'queued' && t.runAt && new Date(t.runAt) > new Date() ? `, gepland ${relTime(t.runAt)}` : t.finishedAt ? `, ${ago(t.finishedAt)}` : t.startedAt ? `, sinds ${ago(t.startedAt)}` : !d.online && t.status === 'queued' ? ', wacht tot online' : ''}
                </span>
                {t.status === 'queued' && <button className="text-red-400 hover:underline shrink-0" onClick={() => void cancelTask(d.id, t.id).then(reload)}>Annuleren</button>}
              </div>
              {open === t.id && t.result && (
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-(--bg) border border-(--border) p-2 max-h-60 overflow-auto font-mono">
                  {(t.result.output || t.result.error || '').trim() || 'Geen uitvoer.'}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Sample { t: number; cpu: number; cores?: number; memPct: number; memUsedGB: number; memTotalGB: number; disks: Array<{ drive: string; pct: number; usedGB: number; sizeGB: number }>; net: Array<{ name: string; rx: number; tx: number; ipv4?: string }>; diskBusy?: number; procs?: number; uptimeH?: number; users?: string[] }
interface Info { biosVersion?: string; biosDate?: string; releaseId?: string; build?: string; edition?: string; productKey?: string; lastUser?: string; lastLogin?: string; domain?: string; partOfDomain?: boolean; chassis?: number[]; fqdn?: string; installDate?: string; idleMin?: number; timezone?: string }

const INFO_WIN = `$ErrorActionPreference = 'SilentlyContinue'
$b = Get-CimInstance Win32_BIOS; $cs = Get-CimInstance Win32_ComputerSystem; $os = Get-CimInstance Win32_OperatingSystem
$cv = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$pk = (Get-CimInstance SoftwareLicensingProduct -Filter "PartialProductKey IS NOT NULL AND ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f'" | Select-Object -First 1).PartialProductKey
$lp = Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LastUseTime } | Sort-Object LastUseTime -Descending | Select-Object -First 1
$lu = try { (New-Object System.Security.Principal.SecurityIdentifier($lp.SID)).Translate([System.Security.Principal.NTAccount]).Value } catch { '' }
$fq = try { [System.Net.Dns]::GetHostEntry('').HostName } catch { $env:COMPUTERNAME }
ConvertTo-Json -Compress -InputObject @{ biosVersion = $b.SMBIOSBIOSVersion; biosDate = if ($b.ReleaseDate) { $b.ReleaseDate.ToString('o') } else { '' }; releaseId = if ($cv.DisplayVersion) { $cv.DisplayVersion } else { $cv.ReleaseId }; build = "$($cv.CurrentBuild).$($cv.UBR)"; edition = $cv.EditionID; productKey = $pk; lastUser = $lu; lastLogin = if ($lp) { $lp.LastUseTime.ToString('o') } else { '' }; domain = $cs.Domain; partOfDomain = $cs.PartOfDomain; chassis = @((Get-CimInstance Win32_SystemEnclosure).ChassisTypes); fqdn = $fq; installDate = $os.InstallDate.ToString('o'); timezone = (Get-TimeZone).Id }`;
const INFO_MAC = `u=$(stat -f%Su /dev/console); last1=$(last -1 "$u" 2>/dev/null | head -1 | awk '{print $4" "$5" "$6" "$7}')
idle=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000/60); exit}')
printf '{"releaseId":"%s","build":"%s","lastUser":"%s","lastLoginText":"%s","fqdn":"%s","idleMin":%s,"timezone":"%s"}' "$(sw_vers -productVersion)" "$(sw_vers -buildVersion)" "$u" "$last1" "$(hostname -f)" "\${idle:-0}" "$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"`;

function MetricCard({ title, value, sub, values, values2, max, onMore }: { title: string; value: React.ReactNode; sub?: React.ReactNode; values: number[]; values2?: number[]; max?: number; onMore?: () => void }) {
  return (
    <div className="rounded-xl border border-(--border) bg-(--input) p-3 space-y-1 min-w-0">
      <div className="flex items-center gap-2 text-xs text-(--muted)"><span className="flex-1">{title}</span>{onMore && <button className="text-(--accent) hover:underline" onClick={onMore}>Details</button>}</div>
      <div className="text-lg font-semibold text-(--text) tabular-nums truncate">{value}</div>
      {sub && <div className="text-xs text-(--muted) truncate">{sub}</div>}
      <Sparkline values={values} values2={values2} max={max} />
      <div className="text-[11px] text-(--muted)">Afgelopen uur</div>
    </div>
  );
}

function Overview({ d, tasks, reloadTasks, onDevice, openTab, latestAgent }: { d: Device; tasks: Task[]; reloadTasks: () => void; onDevice: (d: Device) => void; openTab: (t: string) => void; latestAgent: string | null }) {
  const isWin = d.os === 'windows';
  const inv = d.inventory ?? {};
  const [hist, setHist] = useState<Sample[]>([]);
  const [mAt, setMAt] = useState<number | null>(null);
  const [mErr, setMErr] = useState('');
  const loadMetrics = useCallback(async () => {
    try { const r = await api<{ online: boolean; history: Sample[] }>(`/${d.id}/metrics`); setHist(r.history); setMAt(Date.now()); setMErr(''); } catch (e) { setMErr((e as Error).message); }
  }, [d.id]);
  useEffect(() => { void loadMetrics(); const t = setInterval(loadMetrics, 60_000); return () => clearInterval(t); }, [loadMetrics]);
  const info = useLoad(async () => {
    const r = await execOn(d.id, isWin ? INFO_WIN : INFO_MAC, { tool: 'view:overview-info', timeout: 60 });
    return parseJson<Info & { lastLoginText?: string }>(r.output);
  }, [d.id], { enabled: d.online });
  const acts = useLoad(() => api<{ activities: Activity[] }>(`/${d.id}/activities?days=7`).then((r) => r.activities.slice(0, 10)), [d.id]);

  const last = hist.at(-1);
  const drives = last?.disks ?? (inv.disks ?? []).map((x) => ({ drive: x.drive, sizeGB: x.sizeGB, usedGB: Math.round((x.sizeGB - x.freeGB) * 10) / 10, pct: x.sizeGB ? Math.round(((x.sizeGB - x.freeGB) / x.sizeGB) * 100) : 0 }));
  const nets = (last?.net ?? []).filter((n) => n.ipv4 || n.rx || n.tx);
  const alertsAll = alertsOf(d, latestAgent, { all: true });
  const alerts = alertsOf(d, latestAgent);
  const live = tasks.filter((t) => t.status === 'queued' || t.status === 'running');
  const i = info.data;
  const laptop = (i?.chassis ?? []).some((c) => [8, 9, 10, 14, 30, 31, 32].includes(c));
  const role = d.role || (isWin ? (/server/i.test(inv.os ?? d.os_name ?? '') ? 'Windows Server' : laptop ? 'Windows Laptop' : 'Windows Workstation') : /book/i.test(inv.model ?? '') ? 'Mac Laptop' : 'Mac Workstation');
  const c = d.custom ?? {};
  const s = (v: unknown) => (v == null ? '' : String(v));
  const uptimeH = last?.uptimeH ?? (inv.lastBoot ? (Date.now() - new Date(inv.lastBoot).getTime()) / 3600e3 : null);

  async function act(label: string, command: string, tool: string, timeout = 120) {
    if (!confirm(`${label} op ${d.name}?`)) return;
    if (timeout > 120) { await queueTask(d.id, command, label, tool, timeout).catch((e) => alert((e as Error).message)); reloadTasks(); return; }
    const r = await execOn(d.id, command, { tool, timeout }).catch((e) => ({ ok: false, output: '', error: (e as Error).message }));
    alert(r.output || r.error || (r.ok ? 'Klaar.' : 'Mislukt.'));
  }
  async function ack(text: string) {
    try { onDevice((await api<{ device: Device }>(`/${d.id}`, { method: 'PATCH', body: JSON.stringify({ alerts_ack: [...(d.alerts_ack ?? []), text] }) })).device); } catch (e) { alert((e as Error).message); }
  }
  /** Action button per health issue */
  function fix(text: string): React.ReactNode {
    const b = (label: string, fn: () => void, disabled = !d.online) => <button className="text-xs text-(--accent) hover:underline disabled:opacity-40" disabled={disabled} onClick={fn}>{label}</button>;
    if (/^Meekijken: toestemming/.test(text)) return b('Stappen', () => alert(MAC_PERMS_STEPS), false);
    if (/^Herstart nodig/.test(text)) return b('Herstarten', () => void act('Herstarten', isWin ? 'shutdown.exe /r /t 60 /c "Herstart via Claude Chat"; "Herstart over 60 seconden"' : 'shutdown -r +1 && echo "Herstart over 1 minuut"', 'reboot'));
    if (/^Defender/.test(text)) return b('Bijwerken', () => void act('Defender bijwerken', 'Update-MpSignature; Set-MpPreference -DisableRealtimeMonitoring $false; (Get-MpComputerStatus) | Select-Object AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated | Format-List | Out-String', 'av-update', 600));
    if (/^Schijf/.test(text)) return b('Opruimen', () => void act('Tijdelijke bestanden opruimen', isWin ? `$before = (Get-PSDrive C).Free\nGet-ChildItem 'C:\\Windows\\Temp', 'C:\\Users\\*\\AppData\\Local\\Temp' -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue\n"Vrijgekomen: $([math]::Round(((Get-PSDrive C).Free - $before) / 1MB)) MB"` : 'rm -rf /private/var/folders/*/*/T/* 2>/dev/null; echo "Opgeruimd"', 'temp', 600));
    if (/^Agent/.test(text)) return b('Bijwerken', () => { if (confirm('Agent bijwerken?')) void api(`/${d.id}/update`, { method: 'POST' }).then(() => alert('Update gestart.')).catch((e) => alert((e as Error).message)); });
    if (/^Laatste update/.test(text)) return b('Patches', () => openTab('patching:os'), false);
    if (/BitLocker|FileVault/.test(text)) return b('Details', () => openTab('details'), false);
    if (/^Firewall/.test(text)) return b('Inschakelen', () => void act('Firewall inschakelen', isWin ? 'Set-NetFirewallProfile -All -Enabled True; Get-NetFirewallProfile | Select-Object Name, Enabled | Format-Table | Out-String' : '/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on', 'firewall-on'));
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-(--muted)"><span className="flex-1" />{mErr && <span className="text-red-400">{mErr}</span>}<Refreshed at={mAt} onRefresh={() => { void loadMetrics(); void info.load(); void acts.load(); }} /></div>
      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
        <MetricCard title="CPU" value={last ? `${last.cpu}%` : '...'} sub={`${last?.cores ?? inv.cores ?? '?'} logische processors`} values={hist.map((x) => x.cpu)} max={100} onMore={() => openTab('details:cpu')} />
        <MetricCard title="Geheugen" value={last ? `${last.memPct}%` : '...'} sub={last ? `${last.memUsedGB} / ${last.memTotalGB} GB` : inv.ramGB ? `${inv.ramGB} GB` : ''} values={hist.map((x) => x.memPct)} max={100} onMore={() => openTab('details:memory')} />
        <MetricCard title="Schijven" value={drives.length ? `${Math.max(...drives.map((x) => x.pct))}%` : '...'}
          sub={drives.map((x) => `${x.drive} ${x.pct}% (${x.usedGB}/${x.sizeGB} GB)`).join(' · ')} values={hist.map((x) => x.diskBusy ?? Math.max(0, ...x.disks.map((y) => y.pct)))} max={100} onMore={() => openTab('details:disks')} />
        <MetricCard title="Netwerk" value={nets[0] ? fmtRate(nets.reduce((a, n) => a + n.rx + n.tx, 0)) : (inv.ips ?? [])[0] ?? '...'}
          sub={nets.map((n) => `${n.name}${n.ipv4 ? ` ${n.ipv4}` : ''}`).join(' · ') || (inv.ips ?? []).join(', ')}
          values={hist.map((x) => x.net.reduce((a, n) => a + n.rx, 0))} values2={hist.map((x) => x.net.reduce((a, n) => a + n.tx, 0))} onMore={() => openTab('details:network')} />
      </div>
      {drives.length > 1 && (
        <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 text-xs">
          {drives.map((x) => <div key={x.drive} className="flex items-center gap-2"><span className="w-14 truncate text-(--muted)">{x.drive}</span><UsageBar pct={x.pct} className="flex-1" /><span className="tabular-nums text-(--muted)">{x.usedGB} / {x.sizeGB} GB</span></div>)}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Apparaatinformatie" className="lg:col-span-2" right={info.busy ? <span className="text-xs text-(--muted)">Ophalen…</span> : null}>
          <KV cols={2} rows={[
            ['Besturingssysteem', `${inv.os ?? d.os_name ?? ''}${i?.releaseId ? ` ${i.releaseId}` : ''}${i?.build ? `, build ${i.build}` : inv.build ? `, build ${inv.build}` : ''}`],
            ['BIOS', i?.biosVersion ? `${i.biosVersion}${i.biosDate ? ` (${fmtDate(i.biosDate)})` : ''}` : ''],
            ['Productsleutel', i?.productKey ? `*****-*****-*****-*****-${i.productKey}` : ''],
            ['Fabrikant / model', [inv.manufacturer, inv.model].filter(Boolean).join(' ')],
            ['Serienummer', inv.serial],
            ['Apparaatnaam', i?.fqdn || d.hostname],
            ['Garantie', c.warranty_end ? `${c.warranty_start ? `${fmtDate(s(c.warranty_start))} - ` : 'tot '}${fmtDate(s(c.warranty_end))}${new Date(s(c.warranty_end)) < new Date() ? ' (verlopen)' : ''}` : <button className="text-(--accent) hover:underline" onClick={() => openTab('custom')}>Invullen</button>],
            ['Actieve tijd', uptimeH != null ? (uptimeH < 48 ? `${Math.round(uptimeH)} uur` : `${Math.round(uptimeH / 24)} dagen`) : ''],
            ['Ingelogde gebruiker', (last?.users ?? []).length ? last!.users!.join(', ') : inv.user || 'niemand'],
            ['Inactief', i?.idleMin != null && i.idleMin > 0 ? `${i.idleMin} min` : ''],
            ['Laatste login', i?.lastUser ? `${i.lastUser}${i.lastLogin ? `, ${relTime(i.lastLogin)}` : i.lastLoginText ? `, ${i.lastLoginText}` : ''}` : ''],
            ['Domein', i?.domain ? `${i.domain}${i.partOfDomain ? '' : ' (werkgroep)'}` : ''],
            ['Rol', role],
            ['Organisatie', d.org ? <button className="text-(--accent) hover:underline" onClick={() => openTab('settings')}>{d.org}</button> : ''],
            ['Locatie', d.location],
            ['Toegewezen gebruiker', d.assigned_user],
            ['IP intern', (inv.ips ?? []).join(', ')], ['IP extern', d.last_ip],
            ['Agent', `${d.agent_version ?? '?'}${d.inventory_at ? `, inventaris ${ago(d.inventory_at)}` : ''}`],
          ]} />
          <button className="text-xs text-(--accent) hover:underline" onClick={() => openTab('details:hardware')}>Meer bekijken</button>
        </Card>

        <div className="space-y-4 min-w-0">
          <Card title="Gezondheidsproblemen" right={inMaintenance(d) ? <Badge tone="warn">Onderhoudsmodus</Badge> : null}>
            {inMaintenance(d) && <p className="text-xs text-(--muted)">Onderdrukt tot {relTime(d.maintenance_until)}{d.maintenance_reason ? `: ${d.maintenance_reason}` : ''}.</p>}
            {!alerts.length && !inMaintenance(d) ? <Badge tone="ok">Geen problemen</Badge> : (
              <div className="space-y-1.5">
                {(inMaintenance(d) ? alertsAll : alerts).map((a) => (
                  <div key={a.text} className="flex items-center gap-2 text-xs">
                    <span className={clsx('w-2 h-2 rounded-full shrink-0', a.tone === 'bad' ? 'bg-red-400' : 'bg-yellow-500')} />
                    <span className="flex-1 min-w-0 text-(--text)">{a.text}</span>
                    {fix(a.text)}
                    {!inMaintenance(d) && <button className="text-xs text-(--muted) hover:text-(--text)" onClick={() => void ack(a.text)} title="Wegzetten tot de situatie verandert">Negeren</button>}
                  </div>
                ))}
              </div>
            )}
            {(d.alerts_ack ?? []).filter((t) => alertsAll.some((a) => a.text === t)).length > 0 && (
              <button className="text-xs text-(--muted) hover:text-(--text)" onClick={async () => onDevice((await api<{ device: Device }>(`/${d.id}`, { method: 'PATCH', body: JSON.stringify({ alerts_ack: [] }) })).device)}>
                {(d.alerts_ack ?? []).filter((t) => alertsAll.some((a) => a.text === t)).length} genegeerd, weer tonen
              </button>
            )}
          </Card>
          <Card><TaskList d={d} tasks={live} reload={reloadTasks} title="Taken in verwerking" limit={10} /></Card>
        </div>
      </div>

      <Card title="Activiteiten" right={<span className="text-xs text-(--muted)">{tzLabel}</span>}>
        {!acts.data ? <p className="text-xs text-(--muted)">Laden…</p> : !acts.data.length ? <p className="text-xs text-(--muted)">Geen activiteiten deze week.</p> : (
          <ol className="relative border-l border-(--border) ml-1.5 space-y-3">
            {acts.data.map((a) => { const x = describe(a); return (
              <li key={a.id} className="ml-4">
                <span className={clsx('absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full border-2 border-(--input)', x.tone === 'bad' ? 'bg-red-400' : x.tone === 'ok' ? 'bg-green-500' : 'bg-zinc-400')} />
                <div className="text-xs"><span className="text-(--text) font-medium">{x.group}: {x.status}</span> <span className="text-(--muted)">{relTime(a.created_at)}{a.user_name ? `, ${a.user_name}` : ''}</span></div>
                <div className="text-xs text-(--muted) truncate">{x.text}</div>
              </li>
            ); })}
          </ol>
        )}
        <button className="text-xs text-(--accent) hover:underline" onClick={() => openTab('activities')}>Alle activiteiten</button>
      </Card>
      <ErrorText err={info.err} />
    </div>
  );
}

const queueTask = (id: string, command: string, label: string, tool: string, timeout: number) =>
  api(`/${id}/tasks`, { method: 'POST', body: JSON.stringify({ items: [{ command, label, tool, timeout }] }) });

// ── Page ─────────────────────────────────────────────────────

export default function DeviceDetail({ id }: { id: string }) {
  const [d, setD] = useState<Device | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTabState] = useState<Tab>('overview');
  const [sub, setSub] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [question, setQuestion] = useState('');
  const [preset, setPreset] = useState<TermPreset | null>(null);
  const [latestAgent, setLatestAgent] = useState<string | null>(null);
  const ask = useAskClaude(d);
  const { tasks, busy: tasksBusy, reload: reloadTasks } = useTasks(id);
  // tabs stay mounted once opened, so switching does not lose what you were doing
  const [visited, setVisited] = useState<Set<Tab>>(new Set(['overview']));

  // tab in the URL hash (#patching:os), so a link or reload lands on the same place
  const openTab = useCallback((v: string) => {
    const [t, s] = v.split(':') as [Tab, string | undefined];
    if (!TABS.some(([k]) => k === t)) return;
    setTabState(t); setSub(s ?? '');
    setVisited((x) => (x.has(t) ? x : new Set(x).add(t)));
    if (typeof window !== 'undefined') history.replaceState(null, '', `#${v}`);
  }, []);
  useEffect(() => { const h = window.location.hash.slice(1); if (h) openTab(h); }, [openTab]);

  const load = useCallback(async () => {
    try { setD((await api<{ device: Device }>(`/${id}`)).device); } catch (e) { setErr((e as Error).message); }
  }, [id]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    const now = () => { void load(); };
    const vis = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('cc:devices-changed', now);
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); window.removeEventListener('cc:devices-changed', now); document.removeEventListener('visibilitychange', vis); };
  }, [load]);
  useEffect(() => { void api<{ latestAgent: string | null }>('').then((r) => setLatestAgent(r.latestAgent)).catch(() => undefined); }, []);

  if (err) return <div className="space-y-3"><Link href="/settings/apparaten" className="text-sm text-(--accent)">Apparaten</Link><p className="text-sm text-red-400">{err}</p></div>;
  if (!d) return <p className="text-sm text-(--muted)">Laden…</p>;
  const inv = d.inventory ?? {};
  const h = health(d, latestAgent);
  const title = deviceTitle(d);
  const tabLabel = TABS.find(([k]) => k === tab)?.[1] ?? '';

  async function toggleFav() {
    if (!d) return;
    const fav = !d.favorite;
    setD({ ...d, favorite: fav });
    await api(`/${d.id}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite: fav }) }).catch(() => setD({ ...d, favorite: !fav }));
  }

  const panes: Array<[Tab, React.ReactNode]> = [
    ['details', <Details key="de" d={d} ask={ask} section={tab === 'details' ? sub : undefined} />],
    ['patching', <Patching key="pa" d={d} tasks={tasks} reload={reloadTasks} sub={sub} setSub={(s) => openTab(`patching:${s}`)} />],
    ['software', <SoftwareInventory key="sw" d={d} tasks={tasks} reload={reloadTasks} />],
    ['tools', <Tools key="to" d={d} />],
    ['activities', <Activities key="ac" d={d} />],
    ['terminal', <Terminal key="te" d={d} preset={preset} />],
    ['notes', <Notes key="no" d={d} onChanged={() => void load()} />],
    ['custom', <CustomFields key="cu" d={d} onDevice={setD} />],
    ['settings', <SettingsPane key="se" d={d} onDevice={setD} tasks={tasks} reload={reloadTasks} />],
  ];

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-1 text-xs text-(--muted)">
        <Link href="/settings/apparaten" className="hover:text-(--text)">Apparaten</Link>
        {d.org && <><span>/</span><Link href={`/settings/apparaten?q=${encodeURIComponent(d.org)}`} className="hover:text-(--text)">{d.org}</Link></>}
        {d.location && <><span>/</span><Link href={`/settings/apparaten?q=${encodeURIComponent(d.location)}`} className="hover:text-(--text)">{d.location}</Link></>}
        <span>/</span><button className="hover:text-(--text)" onClick={() => openTab('overview')}>{title}</button>
        {tab !== 'overview' && <><span>/</span><span className="text-(--text)">{tabLabel}</span></>}
      </nav>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-(--border) bg-(--input) overflow-visible">
        <span className={clsx('self-stretch w-1.5 rounded-l-xl', h === 'bad' ? 'bg-red-500' : h === 'warn' ? 'bg-yellow-500' : 'bg-green-500')} />
        <span className="relative shrink-0 py-3">
          <span className="w-11 h-11 rounded-xl bg-indigo-500 text-white flex items-center justify-center"><DeviceIcon className="w-6 h-6" /></span>
        </span>
        <div className="flex-1 min-w-[12rem] py-3">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-xl font-semibold text-(--text) truncate min-w-0">{title}</h2>
            <button onClick={() => void toggleFav()} title={d.favorite ? 'Uit favorieten' : 'Aan favorieten toevoegen'} className={clsx('shrink-0', d.favorite ? 'text-yellow-500' : 'text-(--muted) hover:text-(--text)')}>
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill={d.favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z" /></svg>
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--muted)">
            <span className={clsx('font-medium', h === 'bad' ? 'text-red-400' : h === 'warn' ? 'text-yellow-500' : 'text-green-500')}>{h === 'bad' ? 'Ongezond' : h === 'warn' ? 'Aandacht' : 'Gezond'}</span>
            <span className="inline-flex items-center gap-1.5"><span className={clsx('w-2 h-2 rounded-full', d.online ? 'bg-green-500' : 'bg-zinc-400')} />{d.online ? 'Online' : `Offline, ${ago(d.last_seen_at)}`}</span>
            {inMaintenance(d) && <Badge tone="warn">Onderhoud tot {relTime(d.maintenance_until)}</Badge>}
            <span className="truncate">{[osLabel(d.os), inv.os ?? d.os_name, inv.model, d.assigned_user || inv.user].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-3">
          <RunActions d={d} reloadTasks={reloadTasks} onDevice={setD} openTab={openTab} openTerminal={(p) => { setPreset({ ...p }); openTab('terminal'); }} />
          <span className="w-px h-6 bg-(--border) mx-1" />
          <button className={clsx(iconBtn, 'relative')} onClick={() => openTab('notes')} title="Opmerkingen" aria-label="Opmerkingen">
            <Icon name="note" />
            {(d.notes_count ?? 0) > 0 && <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-(--accent-strong) text-white text-[11px] leading-4 text-center">{d.notes_count}</span>}
          </button>
          <button className={iconBtn} onClick={() => openTab('settings')} title="Bewerken" aria-label="Bewerken"><Icon name="pencil" /></button>
          <button className={iconBtn} disabled={refreshing || !d.online} title="Inventaris opnieuw ophalen" aria-label="Inventaris verversen" onClick={async () => {
            setRefreshing(true);
            try { setD((await api<{ device: Device }>(`/${d.id}/refresh`, { method: 'POST' })).device); } catch (e) { alert((e as Error).message); }
            setRefreshing(false);
          }}><Icon name="refresh" className={clsx('w-[18px] h-[18px]', refreshing && 'animate-spin')} /></button>
        </div>
      </div>

      {/* Ask Claude about this device: opens a chat that already has the question running */}
      <div className="flex items-center gap-2 rounded-xl border border-(--border) bg-(--input) pl-3 pr-1.5 py-1.5">
        <ClaudeLogo className="w-4 h-4 shrink-0" />
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={`Vraag Claude iets over ${title}`}
          onKeyDown={(e) => { if (e.key === 'Enter' && question.trim()) void ask(question.trim()); }}
          className="flex-1 bg-transparent text-sm text-(--text) outline-none py-1" />
        <button className={primary} disabled={!question.trim()} onClick={() => void ask(question.trim())}>Vraag</button>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-(--border) -mx-1 px-1">
        {TABS.map(([t, label]) => (
          <button key={t} onClick={() => openTab(t)}
            className={clsx('px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors', tab === t ? 'border-(--accent) text-(--text)' : 'border-transparent text-(--muted) hover:text-(--text)')}>
            {label}
            {t === 'notes' && (d.notes_count ?? 0) > 0 && <span className="ml-1 text-xs text-(--muted)">{d.notes_count}</span>}
            {t === 'settings' && tasksBusy && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-(--accent) animate-pulse align-middle" />}
          </button>
        ))}
      </div>

      {LIVE.includes(tab) && !d.online && <p className="text-sm text-(--muted)">{title} is offline; dit werkt zodra het apparaat weer online is.</p>}
      {tab === 'overview' && <Overview d={d} tasks={tasks} reloadTasks={reloadTasks} onDevice={setD} openTab={openTab} latestAgent={latestAgent} />}
      {panes.map(([t, node]) => (visited.has(t) && (d.online || !LIVE.includes(t)) ? (
        <div key={t} className={tab === t ? '' : 'hidden'}>{node}</div>
      ) : null))}
    </div>
  );
}

function Patching({ d, tasks, reload, sub, setSub }: { d: Device; tasks: Task[]; reload: () => void; sub: string; setSub: (s: string) => void }) {
  const which = sub === 'software' ? 'software' : 'os';
  return (
    <div className="space-y-3">
      <Chips items={[['os', 'OS-patches'], ['software', 'Softwarepatches']]} value={which} onChange={setSub} />
      <div className={which === 'os' ? '' : 'hidden'}><OsPatches d={d} tasks={tasks} reload={reload} /></div>
      <div className={which === 'software' ? '' : 'hidden'}><SoftwarePatches d={d} tasks={tasks} reload={reload} /></div>
    </div>
  );
}

function SettingsPane({ d, onDevice, tasks, reload }: { d: Device; onDevice: (d: Device) => void; tasks: Task[]; reload: () => void }) {
  return (
    <div className="space-y-6">
      <GeneralSettings d={d} onDevice={onDevice} />
      <Card><TaskList d={d} tasks={tasks} reload={reload} title="Alle taken (7 dagen)" limit={100} /></Card>
    </div>
  );
}
