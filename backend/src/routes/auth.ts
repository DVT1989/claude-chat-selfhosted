import { Router, Request, Response } from 'express';
import { isKnownLanguage } from '../services/i18n';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from '../db';
import { sessions } from '../redis';
import { config } from '../config';
import { requireAuth, auditLog, JwtPayload } from '../middleware/auth';
import { hashToken, decrypt as decryptSecret } from '../services/crypto';
import { AppError } from '../middleware/errorHandler';
import rateLimit from 'express-rate-limit';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginSchema = z.object({
  totp_code: z.string().regex(/^[0-9]{6}$/).optional(),
  email: z.string().min(1),
  password: z.string().min(1),
  remember: z.boolean().optional(),
});

/** "Onthouden" on the login screen: stay signed in for 90 days on that device. */
const REMEMBER_MS = 90 * 24 * 60 * 60 * 1000;

function issueToken(user: { id: string; email: string; role: string; language: string; theme: string }, ttlMs: number = config.sessionMaxAgeMs): string {
  const payload: JwtPayload = { userId: user.id, email: user.email, role: user.role, language: user.language, theme: user.theme };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: Math.floor(ttlMs / 1000) });
}

function setCookieAndRespond(
  req: Request,
  res: Response,
  token: string,
  user: { id: string; email: string; name: string | null; role: string; language: string; theme: string; avatar?: string | null; default_model?: string | null; totp_enabled?: boolean; theme_mode?: string; accent_color?: string; preferences?: Record<string, unknown> | null },
  ttlMs: number = config.sessionMaxAgeMs,
) {
  // trust proxy is enabled, so req.secure reflects X-Forwarded-Proto from upstream.
  // This makes the cookie work over plain HTTP (LAN / mobile data) and over HTTPS
  // (Synology Application Portal with SSL termination) without changing anything else.
  const isSecure = req.secure;
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    maxAge: ttlMs,
    path: '/',
  });
  res.cookie('NEXT_LOCALE', user.language, {
    httpOnly: false,
    secure: isSecure,
    sameSite: 'lax',
    maxAge: ttlMs,
    path: '/',
  });
  res.cookie('user-theme', user.theme, {
    httpOnly: false,
    secure: isSecure,
    sameSite: 'lax',
    maxAge: ttlMs,
    path: '/',
  });
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      language: user.language,
      theme: user.theme,
      avatar: user.avatar ?? null,
      default_model: user.default_model ?? null,
      totp_enabled: user.totp_enabled ?? false,
      theme_mode: user.theme_mode ?? 'system',
      accent_color: user.accent_color ?? '#CC785C',
      preferences: user.preferences ?? {},
    },
  });
}

// Registration is disabled — users are created by an admin only.
authRouter.post('/register', (_req, res) => {
  res.status(403).json({ error: 'Registratie is uitgeschakeld. Neem contact op met de beheerder.' });
});

