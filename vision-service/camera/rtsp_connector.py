from __future__ import annotations

import logging
import time
from typing import Optional
import cv2
import numpy as np

logger = logging.getLogger("retail-brain-edge.camera")


class ResilientCameraConnector:
    """
    Connects to RTSP DVR/NVR feeds or local HDMI USB capture devices (/dev/video0)
    with automatic exponential-backoff reconnection and explicit offline reporting.
    """

    def __init__(self, camera_id: str, source: str | int, target_fps: int = 15) -> None:
        self.camera_id = camera_id
        self.source = source
        self.target_fps = max(1, min(30, target_fps))
        self.cap: Optional[cv2.VideoCapture] = None
        self.status: str = "offline"
        self.last_seen: float = 0.0
        self.reconnect_attempts: int = 0
        self.last_error: str = ""

    def connect(self) -> bool:
        try:
            if self.cap is not None:
                self.cap.release()
            self.cap = cv2.VideoCapture(self.source)
            if not self.cap.isOpened():
                self.status = "offline"
                self.last_error = "Unable to open video capture stream."
                return False
            self.status = "online"
            self.last_seen = time.time()
            self.reconnect_attempts = 0
            self.last_error = ""
            return True
        except Exception as exc:
            self.status = "offline"
            self.last_error = str(exc)
            return False

    def read_frame(self) -> Optional[np.ndarray]:
        if self.cap is None or not self.cap.isOpened():
            self.reconnect_with_backoff()
            return None
        ok, frame = self.cap.read()
        if not ok or frame is None:
            self.status = "degraded"
            self.last_error = "Dropped frame or stream EOF."
            self.reconnect_with_backoff()
            return None
        self.status = "online"
        self.last_seen = time.time()
        return frame

    def reconnect_with_backoff(self) -> bool:
        self.reconnect_attempts += 1
        delay = min(30.0, 1.5 ** min(self.reconnect_attempts, 6))
        logger.warning(
            "Camera %s offline/degraded (attempt %d). Reconnecting in %.1fs...",
            self.camera_id,
            self.reconnect_attempts,
            delay,
        )
        time.sleep(delay)
        return self.connect()

    def release(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None
        self.status = "offline"
