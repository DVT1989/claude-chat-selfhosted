import express, { Router, Request, Response, NextFunction } from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { decrypt } from '../services/crypto';
import * as dev from '../services/devices';
import { getNas, VIEW_W, VIEW_H } from '../services/nasBrowser';
import * as pwStore from '../services/nasPasswords';
import { actBody, claudeAct, claudeScreen, endDeviceSessions } from './remote';
import { broadcastSse } from '../services/sseEvents';
import { buildExtensionZip, extensionVersion, EXT_DIR } from '../services/browserExtension';

export const devicesRouter = Router();

const DIST = '/app/agent-dist';
const appUrl = () => (process.env.APP_URL ?? '').replace(/\/+$/, '');
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MAX_TIMEOUT_SEC = 1800;
const WINGET_SHIM = `if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { function global:winget { $w = Get-ChildItem "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\\winget.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if (-not $w) { throw 'winget staat niet op dit apparaat' }; & $w.FullName @args } }\n`;

const ipOf = (req: Request) => req.ip ?? '';
/** Own devices; an admin sees everyone's only with the explicit all-users switch. */
const scopeOf = (req: Request): dev.Scope => dev.requestScope(req);
const latestAgent = (): string | null => {
  try { return readFileSync(join(DIST, 'version.txt'), 'utf-8').trim() || null; } catch { return null; }
};

// ── Downloads (public: nothing secret in them; pairing needs a code) ──

devicesRouter.get('/download/windows', (req: Request, res: Response) => {
  const file = join(DIST, 'ClaudeAgentSetup.exe');
  if (!existsSync(file)) { res.status(404).json({ error: 'Installer niet beschikbaar' }); return; }
  const code = String(req.query.code ?? '').toUpperCase();
  // the installer reads the pairing code from its own file name
  res.download(file, CODE_RE.test(code) ? `ClaudeAgentSetup-${code}.exe` : 'ClaudeAgentSetup.exe');
});

// Public half of the self-signed code signing certificate (the installer also installs it)
devicesRouter.get('/download/cert', (_req: Request, res: Response) => {
  const file = join(DIST, 'codesign.crt');
  if (!existsSync(file) || !readFileSync(file).length) { res.status(404).json({ error: 'Niet gesigneerd' }); return; }
  res.download(file, 'ClaudeChatAgent.cer');
});

// Chrome extension (Koppelingen > Browser): zip with config.json (app URL); pairing needs a code
devicesRouter.get('/download/browser-extension.zip', (req: Request, res: Response) => {
  try {
    const code = String(req.query.code ?? '').toUpperCase();
    const zip = buildExtensionZip(appUrl(), CODE_RE.test(code) ? { code } : {});
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="claude-chat-browser-${extensionVersion() || '1'}.zip"`, 'Cache-Control': 'no-store' }).send(zip);
  } catch { res.status(404).json({ error: 'Extensie niet beschikbaar' }); }
});

// Current extension version: the popup compares it with its own and offers an update
devicesRouter.get('/download/browser-extension/version', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store').json({ version: extensionVersion() });
});

// Privacy statement for the Chrome Web Store listing (public, plain page from docs/chrome-store/privacy.md)
devicesRouter.get('/privacy-extension', (_req: Request, res: Response) => {
  try {
    const md = readFileSync(join(EXT_DIR, '..', 'docs', 'chrome-store', 'privacy.md'), 'utf-8');
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = md.split(/\n{2,}/).map((b) => {
      const t = b.trim();
      if (t.startsWith('# ')) return `<h1>${esc(t.slice(2))}</h1>`;
      if (t.startsWith('## ')) return `<h2>${esc(t.slice(3))}</h2>`;
      if (t.split('\n').every((l) => l.startsWith('- '))) return `<ul>${t.split('\n').map((l) => `<li>${esc(l.slice(2))}</li>`).join('')}</ul>`;
      return `<p>${esc(t)}</p>`;
    }).join('\n');
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
      .send(`<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacyverklaring Claude Chat Browser</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;color:#18141f}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.6rem}</style><body>${body}</body></html>`);
  } catch { res.status(404).json({ error: 'Niet beschikbaar' }); }
});

devicesRouter.get('/download/bin/:target', (req: Request, res: Response) => {
  const target = String(req.params.target);
  if (!['darwin-arm64', 'darwin-amd64'].includes(target)) { res.status(404).end(); return; }
  res.download(join(DIST, `claude-agent-${target}`), 'claude-agent');
});

devicesRouter.get('/download/app/:target', (req: Request, res: Response) => {
  const target = String(req.params.target);
  if (!['darwin-arm64', 'darwin-amd64'].includes(target)) { res.status(404).end(); return; }
  res.download(join(DIST, `claude-agent-app-${target}.tar.gz`), 'claude-agent-app.tar.gz');
});

// Windows without SmartScreen: run in an elevated PowerShell, irm .../windows.ps1?code=XXXX-XXXX | iex
// PowerShell downloads the installer itself (no Mark of the Web), installs silently and pairs with the code.
devicesRouter.get('/download/windows.ps1', (req: Request, res: Response) => {
  const server = appUrl();
  const raw = String(req.query.code ?? '').toUpperCase();
  const code = CODE_RE.test(raw) ? raw : '';
  res.type('text/plain; charset=utf-8').set('Cache-Control', 'no-store').send(`# Claude Agent voor Windows (installeren of bijwerken)
# PowerShell als administrator: irm "${server}/api/devices/download/windows.ps1?code=KOPPELCODE" | iex
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $Server = '${server}'
  $Code = '${code}'
  $me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Start PowerShell als administrator (rechtsklik, Als administrator uitvoeren) en plak de regel opnieuw.' -ForegroundColor Red
    return
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $pf = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $exe = Join-Path $pf 'ClaudeAgent\\claude-agent.exe'
  $dir = Join-Path $env:ProgramData 'ClaudeAgent'
  $paired = Test-Path (Join-Path $dir 'config.json')
  if (-not $paired -and -not $Code) {
    Write-Host 'Koppelcode ontbreekt. Maak er een in Claude Chat, Instellingen, Apparaten.' -ForegroundColor Red
    return
  }
  $tmp = Join-Path $env:TEMP ('ClaudeAgentSetup-' + [guid]::NewGuid().ToString('N') + '.exe')
  try {
    Write-Host 'Installer downloaden...'
    Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/devices/download/windows" -OutFile $tmp
    Write-Host 'Installeren...'
    $p = Start-Process -FilePath $tmp -ArgumentList '/S' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Installer stopte met code $($p.ExitCode)" }
    if (-not $paired) {
      Write-Host 'Koppelen...'
      Stop-Service ClaudeAgent -ErrorAction SilentlyContinue
      $out = & $exe enroll --server $Server --code $Code 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Koppelen mislukt: $out" }
      # key file readable only by SYSTEM and Administrators
      icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
      Start-Service ClaudeAgent
    }
    $svc = Get-Service ClaudeAgent
    Write-Host "Klaar. Claude Agent: $($svc.Status). Het apparaat staat in Claude Chat onder Instellingen, Apparaten." -ForegroundColor Green
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}
`);
});

