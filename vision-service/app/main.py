from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hmac
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from typing import Any, Dict, List, Optional
import cv2
import torch
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from camera.rtsp_connector import ResilientCameraConnector
from detection.yolo_detector import YoloPersonDetector
from event_sender.webhook_client import OutboundEventClient
from streaming.mjpeg_server import draw_annotations, encode_mjpeg_frame
from tracking.bytetrack_tracker import AnonymousByteTracker, TrackedPerson
from zones.zone_engine import ZoneIntelligenceEngine, ZonePolygon

logger = logging.getLogger("retail-brain-edge")

ANNOTATED_DIR = os.getenv("ANNOTATED_TMP_DIR", "/tmp/retail-brain-annotated")
ANNOTATION_TTL_SECONDS = int(os.getenv("ANNOTATION_TTL_SECONDS", "1800"))
EVENT_THROTTLE_SECONDS = float(os.getenv("EVENT_THROTTLE_SECONDS", "2.5"))
os.makedirs(ANNOTATED_DIR, exist_ok=True)


@dataclass
class AnnotatedArtifact:
    job_id: str
    file_path: str
    expires_at: float
    tenant_id: str
    outlet_id: str
    camera_id: str


@dataclass
class CameraTelemetry:
    camera_id: str
    tenant_id: str
    outlet_id: str
    status: str = "offline"
    last_frame_at: Optional[str] = None
    reconnect_attempts: int = 0
    last_error: str = ""
    fps: float = 0.0
    inference_ms: float = 0.0
    active_tracks: int = 0


@dataclass
class EdgeCameraWorker:
    camera_id: str
    tenant_id: str
    outlet_id: str
    connector: ResilientCameraConnector
    tracker: AnonymousByteTracker
    zone_engine: ZoneIntelligenceEngine
    stop_event: threading.Event = field(default_factory=threading.Event)
    thread: Optional[threading.Thread] = None


class EdgeState:
    def __init__(self) -> None:
        self._detector: Optional[YoloPersonDetector] = None
        self.model_name = os.getenv("YOLO_MODEL", "yolov8n.pt")
        self.confidence_threshold = float(os.getenv("YOLO_CONF", "0.45"))
        self.event_client = OutboundEventClient()
        self.annotated_artifacts: Dict[str, AnnotatedArtifact] = {}
        self.camera_telemetry: Dict[str, CameraTelemetry] = {}
        self.edge_workers: Dict[str, EdgeCameraWorker] = {}
        self._track_last_sent: Dict[str, Dict[str, float]] = {}

    def get_detector(self) -> YoloPersonDetector:
        if self._detector is None:
            self._detector = YoloPersonDetector(
                model_name=self.model_name,
                confidence_threshold=self.confidence_threshold,
            )
        return self._detector

    def set_confidence(self, threshold: float) -> float:
        clamped = max(0.1, min(0.95, float(threshold)))
        self.confidence_threshold = clamped
        if self._detector is not None:
            self._detector.set_confidence(clamped)
        return clamped

    def cleanup_expired_artifacts(self) -> int:
        now = time.time()
        removed = 0
        for job_id, artifact in list(self.annotated_artifacts.items()):
            if artifact.expires_at <= now:
                try:
                    if os.path.exists(artifact.file_path):
                        os.unlink(artifact.file_path)
                except OSError:
                    pass
                self.annotated_artifacts.pop(job_id, None)
                removed += 1
        return removed


edge_state = EdgeState()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async def periodic_cleanup() -> None:
        while True:
            await asyncio.sleep(60)
            edge_state.cleanup_expired_artifacts()

    cleanup_task = asyncio.create_task(periodic_cleanup())
    try:
        yield
    finally:
        cleanup_task.cancel()
        for worker in list(edge_state.edge_workers.values()):
            worker.stop_event.set()
            worker.connector.release()
        edge_state.edge_workers.clear()
        await edge_state.event_client.close()


app = FastAPI(
    title="Retail Brain OS — Python Vision Edge Service",
    version="1.1.0",
    lifespan=lifespan,
)


def verify_edge_key(x_edge_api_key: Optional[str] = Header(default=None)) -> None:
    expected_key = os.getenv("EDGE_API_KEY", "").strip()
    if not expected_key:
        raise HTTPException(
            status_code=503,
            detail="EDGE_API_KEY is not configured on vision-service.",
        )
    if not x_edge_api_key or not hmac.compare_digest(x_edge_api_key.strip(), expected_key):
        raise HTTPException(status_code=401, detail="Invalid or missing x-edge-api-key.")


