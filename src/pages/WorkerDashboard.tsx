import React, { useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Boxes,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Store,
  Users,
  Video,
} from 'lucide-react';
import type { Transaction, WorkspaceSnapshot } from '../../shared/types/domain';
import { InventoryComingSoon } from '../components/InventoryComingSoon';
import { KpiCard } from '../components/KpiCard';
import { LiveCameraPlayer } from '../components/LiveCameraPlayer';
import { StatusText } from '../components/StatusText';
import { DashboardLayout, type NavItem } from '../layouts/DashboardLayout';
import { apiClient, type AuthSessionHeaders } from '../services/apiClient';
import { formatINR } from '../utils/analytics';

const WORKER_NAV: NavItem[] = [
  { label: 'My Outlet', path: '/worker', icon: Store },
  { label: 'Live Camera', path: '/worker/camera', icon: Video },
  { label: "Today's Visitors", path: '/worker/visitors', icon: Users },
  { label: 'Payment Confirmation', path: '/worker/payment', icon: CreditCard },
  { label: 'Daily Activity', path: '/worker/activity', icon: ClipboardList },
  { label: 'Inventory (Soon)', path: '/worker/inventory', icon: Boxes },
];

interface WorkerDashboardProps {
  workspace: WorkspaceSnapshot;
  session: AuthSessionHeaders;
  onRefresh: () => Promise<void>;
  onSignOut: () => void;
  onSwitchDemoRole: (id: string) => void;
}

