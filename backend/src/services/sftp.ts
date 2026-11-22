// SFTP connector helpers: builds an lftp script (mode 600) so no password ever appears on a command line.

export interface SftpParams {
  host: string;
  port: number;
  username: string;
  password?: string;
  /** path to a private key file (mode 600) */
  keyFile?: string;
  /** start directory */
  dir?: string;
}

const HOST_RE = /^[A-Za-z0-9._:-]+$/;

export function sftpPort(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 22;
}

export function validSftpHost(host: unknown): host is string {
  return typeof host === 'string' && HOST_RE.test(host);
}

/** lftp double-quoted word: escape backslash and double quote, drop line breaks. */
function q(s: string): string {
  return '"' + s.replace(/[\r\n]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Normalise a pasted private key (CRLF, missing trailing newline). */
export function normalizeKey(key: string): string {
  return key.replace(/\r\n/g, '\n').trim() + '\n';
}

export function buildLftpScript(p: SftpParams): string {
  const lines = ['set sftp:auto-confirm yes', 'set net:max-retries 1', 'set net:timeout 10', 'set cmd:fail-exit yes'];
  if (p.keyFile) {
    lines.push(`set sftp:connect-program ${q(`ssh -a -x -i ${p.keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`)}`);
  }
  lines.push(`open -u ${q(p.username)},${q(p.password ?? 'x')} -p ${p.port} sftp://${p.host}`);
  if (p.dir) lines.push(`cd ${q(p.dir)}`);
  return lines.join('\n') + '\n';
}
