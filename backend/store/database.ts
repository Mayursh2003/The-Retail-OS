import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActorContext, AuditLog } from '../../shared/types/domain';
import { createInitialSeedState, type StoreState } from './seed';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const STORE_FILE = path.join(DATA_DIR, 'retail-brain-store.json');

const ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update(process.env.CAMERA_SECRET_KEY || 'retail-brain-local-dev-secret-key')
  .digest();

export function encryptCameraSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes256gcm:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

class RetailDatabase {
  private state: StoreState;

  constructor() {
    this.state = this.load();
  }

  private load(): StoreState {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as StoreState;
        if (parsed && Array.isArray(parsed.tenants) && Array.isArray(parsed.outlets)) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn('[store] Failed to load persisted store, initializing seed:', err);
    }
    const seed = createInitialSeedState();
    this.persist(seed);
    return seed;
  }

  private persist(nextState: StoreState): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmp = `${STORE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(nextState, null, 2), 'utf-8');
      fs.renameSync(tmp, STORE_FILE);
    } catch (err) {
      console.error('[store] Persist error:', err);
    }
  }

  public getState(): StoreState {
    return this.state;
  }

  public save(): void {
    this.persist(this.state);
  }

  public resetDemoState(): StoreState {
    this.state = createInitialSeedState();
    this.persist(this.state);
    return this.state;
  }

  public appendAudit(entry: Omit<AuditLog, 'logId' | 'timestamp'>): AuditLog {
    const log: AuditLog = {
      logId: `aud-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.state.auditLogs.unshift(log);
    if (this.state.auditLogs.length > 500) {
      this.state.auditLogs.length = 500;
    }
    this.save();
    return log;
  }

  public scopeSnapshotForActor(actor: ActorContext) {
    const isDev = actor.role === 'DEVELOPER';
    const isOwner = actor.role === 'CLIENT_OWNER';

    const tenants = isDev
      ? this.state.tenants
      : this.state.tenants.filter((t) => t.tenantId === actor.tenantId);

    const outlets = isDev
      ? this.state.outlets
      : isOwner
        ? this.state.outlets.filter((o) => o.tenantId === actor.tenantId)
        : this.state.outlets.filter(
            (o) => o.tenantId === actor.tenantId && actor.assignedOutletIds.includes(o.outletId)
          );

    const allowedOutletIds = new Set(outlets.map((o) => o.outletId));

    const users = isDev
      ? this.state.users
      : isOwner
        ? this.state.users.filter((u) => u.tenantId === actor.tenantId)
        : this.state.users.filter((u) => u.userId === actor.userId);

    const invitations = isDev
      ? this.state.invitations
      : isOwner
        ? this.state.invitations.filter((i) => i.tenantId === actor.tenantId)
        : [];

    const cameras = isDev
      ? this.state.cameras
      : this.state.cameras.filter(
          (c) => c.tenantId === actor.tenantId && allowedOutletIds.has(c.outletId)
        );

    const visitSessions = isDev
      ? this.state.visitSessions
      : this.state.visitSessions.filter(
          (s) => s.tenantId === actor.tenantId && allowedOutletIds.has(s.outletId)
        );

    const detectionEvents = isDev
      ? this.state.detectionEvents
      : this.state.detectionEvents.filter(
          (e) => e.tenantId === actor.tenantId && allowedOutletIds.has(e.outletId)
        );

    const transactions = isDev
      ? this.state.transactions
      : this.state.transactions.filter(
          (t) => t.tenantId === actor.tenantId && allowedOutletIds.has(t.outletId)
        );

    const reports = isDev
      ? this.state.reports
      : isOwner
        ? this.state.reports.filter((r) => r.tenantId === actor.tenantId)
        : [];

    const auditLogs = isDev
      ? this.state.auditLogs
      : isOwner
        ? this.state.auditLogs.filter((l) => l.tenantId === actor.tenantId)
        : this.state.auditLogs.filter(
            (l) => l.tenantId === actor.tenantId && l.userId === actor.userId
          );

    return {
      actor,
      tenants,
      outlets,
      users,
      invitations,
      cameras,
      visitSessions,
      detectionEvents,
      transactions,
      reports,
      auditLogs,
      modelConfig: this.state.modelConfig,
    };
  }
}

export const dbStore = new RetailDatabase();
