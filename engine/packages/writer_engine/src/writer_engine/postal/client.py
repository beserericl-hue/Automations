"""Postal HTTP client. Thin async wrapper — Postal's send-message endpoint takes a JSON body."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from writer_engine.config import get_settings


@dataclass(frozen=True)
class PostalAttachment:
    """Inline or attached file. Postal expects ``data`` to be already base64-encoded."""

    name: str
    content_type: str
    data: str


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
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        reply_to: str | None = None,
        sender: str | None = None,
        headers: dict[str, str] | None = None,
        attachments: list[PostalAttachment] | None = None,
        tag: str | None = None,
    ) -> PostalResult:
        if not self._api_url or not self._api_key:
            raise RuntimeError("Postal not configured — set POSTAL_API_URL + POSTAL_API_KEY")
        body: dict[str, Any] = {"to": to, "from": from_addr, "subject": subject, "html_body": html}
        if text is not None:
            body["plain_body"] = text
        if cc:
            body["cc"] = cc
        if bcc:
            body["bcc"] = bcc
        if reply_to is not None:
            body["reply_to"] = reply_to
        if sender is not None:
            body["sender"] = sender
        if headers:
            body["headers"] = headers
        if attachments:
            body["attachments"] = [
                {"name": a.name, "content_type": a.content_type, "data": a.data} for a in attachments
            ]
        if tag is not None:
            body["tag"] = tag
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


async def send_email(
    *,
    to: list[str],
    from_addr: str,
    subject: str,
    html: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
) -> PostalResult:
    """One-shot send. The vertical slice does not need this; F2 deliver-svc + notify_step do."""
    client = PostalClient()
    try:
        return await client.send(
            to=to, from_addr=from_addr, subject=subject, html=html, cc=cc, bcc=bcc
        )
    finally:
        await client.aclose()