devicesRouter.get('/download/mac', (_req: Request, res: Response) => {
  const server = appUrl();
  res.type('text/x-shellscript').send(`#!/bin/bash
# Claude Agent voor macOS. Installeren: curl -fsSL ${server}/api/devices/download/mac | sudo bash -s -- KOPPELCODE
# Verwijderen: sudo /usr/local/claude-agent/uninstall.sh
set -euo pipefail
SERVER="${server}"
CODE="\${1:-}"
DIR="/usr/local/claude-agent"
CONF="/Library/Application Support/ClaudeAgent/config.json"
PLIST="/Library/LaunchDaemons/nl.claudechat.agent.plist"
[ "$(id -u)" = 0 ] || { echo "Start met sudo."; exit 1; }
case "$(uname -m)" in arm64) BIN=darwin-arm64 ;; x86_64) BIN=darwin-amd64 ;; *) echo "Onbekende processor"; exit 1 ;; esac
APP="/Applications/Claude Agent.app"
EXE="$APP/Contents/MacOS/claude-agent"
TMP="$(mktemp -d /tmp/claude-agent-install.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DIR"
curl -fsSL "$SERVER/api/devices/download/app/$BIN" -o "$TMP/app.tar.gz"
tar xzf "$TMP/app.tar.gz" -C "$TMP"
[ -x "$TMP/Claude Agent.app/Contents/MacOS/claude-agent" ] || { echo "Download onvolledig"; exit 1; }
launchctl bootout system "$PLIST" 2>/dev/null || true
rm -rf "$APP"
mv "$TMP/Claude Agent.app" "$APP"
chown -R root:wheel "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
rm -f "$DIR/claude-agent"
ln -s "$EXE" "$DIR/claude-agent"
if [ ! -f "$CONF" ]; then
  [ -n "$CODE" ] || { echo "Koppelcode ontbreekt: ... | sudo bash -s -- ABCD-EFGH"; exit 1; }
  "$EXE" enroll --server "$SERVER" --code "$CODE"
fi
chmod 700 "/Library/Application Support/ClaudeAgent"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>nl.claudechat.agent</string>
  <key>ProgramArguments</key><array><string>$EXE</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Library/Logs/claude-agent.log</string>
</dict></plist>
PL
chmod 644 "$PLIST"
cat > "$DIR/uninstall.sh" <<'UN'
#!/bin/bash
[ "$(id -u)" = 0 ] || { echo "Start met sudo."; exit 1; }
launchctl bootout system /Library/LaunchDaemons/nl.claudechat.agent.plist 2>/dev/null || true
CU="$(stat -f %Su /dev/console)"; [ -n "$CU" ] && launchctl bootout "gui/$(id -u "$CU")/nl.claudechat.agent.job.desktop" 2>/dev/null || true
"/Applications/Claude Agent.app/Contents/MacOS/claude-agent" unenroll 2>/dev/null || /usr/local/claude-agent/claude-agent unenroll 2>/dev/null || true
rm -f /Library/LaunchDaemons/nl.claudechat.agent.plist /Library/Logs/claude-agent.log
rm -rf "/Library/Application Support/ClaudeAgent" /usr/local/claude-agent "/Applications/Claude Agent.app"
echo "Claude Agent verwijderd."
UN
chmod 755 "$DIR/uninstall.sh"
launchctl bootstrap system "$PLIST"
echo "Claude Agent draait. Verwijderen: sudo $DIR/uninstall.sh"
echo ""
echo "Meekijken en bedienen vragen twee toestemmingen op deze Mac. Binnen een minuut opent macOS de vragen zelf:"
echo "  1. Systeeminstellingen > Privacy en beveiliging > Schermopname: zet 'Claude Agent' aan."
echo "  2. Systeeminstellingen > Privacy en beveiliging > Toegankelijkheid: zet 'Claude Agent' aan."
echo "  Staat hij niet in de lijst: klik op + en kies Programma's > Claude Agent. Kies daarna 'Stop en heropen' als macOS dat vraagt."
`);
});

// ── Live status: tell open apps when a device comes online or goes offline ──
// (no device data in the event: every app reloads its own, scoped list)
const onlineNow = new Set<string>();
setInterval(async () => {
  try {
    const r = await query<{ id: string }>(`SELECT id FROM devices WHERE enabled AND last_seen_at > now() - make_interval(secs => $1)`, [dev.ONLINE_MS / 1000]);
    const ids = new Set(r.rows.map((x) => x.id));
    let changed = ids.size !== onlineNow.size;
    for (const id of onlineNow) if (!ids.has(id)) { onlineNow.delete(id); changed = true; }
    for (const id of ids) if (!onlineNow.has(id)) { onlineNow.add(id); changed = true; }
    if (changed) broadcastSse('devices-changed', {});
  } catch { /* database busy: next round */ }
}, 15_000).unref();

// ── Agent (device token) ─────────────────────────────────────

const agent = Router();
devicesRouter.use('/agent', agent);

agent.post('/enroll', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      code: z.string().min(8).max(20), hostname: z.string().max(200).optional(), os: z.string().max(40).optional(),
      osName: z.string().max(200).optional(), arch: z.string().max(40).optional(), version: z.string().max(40).optional(),
    }).parse(req.body);
    const out = await dev.enrollDevice(body, ipOf(req));
    if (!out) throw new AppError(401, 'Koppelcode ongeldig of verlopen');
    const owner = await query<{ user_id: string }>('SELECT user_id FROM devices WHERE id = $1', [out.deviceId]);
    await auditLog(owner.rows[0].user_id, 'device.enroll', 'device', out.deviceId, ipOf(req), { name: out.name, os: body.os });
    res.json(out);
  } catch (err) { next(err); }
});

agent.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = String(req.headers.authorization ?? '');
    const d = await dev.deviceForToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!d) throw new AppError(401, 'Apparaat onbekend');
    res.locals.device = d;
    next();
  } catch (err) { next(err); }
});

agent.post('/poll', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = res.locals.device as dev.AgentDevice;
    const version = typeof req.body?.version === 'string' ? req.body.version.slice(0, 40) : null;
    const up = await query<{ os: string | null; agent_version: string | null; enabled: boolean }>(
      'UPDATE devices SET last_seen_at = now(), last_ip = $1, agent_version = COALESCE($2, agent_version) WHERE id = $3 RETURNING os, agent_version, enabled',
      [ipOf(req), version, d.id]);
    const row = up.rows[0];
    if (row) maybeAutoUpdate(d, row.os, row.agent_version, row.enabled);
    // macOS: permissions for screen capture and input, shown as a health issue with the steps
    const p = req.body?.perms;
    if (p && typeof p === 'object') {
      const perms = JSON.stringify({ screen: p.screen === true, accessibility: p.accessibility === true });
      await query(`UPDATE devices SET inventory = jsonb_set(COALESCE(inventory, '{}'::jsonb), '{remotePerms}', $1::jsonb) WHERE id = $2 AND (inventory->'remotePerms') IS DISTINCT FROM $1::jsonb`, [perms, d.id]);
    }
    if (!onlineNow.has(d.id)) { onlineNow.add(d.id); broadcastSse('devices-changed', {}); }
    dev.holdPoll(d.id, res);
  } catch (err) { next(err); }
});

