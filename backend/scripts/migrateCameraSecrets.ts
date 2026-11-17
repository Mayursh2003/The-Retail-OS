import fs from 'node:fs';
import path from 'node:path';
import { rotateCameraSecrets } from '../security/config';

/**
 * Safe all-or-nothing migration script when rotating CAMERA_SECRET_KEY.
 *
 * Usage:
 *   OLD_CAMERA_SECRET_KEY="..." NEW_CAMERA_SECRET_KEY="..." npm run migrate:camera-keys
 */
function main(): void {
  const oldKey = process.env.OLD_CAMERA_SECRET_KEY;
  const newKey = process.env.NEW_CAMERA_SECRET_KEY;

  if (!oldKey?.trim() || !newKey?.trim()) {
    console.error(
      'Error: Set OLD_CAMERA_SECRET_KEY and NEW_CAMERA_SECRET_KEY environment variables before running key rotation.'
    );
    process.exit(1);
  }

  const storeFile = path.resolve(process.cwd(), '.data', 'retail-brain-store.json');
  if (!fs.existsSync(storeFile)) {
    console.log('No local store file found at .data/retail-brain-store.json; nothing to migrate.');
    return;
  }

  const raw = fs.readFileSync(storeFile, 'utf8');
  const parsed = JSON.parse(raw) as { cameraSecrets?: Record<string, string> };
  const existingSecrets = parsed.cameraSecrets ?? {};

  const { rotated, migratedCount, skippedLegacyCount } = rotateCameraSecrets({
    oldKey,
    newKey,
    cameraSecrets: existingSecrets,
  });

  const backupFile = `${storeFile}.bak-${Date.now()}`;
  fs.writeFileSync(backupFile, raw, 'utf8');

  parsed.cameraSecrets = rotated;
  fs.writeFileSync(storeFile, JSON.stringify(parsed, null, 2), 'utf8');

  console.log(
    `Camera credential key rotation complete. Migrated=${migratedCount}, SkippedDemoPlaceholders=${skippedLegacyCount}, Backup=${path.basename(backupFile)}.`
  );
}

main();
