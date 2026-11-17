from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple
import numpy as np
from ultralytics import YOLO


@dataclass
class PersonDetection:
    bbox: Tuple[int, int, int, int]  # x1, y1, x2, y2
    confidence: float
    class_id: int


class YoloPersonDetector:
    """YOLOv8n person-only detector (COCO class 0). No biometric embeddings stored."""

    def __init__(self, model_name: str = "yolov8n.pt", confidence_threshold: float = 0.45) -> None:
        self.model_name = model_name
        self.confidence_threshold = confidence_threshold
        self.model = YOLO(model_name)

    def set_confidence(self, threshold: float) -> None:
        self.confidence_threshold = max(0.1, min(0.95, float(threshold)))

    def detect(self, frame: np.ndarray) -> List[PersonDetection]:
        results = self.model.predict(
            source=frame,
            classes=[0],  # Person class only
            conf=self.confidence_threshold,
            verbose=False,
        )
        detections: List[PersonDetection] = []
        if not results:
            return detections
        boxes = results[0].boxes
        if boxes is None:
            return detections
        for box in boxes:
            coords = box.xyxy[0].cpu().numpy().astype(int)
            conf = float(box.conf[0].cpu().numpy())
            detections.append(
                PersonDetection(
                    bbox=(int(coords[0]), int(coords[1]), int(coords[2]), int(coords[3])),
                    confidence=round(conf, 3),
                    class_id=0,
                )
            )
        return detections