authRouter.post('/login', authLimiter, async (req: Request, res: Response, next) => {
  let parsedEmail: string | undefined;
  try {
    const body = loginSchema.parse(req.body);
    parsedEmail = body.email;

    const result = await query<{
      id: string; email: string; name: string | null; role: string;
      password_hash: string; is_active: boolean;
      language: string; theme: string; avatar: string | null;
      totp_enabled: boolean; totp_secret: string | null;
      default_model: string | null; theme_mode: string; accent_color: string; preferences: Record<string, unknown> | null;
    }>(
      `SELECT id, email, name, role, password_hash, is_active, language, theme, avatar, totp_enabled, totp_secret, default_model, theme_mode, accent_color, preferences
       FROM users WHERE email = $1`,
      [body.email.toLowerCase()],
    );

    const user = result.rows[0];
    if (!user || !user.is_active) {
      await auditLog(user?.id ?? '', 'user.login.failed', 'user', user?.id ?? null, req.ip ?? '', { email: body.email, reason: user ? 'inactive' : 'unknown' });
      throw new AppError(401, 'Invalid email or password');
    }

    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      await auditLog(user.id, 'user.login.failed', 'user', user.id, req.ip ?? '', { email: body.email, reason: 'password' });
      throw new AppError(401, 'Invalid email or password');
    }

    if (user.totp_enabled && user.totp_secret) {
      if (!body.totp_code) {
        res.status(401).json({ error: 'TOTP code required', requires_totp: true });
        return;
      }
      const { verify: verifyTotp, createGuardrails } = await import('otplib');
      const guardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });
      let totpPlain: string;
      try { totpPlain = decryptSecret(user.totp_secret); } catch { totpPlain = user.totp_secret; }
      const codeOk = (await verifyTotp({ token: body.totp_code, secret: totpPlain, epochTolerance: 30, guardrails })).valid;
      if (!codeOk) {
        await auditLog(user.id, 'user.login.failed', 'user', user.id, req.ip ?? '', { email: body.email, reason: 'totp' });
        res.status(401).json({ error: 'TOTP code incorrect', requires_totp: true });
        return;
      }
    }

    const ttlMs = body.remember ? REMEMBER_MS : config.sessionMaxAgeMs;
    const token = issueToken(user, ttlMs);
    const tokenHash = hashToken(token);
    await sessions.set(tokenHash, user.id, ttlMs);

    await query(
      `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))`,
      [user.id, tokenHash, req.ip, req.headers['user-agent'] ?? null, Math.floor(ttlMs / 1000)],
    );

    await auditLog(user.id, 'login', 'user', user.id, req.ip ?? '', {});
    setCookieAndRespond(req, res, token, user, ttlMs);
  } catch (err) {
    // Log only paths we did not already log (those throw AppError 401 with this message).
    const isHandledAuthFail = err instanceof AppError && err.statusCode === 401 && err.message === 'Invalid email or password';
    if (!isHandledAuthFail) {
      const rawEmail = parsedEmail ?? (typeof req.body?.email === 'string' ? req.body.email : '');
      await auditLog('', 'user.login.failed', 'user', null, req.ip ?? '', { email: rawEmail, reason: 'unknown' });
    }
    next(err);
  }
});

