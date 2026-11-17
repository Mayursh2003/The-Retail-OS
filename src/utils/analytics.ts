import type {
  ActorContext,
  Camera,
  HourlyFootfallBucket,
  Outlet,
  Report,
  ReportType,
  Transaction,
  VisitSession,
  ZonePoint,
} from '../../shared/types/domain';

export function formatINR(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Math.round(safe));
}

export function calculateConversionRate(confirmedTransactions: number, totalVisitors: number): number {
  if (totalVisitors <= 0 || confirmedTransactions <= 0) return 0;
  const pct = (confirmedTransactions / totalVisitors) * 100;
  return Math.min(100, Math.round(pct * 10) / 10);
}

export function calculateAverageBillValue(totalRevenue: number, confirmedTransactions: number): number {
  if (confirmedTransactions <= 0 || totalRevenue <= 0) return 0;
  return Math.round(totalRevenue / confirmedTransactions);
}

export function checkTenantAccess(actor: ActorContext, targetTenantId: string): boolean {
  if (actor.role === 'DEVELOPER') return true;
  return actor.tenantId === targetTenantId;
}

export function checkOutletAccess(
  actor: ActorContext,
  targetTenantId: string,
  targetOutletId: string
): boolean {
  if (actor.role === 'DEVELOPER') return true;
  if (actor.tenantId !== targetTenantId) return false;
  if (actor.role === 'CLIENT_OWNER') return true;
  return actor.assignedOutletIds.includes(targetOutletId);
}

export interface TransactionValidationResult {
  valid: boolean;
  error?: string;
}

export function validateTransactionInput(input: {
  outletId?: string;
  amount?: unknown;
  paymentMethod?: string;
  transactionRef?: string;
  notes?: string;
}): TransactionValidationResult {
  if (!input.outletId || typeof input.outletId !== 'string' || input.outletId.trim().length < 2) {
    return { valid: false, error: 'Valid outlet assignment is required.' };
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    return { valid: false, error: 'Payment amount must be greater than ₹0 and at most ₹1,00,00,000.' };
  }
  const allowedMethods = ['UPI', 'Cash', 'Card', 'Other'];
  if (!input.paymentMethod || !allowedMethods.includes(input.paymentMethod)) {
    return { valid: false, error: 'Payment method must be UPI, Cash, Card, or Other.' };
  }
  if (input.transactionRef && input.transactionRef.length > 80) {
    return { valid: false, error: 'Transaction reference cannot exceed 80 characters.' };
  }
  if (input.notes && input.notes.length > 280) {
    return { valid: false, error: 'Notes cannot exceed 280 characters.' };
  }
  return { valid: true };
}

export function maskRtspEndpoint(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return 'unconfigured';
  return trimmed.replace(/(rtsp:\/\/)([^:@/]+)(:[^@/]+)?@/i, '$1***:***@');
}

export function validateCameraInput(input: {
  cameraName?: string;
  outletId?: string;
  sourceType?: string;
  rtspUrl?: string;
}): { valid: boolean; error?: string } {
  if (!input.cameraName || input.cameraName.trim().length < 2 || input.cameraName.trim().length > 100) {
    return { valid: false, error: 'Camera name must be 2 to 100 characters.' };
  }
  if (!input.outletId || input.outletId.trim().length < 2) {
    return { valid: false, error: 'Target outlet is required.' };
  }
  if (!input.sourceType || !['RTSP', 'HDMI', 'UPLOAD'].includes(input.sourceType)) {
    return { valid: false, error: 'Source type must be RTSP, HDMI, or UPLOAD.' };
  }
  if (input.sourceType === 'RTSP') {
    if (!input.rtspUrl || !/^rtsp(s)?:\/\/.+/i.test(input.rtspUrl.trim())) {
      return { valid: false, error: 'Valid rtsp:// or rtsps:// stream URL is required for RTSP cameras.' };
    }
  }
  return { valid: true };
}

