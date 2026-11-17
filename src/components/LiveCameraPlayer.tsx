import React, { useEffect, useRef, useState } from 'react';
import {
  Camera as CameraIcon,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Square,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type {
  Camera,
  CameraZone,
  ModelConfig,
  Outlet,
  UploadedTestVideo,
  ZoneType,
} from '../../shared/types/domain';
import { apiClient, type AuthSessionHeaders } from '../services/apiClient';
import { StatusText } from './StatusText';

interface SimulatedBox {
  trackId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  zoneName: string;
}

interface LiveCameraPlayerProps {
  session: AuthSessionHeaders;
  cameras: Camera[];
  outlets: Outlet[];
  modelConfig: ModelConfig;
  visionServiceStatus: { connected: boolean; endpoint: string; message: string };
  canEditZones: boolean;
  onCameraUpdated?: (camera: Camera) => void;
}

export const LiveCameraPlayer: React.FC<LiveCameraPlayerProps> = ({
  session,
  cameras,
  outlets,
  modelConfig,
  visionServiceStatus,
  canEditZones,
  onCameraUpdated,
}) => {
  const [selectedCameraId, setSelectedCameraId] = useState<string>(cameras[0]?.cameraId || '');
  const [viewMode, setViewMode] = useState<'single' | 'grid'>('single');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackState, setPlaybackState] = useState<'running' | 'paused' | 'stopped'>('running');
  const [uploadedVideo, setUploadedVideo] = useState<UploadedTestVideo | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [zoneDraftName, setZoneDraftName] = useState('New Product Zone');
  const [zoneDraftType, setZoneDraftType] = useState<ZoneType>('product');
  const [savingZone, setSavingZone] = useState(false);
  const [showRawFeed, setShowRawFeed] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedCamera = cameras.find((c) => c.cameraId === selectedCameraId) || cameras[0];
  const outletMap = new Map(outlets.map((o) => [o.outletId, o.outletName]));

  useEffect(() => {
    if (!selectedCamera && cameras.length > 0) {
      setSelectedCameraId(cameras[0].cameraId);
    }
  }, [cameras, selectedCamera]);

  // Deterministic demo bounding boxes shown ONLY when clearly labelled as Demo Overlay (or uploaded video preview without Python service)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (playbackState !== 'running') return;
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % 120);
    }, 500);
    return () => clearInterval(timer);
  }, [playbackState]);

  const demoDetections: SimulatedBox[] =
    playbackState === 'stopped' || showRawFeed
      ? []
      : [
          {
            trackId: 'TRK-004',
            x: 590 + Math.round(Math.sin(tick * 0.12) * 35),
            y: 340,
            w: 110,
            h: 290,
            confidence: 0.91,
            zoneName: 'Billing Counter',
          },
          {
            trackId: 'TRK-005',
            x: 190 + Math.round(Math.cos(tick * 0.1) * 45),
            y: 310,
            w: 105,
            h: 275,
            confidence: 0.87,
            zoneName: 'Entrance',
          },
        ].filter((b) => b.confidence >= modelConfig.confidenceThreshold);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const targetOutletId = selectedCamera?.outletId || outlets[0]?.outletId || '';
      const result = await apiClient.uploadTestVideo(session, file, targetOutletId);
      setUploadedVideo(result);
      setPlaybackState('running');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Video upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handlePlaybackAction = async (next: 'running' | 'paused' | 'stopped') => {
    setPlaybackState(next);
    if (videoRef.current) {
      if (next === 'running') void videoRef.current.play().catch(() => {});
      if (next === 'paused') videoRef.current.pause();
      if (next === 'stopped') {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
    }
    if (selectedCamera && canEditZones) {
      try {
        const res = await apiClient.updateCamera(session, selectedCamera.cameraId, {
          aiProcessingStatus: next,
        });
        onCameraUpdated?.(res.camera);
      } catch {
        // Ignore if worker role views camera without edit rights
      }
    }
  };

  const handleAddPresetZone = async () => {
    if (!selectedCamera || !zoneDraftName.trim()) return;
    setSavingZone(true);
    try {
      const offset = (selectedCamera.zones.length % 4) * 60;
      const newZone: CameraZone = {
        id: `z-${Date.now().toString(36)}`,
        name: zoneDraftName.trim(),
        type: zoneDraftType,
        points: [
          { x: 220 + offset, y: 200 + offset },
          { x: 460 + offset, y: 200 + offset },
          { x: 460 + offset, y: 520 + offset },
          { x: 220 + offset, y: 520 + offset },
        ],
      };
      const res = await apiClient.updateCamera(session, selectedCamera.cameraId, {
        zones: [...selectedCamera.zones, newZone],
      });
      onCameraUpdated?.(res.camera);
      setZoneDraftName('');
    } finally {
      setSavingZone(false);
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      void containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      void document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  return (
    <div className="space-y-4">
      {/* Control Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label htmlFor="camera-selector" className="sr-only">
              Select Camera
            </label>
            <select
              id="camera-selector"
              value={selectedCamera?.cameraId || ''}
              onChange={(e) => setSelectedCameraId(e.target.value)}
              className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-900"
            >
              {cameras.map((cam) => (
                <option key={cam.cameraId} value={cam.cameraId}>
                  {outletMap.get(cam.outletId) || cam.outletId} — {cam.cameraName} ({cam.sourceType})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center bg-slate-100 p-1 rounded-lg">
            <button
              type="button"
              onClick={() => setViewMode('single')}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                viewMode === 'single' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Single Camera
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                viewMode === 'grid' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Multi-Camera Grid ({cameras.length})
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 cursor-pointer whitespace-nowrap">
            <Upload className="w-3.5 h-3.5" />
            <span>{uploading ? 'Uploading...' : 'Upload Test Video (MP4/AVI/MOV)'}</span>
            <input
              type="file"
              accept=".mp4,.avi,.mov,.webm,video/*"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>

          {uploadedVideo && (
            <button
              type="button"
              onClick={() => setUploadedVideo(null)}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-100 whitespace-nowrap"
            >
              Clear Test Video
            </button>
          )}
        </div>
      </div>

      {uploadError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-xs text-red-700">
          {uploadError}
        </div>
      )}

      {/* Honest Inference Source Banner */}
      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          {visionServiceStatus.connected ? (
            <StatusText tone="success" label="Python YOLOv8n + ByteTrack Connected" />
          ) : (
            <StatusText
              tone="warning"
              label={
                uploadedVideo
                  ? 'Uploaded Video Playback · Demo Overlay Mode (Python Edge Offline)'
                  : 'Demo Camera Feed Simulation · Connect Python Edge for Live RTSP Inference'
              }
            />
          )}
        </div>
        <div className="flex items-center gap-4 text-slate-500 font-mono tabular-nums">
          <span>Model: {modelConfig.modelName}</span>
          <span>Conf &ge; {modelConfig.confidenceThreshold}</span>
          <span>Tracker: ByteTrack (Anonymous)</span>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cameras.map((cam) => (
            <div key={cam.cameraId} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">{cam.cameraName}</p>
                  <p className="text-xs text-slate-500 truncate">
                    {outletMap.get(cam.outletId)} · {cam.sourceType} · {cam.resolution}
                  </p>
                </div>
                <StatusText
                  tone={
                    cam.connectionStatus === 'online'
                      ? 'success'
                      : cam.connectionStatus === 'degraded'
                        ? 'warning'
                        : 'danger'
                  }
                  label={cam.connectionStatus.toUpperCase()}
                />
              </div>
              <div className="relative aspect-video bg-slate-950 flex items-center justify-center">
                {cam.connectionStatus === 'offline' ? (
                  <div className="text-center px-4">
                    <WifiOff className="w-7 h-7 text-red-400 mx-auto mb-2" />
                    <p className="text-xs font-medium text-red-300">Camera Stream Offline</p>
                    <p className="text-xs text-slate-400 mt-1">{cam.lastHealthCheckMessage}</p>
                  </div>
                ) : (
                  <div className="w-full h-full relative p-3 flex flex-col justify-between">
                    <div className="flex items-center justify-between text-xs font-mono text-slate-300">
                      <span>DEMO PREVIEW · {cam.cameraId}</span>
                      <span>{cam.fps} FPS</span>
                    </div>
                    <div className="text-center text-xs text-slate-400">
                      Zones configured: {cam.zones.length} · Anonymous ByteTrack Active
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCameraId(cam.cameraId);
                        setViewMode('single');
                      }}
                      className="self-end px-2.5 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
                    >
                      Inspect Camera
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          ref={containerRef}
          className="bg-white border border-slate-200 rounded-xl overflow-hidden"
        >
          {/* Video Viewport Header */}
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <CameraIcon className="w-4 h-4 text-slate-500" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {uploadedVideo
                    ? `Uploaded Test Video: ${uploadedVideo.filename}`
                    : selectedCamera?.cameraName || 'No Camera Selected'}
                </h2>
                <p className="text-xs text-slate-500 font-mono">
                  {uploadedVideo
                    ? `Temporary Buffer (${Math.round(uploadedVideo.sizeBytes / 1024)} KB) · Auto-purges in 30m`
                    : `${selectedCamera?.maskedEndpoint || ''} · ${selectedCamera?.resolution || '1920x1080'}`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRawFeed((v) => !v)}
                className="px-2.5 py-1.5 text-xs font-medium border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                {showRawFeed ? 'Show Annotated Overlay' : 'Show Raw View'}
              </button>
              <button
                type="button"
                onClick={() => handlePlaybackAction('running')}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg ${
                  playbackState === 'running'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <Play className="w-3.5 h-3.5" />
                Start
              </button>
              <button
                type="button"
                onClick={() => handlePlaybackAction('paused')}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg ${
                  playbackState === 'paused'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <Pause className="w-3.5 h-3.5" />
                Pause
              </button>
              <button
                type="button"
                onClick={() => handlePlaybackAction('stopped')}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg ${
                  playbackState === 'stopped'
                    ? 'bg-red-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <Square className="w-3.5 h-3.5" />
                Stop
              </button>
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label="Toggle fullscreen camera view"
                className="p-1.5 border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50"
              >
                {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Main Video / Canvas Surface */}
          <div className="relative aspect-video bg-slate-950 w-full overflow-hidden">
            {uploadedVideo ? (
              <video
                ref={videoRef}
                src={uploadedVideo.streamUrl}
                controls
                autoPlay
                loop
                muted
                playsInline
                className="w-full h-full object-contain bg-black"
              />
            ) : selectedCamera?.connectionStatus === 'offline' ? (
              <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center">
                <WifiOff className="w-10 h-10 text-red-400 mb-3" />
                <p className="text-sm font-semibold text-white">Camera Offline</p>
                <p className="text-xs text-slate-400 mt-1 max-w-md">
                  {selectedCamera.lastHealthCheckMessage ||
                    'Stream failed to respond. Verify local Python edge connector and DVR/NVR network.'}
                </p>
              </div>
            ) : (
              <div className="w-full h-full relative bg-slate-900 flex items-end justify-start p-4">
                <div className="bg-slate-950/85 border border-slate-800 rounded-lg px-3.5 py-2.5 max-w-xl">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>
                      {selectedCamera?.sourceType === 'HDMI'
                        ? 'HDMI Monitor Capture Stream (Simulated Demo Canvas)'
                        : 'RTSP Store Feed (Simulated Demo Canvas)'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Upload an MP4/AVI/MOV clip above to inspect real video frames, or connect the Python YOLOv8n edge service for live DVR/NVR playback.
                  </p>
                </div>
              </div>
            )}

            {/* SVG Zone & Detection Bounding Box Overlay */}
            {!showRawFeed && (
              <svg
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full pointer-events-none"
                data-testid="vision-overlay-svg"
              >
                {(selectedCamera?.zones || []).map((z) => {
                  const pts = z.points.map((p) => `${p.x},${p.y}`).join(' ');
                  const stroke =
                    z.type === 'billing'
                      ? '#3B82F6'
                      : z.type === 'entrance'
                        ? '#10B981'
                        : '#F59E0B';
                  const first = z.points[0] || { x: 40, y: 40 };
                  return (
                    <g key={z.id}>
                      <polygon
                        points={pts}
                        fill={stroke}
                        fillOpacity={0.12}
                        stroke={stroke}
                        strokeWidth={3}
                        strokeDasharray="8 6"
                      />
                      <text
                        x={first.x + 8}
                        y={Math.max(28, first.y - 10)}
                        fill="#F8FAFC"
                        fontSize="22"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {z.name} ({z.type})
                      </text>
                    </g>
                  );
                })}

                {selectedCamera?.connectionStatus !== 'offline' &&
                  demoDetections.map((det) => (
                    <g key={det.trackId}>
                      <rect
                        x={det.x}
                        y={det.y}
                        width={det.w}
                        height={det.h}
                        fill="none"
                        stroke="#3B82F6"
                        strokeWidth={3}
                      />
                      <rect x={det.x} y={Math.max(0, det.y - 34)} width={210} height={32} fill="#1E293B" />
                      <text
                        x={det.x + 8}
                        y={Math.max(22, det.y - 11)}
                        fill="#F8FAFC"
                        fontSize="20"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {det.trackId} · {(det.confidence * 100).toFixed(0)}%
                      </text>
                    </g>
                  ))}
              </svg>
            )}
          </div>

          {/* Live Inference Telemetry Strip */}
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-slate-500">Visitor Detections</span>
              <p className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                {selectedCamera?.connectionStatus === 'offline' ? 0 : demoDetections.length} persons
              </p>
            </div>
            <div>
              <span className="text-slate-500">Stream FPS</span>
              <p className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                {playbackState === 'running' ? `${selectedCamera?.fps || 15} FPS` : '0 FPS'}
              </p>
            </div>
            <div>
              <span className="text-slate-500">Inference Latency</span>
              <p className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                {visionServiceStatus.connected ? `${modelConfig.lastInferenceMs} ms` : 'Demo Overlay'}
              </p>
            </div>
            <div>
              <span className="text-slate-500">Temporary IDs</span>
              <p className="font-mono font-semibold text-slate-900 truncate mt-0.5">
                {demoDetections.map((d) => d.trackId).join(', ') || 'None'}
              </p>
            </div>
          </div>

          {/* Zone Configuration Bar (Developer & Owner Only) */}
          {canEditZones && selectedCamera && (
            <div className="px-4 py-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-slate-700">Zones ({selectedCamera.zones.length}):</span>
                {selectedCamera.zones.map((z) => (
                  <span key={z.id} className="font-mono text-slate-600">
                    {z.name} [{z.type}]
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={zoneDraftName}
                  onChange={(e) => setZoneDraftName(e.target.value)}
                  placeholder="Zone name"
                  aria-label="New zone name"
                  className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs"
                />
                <select
                  value={zoneDraftType}
                  onChange={(e) => setZoneDraftType(e.target.value as ZoneType)}
                  aria-label="New zone type"
                  className="border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white"
                >
                  <option value="entrance">Entrance</option>
                  <option value="billing">Billing Counter</option>
                  <option value="product">Product Section</option>
                  <option value="waiting">Waiting Area</option>
                </select>
                <button
                  type="button"
                  disabled={savingZone || !zoneDraftName.trim()}
                  onClick={handleAddPresetZone}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                >
                  {savingZone ? 'Saving...' : 'Add Zone Polygon'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
