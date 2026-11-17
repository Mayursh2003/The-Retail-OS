import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createApiRouter } from './api';

test('Node backend forwards multipart upload with EDGE_API_KEY, enforces tenant/camera ownership, and serves ticketed annotated MP4', async () => {
  const prevVision = process.env.VISION_SERVICE_URL;
  const prevEdge = process.env.EDGE_API_KEY;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevRetention = process.env.UPLOAD_RETENTION_MS;

  process.env.EDGE_API_KEY = 'unit-test-edge-key';
  process.env.NODE_ENV = 'development';
  process.env.UPLOAD_RETENTION_MS = '1500';

  let receivedEdgeHeader: string | undefined;
  let receivedBodyText = '';
  let deletedPythonArtifact = false;

  const mockPython = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', model: 'yolov8n.pt', device: 'CPU' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/upload-video') {
      receivedEdgeHeader = req.headers['x-edge-api-key'] as string | undefined;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBodyText = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            upload_job_id: 'job-test01',
            annotated_download_path: '/annotated/job-test01',
            model: 'yolov8n.pt',
            confidence_threshold: 0.45,
            device: 'CPU',
            frames_total: 10,
            frames_processed: 5,
            unique_temporary_tracks: ['TRK-001'],
            visitor_count: 1,
            total_detections: 4,
            avg_fps: 12.5,
            inference_ms: 41.2,
            events_dispatched: 1,
            detections_sample: [
              {
                temporaryTrackId: 'TRK-001',
                bbox: [120, 200, 320, 750],
                confidence: 0.88,
                frameNumber: 2,
                timestamp: new Date().toISOString(),
                cameraId: 'upload-test',
                outletId: 'out-indiranagar',
                tenantId: 'ten-bharat-fresh',
                zoneName: 'Entrance',
                latencyMs: 41.2,
              },
            ],
          })
        );
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/annotated/job-test01') {
      if (req.headers['x-edge-api-key'] !== 'unit-test-edge-key') {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.from('FAKE_ANNOTATED_MP4_BYTES'));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/annotated/job-test01') {
      deletedPythonArtifact = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockPython.listen(0, '127.0.0.1', resolve));
  const pyPort = (mockPython.address() as { port: number }).port;
  process.env.VISION_SERVICE_URL = `http://127.0.0.1:${pyPort}`;

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());
  const backendServer = http.createServer(app);
  await new Promise<void>((resolve) => backendServer.listen(0, '127.0.0.1', resolve));
  const apiPort = (backendServer.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${apiPort}`;

  try {
    // 1. Upload test video (spoofed tenantId in form is ignored; backend derives ten-bharat-fresh from out-indiranagar)
    const form = new FormData();
    form.append('video', new Blob([Buffer.from('SAMPLE_MP4_CONTENT')], { type: 'video/mp4' }), 'sample.mp4');
    form.append('outletId', 'out-indiranagar');
    form.append('tenantId', 'ten-vastra-luxe'); // Spoof attempt must be ignored!

    const uploadResp = await fetch(`${baseUrl}/api/vision/upload`, {
      method: 'POST',
      headers: {
        'x-demo-mode': 'true',
        'x-demo-user-id': 'usr-owner-bharat',
      },
      body: form,
    });
    assert.equal(uploadResp.status, 201);
    const uploaded = (await uploadResp.json()) as {
      uploadId: string;
      tenantId: string;
      outletId: string;
      inferenceState: string;
      annotatedStreamUrl?: string;
      metrics?: { visitorCount: number; uniqueTrackIds: string[] };
    };

    assert.equal(uploaded.tenantId, 'ten-bharat-fresh');
    assert.equal(uploaded.outletId, 'out-indiranagar');
    assert.equal(uploaded.inferenceState, 'live_yolo');
    assert.ok(uploaded.annotatedStreamUrl?.includes('/api/vision/annotated/'));
    assert.equal(uploaded.metrics?.visitorCount, 1);
    assert.deepEqual(uploaded.metrics?.uniqueTrackIds, ['TRK-001']);
    assert.equal(receivedEdgeHeader, 'unit-test-edge-key');
    assert.equal(receivedBodyText.includes('ten-bharat-fresh'), true);
    assert.equal(receivedBodyText.includes('ten-vastra-luxe'), false);

    // 2. Annotated playback works with ticket, fails without auth/ticket
    const noAuthPlayback = await fetch(`${baseUrl}/api/vision/annotated/${uploaded.uploadId}`);
    assert.equal(noAuthPlayback.status, 401);

    const ticketPlayback = await fetch(`${baseUrl}${uploaded.annotatedStreamUrl}`);
    assert.equal(ticketPlayback.status, 200);
    assert.equal(await ticketPlayback.text(), 'FAKE_ANNOTATED_MP4_BYTES');

    // 3. Cross-tenant camera upload rejected with 403
    const crossTenantForm = new FormData();
    crossTenantForm.append('video', new Blob([Buffer.from('X')], { type: 'video/mp4' }), 'bad.mp4');
    crossTenantForm.append('outletId', 'out-indiranagar');
    crossTenantForm.append('cameraId', 'cam-bandra-01'); // belongs to Vastra Luxe
    const crossResp = await fetch(`${baseUrl}/api/vision/upload`, {
      method: 'POST',
      headers: {
        'x-demo-mode': 'true',
        'x-demo-user-id': 'usr-owner-bharat',
      },
      body: crossTenantForm,
    });
    assert.equal(crossResp.status, 403);

    // 4. Detection event webhook rejects missing/wrong key and updates existing session cleanly
    const noKeyEvent = await fetch(`${baseUrl}/api/vision/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'ten-bharat-fresh',
        outletId: 'out-indiranagar',
        cameraId: 'cam-ind-ent-01',
        temporaryTrackId: 'TRK-777',
      }),
    });
    assert.equal(noKeyEvent.status, 401);

    const badKeyEvent = await fetch(`${baseUrl}/api/vision/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-api-key': 'wrong' },
      body: JSON.stringify({
        tenantId: 'ten-bharat-fresh',
        outletId: 'out-indiranagar',
        cameraId: 'cam-ind-ent-01',
        temporaryTrackId: 'TRK-777',
      }),
    });
    assert.equal(badKeyEvent.status, 403);

    const goodEvent1 = await fetch(`${baseUrl}/api/vision/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-api-key': 'unit-test-edge-key' },
      body: JSON.stringify({
        tenantId: 'ten-bharat-fresh',
        outletId: 'out-indiranagar',
        cameraId: 'cam-ind-ent-01',
        temporaryTrackId: 'TRK-777',
        eventType: 'entry',
        confidence: 0.92,
        bbox: [100, 120, 220, 480],
        latencyMs: 38.5,
      }),
    });
    assert.equal(goodEvent1.status, 201);
    const body1 = (await goodEvent1.json()) as { session: { sessionId: string; dwellSeconds: number } };

    const goodEvent2 = await fetch(`${baseUrl}/api/vision/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-api-key': 'unit-test-edge-key' },
      body: JSON.stringify({
        tenantId: 'ten-bharat-fresh',
        outletId: 'out-indiranagar',
        cameraId: 'cam-ind-ent-01',
        temporaryTrackId: 'TRK-777',
        eventType: 'billing_zone_enter',
        confidence: 0.94,
        dwellSeconds: 12,
        sessionStatus: 'billing_zone',
      }),
    });
    assert.equal(goodEvent2.status, 201);
    const body2 = (await goodEvent2.json()) as { session: { sessionId: string; dwellSeconds: number } };
    assert.equal(body2.session.sessionId, body1.session.sessionId);
    assert.equal(body2.session.dwellSeconds, 12);

    // 5. Retention auto-cleanup deletes temporary raw and annotated files
    await new Promise((r) => setTimeout(r, 1700));
    const expiredPlayback = await fetch(`${baseUrl}${uploaded.annotatedStreamUrl}`);
    assert.equal(expiredPlayback.status, 404);
    assert.equal(deletedPythonArtifact, true);
  } finally {
    await new Promise<void>((resolve) => backendServer.close(() => resolve()));
    await new Promise<void>((resolve) => mockPython.close(() => resolve()));
    if (prevVision === undefined) delete process.env.VISION_SERVICE_URL;
    else process.env.VISION_SERVICE_URL = prevVision;
    if (prevEdge === undefined) delete process.env.EDGE_API_KEY;
    else process.env.EDGE_API_KEY = prevEdge;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevRetention === undefined) delete process.env.UPLOAD_RETENTION_MS;
    else process.env.UPLOAD_RETENTION_MS = prevRetention;
  }
});
