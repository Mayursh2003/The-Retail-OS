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
  const [demoAuthEnabled, setDemoAuthEnabled] = useState(!import.meta.env.PROD);
  const [firebaseSignedIn, setFirebaseSignedIn] = useState(false);
  const [demoUserId, setDemoUserId] = useState<string | null>(() => {
    if (import.meta.env.PROD) return null;
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      return 'usr-owner-bharat';
    }
    return sessionStorage.getItem('rb_demo_user_id');
  });
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const effectiveDemoUserId = demoAuthEnabled ? demoUserId : null;

  const session: AuthSessionHeaders | null = firebaseSignedIn
    ? { isDemoMode: false }
    : effectiveDemoUserId
      ? { isDemoMode: true, demoUserId: effectiveDemoUserId }
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
    void apiClient
      .getAuthConfig()
      .then((cfg) => {
        setDemoAuthEnabled(cfg.demoAuthEnabled);
        if (!cfg.demoAuthEnabled) {
          sessionStorage.removeItem('rb_demo_user_id');
          setDemoUserId(null);
        }
      })
      .catch(() => {});

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
    } else if (effectiveDemoUserId) {
      void loadWorkspace({ isDemoMode: true, demoUserId: effectiveDemoUserId });
    } else {
      setWorkspace(null);
    }
  }, [authReady, firebaseSignedIn, effectiveDemoUserId, loadWorkspace]);

  // Authenticated real-time WebSocket channel (no role/tenant/outlet query params)
  useEffect(() => {
    if (!workspace || !session) return;
    let active = true;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = async () => {
      if (!active) return;
      try {
        if (!session.isDemoMode && auth.currentUser) {
          const token = await auth.currentUser.getIdToken();
          ws.send(JSON.stringify({ type: 'auth', token }));
        } else if (session.isDemoMode && session.demoUserId && demoAuthEnabled) {
          ws.send(JSON.stringify({ type: 'auth', demoUserId: session.demoUserId }));
        }
      } catch {
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string };
        if (
          msg.type === 'transaction:confirmed' ||
          msg.type === 'transaction:updated' ||
          msg.type === 'session:updated' ||
          msg.type === 'camera:status'
        ) {
          void loadWorkspace(session);
        }
      } catch {
        // Ignore malformed socket frames
      }
    };

    return () => {
      active = false;
      ws.close();
    };
  }, [workspace?.actor.userId, firebaseSignedIn, effectiveDemoUserId, demoAuthEnabled, loadWorkspace]);

  const handleEnterDemoRole = (userId: string) => {
    if (!demoAuthEnabled) return;
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
    return (
      <LoginPage
        onEnterDemoRole={handleEnterDemoRole}
        authError={authError}
        demoAuthEnabled={demoAuthEnabled}
      />
    );
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
