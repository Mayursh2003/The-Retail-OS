# Retail Brain OS

Multi-tenant retail CCTV intelligence, anonymous visitor session analytics, manual payment confirmation, and automated outlet reporting platform built for Indian retail businesses.

## Architecture

1. **Frontend (`src/`)**: React 19, TypeScript, Tailwind CSS v4, React Router, Recharts, Lucide Icons, PWA (`vite-plugin-pwa`), and Firebase Client SDK (`firebase-applet-config.json`).
   - **Developer Console (`/dev/*`)**: Super-admin interface across all tenants, outlets, cameras, YOLOv8 model config, system health, and audit logs.
   - **Business Owner Dashboard (`/owner/*`)**: Multi-outlet analytics, live camera views, visitor session classifications, payment ledger, automated daily/weekly/monthly reports (CSV & PDF/Print), and employee invitations.
   - **Store Worker Dashboard (`/worker/*`)**: Tablet/mobile-first interface strictly scoped to assigned outlets for live camera viewing, today's visitors, and manual payment confirmation.
2. **Main Backend (`server.ts`, `backend/`)**: Node.js + Express + WebSockets (`ws`) + Firebase Admin SDK + AES-256-GCM server-side camera credential encryption.
3. **Python Computer Vision Edge Service (`vision-service/`)**: FastAPI + OpenCV + Ultralytics YOLOv8n (`class=0` person only) + ByteTrack anonymous temporary IDs (`TRK-001`) + polygon zone engine + MJPEG streaming.

## Privacy & Operational Guarantees

- **Zero Biometric Storage**: No facial recognition vectors, face embeddings, or cross-outlet visitor identities are ever stored.
- **No Auto-Confirmed Sales**: Camera detections never create confirmed revenue; every transaction requires manual confirmation by an authorized worker or owner.
- **No Exposed Camera Credentials**: RTSP passwords are encrypted on the backend and isolated under `/cameras/{cameraId}/secrets/{secretId}` (`allow read, write: if false;` in `firestore.rules`).

## Quick Start

```bash
npm install
npm run test
npm run lint
npm run dev
```

For the standalone Python edge service:

```bash
cd vision-service
docker build -t retail-brain-vision .
docker run -p 8001:8001 -e BACKEND_URL=http://host.docker.internal:3000 retail-brain-vision
```
