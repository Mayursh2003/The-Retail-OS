import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { ActorContext, UserRole } from '../../shared/types/domain';
import { dbStore } from '../store/database';

let firebaseAdminReady = false;

function initFirebaseAdmin(): void {
  if (firebaseAdminReady || getApps().length > 0) {
    firebaseAdminReady = true;
    return;
  }
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { projectId?: string };
      if (raw.projectId) {
        initializeApp({ projectId: raw.projectId });
        firebaseAdminReady = true;
      }
    }
  } catch (err) {
    console.warn('[auth] Firebase Admin fallback mode:', err instanceof Error ? err.message : err);
  }
}

initFirebaseAdmin();

export interface AuthenticatedRequest extends Request {
  actor?: ActorContext;
}

const BOOTSTRAPPED_ADMIN_EMAIL = 'mayursharma.bkbiet2025@gmail.com';

export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const demoUserId = req.headers['x-demo-user-id'] as string | undefined;
    const demoMode = req.headers['x-demo-mode'] === 'true';

    // 1. Real Firebase ID Token path
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (firebaseAdminReady && token) {
        try {
          const decoded = await getAuth().verifyIdToken(token);
          const email = decoded.email || '';
          const state = dbStore.getState();
          let userRecord = state.users.find(
            (u) => u.userId === decoded.uid || (email && u.email?.toLowerCase() === email.toLowerCase())
          );

          if (!userRecord && email.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL) {
            userRecord = {
              userId: decoded.uid,
              role: 'DEVELOPER',
              tenantId: 'platform',
              assignedOutletIds: [],
              displayName: decoded.name || 'Platform Super Admin',
              email,
              accountStatus: 'active',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              isDemoData: false,
            };
            state.users.push(userRecord);
            dbStore.save();
          }

          if (!userRecord) {
            // Check pending invitation for this email
            const invite = state.invitations.find(
              (i) => i.email.toLowerCase() === email.toLowerCase() && i.status === 'pending'
            );
            if (invite) {
              invite.status = 'accepted';
              userRecord = {
                userId: decoded.uid,
                role: invite.role,
                tenantId: invite.tenantId,
                assignedOutletIds: invite.assignedOutletIds,
                displayName: invite.displayName || decoded.name || email.split('@')[0],
                email,
                accountStatus: 'active',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                isDemoData: false,
              };
              state.users.push(userRecord);
              dbStore.save();
            }
          }

          if (!userRecord || userRecord.accountStatus !== 'active') {
            res.status(403).json({ error: 'Account is not active or has not been invited to a tenant.' });
            return;
          }

          req.actor = {
            userId: userRecord.userId,
            email: userRecord.email,
            displayName: userRecord.displayName,
            role: userRecord.role,
            tenantId: userRecord.tenantId,
            assignedOutletIds: userRecord.assignedOutletIds,
            isDemoMode: false,
          };
          next();
          return;
        } catch (err) {
          console.warn('[auth] Firebase ID token verification failed:', err);
          res.status(401).json({ error: 'Invalid or expired Firebase authentication token.' });
          return;
        }
      }
    }

    // 2. Explicit Demo Workspace Mode path (clearly marked isDemoMode: true)
    if (demoMode && demoUserId) {
      const state = dbStore.getState();
      const demoUser = state.users.find((u) => u.userId === demoUserId);
      if (!demoUser || demoUser.accountStatus !== 'active') {
        res.status(403).json({ error: 'Demo account is disabled or unavailable.' });
        return;
      }
      req.actor = {
        userId: demoUser.userId,
        email: demoUser.email,
        displayName: demoUser.displayName,
        role: demoUser.role,
        tenantId: demoUser.tenantId,
        assignedOutletIds: demoUser.assignedOutletIds,
        isDemoMode: true,
      };
      next();
      return;
    }

    res.status(401).json({ error: 'Authentication required.' });
  } catch (err) {
    console.error('[auth] Unexpected auth error:', err);
    res.status(500).json({ error: 'Authentication verification failed.' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.actor) {
      res.status(401).json({ error: 'Unauthenticated.' });
      return;
    }
    if (!roles.includes(req.actor.role)) {
      res.status(403).json({ error: `Role ${req.actor.role} is not permitted for this operation.` });
      return;
    }
    next();
  };
}

// Lightweight sliding-window API rate limiter
const requestHits = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || 'local';
  const now = Date.now();
  const bucket = requestHits.get(key);
  if (!bucket || bucket.resetAt < now) {
    requestHits.set(key, { count: 1, resetAt: now + 60_000 });
    next();
    return;
  }
  bucket.count += 1;
  if (bucket.count > 240) {
    res.status(429).json({ error: 'Rate limit exceeded. Please wait before retrying.' });
    return;
  }
  next();
}