// The agent reports it is going away (shutdown, restart, sleep): remote sessions end at once and the
// device shows offline right away instead of after the poll timeout.
agent.post('/state', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = res.locals.device as dev.AgentDevice;
    const state = z.object({ state: z.enum(['shutdown', 'sleep']) }).parse(req.body).state;
    endDeviceSessions(d.id, state === 'sleep' ? 'de pc gaat in slaapstand' : 'de pc wordt afgesloten of herstart');
    await query("UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE id = $1", [d.id]);
    onlineNow.delete(d.id);
    broadcastSse('devices-changed', {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

agent.post('/result', (req: Request, res: Response) => {
  const d = res.locals.device as dev.AgentDevice;
  if (typeof req.body?.id === 'string') dev.deliverResult(d.id, req.body as dev.JobResult);
  res.json({ ok: true });
});

agent.post('/inventory', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = res.locals.device as dev.AgentDevice;
    await dev.storeInventory(d.id, req.body?.inventory ?? null);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Update zip for a paired browser: carries a fresh one-time code and the current name, so even a reinstall
// (new folder, other extension id) pairs itself again and replaces this pairing.
agent.get('/browser-extension.zip', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const d = res.locals.device as dev.AgentDevice;
    const { code } = await dev.createEnrollCode(d.user_id);
    const zip = buildExtensionZip(appUrl(), { code, name: d.name });
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="claude-chat-browser-${extensionVersion() || '1'}.zip"`, 'Cache-Control': 'no-store' }).send(zip);
  } catch (err) { next(err); }
});

agent.post('/unenroll', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const d = res.locals.device as dev.AgentDevice;
    await query('DELETE FROM devices WHERE id = $1', [d.id]);
    await auditLog(d.user_id, 'device.uninstall', 'device', d.id, '', { name: d.name });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Shared: run a job for a user on one of their devices ─────

/** 32-bit context on 64-bit Windows: the command runs in SysWOW64's PowerShell or cmd. */
function wrap32(command: string, shell: string): { command: string; shell: string } {
  if (shell === 'cmd') {
    const b64 = Buffer.from(`@echo off\r\n${command}`, 'utf-8').toString('base64');
    return { shell: 'powershell', command: `$f = Join-Path $env:TEMP ('cc32-' + [guid]::NewGuid().ToString('N') + '.cmd')
[IO.File]::WriteAllText($f, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')), [Text.Encoding]::Default)
try { & "$env:SystemRoot\\SysWOW64\\cmd.exe" /c $f; exit $LASTEXITCODE } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue }` };
  }
  const enc = Buffer.from(command, 'utf16le').toString('base64');
  return { shell: 'powershell', command: `& "$env:SystemRoot\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${enc}; exit $LASTEXITCODE` };
}

async function jobFor(scope: dev.Scope, idOrName: string, job: Omit<dev.Job, 'id'>, timeoutSec: number, bits32 = false) {
  const d = await dev.getDevice(scope, idOrName);
  if (!d) throw new AppError(404, `Apparaat "${idOrName}" niet gevonden`);
  if (!d.enabled) throw new AppError(409, `${d.name} is uitgeschakeld in de app`);
  if (d.os === dev.NAS_OS) throw new AppError(409, `${d.name} is de browser op de server: gebruik tabs, read, browser, screen of act (geen exec, file of info)`);
  if (job.type === 'browser' && d.os !== 'browser') throw new AppError(400, `${d.name} is geen browser`);
  if (d.os === 'browser' && job.type !== 'browser') throw new AppError(409, `${d.name} is een browser: gebruik tabs, read, screen, act of browser (geen exec, file of info)`);
  if (!d.online) throw new AppError(409, `${d.name} is offline${d.last_seen_at ? ` (laatst gezien ${new Date(d.last_seen_at).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })})` : ''}`);
  // winget is a Store app, only on the PATH of signed-in users; the agent runs as SYSTEM
  if (job.type === 'exec' && d.os === 'windows' && job.runas !== 'user' && job.command && (!job.shell || job.shell === 'powershell' || job.shell === 'pwsh')) {
    job = { ...job, command: WINGET_SHIM + job.command };
  }
  if (bits32 && job.type === 'exec' && d.os === 'windows' && job.command) job = { ...job, ...wrap32(job.command, job.shell ?? '') };
  const result = await dev.runJob(d.id, job, (timeoutSec + 30) * 1000);
  return { device: d, result };
}

// ── Claude Code in this container: /devices/claude/*, per-run token, loopback only ──

const claude = Router();
devicesRouter.use('/claude', claude);

claude.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const t = await dev.userForClaudeToken(String(req.headers['x-device-token'] ?? ''));
    if (!t) throw new AppError(401, 'Token ongeldig of verlopen; start een nieuwe beurt');
    res.locals.userId = t.userId;
    res.locals.scope = t.scope;
    next();
  } catch (err) { next(err); }
});

claude.get('/list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await dev.listDevices(res.locals.scope as dev.Scope);
    res.json(list.map((d) => {
      const inv = d.inventory ?? {};
      return {
        id: d.id, name: d.name, online: d.online, enabled: d.enabled, os: d.os === 'browser' || d.os === dev.NAS_OS ? d.os : d.os_name ?? d.os, lastSeen: d.last_seen_at,
        model: inv.model, user: inv.user, rebootPending: inv.rebootPending, inventoryAt: d.inventory_at,
      };
    }));
  } catch (err) { next(err); }
});

claude.get('/:dev/info', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(res.locals.scope as dev.Scope, String(req.params.dev));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const apps = req.query.apps === '1';
    const inv = { ...(d.inventory ?? {}) } as Record<string, unknown>;
    if (!apps) delete inv.apps;
    res.json({ id: d.id, name: d.name, online: d.online, enabled: d.enabled, os: d.os === 'browser' || d.os === dev.NAS_OS ? d.os : d.os_name ?? d.os, arch: d.arch,
      agentVersion: d.agent_version, lastSeen: d.last_seen_at, lastIp: d.last_ip, inventoryAt: d.inventory_at, inventory: inv });
  } catch (err) { next(err); }
});

// ── Browser (Chrome extension, device type 'browser'): same /devices/claude API, tab-based ──

const optTab = (v: unknown): number | undefined => { const n = Number(v); return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : undefined; };
const pair2 = z.tuple([z.number(), z.number()]);
const browserActBody = z.object({
  tab: z.number().int().min(0).optional(),
  actions: z.array(z.object({
    click: pair2.optional(), click_ref: z.number().int().min(0).optional(), click_selector: z.string().max(500).optional(),
    button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional(),
    move: pair2.optional(), drag: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), scroll: z.tuple([z.number(), z.number(), z.number()]).optional(),
    fill: z.object({ ref: z.number().int().min(0).optional(), selector: z.string().max(500).optional(), text: z.string().max(20000), clear: z.boolean().optional() }).optional(),
    type: z.string().max(20000).optional(), key: z.string().max(60).optional(), wait: z.number().min(0).max(10_000).optional(),
  })).min(1).max(50),
});
const browserNavBody = z.object({
  cmd: z.enum(['open', 'navigate', 'history', 'close', 'focus']),
  tab: z.number().int().min(0).optional(), url: z.string().max(4000).optional(),
  dir: z.enum(['back', 'forward', 'reload']).optional(), background: z.boolean().optional(),
});

/** Runs a browser command via the extension; audited (never the typed text, only its length). */
async function browserJob(res: Response, d: NonNullable<Awaited<ReturnType<typeof dev.getDevice>>>, cmd: string, args: Record<string, unknown>, timeoutSec: number) {
  const { result } = await jobFor(res.locals.scope as dev.Scope, d.id, { type: 'browser', cmd, args }, timeoutSec);
  const actions = Array.isArray(args.actions) ? (args.actions as Array<Record<string, unknown>>).map((a) => Object.keys(a).filter((k) => k !== 'button' && k !== 'double').join(',')).join('; ').slice(0, 400) : undefined;
  await auditLog(res.locals.userId as string, `device.browser.${cmd}`, 'device', d.id, '', {
    device: d.name, ok: result.ok, tab: args.tab, ...(typeof args.url === 'string' ? { url: args.url.slice(0, 300) } : {}), ...(actions ? { actions } : {}),
  }).catch(() => undefined);
  if (!result.ok) throw new AppError(502, result.error || 'Browser-opdracht mislukt');
  return { data: result.data as Record<string, unknown> | undefined, dataB64: result.dataB64 };
}

async function browserFor(req: Request, res: Response) {
  const d = await dev.getDevice(res.locals.scope as dev.Scope, String(req.params.dev));
  if (!d) throw new AppError(404, 'Apparaat niet gevonden');
  if (d.os !== 'browser') throw new AppError(400, `${d.name} is geen browser`);
  return d;
}

// ── Browser (NAS): Chromium on the server, per user (device type 'nasbrowser') ──

/** The user's own NAS browser; null for every other device. Scope is always the user, admin included. */
async function nasFor(req: Request, res: Response): Promise<{ d: NonNullable<Awaited<ReturnType<typeof dev.getDevice>>>; nas: Awaited<ReturnType<typeof getNas>> } | null> {
  const userId = res.locals.userId as string;
  const d = await dev.getDevice(userId, String(req.params.dev));
  if (!d) throw new AppError(404, 'Apparaat niet gevonden');
  if (d.os !== dev.NAS_OS) return null;
  if (!d.enabled) throw new AppError(409, `${d.name} is uitgeschakeld in de app`);
  try { return { d, nas: await getNas(userId) }; }
  catch (err) { throw new AppError(502, `${dev.NAS_NAME} starten mislukt: ${String((err as Error).message).split('\n')[0].slice(0, 200)}`); }
}
const nasAudit = (res: Response, d: { id: string; name: string }, cmd: string, extra: Record<string, unknown> = {}) =>
  auditLog(res.locals.userId as string, `device.browser.${cmd}`, 'device', d.id, '', { device: d.name, nas: true, ...extra }).catch(() => undefined);

