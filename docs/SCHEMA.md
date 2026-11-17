# Retail Brain OS — Database Schema & Security Rules

See `firebase-blueprint.json` for exact JSON Schema definitions and `firestore.rules` for production ABAC enforcement.

## Collections

1. `/tenants/{tenantId}` — `tenantId`, `businessName`, `ownerUserId`, `subscriptionPlan`, `status`, `createdAt`, `updatedAt`.
2. `/outlets/{outletId}` — `outletId`, `tenantId`, `outletName`, `address`, `city`, `timezone`, `closingTime`, `status`, `createdAt`, `updatedAt`.
3. `/users/{userId}` — `userId`, `role` (`DEVELOPER` | `CLIENT_OWNER` | `WORKER`), `tenantId`, `assignedOutletIds` (max 20), `displayName`, `accountStatus`.
4. `/users/{userId}/private/{docId}` — Isolated PII (`email`, `phone`).
5. `/cameras/{cameraId}` — Camera metadata and polygon `zones` without raw passwords.
6. `/cameras/{cameraId}/secrets/{secretId}` — Server-only encrypted RTSP credentials (`allow read, write: if false;` on client SDK).
7. `/visitSessions/{sessionId}` — Anonymous temporary visitor sessions (`temporaryTrackId`, `dwellSeconds`, `sessionStatus`, `paymentStatus`).
8. `/detectionEvents/{eventId}` — Person detection events (`entry`, `exit`, `zone_dwell`, `billing_zone_enter`, `confidence`).
9. `/transactions/{transactionId}` — Manually confirmed payments (`amount`, `paymentMethod`, `paymentStatus`, `confirmedBy`).
10. `/reports/{reportId}` — Daily, weekly, and monthly store reports generated in outlet local timezone.
11. `/auditLogs/{logId}` — Append-only operational and financial audit log.
