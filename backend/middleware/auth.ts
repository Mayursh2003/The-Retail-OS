import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { ActorContext, UserRole } from '../../shared/types/domain';
import { isDemoAuthAllowed } from '../security/config';
import { dbStore } from '../store/database';

let firebaseAdminReady = false;

function initFirebaseAdmin(): void {
  if (firebaseAdminReady || getApps().length > 0) {
    firebaseAdminReady = true;
    return;
  }
  try {
    const projectIdFromEnv = process.env.FIREBASE_PROJECT_ID?.trim();
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (projectIdFromEnv) {
      initializeApp({ projectId: projectIdFromEnv });
      firebaseAdminReady = true;
    } else if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { projectId?: string };
      if (raw.projectId) {
        initializeApp({ projectId: raw.projectId });
        firebaseAdminReady = true;
      }
    }
  } catch (err) {
    console.warn('[auth] Firebase Admin initialization warning:', err instanceof Error ? err.message : err);
  }
}

initFirebaseAdmin();

export interface AuthenticatedRequest extends Request {
  actor?: ActorContext;
}

const BOOTSTRAPPED_ADMIN_EMAIL = 'mayursharma.bkbiet2025@gmail.com';

export class AuthVerificationError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function resolveActorFromFirebaseToken(token: string): Promise<ActorContext> {
  if (!firebaseAdminReady) {
    throw new AuthVerificationError(503, 'Firebase Admin SDK is not initialized for token verification.');
  }
  if (!token || !token.trim()) {
    throw new AuthVerificationError(401, 'Missing Firebase ID token.');
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token.trim());
  } catch {
    throw new AuthVerificationError(401, 'Invalid or expired Firebase authentication token.');
  }

  const email = decoded.email || '';
  const emailVerified = decoded.email_verified !== false;
  const state = dbStore.getState();

  let userRecord = state.users.find(
    (u) =>
      u.userId === decoded.uid ||
      (emailVerified && email && u.email?.toLowerCase() === email.toLowerCase())
  );

  if (!userRecord && emailVerified && email.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL) {
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

  if (!userRecord && emailVerified && email) {
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
    throw new AuthVerificationError(
      403,
      'Account is not active or has not been invited to a tenant.'
    );
  }

  return {
    userId: userRecord.userId,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: userRecord.role,
    tenantId: userRecord.tenantId,
    assignedOutletIds: userRecord.assignedOutletIds,
    isDemoMode: false,
  };
}

export function resolveDemoActor(demoUserId: string): ActorContext {
  if (!isDemoAuthAllowed()) {
    throw new AuthVerificationError(
      403,
      'Demo authentication is disabled in production. Sign in with Firebase Authentication.'
    );
  }
  const state = dbStore.getState();
  const demoUser = state.users.find((u) => u.userId === demoUserId);
  if (!demoUser || demoUser.accountStatus !== 'active') {
    throw new AuthVerificationError(403, 'Demo account is disabled or unavailable.');
  }
  return {
    userId: demoUser.userId,
    email: demoUser.email,
    displayName: demoUser.displayName,
    role: demoUser.role,
    tenantId: demoUser.tenantId,
    assignedOutletIds: demoUser.assignedOutletIds,
    isDemoMode: true,
  };
}

export function resolveActorByUserId(userId: string): ActorContext | null {
  const state = dbStore.getState();
  const user = state.users.find((u) => u.userId === userId && u.accountStatus === 'active');
  if (!user) return null;
  if (user.isDemoData && !isDemoAuthAllowed()) return null;
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    tenantId: user.tenantId,
    assignedOutletIds: user.assignedOutletIds,
    isDemoMode: Boolean(user.isDemoData),
  };
}

export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const demoUserId = req.headers['x-demo-user-id'] as string | undefined;
    const demoMode = req.headers['x-demo-mode'] === 'true';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      req.actor = await resolveActorFromFirebaseToken(token);
      next();
      return;
    }

    if (demoMode || demoUserId) {
      if (!isDemoAuthAllowed()) {
        res.status(403).json({
          error: 'Demo authentication is disabled in production. Use Firebase Authentication.',
        });
        return;
      }
      if (demoMode && demoUserId) {
        req.actor = resolveDemoActor(demoUserId);
        next();
        return;
      }
    }

    res.status(401).json({ error: 'Authentication required.' });
  } catch (err) {
    if (err instanceof AuthVerificationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
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
