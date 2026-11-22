import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import * as lessons from '../services/lessons';

export const lessonsRouter = Router();

// Claude Code inside this container adds a lesson (loopback + per-run token)
lessonsRouter.post('/claude', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const addr = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new AppError(403, 'Alleen lokaal bereikbaar');
    const userId = await lessons.userForLessonToken(String(req.headers['x-lessons-token'] ?? ''));
    if (!userId) throw new AppError(401, 'Token ongeldig of verlopen');
    const body = z.object({
      topic: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,30}$/, 'topic: kort, bijv. devices, github, m365, messenger, ssh, app'),
      lesson: z.string().trim().min(15).max(400),
    }).parse(req.body);
    const out = await lessons.addLesson(userId, body.topic, body.lesson);
    await auditLog(userId, 'lesson.add', 'lesson', null, '', { topic: body.topic, lesson: body.lesson, result: out });
    res.json({ result: out });
  } catch (err) { next(err); }
});

// Admin: view and remove
lessonsRouter.use(requireAuth);
lessonsRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.user!.role !== 'admin') { next(new AppError(403, 'Alleen beheerders')); return; }
  next();
});

lessonsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ lessons: await lessons.listLessons() }); } catch (err) { next(err); }
});

lessonsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await lessons.deleteLesson(String(req.params.id));
    await auditLog(req.user!.userId, 'lesson.delete', 'lesson', String(req.params.id), req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});
