import React, { useMemo, useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  Boxes,
  Camera,
  CreditCard,
  Download,
  FileBarChart,
  GitCompare,
  LayoutDashboard,
  Printer,
  Settings,
  Store,
  Users,
  Video,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  Outlet,
  ReportType,
  Transaction,
  WorkspaceSnapshot,
} from '../../shared/types/domain';
import { CameraManagementPanel } from '../components/CameraSourceGuide';
import { InventoryComingSoon } from '../components/InventoryComingSoon';
import { KpiCard } from '../components/KpiCard';
import { LiveCameraPlayer } from '../components/LiveCameraPlayer';
import { StatusText } from '../components/StatusText';
import { DashboardLayout, type NavItem } from '../layouts/DashboardLayout';
import { apiClient, type AuthSessionHeaders, downloadCsvFile } from '../services/apiClient';
import {
  aggregateOutletMetrics,
  buildReportCsv,
  buildTransactionsCsv,
  calculateAverageBillValue,
  calculateConversionRate,
  formatINR,
} from '../utils/analytics';

const OWNER_NAV: NavItem[] = [
  { label: 'Business Overview', path: '/owner', icon: LayoutDashboard },
  { label: 'All Outlets', path: '/owner/outlets', icon: Store },
  { label: 'Live Monitoring', path: '/owner/live', icon: Video },
  { label: 'Visitor Analytics', path: '/owner/visitors', icon: BarChart3 },
  { label: 'Payment Management', path: '/owner/payments', icon: CreditCard },
  { label: 'Sales Reports', path: '/owner/reports', icon: FileBarChart },
  { label: 'Outlet Comparison', path: '/owner/compare', icon: GitCompare },
  { label: 'Camera Management', path: '/owner/cameras', icon: Camera },
  { label: 'Employee Management', path: '/owner/employees', icon: Users },
  { label: 'Inventory (Coming Soon)', path: '/owner/inventory', icon: Boxes },
  { label: 'Settings', path: '/owner/settings', icon: Settings },
];

const METHOD_COLORS: Record<string, string> = {
  UPI: '#2563EB',
  Card: '#0F172A',
  Cash: '#16A34A',
  Other: '#64748B',
};

interface OwnerDashboardProps {
  workspace: WorkspaceSnapshot;
  session: AuthSessionHeaders;
  onRefresh: () => Promise<void>;
  onSignOut: () => void;
  onSwitchDemoRole: (id: string) => void;
}

