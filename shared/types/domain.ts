export type UserRole = 'DEVELOPER' | 'CLIENT_OWNER' | 'WORKER';

export type SubscriptionPlan = 'starter' | 'growth' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'pending';
export type OutletStatus = 'active' | 'inactive';
export type AccountStatus = 'active' | 'disabled' | 'invited';
export type CameraSourceType = 'RTSP' | 'HDMI' | 'UPLOAD';
export type ConnectionStatus = 'online' | 'offline' | 'degraded';
export type AiProcessingStatus = 'running' | 'paused' | 'stopped';
export type ZoneType = 'entrance' | 'billing' | 'product' | 'waiting';
export type VisitSessionStatus = 'active' | 'billing_zone' | 'exited' | 'uncertain';
export type SessionPaymentStatus = 'pending' | 'confirmed' | 'not_linked';
export type DetectionEventType = 'entry' | 'exit' | 'zone_dwell' | 'billing_zone_enter';
export type PaymentMethod = 'UPI' | 'Cash' | 'Card' | 'Other';
export type TransactionStatus = 'confirmed' | 'cancelled' | 'refunded';
export type ReportType = 'daily' | 'weekly' | 'monthly';

export interface ZonePoint {
  x: number; // normalized 0..1000
  y: number; // normalized 0..1000
}

export interface CameraZone {
  id: string;
  name: string;
  type: ZoneType;
  points: ZonePoint[];
}

export interface Tenant {
  tenantId: string;
  businessName: string;
  ownerUserId: string;
  ownerEmail?: string;
  subscriptionPlan: SubscriptionPlan;
  status: TenantStatus;
  createdAt: string;
  updatedAt: string;
  isDemoData?: boolean;
}

export interface Outlet {
  outletId: string;
  tenantId: string;
  outletName: string;
  address: string;
  city: string;
  timezone: string;
  closingTime: string; // HH:mm
  status: OutletStatus;
  createdAt: string;
  updatedAt: string;
  isDemoData?: boolean;
}

export interface UserAccount {
  userId: string;
  role: UserRole;
  tenantId: string;
  assignedOutletIds: string[];
  displayName: string;
  email?: string;
  accountStatus: AccountStatus;
  createdAt: string;
  updatedAt: string;
  isDemoData?: boolean;
}