claude.get('/:dev/tabs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const n = await nasFor(req, res);
    if (n) { const st = await n.nas.state(); res.json({ ok: true, tabs: st.tabs }); return; }
    const d = await browserFor(req, res); res.json({ ok: true, ...((await browserJob(res, d, 'tabs', {}, 30)).data ?? {}) });
  } catch (err) { next(err); }
});

claude.get('/:dev/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const n = await nasFor(req, res);
    if (n) {
      const tab = optTab(req.query.tab);
      if (tab !== undefined) await n.nas.command({ cmd: 'tab-focus', id: tab });
      const max = Number(req.query.max) || 20000;
      const r = await n.nas.read();
      await nasAudit(res, n.d, 'read', { url: r.url.slice(0, 300) });
      res.json({ ok: true, ...r, text: r.text.slice(0, max), width: VIEW_W, height: VIEW_H });
      return;
    }
    const d = await browserFor(req, res);
    const args = { tab: optTab(req.query.tab), max: Number(req.query.max) || undefined, maxElements: Number(req.query.maxElements) || undefined };
    res.json({ ok: true, ...((await browserJob(res, d, 'read', args, 60)).data ?? {}) });
  } catch (err) { next(err); }
});

// Password manager: Claude sees the accounts of the current site (id and user name, never a password) and can have
// them filled in. The password goes straight from the database into the page, not through this answer.
claude.get('/:dev/passwords', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const n = await nasFor(req, res);
    if (!n) throw new AppError(400, `Wachtwoorden zijn alleen beschikbaar voor de ${dev.NAS_NAME}`);
    const st = await n.nas.state();
    const url = st.tabs.find((t) => t.active)?.url ?? '';
    const o = pwStore.originOf(url);
    const accounts = o ? await pwStore.accountsFor(res.locals.userId as string, o.origin) : [];
    const fields = o ? await n.nas.pwFields() : { username: false, password: false };
    await nasAudit(res, n.d, 'passwords', { host: o?.host ?? null });
    res.json({ ok: true, url, host: o?.host ?? null, accounts, loginFields: fields,
      note: 'Wachtwoorden worden nooit getoond. Vul in met POST /passwords/fill {"id"} of {"username"}; klik daarna zelf op Inloggen.' });
  } catch (err) { next(err); }
});

const pwFillBody = z.object({ id: z.string().uuid().optional(), username: z.string().max(300).optional() }).refine((v) => v.id || v.username, 'id of username ontbreekt');

claude.post('/:dev/passwords/fill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const n = await nasFor(req, res);
    if (!n) throw new AppError(400, `Wachtwoorden zijn alleen beschikbaar voor de ${dev.NAS_NAME}`);
    const b = pwFillBody.parse(req.body ?? {});
    const st = await n.nas.state();
    const o = pwStore.originOf(st.tabs.find((t) => t.active)?.url ?? '');
    if (!o) throw new AppError(409, 'Open eerst de inlogpagina van de site');
    const accounts = await pwStore.accountsFor(res.locals.userId as string, o.origin);
    const acc = b.id ? accounts.find((a) => a.id === b.id) : accounts.find((a) => a.username.toLowerCase() === b.username!.toLowerCase());
    if (!acc) throw new AppError(404, `Geen opgeslagen account voor ${o.host}${b.username ? ` met naam ${b.username}` : ''}`);
    const r = await n.nas.pwFill(acc.id).catch((err: Error) => { throw new AppError(409, err.message); });
    await nasAudit(res, n.d, 'password.fill', { host: o.host, account: acc.id });
    res.json({ ok: true, host: o.host, ...r });
  } catch (err) { next(err); }
});

claude.post('/:dev/browser', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const n = await nasFor(req, res);
    if (n) {
      const { cmd, ...a } = browserNavBody.parse(req.body);
      if ((cmd === 'open' || cmd === 'navigate') && !a.url) throw new AppError(400, 'url ontbreekt');
      if (a.tab !== undefined && cmd !== 'open') await n.nas.command({ cmd: 'tab-focus', id: a.tab });
      if (cmd === 'open') await n.nas.command({ cmd: 'tab-new', url: a.url });
      else if (cmd === 'navigate') await n.nas.command({ cmd: 'navigate', url: a.url! });
      else if (cmd === 'history') await n.nas.command({ cmd: a.dir === 'forward' ? 'forward' : a.dir === 'reload' ? 'reload' : 'back' });
      else if (cmd === 'close') { const t = a.tab ?? (await n.nas.state()).tabs.find((x) => x.active)?.id; if (t !== undefined) await n.nas.command({ cmd: 'tab-close', id: t }); }
      await nasAudit(res, n.d, cmd, a.url ? { url: a.url.slice(0, 300) } : {});
      const st = await n.nas.state();
      res.json({ ok: true, tabs: st.tabs });
      return;
    }
    const d = await browserFor(req, res);
    const { cmd, ...args } = browserNavBody.parse(req.body);
    if ((cmd === 'open' || cmd === 'navigate') && !args.url) throw new AppError(400, 'url ontbreekt');
    res.json({ ok: true, ...((await browserJob(res, d, cmd, args, 60)).data ?? {}) });
  } catch (err) { next(err); }
});

// Screen: Claude looks at the desktop and works with mouse and keyboard (shown live in the viewer)
claude.get('/:dev/screen', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(res.locals.scope as dev.Scope, String(req.params.dev));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    if (d.os === dev.NAS_OS) {
      await nasFor(req, res);
      const shot = await claudeScreen(d, res.locals.userId as string);
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Screen-Width': String(shot.w), 'X-Screen-Height': String(shot.h) }).send(shot.jpeg);
      return;
    }
    if (d.os === 'browser') {
      const r = await browserJob(res, d, 'screenshot', { tab: optTab(req.query.tab) }, 60);
      const dd = (r.data ?? {}) as { width?: number; height?: number; tab?: number };
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Screen-Width': String(dd.width ?? ''), 'X-Screen-Height': String(dd.height ?? ''), 'X-Tab': String(dd.tab ?? '') })
        .send(Buffer.from(r.dataB64 ?? '', 'base64'));
      return;
    }
    const shot = await claudeScreen(d, res.locals.userId as string);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Screen-Width': String(shot.w), 'X-Screen-Height': String(shot.h) }).send(shot.jpeg);
  } catch (err) { next(err); }
});

claude.post('/:dev/act', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(res.locals.scope as dev.Scope, String(req.params.dev));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    if (d.os === dev.NAS_OS) {
      await nasFor(req, res);
      const b = actBody.parse(req.body);
      res.json({ ok: true, ...(await claudeAct(d, res.locals.userId as string, b.actions)) });
      return;
    }
    if (d.os === 'browser') {
      const b = browserActBody.parse(req.body);
      const r = await browserJob(res, d, 'act', { tab: b.tab ?? optTab(req.query.tab), actions: b.actions }, 120);
      res.json({ ok: true, ...(r.data as object) });
      return;
    }
    const b = actBody.parse(req.body);
    res.json({ ok: true, ...(await claudeAct(d, res.locals.userId as string, b.actions)) });
  } catch (err) { next(err); }
});

