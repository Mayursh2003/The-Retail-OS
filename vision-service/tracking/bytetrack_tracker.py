from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple
import numpy as np
import supervision as sv

from detection.yolo_detector import PersonDetection


@dataclass
class TrackedPerson:
    temporary_track_id: str
    bbox: Tuple[int, int, int, int]
    confidence: float


class AnonymousByteTracker:
    """
    Temporary ByteTrack wrapper generating session-scoped IDs (TRK-001, TRK-002...).
    Strictly non-biometric: no face matching, no persistent identity profiles.
    """

    def __init__(self, frame_rate: int = 15) -> None:
        self.tracker = sv.ByteTrack(frame_rate=frame_rate)
        self._id_map: Dict[int, str] = {}
        self._counter = 0

    def reset(self) -> None:
        self.tracker.reset()
        self._id_map.clear()
        self._counter = 0

    def update(self, detections: List[PersonDetection]) -> List[TrackedPerson]:
        if not detections:
            return []

        xyxy = np.array([d.bbox for d in detections], dtype=np.float32)
        confidence = np.array([d.confidence for d in detections], dtype=np.float32)
        class_id = np.array([d.class_id for d in detections], dtype=int)

        sv_dets = sv.Detections(xyxy=xyxy, confidence=confidence, class_id=class_id)
        tracked = self.tracker.update_with_detections(sv_dets)

        output: List[TrackedPerson] = []
        if tracked.tracker_id is None:
            return output

        for idx, raw_tid in enumerate(tracked.tracker_id):
            tid_int = int(raw_tid)
            if tid_int not in self._id_map:
                self._counter += 1
                self._id_map[tid_int] = f"TRK-{self._counter:03d}"
            box = tracked.xyxy[idx].astype(int)
            conf = float(tracked.confidence[idx]) if tracked.confidence is not None else 0.0
            output.append(
                TrackedPerson(
                    temporary_track_id=self._id_map[tid_int],
                    bbox=(int(box[0]), int(box[1]), int(box[2]), int(box[3])),
                    confidence=round(conf, 3),
                )
            )
        return output
