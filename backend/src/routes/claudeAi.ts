import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { addSseClient, currentRestartNotice, BOOT_ID } from '../services/sseEvents';

export const claudeAiRouter = Router();
claudeAiRouter.use(requireAuth);

/**
 * GET /claude-ai/events
 * SSE stream — pushes conversation-update events in real time.
 */
claudeAiRouter.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const remove = addSseClient(res);
  res.write(`event: hello\ndata: ${JSON.stringify({ bootId: BOOT_ID })}\n\n`);
  const notice = currentRestartNotice();
  if (notice) res.write(`event: server-restart\ndata: ${JSON.stringify(notice)}\n\n`);

  // Keep-alive ping every 25 s (nginx times out idle connections at 30 s)
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25_000);

  req.on('close', () => { clearInterval(ping); remove(); });
});
