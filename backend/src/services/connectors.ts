import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildLftpScript, normalizeKey, sftpPort, validSftpHost } from './sftp';

const execFileAsync = promisify(execFile);

interface TestResult {
  ok: boolean;
  message: string;
}

type ConnectorType = 'git' | 'github' | 'ssh' | 'sftp' | 'ftp' | 'smb' | 'python' | 'sudo' | 'focustrack' | 'google-search-console';

/** GitHub token: who is it, and may it run Actions (checked on the first repo it can see). */
async function testGithub(credentials: Record<string, unknown>): Promise<TestResult> {
  const token = String(credentials.token ?? '');
  if (!token) return { ok: false, message: 'Token ontbreekt' };
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'claude-chat' };
  const r = await fetch('https://api.github.com/user', { headers: h });
  if (!r.ok) return { ok: false, message: `GitHub weigert het token (HTTP ${r.status})` };
  const u = await r.json() as { login: string };
  const repos = await fetch('https://api.github.com/user/repos?per_page=1&sort=updated', { headers: h });
  const n = repos.ok ? ((await repos.json()) as unknown[]).length : 0;
  return { ok: true, message: `Verbonden als ${u.login}${n ? '' : ' (nog geen repo zichtbaar voor dit token)'}` };
}

/** Server address as https://host[:port], whatever else was typed around it (a bracket, a path, a space). */
export function ftBase(url: unknown): string {
  const m = String(url ?? '').trim().match(/^(?:https?:\/\/)?([a-z0-9.-]+(?::\d+)?)/i);
  return m ? `https://${m[1].toLowerCase()}` : '';
}

