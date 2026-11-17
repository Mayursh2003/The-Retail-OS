from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import time


@dataclass
class ZonePolygon:
    zone_id: str
    name: str
    zone_type: str  # entrance | billing | product | waiting
    points: List[Tuple[float, float]]  # normalized 0..1000


@dataclass
class TrackZoneState:
    first_seen: float
    last_seen: float
    current_zone: Optional[str] = None
    entered_billing: bool = False
    occupancy_history: List[str] = field(default_factory=list)


def point_in_polygon(x: float, y: float, polygon: List[Tuple[float, float]]) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) + 1e-9) + xi):
            inside = not inside
        j = i
    return inside


class ZoneIntelligenceEngine:
    """Evaluates normalized polygon occupancy, dwell seconds, and billing-zone entry."""

    def __init__(self, zones: Optional[List[ZonePolygon]] = None) -> None:
        self.zones: List[ZonePolygon] = zones or []
        self.track_states: Dict[str, TrackZoneState] = {}

    def set_zones(self, zones: List[ZonePolygon]) -> None:
        self.zones = zones

    def evaluate_track(
        self,
        track_id: str,
        bbox: Tuple[int, int, int, int],
        frame_width: int,
        frame_height: int,
    ) -> Tuple[Optional[ZonePolygon], float, bool]:
        now = time.time()
        cx = ((bbox[0] + bbox[2]) / 2.0) / max(1, frame_width) * 1000.0
        # Use footpoint (bottom-center) for accurate retail floor zone matching
        fy = float(bbox[3]) / max(1, frame_height) * 1000.0

        matched: Optional[ZonePolygon] = None
        for z in self.zones:
            if point_in_polygon(cx, fy, z.points):
                matched = z
                break

        state = self.track_states.get(track_id)
        if state is None:
            state = TrackZoneState(first_seen=now, last_seen=now)
            self.track_states[track_id] = state
        else:
            state.last_seen = now

        billing_entered_now = False
        if matched is not None:
            state.current_zone = matched.name
            if matched.zone_type == "billing" and not state.entered_billing:
                state.entered_billing = True
                billing_entered_now = True

        dwell_seconds = round(state.last_seen - state.first_seen, 1)
        return matched, dwell_seconds, billing_entered_now
