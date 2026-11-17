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
  type AuthenticatedRequest,
  rateLimitMiddleware,
  requireRole,
} from '../middleware/auth';
import { dbStore, encryptCameraSecret } from '../store/database';
import { realtimeHub } from '../ws';

const UPLOAD_DIR = '/tmp/retail-brain-uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Temporary video upload tracking (strictly auto-expiring, never permanent archive)
const uploadedVideos = new Map<
  string,
  { filePath: string; mimeType: string; filename: string; expiresAt: number; tenantId: string }
>();

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

const VISION_SERVICE_URL = process.env.VISION_SERVICE_URL || 'http://127.0.0.1:8001';

async function probeVisionService(): Promise<{
  connected: boolean;
  endpoint: string;
  message: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900);
  try {
    const resp = await fetch(`${VISION_SERVICE_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (resp.ok) {
      return {
        connected: true,
        endpoint: VISION_SERVICE_URL,
        message: 'Python YOLOv8n + ByteTrack edge service online',
      };
    }
    return {
      connected: false,
      endpoint: VISION_SERVICE_URL,
      message: `Edge service returned HTTP ${resp.status}`,
    };
  } catch {
    clearTimeout(timer);
    return {
      connected: false,
      endpoint: VISION_SERVICE_URL,
      message: 'Python vision-service not running locally; video playback uses explicit Demo Overlay mode.',
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

export function createApiRouter(): express.Router {
  const router = express.Router();
  router.use(rateLimitMiddleware);

  router.get('/health', async (_req, res) => {
    const vision = await probeVisionService();
    res.json({
      status: 'ok',
      service: 'retail-brain-os-backend',
      wsClients: realtimeHub.getClientCount(),
      visionService: vision,
      timestamp: new Date().toISOString(),
    });
  });

  // Stream uploaded temporary test video with HTTP Range support (before auth header requirement so <video src> works cleanly)
  router.get('/vision/stream/:uploadId', (req, res: Response) => {
    const item = uploadedVideos.get(req.params.uploadId);
    if (!item || !fs.existsSync(item.filePath)) {
      res.status(404).json({ error: 'Temporary video expired or not found.' });
      return;
    }
    const stat = fs.statSync(item.filePath);
    const total = stat.size;
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
        'Content-Type': item.mimeType || 'video/mp4',
      });
      fs.createReadStream(item.filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': item.mimeType || 'video/mp4',
    });
    fs.createReadStream(item.filePath).pipe(res);
  });

  // Edge Connector Webhook for Python vision-service detection events
  router.post('/vision/events', (req, res) => {
    const edgeKey = req.headers['x-edge-api-key'] as string | undefined;
    const expectedKey = process.env.EDGE_API_KEY || 'dev-edge-key';
    if (edgeKey && edgeKey !== expectedKey) {
      res.status(403).json({ error: 'Invalid edge connector key.' });
      return;
    }
    const body = req.body as Partial<DetectionEvent> & {
      dwellSeconds?: number;
      sessionStatus?: VisitSession['sessionStatus'];
    };
    if (!body.tenantId || !body.outletId || !body.cameraId || !body.temporaryTrackId) {
      res.status(400).json({ error: 'Missing required detection event fields.' });
      return;
    }
    const state = dbStore.getState();
    const nowIso = new Date().toISOString();
    const sessionId = body.sessionId || `S-${body.temporaryTrackId}`;

    let session = state.visitSessions.find((s) => s.sessionId === sessionId);
    if (!session) {
      session = {
        sessionId,
        tenantId: body.tenantId,
        outletId: body.outletId,
        cameraId: body.cameraId,
        temporaryTrackId: body.temporaryTrackId,
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

    const event: DetectionEvent = {
      eventId: `evt-${crypto.randomUUID().slice(0, 8)}`,
      tenantId: body.tenantId,
      outletId: body.outletId,
      cameraId: body.cameraId,
      sessionId,
      temporaryTrackId: body.temporaryTrackId,
      eventType: body.eventType || 'zone_dwell',
      confidence: Number(body.confidence ?? 0.85),
      frameNumber: Number(body.frameNumber ?? 0),
      zoneName: body.zoneName || 'Floor',
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
      state.cameraSecrets[cameraId] = encryptCameraSecret(rtspUrl.trim());
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
        // Private LAN address unreachable directly from cloud container; report honest edge requirement or toggle demo health
        probeResult = {
          ok: false,
          latencyMs: 12,
          reason: `Private LAN ${host}:${port} requires the local Python Edge Connector to initiate outbound WebSocket telemetry.`,
        };
        if (camera.isDemoData && req.body?.simulateEdgeRecovery === true) {
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
      const state = dbStore.getState();
      const outlet = state.outlets.find((o) => o.outletId === outletId);
      if (outlet && !checkOutletAccess(actor, outlet.tenantId, outlet.outletId)) {
        fs.unlinkSync(file.path);
        res.status(403).json({ error: 'Outlet access denied.' });
        return;
      }

      const uploadId = `vid-${crypto.randomUUID().slice(0, 10)}`;
      const ttlMs = 30 * 60_000;
      const expiresAt = Date.now() + ttlMs;
      uploadedVideos.set(uploadId, {
        filePath: file.path,
        mimeType: file.mimetype || 'video/mp4',
        filename: file.originalname,
        expiresAt,
        tenantId: outlet?.tenantId || actor.tenantId,
      });

      // Auto-purge temporary upload file after 30 minutes
      setTimeout(() => {
        const entry = uploadedVideos.get(uploadId);
        if (entry && fs.existsSync(entry.filePath)) {
          fs.unlink(entry.filePath, () => {});
        }
        uploadedVideos.delete(uploadId);
      }, ttlMs).unref();

      const visionStatus = await probeVisionService();
      dbStore.appendAudit({
        userId: actor.userId,
        userEmail: actor.email,
        tenantId: outlet?.tenantId || actor.tenantId,
        action: 'TEST_VIDEO_UPLOADED',
        resource: `vision/uploads/${uploadId}`,
        details: `Uploaded temporary test file ${file.originalname} (${Math.round(file.size / 1024)} KB)`,
      });

      res.status(201).json({
        uploadId,
        tenantId: outlet?.tenantId || actor.tenantId,
        outletId: outlet?.outletId || outletId,
        filename: file.originalname,
        mimeType: file.mimetype || 'video/mp4',
        sizeBytes: file.size,
        streamUrl: `/api/vision/stream/${uploadId}`,
        uploadedAt: new Date().toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        visionServiceConnected: visionStatus.connected,
        inferenceMode: visionStatus.connected ? 'python_yolov8_edge' : 'browser_demo_overlay',
      });
    }
  );

  router.patch('/model/config', requireRole('DEVELOPER'), (req: AuthenticatedRequest, res) => {
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
