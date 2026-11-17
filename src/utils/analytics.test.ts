import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateOutletMetrics,
  buildReportCsv,
  calculateAverageBillValue,
  calculateConversionRate,
  checkOutletAccess,
  checkTenantAccess,
  formatINR,
  generatePeriodReport,
  isPointInPolygon,
  maskRtspEndpoint,
  sanitizeCsvCell,
  validateCameraInput,
  validateTransactionInput,
} from './analytics';
import type { ActorContext, Camera, Outlet, Transaction, VisitSession } from '../../shared/types/domain';

test('formatINR formats Indian rupee figures cleanly', () => {
  assert.equal(formatINR(142500), '₹1,42,500');
  assert.equal(formatINR(0), '₹0');
});

test('conversion rate and average bill value handle zero denominators safely', () => {
  assert.equal(calculateConversionRate(0, 0), 0);
  assert.equal(calculateConversionRate(25, 100), 25);
  assert.equal(calculateConversionRate(150, 100), 100);
  assert.equal(calculateAverageBillValue(5000, 0), 0);
  assert.equal(calculateAverageBillValue(5000, 4), 1250);
});

test('tenant and outlet RBAC guards enforce strict multi-tenant and worker isolation', () => {
  const dev: ActorContext = {
    userId: 'u-dev',
    displayName: 'Dev',
    role: 'DEVELOPER',
    tenantId: 'platform',
    assignedOutletIds: [],
    isDemoMode: true,
  };
  const ownerA: ActorContext = {
    userId: 'u-owner-a',
    displayName: 'Owner A',
    role: 'CLIENT_OWNER',
    tenantId: 'tenant-a',
    assignedOutletIds: [],
    isDemoMode: true,
  };
  const workerA1: ActorContext = {
    userId: 'u-worker-a1',
    displayName: 'Worker A1',
    role: 'WORKER',
    tenantId: 'tenant-a',
    assignedOutletIds: ['outlet-a1'],
    isDemoMode: true,
  };

  assert.equal(checkTenantAccess(dev, 'tenant-b'), true);
  assert.equal(checkTenantAccess(ownerA, 'tenant-a'), true);
  assert.equal(checkTenantAccess(ownerA, 'tenant-b'), false);

  assert.equal(checkOutletAccess(ownerA, 'tenant-a', 'outlet-a2'), true);
  assert.equal(checkOutletAccess(ownerA, 'tenant-b', 'outlet-b1'), false);

  assert.equal(checkOutletAccess(workerA1, 'tenant-a', 'outlet-a1'), true);
  assert.equal(checkOutletAccess(workerA1, 'tenant-a', 'outlet-a2'), false);
  assert.equal(checkOutletAccess(workerA1, 'tenant-b', 'outlet-b1'), false);
});

test('validateTransactionInput rejects invalid amounts, methods, and missing outlets', () => {
  assert.equal(validateTransactionInput({ outletId: '', amount: 100, paymentMethod: 'UPI' }).valid, false);
  assert.equal(validateTransactionInput({ outletId: 'out-1', amount: -50, paymentMethod: 'UPI' }).valid, false);
  assert.equal(validateTransactionInput({ outletId: 'out-1', amount: 0, paymentMethod: 'Cash' }).valid, false);
  assert.equal(validateTransactionInput({ outletId: 'out-1', amount: 500, paymentMethod: 'Crypto' }).valid, false);
  assert.equal(validateTransactionInput({ outletId: 'out-1', amount: 1250, paymentMethod: 'UPI' }).valid, true);
});

test('maskRtspEndpoint redacts embedded RTSP credentials', () => {
  assert.equal(
    maskRtspEndpoint('rtsp://admin:SuperSecret99@192.168.1.45:554/Streaming/Channels/101'),
    'rtsp://***:***@192.168.1.45:554/Streaming/Channels/101'
  );
  assert.equal(
    validateCameraInput({
      cameraName: 'Billing Cam 1',
      outletId: 'out-1',
      sourceType: 'RTSP',
      rtspUrl: 'http://invalid',
    }).valid,
    false
  );
});

test('isPointInPolygon accurately classifies billing zone hits', () => {
  const billingSquare = [
    { x: 100, y: 100 },
    { x: 400, y: 100 },
    { x: 400, y: 400 },
    { x: 100, y: 400 },
  ];
  assert.equal(isPointInPolygon({ x: 250, y: 250 }, billingSquare), true);
  assert.equal(isPointInPolygon({ x: 50, y: 250 }, billingSquare), false);
});

