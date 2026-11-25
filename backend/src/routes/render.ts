import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { query } from '../db';
import { AppError } from '../middleware/errorHandler';
import * as mem from '../services/memory';
import { render, saveAttachment, allowedRoots, insideRoots, parseHosts, type RenderOpts } from '../services/render';

/** POST /render/claude: Claude in this container renders HTML/URL to PNG and gets chat attachments back. */
export const renderRouter = Router();
const claude = Router();
claude.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const tok = String(req.headers['x-memory-token'] ?? '');
    // a run in a shared project has a project token (no personal memory); rendering is allowed with it
    const userId = await mem.userForMemoryToken(tok) ?? (await (await import('../services/sharedProjects')).scopeForProjectToken(tok))?.userId;
    if (!userId) throw new AppError(401, 'Token ongeldig of verlopen');
    (req as Request & { memUser?: string }).memUser = userId;
    next();
  } catch (err) { next(err); }
});

let running = 0;
claude.post('/', async (req, res, next) => {
  try {
    const userId = (req as Request & { memUser?: string }).memUser!;
    const b = (req.body ?? {}) as RenderOpts & { conversationId?: string; name?: string; out?: string };
    const u = await query<{ role: string; hosts: string | null }>("SELECT role, preferences->>'render_hosts' AS hosts FROM users WHERE id = $1 AND is_active", [userId]);
    if (!u.rows.length) throw new AppError(403, 'Gebruiker niet actief');
    const isAdmin = u.rows[0].role === 'admin';
    const roots = allowedRoots(userId, isAdmin);
    let conversationId: string | null = null;
    if (b.conversationId) {
      const c = await (await import('../services/sharedProjects')).convAccess(b.conversationId, userId);
      if (!c) throw new AppError(404, 'Gesprek niet gevonden');
      conversationId = b.conversationId;
    }
    let outDir: string | null = null;
    if (b.out) {
      outDir = insideRoots(b.out, roots);
      if (!outDir || !fs.statSync(outDir).isDirectory()) throw new AppError(400, 'out niet gevonden of buiten je werkruimte');
    }
    if (!conversationId && !outDir) throw new AppError(400, 'Geef conversationId (in de chat tonen) en/of out (map in je werkruimte)');
    if (running >= 3) throw new AppError(429, 'Te veel renders tegelijk, probeer het zo opnieuw');
    running++;
    let shots;
    try {
      shots = await render({ ...b, allowPrivate: isAdmin && !!b.allowPrivate, hosts: parseHosts(u.rows[0].hosts).map, isAdmin }, roots);
    } catch (err) {
      throw new AppError(400, `Render mislukt: ${(err as Error).message.split('\n')[0].slice(0, 300)}`);
    } finally { running--; }
    const base = String(b.name || 'ontwerp').replace(/\.png$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'ontwerp';
    const out: Array<{ width: number; bytes: number; url?: string; markdown?: string; path?: string }> = [];
    for (const s of shots) {
      const name = `${base}-${s.width}.png`;
      const item: { width: number; bytes: number; url?: string; markdown?: string; path?: string } = { width: s.width, bytes: s.png.length };
      if (conversationId) {
        const a = await saveAttachment(userId, conversationId, name, s.png);
        item.url = a.url;
        item.markdown = `![${base} ${s.width} px](${a.url})`;
      }
      if (outDir) {
        const p = path.join(outDir, name);
        fs.writeFileSync(p, s.png, { mode: 0o640 });
        try { const st = fs.statSync(outDir); fs.chownSync(p, st.uid, st.gid); } catch { /* ignore */ }
        item.path = p;
      }
      out.push(item);
    }
    res.json({ shots: out, hint: conversationId ? 'Zet de markdown-regels letterlijk in je antwoord: dan ziet de gebruiker de afbeeldingen in de chat.' : undefined });
  } catch (err) { next(err); }
});

/** GET/PUT /render/claude/hosts: the user's hosts list for screenshots (same field as Settings > Profiel). */
claude.get('/hosts', async (req, res, next) => {
  try {
    const userId = (req as Request & { memUser?: string }).memUser!;
    const r = await query<{ hosts: string | null }>("SELECT preferences->>'render_hosts' AS hosts FROM users WHERE id = $1", [userId]);
    const text = r.rows[0]?.hosts ?? '';
    const { map, errors } = parseHosts(text);
    res.json({ hosts: text, entries: [...map].map(([name, t]) => ({ name, ...t })), errors });
  } catch (err) { next(err); }
});
claude.put('/hosts', async (req, res, next) => {
  try {
    const userId = (req as Request & { memUser?: string }).memUser!;
    const text = String((req.body ?? {}).hosts ?? '');
    if (text.length > 4000) throw new AppError(400, 'Hostlijst te lang (max 4000 tekens)');
    const { map, errors } = parseHosts(text);
    if (errors.length) throw new AppError(400, `Ongeldige regels: ${errors.slice(0, 5).join('; ')}`);
    await query("UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || jsonb_build_object('render_hosts', $1::text) WHERE id = $2", [text, userId]);
    res.json({ ok: true, entries: [...map].map(([name, t]) => ({ name, ...t })) });
  } catch (err) { next(err); }
});

renderRouter.use("/claude", claude);