def parse_zones_json(raw_zones: Optional[str]) -> List[ZonePolygon]:
    if not raw_zones:
        return []
    try:
        data = json.loads(raw_zones)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    parsed: List[ZonePolygon] = []
    for item in data[:10]:
        if not isinstance(item, dict):
            continue
        pts_raw = item.get("points") or []
        pts = [
            (float(p["x"]), float(p["y"]))
            for p in pts_raw
            if isinstance(p, dict) and "x" in p and "y" in p
        ]
        if len(pts) >= 3:
            parsed.append(
                ZonePolygon(
                    zone_id=str(item.get("id") or uuid.uuid4().hex[:6]),
                    name=str(item.get("name") or "Zone"),
                    zone_type=str(item.get("type") or "product"),
                    points=pts,
                )
            )
    return parsed


def normalize_bbox(bbox: tuple[int, int, int, int], width: int, height: int) -> List[int]:
    w = max(1, width)
    h = max(1, height)
    x1, y1, x2, y2 = bbox
    return [
        max(0, min(1000, int(round((x1 / w) * 1000)))),
        max(0, min(1000, int(round((y1 / h) * 1000)))),
        max(0, min(1000, int(round((x2 / w) * 1000)))),
        max(0, min(1000, int(round((y2 / h) * 1000)))),
    ]


def transcode_h264_mp4(raw_path: str, final_path: str) -> str:
    """Transcode OpenCV mp4v output into browser-compatible H.264 MP4 when ffmpeg is available."""
    if not shutil.which("ffmpeg"):
        shutil.move(raw_path, final_path)
        return final_path

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        raw_path,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        final_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode == 0 and os.path.exists(final_path) and os.path.getsize(final_path) > 0:
        try:
            os.unlink(raw_path)
        except OSError:
            pass
        return final_path

    shutil.move(raw_path, final_path)
    return final_path


def should_emit_throttled_event(
    camera_id: str,
    track_id: str,
    is_new_track: bool,
    billing_hit: bool,
    now_ts: float,
) -> bool:
    per_cam = edge_state._track_last_sent.setdefault(camera_id, {})
    last_sent = per_cam.get(track_id, 0.0)
    if is_new_track or billing_hit or (now_ts - last_sent) >= EVENT_THROTTLE_SECONDS:
        per_cam[track_id] = now_ts
        return True
    return False


class ModelUpdateRequest(BaseModel):
    confidence_threshold: Optional[float] = None
    model_name: Optional[str] = None


class EdgeMonitorRequest(BaseModel):
    camera_id: str
    tenant_id: str
    outlet_id: str
    rtsp_source: Optional[str] = None
    target_fps: int = 12
    zones: Optional[List[Dict[str, Any]]] = None


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "model": edge_state.model_name,
        "model_loaded": edge_state._detector is not None,
        "confidence_threshold": edge_state.confidence_threshold,
        "device": "CUDA_GPU" if torch.cuda.is_available() else "CPU",
        "tracker": "ByteTrack",
        "biometric_storage": False,
        "backend_configured": bool(edge_state.event_client.backend_url),
        "edge_api_key_configured": bool(os.getenv("EDGE_API_KEY", "").strip()),
        "active_edge_workers": len(edge_state.edge_workers),
    }


@app.patch("/model", dependencies=[Depends(verify_edge_key)])
async def update_model(payload: ModelUpdateRequest) -> Dict[str, Any]:
    if payload.confidence_threshold is not None:
        edge_state.set_confidence(payload.confidence_threshold)
    if payload.model_name and payload.model_name in {"yolov8n.pt", "yolov8s.pt"}:
        if payload.model_name != edge_state.model_name:
            edge_state.model_name = payload.model_name
            edge_state._detector = None
    return {
        "model": edge_state.model_name,
        "confidence_threshold": edge_state.confidence_threshold,
    }


