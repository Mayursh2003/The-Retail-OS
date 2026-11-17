# Deployment & Integration Test Guide

## Cloud Run Web + Backend Deployment

1. Build the frontend bundle: `npm run build`
2. Deploy `firestore.rules` to Firebase project `elite-ray-sflln`.
3. Set environment variables on Cloud Run: `NODE_ENV=production`, `PORT=3000`, `EDGE_API_KEY`, `CAMERA_SECRET_KEY`.
4. Start server: `npm run start`

## Edge Python Service (`deployment/docker-compose.edge.yml`)

Run `docker compose -f deployment/docker-compose.edge.yml up -d` on the store's local Ubuntu/Windows edge box.

## Integration Verification Checklist

1. **Tenant Isolation**: Sign in as `Owner — Bharat Fresh Mart` and confirm `Vastra Luxe Retail` outlets/payments are absent from `/api/workspace`.
2. **Worker Restriction**: Sign in as `Worker — Indiranagar Flagship` and confirm `/dev` or `/owner` routes redirect to `/worker`, and Koramangala/Jayanagar outlets are inaccessible.
3. **Payment Persistence & Audit**: Submit a ₹1,250 UPI payment in `/worker/payment`, reload, verify persistence in Owner `/owner/payments`, then cancel with a mandatory audit reason and confirm revenue updates.
4. **Automated Report & CSV**: Click **Generate Report Now** in `/owner/reports` and download CSV.
