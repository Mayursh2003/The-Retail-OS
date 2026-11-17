import crypto from 'node:crypto';
import type { Camera, Outlet } from '../../shared/types/domain';

export type EnvMap = Record<string, string | undefined>;

const EPHEMERAL_TICKET_SECRET = crypto.randomBytes(32);

export function isProductionEnv(env: EnvMap = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function isDemoAuthAllowed(env: EnvMap = process.env): boolean {
  return !isProductionEnv(env);
}

export function getEdgeApiKey(env: EnvMap = process.env): string | null {
  const raw = env.EDGE_API_KEY?.trim();
  return raw ? raw : null;
}

export function verifyEdgeApiKey(
  providedKey: string | undefined,
  env: EnvMap = process.env
): { ok: boolean; status: 200 | 401 | 403 | 503; error?: string } {
  const expected = getEdgeApiKey(env);
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: 'EDGE_API_KEY is not configured on the backend server.',
    };
  }
  const cleanProvided = typeof providedKey === 'string' ? providedKey.trim() : '';
  if (!cleanProvided) {
    return {
      ok: false,
      status: 401,
      error: 'Missing x-edge-api-key header.',
    };
  }

  const providedHash = crypto.createHash('sha256').update(cleanProvided, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  if (!crypto.timingSafeEqual(providedHash, expectedHash)) {
    return {
      ok: false,
      status: 403,
      error: 'Invalid edge connector API key.',
    };
  }
  return { ok: true, status: 200 };
}

export function getVisionServiceUrl(env: EnvMap = process.env): string | null {
  const raw = env.VISION_SERVICE_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function getCameraSecretKey(env: EnvMap = process.env): string | null {
  const raw = env.CAMERA_SECRET_KEY?.trim();
  return raw ? raw : null;
}

export function deriveAes256Key(secretKey: string): Buffer {
  return crypto.createHash('sha256').update(secretKey, 'utf8').digest();
}

export function encryptCameraCredential(plaintext: string, env: EnvMap = process.env): string {
  const secretKey = getCameraSecretKey(env);
  if (!secretKey) {
    throw new Error(
      'CAMERA_SECRET_KEY environment variable is not configured; refusing to encrypt camera credentials without a server secret.'
    );
  }
  const key = deriveAes256Key(secretKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes256gcm:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptCameraCredential(ciphertext: string, env: EnvMap = process.env): string {
  const secretKey = getCameraSecretKey(env);
  if (!secretKey) {
    throw new Error(
      'CAMERA_SECRET_KEY environment variable is not configured; cannot decrypt stored camera credentials.'
    );
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'aes256gcm') {
    throw new Error('Unsupported or legacy demo credential format; cannot decrypt.');
  }
  const [, ivHex, tagHex, encHex] = parts;
  const key = deriveAes256Key(secretKey);
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      'Failed to decrypt camera credentials with current CAMERA_SECRET_KEY. Run the key migration procedure before changing CAMERA_SECRET_KEY.'
    );
  }
}

/**
 * Atomic all-or-nothing key rotation for stored AES-256-GCM camera credentials.
 * Validates every existing aes256gcm credential decrypts cleanly under oldKey
 * before returning a new rotated map encrypted under newKey.
 */
export function rotateCameraSecrets(params: {
  oldKey: string;
  newKey: string;
  cameraSecrets: Record<string, string>;
}): { rotated: Record<string, string>; migratedCount: number; skippedLegacyCount: number } {
  const oldClean = params.oldKey.trim();
  const newClean = params.newKey.trim();
  if (!oldClean || !newClean) {
    throw new Error('Both oldKey and newKey are required to rotate camera credentials.');
  }
  if (oldClean === newClean) {
    throw new Error('newKey must differ from oldKey.');
  }

  const rotated: Record<string, string> = {};
  let migratedCount = 0;
  let skippedLegacyCount = 0;

  for (const [cameraId, value] of Object.entries(params.cameraSecrets)) {
    if (!value.startsWith('aes256gcm:')) {
      rotated[cameraId] = value;
      skippedLegacyCount += 1;
      continue;
    }
    const plaintext = decryptCameraCredential(value, { CAMERA_SECRET_KEY: oldClean });
    rotated[cameraId] = encryptCameraCredential(plaintext, { CAMERA_SECRET_KEY: newClean });
    migratedCount += 1;
  }

  return { rotated, migratedCount, skippedLegacyCount };
}

export interface StreamTicketPayload {
  kind: 'mjpeg' | 'upload';
  resourceId: string;
  userId: string;
  tenantId: string;
  outletId: string;
  exp: number;
}

function getTicketSigningKey(env: EnvMap = process.env): Buffer {
  const seed = env.CAMERA_SECRET_KEY?.trim() || env.EDGE_API_KEY?.trim();
  if (seed) {
    return crypto.createHmac('sha256', seed).update('retail-brain-stream-ticket').digest();
  }
  return EPHEMERAL_TICKET_SECRET;
}

export function createStreamTicket(
  payload: Omit<StreamTicketPayload, 'exp'>,
  ttlMs = 5 * 60_000,
  env: EnvMap = process.env
): string {
  const fullPayload: StreamTicketPayload = {
    ...payload,
    exp: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getTicketSigningKey(env))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyStreamTicket(
  token: string | undefined,
  expectedKind: StreamTicketPayload['kind'],
  expectedResourceId: string,
  env: EnvMap = process.env
): StreamTicketPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, providedSig] = parts;
  if (!encoded || !providedSig) return null;

  const expectedSig = crypto
    .createHmac('sha256', getTicketSigningKey(env))
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(providedSig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as StreamTicketPayload;
    if (
      parsed.kind !== expectedKind ||
      parsed.resourceId !== expectedResourceId ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < Date.now()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function validateCameraTenantOutlet(params: {
  cameras: Camera[];
  outlets: Outlet[];
  cameraId: string;
  tenantId: string;
  outletId: string;
  allowUploadPlaceholder?: boolean;
}): { ok: boolean; error?: string; camera?: Camera; outlet?: Outlet } {
  const outlet = params.outlets.find((o) => o.outletId === params.outletId);
  if (!outlet) {
    return { ok: false, error: 'Target outlet does not exist.' };
  }
  if (outlet.tenantId !== params.tenantId) {
    return {
      ok: false,
      error: 'Outlet does not belong to the specified tenant.',
    };
  }
  if (params.allowUploadPlaceholder && params.cameraId === 'upload-test') {
    return { ok: true, outlet };
  }
  const camera = params.cameras.find((c) => c.cameraId === params.cameraId);
  if (!camera) {
    return { ok: false, error: 'Camera is not registered.' };
  }
  if (camera.tenantId !== params.tenantId || camera.outletId !== params.outletId) {
    return {
      ok: false,
      error: 'Camera does not belong to the specified tenant and outlet.',
    };
  }
  return { ok: true, camera, outlet };
}

export function getSecurityEnvChecklist(env: EnvMap = process.env) {
  return {
    productionMode: isProductionEnv(env),
    demoAuthEnabled: isDemoAuthAllowed(env),
    edgeApiKeyConfigured: Boolean(getEdgeApiKey(env)),
    cameraSecretKeyConfigured: Boolean(getCameraSecretKey(env)),
    visionServiceConfigured: Boolean(getVisionServiceUrl(env)),
  };
}