@app.post("/upload-video", dependencies=[Depends(verify_edge_key)])
async def process_uploaded_video(
    file: UploadFile = File(...),
    tenant_id: str = Form(...),
    outlet_id: str = Form(...),
    camera_id: str = Form("upload-test"),
    confidence_threshold: Optional[float] = Form(default=None),
    zones_json: Optional[str] = Form(default=None),
) -> Dict[str, Any]:
    edge_state.cleanup_expired_artifacts()

    if not file.filename:
        raise HTTPException(status_code=400, detail="Video filename required.")

    suffix = os.path.splitext(file.filename)[1].lower()
    if suffix not in {".mp4", ".avi", ".mov", ".webm"}:
        raise HTTPException(status_code=400, detail="Supported formats: MP4, AVI, MOV, WEBM.")

    if confidence_threshold is not None:
        edge_state.set_confidence(confidence_threshold)

    try:
        detector = edge_state.get_detector()
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load YOLOv8 model ({edge_state.model_name}): {exc}",
        ) from exc

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    job_id = f"job-{uuid.uuid4().hex[:12]}"
    raw_annotated_path = os.path.join(ANNOTATED_DIR, f"{job_id}-raw.mp4")
    final_annotated_path = os.path.join(ANNOTATED_DIR, f"{job_id}.mp4")

    cap = cv2.VideoCapture(tmp_path)
    if not cap.isOpened():
        os.unlink(tmp_path)
        raise HTTPException(status_code=422, detail="OpenCV failed to open uploaded video.")

    source_fps = cap.get(cv2.CAP_PROP_FPS) or 15.0
    if source_fps <= 1.0 or source_fps > 60.0:
        source_fps = 15.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 360)
    frame_stride = 2 if source_fps >= 16 else 1
    out_fps = max(5.0, source_fps / frame_stride)

    tracker = AnonymousByteTracker(frame_rate=int(round(out_fps)))
    zones = parse_zones_json(zones_json)
    engine = ZoneIntelligenceEngine(zones)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(raw_annotated_path, fourcc, out_fps, (width, height))
    if not writer.isOpened():
        cap.release()
        os.unlink(tmp_path)
        raise HTTPException(status_code=500, detail="OpenCV VideoWriter failed to initialize annotated MP4.")

    frame_idx = 0
    processed_frames = 0
    total_detections = 0
    unique_tracks = set()
    seen_tracks_for_events = set()
    detections_sample: List[Dict[str, Any]] = []
    events_dispatched = 0
    total_inference_ms = 0.0
    start_time = time.time()

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            frame_idx += 1
            if frame_idx % frame_stride != 0:
                continue

            processed_frames += 1
            frame_t0 = time.perf_counter()
            dets = detector.detect(frame)
            tracked: List[TrackedPerson] = tracker.update(dets)
            frame_latency_ms = round((time.perf_counter() - frame_t0) * 1000.0, 1)
            total_inference_ms += frame_latency_ms

            elapsed_so_far = max(0.001, time.time() - start_time)
            running_fps = processed_frames / elapsed_so_far

            annotated = draw_annotations(
                frame,
                tracked,
                zones,
                fps=running_fps,
                inference_ms=frame_latency_ms,
            )
            writer.write(annotated)

            total_detections += len(tracked)
            now_iso = datetime.now(timezone.utc).isoformat()
            for t in tracked:
                is_new = t.temporary_track_id not in seen_tracks_for_events
                unique_tracks.add(t.temporary_track_id)
                zone, dwell, billing_hit = engine.evaluate_track(
                    t.temporary_track_id, t.bbox, width, height
                )
                norm_box = normalize_bbox(t.bbox, width, height)

                if len(detections_sample) < 60:
                    detections_sample.append(
                        {
                            "temporaryTrackId": t.temporary_track_id,
                            "bbox": norm_box,
                            "confidence": t.confidence,
                            "frameNumber": frame_idx,
                            "timestamp": now_iso,
                            "cameraId": camera_id,
                            "outletId": outlet_id,
                            "tenantId": tenant_id,
                            "zoneName": zone.name if zone else "Floor",
                            "latencyMs": frame_latency_ms,
                        }
                    )

                if is_new or billing_hit or processed_frames % 15 == 0:
                    seen_tracks_for_events.add(t.temporary_track_id)
                    event_type = (
                        "entry"
                        if is_new
                        else "billing_zone_enter"
                        if billing_hit
                        else "zone_dwell"
                    )
                    evt_payload = {
                        "tenantId": tenant_id,
                        "outletId": outlet_id,
                        "cameraId": camera_id,
                        "temporaryTrackId": t.temporary_track_id,
                        "eventType": event_type,
                        "confidence": t.confidence,
                        "frameNumber": frame_idx,
                        "zoneName": zone.name if zone else "Floor",
                        "dwellSeconds": dwell,
                        "sessionStatus": "billing_zone" if billing_hit else "active",
                        "bbox": norm_box,
                        "latencyMs": frame_latency_ms,
                        "timestamp": now_iso,
                    }
                    if edge_state.event_client.is_configured:
                        sent = await edge_state.event_client.send_event(evt_payload)
                        if sent:
                            events_dispatched += 1
    finally:
        writer.release()
        cap.release()
        try:
            os.unlink(tmp_path)  # Never retain customer original uploaded video
        except OSError:
            pass

    output_path = transcode_h264_mp4(raw_annotated_path, final_annotated_path)
    expires_at_ts = time.time() + ANNOTATION_TTL_SECONDS
    edge_state.annotated_artifacts[job_id] = AnnotatedArtifact(
        job_id=job_id,
        file_path=output_path,
        expires_at=expires_at_ts,
        tenant_id=tenant_id,
        outlet_id=outlet_id,
        camera_id=camera_id,
    )

    elapsed = max(0.01, time.time() - start_time)
    avg_fps = round(processed_frames / elapsed, 2)
    avg_inference_ms = round(total_inference_ms / max(1, processed_frames), 1)
    device_label = "CUDA_GPU" if torch.cuda.is_available() else "CPU"

    return {
        "upload_job_id": job_id,
        "annotated_download_path": f"/annotated/{job_id}",
        "expires_at": datetime.fromtimestamp(expires_at_ts, tz=timezone.utc).isoformat(),
        "model": edge_state.model_name,
        "confidence_threshold": edge_state.confidence_threshold,
        "device": device_label,
        "frames_total": frame_idx,
        "frames_processed": processed_frames,
        "frames_sampled": processed_frames,
        "unique_temporary_tracks": sorted(unique_tracks),
        "visitor_count": len(unique_tracks),
        "total_detections": total_detections,
        "avg_fps": avg_fps,
        "inference_ms": avg_inference_ms,
        "events_dispatched": events_dispatched,
        "detections_sample": detections_sample,
    }


