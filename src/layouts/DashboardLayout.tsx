import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LogOut, Menu, ShieldAlert, X } from 'lucide-react';
import type { ActorContext } from '../../shared/types/domain';
import { PWAInstallButton } from '../components/PWAInstallButton';

export interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface DashboardLayoutProps {
  actor: ActorContext;
  interfaceTitle: string;
  navItems: NavItem[];
  onSignOut: () => void;
  onSwitchDemoRole?: (demoUserId: string) => void;
  primaryAction?: React.ReactNode;
  children: React.ReactNode;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  actor,
  interfaceTitle,
  navItems,
  onSignOut,
  onSwitchDemoRole,
  primaryAction,
  children,
}) => {
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const activeItem =
    navItems.find((item) => location.pathname === item.path) ||
    navItems.find((item) => location.pathname.startsWith(`${item.path}/`)) ||
    navItems[0];

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Dark Navy Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-slate-900 text-slate-100 border-r border-slate-800">
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="text-base font-bold tracking-tight text-white">Retail Brain OS</div>
          <p className="mt-0.5 text-xs text-slate-400">{interfaceTitle}</p>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label={interfaceTitle}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              location.pathname === item.path ||
              (item.path !== navItems[0].path && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-3">
          {actor.isDemoMode && onSwitchDemoRole && (
            <div>
              <label htmlFor="demo-role-switcher" className="block text-xs text-slate-400 mb-1">
                Demo Role Switcher
              </label>
              <select
                id="demo-role-switcher"
                value={actor.userId}
                onChange={(e) => onSwitchDemoRole(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="usr-dev-admin">Developer (Super Admin)</option>
                <option value="usr-owner-bharat">Owner — Bharat Fresh Mart</option>
                <option value="usr-owner-vastra">Owner — Vastra Luxe Retail</option>
                <option value="usr-worker-anita">Worker — Indiranagar Store</option>
              </select>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate">{actor.displayName}</p>
              <p className="text-xs text-slate-400 truncate">
                {actor.role} · {actor.tenantId}
              </p>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/60"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[85vw] bg-slate-900 text-slate-100 flex flex-col h-full">
            <div className="px-4 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <div className="text-base font-bold text-white">Retail Brain OS</div>
                <p className="text-xs text-slate-400">{interfaceTitle}</p>
              </div>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation menu"
                className="p-2 text-slate-300 hover:text-white rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => setMobileNavOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium ${
                      isActive ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-800 space-y-3">
              {actor.isDemoMode && onSwitchDemoRole && (
                <select
                  aria-label="Switch Demo Role"
                  value={actor.userId}
                  onChange={(e) => {
                    onSwitchDemoRole(e.target.value);
                    setMobileNavOpen(false);
                  }}
                  className="w-full bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-lg px-2.5 py-2"
                >
                  <option value="usr-dev-admin">Developer (Super Admin)</option>
                  <option value="usr-owner-bharat">Owner — Bharat Fresh Mart</option>
                  <option value="usr-owner-vastra">Owner — Vastra Luxe Retail</option>
                  <option value="usr-worker-anita">Worker — Indiranagar Store</option>
                </select>
              )}
              <button
                type="button"
                onClick={onSignOut}
                className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium text-slate-200 bg-slate-800 rounded-lg hover:bg-slate-700"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-500 hidden sm:inline whitespace-nowrap">{interfaceTitle}</span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">/</span>
              <h1 className="font-semibold text-slate-900 truncate">{activeItem?.label}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton />
            {primaryAction}
          </div>
        </header>

        {actor.isDemoMode && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                <strong>DEMO DATA ACTIVE</strong> — Simulated store footfall and camera telemetry shown alongside persistent backend transactions.
              </span>
            </div>
            <span className="font-mono text-amber-800">
              Role: {actor.role} · Tenant: {actor.tenantId}
            </span>
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
};
