import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera as CameraIcon,
  Loader2,
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
  DetectionEvent,
  InferenceState,
  ModelConfig,
  Outlet,
  UploadedTestVideo,
  WorkspaceSnapshot,
  ZoneType,
} from '../../shared/types/domain';
import { apiClient, type AuthSessionHeaders } from '../services/apiClient';
import { StatusText } from './StatusText';

interface OverlayDetectionBox {
  trackId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  zoneName: string;
  isDemoData: boolean;
}

interface LiveCameraPlayerProps {
  session: AuthSessionHeaders;
  cameras: Camera[];
  outlets: Outlet[];
  modelConfig: ModelConfig;
  visionServiceStatus: WorkspaceSnapshot['visionServiceStatus'];
  detectionEvents?: DetectionEvent[];
  canEditZones: boolean;
  onCameraUpdated?: (camera: Camera) => void;
}

const STATE_DISPLAY: Record<
  InferenceState,
  { badge: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  live_yolo: { badge: 'LIVE YOLO', tone: 'success' },
  processing: { badge: 'VIDEO PROCESSING', tone: 'warning' },
  demo_overlay: { badge: 'DEMO SIMULATION', tone: 'warning' },
  offline: { badge: 'CAMERA OFFLINE', tone: 'danger' },
  error: { badge: 'INFERENCE ERROR', tone: 'danger' },
};

