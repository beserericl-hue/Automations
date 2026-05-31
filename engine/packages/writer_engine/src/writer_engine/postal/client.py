"""Postal HTTP client. Thin async wrapper — Postal's send-message endpoint takes a JSON body."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from writer_engine.config import get_settings


@dataclass(frozen=True)
class PostalResult:
    message_id: str | None
    status: str


class PostalClient:
    """Async Postal client. One instance per service is fine; keep-alive is reused."""

    def __init__(
        self, *, api_url: str | None = None, api_key: str | None = None, timeout_s: float = 15.0
    ) -> None:
        settings = get_settings()
        self._api_url = (api_url or settings.postal_api_url).rstrip("/")
        self._api_key = api_key or settings.postal_api_key
        self._client = httpx.AsyncClient(timeout=timeout_s)

    async def send(
        self,
        *,
        to: list[str],
        from_addr: str,
        subject: str,
        html: str,
        text: str | None = None,
    ) -> PostalResult:
        if not self._api_url or not self._api_key:
            raise RuntimeError("Postal not configured — set POSTAL_API_URL + POSTAL_API_KEY")
        body = {"to": to, "from": from_addr, "subject": subject, "html_body": html}
        if text is not None:
            body["plain_body"] = text
        # This Postal deployment mounts the send endpoint at /send/message (confirmed via sanity probe).
        # Older Postal docs sometimes show /api/v1/send/message — we use the path the server actually serves.
        resp = await self._client.post(
            f"{self._api_url}/send/message",
            headers={"x-server-api-key": self._api_key, "content-type": "application/json"},
            json=body,
        )
        resp.raise_for_status()
        payload = resp.json()
        return PostalResult(
            message_id=str(payload.get("data", {}).get("message_id")) if isinstance(payload, dict) else None,
            status="ok",
        )

    async def aclose(self) -> None:
        await self._client.aclose()


async def send_email(*, to: list[str], from_addr: str, subject: str, html: str) -> PostalResult:
    """One-shot send. The vertical slice does not need this; F2 deliver-svc does."""
    client = PostalClient()
    try:
        return await client.send(to=to, from_addr=from_addr, subject=subject, html=html)
    finally:
        await client.aclose()