claude.post('/:dev/exec', express.text({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = res.locals.userId as string;
    const command = typeof req.body === 'string' ? req.body : '';
    if (!command.trim()) throw new AppError(400, 'Commando via de body (text/plain)');
    const shell = String(req.query.shell ?? '');
    const timeoutSec = Math.min(Math.max(Number(req.query.timeout) || 120, 5), MAX_TIMEOUT_SEC);
    const runas = String(req.query.runas ?? 'system') === 'user' ? 'user' : 'system';
    const elevated = runas === 'user' && ['1', 'true'].includes(String(req.query.elevated ?? ''));
    const { device, result } = await jobFor(res.locals.scope as dev.Scope, String(req.params.dev), { type: 'exec', command, shell, timeoutSec, runas, elevated }, timeoutSec);
    await auditLog(userId, 'device.exec', 'device', device.id, '', { device: device.name, shell: shell || 'default', runas, elevated, command: command.slice(0, 1000), exitCode: result.exitCode, ok: result.ok });
    res.json({ ok: result.ok, exitCode: result.exitCode, output: result.output ?? '', error: result.error, durationMs: result.durationMs });
  } catch (err) { next(err); }
});

claude.get('/:dev/file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = res.locals.userId as string;
    const path = String(req.query.path ?? '');
    if (!path) throw new AppError(400, 'path ontbreekt');
    const { device, result } = await jobFor(res.locals.scope as dev.Scope, String(req.params.dev), { type: 'read', path }, 120);
    await auditLog(userId, 'device.file.read', 'device', device.id, '', { device: device.name, path, ok: result.ok });
    if (!result.ok) throw new AppError(422, result.error ?? 'Lezen mislukt');
    res.type('application/octet-stream').send(Buffer.from(result.dataB64 ?? '', 'base64'));
  } catch (err) { next(err); }
});

claude.put('/:dev/file', express.raw({ type: '*/*', limit: '20mb' }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = res.locals.userId as string;
    const path = String(req.query.path ?? '');
    if (!path) throw new AppError(400, 'path ontbreekt');
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    const { device, result } = await jobFor(res.locals.scope as dev.Scope, String(req.params.dev), { type: 'write', path, dataB64: data.toString('base64') }, 120);
    await auditLog(userId, 'device.file.write', 'device', device.id, '', { device: device.name, path, bytes: data.length, ok: result.ok });
    if (!result.ok) throw new AppError(422, result.error ?? 'Schrijven mislukt');
    res.json({ ok: true, output: result.output });
  } catch (err) { next(err); }
});

claude.post('/:dev/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { device, result } = await jobFor(res.locals.scope as dev.Scope, String(req.params.dev), { type: 'inventory' }, 200);
    if (!result.ok) throw new AppError(422, result.error ?? 'Inventaris mislukt');
    await dev.storeInventory(device.id, result.data);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── App (logged-in user) ─────────────────────────────────────

const app = Router();
app.use(requireAuth);
devicesRouter.use('/', app);

// Password manager (Browser NAS): list, reveal on click and delete. Own accounts only, also for admins.
app.get('/nas-passwords', async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ passwords: await pwStore.listAll(req.user!.userId) }); } catch (err) { next(err); }
});
app.post('/nas-passwords/:id/reveal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sec = await pwStore.secret(req.user!.userId, String(req.params.id));
    if (!sec) throw new AppError(404, 'Account niet gevonden');
    await auditLog(req.user!.userId, 'device.browser.password.reveal', 'nas_password', String(req.params.id), ipOf(req), {});
    res.set('Cache-Control', 'no-store').json({ password: sec.password });
  } catch (err) { next(err); }
});
app.delete('/nas-passwords/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await pwStore.remove(req.user!.userId, String(req.params.id)))) throw new AppError(404, 'Account niet gevonden');
    await auditLog(req.user!.userId, 'device.browser.password.delete', 'nas_password', String(req.params.id), ipOf(req), {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const [devices, settings, totp] = await Promise.all([
      dev.listDevices(scopeOf(req), userId), dev.getSettings(userId),
      query<{ totp_enabled: boolean }>('SELECT totp_enabled FROM users WHERE id = $1', [userId]),
    ]);
    // the app list does not need every installed program
    res.json({
      devices: devices.map((d) => ({ ...d, inventory: d.inventory ? { ...d.inventory, apps: undefined } : null })),
      settings, totpEnabled: !!totp.rows[0]?.totp_enabled, latestAgent: latestAgent(), isAdmin: req.user!.role === 'admin',
    });
  } catch (err) { next(err); }
});

// ── Script library (Uitvoeren > Script) ─────────────────────

const scriptBody = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional().nullable(), os: z.enum(['windows', 'darwin']),
  shell: z.string().max(10).optional(), runas: z.enum(['system', 'user']).optional(), timeout: z.number().int().min(5).max(MAX_TIMEOUT_SEC).optional(),
  content: z.string().min(1).max(100_000),
});

app.get('/scripts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await query(`SELECT id, name, description, os, shell, runas, timeout_sec, content, updated_at FROM device_scripts WHERE user_id = $1 ORDER BY lower(name)`, [req.user!.userId]);
    res.json({ scripts: r.rows });
  } catch (err) { next(err); }
});