export function isPointInPolygon(point: ZonePoint, polygon: ZonePoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export interface OutletSummaryMetrics {
  outletId: string;
  totalVisitors: number;
  activeVisitors: number;
  billingZoneVisitors: number;
  confirmedTransactions: number;
  totalRevenue: number;
  averageBillValue: number;
  conversionRate: number;
  averageDwellSeconds: number;
  onlineCameras: number;
  offlineCameras: number;
}

export function aggregateOutletMetrics(
  outletId: string,
  sessions: VisitSession[],
  transactions: Transaction[],
  cameras: Camera[]
): OutletSummaryMetrics {
  const outletSessions = sessions.filter((s) => s.outletId === outletId);
  const confirmedTx = transactions.filter(
    (t) => t.outletId === outletId && t.paymentStatus === 'confirmed'
  );
  const outletCameras = cameras.filter((c) => c.outletId === outletId);

  const totalVisitors = outletSessions.length;
  const activeVisitors = outletSessions.filter(
    (s) => s.sessionStatus === 'active' || s.sessionStatus === 'billing_zone'
  ).length;
  const billingZoneVisitors = outletSessions.filter(
    (s) => s.sessionStatus === 'billing_zone'
  ).length;

  const totalRevenue = confirmedTx.reduce((sum, tx) => sum + tx.amount, 0);
  const confirmedTransactions = confirmedTx.length;
  const averageBillValue = calculateAverageBillValue(totalRevenue, confirmedTransactions);
  const conversionRate = calculateConversionRate(confirmedTransactions, totalVisitors);

  const totalDwell = outletSessions.reduce((sum, s) => sum + (s.dwellSeconds || 0), 0);
  const averageDwellSeconds = totalVisitors > 0 ? Math.round(totalDwell / totalVisitors) : 0;

  const onlineCameras = outletCameras.filter((c) => c.connectionStatus === 'online').length;
  const offlineCameras = outletCameras.filter((c) => c.connectionStatus !== 'online').length;

  return {
    outletId,
    totalVisitors,
    activeVisitors,
    billingZoneVisitors,
    confirmedTransactions,
    totalRevenue,
    averageBillValue,
    conversionRate,
    averageDwellSeconds,
    onlineCameras,
    offlineCameras,
  };
}

export function formatLocalDateKey(isoTimestamp: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(isoTimestamp));
  } catch {
    return isoTimestamp.slice(0, 10);
  }
}

export function formatLocalHourLabel(isoTimestamp: string, timezone: string): string {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Asia/Kolkata',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(isoTimestamp));
    return `${hour.padStart(2, '0')}:00`;
  } catch {
    return '12:00';
  }
}

