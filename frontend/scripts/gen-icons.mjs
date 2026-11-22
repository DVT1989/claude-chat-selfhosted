/**
 * Generates PNG icons from SVG using rsvg-convert (installed via vips-dev on Alpine).
 * Run during Docker build — do not run locally unless rsvg-convert is installed.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dir, '..', 'public');

const srcIcon      = join(publicDir, 'icons', 'icon.svg');
const srcMaskable  = join(publicDir, 'icons', 'icon-maskable.svg');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

function rsvg(src, size, dest) {
  execSync(`rsvg-convert -w ${size} -h ${size} "${src}" -o "${dest}"`);
  console.log(`✓ ${dest.split('/').pop()}`);
}

for (const size of sizes) {
  rsvg(srcIcon,     size, join(publicDir, 'icons', `icon-${size}.png`));
  rsvg(srcMaskable, size, join(publicDir, 'icons', `icon-maskable-${size}.png`));
}

// Apple touch icon (180x180)
rsvg(srcIcon, 180, join(publicDir, 'icons', 'apple-touch-icon.png'));

console.log('All icons generated.');