app.post('/scripts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = scriptBody.parse(req.body);
    const r = await query<{ id: string }>(`INSERT INTO device_scripts (user_id, name, description, os, shell, runas, timeout_sec, content) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.user!.userId, b.name, b.description ?? null, b.os, b.shell ?? '', b.runas ?? 'system', b.timeout ?? 600, b.content]);
    res.json({ id: r.rows[0].id });
  } catch (err) { next(err); }
});

app.put('/scripts/:sid', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = scriptBody.parse(req.body);
    await query(`UPDATE device_scripts SET name = $1, description = $2, os = $3, shell = $4, runas = $5, timeout_sec = $6, content = $7, updated_at = now() WHERE id = $8 AND user_id = $9`,
      [b.name, b.description ?? null, b.os, b.shell ?? '', b.runas ?? 'system', b.timeout ?? 600, b.content, String(req.params.sid), req.user!.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.delete('/scripts/:sid', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query('DELETE FROM device_scripts WHERE id = $1 AND user_id = $2', [String(req.params.sid), req.user!.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id), req.user!.userId);
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    res.json({ device: d });
  } catch (err) { next(err); }
});

app.put('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ requireTotp: z.boolean() }).parse(req.body);
    await dev.saveSettings(req.user!.userId, body.requireTotp);
    res.json({ settings: await dev.getSettings(req.user!.userId) });
  } catch (err) { next(err); }
});

app.post('/enroll-code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const u = (await query<{ totp_enabled: boolean; totp_secret: string | null }>(
      'SELECT totp_enabled, totp_secret FROM users WHERE id = $1', [userId])).rows[0];
    const { requireTotp } = await dev.getSettings(userId);
    if (requireTotp && u?.totp_enabled && u.totp_secret) {
      const code = String(req.body?.totp_code ?? '').replace(/\s/g, '');
      if (!code) throw new AppError(403, 'TOTP-code nodig');
      const { verify, createGuardrails } = await import('otplib');
      let secret: string;
      try { secret = decrypt(u.totp_secret); } catch { secret = u.totp_secret; }
      const ok = (await verify({ token: code, secret, epochTolerance: 30, guardrails: createGuardrails({ MIN_SECRET_BYTES: 10 }) })).valid;
      if (!ok) throw new AppError(403, 'TOTP-code onjuist');
    }
    const out = await dev.createEnrollCode(userId);
    await auditLog(userId, 'device.enroll_code', 'device', null, ipOf(req), {});
    const server = appUrl();
    res.json({
      ...out, server,
      windowsUrl: `/api/devices/download/windows?code=${out.code}`,
      macCommand: `curl -fsSL ${server}/api/devices/download/mac | sudo bash -s -- ${out.code}`,
      windowsCommand: `irm "${server}/api/devices/download/windows.ps1?code=${out.code}" | iex`,
    });
  } catch (err) { next(err); }
});

app.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const opt = z.string().trim().max(200).nullable().optional();
    const body = z.object({
      name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(),
      display_name: opt, org: opt, location: opt, assigned_user: opt, role: opt,
      custom: z.record(z.string().max(80), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
      maintenance_until: z.string().datetime({ offset: true }).nullable().optional(), maintenance_reason: opt,
      alerts_ack: z.array(z.string().max(300)).max(100).optional(),
    }).parse(req.body);
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      vals.push(k === 'custom' || k === 'alerts_ack' ? JSON.stringify(v) : v === '' ? null : v);
      sets.push(`${k} = $${vals.length}${k === 'custom' || k === 'alerts_ack' ? '::jsonb' : ''}`);
    }
    if (sets.length) { vals.push(d.id); await query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); }
    const action = body.maintenance_until !== undefined ? 'device.maintenance' : body.alerts_ack ? 'device.alerts_reset' : 'device.update';
    await auditLog(req.user!.userId, action, 'device', d.id, ipOf(req), { device: d.name, ...body });
    res.json({ device: await dev.getDevice(scopeOf(req), d.id, req.user!.userId) });
  } catch (err) { next(err); }
});

app.post('/:id/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { device, result } = await jobFor(scopeOf(req), String(req.params.id), { type: 'inventory' }, 200);
    if (!result.ok) throw new AppError(422, result.error ?? 'Inventaris mislukt');
    await dev.storeInventory(device.id, result.data);
    res.json({ device: await dev.getDevice(scopeOf(req), device.id, req.user!.userId) });
  } catch (err) { next(err); }
});

// Remote console and the management tools in the app (same job path as Claude, also audited)
// ── Background tasks: queued in the database, run one at a time per device ──

interface TaskRow { id: string; device_id: string; user_id: string; label: string; tool: string | null; command: string; shell: string; timeout_sec: number; status: string; result: dev.JobResult | null; created_at: string; started_at: string | null; finished_at: string | null; run_at: string | null; runas: string | null }
const runningDevices = new Set<string>();

async function runTasks(deviceId: string): Promise<void> {
  if (runningDevices.has(deviceId)) return;
  runningDevices.add(deviceId);
  try {
    for (;;) {
      // offline: tasks wait (the scheduler retries every 30 s); after 24 hours they give up
      const cur = await dev.getDevice(null, deviceId);
      if (!cur) break;
      if (!cur.online || !cur.enabled) {
        await query(`UPDATE device_tasks SET status = 'failed', finished_at = now(), result = $2::jsonb
          WHERE device_id = $1 AND status = 'queued' AND COALESCE(run_at, created_at) < now() - interval '24 hours'`,
          [deviceId, JSON.stringify({ ok: false, error: 'Apparaat bleef 24 uur offline' })]);
        break;
      }
      const t = (await query<TaskRow>(
        `UPDATE device_tasks SET status = 'running', started_at = now() WHERE id = (
           SELECT id FROM device_tasks WHERE device_id = $1 AND status = 'queued' AND (run_at IS NULL OR run_at <= now()) ORDER BY COALESCE(run_at, created_at) LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING *`, [deviceId])).rows[0];
      if (!t) break;
      let result: dev.JobResult;
      let name = '';
      try {
        const r = await jobFor(null, deviceId, { type: 'exec', command: t.command, shell: t.shell, timeoutSec: t.timeout_sec, runas: t.runas === 'user' ? 'user' : 'system' }, t.timeout_sec);
        result = r.result; name = r.device.name;
      } catch (e) { result = { id: t.id, ok: false, error: (e as Error).message }; }
      await query(`UPDATE device_tasks SET status = $1, result = $2::jsonb, finished_at = now() WHERE id = $3`,
        [result.ok ? 'done' : 'failed', JSON.stringify({ ...result, output: (result.output ?? '').slice(-20000) }), t.id]);
      await auditLog(t.user_id, 'device.exec', 'device', deviceId, '', { device: name, source: `task:${t.tool ?? t.label}`, command: t.command.slice(0, 1000), exitCode: result.exitCode, ok: result.ok }).catch(() => undefined);
    }
  } catch (e) { console.error('[devices] task runner:', e); }
  finally { runningDevices.delete(deviceId); }
}

/** After a restart: continue the queues; scheduled tasks (run_at) start when due. */
export async function resumeDeviceTasks(): Promise<void> {
  const due = async () => {
    const r = await query<{ device_id: string }>(`SELECT DISTINCT device_id FROM device_tasks WHERE status = 'queued' AND (run_at IS NULL OR run_at <= now())`).catch(() => ({ rows: [] as Array<{ device_id: string }> }));
    for (const x of r.rows) void runTasks(x.device_id);
  };
  await due();
  setInterval(() => void due(), 30_000).unref();
}

const taskJson = (t: TaskRow) => ({ id: t.id, label: t.label, tool: t.tool, status: t.status, result: t.result, createdAt: t.created_at, startedAt: t.started_at, finishedAt: t.finished_at, runAt: t.run_at });

const taskItem = z.object({ command: z.string().min(1).max(100_000), shell: z.string().max(10).optional(), timeout: z.number().int().min(5).max(MAX_TIMEOUT_SEC).optional(), tool: z.string().max(120).optional(), label: z.string().max(200).optional(), runAt: z.string().datetime({ offset: true }).optional(), runas: z.enum(['system', 'user']).optional() });

app.post('/:id/tasks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ items: z.array(taskItem).min(1).max(100) }).parse(req.body);
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const ids: string[] = [];
    for (const it of body.items) {
      const r = await query<{ id: string }>(
        `INSERT INTO device_tasks (device_id, user_id, label, tool, command, shell, timeout_sec, run_at, runas) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [d.id, req.user!.userId, it.label ?? it.tool ?? 'Taak', it.tool ?? null, it.command, it.shell ?? '', it.timeout ?? 1800, it.runAt ?? null, it.runas ?? 'system']);
      ids.push(r.rows[0].id);
      await auditLog(req.user!.userId, 'device.task', 'device', d.id, ipOf(req), { device: d.name, source: `task:${it.tool ?? it.label ?? ''}`, label: it.label, runAt: it.runAt, status: 'queued' });
    }
    void runTasks(d.id);
    res.json({ ids });
  } catch (err) { next(err); }
});

app.get('/:id/tasks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const r = await query<TaskRow>(
      `SELECT * FROM device_tasks WHERE device_id = $1 AND (status IN ('queued', 'running') OR created_at > now() - interval '7 days')
       ORDER BY created_at DESC LIMIT 100`, [d.id]);
    res.json({ tasks: r.rows.map(taskJson) });
  } catch (err) { next(err); }
});

app.delete('/:id/tasks/:taskId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    await query(`UPDATE device_tasks SET status = 'cancelled', finished_at = now() WHERE id = $1 AND device_id = $2 AND status = 'queued'`, [String(req.params.taskId), d.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/:id/exec', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      command: z.string().min(1).max(100_000), shell: z.string().max(10).optional(), timeout: z.number().int().min(5).max(MAX_TIMEOUT_SEC).optional(), tool: z.string().max(120).optional(),
      runas: z.enum(['system', 'user']).optional(), elevated: z.boolean().optional(), bits: z.union([z.literal(32), z.literal(64)]).optional(),
    }).parse(req.body);
    const timeoutSec = body.timeout ?? 120;
    const runas = body.runas ?? 'system';
    const { device, result } = await jobFor(scopeOf(req), String(req.params.id),
      { type: 'exec', command: body.command, shell: body.shell ?? '', timeoutSec, runas, elevated: runas === 'user' && !!body.elevated }, timeoutSec, body.bits === 32);
    // tools named view:* only read (lists, details): logged apart so the activity feed stays readable
    const view = body.tool?.startsWith('view:');
    await auditLog(req.user!.userId, view ? 'device.view' : 'device.exec', 'device', device.id, ipOf(req), {
      device: device.name, source: body.tool ? (view ? body.tool : `tool:${body.tool}`) : 'console', runas, bits: body.bits ?? 64,
      command: body.command.slice(0, view ? 200 : 1000), exitCode: result.exitCode, ok: result.ok });
    res.json({ ok: result.ok, exitCode: result.exitCode, output: result.output ?? '', error: result.error, durationMs: result.durationMs });
  } catch (err) { next(err); }
});

// ── Live metrics: sampled on request, kept one hour in memory for the sparklines ──

