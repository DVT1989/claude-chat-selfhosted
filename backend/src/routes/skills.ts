import { Router, Request, Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { getUserHomeDir } from '../services/claudeCode';
import { listOwnSkills, prepareSkill, saveOwnSkill, deleteOwnSkill, MAX_SKILL_BYTES } from '../services/userSkills';
import { importFromGithub } from '../services/githubSkills';

export const skillsRouter = Router();

const MANIFEST = '/shared-skills/MANIFEST.json';

type Manifest = { generatedAt: string | null; generatedOn: string | null; skills: unknown[]; hooks?: unknown[] };

// Shared skills (synced to the NAS with sync_skills.py) plus this user's own skills.
skillsRouter.get('/', requireAuth, (req: Request, res: Response) => {
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
  res.json({ ...manifest, own: listOwnSkills(getUserHomeDir(req.user!.userId)) });
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

skillsRouter.delete('/:name', requireAuth, (req: Request, res: Response) => {
  const ok = deleteOwnSkill(getUserHomeDir(req.user!.userId), String(req.params.name));
  if (!ok) { res.status(404).json({ error: 'Skill niet gevonden' }); return; }
  res.json({ ok: true });
});
