# Deployment & Integration Test Guide

## 1. Cloud Run Web + Node.js Backend Deployment

1. Build the frontend bundle: `npm run build`
2. Deploy `firestore.rules` to Firebase project `elite-ray-sflln`.
3. Configure **Node.js backend** environment variables / Cloud Run secrets (never commit real secrets):
   - `NODE_ENV=production` (disables all demo authentication)
   - `PORT=3000`
   - `APP_URL=https://<your-cloud-run-service-url>`
   - `FIREBASE_PROJECT_ID=elite-ray-sflln`
   - `EDGE_API_KEY=<strong-random-shared-secret>`
   - `CAMERA_SECRET_KEY=<strong-32+-char-encryption-secret>`
   - `VISION_SERVICE_URL=<https-url-of-reachable-vision-service-or-empty>` (Note: `127.0.0.1` / `localhost` is **not** reachable from Cloud Run)
4. Start server: `npm run start`

## 2. Python Edge Service Deployment (`vision-service/`)

The Python edge container runs separately (either on the store's local LAN edge computer or its own cloud host) and **does not** inherit Node.js backend secrets automatically.

1. Copy `vision-service/.env.example` to `vision-service/.env` and configure:
   - `BACKEND_URL=https://<your-deployed-nodejs-backend-url>`
   - `EDGE_API_KEY=<exact-same-key-as-nodejs-backend-EDGE_API_KEY>`
   - `YOLO_MODEL=yolov8n.pt`
   - `YOLO_CONF=0.45`
2. Start the edge container:
   ```bash
   docker compose --env-file vision-service/.env -f deployment/docker-compose.edge.yml up -d
   ```

## 3. Rotating `CAMERA_SECRET_KEY` Safely

If real RTSP camera credentials (`aes256gcm:...`) are already stored, **do not** change `CAMERA_SECRET_KEY` directly or decryption will fail. Run the atomic migration helper first:

```bash
OLD_CAMERA_SECRET_KEY="<current-key>" NEW_CAMERA_SECRET_KEY="<new-key>" npm run migrate:camera-keys
```

Then update `CAMERA_SECRET_KEY` on your deployment target and restart the server.

## 4. Integration & Security Verification Checklist

1. **Tenant Isolation**: Sign in as `Owner — Bharat Fresh Mart` (dev mode) or a tenant-scoped Firebase user and confirm `Vastra Luxe Retail` outlets/payments are absent from `/api/workspace`.
2. **Worker Restriction**: Sign in as `Worker — Indiranagar Flagship` and confirm `/dev` or `/owner` routes redirect to `/worker`, and Koramangala/Jayanagar outlets are inaccessible.
3. **Edge Key Enforcement**: Send `POST /api/vision/events` without `x-edge-api-key` or with a wrong key and confirm rejection (`401`/`403` when configured, `503` when unconfigured).
4. **WebSocket Auth**: Connect to `/ws` without sending `{ type: "auth", token }` (or `Authorization: Bearer`) and confirm connection closes with `4401`.
5. **Payment Persistence & Audit**: Submit a ₹1,250 UPI payment in `/worker/payment`, reload, verify persistence in Owner `/owner/payments`, then cancel with a mandatory audit reason and confirm revenue updates.
6. **Automated Report & CSV**: Click **Generate Report Now** in `/owner/reports` and download CSV.
