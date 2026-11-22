import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { sessions } from '../redis';
import { hashToken } from '../services/crypto';
import { query } from '../db';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  language: string;
  theme: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token =
    req.cookies?.auth_token ??
    req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;

    // Check session is still valid in Redis
    const tokenHash = hashToken(token);
    const sessionUserId = await sessions.get(tokenHash);
    if (!sessionUserId) {
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

// Verify that a resource belongs to the authenticated user
export function ownResource(
  getUserId: (req: Request) => string | undefined,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const resourceUserId = getUserId(req);
    if (!resourceUserId || resourceUserId !== req.user?.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    next();
  };
}

export async function auditLog(
  userId: string,
  action: string,
  resourceType: string | null,
  resourceId: string | null,
  ip: string,
  metadata: Record<string, unknown> = {},
) {
  await query(
    `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, resourceType, resourceId, ip, JSON.stringify(metadata)],
  ).catch((err) => console.error('Audit log failed:', err));
}
