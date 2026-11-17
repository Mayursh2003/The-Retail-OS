# Retail Brain OS — REST & WebSocket API Documentation

All authenticated endpoints require either:
- `Authorization: Bearer <Firebase_ID_Token>` (Production Firebase Auth), or
- `x-demo-mode: true` + `x-demo-user-id: <demoUserId>` (Explicit Demo Mode).

## Endpoints

- `GET /api/health` — Returns backend, WebSocket client count, and Python `vision-service` probe status.
- `GET /api/workspace` — Returns strictly tenant- and outlet-scoped snapshot for the authenticated actor.
- `POST /api/tenants` (`DEVELOPER` only) — Creates a new tenant and generates a secure one-time owner invitation.
- `PATCH /api/tenants/:tenantId` (`DEVELOPER` only) — Updates tenant status (`active`, `suspended`, `pending`) or plan.
- `POST /api/outlets` (`DEVELOPER` | `CLIENT_OWNER`) — Creates an outlet with IANA timezone and daily closing time.
- `PATCH /api/outlets/:outletId` (`DEVELOPER` | `CLIENT_OWNER`) — Updates outlet metadata and closing schedule.
- `POST /api/invitations` (`DEVELOPER` | `CLIENT_OWNER`) — Issues an invitation token for a user scoped to specific outlets.
- `PATCH /api/users/:userId/status` (`DEVELOPER` | `CLIENT_OWNER`) — Activates/disables users or updates worker outlet assignments.
- `POST /api/cameras` (`DEVELOPER` | `CLIENT_OWNER`) — Registers RTSP, HDMI, or UPLOAD camera. Encrypts RTSP credentials server-side.
- `PATCH /api/cameras/:cameraId` (`DEVELOPER` | `CLIENT_OWNER`) — Updates polygon zones, resolution, FPS, or AI processing status.
- `DELETE /api/cameras/:cameraId` (`DEVELOPER` only) — Deletes camera and encrypted secret.
- `POST /api/cameras/:cameraId/test` (`DEVELOPER` | `CLIENT_OWNER`) — Performs TCP/RTSP stream reachability check and updates `connectionStatus`.
- `POST /api/transactions` (`WORKER` for assigned outlet | `CLIENT_OWNER` | `DEVELOPER`) — Manually confirms payment with duplicate guard and immutable audit log.
- `PATCH /api/transactions/:transactionId/status` (`CLIENT_OWNER` | `DEVELOPER`) — Cancels or refunds a confirmed payment with mandatory reason.
- `POST /api/reports/generate` (`CLIENT_OWNER` | `DEVELOPER`) — Generates `daily`, `weekly`, or `monthly` reports in each outlet's local timezone.
- `POST /api/vision/upload` — Accepts temporary MP4/AVI/MOV/WEBM file (auto-purged after 30m) and returns `/api/vision/stream/:uploadId`.
- `POST /api/vision/events` (`x-edge-api-key`) — Outbound webhook receiving YOLOv8n + ByteTrack events from Python edge service.
- `PATCH /api/model/config` (`DEVELOPER` only) — Updates YOLO variant and confidence threshold.

## WebSocket Channel (`/ws`)

Connect with `?role=<ROLE>&tenantId=<TENANT_ID>&outlets=<OUTLET_IDS>`.
Server broadcasts strictly scoped events: `detection:event`, `session:updated`, `transaction:confirmed`, `transaction:updated`, `camera:status`.