@app.get("/annotated/{job_id}", dependencies=[Depends(verify_edge_key)])
async def download_annotated_video(job_id: str) -> FileResponse:
    edge_state.cleanup_expired_artifacts()
    artifact = edge_state.annotated_artifacts.get(job_id)
    if not artifact or not os.path.exists(artifact.file_path):
        raise HTTPException(status_code=404, detail="Annotated video expired or not found.")
    return FileResponse(artifact.file_path, media_type="video/mp4", filename=f"{job_id}.mp4")


@app.delete("/annotated/{job_id}", dependencies=[Depends(verify_edge_key)])
async def delete_annotated_video(job_id: str) -> Dict[str, Any]:
    artifact = edge_state.annotated_artifacts.pop(job_id, None)
    if artifact and os.path.exists(artifact.file_path):
        try:
            os.unlink(artifact.file_path)
        except OSError:
            pass
    return {"deleted": bool(artifact)}


def _resolve_camera_source(camera_id: str, header_source: Optional[str]) -> str:
    env_key = f"CAMERA_SOURCE_{camera_id.upper().replace('-', '_')}"
    source_uri = (header_source or os.getenv(env_key, "")).strip()
    if not source_uri:
        raise HTTPException(
            status_code=400,
            detail="Missing authenticated camera source header or local edge camera mapping.",
        )
    return source_uri


async def _dispatch_camera_frame_events(
    camera_id: str,
    tenant_id: str,
    outlet_id: str,
    tracked: List[TrackedPerson],
    engine: ZoneIntelligenceEngine,
    seen_tracks: set[str],
    width: int,
    height: int,
    latency_ms: float,
) -> None:
    if not tenant_id or not outlet_id or not edge_state.event_client.is_configured:
        return
    now_ts = time.time()
    now_iso = datetime.now(timezone.utc).isoformat()
    for t in tracked:
        is_new = t.temporary_track_id not in seen_tracks
        zone, dwell, billing_hit = engine.evaluate_track(t.temporary_track_id, t.bbox, width, height)
        if should_emit_throttled_event(camera_id, t.temporary_track_id, is_new, billing_hit, now_ts):
            seen_tracks.add(t.temporary_track_id)
            event_type = (
                "entry"
                if is_new
                else "billing_zone_enter"
                if billing_hit
                else "zone_dwell"
            )
            await edge_state.event_client.send_event(
                {
                    "tenantId": tenant_id,
                    "outletId": outlet_id,
                    "cameraId": camera_id,
                    "temporaryTrackId": t.temporary_track_id,
                    "eventType": event_type,
                    "confidence": t.confidence,
                    "frameNumber": 0,
                    "zoneName": zone.name if zone else "Floor",
                    "dwellSeconds": dwell,
                    "sessionStatus": "billing_zone" if billing_hit else "active",
                    "bbox": normalize_bbox(t.bbox, width, height),
                    "latencyMs": latency_ms,
                    "timestamp": now_iso,
                }
            )


