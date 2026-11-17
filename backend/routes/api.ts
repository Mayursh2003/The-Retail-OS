import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express, { type Response } from 'express';
import multer from 'multer';
import type {
  Camera,
  CameraZone,
  DetectionEvent,
  Invitation,
  Outlet,
  ReportType,
  Tenant,
  Transaction,
  UserAccount,
  VisitSession,
} from '../../shared/types/domain';
import {
  checkOutletAccess,
  checkTenantAccess,
  formatLocalDateKey,
  generatePeriodReport,
  maskRtspEndpoint,
  validateCameraInput,
  validateTransactionInput,
} from '../../src/utils/analytics';
import {
  authenticateRequest,
  AuthVerificationError,
  type AuthenticatedRequest,
  rateLimitMiddleware,
  requireRole,
  resolveActorByUserId,
  resolveActorFromFirebaseToken,
  resolveDemoActor,
} from '../middleware/auth';
import {
  createStreamTicket,
  getEdgeApiKey,
  getSecurityEnvChecklist,
  getVisionServiceUrl,
  isDemoAuthAllowed,
  isProductionEnv,
  validateCameraTenantOutlet,
  verifyEdgeApiKey,
  verifyStreamTicket,
} from '../security/config';
import { dbStore, decryptCameraSecret, encryptCameraSecret } from '../store/database';
import { realtimeHub } from '../ws';

const UPLOAD_DIR = '/tmp/retail-brain-uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Temporary video upload tracking (strictly auto-expiring, never permanent archive)
const uploadedVideos = new Map<
  string,
  {
    filePath: string;
    annotatedFilePath?: string;
    mimeType: string;
    filename: string;
    expiresAt: number;
    tenantId: string;
    outletId: string;
  }
>();

let lastVerifiedYoloInferenceAt: string | null = null;

function markVerifiedYoloInference(nowIso = new Date().toISOString()): void {
  lastVerifiedYoloInferenceAt = nowIso;
}

function hasRecentVerifiedYoloInference(): boolean {
  if (!lastVerifiedYoloInferenceAt) return false;
  return Date.now() - new Date(lastVerifiedYoloInferenceAt).getTime() < 15 * 60_000;
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 120 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = ['.mp4', '.avi', '.mov', '.webm'].includes(ext);
    if (!ok) {
      cb(new Error('Only MP4, AVI, MOV, or WEBM video files are supported.'));
      return;
    }
    cb(null, true);
  },
});

async function probeVisionService(): Promise<{
  configured: boolean;
  connected: boolean;
  inferenceState: 'live_yolo' | 'processing' | 'demo_overlay' | 'offline' | 'error';
  inferenceMode: 'live_yolo' | 'demo_simulation';
  endpoint: string;
  message: string;
  model?: string;
  device?: string;
  lastVerifiedInferenceAt?: string;
}> {
  const visionUrl = getVisionServiceUrl();
  if (!visionUrl) {
    return {
      configured: false,
      connected: false,
      inferenceState: 'offline',
      inferenceMode: 'demo_simulation',
      endpoint: 'Not configured (set VISION_SERVICE_URL)',
      message:
        'VISION_SERVICE_URL is not configured on backend; live camera view uses Demo Simulation only.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const edgeKey = getEdgeApiKey();
    const resp = await fetch(`${visionUrl}/health`, {
      signal: controller.signal,
      headers: edgeKey ? { 'x-edge-api-key': edgeKey } : undefined,
    });
    clearTimeout(timer);
    if (resp.ok) {
      const info = (await resp.json().catch(() => ({}))) as {
        model?: string;
        device?: string;
      };
      const verified = hasRecentVerifiedYoloInference();
      return {
        configured: true,
        connected: true,
        inferenceState: verified ? 'live_yolo' : 'demo_overlay',
        inferenceMode: verified ? 'live_yolo' : 'demo_simulation',
        endpoint: visionUrl,
        model: info.model || 'yolov8n.pt',
        device: info.device || 'CPU',
        lastVerifiedInferenceAt: lastVerifiedYoloInferenceAt || undefined,
        message: verified
          ? 'Python YOLOv8n + ByteTrack inference verified'
          : 'Python vision-service reachable on standby; upload a test video or start an edge camera stream to run live YOLOv8n inference.',
      };
    }
    return {
      configured: true,
      connected: false,
      inferenceState: 'offline',
      inferenceMode: 'demo_simulation',
      endpoint: visionUrl,
      message: `Configured Python vision-service returned HTTP ${resp.status}; using Demo Simulation fallback.`,
    };
  } catch {
    clearTimeout(timer);
    return {
      configured: true,
      connected: false,
      inferenceState: 'offline',
      inferenceMode: 'demo_simulation',
      endpoint: visionUrl,
      message:
        'Configured VISION_SERVICE_URL is unreachable from backend; using Demo Overlay simulation.',
    };
  }
}

function probeTcpSocket(host: string, port: number, timeoutMs = 1800): Promise<{ ok: boolean; latencyMs: number; reason?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - start, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, `TCP timeout after ${timeoutMs}ms reaching ${host}:${port}`));
    socket.on('error', (err) => finish(false, err.message));
  });
}

async function resolveOptionalRequestActor(req: express.Request) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return resolveActorFromFirebaseToken(authHeader.slice(7).trim());
  }
  const demoMode = req.headers['x-demo-mode'] === 'true';
  const demoUserId = req.headers['x-demo-user-id'] as string | undefined;
  if (demoMode && demoUserId && isDemoAuthAllowed()) {
    return resolveDemoActor(demoUserId);
  }
  return null;
}

