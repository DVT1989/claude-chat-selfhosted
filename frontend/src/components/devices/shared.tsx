'use client';

import clsx from 'clsx';

export interface Disk { drive: string; sizeGB: number; freeGB: number }
export interface Inventory {
  manufacturer?: string; model?: string; serial?: string; cpu?: string; cores?: number | string; ramGB?: number;
  os?: string; build?: string; lastBoot?: string; user?: string; disks?: Disk[];
  encryption?: Array<{ drive: string; status: string; percent?: number; name?: string }>;
  defender?: { enabled?: boolean; realtime?: boolean; signatureAgeDays?: number; lastQuickScan?: string } | null;
  firewall?: Array<{ name: string; enabled: boolean }>;
  lastUpdate?: string; lastUpdateId?: string; rebootPending?: boolean; ips?: string[]; appCount?: number;
  apps?: Array<{ name: string; version?: string; publisher?: string }>; agentVersion?: string;
  remotePerms?: { screen?: boolean; accessibility?: boolean };
}
export interface Device {
  id: string; name: string; hostname: string | null; os: string | null; os_name: string | null; arch: string | null;
  agent_version: string | null; enabled: boolean; online: boolean; inventory: Inventory | null; inventory_at: string | null;
  last_seen_at: string | null; last_ip: string | null; created_at: string; owner?: string | null;
  display_name?: string | null; org?: string | null; location?: string | null; assigned_user?: string | null; role?: string | null;
  custom?: Record<string, string | number | boolean | null>; maintenance_until?: string | null; maintenance_reason?: string | null;
  alerts_ack?: string[]; notes_count?: number; favorite?: boolean;
}
export interface ExecResult { ok: boolean; exitCode?: number; output: string; error?: string; durationMs?: number }

