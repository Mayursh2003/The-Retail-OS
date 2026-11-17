from __future__ import annotations

import os
import logging
from typing import Any, Dict
import httpx

logger = logging.getLogger("retail-brain-edge.events")


class OutboundEventClient:
    """Pushes anonymous detection and session events over outbound HTTPS to Retail Brain OS backend."""

    def __init__(self) -> None:
        self.backend_url = os.getenv("BACKEND_URL", "http://127.0.0.1:3000").rstrip("/")
        self.edge_api_key = os.getenv("EDGE_API_KEY", "dev-edge-key")
        self._client = httpx.AsyncClient(timeout=3.0)

    async def send_event(self, payload: Dict[str, Any]) -> bool:
        try:
            resp = await self._client.post(
                f"{self.backend_url}/api/vision/events",
                json=payload,
                headers={"x-edge-api-key": self.edge_api_key},
            )
            return resp.status_code < 300
        except Exception as exc:
            logger.warning("Failed to deliver detection event to cloud backend: %s", exc)
            return False

    async def close(self) -> None:
        await self._client.aclose()
