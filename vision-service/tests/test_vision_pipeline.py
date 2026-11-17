from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def test_health_and_edge_key_enforcement(monkeypatch: pytest.MonkeyPatch) -> None:
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    cv2 = pytest.importorskip("cv2")
    assert cv2 is not None

    from app.main import app, edge_state

    monkeypatch.setenv("EDGE_API_KEY", "test-edge-secret")
    client = fastapi_testclient.TestClient(app)

    health = client.get("/health")
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok"
    assert body["tracker"] == "ByteTrack"
    assert body["biometric_storage"] is False
    assert body["edge_api_key_configured"] is True

    # Missing or wrong API key rejected
    assert client.patch("/model", json={"confidence_threshold": 0.5}).status_code == 401
    assert (
        client.patch(
            "/model",
            json={"confidence_threshold": 0.5},
            headers={"x-edge-api-key": "wrong-key"},
        ).status_code
        == 401
    )

    ok_resp = client.patch(
        "/model",
        json={"confidence_threshold": 0.5},
        headers={"x-edge-api-key": "test-edge-secret"},
    )
    assert ok_resp.status_code == 200
    assert edge_state.confidence_threshold == 0.5

    # Unconfigured EDGE_API_KEY fails closed with 503
    monkeypatch.delenv("EDGE_API_KEY", raising=False)
    assert (
        client.patch(
            "/model",
            json={"confidence_threshold": 0.5},
            headers={"x-edge-api-key": "test-edge-secret"},
        ).status_code
        == 503
    )


def test_bytetrack_generates_session_scoped_ids_isolated_per_camera() -> None:
    np = pytest.importorskip("numpy")
    pytest.importorskip("supervision")
    from detection.yolo_detector import PersonDetection
    from tracking.bytetrack_tracker import AnonymousByteTracker

    cam_a = AnonymousByteTracker(frame_rate=15)
    cam_b = AnonymousByteTracker(frame_rate=15)

    det_a = [PersonDetection(bbox=(100, 120, 220, 380), confidence=0.91, class_id=0)]
    det_b = [PersonDetection(bbox=(300, 140, 420, 410), confidence=0.88, class_id=0)]

    # Warm up ByteTrack across frames
    tracks_a = []
    tracks_b = []
    for _ in range(3):
        tracks_a = cam_a.update(det_a)
        tracks_b = cam_b.update(det_b)

    assert len(tracks_a) == 1
    assert len(tracks_b) == 1
    assert tracks_a[0].temporary_track_id.startswith("TRK-")
    assert tracks_b[0].temporary_track_id.startswith("TRK-")
    assert np is not None


def test_event_throttling_and_ttl_cleanup(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("fastapi")
    from app.main import AnnotatedArtifact, edge_state, should_emit_throttled_event

    edge_state._track_last_sent.clear()
    # First detection emits immediately
    assert should_emit_throttled_event("cam-1", "TRK-001", True, False, 100.0) is True
    # Frame 0.2s later without billing hit is throttled
    assert should_emit_throttled_event("cam-1", "TRK-001", False, False, 100.2) is False
    # Billing zone entry emits immediately even within throttle window
    assert should_emit_throttled_event("cam-1", "TRK-001", False, True, 100.4) is True
    # After throttle window expires, emits again
    assert should_emit_throttled_event("cam-1", "TRK-001", False, False, 105.0) is True

    # TTL cleanup removes expired temporary annotated artifact file
    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
        tmp.write(b"fake-mp4-bytes")
        tmp_path = tmp.name

    edge_state.annotated_artifacts["job-expired"] = AnnotatedArtifact(
        job_id="job-expired",
        file_path=tmp_path,
        expires_at=time.time() - 10,
        tenant_id="ten-1",
        outlet_id="out-1",
        camera_id="upload-test",
    )
    removed = edge_state.cleanup_expired_artifacts()
    assert removed >= 1
    assert not os.path.exists(tmp_path)


def test_upload_video_pipeline_generates_annotated_mp4_and_metrics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    pytest.importorskip("supervision")

    from app.main import app, edge_state
    from detection.yolo_detector import PersonDetection

    monkeypatch.setenv("EDGE_API_KEY", "test-edge-secret")

    # Create tiny valid MP4 file in temp dir
    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp_vid:
        vid_path = tmp_vid.name

    writer = cv2.VideoWriter(vid_path, cv2.VideoWriter_fourcc(*"mp4v"), 10.0, (320, 240))
    for i in range(6):
        frame = np.zeros((240, 320, 3), dtype=np.uint8)
        cv2.rectangle(frame, (80 + i * 2, 40), (160 + i * 2, 210), (200, 200, 200), -1)
        writer.write(frame)
    writer.release()

    class StubDetector:
        model_name = "yolov8n.pt"
        confidence_threshold = 0.45

        def set_confidence(self, threshold: float) -> None:
            self.confidence_threshold = threshold

        def detect(self, _frame):
            return [PersonDetection(bbox=(82, 40, 162, 210), confidence=0.89, class_id=0)]

    monkeypatch.setattr(edge_state, "get_detector", lambda: StubDetector())

    client = fastapi_testclient.TestClient(app)
    try:
        with open(vid_path, "rb") as f:
            resp = client.post(
                "/upload-video",
                headers={"x-edge-api-key": "test-edge-secret"},
                data={
                    "tenant_id": "ten-bharat-fresh",
                    "outlet_id": "out-indiranagar",
                    "camera_id": "upload-test",
                },
                files={"file": ("sample.mp4", f, "video/mp4")},
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["frames_processed"] >= 3
        assert data["total_detections"] >= 1
        assert len(data["unique_temporary_tracks"]) >= 1
        assert data["annotated_download_path"].startswith("/annotated/job-")

        # Download annotated MP4 via protected endpoint
        dl = client.get(
            data["annotated_download_path"],
            headers={"x-edge-api-key": "test-edge-secret"},
        )
        assert dl.status_code == 200
        assert len(dl.content) > 100

        # Cleanup endpoint deletes file
        delete_resp = client.delete(
            data["annotated_download_path"],
            headers={"x-edge-api-key": "test-edge-secret"},
        )
        assert delete_resp.status_code == 200
        assert delete_resp.json()["deleted"] is True
    finally:
        if os.path.exists(vid_path):
            os.unlink(vid_path)
