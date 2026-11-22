import { Router, Request, Response } from 'express';
import { rmSync } from 'fs';
import { z } from 'zod';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { startAuthLogin, exchangeOAuthCode, getAuthStatus, getUserHomeDir } from '../services/claudeCode';
import { accountsOverview, nextSlot, removeAccount } from '../services/claudeAccounts';

export const claudeAuthRouter = Router();
claudeAuthRouter.use(requireAuth);

// Start OAuth login — generates PKCE URL (no process spawn needed).
// Body { newAccount: true } links an extra Claude subscription instead of (re)linking account 1.
claudeAuthRouter.post('/start', async (req: Request, res: Response, next) => {
  try {
    const { newAccount } = z.object({ newAccount: z.boolean().optional() }).parse(req.body ?? {});
    const slot = newAccount ? nextSlot(req.user!.userId) : 0;
    const { url } = await startAuthLogin(req.user!.userId, slot);
    if (!url) throw new AppError(500, 'Kon geen authenticatie URL ophalen');
    res.json({ url, slot });
  } catch (err) {
    next(err);
  }
});

// Check current auth status
claudeAuthRouter.get('/status', async (req: Request, res: Response, next) => {
  try {
    const status = await getAuthStatus(req.user!.userId);
    res.json({ status });
  } catch (err) {
    next(err);
  }
});

// All linked Claude subscriptions with their usage and which one the next message uses
claudeAuthRouter.get('/accounts', async (req: Request, res: Response, next) => {
  try {
    res.json({ accounts: await accountsOverview(req.user!.userId) });
  } catch (err) {
    next(err);
  }
});

// Exchange the authorization code for OAuth tokens and write credentials
claudeAuthRouter.post('/submit-code', async (req: Request, res: Response, next) => {
  try {
    const { code } = z.object({ code: z.string().min(1).max(2000) }).parse(req.body);
    await exchangeOAuthCode(req.user!.userId, code);
    await auditLog(req.user!.userId, 'claude.oauth.grant', 'user', req.user!.userId, req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Unlink an extra subscription (account 2+)
claudeAuthRouter.delete('/accounts/:slot', async (req: Request, res: Response, next) => {
  try {
    const slot = Number(req.params.slot);
    if (!removeAccount(req.user!.userId, slot)) throw new AppError(404, 'Account niet gevonden');
    await auditLog(req.user!.userId, 'claude.oauth.unlink', 'user', req.user!.userId, req.ip ?? '', { slot });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Logout of account 1 — removes only its login. The conversation history in ~/.claude stays:
// deleting it (as before) wiped every transcript, so --resume and the other accounts lost everything.
claudeAuthRouter.delete('/', async (req: Request, res: Response, next) => {
  try {
    const home = getUserHomeDir(req.user!.userId);
    rmSync(`${home}/.claude.json`, { force: true });
    await auditLog(req.user!.userId, 'claude.oauth.logout', 'user', req.user!.userId, req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
