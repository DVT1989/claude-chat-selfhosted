import { Router, Request, Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { getUserHomeDir } from '../services/claudeCode';
import { requireAdmin } from '../middleware/auth';
import { listSharedSkills, sharedNamesOf, setSkillShared } from '../services/userSkills';
import { query } from '../db';
import { listOwnSkills, prepareSkill, saveOwnSkill, deleteOwnSkill, MAX_SKILL_BYTES } from '../services/userSkills';
import { importFromGithub } from '../services/githubSkills';

export const skillsRouter = Router();

const MANIFEST = '/shared-skills/MANIFEST.json';

type Manifest = { generatedAt: string | null; generatedOn: string | null; skills: unknown[]; hooks?: unknown[] };

// Shared skills (synced to the NAS with sync_skills.py) plus this user's own skills.
skillsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  let manifest: Manifest = { generatedAt: null, generatedOn: null, skills: [] };
  if (existsSync(MANIFEST)) {
    try {
      const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest & { excluded?: unknown };
      // "excluded" (skills that could not be synced) is of no use in the app, so it is not sent
      manifest = { generatedAt: m.generatedAt, generatedOn: m.generatedOn, skills: m.skills ?? [], hooks: m.hooks };
    } catch {
      res.status(500).json({ error: 'Skills manifest unreadable' });
      return;
    }
  }
  const uid = req.user!.userId;
  const shared = await sharedNamesOf(uid);
  res.json({
    ...manifest,
    own: listOwnSkills(getUserHomeDir(uid)).map((s) => ({ ...s, shared: shared.has(s.name) })),
    // skills admins share with everyone (read-only for this user)
    sharedByOthers: (await listSharedSkills(uid)).map(({ dir: _dir, ...s }) => s),
  });
});

const skillSchema = z.object({
  name: z.string().max(100).optional(),
  description: z.string().max(1024).optional(),
  instructions: z.string().max(MAX_SKILL_BYTES).optional(),
  skillMd: z.string().max(MAX_SKILL_BYTES).optional(),
});

// Add or replace one of the user's own skills (form fields or an uploaded SKILL.md)
skillsRouter.post('/', requireAuth, (req: Request, res: Response) => {
  const parsed = skillSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Ongeldige invoer' }); return; }
  try {
    const { name, content } = prepareSkill(parsed.data);
    saveOwnSkill(getUserHomeDir(req.user!.userId), name, content);
    res.json({ ok: true, name });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Import (or update) skills from a public GitHub repo or folder
skillsRouter.post('/github', requireAuth, async (req: Request, res: Response) => {
  const parsed = z.object({ url: z.string().min(3).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Geef een GitHub-link.' }); return; }
  try {
    res.json(await importFromGithub(getUserHomeDir(req.user!.userId), parsed.data.url));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

skillsRouter.delete('/:name', requireAuth, async (req: Request, res: Response) => {
  const ok = deleteOwnSkill(getUserHomeDir(req.user!.userId), String(req.params.name));
  if (!ok) { res.status(404).json({ error: 'Skill niet gevonden' }); return; }
  await query('DELETE FROM shared_skills WHERE owner_id = $1 AND name = $2', [req.user!.userId, String(req.params.name)]);
  res.json({ ok: true });
});

// Admins: share one of their own skills with everyone, or stop sharing
skillsRouter.put('/:name/share', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const parsed = z.object({ shared: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Ongeldige invoer' }); return; }
  try {
    await setSkillShared(req.user!.userId, String(req.params.name), parsed.data.shared);
    res.json({ ok: true, shared: parsed.data.shared });
  } catch (err) {
    const e = err as { status?: number; statusCode?: number; message: string };
    res.status(e.statusCode ?? e.status ?? 400).json({ error: e.message });
  }
});