export const OwnerDashboard: React.FC<OwnerDashboardProps> = ({
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
    cameras,
    visitSessions,
    transactions,
    reports,
    modelConfig,
    visionServiceStatus,
  } = workspace;

  const tenant = tenants[0];
  const [dateFilter, setDateFilter] = useState<'today' | 'yesterday' | '7d' | '30d' | 'custom'>('today');
  const [customStart, setCustomStart] = useState('2026-11-01');
  const [customEnd, setCustomEnd] = useState('2026-11-17');
  const [selectedOutletId, setSelectedOutletId] = useState<string>('all');
  const [visitorCategoryFilter, setVisitorCategoryFilter] = useState<string>('all');

  // Payment search & audit modal
  const [txSearch, setTxSearch] = useState('');
  const [txMethodFilter, setTxMethodFilter] = useState<string>('all');
  const [correctingTx, setCorrectingTx] = useState<Transaction | null>(null);
  const [correctionType, setCorrectionType] = useState<'cancelled' | 'refunded'>('cancelled');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionErr, setCorrectionErr] = useState<string | null>(null);

  // Employee invitation form
  const [empName, setEmpName] = useState('');
  const [empEmail, setEmpEmail] = useState('');
  const [empOutlets, setEmpOutlets] = useState<string[]>(outlets[0] ? [outlets[0].outletId] : []);
  const [empMsg, setEmpMsg] = useState<string | null>(null);
  const [empErr, setEmpErr] = useState<string | null>(null);

  // Report generation
  const [reportPeriod, setReportPeriod] = useState<ReportType>('daily');
  const [reportMsg, setReportMsg] = useState<string | null>(null);

  const outletMap = new Map(outlets.map((o) => [o.outletId, o]));

  const filteredSessions = useMemo(
    () =>
      selectedOutletId === 'all'
        ? visitSessions
        : visitSessions.filter((s) => s.outletId === selectedOutletId),
    [visitSessions, selectedOutletId]
  );

  const filteredTransactions = useMemo(
    () =>
      selectedOutletId === 'all'
        ? transactions
        : transactions.filter((t) => t.outletId === selectedOutletId),
    [transactions, selectedOutletId]
  );

  const confirmedTransactions = useMemo(
    () => filteredTransactions.filter((t) => t.paymentStatus === 'confirmed'),
    [filteredTransactions]
  );

  const totalRevenue = confirmedTransactions.reduce((sum, t) => sum + t.amount, 0);
  const avgBill = calculateAverageBillValue(totalRevenue, confirmedTransactions.length);
  const conversionRate = calculateConversionRate(
    confirmedTransactions.length,
    filteredSessions.length
  );
  const activeOutlets = outlets.filter((o) => o.status === 'active').length;
  const offlineCameras = cameras.filter((c) => c.connectionStatus !== 'online').length;

  // Outlet comparison rows
  const outletSummaries = useMemo(
    () =>
      outlets.map((outlet) => ({
        outlet,
        metrics: aggregateOutletMetrics(outlet.outletId, visitSessions, transactions, cameras),
      })),
    [outlets, visitSessions, transactions, cameras]
  );

  // Payment method breakdown
  const paymentMethodData = useMemo(() => {
    const sums = new Map<string, number>();
    for (const tx of confirmedTransactions) {
      sums.set(tx.paymentMethod, (sums.get(tx.paymentMethod) || 0) + tx.amount);
    }
    return Array.from(sums.entries()).map(([name, value]) => ({ name, value }));
  }, [confirmedTransactions]);

  // Visitor category breakdown
  const visitorCategories = useMemo(() => {
    return {
      active: filteredSessions.filter((s) => s.sessionStatus === 'active').length,
      exited: filteredSessions.filter((s) => s.sessionStatus === 'exited').length,
      billingZone: filteredSessions.filter((s) => s.sessionStatus === 'billing_zone').length,
      paymentPending: filteredSessions.filter((s) => s.paymentStatus === 'pending').length,
      paymentConfirmed: filteredSessions.filter((s) => s.paymentStatus === 'confirmed').length,
      paymentNotLinked: filteredSessions.filter((s) => s.paymentStatus === 'not_linked').length,
      uncertain: filteredSessions.filter((s) => s.sessionStatus === 'uncertain').length,
    };
  }, [filteredSessions]);

  const hourlyChartData = useMemo(() => {
    const latestByOutlet = new Map<string, (typeof reports)[number]>();
    for (const rep of reports) {
      if (selectedOutletId !== 'all' && rep.outletId !== selectedOutletId) continue;
      const prev = latestByOutlet.get(rep.outletId);
      if (!prev || rep.createdAt > prev.createdAt) {
        latestByOutlet.set(rep.outletId, rep);
      }
    }
    const map = new Map<string, { hour: string; visitors: number; confirmedSales: number }>();
    for (const rep of latestByOutlet.values()) {
      for (const b of rep.hourlyFootfall || []) {
        const cur = map.get(b.hour) || { hour: b.hour, visitors: 0, confirmedSales: 0 };
        cur.visitors += b.visitors;
        cur.confirmedSales += b.confirmedSales;
        map.set(b.hour, cur);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.hour.localeCompare(b.hour));
  }, [reports, selectedOutletId]);

  const handleCorrectTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctingTx) return;
    setCorrectionErr(null);
    try {
      await apiClient.updateTransactionStatus(session, correctingTx.transactionId, {
        paymentStatus: correctionType,
        reason: correctionReason,
      });
      setCorrectingTx(null);
      setCorrectionReason('');
      await onRefresh();
    } catch (err) {
      setCorrectionErr(err instanceof Error ? err.message : 'Update failed.');
    }
  };

  const handleInviteWorker = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmpErr(null);
    setEmpMsg(null);
    try {
      const res = await apiClient.inviteUser(session, {
        email: empEmail,
        displayName: empName,
        role: 'WORKER',
        assignedOutletIds: empOutlets,
      });
      setEmpName('');
      setEmpEmail('');
      setEmpMsg(
        `Worker ${res.user.displayName} invited and scoped to ${empOutlets.length} outlet(s).`
      );
      await onRefresh();
    } catch (err) {
      setEmpErr(err instanceof Error ? err.message : 'Invitation failed.');
    }
  };

  const handleGenerateReports = async () => {
    setReportMsg(null);
    const res = await apiClient.generateReports(session, {
      outletId: selectedOutletId === 'all' ? undefined : selectedOutletId,
      reportType: reportPeriod,
    });
    setReportMsg(`Generated ${res.reports.length} ${reportPeriod} report(s) in outlet local timezone.`);
    await onRefresh();
  };

  const displayedPayments = filteredTransactions.filter((t) => {
    if (txMethodFilter !== 'all' && t.paymentMethod !== txMethodFilter) return false;
    if (!txSearch.trim()) return true;
    const q = txSearch.toLowerCase();
    return (
      t.transactionId.toLowerCase().includes(q) ||
      (t.sessionId || '').toLowerCase().includes(q) ||
      (t.transactionRef || '').toLowerCase().includes(q) ||
      t.confirmedByName.toLowerCase().includes(q)
    );
  });

  const displayedVisitors = filteredSessions.filter((s) => {
    if (visitorCategoryFilter === 'all') return true;
    if (visitorCategoryFilter === 'active') return s.sessionStatus === 'active';
    if (visitorCategoryFilter === 'exited') return s.sessionStatus === 'exited';
    if (visitorCategoryFilter === 'billing_zone') return s.sessionStatus === 'billing_zone';
    if (visitorCategoryFilter === 'uncertain') return s.sessionStatus === 'uncertain';
    if (visitorCategoryFilter === 'pending') return s.paymentStatus === 'pending';
    if (visitorCategoryFilter === 'confirmed') return s.paymentStatus === 'confirmed';
    if (visitorCategoryFilter === 'not_linked') return s.paymentStatus === 'not_linked';
    return true;
  });

  return (
    <DashboardLayout
      actor={actor}
      interfaceTitle={tenant ? `${tenant.businessName} · Owner` : 'Business Owner'}
      navItems={OWNER_NAV}
      onSignOut={onSignOut}
      onSwitchDemoRole={onSwitchDemoRole}
      primaryAction={
        <button
          type="button"
          onClick={() => navigate('/owner/reports')}
          className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 whitespace-nowrap shrink-0"
        >
          Export Reports
        </button>
      }
    >
      <Routes>
        <Route
          index
          element={
            <div className="space-y-6">
              {/* Filter Bar */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {[
                    { id: 'today', label: 'Today' },
                    { id: 'yesterday', label: 'Yesterday' },
                    { id: '7d', label: 'Last 7 Days' },
                    { id: '30d', label: 'Last 30 Days' },
                    { id: 'custom', label: 'Custom' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setDateFilter(opt.id as typeof dateFilter)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                        dateFilter === opt.id
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {dateFilter === 'custom' && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <input
                        type="date"
                        value={customStart}
                        onChange={(e) => setCustomStart(e.target.value)}
                        aria-label="Start date"
                        className="border border-slate-300 rounded-lg px-2 py-1"
                      />
                      <span>to</span>
                      <input
                        type="date"
                        value={customEnd}
                        onChange={(e) => setCustomEnd(e.target.value)}
                        aria-label="End date"
                        className="border border-slate-300 rounded-lg px-2 py-1"
                      />
                    </div>
                  )}

                  <select
                    aria-label="Filter by outlet"
                    value={selectedOutletId}
                    onChange={(e) => setSelectedOutletId(e.target.value)}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-medium bg-white"
                  >
                    <option value="all">All Outlets ({outlets.length})</option>
                    {outlets.map((o) => (
                      <option key={o.outletId} value={o.outletId}>
                        {o.outletName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 8 Business KPIs */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <KpiCard
                  label="Total Visitors Today"
                  value={filteredSessions.length}
                  subtext="Anonymous camera sessions"
                />
                <KpiCard
                  label="Visitors This Month"
                  value={filteredSessions.length * 24}
                  subtext="Rolling 30d estimate (DEMO DATA)"
                />
                <KpiCard
                  label="Confirmed Transactions"
                  value={confirmedTransactions.length}
                  subtext="Worker-verified only"
                />
                <KpiCard
                  label="Manually Recorded Revenue"
                  value={formatINR(totalRevenue)}
                  tone="success"
                  subtext="Confirmed receipts"
                />
                <KpiCard
                  label="Average Transaction Value"
                  value={formatINR(avgBill)}
                  subtext="Confirmed bill mean"
                />
                <KpiCard
                  label="Visitor-to-Sale Conversion"
                  value={`${conversionRate}%`}
                  subtext="Confirmed / Total Sessions"
                />
                <KpiCard
                  label="Active Outlets"
                  value={`${activeOutlets} / ${outlets.length}`}
                  subtext="Reporting enabled"
                />
                <KpiCard
                  label="Disconnected Cameras"
                  value={offlineCameras}
                  tone={offlineCameras > 0 ? 'danger' : 'success'}
                  subtext={offlineCameras > 0 ? 'Inspect camera health' : 'All feeds nominal'}
                />
              </div>

              {/* Charts */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-slate-900 mb-4">
                    Hourly Footfall vs Confirmed Sales
                  </h2>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={hourlyChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="hour" tick={{ fontSize: 11, fill: '#64748B' }} />
                        <YAxis tick={{ fontSize: 11, fill: '#64748B' }} />
                        <Tooltip />
                        <Bar dataKey="visitors" fill="#3B82F6" name="Visitors" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                        <Bar
                          dataKey="confirmedSales"
                          fill="#16A34A"
                          name="Confirmed Sales"
                          radius={[3, 3, 0, 0]}
                          isAnimationActive={false}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-slate-900 mb-4">
                    Confirmed Revenue by Outlet
                  </h2>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={outletSummaries.map((s) => ({
                          name: s.outlet.outletName,
                          revenue: s.metrics.totalRevenue,
                        }))}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748B' }} />
                        <YAxis tick={{ fontSize: 11, fill: '#64748B' }} />
                        <Tooltip formatter={(val) => formatINR(Number(val ?? 0))} />
                        <Bar dataKey="revenue" fill="#0F172A" name="Revenue (INR)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </div>
          }
        />

        <Route
          path="outlets"
          element={
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {outletSummaries.map(({ outlet, metrics }) => (
                  <div
                    key={outlet.outletId}
                    className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h2 className="text-base font-semibold text-slate-900">
                            {outlet.outletName}
                          </h2>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {outlet.address}, {outlet.city}
                          </p>
                        </div>
                        <StatusText
                          tone={outlet.status === 'active' ? 'success' : 'neutral'}
                          label={outlet.status.toUpperCase()}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-slate-100 text-xs">
                        <div>
                          <span className="text-slate-500">Live / Today Visitors</span>
                          <p className="font-mono font-semibold text-slate-900 text-sm tabular-nums mt-0.5">
                            {metrics.activeVisitors} live · {metrics.totalVisitors} today
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-500">Confirmed Sales</span>
                          <p className="font-mono font-semibold text-slate-900 text-sm tabular-nums mt-0.5">
                            {metrics.confirmedTransactions} ({metrics.conversionRate}%)
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-500">Confirmed Revenue</span>
                          <p className="font-mono font-semibold text-emerald-700 text-sm tabular-nums mt-0.5">
                            {formatINR(metrics.totalRevenue)}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-500">Camera Health</span>
                          <p className="font-mono font-semibold text-slate-900 text-sm tabular-nums mt-0.5">
                            {metrics.onlineCameras} online · {metrics.offlineCameras} alert
                          </p>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setSelectedOutletId(outlet.outletId);
                        navigate('/owner');
                      }}
                      className="w-full py-2 text-xs font-semibold text-slate-900 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
                    >
                      Open Outlet Dashboard &rarr;
                    </button>
                  </div>
                ))}
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
              detectionEvents={workspace.detectionEvents}
              canEditZones={true}
              onCameraUpdated={() => {
                void onRefresh();
              }}
            />
          }
        />

        <Route
          path="visitors"
          element={
            <div className="space-y-6">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                <KpiCard label="Active Visitors" value={visitorCategories.active} />
                <KpiCard label="Exited Visitors" value={visitorCategories.exited} />
                <KpiCard label="Billing Zone" value={visitorCategories.billingZone} />
                <KpiCard label="Payment Pending" value={visitorCategories.paymentPending} />
                <KpiCard
                  label="Payment Confirmed"
                  value={visitorCategories.paymentConfirmed}
                  tone="success"
                />
                <KpiCard label="Not Linked" value={visitorCategories.paymentNotLinked} />
                <KpiCard
                  label="Uncertain Tracking"
                  value={visitorCategories.uncertain}
                  tone="warning"
                />
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {[
                    { id: 'all', label: 'All Sessions' },
                    { id: 'active', label: 'Active' },
                    { id: 'billing_zone', label: 'Billing Zone' },
                    { id: 'confirmed', label: 'Paid' },
                    { id: 'pending', label: 'Pending' },
                    { id: 'not_linked', label: 'Not Linked' },
                    { id: 'uncertain', label: 'Uncertain' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setVisitorCategoryFilter(tab.id)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                        visitorCategoryFilter === tab.id
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-slate-500">
                  Anonymous session IDs only · Zero cross-outlet biometric tracking
                </span>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Session / Track ID</th>
                        <th className="py-3 px-4">Outlet</th>
                        <th className="py-3 px-4">Zone</th>
                        <th className="py-3 px-4 text-right">Dwell Time</th>
                        <th className="py-3 px-4">Session State</th>
                        <th className="py-3 px-4">Payment State</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {displayedVisitors.map((s) => (
                        <tr key={s.sessionId} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-mono text-xs">
                            <span className="font-semibold text-slate-900">{s.sessionId}</span> ·{' '}
                            <span className="text-slate-500">{s.temporaryTrackId}</span>
                          </td>
                          <td className="py-3 px-4 text-slate-700">
                            {outletMap.get(s.outletId)?.outletName || s.outletId}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-700">{s.zoneName}</td>
                          <td className="py-3 px-4 text-right font-mono text-xs tabular-nums">
                            {Math.floor(s.dwellSeconds / 60)}m {s.dwellSeconds % 60}s
                          </td>
                          <td className="py-3 px-4">
                            <StatusText
                              tone={
                                s.sessionStatus === 'billing_zone'
                                  ? 'warning'
                                  : s.sessionStatus === 'uncertain'
                                    ? 'danger'
                                    : 'neutral'
                              }
                              label={s.sessionStatus.replace('_', ' ').toUpperCase()}
                            />
                          </td>
                          <td className="py-3 px-4">
                            <StatusText
                              tone={s.paymentStatus === 'confirmed' ? 'success' : 'neutral'}
                              label={s.paymentStatus.replace('_', ' ').toUpperCase()}
                            />
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
          path="payments"
          element={
            <div className="space-y-5">
              <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="search"
                    value={txSearch}
                    onChange={(e) => setTxSearch(e.target.value)}
                    placeholder="Search TXN ID, session, or worker..."
                    aria-label="Search transactions"
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-64"
                  />
                  <select
                    aria-label="Filter payment method"
                    value={txMethodFilter}
                    onChange={(e) => setTxMethodFilter(e.target.value)}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white"
                  >
                    <option value="all">All Methods</option>
                    <option value="UPI">UPI</option>
                    <option value="Cash">Cash</option>
                    <option value="Card">Card</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    downloadCsvFile(
                      'retail-brain-transactions.csv',
                      buildTransactionsCsv(displayedPayments, outlets)
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export CSV
                </button>
              </div>

              {correctingTx && (
                <form
                  onSubmit={handleCorrectTransaction}
                  className="bg-white border border-amber-300 rounded-xl p-5 space-y-4"
                >
                  <h3 className="text-sm font-semibold text-slate-900">
                    Audit Correction for {correctingTx.transactionId} ({formatINR(correctingTx.amount)})
                  </h3>
                  {correctionErr && (
                    <p className="text-xs text-red-700 bg-red-50 p-2 rounded">{correctionErr}</p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label htmlFor="corr-type" className="block text-xs font-medium text-slate-700 mb-1">
                        Action
                      </label>
                      <select
                        id="corr-type"
                        value={correctionType}
                        onChange={(e) => setCorrectionType(e.target.value as 'cancelled' | 'refunded')}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="cancelled">Cancel Entry</option>
                        <option value="refunded">Mark Refunded</option>
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="corr-reason" className="block text-xs font-medium text-slate-700 mb-1">
                        Mandatory Audit Reason
                      </label>
                      <input
                        id="corr-reason"
                        type="text"
                        required
                        value={correctionReason}
                        onChange={(e) => setCorrectionReason(e.target.value)}
                        placeholder="e.g. Duplicate UPI notification, customer refunded via cash"
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setCorrectingTx(null)}
                      className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg"
                    >
                      Dismiss
                    </button>
                    <button
                      type="submit"
                      className="px-3.5 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700"
                    >
                      Record Audited Correction
                    </button>
                  </div>
                </form>
              )}

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Transaction ID</th>
                        <th className="py-3 px-4">Outlet</th>
                        <th className="py-3 px-4">Visit Session</th>
                        <th className="py-3 px-4 text-right">Amount</th>
                        <th className="py-3 px-4">Method</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4">Confirmed By</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {displayedPayments.map((tx) => (
                        <tr key={tx.transactionId} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <div className="font-mono text-xs font-semibold text-slate-900">
                              {tx.transactionId}
                            </div>
                            <div className="text-xs text-slate-500 font-mono">
                              {new Date(tx.createdAt).toLocaleString('en-IN')}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-slate-700">
                            {outletMap.get(tx.outletId)?.outletName || tx.outletId}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-600">
                            {tx.sessionId || 'Walk-in (Unlinked)'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-semibold text-slate-900 tabular-nums">
                            {formatINR(tx.amount)}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-700">
                            {tx.paymentMethod}
                          </td>
                          <td className="py-3 px-4">
                            <StatusText
                              tone={tx.paymentStatus === 'confirmed' ? 'success' : 'danger'}
                              label={tx.paymentStatus.toUpperCase()}
                            />
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-700">{tx.confirmedByName}</td>
                          <td className="py-3 px-4 text-right">
                            {tx.paymentStatus === 'confirmed' && (
                              <button
                                type="button"
                                onClick={() => setCorrectingTx(tx)}
                                className="px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 rounded-lg hover:bg-red-50"
                              >
                                Cancel / Refund
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
          path="reports"
          element={
            <div className="space-y-6">
              <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Automated &amp; On-Demand Sales Reports
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Generated in each outlet&apos;s local timezone. Confirmed sales are strictly separated from AI visitor estimates.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Report period type"
                    value={reportPeriod}
                    onChange={(e) => setReportPeriod(e.target.value as ReportType)}
                    className="border border-slate-300 rounded-lg px-3 py-2 text-xs font-medium bg-white"
                  >
                    <option value="daily">Daily Report</option>
                    <option value="weekly">Weekly Report</option>
                    <option value="monthly">Monthly Report</option>
                  </select>
                  <button
                    type="button"
                    onClick={handleGenerateReports}
                    className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                  >
                    Generate Report Now
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadCsvFile(
                        `retail-brain-${reportPeriod}-reports.csv`,
                        buildReportCsv(reports, outlets)
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    Print / Save PDF
                  </button>
                </div>
              </div>

              {reportMsg && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-xs text-emerald-800">
                  {reportMsg}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="bg-white border border-slate-200 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-slate-900 mb-3">
                    Payment Method Breakdown (Confirmed)
                  </h3>
                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={paymentMethodData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={75}
                          isAnimationActive={false}
                          label={({ name, value }) => `${name}: ${formatINR(value)}`}
                        >
                          {paymentMethodData.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={METHOD_COLORS[entry.name] || '#64748B'}
                            />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v) => formatINR(Number(v ?? 0))} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-200">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Generated Store Reports ({reports.length})
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                          <th className="py-3 px-4">Date · Type</th>
                          <th className="py-3 px-4">Outlet (TZ)</th>
                          <th className="py-3 px-4 text-right">Visitors</th>
                          <th className="py-3 px-4 text-right">Confirmed Tx</th>
                          <th className="py-3 px-4 text-right">Revenue</th>
                          <th className="py-3 px-4 text-right">Conv %</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-xs">
                        {reports.map((r) => (
                          <tr key={r.reportId} className="hover:bg-slate-50">
                            <td className="py-2.5 px-4 font-mono">
                              <span className="font-semibold text-slate-900">{r.reportDate}</span> ·{' '}
                              <span className="uppercase text-slate-500">{r.reportType}</span>
                            </td>
                            <td className="py-2.5 px-4 text-slate-700">
                              {outletMap.get(r.outletId)?.outletName || r.outletId} ({r.timezone})
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                              {r.totalVisitors}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                              {r.confirmedTransactions}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono font-semibold text-emerald-700 tabular-nums">
                              {formatINR(r.totalRevenue)}
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                              {r.conversionRate}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          }
        />

        <Route
          path="compare"
          element={
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h2 className="text-base font-semibold text-slate-900">
                  Multi-Outlet Performance Comparison
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">Outlet</th>
                      <th className="py-3 px-4 text-right">Visitors</th>
                      <th className="py-3 px-4 text-right">Avg Dwell</th>
                      <th className="py-3 px-4 text-right">Confirmed Bills</th>
                      <th className="py-3 px-4 text-right">Revenue</th>
                      <th className="py-3 px-4 text-right">Avg Bill</th>
                      <th className="py-3 px-4 text-right">Conversion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-sm">
                    {outletSummaries.map(({ outlet, metrics }) => (
                      <tr key={outlet.outletId} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-semibold text-slate-900">
                          {outlet.outletName}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {metrics.totalVisitors}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {Math.round(metrics.averageDwellSeconds / 60)}m
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {metrics.confirmedTransactions}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-emerald-700 tabular-nums">
                          {formatINR(metrics.totalRevenue)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {formatINR(metrics.averageBillValue)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {metrics.conversionRate}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
              isDeveloper={false}
              onRefresh={onRefresh}
            />
          }
        />

        <Route
          path="employees"
          element={
            <div className="space-y-6">
              <form
                onSubmit={handleInviteWorker}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
              >
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Invite Store Employee (Worker)
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Workers receive access strictly to their assigned outlets and cannot view multi-outlet financials.
                  </p>
                </div>
                {empErr && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                    {empErr}
                  </div>
                )}
                {empMsg && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800">
                    {empMsg}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="emp-name" className="block text-xs font-medium text-slate-700 mb-1">
                      Employee Full Name
                    </label>
                    <input
                      id="emp-name"
                      type="text"
                      required
                      value={empName}
                      onChange={(e) => setEmpName(e.target.value)}
                      placeholder="e.g. Kiran Deshmukh"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="emp-email" className="block text-xs font-medium text-slate-700 mb-1">
                      Work Email
                    </label>
                    <input
                      id="emp-email"
                      type="email"
                      required
                      value={empEmail}
                      onChange={(e) => setEmpEmail(e.target.value)}
                      placeholder="kiran@bharatfresh.in"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <span className="block text-xs font-medium text-slate-700 mb-1">
                      Assigned Outlets
                    </span>
                    <div className="flex flex-wrap gap-2 pt-1">
                      {outlets.map((o) => {
                        const checked = empOutlets.includes(o.outletId);
                        return (
                          <label key={o.outletId} className="inline-flex items-center gap-1.5 text-xs">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setEmpOutlets((prev) =>
                                  prev.includes(o.outletId)
                                    ? prev.filter((x) => x !== o.outletId)
                                    : [...prev, o.outletId]
                                )
                              }
                            />
                            <span>{o.outletName}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                  >
                    Create Worker Invitation
                  </button>
                </div>
              </form>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Employee</th>
                        <th className="py-3 px-4">Role</th>
                        <th className="py-3 px-4">Assigned Outlets</th>
                        <th className="py-3 px-4 text-right">Confirmed Bills</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {users.map((u) => {
                        const count = transactions.filter((t) => t.confirmedBy === u.userId).length;
                        return (
                          <tr key={u.userId} className="hover:bg-slate-50">
                            <td className="py-3 px-4">
                              <div className="font-medium text-slate-900">{u.displayName}</div>
                              <div className="text-xs text-slate-500">{u.email}</div>
                            </td>
                            <td className="py-3 px-4 font-mono text-xs">{u.role}</td>
                            <td className="py-3 px-4 text-xs text-slate-700">
                              {u.assignedOutletIds
                                .map((id) => outletMap.get(id)?.outletName || id)
                                .join(', ') || 'All Tenant Outlets'}
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums">{count}</td>
                            <td className="py-3 px-4">
                              <StatusText
                                tone={u.accountStatus === 'active' ? 'success' : 'danger'}
                                label={u.accountStatus.toUpperCase()}
                              />
                            </td>
                            <td className="py-3 px-4 text-right">
                              {u.role === 'WORKER' && (
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
                                  {u.accountStatus === 'active' ? 'Disable Access' : 'Re-enable'}
                                </button>
                              )}
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

        <Route path="inventory" element={<InventoryComingSoon />} />

        <Route
          path="settings"
          element={
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="text-base font-semibold text-slate-900">
                Outlet Closing Schedules &amp; Timezone Rules
              </h2>
              <div className="space-y-3">
                {outlets.map((o) => (
                  <div
                    key={o.outletId}
                    className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 rounded-lg p-3.5 text-sm"
                  >
                    <div>
                      <p className="font-semibold text-slate-900">{o.outletName}</p>
                      <p className="text-xs text-slate-500">
                        Automated daily report runs at {o.closingTime} ({o.timezone})
                      </p>
                    </div>
                    <input
                      type="time"
                      defaultValue={o.closingTime}
                      aria-label={`Closing time for ${o.outletName}`}
                      onBlur={async (e) => {
                        if (e.target.value && e.target.value !== o.closingTime) {
                          await apiClient.updateOutlet(session, o.outletId, {
                            closingTime: e.target.value,
                          });
                          await onRefresh();
                        }
                      }}
                      className="border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          }
        />
      </Routes>
    </DashboardLayout>
  );
};
