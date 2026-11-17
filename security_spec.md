# Retail Brain OS — Security Specification & Dirty Dozen Audit

## Data Invariants
1. **Tenant Isolation**: No `CLIENT_OWNER` or `WORKER` can read, list, create, update, or delete any document belonging to another `tenantId`.
2. **Outlet Isolation**: A `WORKER` can read cameras, visitSessions, detectionEvents, and transactions ONLY for `outletId` values explicitly present in their `assignedOutletIds` array on `/users/{uid}`.
3. **No Self-Assigned Privilege Escalation**: A user cannot create or modify their own `role`, `tenantId`, or `accountStatus` in `/users/{uid}`. Only `DEVELOPER` (or `CLIENT_OWNER` creating/updating `WORKER` accounts in their own tenant) may assign roles.
4. **No Exposed Camera Secrets**: Raw RTSP URLs with credentials live exclusively in `/cameras/{cameraId}/secrets/{secretId}` where client SDK access is unconditionally denied (`if false`).
5. **Immutable Financial Audit Trail**: Confirmed `transactions` cannot be silently overwritten to change `amount`, `confirmedBy`, or `tenantId`. Corrections/cancellations/refunds only transition `paymentStatus` via authorized owner/developer actions and require an atomic `auditLogs` entry (`existsAfter`).
6. **Temporal Integrity**: `createdAt` and `updatedAt` timestamps on client-originated writes must equal `request.time`.
7. **PII Isolation**: User email and phone reside in `/users/{userId}/private/contact` readable only by the user themselves or `DEVELOPER`.

## Dirty Dozen Malicious Payloads (All Must Return PERMISSION_DENIED)
1. **Cross-Tenant Read**: `CLIENT_OWNER` of `tenant-alpha` tries `get(/outlets/outlet-beta-1)` belonging to `tenant-beta`.
2. **Unscoped List Scraping**: `WORKER` runs `list(/transactions)` without a `where('tenantId', '==', ...)` or `where('outletId', 'in', ...)` filter matching their assignment.
3. **Self-Role Escalation**: `WORKER` tries `update(/users/{uid}, { role: 'DEVELOPER' })`.
4. **Ghost Field Injection (Shadow Update)**: `WORKER` creates a transaction with `{ ..., isVerifiedAdmin: true }`.
5. **Negative/Zero Amount Poisoning**: `WORKER` creates a transaction with `{ amount: -500 }`.
6. **Impersonated Confirmation**: `WORKER` creates a transaction with `confirmedBy: 'other-worker-uid'`.
7. **Orphaned Transaction**: User creates a transaction referencing a non-existent `outletId`.
8. **Terminal Transaction Tampering**: `WORKER` updates a `cancelled` transaction back to `confirmed`.
9. **ID Poisoning**: User tries `create(/outlets/invalid$id!with*badchars, ...)` or 1.5KB document ID.
10. **Unverified Email Spoof**: Unauthenticated or `email_verified: false` token attempts write on `/tenants/t1`.
11. **Camera Secret Exfiltration**: `CLIENT_OWNER` tries `get(/cameras/cam-1/secrets/rtsp)`.
12. **Audit Log Deletion**: `CLIENT_OWNER` or `WORKER` tries `delete(/auditLogs/log-1)`.
