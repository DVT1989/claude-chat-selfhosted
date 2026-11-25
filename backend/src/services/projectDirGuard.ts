import { chmodSync, chownSync, readdirSync, statSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config';

/**
 * The project dir (source, .env, backups) is mounted at its host path. Normal chats run as their own uid (20000+)
 * and must not read it; only the admin chat (gid 0) may. On the NAS the Dockerfile closes /volume1.
 * On other hosts (e.g. /opt/claude-chat or /home/x/claude-chat) the parent dirs are created by docker
 * as 755: close the first parent that exists only for this mount (root:root 750), otherwise warn.
 */
export function guardProjectDir(dir = config.projectDir): void {
  try {
    statSync(dir);
  } catch { return; } // not mounted (e.g. tests)
  const parents: string[] = [];
  for (let d = dirname(dir); d !== '/' && d !== '.'; d = dirname(d)) parents.unshift(d);
  for (const p of parents) {
    const next = dir.slice(p.length + 1).split('/')[0];
    let entries: string[];
    try { entries = readdirSync(p); } catch { continue; }
    if (entries.length === 1 && entries[0] === next) {
      const st = statSync(p);
      if (st.uid !== 0 || st.gid !== 0 || (st.mode & 0o777) !== 0o750) { chownSync(p, 0, 0); chmodSync(p, 0o750); }
      return;
    }
  }
  // No mount-only parent (the dir sits next to other things in the container). Changing the dir itself
  // could lock out the admin chat (gid 0) when the host owner is another group, so only warn.
  const st = statSync(dir);
  if (st.mode & 0o005 || st.uid === 1001) {
    console.warn(`! ${dir} is leesbaar voor gewone chats (uid 1001). Kies een pad met een eigen bovenmap, bijv. /srv/claude-chat of /volume1/docker/claude-chat.`);
  }
}