/** FocusTrack (AIO Cloud): the key must be an integration key; reports read or read+write. */
async function testFocustrack(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<TestResult> {
  const base = ftBase(config.url);
  const key = String(credentials.key ?? '').trim();
  if (!/^https:\/\//.test(base)) return { ok: false, message: 'Vul het serveradres in, bijv. https://focustrack.example.com' };
  if (!key.startsWith('aio_')) return { ok: false, message: 'Dit is geen AIO-sleutel (begint met aio_)' };
  const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  let me: Response;
  try { me = await fetch(`${base}/api/me`, { headers: h, signal: AbortSignal.timeout(10000) }); }
  catch { return { ok: false, message: `Server ${base} niet bereikbaar. Klopt het adres?` }; }
  if (me.status === 401) return { ok: false, message: 'Sleutel onbekend, ingetrokken of geen koppelingssleutel. Maak op de site een sleutel van de soort Koppeling.' };
  if (!me.ok) return { ok: false, message: `AIO Cloud gaf HTTP ${me.status}` };
  const u = (await me.json()) as { user?: { name?: string; email?: string } };
  // a harmless write probe: an unknown customer edit is refused differently for read and write keys
  const probe = await fetch(`${base}/api/tt/klantWijzig`, { method: 'POST', headers: h, body: JSON.stringify({ args: { id: -1 } }), signal: AbortSignal.timeout(10000) });
  const pj = (await probe.json().catch(() => ({}))) as { error?: string };
  const readOnly = probe.status === 403 && /alleen lezen/i.test(pj.error ?? '');
  return { ok: true, message: `Verbonden als ${u.user?.name ?? u.user?.email ?? 'gebruiker'}, ${readOnly ? 'alleen lezen' : 'lezen en schrijven'}` };
}

export async function testConnector(
  type: ConnectorType,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): Promise<TestResult> {
  try {
    switch (type) {
      case 'git':
        return await testGit(config, credentials);
      case 'github':
        return await testGithub(credentials);
      case 'focustrack':
        return await testFocustrack(config, credentials);
      case 'google-search-console':
        return await (await import('./googleSearchConsole')).testGsc(credentials);
      case 'ssh':
        return await testSsh(config, credentials);
      case 'sftp':
        return await testSftp(config, credentials);
      case 'ftp':
        return await testFtp(config, credentials);
      case 'smb':
        return await testSmb(config, credentials);
      case 'python':
        return await testPython();
      case 'sudo':
        return await testSudo(credentials);
      default:
        return { ok: false, message: `Unknown connector type: ${type as string}` };
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

async function testGit(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<TestResult> {
  const url = config.url as string;
  if (!url) return { ok: false, message: 'Repository URL required' };

  try {
    // Use git ls-remote to test connectivity without cloning
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (credentials.token) {
      // Inject token into URL
      const parsed = new URL(url);
      parsed.username = credentials.username as string ?? 'token';
      parsed.password = credentials.token as string;
      await execFileAsync('git', ['ls-remote', '--heads', parsed.toString()], {
        timeout: 10_000,
        env,
      });
    } else {
      await execFileAsync('git', ['ls-remote', '--heads', url], {
        timeout: 10_000,
        env,
      });
    }
    return { ok: true, message: 'Git repository accessible' };
  } catch (err) {
    return { ok: false, message: `Git test failed: ${(err as Error).message}` };
  }
}

async function testSsh(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<TestResult> {
  const host = config.host as string;
  const port = (config.port as number) ?? 22;
  const user = credentials.username as string ?? 'root';
  const password = credentials.password as string | undefined;

  if (!host) return { ok: false, message: 'SSH host vereist' };
  if (!user) return { ok: false, message: 'Gebruikersnaam vereist' };
  if (!password) return { ok: false, message: 'Wachtwoord vereist' };

  // Password via SSHPASS env (sshpass -e), sudo password via stdin: neither shows up in a process list or error text
  const sshArgs = ['-e', 'ssh',
    '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5',
    '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no',
    '-p', String(port), `${user}@${host}`];
  const env = { ...process.env, SSHPASS: password };
  const clean = (m: string) => m.split('\n').filter(l => !l.startsWith('Command failed')).join(' ').trim().slice(0, 300);
  try {
    await execFileAsync('sshpass', [...sshArgs, 'echo ok'], { timeout: 10_000, env });
    const sudoPass = credentials.sudo_password as string | undefined;
    if (sudoPass) {
      try {
        const run = execFileAsync('sshpass', [...sshArgs,
          "S=$(command -v sudo || ls /usr/bin/sudo /bin/sudo /usr/local/bin/sudo 2>/dev/null | head -1); [ -n \"$S\" ] || { echo NOSUDO; exit 0; }; $S -S -p '' -k whoami 2>/dev/null"],
          { timeout: 10_000, env });
        run.child.stdin?.end(sudoPass + '\n');
        const out = (await run).stdout.trim();
        if (out === 'root') return { ok: true, message: `SSH + sudo werkend (${host}:${port}, sudo OK)` };
        if (out === 'NOSUDO') return { ok: false, message: 'SSH werkt, maar sudo is niet geïnstalleerd op de server' };
        return { ok: false, message: `SSH werkt maar sudo wachtwoord onjuist of geen sudo-rechten voor ${user}` };
      } catch (err) {
        return { ok: false, message: `SSH werkt maar sudo test faalde: ${clean((err as Error).message)}` };
      }
    }
    return { ok: true, message: `SSH verbinding met ${host}:${port} succesvol` };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('Permission denied') || msg.includes('Authentication failed')) {
      return { ok: false, message: `SSH authenticatie mislukt — controleer gebruikersnaam/wachtwoord` };
    }
    return { ok: false, message: `SSH verbinding mislukt: ${clean(msg)}` };
  }
}

async function testSftp(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<TestResult> {
  const host = config.host;
  const port = sftpPort(config.port);
  const user = credentials.username as string | undefined;
  const password = credentials.password as string | undefined;
  const key = credentials.private_key as string | undefined;
  if (!validSftpHost(host)) return { ok: false, message: 'SFTP host vereist (alleen letters, cijfers, punt en streepje)' };
  if (!user) return { ok: false, message: 'Gebruikersnaam vereist' };
  if (!password && !key) return { ok: false, message: 'Wachtwoord of private key vereist' };

  const dir = mkdtempSync(join(tmpdir(), 'sftp-'));
  try {
    let keyFile: string | undefined;
    if (key) { keyFile = join(dir, 'key'); writeFileSync(keyFile, normalizeKey(key), { mode: 0o600 }); }
    const script = join(dir, 'test.lftp');
    writeFileSync(script, buildLftpScript({ host, port, username: user, password, keyFile, dir: config.dir as string | undefined }) + 'cls -1\nbye\n', { mode: 0o600 });
    await execFileAsync('lftp', ['-f', script], { timeout: 20_000 });
    return { ok: true, message: `SFTP verbinding met ${host}:${port} succesvol` };
  } catch (err) {
    const msg = ((err as { stderr?: string }).stderr || (err as Error).message || '').trim().split('\n').pop() ?? '';
    return { ok: false, message: `SFTP test mislukt: ${msg}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testFtp(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<TestResult> {
  const host = config.host as string;
  const user = credentials.username as string ?? 'anonymous';
  const pass = credentials.password as string ?? '';

  if (!host) return { ok: false, message: 'FTP host required' };

  try {
    await execFileAsync('lftp', [
      '-u', `${user},${pass}`,
      '-e', 'ls; quit',
      host,
    ], { timeout: 10_000 });
    return { ok: true, message: `FTP connection to ${host} successful` };
  } catch (err) {
    return { ok: false, message: `FTP test failed: ${(err as Error).message}` };
  }
}

async function testSmb(config: Record<string, unknown>, credentials: Record<string, unknown>): Promise<TestResult> {
  const host = config.host as string;
  const share = config.share as string;
  const user = credentials.username as string;
  const pass = credentials.password as string ?? '';

  if (!host || !share) return { ok: false, message: 'SMB host and share required' };

  try {
    await execFileAsync('smbclient', [
      `-H${host}`,
      share,
      '-U', `${user}%${pass}`,
      '-c', 'ls',
    ], { timeout: 10_000 });
    return { ok: true, message: `SMB connection to \\\\${host}\\${share} successful` };
  } catch (err) {
    return { ok: false, message: `SMB test failed: ${(err as Error).message}` };
  }
}

function testSudo(credentials: Record<string, unknown>): TestResult {
  const user = credentials.username as string | undefined;
  const pass = credentials.password as string | undefined;
  if (!user || !pass) return { ok: false, message: 'Gebruikersnaam en wachtwoord vereist' };
  return { ok: true, message: `Sudo credentials opgeslagen voor gebruiker "${user}"` };
}

async function testPython(): Promise<TestResult> {
  try {
    const { stdout } = await execFileAsync('python3', ['--version'], { timeout: 5_000 });
    return { ok: true, message: `Python available: ${stdout.trim()}` };
  } catch {
    return { ok: false, message: 'Python3 not available in container' };
  }
}