@app.get("/streams/{camera_id}/mjpeg", dependencies=[Depends(verify_edge_key)])
async def stream_mjpeg(
    camera_id: str,
    x_rtsp_source: Optional[str] = Header(default=None),
    x_tenant_id: Optional[str] = Header(default=None),
    x_outlet_id: Optional[str] = Header(default=None),
    x_zones_json: Optional[str] = Header(default=None),
) -> StreamingResponse:
    source_uri = _resolve_camera_source(camera_id, x_rtsp_source)
    connector = ResilientCameraConnector(camera_id=camera_id, source=source_uri, target_fps=15)
    if not connector.connect():
        raise HTTPException(status_code=502, detail="Unable to open camera stream.")

    detector = edge_state.get_detector()
    tracker = AnonymousByteTracker(frame_rate=15)
    zones = parse_zones_json(x_zones_json)
    engine = ZoneIntelligenceEngine(zones)
    seen_tracks: set[str] = set()
    tenant_id = (x_tenant_id or "").strip()
    outlet_id = (x_outlet_id or "").strip()

    async def generate():
        consecutive_misses = 0
        try:
            while True:
                t0 = time.perf_counter()
                frame = connector.read_frame(blocking_reconnect=False)
                if frame is None:
                    consecutive_misses += 1
                    edge_state.camera_telemetry[camera_id] = CameraTelemetry(
                        camera_id=camera_id,
                        tenant_id=tenant_id,
                        outlet_id=outlet_id,
                        status=connector.status,
                        last_frame_at=datetime.fromtimestamp(connector.last_seen, tz=timezone.utc).isoformat()
                        if connector.last_seen
                        else None,
                        reconnect_attempts=connector.reconnect_attempts,
                        last_error=connector.last_error,
                    )
                    if consecutive_misses > 15:
                        break
                    await asyncio.sleep(0.5)
                    continue

                consecutive_misses = 0
                h, w = frame.shape[:2]
                dets = detector.detect(frame)
                tracked = tracker.update(dets)
                latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
                fps = round(1000.0 / max(1.0, latency_ms), 1)

                edge_state.camera_telemetry[camera_id] = CameraTelemetry(
                    camera_id=camera_id,
                    tenant_id=tenant_id,
                    outlet_id=outlet_id,
                    status="online",
                    last_frame_at=datetime.now(timezone.utc).isoformat(),
                    reconnect_attempts=0,
                    last_error="",
                    fps=fps,
                    inference_ms=latency_ms,
                    active_tracks=len(tracked),
                )

                await _dispatch_camera_frame_events(
                    camera_id=camera_id,
                    tenant_id=tenant_id,
                    outlet_id=outlet_id,
                    tracked=tracked,
                    engine=engine,
                    seen_tracks=seen_tracks,
                    width=w,
                    height=h,
                    latency_ms=latency_ms,
                )

                annotated = draw_annotations(frame, tracked, zones, fps, inference_ms=latency_ms)
                payload = encode_mjpeg_frame(annotated)
                if payload:
                    yield payload
                await asyncio.sleep(0.01)
        finally:
            connector.release()

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