interface Sample { t: number; cpu: number; memPct: number; memUsedGB: number; memTotalGB: number; disks: Array<{ drive: string; pct: number; usedGB: number; sizeGB: number }>; net: Array<{ name: string; rx: number; tx: number; ipv4?: string }>; diskBusy?: number; procs?: number; uptimeH?: number; users?: string[]; cores?: number }
const samples = new Map<string, Sample[]>();
const sampling = new Map<string, Promise<Sample | null>>();
const HOUR = 3600_000;

const METRICS_WIN = `$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB, 1); usedGB = [math]::Round(($_.Size - $_.FreeSpace) / 1GB, 1) } })
$ip = @{}; Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $ip[$_.InterfaceAlias] = $_.IPAddress }
$net = @(Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { $a = $_; $p = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Where-Object { $_.Name -eq ($a.InterfaceDescription -replace '\\(', '[' -replace '\\)', ']' -replace '[#/\\\\]', '_') } | Select-Object -First 1; @{ name = $a.Name; rx = [int64]$p.BytesReceivedPersec; tx = [int64]$p.BytesSentPersec; ipv4 = $ip[$a.Name] } })
$busy = (Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'").PercentDiskTime
$users = @(quser 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_.Trim().TrimStart('>') -split '\\s+')[0] })
ConvertTo-Json -Compress -Depth 4 -InputObject @{ cpu = [math]::Round($cpu); cores = $cores; memTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1); memFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1); uptimeH = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1); procs = (Get-Process).Count; users = $users; disks = $disks; net = $net; diskBusy = [math]::Min(100, [math]::Round($busy)) }`;
const METRICS_MAC = `cpu=$(top -l 2 -n 0 | grep "CPU usage" | tail -1 | awk '{print 100-$7}')
free=$(memory_pressure 2>/dev/null | tail -1 | grep -o '[0-9]*%' | tr -d '%')
total=$(sysctl -n hw.memsize); cores=$(sysctl -n hw.logicalcpu)
boot=$(sysctl -n kern.boottime | sed 's/.*sec = \\([0-9]*\\).*/\\1/')
users=$(who | awk '{print $1}' | sort -u | awk 'BEGIN{ORS=","}{printf "\\"%s\\"",$1; print ""}' | sed 's/,$//')
disks=$(df -k / /System/Volumes/Data 2>/dev/null | tail -n +2 | awk 'BEGIN{ORS=","}{printf "{\\"drive\\":\\"%s\\",\\"sizeGB\\":%.1f,\\"usedGB\\":%.1f}", $9, $2/1048576, $3/1048576; print ""}' | sed 's/,$//')
printf '{"cpu":%.0f,"cores":%d,"memTotalGB":%.1f,"memFreeGB":%.1f,"uptimeH":%.1f,"procs":%d,"users":[%s],"disks":[%s],"net":[]}' "$cpu" "$cores" "$(echo "$total/1073741824" | bc -l)" "$(echo "$total/1073741824*\${free:-0}/100" | bc -l)" "$(echo "($(date +%s)-$boot)/3600" | bc -l)" "$(ps -A | wc -l)" "$users" "$disks"`;

async function takeSample(d: dev.DeviceRow & { online: boolean }, scope: dev.Scope): Promise<Sample | null> {
  const { result } = await jobFor(scope, d.id, { type: 'exec', shell: d.os === 'windows' ? 'powershell' : '', command: d.os === 'windows' ? METRICS_WIN : METRICS_MAC, timeoutSec: 40 }, 40);
  const out = (result.output ?? '').replace(/^﻿/, '');
  const i = out.indexOf('{');
  if (i < 0) return null;
  let m: { cpu: number; cores?: number; memTotalGB: number; memFreeGB: number; uptimeH?: number; procs?: number; users?: string[]; disks?: Array<{ drive: string; sizeGB: number; usedGB: number }>; net?: Array<{ name: string; rx: number; tx: number; ipv4?: string }>; diskBusy?: number };
  try { m = JSON.parse(out.slice(i)); } catch { return null; }
  const arr = <T,>(v: T[] | T | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);
  const s: Sample = {
    t: Date.now(), cpu: Number(m.cpu) || 0, cores: m.cores, memTotalGB: m.memTotalGB, memUsedGB: Math.round((m.memTotalGB - m.memFreeGB) * 10) / 10,
    memPct: m.memTotalGB ? Math.round(((m.memTotalGB - m.memFreeGB) / m.memTotalGB) * 100) : 0,
    disks: arr(m.disks).map((x) => ({ drive: x.drive, sizeGB: x.sizeGB, usedGB: x.usedGB, pct: x.sizeGB ? Math.round((x.usedGB / x.sizeGB) * 100) : 0 })),
    net: arr(m.net), diskBusy: m.diskBusy, procs: m.procs, uptimeH: m.uptimeH, users: arr(m.users),
  };
  const list = (samples.get(d.id) ?? []).filter((x) => s.t - x.t < HOUR);
  list.push(s);
  samples.set(d.id, list);
  return s;
}

app.get('/:id/metrics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const history = () => (samples.get(d.id) ?? []).filter((x) => Date.now() - x.t < HOUR);
    const last = history().at(-1);
    // several viewers share one sample per 20 seconds
    if (d.online && (!last || Date.now() - last.t > 20_000)) {
      let p = sampling.get(d.id);
      if (!p) { p = takeSample(d, scopeOf(req)).catch(() => null).finally(() => sampling.delete(d.id)); sampling.set(d.id, p); }
      await p;
    }
    res.json({ online: d.online, history: history() });
  } catch (err) { next(err); }
});

// ── Activities: the audit log of this device ─────────────────

app.get('/:id/activities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
    const views = req.query.views === '1';
    const r = await query<{ id: string; action: string; metadata: Record<string, unknown>; created_at: string; user_name: string | null; ip_address: string | null }>(
      `SELECT a.id, a.action, a.metadata, a.created_at, a.ip_address, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.resource_type = 'device' AND a.resource_id = $1 AND a.created_at > now() - ($2 || ' days')::interval
         AND ($3::boolean OR a.action <> 'device.view') AND coalesce(a.metadata->>'source', '') <> 'tool:metrics'
       ORDER BY a.created_at DESC LIMIT 2000`, [d.id, String(days), views]);
    // Claude sessions on this device (kept out of the chat list) as rows of their own
    const c = await query<{ id: string; title: string; created_at: string; updated_at: string; user_name: string | null; question: string | null; turns: number; actions: number }>(
      `SELECT c.id, c.title, c.created_at, c.updated_at, u.name AS user_name,
              (SELECT left(m.content, 300) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.created_at LIMIT 1) AS question,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS turns,
              (SELECT count(*)::int FROM messages m, jsonb_array_elements(CASE WHEN m.content LIKE '[%' THEN m.content::jsonb ELSE '[]'::jsonb END) e
                 WHERE m.conversation_id = c.id AND m.role = 'assistant' AND e->>'type' = 'tool_use') AS actions
       FROM conversations c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.metadata->>'device_id' = $1 AND c.status <> 'deleted' AND ($2::uuid IS NULL OR c.user_id = $2::uuid)
         AND c.updated_at > now() - ($3 || ' days')::interval
       ORDER BY c.updated_at DESC LIMIT 200`, [d.id, scopeOf(req), String(days)]).catch((e) => { console.error('[devices] claude log:', e); return { rows: [] }; });
    const sessions = c.rows.map((s) => ({
      id: `claude-${s.id}`, action: 'device.claude', created_at: s.created_at, user_name: s.user_name, ip_address: null,
      metadata: { conversation_id: s.id, question: s.question ?? s.title, turns: s.turns, actions: s.actions, last: s.updated_at },
    }));
    res.json({ activities: [...sessions, ...r.rows].sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at))) });
  } catch (err) { next(err); }
});

