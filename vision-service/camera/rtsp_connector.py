from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional
import cv2
import numpy as np

logger = logging.getLogger("retail-brain-edge.camera")


class ResilientCameraConnector:
    """
    Connects to RTSP DVR/NVR feeds or local HDMI USB capture devices (/dev/video0)
    with automatic exponential-backoff reconnection and explicit health reporting.
    Credentials in `source` are never exposed in health snapshots or logs.
    """

    def __init__(self, camera_id: str, source: str | int, target_fps: int = 15) -> None:
        self.camera_id = camera_id
        self.source = source
        self.target_fps = max(1, min(30, target_fps))
        self.cap: Optional[cv2.VideoCapture] = None
        self.status: str = "offline"
        self.last_seen: float = 0.0
        self.reconnect_attempts: int = 0
        self.next_reconnect_at: float = 0.0
        self.last_error: str = ""

    def connect(self) -> bool:
        try:
            if self.cap is not None:
                self.cap.release()
                self.cap = None
            self.cap = cv2.VideoCapture(self.source)
            if not self.cap.isOpened():
                self.status = "offline"
                self.last_error = "Unable to open video capture stream."
                self._schedule_backoff()
                return False
            self.status = "online"
            self.last_seen = time.time()
            self.reconnect_attempts = 0
            self.next_reconnect_at = 0.0
            self.last_error = ""
            return True
        except Exception as exc:
            self.status = "offline"
            self.last_error = f"Capture connect error: {type(exc).__name__}"
            self._schedule_backoff()
            return False

    def _schedule_backoff(self) -> float:
        self.reconnect_attempts += 1
        delay = min(30.0, 1.5 ** min(self.reconnect_attempts, 6))
        self.next_reconnect_at = time.time() + delay
        return delay

    def read_frame(self, blocking_reconnect: bool = False) -> Optional[np.ndarray]:
        if self.cap is None or not self.cap.isOpened():
            self.reconnect_with_backoff(blocking=blocking_reconnect)
            return None
        ok, frame = self.cap.read()
        if not ok or frame is None:
            self.status = "degraded"
            self.last_error = "Dropped frame or stream EOF."
            self.reconnect_with_backoff(blocking=blocking_reconnect)
            return None
        self.status = "online"
        self.last_seen = time.time()
        self.reconnect_attempts = 0
        self.last_error = ""
        return frame

    def reconnect_with_backoff(self, blocking: bool = False) -> bool:
        now = time.time()
        if now < self.next_reconnect_at:
            if not blocking:
                return False
            time.sleep(max(0.0, self.next_reconnect_at - now))

        delay = min(30.0, 1.5 ** min(self.reconnect_attempts + 1, 6))
        logger.warning(
            "Camera %s %s (attempt %d). Reconnecting (next backoff %.1fs)...",
            self.camera_id,
            self.status,
            self.reconnect_attempts + 1,
            delay,
        )
        return self.connect()

    def health_snapshot(self) -> Dict[str, Any]:
        return {
            "camera_id": self.camera_id,
            "status": self.status,
            "last_seen": self.last_seen,
            "reconnect_attempts": self.reconnect_attempts,
            "last_error": self.last_error,
        }

    def release(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        self.status = "offline"