/** Admin switch "Alle gebruikers": lives in memory only (off after a reload); the server checks the role. */
let allUsers = false;
export const getAllUsers = () => allUsers;
export const setAllUsers = (v: boolean) => { allUsers = v; };
/** Header for every device request; empty unless the admin switch is on. */
export const scopeHeaders = (): Record<string, string> => (allUsers ? { 'x-devices-all': '1' } : {});

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/devices${path}`, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...scopeHeaders(), ...(init?.headers as Record<string, string> | undefined) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Runs a command on the device (audited server-side); tool names the button that sent it. */
export interface ExecOpts { shell?: string; timeout?: number; tool?: string; runas?: 'system' | 'user'; elevated?: boolean; bits?: 32 | 64 }
/** tool "view:..." marks a read-only call (lists, details): kept out of the activity feed by default. */
export function execOn(id: string, command: string, opts: ExecOpts = {}): Promise<ExecResult> {
  return api<ExecResult>(`/${id}/exec`, { method: 'POST', body: JSON.stringify({ command, ...opts }) });
}

export interface Task {
  id: string; label: string; tool: string | null; status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
  result: ExecResult | null; createdAt: string; startedAt: string | null; finishedAt: string | null; runAt?: string | null;
}
export interface TaskItem { command: string; label: string; tool?: string; shell?: string; timeout?: number; runAt?: string; runas?: 'system' | 'user' }

/** Queues work on the server: runs one at a time per device, also with the app closed. */
export const queueTasks = (id: string, items: TaskItem[]) => api<{ ids: string[] }>(`/${id}/tasks`, { method: 'POST', body: JSON.stringify({ items }) });
export const cancelTask = (id: string, taskId: string) => api(`/${id}/tasks/${taskId}`, { method: 'DELETE' });

/** Parses JSON printed by a script; tolerates a leading BOM or noise before the first bracket. */
export function parseJson<T>(out: string): T | null {
  const s = out.replace(/^\uFEFF/, '').trim();
  const i = s.search(/[[{]/);
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)) as T; } catch { return null; }
}

export const btn = 'text-sm font-medium px-3.5 py-2 rounded-lg transition-[filter,transform,background-color] duration-150 active:scale-[0.97] disabled:opacity-50';
export const ghost = `${btn} bg-(--bg) border border-(--border) text-(--text) hover:bg-(--border)`;
export const primary = `${btn} bg-(--accent-strong) text-white hover:brightness-95`;

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'nooit';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'zojuist';
  if (s < 3600) return `${Math.round(s / 60)} min geleden`;
  if (s < 86400) return `${Math.round(s / 3600)} uur geleden`;
  return `${Math.round(s / 86400)} dagen geleden`;
}
export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const osLabel = (os: string | null) => (os === 'windows' ? 'Windows' : os === 'darwin' ? 'Mac' : os === 'browser' ? 'Browser' : os === 'nasbrowser' ? 'Browser (NAS)' : os ?? '?');

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; children: React.ReactNode }) {
  return (
    <span className={clsx('inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap', {
      'bg-green-500/10 border-green-500/30 text-green-500': tone === 'ok',
      'bg-yellow-500/10 border-yellow-500/30 text-yellow-500': tone === 'warn',
      'bg-red-500/10 border-red-500/30 text-red-400': tone === 'bad',
      'bg-(--bg) border-(--border) text-(--muted)': tone === 'muted',
    })}>{children}</span>
  );
}

export function UsageBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={clsx('h-1.5 rounded-full bg-(--border) overflow-hidden', className)}>
      <div className={clsx('h-full rounded-full', pct > 90 ? 'bg-red-400' : pct > 75 ? 'bg-yellow-500' : 'bg-indigo-500')} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

export function DiskBar({ d }: { d: Disk }) {
  const used = d.sizeGB > 0 ? Math.round(((d.sizeGB - d.freeGB) / d.sizeGB) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 shrink-0 text-(--muted)">{d.drive}</span>
      <UsageBar pct={used} className="flex-1" />
      <span className="shrink-0 tabular-nums text-(--muted)">{d.freeGB} / {d.sizeGB} GB vrij</span>
    </div>
  );
}

export const diskUsedPct = (inv: Inventory | null) =>
  Math.max(0, ...(inv?.disks ?? []).map((d) => (d.sizeGB > 0 ? Math.round(((d.sizeGB - d.freeGB) / d.sizeGB) * 100) : 0)));

/** Issues worth a look, NinjaOne-style: shown as alerts and used by the "Aandacht" filter. */
export function alertsOf(d: Device, latestAgent: string | null, opts: { all?: boolean } = {}): Array<{ tone: 'warn' | 'bad'; text: string }> {
  const list = rawAlerts(d, latestAgent);
  if (opts.all) return list;
  if (inMaintenance(d)) return [];
  const ack = new Set(d.alerts_ack ?? []);
  return list.filter((a) => !ack.has(a.text));
}
export const inMaintenance = (d: Device) => !!d.maintenance_until && new Date(d.maintenance_until).getTime() > Date.now();
export function health(d: Device, latestAgent: string | null = null): 'ok' | 'warn' | 'bad' {
  const a = alertsOf(d, latestAgent);
  return a.some((x) => x.tone === 'bad') ? 'bad' : a.length ? 'warn' : 'ok';
}
export const deviceTitle = (d: Device) => d.display_name || d.name;

function rawAlerts(d: Device, latestAgent: string | null): Array<{ tone: 'warn' | 'bad'; text: string }> {
  const inv = d.inventory;
  const out: Array<{ tone: 'warn' | 'bad'; text: string }> = [];
  if (d.os === 'nasbrowser') return out;
  if (!d.online && d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() > 86400e3) out.push({ tone: 'warn', text: `Offline sinds ${ago(d.last_seen_at)}` });
  if (!inv) return out;
  const disk = diskUsedPct(inv);
  if (disk > 90) out.push({ tone: 'bad', text: `Schijf ${disk}% vol` });
  else if (disk > 80) out.push({ tone: 'warn', text: `Schijf ${disk}% vol` });
  if (inv.rebootPending) out.push({ tone: 'warn', text: 'Herstart nodig' });
  if (d.os === 'darwin' && inv.remotePerms && (!inv.remotePerms.screen || !inv.remotePerms.accessibility)) out.push({ tone: 'warn', text: `Meekijken: toestemming ontbreekt (${[!inv.remotePerms.screen && 'Schermopname', !inv.remotePerms.accessibility && 'Toegankelijkheid'].filter(Boolean).join(' en ')})` });
  const enc = inv.encryption ?? [];
  if (enc.length && !enc.every((e) => /on/i.test(e.status))) out.push({ tone: 'bad', text: `${d.os === 'darwin' ? 'FileVault' : 'BitLocker'} uit` });
  if (d.os === 'windows' && inv.defender && !(inv.defender.enabled && inv.defender.realtime)) out.push({ tone: 'bad', text: 'Defender uit' });
  if (d.os === 'windows' && (inv.defender?.signatureAgeDays ?? 0) > 3) out.push({ tone: 'warn', text: `Defender-definities ${inv.defender?.signatureAgeDays} dagen oud` });
  if ((inv.firewall ?? []).some((f) => !f.enabled)) out.push({ tone: 'warn', text: 'Firewall (deels) uit' });
  if (inv.lastUpdate && Date.now() - new Date(inv.lastUpdate).getTime() > 45 * 86400e3) out.push({ tone: 'warn', text: `Laatste update ${fmtDate(inv.lastUpdate)}` });
  if (latestAgent && d.agent_version && d.agent_version !== latestAgent) out.push({ tone: 'warn', text: `Agent ${d.agent_version}, nieuw: ${latestAgent}` });
  return out;
}

export const DeviceIcon = ({ className = 'w-5 h-5', os }: { className?: string; os?: string | null }) => os === 'nasbrowser' ? (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></svg>
) : (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
);
