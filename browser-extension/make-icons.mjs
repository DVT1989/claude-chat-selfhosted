// Genereert de PNG-iconen (afgeronde oranje tegel met witte ring). Gebruik: node make-icons.mjs
import { deflateSync, crc32 } from 'zlib';
import { writeFileSync } from 'fs';
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'ascii'); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)) >>> 0, 8 + d.length); return b; };
function png(n) {
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const cx = x + 0.5 - n / 2, cy = y + 0.5 - n / 2, r = Math.hypot(cx, cy);
      const rx = Math.max(Math.abs(cx) - (n / 2 - n * 0.22), 0), ry = Math.max(Math.abs(cy) - (n / 2 - n * 0.22), 0);
      const inTile = Math.hypot(rx, ry) <= n * 0.22;
      const ring = r < n * 0.3 && r > n * 0.17;
      const o = y * (n * 4 + 1) + 1 + x * 4;
      const c = !inTile ? [0, 0, 0, 0] : ring ? [255, 255, 255, 255] : [217, 119, 6, 255];
      raw.set(c, o);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const n of [16, 32, 48, 128]) writeFileSync(new URL(`./icons/icon${n}.png`, import.meta.url), png(n));