export function createApiRouter(): express.Router {
  const router = express.Router();
  router.use(rateLimitMiddleware);

  router.get('/auth/config', (_req, res) => {
    res.json({
      demoAuthEnabled: isDemoAuthAllowed(),
      productionMode: isProductionEnv(),
    });
  });

  router.get('/health', async (_req, res) => {
    const vision = await probeVisionService();
    res.json({
      status: 'ok',
      service: 'retail-brain-os-backend',
      wsClients: realtimeHub.getClientCount(),
      visionService: vision,
      securityStatus: getSecurityEnvChecklist(),
      timestamp: new Date().toISOString(),
    });
  });

  async function authorizeAndStreamUpload(
    req: express.Request,
    res: Response,
    kind: 'upload' | 'upload-annotated'
  ): Promise<void> {
    const item = uploadedVideos.get(req.params.uploadId);
    const targetPath = kind === 'upload-annotated' ? item?.annotatedFilePath : item?.filePath;
    if (!item || !targetPath || !fs.existsSync(targetPath) || item.expiresAt < Date.now()) {
      res.status(404).json({ error: 'Temporary video expired or not found.' });
      return;
    }

    let authorized = false;
    try {
      const ticketParam = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
      if (ticketParam) {
        const ticket = verifyStreamTicket(ticketParam, kind, req.params.uploadId);
        if (
          ticket &&
          ticket.tenantId === item.tenantId &&
          ticket.outletId === item.outletId &&
          resolveActorByUserId(ticket.userId)
        ) {
          authorized = true;
        }
      } else {
        const actor = await resolveOptionalRequestActor(req);
        if (actor && checkOutletAccess(actor, item.tenantId, item.outletId)) {
          authorized = true;
        }
      }
    } catch (err) {
      if (err instanceof AuthVerificationError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
    }

    if (!authorized) {
      res.status(401).json({ error: 'Authentication or valid stream ticket required.' });
      return;
    }

    const stat = fs.statSync(targetPath);
    const total = stat.size;
    const contentType = kind === 'upload-annotated' ? 'video/mp4' : item.mimeType || 'video/mp4';
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      fs.createReadStream(targetPath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': contentType,
    });
    fs.createReadStream(targetPath).pipe(res);
  }

  // Protected stream for temporary uploaded test video (requires Bearer/dev session OR scoped HMAC ticket)
  router.get('/vision/stream/:uploadId', async (req, res: Response) => {
    await authorizeAndStreamUpload(req, res, 'upload');
  });

  // Protected stream for Python-generated annotated MP4 output
  router.get('/vision/annotated/:uploadId', async (req, res: Response) => {
    await authorizeAndStreamUpload(req, res, 'upload-annotated');
  });

  // Protected MJPEG camera proxy stream (requires Bearer/dev auth OR scoped HMAC stream ticket; never exposes RTSP URLs to browser)
  router.get('/cameras/:cameraId/stream/mjpeg', async (req, res: Response) => {
    const state = dbStore.getState();
    const camera = state.cameras.find((c) => c.cameraId === req.params.cameraId);
    if (!camera) {
      res.status(404).json({ error: 'Camera not found.' });
      return;
    }

    const integrity = validateCameraTenantOutlet({
      cameras: state.cameras,
      outlets: state.outlets,
      cameraId: camera.cameraId,
      tenantId: camera.tenantId,
      outletId: camera.outletId,
    });
    if (!integrity.ok) {
      res.status(403).json({ error: integrity.error });
      return;
    }

    let authorized = false;
    try {
      const ticketParam = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
      if (ticketParam) {
        const ticket = verifyStreamTicket(ticketParam, 'mjpeg', camera.cameraId);
        if (ticket && ticket.tenantId === camera.tenantId && ticket.outletId === camera.outletId) {
          const actor = resolveActorByUserId(ticket.userId);
          if (actor && checkOutletAccess(actor, camera.tenantId, camera.outletId)) {
            authorized = true;
          }
        }
      } else {
        const actor = await resolveOptionalRequestActor(req);
        if (actor && checkOutletAccess(actor, camera.tenantId, camera.outletId)) {
          authorized = true;
        }
      }
    } catch (err) {
      if (err instanceof AuthVerificationError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
    }

    if (!authorized) {
      res.status(401).json({ error: 'Authentication and outlet access required for MJPEG stream.' });
      return;
    }

    const visionUrl = getVisionServiceUrl();
    const edgeKey = getEdgeApiKey();
    if (!visionUrl || !edgeKey) {
      res.status(503).json({
        error: 'VISION_SERVICE_URL and EDGE_API_KEY must be configured on backend for live MJPEG streaming.',
      });
      return;
    }

    let rtspSourceHeader: string | undefined;
    if (camera.sourceType === 'RTSP') {
      const encrypted = state.cameraSecrets[camera.cameraId];
      if (!encrypted) {
        res.status(404).json({ error: 'Camera credentials not provisioned.' });
        return;
      }
      if (encrypted.startsWith('aes256gcm:')) {
        try {
          rtspSourceHeader = decryptCameraSecret(encrypted);
        } catch (err) {
          res.status(503).json({
            error: err instanceof Error ? err.message : 'Unable to decrypt camera stream credentials.',
          });
          return;
        }
      } else {
        res.status(422).json({
          error: 'Demo placeholder camera endpoint has no live RTSP stream credentials.',
        });
        return;
      }
    }

    try {
      const upstream = await fetch(`${visionUrl}/streams/${encodeURIComponent(camera.cameraId)}/mjpeg`, {
        headers: {
          'x-edge-api-key': edgeKey,
          'x-tenant-id': camera.tenantId,
          'x-outlet-id': camera.outletId,
          'x-zones-json': JSON.stringify(camera.zones || []),
          ...(rtspSourceHeader ? { 'x-rtsp-source': rtspSourceHeader } : {}),
        },
      });
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status || 502).json({ error: 'Upstream vision MJPEG stream unavailable.' });
        return;
      }
      markVerifiedYoloInference();
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store',
      });
      const reader = upstream.body.getReader();
      req.on('close', () => {
        void reader.cancel().catch(() => {});
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Failed to connect to Python vision-service MJPEG endpoint.' });
      }
    }
  });

  // Edge Connector Webhook for Python vision-service detection events (strict EDGE_API_KEY + camera integrity)
  router.post('/vision/events', (req, res) => {
    const keyCheck = verifyEdgeApiKey(req.headers['x-edge-api-key'] as string | undefined);
    if (!keyCheck.ok) {
      res.status(keyCheck.status).json({ error: keyCheck.error });
      return;
    }

    const body = req.body as Partial<DetectionEvent> & {
      dwellSeconds?: number;
      sessionStatus?: VisitSession['sessionStatus'];
    };
    if (!body.tenantId || !body.outletId || !body.cameraId || !body.temporaryTrackId?.trim()) {
      res.status(400).json({ error: 'Missing required detection event fields.' });
      return;
    }

    const confidence = Number(body.confidence ?? 0.85);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      res.status(400).json({ error: 'Invalid confidence score; must be between 0 and 1.' });
      return;
    }

    const validEventTypes: DetectionEvent['eventType'][] = [
      'entry',
      'exit',
      'zone_dwell',
      'billing_zone_enter',
    ];
    const eventType: DetectionEvent['eventType'] =
      body.eventType && validEventTypes.includes(body.eventType) ? body.eventType : 'zone_dwell';

    let validBbox: [number, number, number, number] | undefined;
    if (body.bbox !== undefined) {
      if (
        !Array.isArray(body.bbox) ||
        body.bbox.length !== 4 ||
        body.bbox.some((n) => typeof n !== 'number' || !Number.isFinite(n))
      ) {
        res.status(400).json({ error: 'Invalid bbox coordinates; expected [x1, y1, x2, y2].' });
        return;
      }
      validBbox = [body.bbox[0], body.bbox[1], body.bbox[2], body.bbox[3]];
    }

    const state = dbStore.getState();
    const camCheck = validateCameraTenantOutlet({
      cameras: state.cameras,
      outlets: state.outlets,
      cameraId: body.cameraId,
      tenantId: body.tenantId,
      outletId: body.outletId,
      allowUploadPlaceholder: true,
    });
    if (!camCheck.ok) {
      res.status(403).json({ error: camCheck.error });
      return;
    }

    const nowIso =
      body.timestamp && !Number.isNaN(Date.parse(body.timestamp))
        ? new Date(body.timestamp).toISOString()
        : new Date().toISOString();
    const sessionId =
      body.sessionId || `S-${body.cameraId}-${body.temporaryTrackId.trim()}`;

    let session = state.visitSessions.find((s) => s.sessionId === sessionId);
    if (!session) {
      session = {
        sessionId,
        tenantId: body.tenantId,
        outletId: body.outletId,
        cameraId: body.cameraId,
        temporaryTrackId: body.temporaryTrackId.trim(),
        firstSeen: nowIso,
        lastSeen: nowIso,
        dwellSeconds: body.dwellSeconds || 1,
        sessionStatus: body.sessionStatus || 'active',
        paymentStatus: 'pending',
        zoneName: body.zoneName || 'Entrance',
        isDemoData: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      state.visitSessions.unshift(session);
    } else {
      session.lastSeen = nowIso;
      session.dwellSeconds = body.dwellSeconds ?? session.dwellSeconds + 2;
      if (body.sessionStatus) session.sessionStatus = body.sessionStatus;
      if (body.zoneName) session.zoneName = body.zoneName;
      session.updatedAt = nowIso;
    }

    if (camCheck.camera) {
      camCheck.camera.connectionStatus = 'online';
      camCheck.camera.lastSeen = nowIso;
      camCheck.camera.lastHealthCheckMessage = `Edge YOLOv8n frame processed (${
        typeof body.latencyMs === 'number' ? `${body.latencyMs}ms` : 'active'
      })`;
      camCheck.camera.updatedAt = nowIso;
    }
    if (typeof body.latencyMs === 'number' && Number.isFinite(body.latencyMs)) {
      state.modelConfig.lastInferenceMs = Math.round(body.latencyMs);
      state.modelConfig.inferenceStatus = 'live_edge';
    }
    markVerifiedYoloInference(nowIso);

    const event: DetectionEvent = {
      eventId: `evt-${crypto.randomUUID().slice(0, 8)}`,
      tenantId: body.tenantId,
      outletId: body.outletId,
      cameraId: body.cameraId,
      sessionId,
      temporaryTrackId: body.temporaryTrackId.trim(),
      eventType,
      confidence,
      frameNumber: Number(body.frameNumber ?? 0),
      zoneName: body.zoneName || 'Floor',
      bbox: validBbox,
      latencyMs: typeof body.latencyMs === 'number' ? body.latencyMs : undefined,
      timestamp: nowIso,
      isDemoData: false,
    };
    state.detectionEvents.unshift(event);
    if (state.detectionEvents.length > 300) state.detectionEvents.length = 300;
    dbStore.save();

    realtimeHub.broadcastScoped(body.tenantId, body.outletId, 'detection:event', event);
    realtimeHub.broadcastScoped(body.tenantId, body.outletId, 'session:updated', session);
    res.status(201).json({ ok: true, event, session });
  });

  // All routes below require authenticated actor
  router.use(authenticateRequest);

  router.get('/workspace', async (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const visionServiceStatus = await probeVisionService();
    const scoped = dbStore.scopeSnapshotForActor(actor);
    res.json({
      ...scoped,
      visionServiceStatus,
      securityStatus: getSecurityEnvChecklist(),
    });
  });

  // ------------------------------------------------------------------
  // Tenant Management (DEVELOPER ONLY)
  // ------------------------------------------------------------------
  router.post('/tenants', requireRole('DEVELOPER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const { businessName, ownerEmail, ownerName, subscriptionPlan } = req.body as {
      businessName?: string;
      ownerEmail?: string;
      ownerName?: string;
      subscriptionPlan?: Tenant['subscriptionPlan'];
    };

    if (!businessName || businessName.trim().length < 2 || businessName.trim().length > 120) {
      res.status(400).json({ error: 'Business name must be 2 to 120 characters.' });
      return;
    }
    if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim())) {
      res.status(400).json({ error: 'Valid primary owner email is required.' });
      return;
    }

    const plan = subscriptionPlan && ['starter', 'growth', 'enterprise'].includes(subscriptionPlan)
      ? subscriptionPlan
      : 'growth';

    const state = dbStore.getState();
    const nowIso = new Date().toISOString();
    const tenantId = `ten-${crypto.randomUUID().slice(0, 8)}`;
    const ownerUserId = `usr-${crypto.randomUUID().slice(0, 8)}`;
    const inviteToken = crypto.randomBytes(16).toString('hex');

    const tenant: Tenant = {
      tenantId,
      businessName: businessName.trim(),
      ownerUserId,
      ownerEmail: ownerEmail.trim().toLowerCase(),
      subscriptionPlan: plan,
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
      isDemoData: actor.isDemoMode,
    };

    const ownerAccount: UserAccount = {
      userId: ownerUserId,
      role: 'CLIENT_OWNER',
      tenantId,
      assignedOutletIds: [],
      displayName: (ownerName || ownerEmail.split('@')[0]).trim(),
      email: ownerEmail.trim().toLowerCase(),
      accountStatus: 'invited',
      createdAt: nowIso,
      updatedAt: nowIso,
      isDemoData: actor.isDemoMode,
    };

    const invitation: Invitation = {
      invitationId: `inv-${crypto.randomUUID().slice(0, 8)}`,
      email: ownerEmail.trim().toLowerCase(),
      displayName: ownerAccount.displayName,
      role: 'CLIENT_OWNER',
      tenantId,
      assignedOutletIds: [],
      inviteToken,
      status: 'pending',
      invitedBy: actor.userId,
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    };

    state.tenants.unshift(tenant);
    state.users.unshift(ownerAccount);
    state.invitations.unshift(invitation);
    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId,
      action: 'TENANT_CREATED',
      resource: `tenants/${tenantId}`,
      details: `Created client ${tenant.businessName} with invitation for ${tenant.ownerEmail}`,
    });
    dbStore.save();
    res.status(201).json({ tenant, ownerAccount, invitation });
  });

  router.patch('/tenants/:tenantId', requireRole('DEVELOPER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const state = dbStore.getState();
    const tenant = state.tenants.find((t) => t.tenantId === req.params.tenantId);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found.' });
      return;
    }
    const { businessName, status, subscriptionPlan } = req.body as Partial<Tenant>;
    if (businessName && businessName.trim().length >= 2) tenant.businessName = businessName.trim();
    if (status && ['active', 'suspended', 'pending'].includes(status)) tenant.status = status;
    if (subscriptionPlan && ['starter', 'growth', 'enterprise'].includes(subscriptionPlan)) {
      tenant.subscriptionPlan = subscriptionPlan;
    }
    tenant.updatedAt = new Date().toISOString();
    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: tenant.tenantId,
      action: 'TENANT_UPDATED',
      resource: `tenants/${tenant.tenantId}`,
      details: `Updated status=${tenant.status}, plan=${tenant.subscriptionPlan}`,
    });
    dbStore.save();
    res.json({ tenant });
  });

  // ------------------------------------------------------------------
  // Outlet Management (DEVELOPER or CLIENT_OWNER for own tenant)
  // ------------------------------------------------------------------
  router.post('/outlets', requireRole('DEVELOPER', 'CLIENT_OWNER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const { tenantId, outletName, address, city, timezone, closingTime } = req.body as Partial<Outlet>;
    const targetTenantId = actor.role === 'CLIENT_OWNER' ? actor.tenantId : tenantId;

    if (!targetTenantId || !checkTenantAccess(actor, targetTenantId)) {
      res.status(403).json({ error: 'Cross-tenant outlet creation forbidden.' });
      return;
    }
    const state = dbStore.getState();
    if (!state.tenants.some((t) => t.tenantId === targetTenantId)) {
      res.status(404).json({ error: 'Target tenant not found.' });
      return;
    }
    if (!outletName || outletName.trim().length < 2 || !address || address.trim().length < 2) {
      res.status(400).json({ error: 'Outlet name and address are required.' });
      return;
    }

    const nowIso = new Date().toISOString();
    const outlet: Outlet = {
      outletId: `out-${crypto.randomUUID().slice(0, 8)}`,
      tenantId: targetTenantId,
      outletName: outletName.trim(),
      address: address.trim(),
      city: (city || 'Bengaluru').trim(),
      timezone: (timezone || 'Asia/Kolkata').trim(),
      closingTime: closingTime && /^\d{2}:\d{2}$/.test(closingTime) ? closingTime : '22:00',
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
      isDemoData: actor.isDemoMode,
    };

    state.outlets.unshift(outlet);
    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: targetTenantId,
      action: 'OUTLET_CREATED',
      resource: `outlets/${outlet.outletId}`,
      details: `Created outlet ${outlet.outletName} (${outlet.city}, ${outlet.timezone})`,
    });
    dbStore.save();
    res.status(201).json({ outlet });
  });

  router.patch('/outlets/:outletId', requireRole('DEVELOPER', 'CLIENT_OWNER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const state = dbStore.getState();
    const outlet = state.outlets.find((o) => o.outletId === req.params.outletId);
    if (!outlet) {
      res.status(404).json({ error: 'Outlet not found.' });
      return;
    }
    if (!checkTenantAccess(actor, outlet.tenantId)) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }
    const { outletName, address, city, timezone, closingTime, status } = req.body as Partial<Outlet>;
    if (outletName && outletName.trim().length >= 2) outlet.outletName = outletName.trim();
    if (address && address.trim().length >= 2) outlet.address = address.trim();
    if (city && city.trim().length >= 2) outlet.city = city.trim();
    if (timezone) outlet.timezone = timezone;
    if (closingTime && /^\d{2}:\d{2}$/.test(closingTime)) outlet.closingTime = closingTime;
    if (status && ['active', 'inactive'].includes(status)) outlet.status = status;
    outlet.updatedAt = new Date().toISOString();

    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: outlet.tenantId,
      action: 'OUTLET_UPDATED',
      resource: `outlets/${outlet.outletId}`,
      details: `Updated outlet ${outlet.outletName} (closingTime=${outlet.closingTime}, status=${outlet.status})`,
    });
    dbStore.save();
    res.json({ outlet });
  });

  // ------------------------------------------------------------------
  // User & Employee Invitation Management
  // ------------------------------------------------------------------
  router.post('/invitations', requireRole('DEVELOPER', 'CLIENT_OWNER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const { email, displayName, role, tenantId, assignedOutletIds } = req.body as {
      email?: string;
      displayName?: string;
      role?: UserAccount['role'];
      tenantId?: string;
      assignedOutletIds?: string[];
    };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      res.status(400).json({ error: 'Valid email is required.' });
      return;
    }
    const targetTenantId = actor.role === 'CLIENT_OWNER' ? actor.tenantId : tenantId || actor.tenantId;
    if (!checkTenantAccess(actor, targetTenantId)) {
      res.status(403).json({ error: 'Cannot invite users for another tenant.' });
      return;
    }
    const targetRole: UserAccount['role'] =
      actor.role === 'CLIENT_OWNER' ? 'WORKER' : role || 'WORKER';

    const state = dbStore.getState();
    const outletList = Array.isArray(assignedOutletIds) ? assignedOutletIds : [];
    for (const oid of outletList) {
      const o = state.outlets.find((x) => x.outletId === oid && x.tenantId === targetTenantId);
      if (!o) {
        res.status(400).json({ error: `Outlet ${oid} does not belong to tenant ${targetTenantId}.` });
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const invitation: Invitation = {
      invitationId: `inv-${crypto.randomUUID().slice(0, 8)}`,
      email: email.trim().toLowerCase(),
      displayName: (displayName || email.split('@')[0]).trim(),
      role: targetRole,
      tenantId: targetTenantId,
      assignedOutletIds: outletList,
      inviteToken: crypto.randomBytes(16).toString('hex'),
      status: 'pending',
      invitedBy: actor.userId,
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    };

    const user: UserAccount = {
      userId: `usr-${crypto.randomUUID().slice(0, 8)}`,
      role: targetRole,
      tenantId: targetTenantId,
      assignedOutletIds: outletList,
      displayName: invitation.displayName,
      email: invitation.email,
      accountStatus: actor.isDemoMode ? 'active' : 'invited',
      createdAt: nowIso,
      updatedAt: nowIso,
      isDemoData: actor.isDemoMode,
    };

    state.invitations.unshift(invitation);
    state.users.unshift(user);
    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: targetTenantId,
      action: 'USER_INVITED',
      resource: `users/${user.userId}`,
      details: `Invited ${user.email} as ${targetRole} for outlets [${outletList.join(', ')}]`,
    });
    dbStore.save();
    res.status(201).json({ invitation, user });
  });

  router.patch('/users/:userId/status', requireRole('DEVELOPER', 'CLIENT_OWNER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const state = dbStore.getState();
    const target = state.users.find((u) => u.userId === req.params.userId);
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    if (!checkTenantAccess(actor, target.tenantId)) {
      res.status(403).json({ error: 'Cross-tenant user modification forbidden.' });
      return;
    }
    if (actor.role === 'CLIENT_OWNER' && target.role !== 'WORKER') {
      res.status(403).json({ error: 'Owners can only modify worker accounts.' });
      return;
    }
    const { accountStatus, assignedOutletIds } = req.body as Partial<UserAccount>;
    if (accountStatus && ['active', 'disabled', 'invited'].includes(accountStatus)) {
      target.accountStatus = accountStatus;
    }
    if (Array.isArray(assignedOutletIds)) {
      target.assignedOutletIds = assignedOutletIds.slice(0, 20);
    }
    target.updatedAt = new Date().toISOString();
    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: target.tenantId,
      action: 'USER_STATUS_UPDATED',
      resource: `users/${target.userId}`,
      details: `Updated ${target.displayName} status=${target.accountStatus}`,
    });
    dbStore.save();
    res.json({ user: target });
  });

  // ------------------------------------------------------------------
  // Camera Management & Connection Testing (No RTSP passwords exposed!)
  // ------------------------------------------------------------------
  router.post('/cameras/:cameraId/stream-token', (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const state = dbStore.getState();
    const camera = state.cameras.find((c) => c.cameraId === req.params.cameraId);
    if (!camera) {
      res.status(404).json({ error: 'Camera not found.' });
      return;
    }
    const integrity = validateCameraTenantOutlet({
      cameras: state.cameras,
      outlets: state.outlets,
      cameraId: camera.cameraId,
      tenantId: camera.tenantId,
      outletId: camera.outletId,
    });
    if (!integrity.ok) {
      res.status(403).json({ error: integrity.error });
      return;
    }
    if (!checkOutletAccess(actor, camera.tenantId, camera.outletId)) {
      res.status(403).json({ error: 'Outlet access denied for this camera.' });
      return;
    }
    const ticket = createStreamTicket({
      kind: 'mjpeg',
      resourceId: camera.cameraId,
      userId: actor.userId,
      tenantId: camera.tenantId,
      outletId: camera.outletId,
    });
    res.json({
      streamUrl: `/api/cameras/${encodeURIComponent(camera.cameraId)}/stream/mjpeg?ticket=${encodeURIComponent(ticket)}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
  });

  router.post('/cameras', requireRole('DEVELOPER', 'CLIENT_OWNER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const { outletId, cameraName, sourceType, rtspUrl, resolution, fps } = req.body as {
      outletId?: string;
      cameraName?: string;
      sourceType?: Camera['sourceType'];
      rtspUrl?: string;
      resolution?: string;
      fps?: number;
    };

    const validation = validateCameraInput({ cameraName, outletId, sourceType, rtspUrl });
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const state = dbStore.getState();
    const outlet = state.outlets.find((o) => o.outletId === outletId);
    if (!outlet) {
      res.status(404).json({ error: 'Outlet not found.' });
      return;
    }
    if (!checkTenantAccess(actor, outlet.tenantId)) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }

    const nowIso = new Date().toISOString();
    const cameraId = `cam-${crypto.randomUUID().slice(0, 8)}`;
    const maskedEndpoint =
      sourceType === 'RTSP'
        ? maskRtspEndpoint(rtspUrl || '')
        : sourceType === 'HDMI'
          ? 'hdmi:///dev/video0 (Capture Device)'
          : 'upload://temporary-mp4-buffer';

    if (sourceType === 'RTSP' && rtspUrl) {
      try {
        state.cameraSecrets[cameraId] = encryptCameraSecret(rtspUrl.trim());
      } catch (err) {
        res.status(503).json({
          error:
            err instanceof Error
              ? err.message
              : 'CAMERA_SECRET_KEY is not configured; cannot save RTSP credentials.',
        });
        return;
      }
    }

    const camera: Camera = {
      cameraId,
      tenantId: outlet.tenantId,
      outletId: outlet.outletId,
      cameraName: cameraName!.trim(),
      sourceType: sourceType!,
      maskedEndpoint,
      hasCredentialsStored: sourceType === 'RTSP',
      resolution: resolution || (sourceType === 'HDMI' ? '1280x720' : '1920x1080'),
      fps: Number(fps ?? (sourceType === 'HDMI' ? 12 : 15)),
      connectionStatus: sourceType === 'UPLOAD' ? 'online' : 'offline',
      aiProcessingStatus: 'paused',
      lastSeen: nowIso,
      lastHealthCheckMessage:
        sourceType === 'RTSP'
          ? 'Added camera; run Test Connection to verify edge LAN reachability.'
          : sourceType === 'HDMI'
            ? 'HDMI capture device configured.'
            : 'Ready for temporary test video upload.',
      zones: [
        {
          id: `z-${crypto.randomUUID().slice(0, 6)}`,
          name: 'Entrance',
          type: 'entrance',
          points: [
            { x: 100, y: 150 },
            { x: 420, y: 150 },
            { x: 420, y: 820 },
            { x: 100, y: 820 },
          ],
        },
        {
          id: `z-${crypto.randomUUID().slice(0, 6)}`,
          name: 'Billing Counter',
          type: 'billing',
          points: [
            { x: 560, y: 200 },
            { x: 920, y: 200 },
            { x: 920, y: 840 },
            { x: 560, y: 840 },
          ],
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
      isDemoData: actor.isDemoMode,
    };

    state.cameras.unshift(camera);
    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: outlet.tenantId,
      action: 'CAMERA_ADDED',
      resource: `cameras/${cameraId}`,
      details: `Added ${camera.sourceType} camera "${camera.cameraName}" to ${outlet.outletName}`,
    });
    dbStore.save();
    res.status(201).json({ camera });
  });

  router.patch('/cameras/:cameraId', requireRole('DEVELOPER', 'CLIENT_OWNER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const state = dbStore.getState();
    const camera = state.cameras.find((c) => c.cameraId === req.params.cameraId);
    if (!camera) {
      res.status(404).json({ error: 'Camera not found.' });
      return;
    }
    const integrity = validateCameraTenantOutlet({
      cameras: state.cameras,
      outlets: state.outlets,
      cameraId: camera.cameraId,
      tenantId: camera.tenantId,
      outletId: camera.outletId,
    });
    if (!integrity.ok) {
      res.status(403).json({ error: integrity.error });
      return;
    }
    if (!checkTenantAccess(actor, camera.tenantId)) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }
    const { cameraName, aiProcessingStatus, zones, resolution, fps } = req.body as {
      cameraName?: string;
      aiProcessingStatus?: Camera['aiProcessingStatus'];
      zones?: CameraZone[];
      resolution?: string;
      fps?: number;
    };
    if (cameraName && cameraName.trim().length >= 2) camera.cameraName = cameraName.trim();
    if (aiProcessingStatus && ['running', 'paused', 'stopped'].includes(aiProcessingStatus)) {
      camera.aiProcessingStatus = aiProcessingStatus;
    }
    if (Array.isArray(zones) && zones.length <= 10) {
      camera.zones = zones;
    }
    if (resolution) camera.resolution = resolution;
    if (typeof fps === 'number' && fps >= 0 && fps <= 120) camera.fps = fps;
    camera.updatedAt = new Date().toISOString();

    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: camera.tenantId,
      action: 'CAMERA_UPDATED',
      resource: `cameras/${camera.cameraId}`,
      details: `Updated camera ${camera.cameraName} (ai=${camera.aiProcessingStatus}, zones=${camera.zones.length})`,
    });
    dbStore.save();
    realtimeHub.broadcastScoped(camera.tenantId, camera.outletId, 'camera:status', camera);
    res.json({ camera });
  });

  router.delete('/cameras/:cameraId', requireRole('DEVELOPER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const state = dbStore.getState();
    const idx = state.cameras.findIndex((c) => c.cameraId === req.params.cameraId);
    if (idx === -1) {
      res.status(404).json({ error: 'Camera not found.' });
      return;
    }
    const [removed] = state.cameras.splice(idx, 1);
    delete state.cameraSecrets[removed.cameraId];
    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: removed.tenantId,
      action: 'CAMERA_DELETED',
      resource: `cameras/${removed.cameraId}`,
      details: `Removed camera ${removed.cameraName}`,
    });
    dbStore.save();
    res.json({ ok: true });
  });

  router.post('/cameras/:cameraId/test', requireRole('DEVELOPER', 'CLIENT_OWNER'), async (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const state = dbStore.getState();
    const camera = state.cameras.find((c) => c.cameraId === req.params.cameraId);
    if (!camera) {
      res.status(404).json({ error: 'Camera not found.' });
      return;
    }
    const integrity = validateCameraTenantOutlet({
      cameras: state.cameras,
      outlets: state.outlets,
      cameraId: camera.cameraId,
      tenantId: camera.tenantId,
      outletId: camera.outletId,
    });
    if (!integrity.ok) {
      res.status(403).json({ error: integrity.error });
      return;
    }
    if (!checkTenantAccess(actor, camera.tenantId)) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }

    const nowIso = new Date().toISOString();
    let probeResult: { ok: boolean; latencyMs: number; reason?: string };

    if (camera.sourceType === 'RTSP') {
      const hostMatch = camera.maskedEndpoint.match(/@([^:/]+):(\d+)/) ||
        camera.maskedEndpoint.match(/rtsp:\/\/([^:/]+):(\d+)/);
      const host = hostMatch?.[1] || '127.0.0.1';
      const port = Number(hostMatch?.[2] || 554);

      if (host.startsWith('192.168.') || host.startsWith('10.')) {
        probeResult = {
          ok: false,
          latencyMs: 12,
          reason: `Private LAN ${host}:${port} requires the local Python Edge Connector to initiate outbound HTTPS/WebSocket telemetry.`,
        };
        if (isDemoAuthAllowed() && camera.isDemoData && req.body?.simulateEdgeRecovery === true) {
          probeResult = { ok: true, latencyMs: 18 };
        }
      } else {
        probeResult = await probeTcpSocket(host, port);
      }
    } else {
      probeResult = { ok: true, latencyMs: 5 };
    }

    camera.connectionStatus = probeResult.ok ? 'online' : 'offline';
    camera.lastSeen = probeResult.ok ? nowIso : camera.lastSeen;
    camera.lastHealthCheckMessage = probeResult.ok
      ? `Stream reachable (${probeResult.latencyMs}ms)`
      : probeResult.reason || 'Connection failed';
    camera.updatedAt = nowIso;

    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: camera.tenantId,
      action: 'CAMERA_CONNECTION_TEST',
      resource: `cameras/${camera.cameraId}`,
      details: `${camera.cameraName}: ${camera.connectionStatus} — ${camera.lastHealthCheckMessage}`,
    });
    dbStore.save();
    realtimeHub.broadcastScoped(camera.tenantId, camera.outletId, 'camera:status', camera);
    res.json({ camera, probeResult });
  });

  // ------------------------------------------------------------------
  // Payment Management (Manual Confirmation + Immutable Audit)
  // ------------------------------------------------------------------
  router.post('/transactions', (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const { outletId, sessionId, amount, paymentMethod, transactionRef, notes } = req.body as {
      outletId?: string;
      sessionId?: string;
      amount?: number;
      paymentMethod?: Transaction['paymentMethod'];
      transactionRef?: string;
      notes?: string;
    };

    const validation = validateTransactionInput({
      outletId,
      amount,
      paymentMethod,
      transactionRef,
      notes,
    });
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const state = dbStore.getState();
    const outlet = state.outlets.find((o) => o.outletId === outletId);
    if (!outlet) {
      res.status(404).json({ error: 'Outlet not found.' });
      return;
    }
    if (!checkOutletAccess(actor, outlet.tenantId, outlet.outletId)) {
      res.status(403).json({ error: 'You are not assigned to this outlet.' });
      return;
    }

    // Duplicate transaction guard
    const nowMs = Date.now();
    const cleanRef = transactionRef?.trim();
    if (cleanRef) {
      const dupRef = state.transactions.find(
        (t) =>
          t.outletId === outlet.outletId &&
          t.paymentStatus === 'confirmed' &&
          t.transactionRef?.toLowerCase() === cleanRef.toLowerCase() &&
          nowMs - new Date(t.createdAt).getTime() < 300_000
      );
      if (dupRef) {
        res.status(409).json({
          error: `Duplicate transaction reference ${cleanRef} already confirmed at this outlet.`,
        });
        return;
      }
    }
    if (sessionId) {
      const dupSession = state.transactions.find(
        (t) =>
          t.outletId === outlet.outletId &&
          t.sessionId === sessionId &&
          t.amount === Number(amount) &&
          t.paymentStatus === 'confirmed' &&
          nowMs - new Date(t.createdAt).getTime() < 60_000
      );
      if (dupSession) {
        res.status(409).json({
          error: `Duplicate ₹${amount} confirmation detected for session ${sessionId} within 60 seconds.`,
        });
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const transaction: Transaction = {
      transactionId: `TXN-${Math.floor(1000 + Math.random() * 9000)}-${crypto
        .randomUUID()
        .slice(0, 4)
        .toUpperCase()}`,
      tenantId: outlet.tenantId,
      outletId: outlet.outletId,
      sessionId: sessionId || undefined,
      amount: Math.round(Number(amount) * 100) / 100,
      paymentMethod: paymentMethod!,
      paymentStatus: 'confirmed',
      transactionRef: cleanRef || undefined,
      confirmedBy: actor.userId,
      confirmedByName: actor.displayName,
      notes: notes?.trim() || undefined,
      isDemoData: actor.isDemoMode,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    state.transactions.unshift(transaction);

    // Update optional linked visitor session if provided
    let updatedSession: VisitSession | undefined;
    if (sessionId) {
      updatedSession = state.visitSessions.find(
        (s) => s.sessionId === sessionId && s.outletId === outlet.outletId
      );
      if (updatedSession) {
        updatedSession.paymentStatus = 'confirmed';
        updatedSession.updatedAt = nowIso;
        realtimeHub.broadcastScoped(
          outlet.tenantId,
          outlet.outletId,
          'session:updated',
          updatedSession
        );
      }
    }

    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: outlet.tenantId,
      action: 'PAYMENT_CONFIRMED',
      resource: `transactions/${transaction.transactionId}`,
      details: `Confirmed ₹${transaction.amount} via ${transaction.paymentMethod} at ${outlet.outletName}${
        sessionId ? ` (session ${sessionId})` : ''
      }`,
    });
    dbStore.save();
    realtimeHub.broadcastScoped(outlet.tenantId, outlet.outletId, 'transaction:confirmed', transaction);
    res.status(201).json({ transaction, updatedSession });
  });

  router.patch(
    '/transactions/:transactionId/status',
    requireRole('DEVELOPER', 'CLIENT_OWNER'),
    (req: AuthenticatedRequest, res) => {
      const actor = req.actor!;
      const state = dbStore.getState();
      const tx = state.transactions.find((t) => t.transactionId === req.params.transactionId);
      if (!tx) {
        res.status(404).json({ error: 'Transaction not found.' });
        return;
      }
      if (!checkTenantAccess(actor, tx.tenantId)) {
        res.status(403).json({ error: 'Cross-tenant access forbidden.' });
        return;
      }
      const { paymentStatus, reason } = req.body as {
        paymentStatus?: 'cancelled' | 'refunded';
        reason?: string;
      };
      if (!paymentStatus || !['cancelled', 'refunded'].includes(paymentStatus)) {
        res.status(400).json({ error: 'Status must be cancelled or refunded.' });
        return;
      }
      if (!reason || reason.trim().length < 3) {
        res.status(400).json({ error: 'Audit reason (min 3 chars) is required for corrections.' });
        return;
      }
      if (tx.paymentStatus !== 'confirmed' && actor.role !== 'DEVELOPER') {
        res.status(409).json({ error: 'Transaction is already in terminal state.' });
        return;
      }

      tx.paymentStatus = paymentStatus;
      tx.notes = `${tx.notes ? `${tx.notes} | ` : ''}${paymentStatus.toUpperCase()}: ${reason.trim()}`;
      tx.updatedAt = new Date().toISOString();

      dbStore.appendAudit({
        userId: actor.userId,
        userEmail: actor.email,
        tenantId: tx.tenantId,
        action: `PAYMENT_${paymentStatus.toUpperCase()}`,
        resource: `transactions/${tx.transactionId}`,
        details: `${paymentStatus} ₹${tx.amount}: ${reason.trim()}`,
      });
      dbStore.save();
      realtimeHub.broadcastScoped(tx.tenantId, tx.outletId, 'transaction:updated', tx);
      res.json({ transaction: tx });
    }
  );

  // ------------------------------------------------------------------
  // Automated & On-Demand Reports (Timezone Aware)
  // ------------------------------------------------------------------
  router.post(
    '/reports/generate',
    requireRole('DEVELOPER', 'CLIENT_OWNER'),
    (req: AuthenticatedRequest, res) => {
      const actor = req.actor!;
      const { outletId, reportType, reportDate } = req.body as {
        outletId?: string;
        reportType?: ReportType;
        reportDate?: string;
      };
      const state = dbStore.getState();
      const targetOutlets = outletId
        ? state.outlets.filter((o) => o.outletId === outletId)
        : actor.role === 'DEVELOPER'
          ? state.outlets
          : state.outlets.filter((o) => o.tenantId === actor.tenantId);

      if (targetOutlets.length === 0) {
        res.status(404).json({ error: 'No matching outlets found.' });
        return;
      }
      for (const o of targetOutlets) {
        if (!checkTenantAccess(actor, o.tenantId)) {
          res.status(403).json({ error: 'Forbidden.' });
          return;
        }
      }

      const period: ReportType =
        reportType && ['daily', 'weekly', 'monthly'].includes(reportType) ? reportType : 'daily';

      const generated = targetOutlets.map((outlet) => {
        const localDate =
          reportDate || formatLocalDateKey(new Date().toISOString(), outlet.timezone);
        return generatePeriodReport({
          reportId: `REP-${period.toUpperCase().slice(0, 1)}-${crypto
            .randomUUID()
            .slice(0, 6)
            .toUpperCase()}`,
          tenantId: outlet.tenantId,
          outlet,
          reportType: period,
          reportDate: localDate,
          sessions: state.visitSessions,
          transactions: state.transactions,
          cameras: state.cameras,
        });
      });

      state.reports.unshift(...generated);
      dbStore.appendAudit({
        userId: actor.userId,
        userEmail: actor.email,
        tenantId: actor.tenantId,
        action: 'REPORTS_GENERATED',
        resource: `reports/${period}`,
        details: `Generated ${generated.length} ${period} report(s) in outlet local timezones.`,
      });
      dbStore.save();
      res.status(201).json({ reports: generated });
    }
  );

  // ------------------------------------------------------------------
  // Video Upload & Model Configuration
  // ------------------------------------------------------------------
  router.post(
    '/vision/upload',
    upload.single('video'),
    async (req: AuthenticatedRequest, res) => {
      const actor = req.actor!;
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Video file (MP4, AVI, MOV, WEBM) is required.' });
        return;
      }
      const outletId = String(req.body?.outletId || actor.assignedOutletIds[0] || '');
      const requestedCameraId =
        typeof req.body?.cameraId === 'string' && req.body.cameraId.trim()
          ? req.body.cameraId.trim()
          : 'upload-test';

      const state = dbStore.getState();
      const outlet = state.outlets.find((o) => o.outletId === outletId);
      if (!outlet) {
        fs.unlinkSync(file.path);
        res.status(404).json({ error: 'Target outlet not found.' });
        return;
      }
      if (!checkOutletAccess(actor, outlet.tenantId, outlet.outletId)) {
        fs.unlinkSync(file.path);
        res.status(403).json({ error: 'Outlet access denied.' });
        return;
      }

      const camCheck = validateCameraTenantOutlet({
        cameras: state.cameras,
        outlets: state.outlets,
        cameraId: requestedCameraId,
        tenantId: outlet.tenantId,
        outletId: outlet.outletId,
        allowUploadPlaceholder: true,
      });
      if (!camCheck.ok) {
        fs.unlinkSync(file.path);
        res.status(403).json({ error: camCheck.error });
        return;
      }

      const uploadId = `vid-${crypto.randomUUID().slice(0, 10)}`;
      const ttlMs = Number(process.env.UPLOAD_RETENTION_MS || 30 * 60_000);
      const expiresAt = Date.now() + ttlMs;
      const uploadRecord: {
        filePath: string;
        annotatedFilePath?: string;
        mimeType: string;
        filename: string;
        expiresAt: number;
        tenantId: string;
        outletId: string;
      } = {
        filePath: file.path,
        mimeType: file.mimetype || 'video/mp4',
        filename: file.originalname,
        expiresAt,
        tenantId: outlet.tenantId,
        outletId: outlet.outletId,
      };
      uploadedVideos.set(uploadId, uploadRecord);

      // Auto-purge temporary upload & annotated MP4 files after retention period
      setTimeout(() => {
        const entry = uploadedVideos.get(uploadId);
        if (entry?.filePath && fs.existsSync(entry.filePath)) {
          fs.unlink(entry.filePath, () => {});
        }
        if (entry?.annotatedFilePath && fs.existsSync(entry.annotatedFilePath)) {
          fs.unlink(entry.annotatedFilePath, () => {});
        }
        uploadedVideos.delete(uploadId);
      }, ttlMs).unref();

      const rawTicket = createStreamTicket(
        {
          kind: 'upload',
          resourceId: uploadId,
          userId: actor.userId,
          tenantId: outlet.tenantId,
          outletId: outlet.outletId,
        },
        ttlMs
      );
      const streamUrl = `/api/vision/stream/${uploadId}?ticket=${encodeURIComponent(rawTicket)}`;

      const visionUrl = getVisionServiceUrl();
      const edgeKey = getEdgeApiKey();

      if (!visionUrl) {
        dbStore.appendAudit({
          userId: actor.userId,
          userEmail: actor.email,
          tenantId: outlet.tenantId,
          action: 'TEST_VIDEO_UPLOADED',
          resource: `vision/uploads/${uploadId}`,
          details: `Uploaded temporary test file ${file.originalname} (Demo Overlay — VISION_SERVICE_URL not configured)`,
        });
        res.status(201).json({
          uploadId,
          tenantId: outlet.tenantId,
          outletId: outlet.outletId,
          cameraId: requestedCameraId,
          filename: file.originalname,
          mimeType: file.mimetype || 'video/mp4',
          sizeBytes: file.size,
          streamUrl,
          uploadedAt: new Date().toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          visionServiceConfigured: false,
          visionServiceConnected: false,
          inferenceState: 'demo_overlay',
          inferenceMode: 'browser_demo_overlay',
        });
        return;
      }

      if (!edgeKey) {
        res.status(201).json({
          uploadId,
          tenantId: outlet.tenantId,
          outletId: outlet.outletId,
          cameraId: requestedCameraId,
          filename: file.originalname,
          mimeType: file.mimetype || 'video/mp4',
          sizeBytes: file.size,
          streamUrl,
          uploadedAt: new Date().toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          visionServiceConfigured: true,
          visionServiceConnected: false,
          inferenceState: 'error',
          inferenceMode: 'error',
          errorMessage: 'EDGE_API_KEY is not configured on backend; cannot authenticate request to Python vision-service.',
        });
        return;
      }

      try {
        const buffer = await fs.promises.readFile(file.path);
        const form = new FormData();
        form.append(
          'file',
          new Blob([buffer], { type: file.mimetype || 'video/mp4' }),
          file.originalname
        );
        form.append('tenant_id', outlet.tenantId);
        form.append('outlet_id', outlet.outletId);
        form.append('camera_id', requestedCameraId);
        form.append('confidence_threshold', String(state.modelConfig.confidenceThreshold));
        if (camCheck.camera?.zones) {
          form.append('zones_json', JSON.stringify(camCheck.camera.zones));
        }

        const pyResp = await fetch(`${visionUrl}/upload-video`, {
          method: 'POST',
          headers: { 'x-edge-api-key': edgeKey },
          body: form,
        });

        if (!pyResp.ok) {
          const errBody = await pyResp.text().catch(() => '');
          res.status(201).json({
            uploadId,
            tenantId: outlet.tenantId,
            outletId: outlet.outletId,
            cameraId: requestedCameraId,
            filename: file.originalname,
            mimeType: file.mimetype || 'video/mp4',
            sizeBytes: file.size,
            streamUrl,
            uploadedAt: new Date().toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            visionServiceConfigured: true,
            visionServiceConnected: false,
            inferenceState: 'error',
            inferenceMode: 'error',
            errorMessage: `Python vision-service inference failed (HTTP ${pyResp.status}): ${errBody || pyResp.statusText}`,
          });
          return;
        }

        const pyData = (await pyResp.json()) as {
          upload_job_id: string;
          annotated_download_path?: string;
          model?: string;
          confidence_threshold?: number;
          device?: string;
          frames_total?: number;
          frames_processed?: number;
          unique_temporary_tracks?: string[];
          visitor_count?: number;
          total_detections?: number;
          avg_fps?: number;
          inference_ms?: number;
          events_dispatched?: number;
          detections_sample?: Array<{
            temporaryTrackId: string;
            bbox: [number, number, number, number];
            confidence: number;
            frameNumber: number;
            timestamp: string;
            cameraId: string;
            outletId: string;
            tenantId: string;
            zoneName?: string;
            latencyMs?: number;
          }>;
        };

        let annotatedStreamUrl: string | undefined;
        if (pyData.annotated_download_path) {
          const annotatedResp = await fetch(`${visionUrl}${pyData.annotated_download_path}`, {
            headers: { 'x-edge-api-key': edgeKey },
          });
          if (annotatedResp.ok) {
            const annotatedBuf = Buffer.from(await annotatedResp.arrayBuffer());
            const annotatedPath = path.join(UPLOAD_DIR, `${uploadId}-annotated.mp4`);
            await fs.promises.writeFile(annotatedPath, annotatedBuf);
            uploadRecord.annotatedFilePath = annotatedPath;

            const annotatedTicket = createStreamTicket(
              {
                kind: 'upload-annotated',
                resourceId: uploadId,
                userId: actor.userId,
                tenantId: outlet.tenantId,
                outletId: outlet.outletId,
              },
              ttlMs
            );
            annotatedStreamUrl = `/api/vision/annotated/${uploadId}?ticket=${encodeURIComponent(annotatedTicket)}`;

            // Clean up duplicate temporary artifact on Python side once buffered locally
            void fetch(`${visionUrl}${pyData.annotated_download_path}`, {
              method: 'DELETE',
              headers: { 'x-edge-api-key': edgeKey },
            }).catch(() => {});
          }
        }

        const nowIso = new Date().toISOString();
        const uniqueTracks = pyData.unique_temporary_tracks || [];
        state.modelConfig.lastInferenceMs = Math.round(pyData.inference_ms || 0);
        state.modelConfig.measuredFps = pyData.avg_fps || 0;
        state.modelConfig.activeTrackCount = uniqueTracks.length;
        state.modelConfig.inferenceStatus = 'live_edge';
        state.modelConfig.deviceType = pyData.device === 'CUDA_GPU' ? 'CUDA_GPU' : 'CPU';
        markVerifiedYoloInference(nowIso);

        dbStore.appendAudit({
          userId: actor.userId,
          userEmail: actor.email,
          tenantId: outlet.tenantId,
          action: 'YOLO_VIDEO_INFERENCE_COMPLETED',
          resource: `vision/uploads/${uploadId}`,
          details: `Processed ${file.originalname} via ${pyData.model || state.modelConfig.modelName}: ${uniqueTracks.length} unique tracks, ${pyData.total_detections || 0} detections`,
        });
        dbStore.save();

        res.status(201).json({
          uploadId,
          tenantId: outlet.tenantId,
          outletId: outlet.outletId,
          cameraId: requestedCameraId,
          filename: file.originalname,
          mimeType: file.mimetype || 'video/mp4',
          sizeBytes: file.size,
          streamUrl,
          annotatedStreamUrl,
          uploadedAt: nowIso,
          expiresAt: new Date(expiresAt).toISOString(),
          visionServiceConfigured: true,
          visionServiceConnected: true,
          inferenceState: 'live_yolo',
          inferenceMode: 'live_yolo',
          metrics: {
            model: pyData.model || state.modelConfig.modelName,
            confidenceThreshold: pyData.confidence_threshold ?? state.modelConfig.confidenceThreshold,
            device: pyData.device || 'CPU',
            framesTotal: pyData.frames_total || 0,
            framesProcessed: pyData.frames_processed || 0,
            uniqueTrackIds: uniqueTracks,
            totalDetections: pyData.total_detections || 0,
            visitorCount: pyData.visitor_count ?? uniqueTracks.length,
            avgFps: pyData.avg_fps || 0,
            inferenceMs: pyData.inference_ms || 0,
            eventsDispatched: pyData.events_dispatched || 0,
            detectionsSample: pyData.detections_sample || [],
          },
        });
      } catch (err) {
        res.status(201).json({
          uploadId,
          tenantId: outlet.tenantId,
          outletId: outlet.outletId,
          cameraId: requestedCameraId,
          filename: file.originalname,
          mimeType: file.mimetype || 'video/mp4',
          sizeBytes: file.size,
          streamUrl,
          uploadedAt: new Date().toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          visionServiceConfigured: true,
          visionServiceConnected: false,
          inferenceState: 'error',
          inferenceMode: 'error',
          errorMessage:
            err instanceof Error
              ? `Could not reach Python vision-service for inference: ${err.message}`
              : 'Could not reach Python vision-service for inference.',
        });
      }
    }
  );

  router.patch('/model/config', requireRole('DEVELOPER'), async (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    const state = dbStore.getState();
    const { confidenceThreshold, modelName } = req.body as {
      confidenceThreshold?: number;
      modelName?: string;
    };
    if (typeof confidenceThreshold === 'number' && confidenceThreshold >= 0.1 && confidenceThreshold <= 0.95) {
      state.modelConfig.confidenceThreshold = Math.round(confidenceThreshold * 100) / 100;
    }
    if (modelName && ['yolov8n.pt', 'yolov8s.pt'].includes(modelName)) {
      state.modelConfig.modelName = modelName;
    }

    const visionUrl = getVisionServiceUrl();
    const edgeKey = getEdgeApiKey();
    if (visionUrl && edgeKey) {
      void fetch(`${visionUrl}/model`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-edge-api-key': edgeKey,
        },
        body: JSON.stringify({
          confidence_threshold: state.modelConfig.confidenceThreshold,
          model_name: state.modelConfig.modelName,
        }),
      }).catch(() => {});
    }

    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: 'platform',
      action: 'MODEL_CONFIG_UPDATED',
      resource: 'model/yolov8',
      details: `Updated model=${state.modelConfig.modelName}, conf=${state.modelConfig.confidenceThreshold}`,
    });
    dbStore.save();
    res.json({ modelConfig: state.modelConfig });
  });

  router.post('/demo/reset', requireRole('DEVELOPER'), (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    dbStore.resetDemoState();
    dbStore.appendAudit({
      userId: actor.userId,
      userEmail: actor.email,
      tenantId: 'platform',
      action: 'DEMO_DATA_RESET',
      resource: 'store/seed',
      details: 'Reset workspace to initial deterministic demo seed data.',
    });
    res.json({ ok: true });
  });

  return router;
}
