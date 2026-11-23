import { Router, Request, Response } from 'express';
import { generateSecret, generateURI, verify as verifyTotp, createGuardrails } from 'otplib';
import { toDataURL } from 'qrcode';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt, hashToken } from '../services/crypto';
import { query } from '../db';
import { sessions } from '../redis';
import { requireAuth, auditLog } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export const totpRouter = Router();
totpRouter.use(requireAuth);

// v12 secrets were 10 bytes; v13 requires 16 unless relaxed. Accept +/- 1 step (30s) like before.
const guardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });

const APP_NAME = 'Claude Chat';

// Kick every other device but keep the current session, so the settings page keeps working.
async function revokeOtherSessions(req: Request, userId: string): Promise<void> {
  const token = req.cookies?.auth_token ?? req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    await sessions.delAll(userId);
    await query('DELETE FROM sessions WHERE user_id = $1', [userId]).catch(() => {});
    return;
  }
  const keep = hashToken(token);
  await sessions.delAllExcept(userId, keep);
  await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, keep]).catch(() => {});
}

// Start enrollment: generate fresh secret, store as pending, return otpauth URL + QR.
totpRouter.post('/setup', async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.userId;
    const result = await query<{ email: string; name: string | null; totp_enabled: boolean }>(
      'SELECT email, name, totp_enabled FROM users WHERE id = $1',
      [userId],
    );
    const user = result.rows[0];
    if (!user) throw new AppError(404, 'User not found');
    if (user.totp_enabled) throw new AppError(400, 'TOTP already enabled');

    const secret = generateSecret();
    const accountName = user.name || user.email || 'user';
    const otpauthUrl = generateURI({ issuer: APP_NAME, label: accountName, secret });
    const qrDataUrl = await toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });

    await query('UPDATE users SET pending_totp_secret = $1 WHERE id = $2', [encrypt(secret), userId]);

    res.json({ secret, otpauthUrl, qrDataUrl });
  } catch (err) {
    next(err);
  }
});

// Confirm enrollment: verify code, then activate.
totpRouter.post('/enable', async (req: Request, res: Response, next) => {
  try {
    const body = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).parse(req.body);
    const userId = req.user!.userId;

    const r = await query<{ pending_totp_secret: string | null; totp_enabled: boolean }>(
      'SELECT pending_totp_secret, totp_enabled FROM users WHERE id = $1',
      [userId],
    );
    const row = r.rows[0];
    if (!row) throw new AppError(404, 'User not found');
    if (row.totp_enabled) throw new AppError(400, 'TOTP already enabled');
    if (!row.pending_totp_secret) throw new AppError(400, 'No pending TOTP setup. Call /setup first.');

    let plainSecret: string;
    try { plainSecret = decrypt(row.pending_totp_secret); } catch { plainSecret = row.pending_totp_secret; }
    const valid = (await verifyTotp({ token: body.code, secret: plainSecret, epochTolerance: 30, guardrails })).valid;
    if (!valid) throw new AppError(400, 'Code incorrect. Probeer opnieuw.');

    await query(
      'UPDATE users SET totp_secret = pending_totp_secret, totp_enabled = TRUE, pending_totp_secret = NULL WHERE id = $1',
      [userId],
    );
    // Force re-login on every other device so the new factor is required there; this session stays valid.
    await revokeOtherSessions(req, userId);
    await auditLog(userId, 'user.totp.enable', 'user', userId, req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Disable: requires password (or current TOTP code as fallback).
totpRouter.post('/disable', async (req: Request, res: Response, next) => {
  try {
    const body = z.object({ password: z.string().min(1) }).parse(req.body);
    const userId = req.user!.userId;

    const r = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );
    if (!r.rows[0]) throw new AppError(404, 'User not found');
    const ok = await bcrypt.compare(body.password, r.rows[0].password_hash);
    if (!ok) throw new AppError(401, 'Wachtwoord onjuist');

    await query(
      'UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, pending_totp_secret = NULL WHERE id = $1',
      [userId],
    );
    // Disabling 2FA is a sensitive change: kick all other devices; this session stays valid.
    await revokeOtherSessions(req, userId);
    await auditLog(userId, 'user.totp.disable', 'user', userId, req.ip ?? '', {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Cancel pending setup (user changed their mind before confirming).
totpRouter.post('/cancel-setup', async (req: Request, res: Response, next) => {
  try {
    await query('UPDATE users SET pending_totp_secret = NULL WHERE id = $1', [req.user!.userId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
