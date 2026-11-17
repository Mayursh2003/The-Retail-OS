from __future__ import annotations

import os
import tempfile
import time
from typing import Any, Dict, List
import cv2
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from detection.yolo_detector import YoloPersonDetector
from event_sender.webhook_client import OutboundEventClient
from streaming.mjpeg_server import draw_annotations, encode_mjpeg_frame
from tracking.bytetrack_tracker import AnonymousByteTracker
from zones.zone_engine import ZoneIntelligenceEngine, ZonePolygon

app = FastAPI(title="Retail Brain OS — Python Vision Edge Service", version="1.0.0")

detector = YoloPersonDetector(
    model_name=os.getenv("YOLO_MODEL", "yolov8n.pt"),
    confidence_threshold=float(os.getenv("YOLO_CONF", "0.45")),
)
event_client = OutboundEventClient()
zone_engines: Dict[str, ZoneIntelligenceEngine] = {}


class ModelUpdateRequest(BaseModel):
    confidence_threshold: float


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "model": detector.model_name,
        "confidence_threshold": detector.confidence_threshold,
        "device": "CUDA_GPU" if torch.cuda.is_available() else "CPU",
        "tracker": "ByteTrack",
        "biometric_storage": False,
    }


@app.patch("/model")
async def update_model(payload: ModelUpdateRequest) -> Dict[str, Any]:
    detector.set_confidence(payload.confidence_threshold)
    return {"confidence_threshold": detector.confidence_threshold}


@app.post("/upload-video")
async def process_uploaded_video(
    file: UploadFile = File(...),
    tenant_id: str = Form("ten-bharat-fresh"),
    outlet_id: str = Form("out-indiranagar"),
    camera_id: str = Form("upload-test"),
) -> Dict[str, Any]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Video filename required.")

    suffix = os.path.splitext(file.filename)[1].lower()
    if suffix not in {".mp4", ".avi", ".mov", ".webm"}:
        raise HTTPException(status_code=400, detail="Supported formats: MP4, AVI, MOV, WEBM.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    tracker = AnonymousByteTracker(frame_rate=15)
    zones = zone_engines.get(camera_id, ZoneIntelligenceEngine()).zones
    engine = ZoneIntelligenceEngine(zones)

    cap = cv2.VideoCapture(tmp_path)
    if not cap.isOpened():
        os.unlink(tmp_path)
        raise HTTPException(status_code=422, detail="OpenCV failed to open uploaded video.")

    frame_idx = 0
    total_detections = 0
    unique_tracks = set()
    start_time = time.time()
    sample_events: List[Dict[str, Any]] = []

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            frame_idx += 1
            if frame_idx % 2 != 0:
                continue  # Process every 2nd frame for CPU throughput
            h, w = frame.shape[:2]
            dets = detector.detect(frame)
            tracked = tracker.update(dets)
            total_detections += len(tracked)
            for t in tracked:
                unique_tracks.add(t.temporary_track_id)
                zone, dwell, billing_hit = engine.evaluate_track(t.temporary_track_id, t.bbox, w, h)
                if frame_idx % 30 == 0 or billing_hit:
                    evt = {
                        "tenantId": tenant_id,
                        "outletId": outlet_id,
                        "cameraId": camera_id,
                        "temporaryTrackId": t.temporary_track_id,
                        "eventType": "billing_zone_enter" if billing_hit else "zone_dwell",
                        "confidence": t.confidence,
                        "frameNumber": frame_idx,
                        "zoneName": zone.name if zone else "Floor",
                        "dwellSeconds": dwell,
                        "sessionStatus": "billing_zone" if billing_hit else "active",
                    }
                    sample_events.append(evt)
                    await event_client.send_event(evt)
    finally:
        cap.release()
        os.unlink(tmp_path)  # Never retain customer test videos permanently

    elapsed = max(0.01, time.time() - start_time)
    return {
        "frames_sampled": frame_idx // 2,
        "unique_temporary_tracks": sorted(unique_tracks),
        "total_detections": total_detections,
        "avg_fps": round((frame_idx / 2) / elapsed, 2),
        "inference_ms": round((elapsed / max(1, frame_idx / 2)) * 1000, 1),
        "events_dispatched": len(sample_events),
    }


@app.get("/streams/{camera_id}/mjpeg")
async def stream_mjpeg(camera_id: str, rtsp_url: str) -> StreamingResponse:
    cap = cv2.VideoCapture(rtsp_url)
    if not cap.isOpened():
        raise HTTPException(status_code=502, detail="Unable to open RTSP camera stream.")

    tracker = AnonymousByteTracker(frame_rate=15)
    zones = zone_engines.get(camera_id, ZoneIntelligenceEngine()).zones

    def generate():
        try:
            while True:
                t0 = time.time()
                ok, frame = cap.read()
                if not ok or frame is None:
                    break
                dets = detector.detect(frame)
                tracked = tracker.update(dets)
                fps = 1.0 / max(0.001, time.time() - t0)
                annotated = draw_annotations(frame, tracked, zones, fps)
                yield encode_mjpeg_frame(annotated)
        finally:
            cap.release()

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
