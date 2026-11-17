from __future__ import annotations

import logging
import os
from typing import Any, Dict
import httpx

logger = logging.getLogger("retail-brain-edge.events")


class OutboundEventClient:
    """Pushes anonymous detection and session events over outbound HTTPS to Retail Brain OS backend."""

    def __init__(self) -> None:
        self.backend_url = os.getenv("BACKEND_URL", "").strip().rstrip("/")
        self.edge_api_key = os.getenv("EDGE_API_KEY", "").strip()
        self._client = httpx.AsyncClient(timeout=5.0)
        if not self.backend_url:
            logger.warning("BACKEND_URL is not configured; outbound cloud event delivery is disabled.")
        if not self.edge_api_key:
            logger.warning("EDGE_API_KEY is not configured; outbound authenticated event delivery is disabled.")

    @property
    def is_configured(self) -> bool:
        return bool(self.backend_url and self.edge_api_key)

    async def send_event(self, payload: Dict[str, Any]) -> bool:
        if not self.is_configured:
            logger.error(
                "Refusing to send detection event: BACKEND_URL and EDGE_API_KEY must both be configured."
            )
            return False
        try:
            resp = await self._client.post(
                f"{self.backend_url}/api/vision/events",
                json=payload,
                headers={"x-edge-api-key": self.edge_api_key},
            )
            if resp.status_code >= 300:
                logger.warning("Backend rejected detection event with HTTP %s", resp.status_code)
                return False
            return True
        except Exception as exc:
            logger.warning("Failed to deliver detection event to cloud backend: %s", exc)
            return False

    async def close(self) -> None:
        await self._client.aclose()