export function generatePeriodReport(params: {
  reportId: string;
  tenantId: string;
  outlet: Outlet;
  reportType: ReportType;
  reportDate: string;
  sessions: VisitSession[];
  transactions: Transaction[];
  cameras: Camera[];
  nowIso?: string;
}): Report {
  const { reportId, tenantId, outlet, reportType, reportDate, sessions, transactions, cameras } =
    params;
  const metrics = aggregateOutletMetrics(outlet.outletId, sessions, transactions, cameras);
  const outletSessions = sessions.filter((s) => s.outletId === outlet.outletId);
  const confirmedTx = transactions.filter(
    (t) => t.outletId === outlet.outletId && t.paymentStatus === 'confirmed'
  );

  const buckets = new Map<string, HourlyFootfallBucket>();
  for (let h = 9; h <= 22; h++) {
    const label = `${String(h).padStart(2, '0')}:00`;
    buckets.set(label, { hour: label, visitors: 0, billingZone: 0, confirmedSales: 0 });
  }

  for (const s of outletSessions) {
    const label = formatLocalHourLabel(s.firstSeen, outlet.timezone);
    const existing = buckets.get(label) || {
      hour: label,
      visitors: 0,
      billingZone: 0,
      confirmedSales: 0,
    };
    existing.visitors += 1;
    if (s.sessionStatus === 'billing_zone' || s.paymentStatus === 'confirmed') {
      existing.billingZone += 1;
    }
    buckets.set(label, existing);
  }

  for (const tx of confirmedTx) {
    const label = formatLocalHourLabel(tx.createdAt, outlet.timezone);
    const existing = buckets.get(label) || {
      hour: label,
      visitors: 0,
      billingZone: 0,
      confirmedSales: 0,
    };
    existing.confirmedSales += 1;
    buckets.set(label, existing);
  }

  const hourlyFootfall = Array.from(buckets.values()).sort((a, b) =>
    a.hour.localeCompare(b.hour)
  );
  let peakHour = '18:00';
  let maxVisitors = -1;
  for (const b of hourlyFootfall) {
    if (b.visitors > maxVisitors) {
      maxVisitors = b.visitors;
      peakHour = b.hour;
    }
  }

  return {
    reportId,
    tenantId,
    outletId: outlet.outletId,
    reportType,
    reportDate,
    timezone: outlet.timezone,
    totalVisitors: metrics.totalVisitors,
    billingZoneVisits: outletSessions.filter(
      (s) => s.sessionStatus === 'billing_zone' || s.paymentStatus === 'confirmed'
    ).length,
    confirmedTransactions: metrics.confirmedTransactions,
    totalRevenue: metrics.totalRevenue,
    averageBillValue: metrics.averageBillValue,
    conversionRate: metrics.conversionRate,
    averageDwellSeconds: metrics.averageDwellSeconds,
    peakHour,
    cameraDowntimeMinutes: metrics.offlineCameras * 15,
    hourlyFootfall,
    createdAt: params.nowIso || new Date().toISOString(),
    isDemoData: outlet.isDemoData,
  };
}

export function sanitizeCsvCell(value: string | number | undefined | null): string {
  const raw = value === undefined || value === null ? '' : String(value);
  const formulaSafe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(formulaSafe)) {
    return `"${formulaSafe.replace(/"/g, '""')}"`;
  }
  return formulaSafe;
}

export function buildReportCsv(reports: Report[], outlets: Outlet[]): string {
  const outletMap = new Map(outlets.map((o) => [o.outletId, o.outletName]));
  const headers = [
    'Report ID',
    'Outlet',
    'Period Type',
    'Report Date',
    'Timezone',
    'Total Visitors',
    'Billing Zone Visits',
    'Confirmed Transactions',
    'Confirmed Revenue (INR)',
    'Average Bill Value (INR)',
    'Conversion Rate (%)',
    'Avg Dwell (s)',
    'Peak Hour',
    'Camera Downtime (min)',
  ];
  const rows = reports.map((r) =>
    [
      r.reportId,
      outletMap.get(r.outletId) || r.outletId,
      r.reportType,
      r.reportDate,
      r.timezone,
      r.totalVisitors,
      r.billingZoneVisits,
      r.confirmedTransactions,
      r.totalRevenue,
      r.averageBillValue,
      r.conversionRate,
      r.averageDwellSeconds,
      r.peakHour,
      r.cameraDowntimeMinutes,
    ]
      .map(sanitizeCsvCell)
      .join(',')
  );
  return [headers.map(sanitizeCsvCell).join(','), ...rows].join('\n');
}

export function buildTransactionsCsv(transactions: Transaction[], outlets: Outlet[]): string {
  const outletMap = new Map(outlets.map((o) => [o.outletId, o.outletName]));
  const headers = [
    'Transaction ID',
    'Outlet',
    'Session Ref',
    'Amount (INR)',
    'Method',
    'Status',
    'Transaction Ref',
    'Confirmed By',
    'Created At',
    'Demo Data',
  ];
  const rows = transactions.map((tx) =>
    [
      tx.transactionId,
      outletMap.get(tx.outletId) || tx.outletId,
      tx.sessionId || 'Unlinked',
      tx.amount,
      tx.paymentMethod,
      tx.paymentStatus,
      tx.transactionRef || '',
      tx.confirmedByName,
      tx.createdAt,
      tx.isDemoData ? 'YES' : 'NO',
    ]
      .map(sanitizeCsvCell)
      .join(',')
  );
  return [headers.map(sanitizeCsvCell).join(','), ...rows].join('\n');
}
