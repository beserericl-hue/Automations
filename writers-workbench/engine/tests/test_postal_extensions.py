"""PostalClient cc/bcc/headers/attachments — body-shape contract.

Postal accepts a flat JSON body; the API doesn't echo what wasn't sent, so the
test asserts the request body the client constructs (via a mock httpx transport)
matches what Postal expects.
"""

from __future__ import annotations

import json

import httpx
import pytest

from writer_engine.postal import PostalAttachment, PostalClient


class _Capture:
    def __init__(self) -> None:
        self.last_body: dict | None = None


@pytest.fixture
def capture(monkeypatch: pytest.MonkeyPatch) -> _Capture:
    cap = _Capture()

    class _Transport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            cap.last_body = json.loads(request.content)
            return httpx.Response(
                200, json={"status": "success", "data": {"message_id": "fake-mid-123"}}
            )

    real_init = httpx.AsyncClient.__init__

    def _init(self: httpx.AsyncClient, *args: object, **kwargs: object) -> None:
        kwargs.setdefault("transport", _Transport())
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", _init)
    return cap


@pytest.mark.asyncio
async def test_send_includes_cc_bcc(capture: _Capture) -> None:
    client = PostalClient(api_url="http://postal.test", api_key="k")
    try:
        res = await client.send(
            to=["a@example.com"],
            from_addr="bot@example.com",
            subject="s",
            html="<p>hi</p>",
            cc=["c1@example.com", "c2@example.com"],
            bcc=["b@example.com"],
        )
    finally:
        await client.aclose()
    assert res.message_id == "fake-mid-123"
    assert capture.last_body is not None
    assert capture.last_body["cc"] == ["c1@example.com", "c2@example.com"]
    assert capture.last_body["bcc"] == ["b@example.com"]


@pytest.mark.asyncio
async def test_send_omits_optional_when_unset(capture: _Capture) -> None:
    """Optional fields stay out of the body when not passed — Postal rejects unknown keys."""
    client = PostalClient(api_url="http://postal.test", api_key="k")
    try:
        await client.send(
            to=["a@example.com"], from_addr="bot@example.com", subject="s", html="<p>x</p>"
        )
    finally:
        await client.aclose()
    body = capture.last_body
    assert body is not None
    for unset in ("cc", "bcc", "plain_body", "reply_to", "sender", "headers", "attachments", "tag"):
        assert unset not in body, f"{unset} leaked into body when not passed"


@pytest.mark.asyncio
async def test_send_attachments_and_headers(capture: _Capture) -> None:
    client = PostalClient(api_url="http://postal.test", api_key="k")
    try:
        await client.send(
            to=["a@example.com"],
            from_addr="bot@example.com",
            subject="s",
            html="<p>x</p>",
            text="plain",
            reply_to="reply@example.com",
            headers={"X-Trace": "abc"},
            attachments=[PostalAttachment(name="cover.png", content_type="image/png", data="BASE64")],
            tag="newsletter",
        )
    finally:
        await client.aclose()
    body = capture.last_body
    assert body is not None
    assert body["plain_body"] == "plain"
    assert body["reply_to"] == "reply@example.com"
    assert body["headers"] == {"X-Trace": "abc"}
    assert body["attachments"] == [
        {"name": "cover.png", "content_type": "image/png", "data": "BASE64"}
    ]
    assert body["tag"] == "newsletter"


@pytest.mark.asyncio
async def test_send_raises_on_postal_error_status(monkeypatch: pytest.MonkeyPatch) -> None:
    """Postal returns HTTP 200 with status=error for an unauthorised From — must NOT be a phantom
    success. (Observed live: a placeholder .local From → UnauthenticatedFromAddress, mail dropped.)"""

    class _ErrTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "status": "error",
                    "data": {
                        "code": "UnauthenticatedFromAddress",
                        "message": "The From address is not authorised to send mail from this server",
                    },
                },
            )

    real_init = httpx.AsyncClient.__init__

    def _init(self: httpx.AsyncClient, *args: object, **kwargs: object) -> None:
        kwargs.setdefault("transport", _ErrTransport())
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", _init)
    client = PostalClient(api_url="http://postal.test", api_key="k")
    try:
        with pytest.raises(RuntimeError, match="UnauthenticatedFromAddress"):
            await client.send(
                to=["a@example.com"], from_addr="bot@bad.local", subject="s", html="<p>x</p>"
            )
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_send_raises_without_credentials() -> None:
    client = PostalClient(api_url="", api_key="")
    try:
        with pytest.raises(RuntimeError, match="Postal not configured"):
            await client.send(
                to=["a@example.com"], from_addr="bot@example.com", subject="s", html="<p>x</p>"
            )
    finally:
        await client.aclose()