// One Claude session on this device: the questions, answers and actions, for the activity log
app.get('/:id/claude/:convId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const convId = String(req.params.convId);
    if (!/^[0-9a-f-]{36}$/i.test(convId)) throw new AppError(404, 'Sessie niet gevonden');
    const conv = await query(`SELECT 1 FROM conversations WHERE id = $1 AND metadata->>'device_id' = $2 AND ($3::uuid IS NULL OR user_id = $3::uuid)`,
      [convId, d.id, scopeOf(req)]);
    if (!conv.rowCount) throw new AppError(404, 'Sessie niet gevonden');
    const m = await query<{ id: string; role: string; content: string; created_at: string }>(
      `SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 AND role IN ('user', 'assistant') ORDER BY created_at`, [convId]);
    res.json({ messages: m.rows });
  } catch (err) { next(err); }
});

// ── Favorites and notes ──────────────────────────────────────

app.put('/:id/favorite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    if (req.body?.favorite === false) await query('DELETE FROM device_favorites WHERE user_id = $1 AND device_id = $2', [req.user!.userId, d.id]);
    else await query('INSERT INTO device_favorites (user_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user!.userId, d.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const r = await query(`SELECT n.id, n.body, n.created_at, n.user_id, u.name AS user_name FROM device_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.device_id = $1 ORDER BY n.created_at DESC`, [d.id]);
    res.json({ notes: r.rows });
  } catch (err) { next(err); }
});

app.post('/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ body: z.string().trim().min(1).max(10_000) }).parse(req.body);
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    await query('INSERT INTO device_notes (device_id, user_id, body) VALUES ($1, $2, $3)', [d.id, req.user!.userId, body.body]);
    await auditLog(req.user!.userId, 'device.note', 'device', d.id, ipOf(req), { device: d.name, text: body.body.slice(0, 200) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.delete('/:id/notes/:noteId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    await query('DELETE FROM device_notes WHERE id = $1 AND device_id = $2 AND (user_id = $3 OR $4::boolean)', [String(req.params.noteId), d.id, req.user!.userId, req.user!.role === 'admin']);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Files: download and upload through the agent (max 10 MB read) ──

app.get('/:id/file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const path = String(req.query.path ?? '');
    if (!path) throw new AppError(400, 'path ontbreekt');
    const { device, result } = await jobFor(scopeOf(req), String(req.params.id), { type: 'read', path }, 120);
    await auditLog(req.user!.userId, 'device.file.read', 'device', device.id, ipOf(req), { device: device.name, source: 'tool:files', path, ok: result.ok });
    if (!result.ok) throw new AppError(422, result.error ?? 'Lezen mislukt');
    const name = path.split(/[\\/]/).pop() || 'bestand';
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`).type('application/octet-stream').send(Buffer.from(result.dataB64 ?? '', 'base64'));
  } catch (err) { next(err); }
});

app.put('/:id/file', express.raw({ type: '*/*', limit: '20mb' }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const path = String(req.query.path ?? '');
    if (!path) throw new AppError(400, 'path ontbreekt');
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    const { device, result } = await jobFor(scopeOf(req), String(req.params.id), { type: 'write', path, dataB64: data.toString('base64') }, 120);
    await auditLog(req.user!.userId, 'device.file.write', 'device', device.id, ipOf(req), { device: device.name, source: 'tool:files', path, bytes: data.length, ok: result.ok });
    if (!result.ok) throw new AppError(422, result.error ?? 'Schrijven mislukt');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

function updateJob(os: string | null): Omit<dev.Job, 'id'> {
    const server = appUrl();
    const url = os === 'windows' ? `${server}/api/devices/download/windows` : `${server}/api/devices/download/mac`;
    // Windows: a scheduled task runs the installer as SYSTEM, independent of the agent process
    // (a child of the agent was taken down when the installer stopped the service)
    return os === 'windows'
      ? { type: 'exec', shell: 'powershell', timeoutSec: 180, command: `$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:ProgramData 'ClaudeAgent'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
$p = Join-Path $dir 'ClaudeAgentSetup-update.exe'
Invoke-WebRequest -Uri '${url}' -OutFile $p -UseBasicParsing
$a = New-ScheduledTaskAction -Execute $p -Argument '/S'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(15)
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'ClaudeAgentUpdate' -Action $a -Trigger $t -Settings $s -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
"Update ingepland: $((Get-Item $p).Length) bytes, handtekening $((Get-AuthenticodeSignature $p).Status)"` }
      : { type: 'update', path: url };
}

// ── Automatic agent update: an outdated agent that polls gets the newest version right away ──
// Per device and target version at most 3 tries, 30 minutes apart (so a failing update does not loop).
const AUTO_RETRY_MS = 30 * 60_000;
const autoTried = new Map<string, { target: string; at: number; tries: number }>();
const verLess = (a: string, b: string) => {
  const p = (v: string) => v.split('.').map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); }
  return false;
};
function maybeAutoUpdate(d: dev.AgentDevice, os: string | null, current: string | null, enabled: boolean): void {
  if (process.env.AGENT_AUTO_UPDATE === '0' || !enabled || (os !== 'windows' && os !== 'darwin')) return;
  const target = latestAgent();
  if (!target || !current || !verLess(current, target)) return;
  const prev = autoTried.get(d.id);
  if (prev && prev.target === target && (prev.tries >= 3 || Date.now() - prev.at < AUTO_RETRY_MS)) return;
  autoTried.set(d.id, { target, at: Date.now(), tries: prev?.target === target ? prev.tries + 1 : 1 });
  // after this poll is held, so the job goes out on the open connection
  setTimeout(() => {
    void dev.runJob(d.id, updateJob(os), 210_000).then(async (result) => {
      console.log(`[devices] auto-update ${d.name} ${current} -> ${target}: ${result.ok ? 'ok' : result.error}`);
      await auditLog(d.user_id, 'device.update_agent', 'device', d.id, '', { device: d.name, from: current, to: target, auto: true, ok: result.ok, error: result.ok ? undefined : result.error });
    }).catch((e) => console.error('[devices] auto-update:', e));
  }, 3000).unref();
}

// Agent self-update: the agent downloads the current installer (Windows) or script (Mac) and runs it
app.post('/:id/update', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const job = updateJob(d.os);
    const { result } = await jobFor(scopeOf(req), d.id, job, 180);
    await auditLog(req.user!.userId, 'device.update_agent', 'device', d.id, ipOf(req), { device: d.name, from: d.agent_version, ok: result.ok });
    if (!result.ok) throw new AppError(422, result.error ?? 'Bijwerken mislukt (agent te oud? Installeer de nieuwe versie handmatig)');
    res.json({ ok: true, output: result.output });
  } catch (err) { next(err); }
});

// Terminal "Vraag Claude": one hidden conversation per device and user, so follow-ups keep context
app.post('/:id/terminal-session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    const userId = req.user!.userId;
    if (req.body?.fresh === true) {
      await query(`UPDATE conversations SET status = 'deleted' WHERE user_id = $1 AND metadata->>'deviceTerminal' = $2`, [userId, d.id]);
    }
    const found = await query<{ id: string }>(
      `SELECT id FROM conversations WHERE user_id = $1 AND metadata->>'deviceTerminal' = $2 AND status != 'deleted' ORDER BY created_at DESC LIMIT 1`, [userId, d.id]);
    if (found.rows[0]) { res.json({ conversationId: found.rows[0].id, fresh: false }); return; }
    const u = await query<{ default_model: string | null }>('SELECT default_model FROM users WHERE id = $1', [userId]);
    const r = await query<{ id: string }>(
      `INSERT INTO conversations (user_id, title, model, metadata) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [userId, `Terminal ${d.name}`, u.rows[0]?.default_model ?? 'sonnet', JSON.stringify({ deviceTerminal: d.id })]);
    res.json({ conversationId: r.rows[0].id, fresh: true });
  } catch (err) { next(err); }
});

app.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = await dev.getDevice(scopeOf(req), String(req.params.id));
    if (!d) throw new AppError(404, 'Apparaat niet gevonden');
    if (d.os === dev.NAS_OS) throw new AppError(409, `${d.name} hoort bij de app en kan niet worden verwijderd`);
    await query('DELETE FROM devices WHERE id = $1', [d.id]);
    await auditLog(req.user!.userId, 'device.remove', 'device', d.id, ipOf(req), { name: d.name });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