export interface Invitation {
  invitationId: string;
  email: string;
  displayName: string;
  role: UserRole;
  tenantId: string;
  assignedOutletIds: string[];
  inviteToken: string;
  status: 'pending' | 'accepted' | 'revoked';
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface Camera {
  cameraId: string;
  tenantId: string;
  outletId: string;
  cameraName: string;
  sourceType: CameraSourceType;
  maskedEndpoint: string; // Never contains raw password!
  hasCredentialsStored: boolean;
  resolution: string;
  fps: number;
  connectionStatus: ConnectionStatus;
  aiProcessingStatus: AiProcessingStatus;
  lastSeen: string;
  lastHealthCheckMessage?: string;
  zones: CameraZone[];
  createdAt: string;
  updatedAt: string;
  isDemoData?: boolean;
}

export interface VisitSession {
  sessionId: string;
  tenantId: string;
  outletId: string;
  cameraId: string;
  temporaryTrackId: string; // e.g. TRK-001
  firstSeen: string;
  lastSeen: string;
  dwellSeconds: number;
  sessionStatus: VisitSessionStatus;
  paymentStatus: SessionPaymentStatus;
  zoneName: string;
  isDemoData?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type InferenceState =
  | 'live_yolo'
  | 'processing'
  | 'demo_overlay'
  | 'offline'
  | 'error';

export interface TrackedDetectionSample {
  temporaryTrackId: string;
  bbox: [number, number, number, number]; // normalized 0..1000 [x1, y1, x2, y2]
  confidence: number;
  frameNumber: number;
  timestamp: string;
  cameraId: string;
  outletId: string;
  tenantId: string;
  zoneName?: string;
  latencyMs?: number;
}

export interface DetectionEvent {
  eventId: string;
  tenantId: string;
  outletId: string;
  cameraId: string;
  sessionId: string;
  temporaryTrackId: string;
  eventType: DetectionEventType;
  confidence: number;
  frameNumber: number;
  zoneName: string;
  bbox?: [number, number, number, number];
  latencyMs?: number;
  timestamp: string;
  isDemoData?: boolean;
}

export interface Transaction {
  transactionId: string;
  tenantId: string;
  outletId: string;
  sessionId?: string;
  amount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: TransactionStatus;
  transactionRef?: string;
  confirmedBy: string;
  confirmedByName: string;
  notes?: string;
  isDemoData?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HourlyFootfallBucket {
  hour: string;
  visitors: number;
  billingZone: number;
  confirmedSales: number;
}

export interface Report {
  reportId: string;
  tenantId: string;
  outletId: string;
  reportType: ReportType;
  reportDate: string;
  timezone: string;
  totalVisitors: number;
  billingZoneVisits: number;
  confirmedTransactions: number;
  totalRevenue: number;
  averageBillValue: number;
  conversionRate: number;
  averageDwellSeconds: number;
  peakHour: string;
  cameraDowntimeMinutes: number;
  hourlyFootfall: HourlyFootfallBucket[];
  createdAt: string;
  isDemoData?: boolean;
}

export interface AuditLog {
  logId: string;
  userId: string;
  userEmail?: string;
  tenantId: string;
  action: string;
  resource: string;
  details?: string;
  timestamp: string;
}

export interface ModelConfig {
  modelName: string;
  targetClass: 'person';
  confidenceThreshold: number;
  trackerType: 'ByteTrack';
  deviceType: 'CPU' | 'CUDA_GPU' | 'EDGE_UNAVAILABLE';
  inferenceStatus: 'live_edge' | 'awaiting_edge' | 'demo_video_overlay';
  lastInferenceMs: number;
  measuredFps: number;
  activeTrackCount: number;
}

export interface UploadedVideoInferenceMetrics {
  model: string;
  confidenceThreshold: number;
  device: string;
  framesTotal: number;
  framesProcessed: number;
  uniqueTrackIds: string[];
  totalDetections: number;
  visitorCount: number;
  avgFps: number;
  inferenceMs: number;
  eventsDispatched: number;
  detectionsSample: TrackedDetectionSample[];
}

export interface UploadedTestVideo {
  uploadId: string;
  tenantId: string;
  outletId: string;
  cameraId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  streamUrl: string;
  annotatedStreamUrl?: string;
  uploadedAt: string;
  expiresAt: string;
  visionServiceConfigured: boolean;
  visionServiceConnected: boolean;
  inferenceState: InferenceState;
  inferenceMode: 'live_yolo' | 'python_yolov8_edge' | 'browser_demo_overlay' | 'error';
  errorMessage?: string;
  metrics?: UploadedVideoInferenceMetrics;
}

export interface InventoryItemPreview {
  sku: string;
  name: string;
  category: string;
  openingStock: number;
  received: number;
  sold: number;
  damaged: number;
  currentStock: number;
  lowStockThreshold: number;
}

export interface ActorContext {
  userId: string;
  email?: string;
  displayName: string;
  role: UserRole;
  tenantId: string;
  assignedOutletIds: string[];
  isDemoMode: boolean;
}

export interface SecurityStatusSummary {
  productionMode: boolean;
  demoAuthEnabled: boolean;
  edgeApiKeyConfigured: boolean;
  cameraSecretKeyConfigured: boolean;
  visionServiceConfigured: boolean;
}

export interface WorkspaceSnapshot {
  actor: ActorContext;
  tenants: Tenant[];
  outlets: Outlet[];
  users: UserAccount[];
  invitations: Invitation[];
  cameras: Camera[];
  visitSessions: VisitSession[];
  detectionEvents: DetectionEvent[];
  transactions: Transaction[];
  reports: Report[];
  auditLogs: AuditLog[];
  modelConfig: ModelConfig;
  visionServiceStatus: {
    configured: boolean;
    connected: boolean;
    inferenceState: InferenceState;
    inferenceMode: 'live_yolo' | 'demo_simulation';
    endpoint: string;
    message: string;
    model?: string;
    device?: string;
    lastVerifiedInferenceAt?: string;
  };
  securityStatus?: SecurityStatusSummary;
}
