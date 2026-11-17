import { auth } from '../firebase';
import type {
  Camera,
  CameraZone,
  ModelConfig,
  Outlet,
  Report,
  ReportType,
  Tenant,
  Transaction,
  UploadedTestVideo,
  UserAccount,
  WorkspaceSnapshot,
} from '../../shared/types/domain';

export interface AuthSessionHeaders {
  isDemoMode: boolean;
  demoUserId?: string;
}

async function buildHeaders(session: AuthSessionHeaders, isJson = true): Promise<HeadersInit> {
  const headers: Record<string, string> = {};
  if (isJson) {
    headers['Content-Type'] = 'application/json';
  }
  if (session.isDemoMode && session.demoUserId) {
    headers['x-demo-mode'] = 'true';
    headers['x-demo-user-id'] = session.demoUserId;
  } else if (auth.currentUser) {
    const token = await auth.currentUser.getIdToken();
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function requestJson<T>(
  url: string,
  session: AuthSessionHeaders,
  init: RequestInit = {}
): Promise<T> {
  const isForm = init.body instanceof FormData;
  const headers = await buildHeaders(session, !isForm);
  const resp = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers || {}),
    },
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) {
    throw new Error(data.error || `Request failed with status ${resp.status}`);
  }
  return data;
}

export const apiClient = {
  getAuthConfig: async (): Promise<{ demoAuthEnabled: boolean; productionMode: boolean }> => {
    const resp = await fetch('/api/auth/config');
    if (!resp.ok) {
      return { demoAuthEnabled: !import.meta.env.PROD, productionMode: import.meta.env.PROD };
    }
    return resp.json() as Promise<{ demoAuthEnabled: boolean; productionMode: boolean }>;
  },

  getWorkspace: (session: AuthSessionHeaders) =>
    requestJson<WorkspaceSnapshot>('/api/workspace', session),

  getCameraStreamUrl: (session: AuthSessionHeaders, cameraId: string) =>
    requestJson<{ streamUrl: string; expiresAt: string }>(
      `/api/cameras/${encodeURIComponent(cameraId)}/stream-token`,
      session,
      { method: 'POST' }
    ),

  createTenant: (
    session: AuthSessionHeaders,
    payload: {
      businessName: string;
      ownerEmail: string;
      ownerName: string;
      subscriptionPlan: Tenant['subscriptionPlan'];
    }
  ) =>
    requestJson<{ tenant: Tenant }>('/api/tenants', session, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateTenant: (
    session: AuthSessionHeaders,
    tenantId: string,
    payload: Partial<Pick<Tenant, 'businessName' | 'status' | 'subscriptionPlan'>>
  ) =>
    requestJson<{ tenant: Tenant }>(`/api/tenants/${tenantId}`, session, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  createOutlet: (
    session: AuthSessionHeaders,
    payload: {
      tenantId?: string;
      outletName: string;
      address: string;
      city: string;
      timezone: string;
      closingTime: string;
    }
  ) =>
    requestJson<{ outlet: Outlet }>('/api/outlets', session, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateOutlet: (
    session: AuthSessionHeaders,
    outletId: string,
    payload: Partial<Pick<Outlet, 'outletName' | 'address' | 'city' | 'timezone' | 'closingTime' | 'status'>>
  ) =>
    requestJson<{ outlet: Outlet }>(`/api/outlets/${outletId}`, session, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  inviteUser: (
    session: AuthSessionHeaders,
    payload: {
      email: string;
      displayName: string;
      role?: UserAccount['role'];
      tenantId?: string;
      assignedOutletIds: string[];
    }
  ) =>
    requestJson<{ user: UserAccount; invitation: { inviteToken: string } }>(
      '/api/invitations',
      session,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  updateUserStatus: (
    session: AuthSessionHeaders,
    userId: string,
    payload: Partial<Pick<UserAccount, 'accountStatus' | 'assignedOutletIds'>>
  ) =>
    requestJson<{ user: UserAccount }>(`/api/users/${userId}/status`, session, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  addCamera: (
    session: AuthSessionHeaders,
    payload: {
      outletId: string;
      cameraName: string;
      sourceType: Camera['sourceType'];
      rtspUrl?: string;
      resolution?: string;
      fps?: number;
    }
  ) =>
    requestJson<{ camera: Camera }>('/api/cameras', session, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateCamera: (
    session: AuthSessionHeaders,
    cameraId: string,
    payload: {
      cameraName?: string;
      aiProcessingStatus?: Camera['aiProcessingStatus'];
      zones?: CameraZone[];
      resolution?: string;
      fps?: number;
    }
  ) =>
    requestJson<{ camera: Camera }>(`/api/cameras/${cameraId}`, session, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteCamera: (session: AuthSessionHeaders, cameraId: string) =>
    requestJson<{ ok: boolean }>(`/api/cameras/${cameraId}`, session, {
      method: 'DELETE',
    }),

  testCameraConnection: (
    session: AuthSessionHeaders,
    cameraId: string,
    simulateEdgeRecovery = false
  ) =>
    requestJson<{ camera: Camera; probeResult: { ok: boolean; latencyMs: number; reason?: string } }>(
      `/api/cameras/${cameraId}/test`,
      session,
      {
        method: 'POST',
        body: JSON.stringify({ simulateEdgeRecovery }),
      }
    ),

  confirmTransaction: (
    session: AuthSessionHeaders,
    payload: {
      outletId: string;
      sessionId?: string;
      amount: number;
      paymentMethod: Transaction['paymentMethod'];
      transactionRef?: string;
      notes?: string;
    }
  ) =>
    requestJson<{ transaction: Transaction }>('/api/transactions', session, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateTransactionStatus: (
    session: AuthSessionHeaders,
    transactionId: string,
    payload: { paymentStatus: 'cancelled' | 'refunded'; reason: string }
  ) =>
    requestJson<{ transaction: Transaction }>(
      `/api/transactions/${transactionId}/status`,
      session,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }
    ),

  generateReports: (
    session: AuthSessionHeaders,
    payload: { outletId?: string; reportType: ReportType; reportDate?: string }
  ) =>
    requestJson<{ reports: Report[] }>('/api/reports/generate', session, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  uploadTestVideo: (
    session: AuthSessionHeaders,
    file: File,
    outletId: string,
    cameraId?: string
  ) => {
    const formData = new FormData();
    formData.append('video', file);
    formData.append('outletId', outletId);
    if (cameraId) {
      formData.append('cameraId', cameraId);
    }
    return requestJson<UploadedTestVideo>('/api/vision/upload', session, {
      method: 'POST',
      body: formData,
    });
  },

  updateModelConfig: (
    session: AuthSessionHeaders,
    payload: Partial<Pick<ModelConfig, 'confidenceThreshold' | 'modelName'>>
  ) =>
    requestJson<{ modelConfig: ModelConfig }>('/api/model/config', session, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  resetDemoWorkspace: (session: AuthSessionHeaders) =>
    requestJson<{ ok: boolean }>('/api/demo/reset', session, {
      method: 'POST',
    }),
};

export function downloadCsvFile(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