export const LiveCameraPlayer: React.FC<LiveCameraPlayerProps> = ({
  session,
  cameras,
  outlets,
  modelConfig,
  visionServiceStatus,
  detectionEvents = [],
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
  const [liveMjpegUrl, setLiveMjpegUrl] = useState<string | null>(null);
  const [liveMjpegFailed, setLiveMjpegFailed] = useState(false);
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

  useEffect(() => {
    setLiveMjpegUrl(null);
    setLiveMjpegFailed(false);
    if (
      !visionServiceStatus.connected ||
      !selectedCamera ||
      selectedCamera.connectionStatus === 'offline' ||
      uploadedVideo
    ) {
      return;
    }
    let cancelled = false;
    void apiClient
      .getCameraStreamUrl(session, selectedCamera.cameraId)
      .then((res) => {
        if (!cancelled) {
          setLiveMjpegUrl(res.streamUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLiveMjpegFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    visionServiceStatus.connected,
    selectedCamera?.cameraId,
    selectedCamera?.connectionStatus,
    uploadedVideo,
    session,
  ]);

  // Recent real (non-demo) WebSocket detection events for the currently selected camera
  const recentRealEvents = useMemo(() => {
    if (!selectedCamera) return [];
    const cutoff = Date.now() - 12_000;
    const seenTrack = new Set<string>();
    const list: DetectionEvent[] = [];
    for (const evt of detectionEvents) {
      if (evt.isDemoData !== false) continue;
      if (evt.cameraId !== selectedCamera.cameraId) continue;
      if (Date.parse(evt.timestamp) < cutoff) continue;
      if (seenTrack.has(evt.temporaryTrackId)) continue;
      seenTrack.add(evt.temporaryTrackId);
      list.push(evt);
    }
    return list;
  }, [detectionEvents, selectedCamera]);

  const liveMjpegActive = Boolean(
    !uploadedVideo &&
      selectedCamera?.connectionStatus !== 'offline' &&
      visionServiceStatus.connected &&
      liveMjpegUrl &&
      !liveMjpegFailed
  );

  // Determine exact inference state (never fake LIVE YOLO from /health alone)
  const uiState: InferenceState = useMemo(() => {
    if (uploading) return 'processing';
    if (uploadError || uploadedVideo?.inferenceState === 'error') return 'error';
    if (uploadedVideo) {
      return uploadedVideo.inferenceState === 'live_yolo' ? 'live_yolo' : 'demo_overlay';
    }
    if (selectedCamera?.connectionStatus === 'offline') return 'offline';
    if (liveMjpegActive || recentRealEvents.length > 0) return 'live_yolo';
    return 'demo_overlay';
  }, [
    uploading,
    uploadError,
    uploadedVideo,
    selectedCamera?.connectionStatus,
    liveMjpegActive,
    recentRealEvents.length,
  ]);

  // Demo animation tick runs ONLY when strictly in DEMO SIMULATION mode
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (uiState !== 'demo_overlay' || playbackState !== 'running') return;
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % 120);
    }, 500);
    return () => clearInterval(timer);
  }, [uiState, playbackState]);

  const activeDetections: OverlayDetectionBox[] = useMemo(() => {
    if (playbackState === 'stopped' || showRawFeed) return [];

    // When real Python annotated video plays, boxes are baked into annotated MP4 (do not overlay fake boxes)
    if (uploadedVideo?.inferenceState === 'live_yolo') {
      return [];
    }

    // Real WebSocket detection boxes when live inference is active
    if (uiState === 'live_yolo') {
      return recentRealEvents
        .filter((e) => Array.isArray(e.bbox) && e.bbox.length === 4)
        .map((e) => {
          const [x1, y1, x2, y2] = e.bbox!;
          return {
            trackId: e.temporaryTrackId,
            x: x1,
            y: y1,
            w: Math.max(20, x2 - x1),
            h: Math.max(40, y2 - y1),
            confidence: e.confidence,
            zoneName: e.zoneName,
            isDemoData: false,
          };
        });
    }

    // Synthetic demo boxes ONLY in explicit DEMO SIMULATION mode
    if (uiState === 'demo_overlay') {
      return [
        {
          trackId: 'DEMO-TRK-004',
          x: 590 + Math.round(Math.sin(tick * 0.12) * 35),
          y: 340,
          w: 110,
          h: 290,
          confidence: 0.91,
          zoneName: 'Billing Counter',
          isDemoData: true,
        },
        {
          trackId: 'DEMO-TRK-005',
          x: 190 + Math.round(Math.cos(tick * 0.1) * 45),
          y: 310,
          w: 105,
          h: 275,
          confidence: 0.87,
          zoneName: 'Entrance',
          isDemoData: true,
        },
      ].filter((b) => b.confidence >= modelConfig.confidenceThreshold);
    }

    return [];
  }, [
    playbackState,
    showRawFeed,
    uploadedVideo,
    uiState,
    recentRealEvents,
    tick,
    modelConfig.confidenceThreshold,
  ]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    setUploadedVideo(null);
    try {
      const targetOutletId = selectedCamera?.outletId || outlets[0]?.outletId || '';
      const targetCameraId =
        selectedCamera && selectedCamera.outletId === targetOutletId
          ? selectedCamera.cameraId
          : 'upload-test';
      const result = await apiClient.uploadTestVideo(
        session,
        file,
        targetOutletId,
        targetCameraId
      );
      setUploadedVideo(result);
      setShowRawFeed(false);
      setPlaybackState('running');
      if (result.inferenceState === 'error' && result.errorMessage) {
        setUploadError(result.errorMessage);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Video upload failed.');
    } finally {
      setUploading(false);
      e.target.value = '';
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

  const uploadMetrics = uploadedVideo?.metrics;
  const activeTrackIdsDisplay = uploadMetrics
    ? uploadMetrics.uniqueTrackIds.join(', ') || 'None'
    : uiState === 'live_yolo'
      ? recentRealEvents.map((e) => e.temporaryTrackId).join(', ') || 'Streaming MJPEG'
      : uiState === 'demo_overlay'
        ? activeDetections.map((d) => d.trackId).join(', ') || 'None'
        : 'None';

  const visitorCountDisplay = uploadMetrics
    ? uploadMetrics.visitorCount
    : uiState === 'live_yolo'
      ? recentRealEvents.length
      : uiState === 'demo_overlay'
        ? activeDetections.length
        : 0;

  const fpsDisplay = uploadMetrics
    ? `${uploadMetrics.avgFps} FPS`
    : uiState === 'live_yolo'
      ? `${modelConfig.measuredFps || selectedCamera?.fps || 0} FPS`
      : uiState === 'demo_overlay' && playbackState === 'running'
        ? `${selectedCamera?.fps || 15} FPS (DEMO)`
        : '0 FPS';

  const latencyDisplay = uploadMetrics
    ? `${uploadMetrics.inferenceMs} ms`
    : uiState === 'live_yolo'
      ? `${recentRealEvents[0]?.latencyMs ?? modelConfig.lastInferenceMs ?? 0} ms`
      : uiState === 'demo_overlay'
        ? 'Demo Overlay'
        : uiState === 'processing'
          ? 'Processing...'
          : 'N/A';

  const activeVideoSrc =
    uploadedVideo && (showRawFeed ? uploadedVideo.streamUrl : uploadedVideo.annotatedStreamUrl || uploadedVideo.streamUrl);

  const stateMeta = STATE_DISPLAY[uiState];

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
            {uploading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5" />
            )}
            <span>{uploading ? 'Running YOLOv8n...' : 'Upload Test Video (MP4/AVI/MOV)'}</span>
            <input
              type="file"
              accept=".mp4,.avi,.mov,.webm,video/*"
              onChange={handleFileUpload}
              disabled={uploading}
              className="hidden"
            />
          </label>

          {uploadedVideo && (
            <button
              type="button"
              onClick={() => {
                setUploadedVideo(null);
                setUploadError(null);
              }}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-100 whitespace-nowrap"
            >
              Clear Test Video
            </button>
          )}
        </div>
      </div>

      {uploadError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{uploadError}</span>
        </div>
      )}

      {/* Honest Inference Source Banner */}
      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <StatusText
            tone={stateMeta.tone}
            label={
              uiState === 'live_yolo' && uploadMetrics
                ? `LIVE YOLO · Annotated MP4 & Metrics (${uploadMetrics.device})`
                : uiState === 'live_yolo'
                  ? `LIVE YOLO · Active Stream (${visionServiceStatus.device || 'Edge'})`
                  : uiState === 'processing'
                    ? 'VIDEO PROCESSING · Running YOLOv8n + ByteTrack'
                    : uiState === 'error'
                      ? 'INFERENCE ERROR · Python Vision Inference Failed'
                      : uiState === 'offline'
                        ? 'CAMERA OFFLINE · Stream Disconnected'
                        : uploadedVideo
                          ? 'DEMO SIMULATION · Uploaded Video Preview Only (Set VISION_SERVICE_URL for YOLO)'
                          : visionServiceStatus.connected
                            ? 'DEMO SIMULATION · Edge Standby (Upload Video or Open Live Stream)'
                            : visionServiceStatus.configured
                              ? 'DEMO SIMULATION · VISION_SERVICE_URL Unreachable'
                              : 'DEMO SIMULATION · VISION_SERVICE_URL Not Configured'
            }
          />
        </div>
        <div className="flex items-center gap-4 text-slate-500 font-mono tabular-nums">
          <span>State: {stateMeta.badge}</span>
          <span>Model: {uploadMetrics?.model || visionServiceStatus.model || modelConfig.modelName}</span>
          <span>Conf &ge; {uploadMetrics?.confidenceThreshold ?? modelConfig.confidenceThreshold}</span>
          <span>Tracker: ByteTrack</span>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cameras.map((cam) => {
            const camRealEvents = detectionEvents.filter(
              (e) => e.isDemoData === false && e.cameraId === cam.cameraId
            );
            const hasRealEdge = visionServiceStatus.connected && cam.connectionStatus === 'online';
            return (
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
                      cam.connectionStatus === 'offline'
                        ? 'danger'
                        : hasRealEdge && camRealEvents.length > 0
                          ? 'success'
                          : 'warning'
                    }
                    label={
                      cam.connectionStatus === 'offline'
                        ? 'CAMERA OFFLINE'
                        : hasRealEdge
                          ? 'EDGE CONNECTED'
                          : 'DEMO SIMULATION'
                    }
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
                        <span>
                          {hasRealEdge ? `EDGE READY · ${cam.cameraId}` : `SIMULATED PREVIEW (DEMO DATA) · ${cam.cameraId}`}
                        </span>
                        <span>{hasRealEdge ? `${cam.fps} FPS` : 'DEMO'}</span>
                      </div>
                      <div className="text-center text-xs text-slate-400">
                        {hasRealEdge
                          ? `Zones: ${cam.zones.length} · Recent real events: ${camRealEvents.length}`
                          : `Zones configured: ${cam.zones.length} · No live edge stream connected`}
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
            );
          })}
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
                    ? `${
                        uploadedVideo.annotatedStreamUrl
                          ? 'YOLOv8n + ByteTrack Annotated MP4'
                          : 'Temporary Raw Video Buffer'
                      } (${Math.round(uploadedVideo.sizeBytes / 1024)} KB) · Auto-purges after retention`
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
                {showRawFeed ? 'Show Annotated Output' : 'Show Raw View'}
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
            {uploading ? (
              <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center">
                <Loader2 className="w-9 h-9 text-blue-400 animate-spin mb-3" />
                <p className="text-sm font-semibold text-white">Processing Video via YOLOv8n + ByteTrack</p>
                <p className="text-xs text-slate-400 mt-1 max-w-md">
                  Extracting frames with OpenCV, detecting persons (COCO class 0), generating temporary TRK IDs, and encoding annotated MP4 playback.
                </p>
              </div>
            ) : uploadedVideo && activeVideoSrc ? (
              <video
                key={activeVideoSrc}
                ref={videoRef}
                src={activeVideoSrc}
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
            ) : liveMjpegActive ? (
              <img
                src={liveMjpegUrl!}
                alt={`Live YOLOv8 MJPEG stream for ${selectedCamera?.cameraName || 'camera'}`}
                onError={() => setLiveMjpegFailed(true)}
                className="w-full h-full object-contain bg-black"
              />
            ) : (
              <div className="w-full h-full relative bg-slate-900 flex items-end justify-start p-4">
                <div className="bg-slate-950/85 border border-slate-800 rounded-lg px-3.5 py-2.5 max-w-xl">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <Wifi className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>
                      {selectedCamera?.sourceType === 'HDMI'
                        ? 'HDMI Monitor Capture (DEMO SIMULATION · Not Live Camera)'
                        : 'RTSP Store Feed (DEMO SIMULATION · Not Live Camera)'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    {visionServiceStatus.message}
                  </p>
                </div>
              </div>
            )}

            {/* SVG Zone & Detection Overlay: never render synthetic boxes over real YOLO annotated video */}
            {!showRawFeed && !uploading && uploadedVideo?.inferenceState !== 'live_yolo' && (
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
                  activeDetections.map((det) => (
                    <g key={det.trackId}>
                      <rect
                        x={det.x}
                        y={det.y}
                        width={det.w}
                        height={det.h}
                        fill="none"
                        stroke={det.isDemoData ? '#F59E0B' : '#10B981'}
                        strokeWidth={3}
                      />
                      <rect
                        x={det.x}
                        y={Math.max(0, det.y - 34)}
                        width={250}
                        height={32}
                        fill={det.isDemoData ? '#78350F' : '#064E3B'}
                      />
                      <text
                        x={det.x + 8}
                        y={Math.max(22, det.y - 11)}
                        fill="#F8FAFC"
                        fontSize="19"
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
              <span className="text-slate-500">
                {uiState === 'demo_overlay' ? 'Visitor Detections (DEMO DATA)' : 'Visitor Detections'}
              </span>
              <p className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                {visitorCountDisplay} persons
              </p>
            </div>
            <div>
              <span className="text-slate-500">Measured FPS</span>
              <p className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                {fpsDisplay}
              </p>
            </div>
            <div>
              <span className="text-slate-500">Inference Latency</span>
              <p className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                {latencyDisplay}
              </p>
            </div>
            <div>
              <span className="text-slate-500">Temporary Track IDs</span>
              <p className="font-mono font-semibold text-slate-900 truncate mt-0.5">
                {activeTrackIdsDisplay}
              </p>
            </div>
          </div>

          {/* Real Uploaded Video Inference Metrics Table */}
          {uploadMetrics && (
            <div className="px-4 py-3 bg-emerald-50/50 border-t border-emerald-200 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-emerald-900">
                  Verified Python YOLOv8n + ByteTrack Run ({uploadMetrics.framesProcessed} / {uploadMetrics.framesTotal} frames · {uploadMetrics.totalDetections} person detections · {uploadMetrics.eventsDispatched} events synced)
                </span>
                <span className="font-mono text-emerald-800">
                  Device: {uploadMetrics.device} · Model: {uploadMetrics.model}
                </span>
              </div>
              {uploadMetrics.detectionsSample.length > 0 && (
                <div className="overflow-x-auto bg-white border border-emerald-200 rounded-lg">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-1.5 px-3 font-medium">Track ID</th>
                        <th className="py-1.5 px-3 font-medium">Confidence</th>
                        <th className="py-1.5 px-3 font-medium">Frame</th>
                        <th className="py-1.5 px-3 font-medium">Zone</th>
                        <th className="py-1.5 px-3 font-medium">Latency</th>
                        <th className="py-1.5 px-3 font-medium">Timestamp</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {uploadMetrics.detectionsSample.slice(0, 6).map((sample, idx) => (
                        <tr key={`${sample.temporaryTrackId}-${sample.frameNumber}-${idx}`} className="border-b border-slate-100 last:border-b-0">
                          <td className="py-1.5 px-3 text-slate-900 font-semibold">{sample.temporaryTrackId}</td>
                          <td className="py-1.5 px-3 text-slate-700">{(sample.confidence * 100).toFixed(1)}%</td>
                          <td className="py-1.5 px-3 text-slate-700">#{sample.frameNumber}</td>
                          <td className="py-1.5 px-3 text-slate-700">{sample.zoneName || 'Floor'}</td>
                          <td className="py-1.5 px-3 text-slate-700">{sample.latencyMs ?? uploadMetrics.inferenceMs} ms</td>
                          <td className="py-1.5 px-3 text-slate-500">{new Date(sample.timestamp).toLocaleTimeString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

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
