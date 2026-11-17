import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');

test('firestore.rules includes default deny safety net and all blueprint collections', () => {
  const rules = fs.readFileSync(rulesPath, 'utf-8');
  const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf-8')) as {
    firestore: Record<string, unknown>;
  };

  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);
  assert.match(rules, /match \/cameras\/\{cameraId\}[\s\S]*match \/secrets\/\{secretId\} \{\s*allow read, write: if false;\s*\}/);

  const expectedMatches = [
    'match /tenants/{tenantId}',
    'match /outlets/{outletId}',
    'match /users/{userId}',
    'match /private/{docId}',
    'match /cameras/{cameraId}',
    'match /visitSessions/{sessionId}',
    'match /detectionEvents/{eventId}',
    'match /transactions/{transactionId}',
    'match /reports/{reportId}',
    'match /auditLogs/{logId}',
  ];

  for (const m of expectedMatches) {
    assert.ok(rules.includes(m), `Expected firestore.rules to include ${m}`);
  }
  assert.ok(Object.keys(blueprint.firestore).length >= 10);
});

test('firestore.rules enforces Dirty Dozen invariants: no blanket list, verified email, and terminal transaction locking', () => {
  const rules = fs.readFileSync(rulesPath, 'utf-8');
  // Must not allow blanket isSignedIn() list
  assert.equal(/allow list:\s*if\s*isSignedIn\(\)\s*;/.test(rules), false);
  // Must require email_verified == true
  assert.match(rules, /request\.auth\.token\.email_verified == true/);
  // Must validate IDs and size limits
  assert.match(rules, /function isValidId\(id\)/);
  // Must lock confirmed transactions from arbitrary amount edits
  assert.match(rules, /incoming\(\)\.amount == existing\(\)\.amount/);
  // Audit logs must not be deleted or updated
  assert.match(rules, /match \/auditLogs\/\{logId\}[\s\S]*allow update, delete: if false;/);
});