export const WorkerDashboard: React.FC<WorkerDashboardProps> = ({
  workspace,
  session,
  onRefresh,
  onSignOut,
  onSwitchDemoRole,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    actor,
    outlets,
    cameras,
    visitSessions,
    transactions,
    modelConfig,
    visionServiceStatus,
  } = workspace;

  const assignedOutlet = outlets[0];
  const [outletId, setOutletId] = useState<string>(assignedOutlet?.outletId || '');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<Transaction['paymentMethod']>('UPI');
  const [transactionRef, setTransactionRef] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const currentOutlet = outlets.find((o) => o.outletId === outletId) || assignedOutlet;
  const outletCameras = cameras.filter((c) => !currentOutlet || c.outletId === currentOutlet.outletId);
  const outletSessions = visitSessions.filter(
    (s) => !currentOutlet || s.outletId === currentOutlet.outletId
  );
  const outletTransactions = transactions.filter(
    (t) => !currentOutlet || t.outletId === currentOutlet.outletId
  );

  const liveVisitorCount = outletSessions.filter(
    (s) => s.sessionStatus === 'active' || s.sessionStatus === 'billing_zone'
  ).length;
  const onlineCamCount = outletCameras.filter((c) => c.connectionStatus === 'online').length;

  const handleConfirmPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setFormError('Enter a valid positive amount in INR.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiClient.confirmTransaction(session, {
        outletId: currentOutlet?.outletId || '',
        sessionId: selectedSessionId || undefined,
        amount: parsedAmount,
        paymentMethod,
        transactionRef: transactionRef.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setAmount('');
      setTransactionRef('');
      setNotes('');
      setSelectedSessionId('');
      setFormSuccess(
        `Confirmed ${formatINR(res.transaction.amount)} (${res.transaction.paymentMethod}) · Ref ${res.transaction.transactionId}`
      );
      await onRefresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Payment confirmation failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setAmount('');
    setSelectedSessionId('');
    setTransactionRef('');
    setNotes('');
    setFormError(null);
    setFormSuccess(null);
  };

  return (
    <DashboardLayout
      actor={actor}
      interfaceTitle={currentOutlet ? `${currentOutlet.outletName} · Worker` : 'Store Worker'}
      navItems={WORKER_NAV}
      onSignOut={onSignOut}
      onSwitchDemoRole={onSwitchDemoRole}
      primaryAction={
        location.pathname === '/worker/payment' ? undefined : (
          <button
            type="button"
            onClick={() => navigate('/worker/payment')}
            className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 whitespace-nowrap shrink-0"
          >
            Record Payment
          </button>
        )
      }
    >
      <div className="pb-16 lg:pb-0">
        <Routes>
          <Route
            index
            element={
              <div className="space-y-6">
                {outlets.length > 1 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <label htmlFor="worker-outlet" className="block text-xs font-medium text-slate-600 mb-1">
                      Assigned Outlet
                    </label>
                    <select
                      id="worker-outlet"
                      value={currentOutlet?.outletId || ''}
                      onChange={(e) => setOutletId(e.target.value)}
                      className="w-full sm:w-80 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      {outlets.map((o) => (
                        <option key={o.outletId} value={o.outletId}>
                          {o.outletName} ({o.city})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <KpiCard
                    label="Assigned Outlet"
                    value={currentOutlet?.outletName || 'None'}
                    subtext={currentOutlet?.city}
                  />
                  <KpiCard
                    label="Current Visitors"
                    value={liveVisitorCount}
                    subtext="Active on store floor"
                  />
                  <KpiCard
                    label="Today's Footfall"
                    value={outletSessions.length}
                    subtext="Temporary sessions"
                  />
                  <KpiCard
                    label="Available Cameras"
                    value={`${onlineCamCount} / ${outletCameras.length}`}
                    tone={onlineCamCount === outletCameras.length ? 'success' : 'warning'}
                    subtext="Assigned outlet only"
                  />
                </div>

                {/* Quick Mobile Actions */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => navigate('/worker/payment')}
                    className="bg-slate-900 text-white rounded-xl p-5 text-left hover:bg-slate-800 transition-colors"
                  >
                    <CreditCard className="w-6 h-6 text-emerald-400 mb-2" />
                    <div className="text-base font-semibold">Record Manual Payment</div>
                    <p className="text-xs text-slate-300 mt-1">
                      Confirm UPI, Cash, or Card receipt and optionally link to an active visitor session.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => navigate('/worker/visitors')}
                    className="bg-white border border-slate-200 rounded-xl p-5 text-left hover:border-blue-500 transition-colors"
                  >
                    <Users className="w-6 h-6 text-blue-600 mb-2" />
                    <div className="text-base font-semibold text-slate-900">
                      View Today&apos;s Visitor Sessions
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      Monitor billing-zone arrivals and anonymous temporary session states.
                    </p>
                  </button>
                </div>

                {/* Assigned Camera Health */}
                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                  <h2 className="text-sm font-semibold text-slate-900">Outlet Camera Status</h2>
                  {outletCameras.map((cam) => (
                    <div
                      key={cam.cameraId}
                      className="flex items-center justify-between border border-slate-200 rounded-lg p-3"
                    >
                      <div>
                        <p className="text-sm font-medium text-slate-900">{cam.cameraName}</p>
                        <p className="text-xs text-slate-500 font-mono">
                          {cam.sourceType} · {cam.resolution} · {cam.fps} FPS
                        </p>
                      </div>
                      <StatusText
                        tone={cam.connectionStatus === 'online' ? 'success' : 'danger'}
                        label={cam.connectionStatus.toUpperCase()}
                      />
                    </div>
                  ))}
                </div>
              </div>
            }
          />

          <Route
            path="camera"
            element={
              <LiveCameraPlayer
                session={session}
                cameras={outletCameras}
                outlets={currentOutlet ? [currentOutlet] : outlets}
                modelConfig={modelConfig}
                visionServiceStatus={visionServiceStatus}
                canEditZones={false}
              />
            }
          />

          <Route
            path="visitors"
            element={
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Today&apos;s Temporary Visitor Sessions ({outletSessions.length})
                  </h2>
                  <span className="text-xs text-slate-500">Anonymous IDs</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Session</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4">First Seen</th>
                        <th className="py-3 px-4">Payment</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {outletSessions.map((s) => (
                        <tr key={s.sessionId} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                            {s.sessionId}
                          </td>
                          <td className="py-3 px-4">
                            <StatusText
                              tone={
                                s.sessionStatus === 'billing_zone'
                                  ? 'warning'
                                  : s.sessionStatus === 'active'
                                    ? 'success'
                                    : 'neutral'
                              }
                              label={
                                s.sessionStatus === 'billing_zone'
                                  ? 'Billing zone'
                                  : s.sessionStatus.charAt(0).toUpperCase() + s.sessionStatus.slice(1)
                              }
                            />
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-600">
                            {new Date(s.firstSeen).toLocaleTimeString('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td className="py-3 px-4">
                            <StatusText
                              tone={s.paymentStatus === 'confirmed' ? 'success' : 'neutral'}
                              label={s.paymentStatus.replace('_', ' ').toUpperCase()}
                            />
                          </td>
                          <td className="py-3 px-4 text-right">
                            {s.paymentStatus !== 'confirmed' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedSessionId(s.sessionId);
                                  navigate('/worker/payment');
                                }}
                                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 whitespace-nowrap"
                              >
                                Link &amp; Pay
                              </button>
                            )}
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
            path="payment"
            element={
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <form
                  onSubmit={handleConfirmPayment}
                  className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
                >
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Manual Payment Confirmation
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Payments are never auto-confirmed by AI cameras. Only authorized worker confirmation updates store revenue.
                    </p>
                  </div>

                  {formError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                      {formError}
                    </div>
                  )}
                  {formSuccess && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>{formSuccess}</span>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="pay-outlet" className="block text-xs font-medium text-slate-700 mb-1">
                        Assigned Outlet
                      </label>
                      <input
                        id="pay-outlet"
                        type="text"
                        readOnly
                        value={currentOutlet?.outletName || ''}
                        className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700"
                      />
                    </div>

                    <div>
                      <label htmlFor="pay-session" className="block text-xs font-medium text-slate-700 mb-1">
                        Visitor Session Reference (Optional)
                      </label>
                      <select
                        id="pay-session"
                        value={selectedSessionId}
                        onChange={(e) => setSelectedSessionId(e.target.value)}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm bg-white"
                      >
                        <option value="">Walk-in / Unlinked Payment</option>
                        {outletSessions.map((s) => (
                          <option key={s.sessionId} value={s.sessionId}>
                            {s.sessionId} ({s.temporaryTrackId} · {s.sessionStatus})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="pay-amount" className="block text-xs font-medium text-slate-700 mb-1">
                      Bill Amount (INR ₹)
                    </label>
                    <input
                      id="pay-amount"
                      type="number"
                      min={1}
                      step="any"
                      required
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="Enter amount e.g. 1250"
                      className="w-full border border-slate-300 rounded-lg px-3 py-3 text-lg font-mono font-semibold text-slate-900"
                    />
                  </div>

                  <div>
                    <span className="block text-xs font-medium text-slate-700 mb-1.5">
                      Payment Type
                    </span>
                    <div className="grid grid-cols-4 gap-2">
                      {(['UPI', 'Cash', 'Card', 'Other'] as const).map((method) => (
                        <button
                          key={method}
                          type="button"
                          onClick={() => setPaymentMethod(method)}
                          className={`py-2.5 text-sm font-semibold rounded-lg border transition-colors ${
                            paymentMethod === method
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {method}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="pay-ref" className="block text-xs font-medium text-slate-700 mb-1">
                        Transaction Reference (Optional)
                      </label>
                      <input
                        id="pay-ref"
                        type="text"
                        value={transactionRef}
                        onChange={(e) => setTransactionRef(e.target.value)}
                        placeholder="e.g. UPI/51209844"
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label htmlFor="pay-emp" className="block text-xs font-medium text-slate-700 mb-1">
                        Confirmed By Employee
                      </label>
                      <input
                        id="pay-emp"
                        type="text"
                        readOnly
                        value={`${actor.displayName} (${actor.userId})`}
                        className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-600"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="pay-notes" className="block text-xs font-medium text-slate-700 mb-1">
                      Notes (Optional)
                    </label>
                    <input
                      id="pay-notes"
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Optional bill note"
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-3 pt-2">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="flex-1 sm:flex-none px-6 py-3 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {submitting ? 'Saving...' : 'Confirm Payment'}
                    </button>
                    <button
                      type="button"
                      onClick={resetForm}
                      className="px-4 py-3 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate('/worker/activity')}
                      className="px-4 py-3 text-sm font-medium text-blue-700 hover:underline"
                    >
                      View Recent Transactions
                    </button>
                  </div>
                </form>

                {/* Live Recent Outlet Confirmations */}
                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Recent Outlet Transactions ({outletTransactions.length})
                  </h3>
                  <div className="space-y-2.5">
                    {outletTransactions.slice(0, 6).map((tx) => (
                      <div
                        key={tx.transactionId}
                        className="border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-xs font-semibold text-slate-900">
                            {tx.transactionId} · {tx.paymentMethod}
                          </div>
                          <div className="text-xs text-slate-500">
                            {tx.sessionId ? `Session ${tx.sessionId}` : 'Walk-in'} ·{' '}
                            {new Date(tx.createdAt).toLocaleTimeString('en-IN')}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-mono text-sm font-semibold text-slate-900 tabular-nums">
                            {formatINR(tx.amount)}
                          </div>
                          <StatusText
                            tone={tx.paymentStatus === 'confirmed' ? 'success' : 'danger'}
                            label={tx.paymentStatus.toUpperCase()}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            }
          />

          <Route
            path="activity"
            element={
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Outlet Daily Payment Activity ({outletTransactions.length})
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">ID</th>
                        <th className="py-3 px-4">Session</th>
                        <th className="py-3 px-4 text-right">Amount</th>
                        <th className="py-3 px-4">Method</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4">Confirmed By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {outletTransactions.map((tx) => (
                        <tr key={tx.transactionId}>
                          <td className="py-3 px-4 font-mono text-xs font-semibold">
                            {tx.transactionId}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-600">
                            {tx.sessionId || 'Unlinked'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums">
                            {formatINR(tx.amount)}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs">{tx.paymentMethod}</td>
                          <td className="py-3 px-4">
                            <StatusText
                              tone={tx.paymentStatus === 'confirmed' ? 'success' : 'danger'}
                              label={tx.paymentStatus.toUpperCase()}
                            />
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">{tx.confirmedByName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            }
          />

          <Route path="inventory" element={<InventoryComingSoon />} />
        </Routes>
      </div>
    </DashboardLayout>
  );
};
