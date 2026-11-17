import assert from 'node:assert/strict';
import test from 'node:test';
import type { Camera, Outlet } from '../../shared/types/domain';
import {
  createStreamTicket,
  decryptCameraCredential,
  encryptCameraCredential,
  getSecurityEnvChecklist,
  getVisionServiceUrl,
  isDemoAuthAllowed,
  rotateCameraSecrets,
  validateCameraTenantOutlet,
  verifyEdgeApiKey,
  verifyStreamTicket,
} from './config';

test('verifyEdgeApiKey rejects unconfigured server key with 503', () => {
  const result = verifyEdgeApiKey('some-key', {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test('verifyEdgeApiKey rejects missing or empty header with 401', () => {
  const env = { EDGE_API_KEY: 'super-secret-edge-key' };
  const missing = verifyEdgeApiKey(undefined, env);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 401);

  const blank = verifyEdgeApiKey('   ', env);
  assert.equal(blank.ok, false);
  assert.equal(blank.status, 401);
});

test('verifyEdgeApiKey rejects mismatched header with 403 and accepts exact match', () => {
  const env = { EDGE_API_KEY: 'super-secret-edge-key' };
  const wrong = verifyEdgeApiKey('wrong-key', env);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 403);

  const valid = verifyEdgeApiKey('super-secret-edge-key', env);
  assert.equal(valid.ok, true);
  assert.equal(valid.status, 200);
});

test('camera credential encryption fails safely when CAMERA_SECRET_KEY is missing', () => {
  assert.throws(
    () => encryptCameraCredential('rtsp://admin:pass@192.168.1.10:554/stream', {}),
    /CAMERA_SECRET_KEY/
  );
  assert.throws(
    () => decryptCameraCredential('aes256gcm:00:00:00', {}),
    /CAMERA_SECRET_KEY/
  );
});

test('camera credential AES-256-GCM round-trip and safe key rotation preserve existing compatibility', () => {
  const oldEnv = { CAMERA_SECRET_KEY: 'initial-prod-key-32-bytes-minimum!' };
  const newEnv = { CAMERA_SECRET_KEY: 'rotated-prod-key-32-bytes-minimum!' };
  const rtspUrl = 'rtsp://operator:secret123@192.168.1.50:554/Streaming/Channels/101';

  const encrypted = encryptCameraCredential(rtspUrl, oldEnv);
  assert.equal(encrypted.startsWith('aes256gcm:'), true);
  assert.equal(encrypted.includes('secret123'), false);

  const decrypted = decryptCameraCredential(encrypted, oldEnv);
  assert.equal(decrypted, rtspUrl);

  assert.throws(() => decryptCameraCredential(encrypted, newEnv), /key migration/i);

  const migration = rotateCameraSecrets({
    oldKey: oldEnv.CAMERA_SECRET_KEY,
    newKey: newEnv.CAMERA_SECRET_KEY,
    cameraSecrets: {
      'cam-real-01': encrypted,
      'cam-demo-01': 'enc:v1:seeded_demo_placeholder',
    },
  });

  assert.equal(migration.migratedCount, 1);
  assert.equal(migration.skippedLegacyCount, 1);
  assert.equal(
    decryptCameraCredential(migration.rotated['cam-real-01'], newEnv),
    rtspUrl
  );
  assert.equal(migration.rotated['cam-demo-01'], 'enc:v1:seeded_demo_placeholder');

  assert.throws(
    () =>
      rotateCameraSecrets({
        oldKey: 'wrong-old-key',
        newKey: newEnv.CAMERA_SECRET_KEY,
        cameraSecrets: { 'cam-real-01': encrypted },
      }),
    /key migration/i
  );
});

test('getVisionServiceUrl returns null unless valid HTTP/HTTPS URL is configured', () => {
  assert.equal(getVisionServiceUrl({}), null);
  assert.equal(getVisionServiceUrl({ VISION_SERVICE_URL: '   ' }), null);
  assert.equal(getVisionServiceUrl({ VISION_SERVICE_URL: 'ftp://invalid:8001' }), null);
  assert.equal(
    getVisionServiceUrl({ VISION_SERVICE_URL: 'https://vision.example.com///' }),
    'https://vision.example.com'
  );
});

test('isDemoAuthAllowed disables demo authentication in production', () => {
  assert.equal(isDemoAuthAllowed({ NODE_ENV: 'development' }), true);
  assert.equal(isDemoAuthAllowed({}), true);
  assert.equal(isDemoAuthAllowed({ NODE_ENV: 'production' }), false);
});

test('stream tickets enforce resource binding, kind binding, expiration, and signature integrity', () => {
  const env = { CAMERA_SECRET_KEY: 'ticket-signing-secret' };
  const ticket = createStreamTicket(
    {
      kind: 'mjpeg',
      resourceId: 'cam-01',
      userId: 'user-owner',
      tenantId: 'tenant-1',
      outletId: 'outlet-1',
    },
    60_000,
    env
  );

  const verified = verifyStreamTicket(ticket, 'mjpeg', 'cam-01', env);
  assert.ok(verified);
  assert.equal(verified.tenantId, 'tenant-1');
  assert.equal(verified.outletId, 'outlet-1');

  assert.equal(verifyStreamTicket(ticket, 'upload', 'cam-01', env), null);
  assert.equal(verifyStreamTicket(ticket, 'mjpeg', 'cam-02', env), null);
  assert.equal(verifyStreamTicket(`${ticket}tamper`, 'mjpeg', 'cam-01', env), null);

  const expired = createStreamTicket(
    {
      kind: 'upload',
      resourceId: 'up-01',
      userId: 'user-owner',
      tenantId: 'tenant-1',
      outletId: 'outlet-1',
    },
    -1_000,
    env
  );
  assert.equal(verifyStreamTicket(expired, 'upload', 'up-01', env), null);
});

test('validateCameraTenantOutlet blocks cross-tenant and cross-outlet camera spoofing', () => {
  const now = new Date().toISOString();
  const outlets: Outlet[] = [
    {
      outletId: 'out-a',
      tenantId: 'ten-a',
      outletName: 'Store A',
      address: '100 Feet Road',
      city: 'Bengaluru',
      timezone: 'Asia/Kolkata',
      closingTime: '22:00',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      outletId: 'out-b',
      tenantId: 'ten-b',
      outletName: 'Store B',
      address: 'Linking Road',
      city: 'Mumbai',
      timezone: 'Asia/Kolkata',
      closingTime: '22:00',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  ];

  const cameras: Camera[] = [
    {
      cameraId: 'cam-a',
      tenantId: 'ten-a',
      outletId: 'out-a',
      cameraName: 'Entrance A',
      sourceType: 'RTSP',
      maskedEndpoint: 'rtsp://***@192.168.1.50:554/stream',
      hasCredentialsStored: true,
      resolution: '1280x720',
      fps: 15,
      connectionStatus: 'online',
      aiProcessingStatus: 'running',
      lastSeen: now,
      zones: [],
      createdAt: now,
      updatedAt: now,
    },
  ];

  assert.equal(
    validateCameraTenantOutlet({
      cameras,
      outlets,
      cameraId: 'cam-a',
      tenantId: 'ten-a',
      outletId: 'out-a',
    }).ok,
    true
  );

  assert.equal(
    validateCameraTenantOutlet({
      cameras,
      outlets,
      cameraId: 'cam-a',
      tenantId: 'ten-b',
      outletId: 'out-b',
    }).ok,
    false
  );

  assert.equal(
    validateCameraTenantOutlet({
      cameras,
      outlets,
      cameraId: 'cam-a',
      tenantId: 'ten-a',
      outletId: 'out-b',
    }).ok,
    false
  );

  assert.equal(
    validateCameraTenantOutlet({
      cameras,
      outlets,
      cameraId: 'upload-test',
      tenantId: 'ten-a',
      outletId: 'out-a',
      allowUploadPlaceholder: true,
    }).ok,
    true
  );
});

test('getSecurityEnvChecklist exposes non-secret booleans only', () => {
  const checklist = getSecurityEnvChecklist({
    NODE_ENV: 'production',
    EDGE_API_KEY: 'secret-edge',
    CAMERA_SECRET_KEY: 'secret-cam',
    VISION_SERVICE_URL: 'https://edge.internal:8001',
  });
  assert.deepEqual(checklist, {
    productionMode: true,
    demoAuthEnabled: false,
    edgeApiKeyConfigured: true,
    cameraSecretKeyConfigured: true,
    visionServiceConfigured: true,
  });
});
