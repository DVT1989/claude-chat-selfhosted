/**
 * Chrome extension (browser-extension/ in the project dir, mounted in this container): served as a zip.
 * The zip gets a config.json with the app URL, so the popup is prefilled. Store-only/deflate zip writer, no dependency.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { crc32, deflateRawSync } from 'zlib';

export const EXT_DIR = process.env.BROWSER_EXT_DIR || '/volume1/docker/claude-chat/browser-extension';
const SKIP = new Set(['make-icons.mjs', 'README.md', 'test']);

function files(dir: string, base = ''): Array<{ name: string; data: Buffer }> {
  const out: Array<{ name: string; data: Buffer }> = [];
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.') || e.includes('.bak') || SKIP.has(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...files(full, `${base}${e}/`));
    else out.push({ name: `${base}${e}`, data: readFileSync(full) });
  }
  return out;
}

export function extensionVersion(): string {
  try { return JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf-8')).version as string; } catch { return ''; }
}

/**
 * opts.code: one-time pairing code; the extension pairs itself on install (no typing).
 * opts.name: device name to pair with (an update zip keeps the current name, the old pairing is replaced).
 * The manifest gets the app address as host permission, so pairing works without a permission prompt.
 */
export function buildExtensionZip(appUrl: string, opts: { code?: string; name?: string } = {}): Buffer {
  const list = files(EXT_DIR).filter((f) => f.name !== 'config.json');
  const conf: Record<string, string> = { server: appUrl };
  if (opts.code) conf.code = opts.code;
  if (opts.name) conf.name = opts.name;
  list.push({ name: 'config.json', data: Buffer.from(JSON.stringify(conf, null, 2)) });
  let origin = '';
  try { origin = new URL(appUrl).origin; } catch { /* no app url */ }
  if (origin) {
    const mf = list.find((f) => f.name === 'manifest.json');
    if (mf) {
      const m = JSON.parse(mf.data.toString('utf-8')) as Record<string, unknown>;
      m.host_permissions = [`${origin}/*`];
      mf.data = Buffer.from(JSON.stringify(m, null, 2));
    }
  }
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of list) {
    const name = Buffer.from(`claude-chat-browser/${f.name}`, 'utf-8');
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); // fixed DOS time/date (1980-01-01)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
