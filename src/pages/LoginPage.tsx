import React, { useState } from 'react';
import { Building2, Shield, Store, UserCheck } from 'lucide-react';
import { signInWithGoogle } from '../firebase';

interface LoginPageProps {
  onEnterDemoRole: (demoUserId: string) => void;
  authError: string | null;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onEnterDemoRole, authError }) => {
  const [loadingGoogle, setLoadingGoogle] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setGoogleError(null);
    setLoadingGoogle(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setGoogleError(
        err instanceof Error ? err.message : 'Google sign-in cancelled or blocked.'
      );
    } finally {
      setLoadingGoogle(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 bg-white border border-slate-200 rounded-2xl overflow-hidden">
        {/* Left Enterprise Context Column */}
        <div className="lg:col-span-5 bg-slate-900 text-slate-100 p-8 flex flex-col justify-between">
          <div>
            <p className="text-xs font-mono text-blue-400 tracking-wide">RETAIL BRAIN OS</p>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-white">
              Multi-Outlet CCTV Intelligence &amp; Store Operations
            </h1>
            <p className="mt-3 text-sm text-slate-300 leading-relaxed">
              Connect existing DVR, NVR, and IP cameras for anonymous YOLOv8 visitor session tracking, manual payment confirmation, and automated closing-time reporting.
            </p>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-800 space-y-2.5 text-xs text-slate-400">
            <div>01. Strictly anonymous ByteTrack session IDs (zero biometric storage)</div>
            <div>02. Strict tenant and outlet-level RBAC enforcement</div>
            <div>03. Outbound edge connector without router port forwarding</div>
          </div>
        </div>

        {/* Right Sign-In & Role Access Column */}
        <div className="lg:col-span-7 p-8 space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Sign in to your workspace</h2>
            <p className="text-sm text-slate-500 mt-1">
              Authenticate via Firebase Google Sign-In or evaluate the platform in Demo Mode.
            </p>
          </div>

          {(authError || googleError) && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
              {authError || googleError}
            </div>
          )}

          <div>
            <button
              type="button"
              disabled={loadingGoogle}
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <span>{loadingGoogle ? 'Connecting to Firebase Auth...' : 'Sign in with Google (Firebase Auth)'}</span>
            </button>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden="true">
              <div className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-white px-3 text-slate-500 font-medium">
                DEMO DATA · Role Access Evaluation
              </span>
            </div>
          </div>

          <div className="space-y-2.5">
            <button
              type="button"
              onClick={() => onEnterDemoRole('usr-dev-admin')}
              className="w-full text-left border border-slate-200 rounded-xl p-3.5 hover:border-blue-500 hover:bg-slate-50 transition-colors flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5 text-blue-600 shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    Developer Console (Super Admin)
                  </div>
                  <div className="text-xs text-slate-500">
                    Global access · Clients, Outlets, Cameras, YOLOv8 Model &amp; System Health
                  </div>
                </div>
              </div>
              <span className="text-xs font-mono text-blue-600 shrink-0">Enter &rarr;</span>
            </button>

            <button
              type="button"
              onClick={() => onEnterDemoRole('usr-owner-bharat')}
              className="w-full text-left border border-slate-200 rounded-xl p-3.5 hover:border-blue-500 hover:bg-slate-50 transition-colors flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3">
                <Building2 className="w-5 h-5 text-emerald-700 shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    Business Owner — Bharat Fresh Mart
                  </div>
                  <div className="text-xs text-slate-500">
                    3 Outlets (Bengaluru) · Analytics, Payments, Reports &amp; Staff
                  </div>
                </div>
              </div>
              <span className="text-xs font-mono text-emerald-700 shrink-0">Enter &rarr;</span>
            </button>

            <button
              type="button"
              onClick={() => onEnterDemoRole('usr-worker-anita')}
              className="w-full text-left border border-slate-200 rounded-xl p-3.5 hover:border-blue-500 hover:bg-slate-50 transition-colors flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3">
                <Store className="w-5 h-5 text-amber-700 shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    Store Worker — Indiranagar Flagship
                  </div>
                  <div className="text-xs text-slate-500">
                    Restricted to 1 outlet · Live Camera, Today&apos;s Visitors &amp; Payment Confirmation
                  </div>
                </div>
              </div>
              <span className="text-xs font-mono text-amber-700 shrink-0">Enter &rarr;</span>
            </button>

            <button
              type="button"
              onClick={() => onEnterDemoRole('usr-owner-vastra')}
              className="w-full text-left border border-slate-200 rounded-xl p-3.5 hover:border-blue-500 hover:bg-slate-50 transition-colors flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3">
                <UserCheck className="w-5 h-5 text-slate-700 shrink-0" />
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    Business Owner — Vastra Luxe Retail (Tenant Isolation Test)
                  </div>
                  <div className="text-xs text-slate-500">
                    1 Outlet (Mumbai) · Isolated from Bharat Fresh Mart records
                  </div>
                </div>
              </div>
              <span className="text-xs font-mono text-slate-700 shrink-0">Enter &rarr;</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
