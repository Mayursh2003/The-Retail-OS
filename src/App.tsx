import React, { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import type { WorkspaceSnapshot } from '../shared/types/domain';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineIndicator } from './components/OfflineIndicator';
import { auth, signOutFirebase, testFirestoreConnection } from './firebase';
import { DeveloperConsole } from './pages/DeveloperConsole';
import { LoginPage } from './pages/LoginPage';
import { OwnerDashboard } from './pages/OwnerDashboard';
import { WorkerDashboard } from './pages/WorkerDashboard';
import { apiClient, type AuthSessionHeaders } from './services/apiClient';

function defaultRouteForRole(role: WorkspaceSnapshot['actor']['role']): string {
  if (role === 'DEVELOPER') return '/dev';
  if (role === 'CLIENT_OWNER') return '/owner';
  return '/worker';
}

function AppShell() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseSignedIn, setFirebaseSignedIn] = useState(false);
  const [demoUserId, setDemoUserId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      return 'usr-owner-bharat';
    }
    return sessionStorage.getItem('rb_demo_user_id');
  });
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const session: AuthSessionHeaders | null = firebaseSignedIn
    ? { isDemoMode: false }
    : demoUserId
      ? { isDemoMode: true, demoUserId }
      : null;

  const loadWorkspace = useCallback(async (activeSession: AuthSessionHeaders) => {
    setLoadingWorkspace(true);
    setAuthError(null);
    try {
      const data = await apiClient.getWorkspace(activeSession);
      setWorkspace(data);
    } catch (err) {
      setWorkspace(null);
      setAuthError(err instanceof Error ? err.message : 'Failed to load workspace.');
      if (activeSession.isDemoMode) {
        sessionStorage.removeItem('rb_demo_user_id');
        setDemoUserId(null);
      }
    } finally {
      setLoadingWorkspace(false);
    }
  }, []);

  useEffect(() => {
    void testFirestoreConnection();
    const fallbackTimer = window.setTimeout(() => {
      setAuthReady(true);
    }, 1200);
    const unsub = onAuthStateChanged(auth, (user) => {
      window.clearTimeout(fallbackTimer);
      setFirebaseSignedIn(!!user);
      setAuthReady(true);
    });
    return () => {
      window.clearTimeout(fallbackTimer);
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (firebaseSignedIn) {
      void loadWorkspace({ isDemoMode: false });
    } else if (demoUserId) {
      void loadWorkspace({ isDemoMode: true, demoUserId });
    } else {
      setWorkspace(null);
    }
  }, [authReady, firebaseSignedIn, demoUserId, loadWorkspace]);

  // Real-time tenant & outlet-scoped WebSocket updates
  useEffect(() => {
    if (!workspace) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const { actor } = workspace;
    const params = new URLSearchParams({
      role: actor.role,
      tenantId: actor.tenantId,
      outlets: actor.assignedOutletIds.join(','),
    });
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?${params.toString()}`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string };
        if (
          msg.type === 'transaction:confirmed' ||
          msg.type === 'transaction:updated' ||
          msg.type === 'session:updated' ||
          msg.type === 'camera:status'
        ) {
          if (session) {
            void loadWorkspace(session);
          }
        }
      } catch {
        // Ignore malformed socket frames
      }
    };

    return () => {
      ws.close();
    };
  }, [workspace?.actor.userId, workspace?.actor.role, workspace?.actor.tenantId]);

  const handleEnterDemoRole = (userId: string) => {
    sessionStorage.setItem('rb_demo_user_id', userId);
    setDemoUserId(userId);
  };

  const handleSignOut = async () => {
    sessionStorage.removeItem('rb_demo_user_id');
    setDemoUserId(null);
    setWorkspace(null);
    if (firebaseSignedIn) {
      await signOutFirebase();
    }
  };

  if (!authReady || (loadingWorkspace && !workspace)) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 text-sm text-slate-700">
          Initializing Retail Brain OS workspace...
        </div>
      </div>
    );
  }

  if (!workspace || !session) {
    return <LoginPage onEnterDemoRole={handleEnterDemoRole} authError={authError} />;
  }

  const refresh = async () => {
    await loadWorkspace(session);
  };

  const homePath = defaultRouteForRole(workspace.actor.role);

  return (
    <Routes>
      {workspace.actor.role === 'DEVELOPER' && (
        <Route
          path="/dev/*"
          element={
            <DeveloperConsole
              workspace={workspace}
              session={session}
              onRefresh={refresh}
              onSignOut={handleSignOut}
              onSwitchDemoRole={handleEnterDemoRole}
            />
          }
        />
      )}

      {workspace.actor.role === 'CLIENT_OWNER' && (
        <Route
          path="/owner/*"
          element={
            <OwnerDashboard
              workspace={workspace}
              session={session}
              onRefresh={refresh}
              onSignOut={handleSignOut}
              onSwitchDemoRole={handleEnterDemoRole}
            />
          }
        />
      )}

      {workspace.actor.role === 'WORKER' && (
        <Route
          path="/worker/*"
          element={
            <WorkerDashboard
              workspace={workspace}
              session={session}
              onRefresh={refresh}
              onSignOut={handleSignOut}
              onSwitchDemoRole={handleEnterDemoRole}
            />
          }
        />
      )}

      <Route path="*" element={<Navigate to={homePath} replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppShell />
        <OfflineIndicator />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
