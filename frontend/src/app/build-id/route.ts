import { readFileSync } from 'fs';
import { join } from 'path';

// Build of the running frontend: RestartWatcher reloads as soon as this changes after an update.
export const dynamic = 'force-dynamic';

let id: string | null = null;
// start of this process: a restart without code changes keeps the build id but still counts
const started = Date.now().toString(36);
export function GET() {
  if (id === null) {
    try { id = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf-8').trim(); } catch { id = ''; }
  }
  return new Response(`${id}-${started}`, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}
