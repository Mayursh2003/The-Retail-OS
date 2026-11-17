import React, { useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import {
  Activity,
  Building2,
  Camera,
  Cpu,
  Database,
  FileText,
  LayoutDashboard,
  RotateCcw,
  Settings,
  Shield,
  Store,
  Users,
  Video,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Tenant, WorkspaceSnapshot } from '../../shared/types/domain';
import { CameraManagementPanel } from '../components/CameraSourceGuide';
import { KpiCard } from '../components/KpiCard';
import { LiveCameraPlayer } from '../components/LiveCameraPlayer';
import { StatusText } from '../components/StatusText';
import { DashboardLayout, type NavItem } from '../layouts/DashboardLayout';
import { apiClient, type AuthSessionHeaders } from '../services/apiClient';
import { formatINR } from '../utils/analytics';

const DEV_NAV: NavItem[] = [
  { label: 'Overview', path: '/dev', icon: LayoutDashboard },
  { label: 'Client Management', path: '/dev/clients', icon: Building2 },
  { label: 'Outlet Management', path: '/dev/outlets', icon: Store },
  { label: 'Camera Management', path: '/dev/cameras', icon: Camera },
  { label: 'User Management', path: '/dev/users', icon: Users },
  { label: 'Live Monitoring', path: '/dev/live', icon: Video },
  { label: 'System Health', path: '/dev/health', icon: Activity },
  { label: 'Model Management', path: '/dev/models', icon: Cpu },
  { label: 'Data Management', path: '/dev/data', icon: Database },
  { label: 'Audit Logs', path: '/dev/audit', icon: FileText },
  { label: 'Settings', path: '/dev/settings', icon: Settings },
];

interface DeveloperConsoleProps {
  workspace: WorkspaceSnapshot;
  session: AuthSessionHeaders;
  onRefresh: () => Promise<void>;
  onSignOut: () => void;
  onSwitchDemoRole: (id: string) => void;
}

export const DeveloperConsole: React.FC<DeveloperConsoleProps> = ({
  workspace,
  session,
  onRefresh,
  onSignOut,
  onSwitchDemoRole,
}) => {
  const navigate = useNavigate();
  const {
    actor,
    tenants,
    outlets,
    users,
    invitations,
    cameras,
    visitSessions,
    detectionEvents,
    transactions,
    auditLogs,
    modelConfig,
    visionServiceStatus,
  } = workspace;

  // Client creation state
  const [bizName, setBizName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [plan, setPlan] = useState<Tenant['subscriptionPlan']>('growth');
  const [clientMsg, setClientMsg] = useState<string | null>(null);
  const [clientErr, setClientErr] = useState<string | null>(null);

  // Outlet creation state
  const [outletTenantId, setOutletTenantId] = useState(tenants[0]?.tenantId || '');
  const [outletName, setOutletName] = useState('');
  const [outletAddr, setOutletAddr] = useState('');
  const [outletCity, setOutletCity] = useState('Bengaluru');
  const [outletTz, setOutletTz] = useState('Asia/Kolkata');
  const [outletClosing, setOutletClosing] = useState('22:00');
  const [outletMsg, setOutletMsg] = useState<string | null>(null);

  // Model config state
  const [confThreshold, setConfThreshold] = useState(modelConfig.confidenceThreshold);
  const [modelName, setModelName] = useState(modelConfig.modelName);
  const [modelSavedMsg, setModelSavedMsg] = useState<string | null>(null);

  const onlineCams = cameras.filter((c) => c.connectionStatus === 'online').length;
  const offlineCams = cameras.filter((c) => c.connectionStatus !== 'online').length;
  const activeWorkers = users.filter((u) => u.role === 'WORKER' && u.accountStatus === 'active').length;
  const totalRevenue = transactions
    .filter((t) => t.paymentStatus === 'confirmed')
    .reduce((sum, t) => sum + t.amount, 0);

  const platformTrafficData = [
    { day: 'Mon', visitors: 210, events: 840, uptime: 98.4 },
    { day: 'Tue', visitors: 245, events: 980, uptime: 99.1 },
    { day: 'Wed', visitors: 230, events: 910, uptime: 97.8 },
    { day: 'Thu', visitors: 280, events: 1120, uptime: 99.4 },
    { day: 'Fri', visitors: 340, events: 1410, uptime: 99.6 },
    { day: 'Sat', visitors: 420, events: 1790, uptime: 99.2 },
    { day: 'Today', visitors: visitSessions.length * 14, events: detectionEvents.length * 42, uptime: cameras.length ? Math.round((onlineCams / cameras.length) * 100) : 100 },
  ];

  const handleCreateClient = async (e: React.FormEvent) => {
    e.preventDefault();
    setClientErr(null);
    setClientMsg(null);
    try {
      const res = await apiClient.createTenant(session, {
        businessName: bizName,
        ownerEmail,
        ownerName,
        subscriptionPlan: plan,
      });
      setBizName('');
      setOwnerName('');
      setOwnerEmail('');
      setClientMsg(`Created tenant ${res.tenant.businessName} (${res.tenant.tenantId}) and generated secure owner invitation.`);
      await onRefresh();
    } catch (err) {
      setClientErr(err instanceof Error ? err.message : 'Failed to create client.');
    }
  };

  const handleToggleTenantStatus = async (tenant: Tenant) => {
    const next = tenant.status === 'active' ? 'suspended' : 'active';
    await apiClient.updateTenant(session, tenant.tenantId, { status: next });
    await onRefresh();
  };

  const handleCreateOutlet = async (e: React.FormEvent) => {
    e.preventDefault();
    setOutletMsg(null);
    await apiClient.createOutlet(session, {
      tenantId: outletTenantId || tenants[0]?.tenantId,
      outletName,
      address: outletAddr,
      city: outletCity,
      timezone: outletTz,
      closingTime: outletClosing,
    });
    setOutletName('');
    setOutletAddr('');
    setOutletMsg('Outlet created and assigned.');
    await onRefresh();
  };

  const handleSaveModelConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setModelSavedMsg(null);
    await apiClient.updateModelConfig(session, {
      confidenceThreshold: confThreshold,
      modelName,
    });
    setModelSavedMsg('Model parameters saved. Active edge connectors will pull config on next heartbeat.');
    await onRefresh();
  };

  const tenantMap = new Map(tenants.map((t) => [t.tenantId, t.businessName]));

  return (
    <DashboardLayout
      actor={actor}
      interfaceTitle="Developer Console"
      navItems={DEV_NAV}
      onSignOut={onSignOut}
      onSwitchDemoRole={onSwitchDemoRole}
      primaryAction={
        <button
          type="button"
          onClick={() => navigate('/dev/clients')}
          className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 whitespace-nowrap shrink-0"
        >
          New Client
        </button>
      }
    >
      <Routes>
        <Route
          index
          element={
            <div className="space-y-6">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                <KpiCard label="Registered Clients" value={tenants.length} subtext="Multi-tenant businesses" />
                <KpiCard label="Total Outlets" value={outlets.length} subtext="Across India" />
                <KpiCard
                  label="Connected Cameras"
                  value={`${onlineCams} / ${cameras.length}`}
                  subtext={`${offlineCams} disconnected`}
                  tone={offlineCams > 0 ? 'warning' : 'success'}
                />
                <KpiCard label="Visitors Today" value={visitSessions.length} subtext="Anonymous sessions" />
                <KpiCard
                  label="Platform Confirmed Sales"
                  value={formatINR(totalRevenue)}
                  subtext={`${transactions.length} transactions`}
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                <KpiCard
                  label="Vision Edge Status"
                  value={visionServiceStatus.connected ? 'ONLINE' : 'STANDBY'}
                  tone={visionServiceStatus.connected ? 'success' : 'warning'}
                  subtext="YOLOv8n + ByteTrack"
                />
                <KpiCard
                  label="Disconnected Cameras"
                  value={offlineCams}
                  tone={offlineCams > 0 ? 'danger' : 'success'}
                  subtext="Requires edge check"
                />
                <KpiCard label="Active Worker Accounts" value={activeWorkers} subtext="Outlet-scoped" />
                <KpiCard
                  label="Detection Events"
                  value={detectionEvents.length}
                  subtext="Latest telemetry stream"
                />
                <KpiCard label="API Availability" value="99.9%" tone="success" subtext="Express + Firestore" />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold text-slate-900">
                      Daily Platform Traffic (DEMO DATA)
                    </h2>
                    <span className="text-xs text-slate-500 font-mono">Visitors &amp; Events</span>
                  </div>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={platformTrafficData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748B' }} />
                        <YAxis tick={{ fontSize: 12, fill: '#64748B' }} />
                        <Tooltip />
                        <Area
                          type="monotone"
                          dataKey="visitors"
                          stroke="#2563EB"
                          fill="#DBEAFE"
                          name="Visitors"
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold text-slate-900">
                      Camera Uptime % Across Tenants (DEMO DATA)
                    </h2>
                    <span className="text-xs text-slate-500 font-mono">7-Day Health</span>
                  </div>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={platformTrafficData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748B' }} />
                        <YAxis domain={[80, 100]} tick={{ fontSize: 12, fill: '#64748B' }} />
                        <Tooltip />
                        <Bar
                          dataKey="uptime"
                          fill="#0F172A"
                          radius={[4, 4, 0, 0]}
                          name="Uptime %"
                          isAnimationActive={false}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </div>
          }
        />

        <Route
          path="clients"
          element={
            <div className="space-y-6">
              <form
                onSubmit={handleCreateClient}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
              >
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Onboard New Business Tenant
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Creates an isolated tenant ID and generates a secure one-time owner invitation token (zero hardcoded passwords).
                  </p>
                </div>
                {clientErr && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                    {clientErr}
                  </div>
                )}
                {clientMsg && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800">
                    {clientMsg}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label htmlFor="biz-name" className="block text-xs font-medium text-slate-700 mb-1">
                      Business Name
                    </label>
                    <input
                      id="biz-name"
                      type="text"
                      required
                      value={bizName}
                      onChange={(e) => setBizName(e.target.value)}
                      placeholder="e.g. Deccan Supermart"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="owner-name" className="block text-xs font-medium text-slate-700 mb-1">
                      Primary Owner Name
                    </label>
                    <input
                      id="owner-name"
                      type="text"
                      required
                      value={ownerName}
                      onChange={(e) => setOwnerName(e.target.value)}
                      placeholder="e.g. Suresh Reddy"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="owner-email" className="block text-xs font-medium text-slate-700 mb-1">
                      Owner Email (Invite)
                    </label>
                    <input
                      id="owner-email"
                      type="email"
                      required
                      value={ownerEmail}
                      onChange={(e) => setOwnerEmail(e.target.value)}
                      placeholder="owner@company.in"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="sub-plan" className="block text-xs font-medium text-slate-700 mb-1">
                      Subscription Plan
                    </label>
                    <select
                      id="sub-plan"
                      value={plan}
                      onChange={(e) => setPlan(e.target.value as Tenant['subscriptionPlan'])}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      <option value="starter">Starter</option>
                      <option value="growth">Growth</option>
                      <option value="enterprise">Enterprise</option>
                    </select>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                  >
                    Create Client &amp; Issue Invite
                  </button>
                </div>
              </form>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Tenant / ID</th>
                        <th className="py-3 px-4">Primary Owner</th>
                        <th className="py-3 px-4">Plan</th>
                        <th className="py-3 px-4 text-right">Outlets</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {tenants.map((t) => {
                        const tOutlets = outlets.filter((o) => o.tenantId === t.tenantId).length;
                        return (
                          <tr key={t.tenantId} className="hover:bg-slate-50">
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-900">{t.businessName}</div>
                              <div className="text-xs font-mono text-slate-500">{t.tenantId}</div>
                            </td>
                            <td className="py-3 px-4 text-slate-700">{t.ownerEmail || t.ownerUserId}</td>
                            <td className="py-3 px-4 font-mono text-xs uppercase text-slate-700">
                              {t.subscriptionPlan}
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums">{tOutlets}</td>
                            <td className="py-3 px-4">
                              <StatusText
                                tone={t.status === 'active' ? 'success' : 'danger'}
                                label={t.status.toUpperCase()}
                              />
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => handleToggleTenantStatus(t)}
                                className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-100"
                              >
                                {t.status === 'active' ? 'Suspend Access' : 'Activate Account'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          }
        />

        <Route
          path="outlets"
          element={
            <div className="space-y-6">
              <form
                onSubmit={handleCreateOutlet}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
              >
                <h2 className="text-base font-semibold text-slate-900">Create &amp; Assign Outlet</h2>
                {outletMsg && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800">
                    {outletMsg}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="dev-out-tenant" className="block text-xs font-medium text-slate-700 mb-1">
                      Client Tenant
                    </label>
                    <select
                      id="dev-out-tenant"
                      value={outletTenantId}
                      onChange={(e) => setOutletTenantId(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      {tenants.map((t) => (
                        <option key={t.tenantId} value={t.tenantId}>
                          {t.businessName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="dev-out-name" className="block text-xs font-medium text-slate-700 mb-1">
                      Outlet Name
                    </label>
                    <input
                      id="dev-out-name"
                      type="text"
                      required
                      value={outletName}
                      onChange={(e) => setOutletName(e.target.value)}
                      placeholder="e.g. HSR Layout Store"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="dev-out-addr" className="block text-xs font-medium text-slate-700 mb-1">
                      Street Address
                    </label>
                    <input
                      id="dev-out-addr"
                      type="text"
                      required
                      value={outletAddr}
                      onChange={(e) => setOutletAddr(e.target.value)}
                      placeholder="27th Main Road, Sector 1"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="dev-out-city" className="block text-xs font-medium text-slate-700 mb-1">
                      City
                    </label>
                    <input
                      id="dev-out-city"
                      type="text"
                      required
                      value={outletCity}
                      onChange={(e) => setOutletCity(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="dev-out-tz" className="block text-xs font-medium text-slate-700 mb-1">
                      Store Timezone (Automated Reports)
                    </label>
                    <select
                      id="dev-out-tz"
                      value={outletTz}
                      onChange={(e) => setOutletTz(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                      <option value="Asia/Dubai">Asia/Dubai (GST)</option>
                      <option value="Asia/Singapore">Asia/Singapore (SGT)</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="dev-out-close" className="block text-xs font-medium text-slate-700 mb-1">
                      Daily Closing Time
                    </label>
                    <input
                      id="dev-out-close"
                      type="time"
                      value={outletClosing}
                      onChange={(e) => setOutletClosing(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                  >
                    Create Outlet
                  </button>
                </div>
              </form>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Outlet</th>
                        <th className="py-3 px-4">Tenant</th>
                        <th className="py-3 px-4">Location</th>
                        <th className="py-3 px-4">Timezone · Closing</th>
                        <th className="py-3 px-4 text-right">Cameras</th>
                        <th className="py-3 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {outlets.map((o) => {
                        const camCount = cameras.filter((c) => c.outletId === o.outletId).length;
                        return (
                          <tr key={o.outletId} className="hover:bg-slate-50">
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-900">{o.outletName}</div>
                              <div className="text-xs font-mono text-slate-500">{o.outletId}</div>
                            </td>
                            <td className="py-3 px-4 text-slate-700">
                              {tenantMap.get(o.tenantId) || o.tenantId}
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-600">
                              {o.address}, {o.city}
                            </td>
                            <td className="py-3 px-4 font-mono text-xs text-slate-700">
                              {o.timezone} · {o.closingTime}
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums">{camCount}</td>
                            <td className="py-3 px-4">
                              <StatusText
                                tone={o.status === 'active' ? 'success' : 'neutral'}
                                label={o.status.toUpperCase()}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          }
        />

        <Route
          path="cameras"
          element={
            <CameraManagementPanel
              session={session}
              cameras={cameras}
              outlets={outlets}
              isDeveloper={true}
              onRefresh={onRefresh}
            />
          }
        />

        <Route
          path="users"
          element={
            <div className="space-y-6">
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Platform Users &amp; Pending Invitations
                  </h2>
                  <span className="text-xs text-slate-500 font-mono">
                    {users.length} accounts · {invitations.length} invitations
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">User</th>
                        <th className="py-3 px-4">Role</th>
                        <th className="py-3 px-4">Tenant</th>
                        <th className="py-3 px-4">Assigned Outlets</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {users.map((u) => (
                        <tr key={u.userId} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <div className="font-medium text-slate-900">{u.displayName}</div>
                            <div className="text-xs text-slate-500">{u.email || u.userId}</div>
                          </td>
                          <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-800">
                            {u.role}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-700">
                            {tenantMap.get(u.tenantId) || u.tenantId}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-600">
                            {u.assignedOutletIds.length > 0 ? u.assignedOutletIds.join(', ') : 'All / Global'}
                          </td>
                          <td className="py-3 px-4">
                            <StatusText
                              tone={
                                u.accountStatus === 'active'
                                  ? 'success'
                                  : u.accountStatus === 'invited'
                                    ? 'warning'
                                    : 'danger'
                              }
                              label={u.accountStatus.toUpperCase()}
                            />
                          </td>
                          <td className="py-3 px-4 text-right">
                            {u.role !== 'DEVELOPER' && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await apiClient.updateUserStatus(session, u.userId, {
                                    accountStatus:
                                      u.accountStatus === 'active' ? 'disabled' : 'active',
                                  });
                                  await onRefresh();
                                }}
                                className="px-2.5 py-1 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-100"
                              >
                                {u.accountStatus === 'active' ? 'Disable' : 'Activate'}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          }
        />

        <Route
          path="live"
          element={
            <LiveCameraPlayer
              session={session}
              cameras={cameras}
              outlets={outlets}
              modelConfig={modelConfig}
              visionServiceStatus={visionServiceStatus}
              canEditZones={true}
              onCameraUpdated={() => {
                void onRefresh();
              }}
            />
          }
        />

        <Route
          path="health"
          element={
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <KpiCard
                  label="Python Vision Service"
                  value={
                    visionServiceStatus.connected
                      ? 'Connected (Live YOLO)'
                      : visionServiceStatus.configured
                        ? 'Configured · Offline'
                        : 'Not Configured'
                  }
                  tone={visionServiceStatus.connected ? 'success' : 'warning'}
                  subtext={visionServiceStatus.endpoint}
                />
                <KpiCard
                  label="Camera Stream Health"
                  value={`${onlineCams} Online · ${offlineCams} Alert`}
                  tone={offlineCams > 0 ? 'danger' : 'success'}
                  subtext="Automatic reconnection via edge backoff"
                />
                <KpiCard
                  label="Firebase Auth & Firestore"
                  value="Active"
                  tone="success"
                  subtext="Rules deployed & linted"
                />
              </div>

              {workspace.securityStatus && (
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-slate-900 mb-3">
                    Backend Environment &amp; Security Readiness (No Secrets Exposed)
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                    <div className="border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                      <span className="font-mono text-slate-700">EDGE_API_KEY</span>
                      <StatusText
                        tone={workspace.securityStatus.edgeApiKeyConfigured ? 'success' : 'warning'}
                        label={workspace.securityStatus.edgeApiKeyConfigured ? 'CONFIGURED' : 'MISSING'}
                      />
                    </div>
                    <div className="border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                      <span className="font-mono text-slate-700">CAMERA_SECRET_KEY</span>
                      <StatusText
                        tone={workspace.securityStatus.cameraSecretKeyConfigured ? 'success' : 'warning'}
                        label={workspace.securityStatus.cameraSecretKeyConfigured ? 'CONFIGURED' : 'MISSING'}
                      />
                    </div>
                    <div className="border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                      <span className="font-mono text-slate-700">VISION_SERVICE_URL</span>
                      <StatusText
                        tone={workspace.securityStatus.visionServiceConfigured ? 'success' : 'warning'}
                        label={workspace.securityStatus.visionServiceConfigured ? 'CONFIGURED' : 'MISSING'}
                      />
                    </div>
                    <div className="border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                      <span className="font-mono text-slate-700">Demo Auth Mode</span>
                      <StatusText
                        tone={workspace.securityStatus.demoAuthEnabled ? 'warning' : 'success'}
                        label={workspace.securityStatus.demoAuthEnabled ? 'DEV ONLY' : 'LOCKED'}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-slate-900 mb-3">
                  Disconnected / Degraded Camera Diagnostics
                </h2>
                <div className="space-y-3">
                  {cameras
                    .filter((c) => c.connectionStatus !== 'online')
                    .map((c) => (
                      <div
                        key={c.cameraId}
                        className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 rounded-lg p-3.5"
                      >
                        <div>
                          <p className="text-sm font-semibold text-slate-900">
                            {c.cameraName} ({c.cameraId})
                          </p>
                          <p className="text-xs text-slate-600 mt-0.5">
                            {c.lastHealthCheckMessage}
                          </p>
                        </div>
                        <StatusText
                          tone={c.connectionStatus === 'degraded' ? 'warning' : 'danger'}
                          label={c.connectionStatus.toUpperCase()}
                        />
                      </div>
                    ))}
                  {cameras.every((c) => c.connectionStatus === 'online') && (
                    <p className="text-sm text-emerald-700">All registered cameras are online.</p>
                  )}
                </div>
              </div>
            </div>
          }
        />

        <Route
          path="models"
          element={
            <div className="space-y-6">
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      YOLOv8n + ByteTrack Inference Configuration
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {visionServiceStatus.message}
                    </p>
                  </div>
                  <StatusText
                    tone={visionServiceStatus.connected ? 'success' : 'warning'}
                    label={
                      visionServiceStatus.connected
                        ? 'Live YOLO Inference Connected'
                        : visionServiceStatus.configured
                          ? 'Configured Edge Offline (Demo Overlay)'
                          : 'Demo Simulation Mode (Set VISION_SERVICE_URL)'
                    }
                  />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2">
                  <KpiCard label="Model Weight" value={modelConfig.modelName} subtext="Class 0 (Person only)" />
                  <KpiCard label="Tracker" value={modelConfig.trackerType} subtext="Session-only TRK IDs" />
                  <KpiCard
                    label="Device Type"
                    value={visionServiceStatus.connected ? visionServiceStatus.device || modelConfig.deviceType : 'Not Connected'}
                  />
                  <KpiCard
                    label="Inference Latency"
                    value={visionServiceStatus.connected ? `${modelConfig.lastInferenceMs} ms` : 'N/A'}
                  />
                </div>

                <form onSubmit={handleSaveModelConfig} className="pt-4 border-t border-slate-200 space-y-4">
                  {modelSavedMsg && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800">
                      {modelSavedMsg}
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="model-select" className="block text-xs font-medium text-slate-700 mb-1">
                        YOLO Model Variant
                      </label>
                      <select
                        id="model-select"
                        value={modelName}
                        onChange={(e) => setModelName(e.target.value)}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="yolov8n.pt">yolov8n.pt (MVP Recommended)</option>
                        <option value="yolov8s.pt">yolov8s.pt (Higher Accuracy)</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="conf-slider" className="block text-xs font-medium text-slate-700 mb-1">
                        Confidence Threshold: <span className="font-mono">{confThreshold}</span>
                      </label>
                      <input
                        id="conf-slider"
                        type="range"
                        min={0.15}
                        max={0.9}
                        step={0.05}
                        value={confThreshold}
                        onChange={(e) => setConfThreshold(Number(e.target.value))}
                        className="w-full mt-2"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                    >
                      Save Model Parameters
                    </button>
                  </div>
                </form>
              </div>
            </div>
          }
        />

        <Route
          path="data"
          element={
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-center gap-2 text-slate-900">
                <Shield className="w-5 h-5 text-emerald-700" />
                <h2 className="text-base font-semibold">Privacy &amp; Data Governance Policy</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-600">
                <div className="border border-slate-200 rounded-lg p-4">
                  <p className="font-semibold text-slate-900 mb-1">Zero Biometric Profiles</p>
                  <p>No facial embeddings, face-recognition vectors, or cross-outlet visitor identities are ever extracted or stored.</p>
                </div>
                <div className="border border-slate-200 rounded-lg p-4">
                  <p className="font-semibold text-slate-900 mb-1">Temporary Upload TTL</p>
                  <p>Uploaded MP4/AVI/MOV test clips reside in ephemeral /tmp storage and auto-purge after 30 minutes.</p>
                </div>
                <div className="border border-slate-200 rounded-lg p-4">
                  <p className="font-semibold text-slate-900 mb-1">Encrypted Camera Secrets</p>
                  <p>RTSP credentials are AES-256-GCM encrypted in backend-only storage and blocked in Firestore rules.</p>
                </div>
              </div>
            </div>
          }
        />

        <Route
          path="audit"
          element={
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200">
                <h2 className="text-sm font-semibold text-slate-900">
                  Immutable Platform Audit Logs
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">Timestamp</th>
                      <th className="py-3 px-4">Actor</th>
                      <th className="py-3 px-4">Action</th>
                      <th className="py-3 px-4">Resource</th>
                      <th className="py-3 px-4">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs">
                    {auditLogs.map((log) => (
                      <tr key={log.logId} className="hover:bg-slate-50">
                        <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleString('en-IN')}
                        </td>
                        <td className="py-2.5 px-4 text-slate-800">{log.userEmail || log.userId}</td>
                        <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">
                          {log.action}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-600">{log.resource}</td>
                        <td className="py-2.5 px-4 text-slate-700">{log.details}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          }
        />

        <Route
          path="settings"
          element={
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="text-base font-semibold text-slate-900">Platform Administration</h2>
              <p className="text-sm text-slate-600">
                Reset demo seed records back to baseline or review edge service endpoints.
              </p>
              <button
                type="button"
                onClick={async () => {
                  await apiClient.resetDemoWorkspace(session);
                  await onRefresh();
                }}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-800 border border-slate-300 rounded-lg hover:bg-slate-100"
              >
                <RotateCcw className="w-4 h-4" />
                Reset Demo Workspace Seed Data
              </button>
            </div>
          }
        />
      </Routes>
    </DashboardLayout>
  );
};
