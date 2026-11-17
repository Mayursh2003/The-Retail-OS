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
) -> np.ndarray:
    annotated = frame.copy()
    h, w = annotated.shape[:2]

    for zone in zones:
        pts = np.array(
            [[int(px / 1000.0 * w), int(py / 1000.0 * h)] for px, py in zone.points],
            dtype=np.int32,
        )
        if len(pts) >= 3:
            color = (37, 99, 235) if zone.zone_type == "billing" else (16, 185, 129)
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
        cv2.rectangle(annotated, (x1, y1), (x2, y2), (59, 130, 246), 2)
        label = f"{t.temporary_track_id} ({t.confidence:.2f})"
        cv2.putText(
            annotated,
            label,
            (x1, max(18, y1 - 8)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            2,
        )

    cv2.putText(
        annotated,
        f"YOLOv8n + ByteTrack | {len(tracks)} persons | {fps:.1f} FPS",
        (14, 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.65,
        (16, 185, 129),
        2,
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
