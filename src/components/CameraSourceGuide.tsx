import React, { useState } from 'react';
import { Activity, Monitor, Plus, RefreshCw, ShieldCheck, Trash2, Video } from 'lucide-react';
import type { Camera, CameraSourceType, Outlet } from '../../shared/types/domain';
import { apiClient, type AuthSessionHeaders } from '../services/apiClient';
import { StatusText } from './StatusText';

interface CameraManagementPanelProps {
  session: AuthSessionHeaders;
  cameras: Camera[];
  outlets: Outlet[];
  isDeveloper: boolean;
  onRefresh: () => Promise<void>;
}

export const CameraManagementPanel: React.FC<CameraManagementPanelProps> = ({
  session,
  cameras,
  outlets,
  isDeveloper,
  onRefresh,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [outletId, setOutletId] = useState(outlets[0]?.outletId || '');
  const [cameraName, setCameraName] = useState('');
  const [sourceType, setSourceType] = useState<CameraSourceType>('RTSP');
  const [rtspUrl, setRtspUrl] = useState('');
  const [resolution, setResolution] = useState('1920x1080');
  const [fps, setFps] = useState(15);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<string | null>(null);

  const outletMap = new Map(outlets.map((o) => [o.outletId, o.outletName]));

  const handleAddCamera = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await apiClient.addCamera(session, {
        outletId: outletId || outlets[0]?.outletId || '',
        cameraName,
        sourceType,
        rtspUrl: sourceType === 'RTSP' ? rtspUrl : undefined,
        resolution,
        fps,
      });
      setCameraName('');
      setRtspUrl('');
      setShowAddForm(false);
      await onRefresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add camera.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTestCamera = async (cameraId: string, simulateRecovery = false) => {
    setTestingId(cameraId);
    setTestFeedback(null);
    try {
      const res = await apiClient.testCameraConnection(session, cameraId, simulateRecovery);
      setTestFeedback(
        `${res.camera.cameraName}: ${res.camera.connectionStatus.toUpperCase()} — ${res.camera.lastHealthCheckMessage || ''}`
      );
      await onRefresh();
    } catch (err) {
      setTestFeedback(err instanceof Error ? err.message : 'Connection test failed.');
    } finally {
      setTestingId(null);
    }
  };

  const handleDeleteCamera = async (cameraId: string) => {
    await apiClient.deleteCamera(session, cameraId);
    await onRefresh();
  };

  return (
    <div className="space-y-6">
      {/* Architecture Guidance: RTSP vs HDMI vs Upload */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              CCTV Integration Methods & Camera Registry
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Credentials are AES-256 encrypted server-side and never sent to browser JavaScript.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            {showAddForm ? 'Close Form' : 'Add Camera Source'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50">
            <div className="flex items-center gap-2 font-semibold text-slate-900 mb-1">
              <ShieldCheck className="w-4 h-4 text-emerald-700" />
              Method 1: RTSP / DVR / NVR (Preferred)
            </div>
            <p className="text-slate-600 leading-relaxed">
              Direct full-resolution stream over local LAN to Python Edge Connector. No router port forwarding needed—edge connector pushes outbound authenticated events.
            </p>
          </div>
          <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50">
            <div className="flex items-center gap-2 font-semibold text-slate-900 mb-1">
              <Monitor className="w-4 h-4 text-amber-700" />
              Method 2: HDMI Monitor Capture
            </div>
            <p className="text-slate-600 leading-relaxed">
              Captures DVR/NVR HDMI/VGA monitor output via USB capture card. Note: Split-screen grid layouts reduce per-camera resolution available to YOLOv8.
            </p>
          </div>
          <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50">
            <div className="flex items-center gap-2 font-semibold text-slate-900 mb-1">
              <Video className="w-4 h-4 text-blue-700" />
              Method 3: Test Video Upload
            </div>
            <p className="text-slate-600 leading-relaxed">
              Temporary MP4/AVI/MOV upload for MVP evaluation without hardware. Automatically purged after 30 minutes; never archived permanently.
            </p>
          </div>
        </div>
      </div>

      {/* Add Camera Form */}
      {showAddForm && (
        <form
          onSubmit={handleAddCamera}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900">Register New Camera Source</h3>
          {formError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
              {formError}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label htmlFor="cam-outlet" className="block text-xs font-medium text-slate-700 mb-1">
                Outlet
              </label>
              <select
                id="cam-outlet"
                value={outletId}
                onChange={(e) => setOutletId(e.target.value)}
                required
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                {outlets.map((o) => (
                  <option key={o.outletId} value={o.outletId}>
                    {o.outletName} ({o.city})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="cam-name" className="block text-xs font-medium text-slate-700 mb-1">
                Camera Name
              </label>
              <input
                id="cam-name"
                type="text"
                required
                value={cameraName}
                onChange={(e) => setCameraName(e.target.value)}
                placeholder="e.g. Entrance Gate Cam 2"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="cam-type" className="block text-xs font-medium text-slate-700 mb-1">
                Connection Type
              </label>
              <select
                id="cam-type"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as CameraSourceType)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="RTSP">RTSP / DVR / NVR (Preferred)</option>
                <option value="HDMI">HDMI Monitor Capture</option>
                <option value="UPLOAD">Test Video Upload</option>
              </select>
            </div>
            {sourceType === 'RTSP' && (
              <div className="sm:col-span-2">
                <label htmlFor="cam-rtsp" className="block text-xs font-medium text-slate-700 mb-1">
                  RTSP Stream URL (stored encrypted on backend only)
                </label>
                <input
                  id="cam-rtsp"
                  type="text"
                  required
                  value={rtspUrl}
                  onChange={(e) => setRtspUrl(e.target.value)}
                  placeholder="rtsp://username:password@192.168.1.50:554/Streaming/Channels/101"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
                />
              </div>
            )}
            <div>
              <label htmlFor="cam-res" className="block text-xs font-medium text-slate-700 mb-1">
                Resolution &amp; Target FPS
              </label>
              <div className="flex gap-2">
                <select
                  id="cam-res"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="flex-1 border border-slate-300 rounded-lg px-2.5 py-2 text-sm bg-white"
                >
                  <option value="1920x1080">1920x1080</option>
                  <option value="1280x720">1280x720</option>
                  <option value="2560x1440">2560x1440</option>
                </select>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value))}
                  aria-label="Target FPS"
                  className="w-20 border border-slate-300 rounded-lg px-2.5 py-2 text-sm font-mono"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save Camera'}
            </button>
          </div>
        </form>
      )}

      {testFeedback && (
        <div className="bg-slate-900 text-slate-100 rounded-lg px-4 py-2.5 text-xs flex items-center justify-between gap-2">
          <span className="font-mono">{testFeedback}</span>
          <button
            type="button"
            onClick={() => setTestFeedback(null)}
            className="text-slate-400 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Camera Inventory Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Camera / ID</th>
                <th className="py-3 px-4">Outlet</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Masked Endpoint</th>
                <th className="py-3 px-4 text-right">Res / FPS</th>
                <th className="py-3 px-4">Health Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {cameras.map((cam) => (
                <tr key={cam.cameraId} className="hover:bg-slate-50">
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900">{cam.cameraName}</div>
                    <div className="text-xs font-mono text-slate-500">{cam.cameraId}</div>
                  </td>
                  <td className="py-3 px-4 text-slate-700">
                    {outletMap.get(cam.outletId) || cam.outletId}
                  </td>
                  <td className="py-3 px-4 font-mono text-xs text-slate-700">{cam.sourceType}</td>
                  <td className="py-3 px-4 font-mono text-xs text-slate-600 max-w-xs truncate">
                    {cam.maskedEndpoint}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-xs text-slate-700 tabular-nums">
                    {cam.resolution} · {cam.fps} FPS
                  </td>
                  <td className="py-3 px-4">
                    <StatusText
                      tone={
                        cam.connectionStatus === 'online'
                          ? 'success'
                          : cam.connectionStatus === 'degraded'
                            ? 'warning'
                            : 'danger'
                      }
                      label={`${cam.connectionStatus.toUpperCase()} (${cam.aiProcessingStatus})`}
                    />
                    {cam.lastHealthCheckMessage && (
                      <p className="text-xs text-slate-500 mt-0.5 max-w-xs truncate">
                        {cam.lastHealthCheckMessage}
                      </p>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={testingId === cam.cameraId}
                        onClick={() => handleTestCamera(cam.cameraId, false)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap"
                      >
                        <Activity className="w-3.5 h-3.5" />
                        {testingId === cam.cameraId ? 'Probing...' : 'Test Stream'}
                      </button>
                      {cam.connectionStatus === 'offline' && cam.isDemoData && (
                        <button
                          type="button"
                          onClick={() => handleTestCamera(cam.cameraId, true)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-700 border border-blue-200 bg-blue-50 rounded-lg hover:bg-blue-100 whitespace-nowrap"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Simulate Recovery
                        </button>
                      )}
                      {isDeveloper && (
                        <button
                          type="button"
                          onClick={() => handleDeleteCamera(cam.cameraId)}
                          aria-label={`Delete ${cam.cameraName}`}
                          className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {cameras.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-500">
                    No cameras registered for this scope yet. Click &ldquo;Add Camera Source&rdquo; to configure RTSP, HDMI, or test uploads.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