authRouter.post('/logout', requireAuth, async (req: Request, res: Response) => {
  const token = req.cookies?.auth_token ?? req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const tokenHash = hashToken(token);
    await sessions.del(tokenHash);
    await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]).catch(() => {});
  }
  await auditLog(req.user!.userId, 'user.logout', 'user', req.user!.userId, req.ip ?? '', {});
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req: Request, res: Response, next) => {
  try {
    const result = await query<{ id: string; email: string; name: string | null; role: string; language: string; theme: string; avatar: string | null; default_model: string | null; totp_enabled: boolean; theme_mode: string; accent_color: string }>(
      'SELECT id, email, name, role, language, theme, avatar, default_model, totp_enabled, theme_mode, accent_color, preferences FROM users WHERE id = $1 AND is_active = true',
      [req.user!.userId],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // Prevent any browser/proxy caching — user profile must always be fresh
    // so theme, language, default_model edits are reflected immediately.
    res.setHeader('Cache-Control', 'no-store');
    // Logins before 2026-11-17 set SameSite=Strict. iOS does not send a Strict cookie with the first
    // request when a home-screen app starts, so the app opened on /login every time. Re-set the same
    // token as Lax for the rest of its lifetime (this request is same-site, so the cookie did arrive).
    const raw = req.cookies?.auth_token as string | undefined;
    const exp = raw ? (jwt.decode(raw) as { exp?: number } | null)?.exp : undefined;
    if (raw && exp && exp * 1000 > Date.now()) {
      res.cookie('auth_token', raw, { httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: exp * 1000 - Date.now(), path: '/' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

authRouter.put('/me', requireAuth, async (req: Request, res: Response, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      password: z.string().min(8).max(128).optional(),
      currentPassword: z.string().optional(),
      language: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/).optional(),
      avatar: z.string().max(150_000).optional().nullable(),
      theme: z.enum(['dark', 'dark-blue', 'light', 'light-blue']).optional(),
      default_model: z.string().max(64).nullable().optional(),
      theme_mode: z.enum(['light', 'dark', 'system']).optional(),
      accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      // spelling check in the composer and the moving background (merged into users.preferences)
      preferences: z.object({
        spellcheck: z.boolean().optional(),
        spell_lang: z.enum(['nl', 'en', 'auto']).optional(),
        bg_motion: z.boolean().optional(),
        remote_notice: z.boolean().optional(),
        prompt_suggestions: z.boolean().optional(),
        render_hosts: z.string().max(4000).optional(),
      }).optional(),
    });
    const body = schema.parse(req.body);

    if (body.password) {
      if (!body.currentPassword) throw new AppError(400, 'Current password required');
      const result = await query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [req.user!.userId],
      );
      const valid = await bcrypt.compare(body.currentPassword, result.rows[0].password_hash);
      if (!valid) throw new AppError(401, 'Current password incorrect');
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined) { updates.push(`name = $${idx++}`); values.push(body.name); }
    if (body.password) {
      updates.push(`password_hash = $${idx++}`);
      values.push(await bcrypt.hash(body.password, 12));
    }

    if (body.avatar !== undefined) {
      if (body.avatar !== null && !body.avatar.startsWith('data:image/')) {
        throw new AppError(400, 'Invalid avatar format');
      }
      updates.push(`avatar = $${idx++}`); values.push(body.avatar);
    }
    if (body.language !== undefined && !(await isKnownLanguage(body.language))) throw new AppError(400, 'Onbekende taal');
    if (body.language !== undefined) { updates.push(`language = $${idx++}`); values.push(body.language); }
    if (body.theme !== undefined) { updates.push(`theme = $${idx++}`); values.push(body.theme); }
    if (body.default_model !== undefined) { updates.push(`default_model = $${idx++}`); values.push(body.default_model); }
    if (body.theme_mode !== undefined) { updates.push(`theme_mode = $${idx++}`); values.push(body.theme_mode); }
    if (body.accent_color !== undefined) { updates.push(`accent_color = $${idx++}`); values.push(body.accent_color); }
    if (body.preferences !== undefined) { updates.push(`preferences = COALESCE(preferences, '{}'::jsonb) || $${idx++}::jsonb`); values.push(JSON.stringify(body.preferences)); }

    if (updates.length === 0) { res.json({ ok: true }); return; }

    values.push(req.user!.userId);
    await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`,
      values,
    );

    // If the password just changed, kill every existing session for this user
    // (Redis + Postgres), then re-issue a fresh JWT so this device stays logged in.
    if (body.password) {
      await sessions.delAll(req.user!.userId);
      await query('DELETE FROM sessions WHERE user_id = $1', [req.user!.userId]).catch(() => {});
      await auditLog(req.user!.userId, 'user.password.change', 'user', req.user!.userId, req.ip ?? '', {});
    }

    const updated = await query<{ id: string; email: string; name: string | null; role: string; language: string; theme: string; avatar: string | null; default_model: string | null; totp_enabled: boolean; theme_mode: string; accent_color: string }>(
      'SELECT id, email, name, role, language, theme, avatar, default_model, totp_enabled, theme_mode, accent_color, preferences FROM users WHERE id = $1',
      [req.user!.userId],
    );
    const u = updated.rows[0];

    const isSecure = req.secure;

    if (body.password) {
      // Re-issue a fresh JWT and store its session so the user is not kicked off this device.
      const newToken = issueToken(u);
      const newHash = hashToken(newToken);
      await sessions.set(newHash, u.id, config.sessionMaxAgeMs);
      await query(
        `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')`,
        [u.id, newHash, req.ip, req.headers['user-agent'] ?? null],
      ).catch(() => {});
      res.cookie('auth_token', newToken, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        maxAge: config.sessionMaxAgeMs,
        path: '/',
      });
    }

    if (body.language) {
      res.cookie('NEXT_LOCALE', u.language, { httpOnly: false, secure: isSecure, sameSite: 'lax', maxAge: config.sessionMaxAgeMs, path: '/' });
    }
    if (body.theme) {
      res.cookie('user-theme', u.theme, { httpOnly: false, secure: isSecure, sameSite: 'lax', maxAge: config.sessionMaxAgeMs, path: '/' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, user: u });
  } catch (err) {
    next(err);
  }
});
