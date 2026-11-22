import type { Response } from 'express';

const clients = new Set<Response>();

export function addSseClient(res: Response): () => void {
  clients.add(res);
  return () => clients.delete(res);
}

export function broadcastSse(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

/** Unique per process start: clients compare it to notice that the backend was restarted. */
export const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface RestartNotice { at: number; services: string[] }
let pendingRestart: RestartNotice | null = null;

/** Announce a planned restart (selfupdate) to every open client, including ones connecting later. */
export function announceRestart(seconds: number, services: string[]): RestartNotice {
  pendingRestart = { at: Date.now() + seconds * 1000, services };
  broadcastSse('server-restart', pendingRestart);
  return pendingRestart;
}

/** Notice for a client that connects now: only while the countdown runs. Afterwards a page that
 * connects is already served by the new version (frontend-only) or by the new process (backend). */
export function currentRestartNotice(): RestartNotice | null {
  if (pendingRestart && Date.now() >= pendingRestart.at) pendingRestart = null;
  return pendingRestart;
}
