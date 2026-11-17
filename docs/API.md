# Retail Brain OS — REST & WebSocket API Documentation

All authenticated endpoints require:
- `Authorization: Bearer <Firebase_ID_Token>` (Production & Firebase Auth — required when `NODE_ENV=production`), or
- `x-demo-mode: true` + `x-demo-user-id: <demoUserId>` (Allowed **only** when `NODE_ENV !== 'production'`).

## Endpoints

- `GET /api/health` — Returns non-secret backend status, WebSocket client count, `visionService` connectivity (`configured`, `connected`, `inferenceMode: 'live_yolo' | 'demo_simulation'`), and `securityStatus` configuration flags.
- `GET /api/auth/config` — Returns `{ demoAuthEnabled, productionMode }` so the UI suppresses demo sign-in controls in production.
- `GET /api/workspace` — Returns strictly tenant- and outlet-scoped snapshot for the authenticated actor.
- `POST /api/tenants` (`DEVELOPER` only) — Creates a new tenant and generates a secure one-time owner invitation.
- `PATCH /api/tenants/:tenantId` (`DEVELOPER` only) — Updates tenant status (`active`, `suspended`, `pending`) or plan.
- `POST /api/outlets` (`DEVELOPER` | `CLIENT_OWNER`) — Creates an outlet with IANA timezone and daily closing time.
- `PATCH /api/outlets/:outletId` (`DEVELOPER` | `CLIENT_OWNER`) — Updates outlet metadata and closing schedule.
- `POST /api/invitations` (`DEVELOPER` | `CLIENT_OWNER`) — Issues an invitation token for a user scoped to specific outlets.
- `PATCH /api/users/:userId/status` (`DEVELOPER` | `CLIENT_OWNER`) — Activates/disables users or updates worker outlet assignments.
- `POST /api/cameras` (`DEVELOPER` | `CLIENT_OWNER`) — Registers RTSP, HDMI, or UPLOAD camera. Encrypts RTSP credentials server-side using `CAMERA_SECRET_KEY` (fails safely with `503` if `CAMERA_SECRET_KEY` is missing) and validates tenant/outlet ownership.
- `PATCH /api/cameras/:cameraId` (`DEVELOPER` | `CLIENT_OWNER`) — Updates polygon zones, resolution, FPS, or AI processing status.
- `DELETE /api/cameras/:cameraId` (`DEVELOPER` only) — Deletes camera and encrypted secret.
- `POST /api/cameras/:cameraId/test` (`DEVELOPER` | `CLIENT_OWNER`) — Decrypts RTSP URL strictly server-side to test TCP/RTSP stream reachability and updates `connectionStatus`.
- `POST /api/cameras/:cameraId/stream-token` (Authenticated actor with outlet access) — Issues a short-lived HMAC-scoped ticket (`streamUrl`) for browser `<img>` playback of `/api/cameras/:cameraId/stream/mjpeg` without exposing Firebase ID tokens or RTSP credentials in browser URLs.
- `GET /api/cameras/:cameraId/stream/mjpeg` (Bearer auth or scoped `ticket` query) — Server-side proxy that forwards authenticated requests to `${VISION_SERVICE_URL}/streams/${cameraId}/mjpeg` with `x-edge-api-key` and `x-rtsp-source` headers.
- `POST /api/transactions` (`WORKER` for assigned outlet | `CLIENT_OWNER` | `DEVELOPER`) — Manually confirms payment with duplicate guard and immutable audit log.
- `PATCH /api/transactions/:transactionId/status` (`CLIENT_OWNER` | `DEVELOPER`) — Cancels or refunds a confirmed payment with mandatory reason.
- `POST /api/reports/generate` (`CLIENT_OWNER` | `DEVELOPER`) — Generates `daily`, `weekly`, or `monthly` reports in each outlet's local timezone.
- `POST /api/vision/upload` (Authenticated actor with outlet access) — Accepts temporary MP4/AVI/MOV/WEBM file (auto-purged after retention period), validates tenant/outlet/camera ownership, forwards multipart video + `x-edge-api-key` server-to-server to `${VISION_SERVICE_URL}/upload-video` for YOLOv8n + ByteTrack inference, and returns metrics + ticketed `/api/vision/stream/:uploadId` and `/api/vision/annotated/:uploadId` playback URLs.
- `GET /api/vision/stream/:uploadId` & `GET /api/vision/annotated/:uploadId` (Bearer auth or scoped `ticket` query) — Stream temporary raw and Python-annotated MP4 test videos with byte-range seeking strictly to authorized callers for that tenant/outlet.
- `POST /api/vision/events` (`x-edge-api-key` required) — Outbound webhook receiving YOLOv8n + ByteTrack events (`bbox`, `latencyMs`, `temporaryTrackId`, `confidence`, `frameNumber`, `zoneName`) from Python edge service. Rejects missing (`401`), invalid (`403`), or unconfigured (`503`) `EDGE_API_KEY`, and enforces camera-to-tenant/outlet ownership.
- `PATCH /api/model/config` (`DEVELOPER` only) — Updates YOLO variant and confidence threshold (and syncs to `VISION_SERVICE_URL` with `x-edge-api-key` when configured).

## WebSocket Channel (`/ws`)

Connect to `/ws` **without** role, tenant, or outlet query parameters (any query params are ignored).
Authenticate via either:
1. HTTP upgrade header `Authorization: Bearer <Firebase_ID_Token>`, or
2. Initial WebSocket frame within 5 seconds of connection:
   - Production / Firebase: `{ "type": "auth", "token": "<Firebase_ID_Token>" }`
   - Development only: `{ "type": "auth", "demoUserId": "<userId>" }`

The server resolves `role`, `tenantId`, and `assignedOutletIds` strictly from backend user records, closes unauthorized sockets with code `4401`, and broadcasts scoped events: `detection:event`, `session:updated`, `transaction:confirmed`, `transaction:updated`, `camera:status`.