def _run_edge_camera_worker(worker: EdgeCameraWorker, loop: asyncio.AbstractEventLoop) -> None:
    detector = edge_state.get_detector()
    seen_tracks: set[str] = set()
    frame_interval = 1.0 / worker.connector.target_fps
    worker.connector.connect()

    while not worker.stop_event.is_set():
        t0 = time.perf_counter()
        frame = worker.connector.read_frame(blocking_reconnect=False)
        if frame is None:
            edge_state.camera_telemetry[worker.camera_id] = CameraTelemetry(
                camera_id=worker.camera_id,
                tenant_id=worker.tenant_id,
                outlet_id=worker.outlet_id,
                status=worker.connector.status,
                last_frame_at=datetime.fromtimestamp(worker.connector.last_seen, tz=timezone.utc).isoformat()
                if worker.connector.last_seen
                else None,
                reconnect_attempts=worker.connector.reconnect_attempts,
                last_error=worker.connector.last_error,
            )
            worker.stop_event.wait(0.5)
            continue

        h, w = frame.shape[:2]
        dets = detector.detect(frame)
        tracked = worker.tracker.update(dets)
        latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
        fps = round(1000.0 / max(1.0, latency_ms), 1)

        edge_state.camera_telemetry[worker.camera_id] = CameraTelemetry(
            camera_id=worker.camera_id,
            tenant_id=worker.tenant_id,
            outlet_id=worker.outlet_id,
            status="online",
            last_frame_at=datetime.now(timezone.utc).isoformat(),
            reconnect_attempts=0,
            last_error="",
            fps=fps,
            inference_ms=latency_ms,
            active_tracks=len(tracked),
        )

        if edge_state.event_client.is_configured:
            fut = asyncio.run_coroutine_threadsafe(
                _dispatch_camera_frame_events(
                    camera_id=worker.camera_id,
                    tenant_id=worker.tenant_id,
                    outlet_id=worker.outlet_id,
                    tracked=tracked,
                    engine=worker.zone_engine,
                    seen_tracks=seen_tracks,
                    width=w,
                    height=h,
                    latency_ms=latency_ms,
                ),
                loop,
            )
            try:
                fut.result(timeout=2.0)
            except Exception:
                pass

        elapsed = time.perf_counter() - t0
        if elapsed < frame_interval:
            worker.stop_event.wait(frame_interval - elapsed)

    worker.connector.release()


@app.post("/cameras/edge/start", dependencies=[Depends(verify_edge_key)])
async def start_edge_camera_worker(payload: EdgeMonitorRequest) -> Dict[str, Any]:
    source_uri = _resolve_camera_source(payload.camera_id, payload.rtsp_source)
    existing = edge_state.edge_workers.pop(payload.camera_id, None)
    if existing:
        existing.stop_event.set()
        existing.connector.release()

    zones = parse_zones_json(json.dumps(payload.zones) if payload.zones else None)
    worker = EdgeCameraWorker(
        camera_id=payload.camera_id,
        tenant_id=payload.tenant_id,
        outlet_id=payload.outlet_id,
        connector=ResilientCameraConnector(
            camera_id=payload.camera_id,
            source=source_uri,
            target_fps=payload.target_fps,
        ),
        tracker=AnonymousByteTracker(frame_rate=payload.target_fps),
        zone_engine=ZoneIntelligenceEngine(zones),
    )
    loop = asyncio.get_running_loop()
    worker.thread = threading.Thread(
        target=_run_edge_camera_worker,
        args=(worker, loop),
        daemon=True,
        name=f"edge-cam-{payload.camera_id}",
    )
    edge_state.edge_workers[payload.camera_id] = worker
    worker.thread.start()
    return {"status": "started", "camera_id": payload.camera_id}


@app.post("/cameras/edge/stop/{camera_id}", dependencies=[Depends(verify_edge_key)])
async def stop_edge_camera_worker(camera_id: str) -> Dict[str, Any]:
    worker = edge_state.edge_workers.pop(camera_id, None)
    if worker:
        worker.stop_event.set()
        worker.connector.release()
    return {"stopped": bool(worker), "camera_id": camera_id}


@app.get("/cameras/health", dependencies=[Depends(verify_edge_key)])
async def get_cameras_health() -> Dict[str, Any]:
    return {
        "cameras": {
            cam_id: {
                "camera_id": tel.camera_id,
                "tenant_id": tel.tenant_id,
                "outlet_id": tel.outlet_id,
                "status": tel.status,
                "last_frame_at": tel.last_frame_at,
                "reconnect_attempts": tel.reconnect_attempts,
                "last_error": tel.last_error,
                "fps": tel.fps,
                "inference_ms": tel.inference_ms,
                "active_tracks": tel.active_tracks,
            }
            for cam_id, tel in edge_state.camera_telemetry.items()
        }
    }
