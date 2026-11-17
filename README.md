# Retail Brain OS

Multi-tenant retail CCTV intelligence, anonymous visitor session analytics, manual payment confirmation, and automated outlet reporting platform built for Indian retail businesses.

## Architecture

1. **Frontend (`src/`)**: React 19, TypeScript, Tailwind CSS v4, React Router, Recharts, Lucide Icons, PWA (`vite-plugin-pwa`), and Firebase Client SDK (`firebase-applet-config.json`).
   - **Developer Console (`/dev/*`)**: Super-admin interface across all tenants, outlets, cameras, YOLOv8 model config, system health, and audit logs.
   - **Business Owner Dashboard (`/owner/*`)**: Multi-outlet analytics, live camera views, visitor session classifications, payment ledger, automated daily/weekly/monthly reports (CSV & PDF/Print), and employee invitations.
   - **Store Worker Dashboard (`/worker/*`)**: Tablet/mobile-first interface strictly scoped to assigned outlets for live camera viewing, today's visitors, and manual payment confirmation.
2. **Main Backend (`server.ts`, `backend/`)**: Node.js + Express + WebSockets (`ws`) + Firebase Auth verification + AES-256-GCM server-side camera credential encryption.
3. **Python Computer Vision Edge Service (`vision-service/`)**: FastAPI + OpenCV + Ultralytics YOLOv8n (`class=0` person only) + ByteTrack anonymous temporary IDs (`TRK-001`) + polygon zone engine + authenticated MJPEG streaming.

## Privacy & Security Guarantees

- **Zero Biometric Storage**: No facial recognition vectors, face embeddings, or cross-outlet visitor identities are ever stored.
- **No Auto-Confirmed Sales**: Camera detections never create confirmed revenue; every transaction requires manual confirmation by an authorized worker or owner.
- **No Exposed Camera Credentials**: RTSP credentials are encrypted server-side using `CAMERA_SECRET_KEY` (AES-256-GCM) and never returned in browser URLs, API responses, or frontend JavaScript.
- **Strict Production Auth**: Setting `NODE_ENV=production` disables demo mode authentication across all HTTP endpoints, WebSocket connections, and UI sign-in screens.
- **Separate Edge Service Secrets**: The Python `vision-service` reads `BACKEND_URL` and `EDGE_API_KEY` from its own environment (`vision-service/.env`), never inheriting Node.js backend secrets implicitly.

## Environment Setup

1. Copy `.env.example` to `.env` for the Node.js backend (never commit `.env`):
   - `NODE_ENV`, `PORT`, `APP_URL`, `FIREBASE_PROJECT_ID`
   - `EDGE_API_KEY`, `CAMERA_SECRET_KEY`, `VISION_SERVICE_URL`
2. Copy `vision-service/.env.example` to `vision-service/.env` for the separate Python edge service:
   - `BACKEND_URL` (your deployed Node.js backend URL)
   - `EDGE_API_KEY` (must match the backend `EDGE_API_KEY`)

## Quick Start

```bash
npm install
npm run test
npm run lint
npm run dev
```

For the standalone Python edge service:

```bash
docker compose --env-file vision-service/.env -f deployment/docker-compose.edge.yml up -d
```
