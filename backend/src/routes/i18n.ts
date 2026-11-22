import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { getAuthStatus } from '../services/claudeCode';
import { CODE_RE, getJob, getMessages, listLanguages, startGeneration } from '../services/i18n';

export const i18nRouter = Router();

// public: needed on the login page and by the server-side layout
i18nRouter.get('/languages', async (_req, res, next) => {
  try { res.json({ languages: await listLanguages() }); } catch (e) { next(e); }
});

i18nRouter.get('/messages/:code', async (req, res, next) => {
  try {
    if (!CODE_RE.test(req.params.code)) throw new AppError(400, 'Ongeldige taalcode');
    const m = await getMessages(req.params.code);
    if (!m) throw new AppError(404, 'Taal niet gevonden');
    res.json(m);
  } catch (e) { next(e); }
});

i18nRouter.post('/generate', requireAuth, async (req, res, next) => {
  try {
    const input = String(req.body?.language ?? '').trim();
    if (input.length < 2 || input.length > 40) throw new AppError(400, 'Typ de naam van een taal');
    if ((await getAuthStatus(req.user!.userId)) !== 'authenticated') throw new AppError(422, 'Koppel eerst je Claude-account');
    const job = startGeneration(req.user!.userId, input);
    res.json({ jobId: job.id });
  } catch (e) { next(e); }
});

i18nRouter.get('/jobs/:id', requireAuth, (req, res) => {
  const j = getJob(String(req.params.id), req.user!.userId);
  if (!j) { res.status(404).json({ error: 'Taak niet gevonden' }); return; }
  res.json({ status: j.status, done: j.done, total: j.total, code: j.code, name: j.name, error: j.error, fallbackKeys: j.fallbackKeys });
});