test('aggregateOutletMetrics & generatePeriodReport exclude cancelled transactions from revenue', () => {
  const outlet: Outlet = {
    outletId: 'out-1',
    tenantId: 'ten-1',
    outletName: 'Indiranagar Store',
    address: '100 Ft Rd',
    city: 'Bengaluru',
    timezone: 'Asia/Kolkata',
    closingTime: '22:00',
    status: 'active',
    createdAt: '2026-11-17T04:00:00Z',
    updatedAt: '2026-11-17T04:00:00Z',
  };
  const sessions: VisitSession[] = [
    {
      sessionId: 's-1',
      tenantId: 'ten-1',
      outletId: 'out-1',
      cameraId: 'cam-1',
      temporaryTrackId: 'TRK-001',
      firstSeen: '2026-11-17T05:30:00Z',
      lastSeen: '2026-11-17T05:40:00Z',
      dwellSeconds: 600,
      sessionStatus: 'exited',
      paymentStatus: 'confirmed',
      zoneName: 'Billing Counter',
      createdAt: '2026-11-17T05:30:00Z',
      updatedAt: '2026-11-17T05:40:00Z',
    },
    {
      sessionId: 's-2',
      tenantId: 'ten-1',
      outletId: 'out-1',
      cameraId: 'cam-1',
      temporaryTrackId: 'TRK-002',
      firstSeen: '2026-11-17T06:30:00Z',
      lastSeen: '2026-11-17T06:35:00Z',
      dwellSeconds: 300,
      sessionStatus: 'active',
      paymentStatus: 'pending',
      zoneName: 'Entrance',
      createdAt: '2026-11-17T06:30:00Z',
      updatedAt: '2026-11-17T06:35:00Z',
    },
  ];
  const transactions: Transaction[] = [
    {
      transactionId: 'tx-1',
      tenantId: 'ten-1',
      outletId: 'out-1',
      sessionId: 's-1',
      amount: 1500,
      paymentMethod: 'UPI',
      paymentStatus: 'confirmed',
      confirmedBy: 'w-1',
      confirmedByName: 'Anita',
      createdAt: '2026-11-17T05:39:00Z',
      updatedAt: '2026-11-17T05:39:00Z',
    },
    {
      transactionId: 'tx-2',
      tenantId: 'ten-1',
      outletId: 'out-1',
      amount: 999,
      paymentMethod: 'Cash',
      paymentStatus: 'cancelled',
      confirmedBy: 'w-1',
      confirmedByName: 'Anita',
      createdAt: '2026-11-17T06:00:00Z',
      updatedAt: '2026-11-17T06:05:00Z',
    },
  ];
  const cameras: Camera[] = [
    {
      cameraId: 'cam-1',
      tenantId: 'ten-1',
      outletId: 'out-1',
      cameraName: 'Main Entrance',
      sourceType: 'RTSP',
      maskedEndpoint: 'rtsp://***@10.0.0.5:554/1',
      hasCredentialsStored: true,
      resolution: '1920x1080',
      fps: 15,
      connectionStatus: 'online',
      aiProcessingStatus: 'running',
      lastSeen: '2026-11-17T06:35:00Z',
      zones: [],
      createdAt: '2026-11-17T04:00:00Z',
      updatedAt: '2026-11-17T06:35:00Z',
    },
  ];

  const metrics = aggregateOutletMetrics('out-1', sessions, transactions, cameras);
  assert.equal(metrics.totalVisitors, 2);
  assert.equal(metrics.confirmedTransactions, 1);
  assert.equal(metrics.totalRevenue, 1500);
  assert.equal(metrics.conversionRate, 50);

  const report = generatePeriodReport({
    reportId: 'rep-1',
    tenantId: 'ten-1',
    outlet,
    reportType: 'daily',
    reportDate: '2026-11-17',
    sessions,
    transactions,
    cameras,
  });
  assert.equal(report.totalRevenue, 1500);
  assert.equal(report.timezone, 'Asia/Kolkata');

  const csv = buildReportCsv([report], [outlet]);
  assert.match(csv, /Indiranagar Store/);
  assert.equal(sanitizeCsvCell('=CMD()'), "'=CMD()");
});
