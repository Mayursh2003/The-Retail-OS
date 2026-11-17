from __future__ import annotations

from typing import List
import cv2
import numpy as np

from tracking.bytetrack_tracker import TrackedPerson
from zones.zone_engine import ZonePolygon


def draw_annotations(
    frame: np.ndarray,
    tracks: List[TrackedPerson],
    zones: List[ZonePolygon],
    fps: float,
    inference_ms: float = 0.0,
) -> np.ndarray:
    annotated = frame.copy()
    h, w = annotated.shape[:2]

    for zone in zones:
        pts = np.array(
            [[int(px / 1000.0 * w), int(py / 1000.0 * h)] for px, py in zone.points],
            dtype=np.int32,
        )
        if len(pts) >= 3:
            color = (235, 99, 37) if zone.zone_type == "billing" else (129, 185, 16)
            cv2.polylines(annotated, [pts], isClosed=True, color=color, thickness=2)
            cv2.putText(
                annotated,
                zone.name,
                (int(pts[0][0]), max(20, int(pts[0][1]) - 6)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                color,
                2,
            )

    for t in tracks:
        x1, y1, x2, y2 = t.bbox
        cv2.rectangle(annotated, (x1, y1), (x2, y2), (246, 130, 59), 2)
        label = f"{t.temporary_track_id} ({int(t.confidence * 100)}%)"
        label_y = max(22, y1 - 8)
        cv2.rectangle(
            annotated,
            (x1, max(0, label_y - 20)),
            (min(w - 1, x1 + max(130, len(label) * 10)), label_y + 4),
            (30, 41, 59),
            -1,
        )
        cv2.putText(
            annotated,
            label,
            (x1 + 4, label_y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.52,
            (248, 250, 252),
            1,
            cv2.LINE_AA,
        )

    header_text = (
        f"YOLOv8n + ByteTrack | {len(tracks)} persons | {fps:.1f} FPS"
        + (f" | {inference_ms:.0f}ms" if inference_ms > 0 else "")
    )
    cv2.rectangle(annotated, (8, 8), (min(w - 8, 560), 36), (15, 23, 42), -1)
    cv2.putText(
        annotated,
        header_text,
        (14, 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.58,
        (52, 211, 153),
        2,
        cv2.LINE_AA,
    )
    return annotated


def encode_mjpeg_frame(frame: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    if not ok:
        return b""
    return (
        b"--frame\r\n"
        b"Content-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
    )
