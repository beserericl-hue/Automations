"""L2 — gateway routes: auth enforcement + the internal forwarder."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from gateway.main import app


def test_health_open() -> None:
    client = TestClient(app)
    r = client.get("/admin/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "gateway"}


def test_internal_requires_service_secret() -> None:
    client = TestClient(app)
    r = client.post("/internal/library/retrieve", json={"user_id": "u1", "limit": 1})
    assert r.status_code == 401


def test_v1_requires_api_key() -> None:
    client = TestClient(app)
    r = client.get("/v1/whoami")
    assert r.status_code == 401
    r2 = client.get("/v1/whoami", headers={"x-api-key": "abcdefghij1234567890"})
    assert r2.status_code == 200
    assert r2.json()["tenant_id"] == "tenant-stub"


def test_admin_requires_admin_token() -> None:
    client = TestClient(app)
    r = client.get("/admin/info")
    assert r.status_code == 401
    r2 = client.get("/admin/info", headers={"x-admin-token": "test-admin-token"})
    assert r2.status_code == 200


def test_internal_forwards_to_orchestrator(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch httpx so /internal/library/retrieve "calls" a fake orchestrator and returns its JSON."""

    class _FakeAsyncClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> _FakeAsyncClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
            assert "library_retrieve" in url
            assert kwargs["headers"]["x-service-secret"] == "test-secret"
            return httpx.Response(200, json={"status": "ok", "items": [{"id": "x"}]})

    monkeypatch.setattr("gateway.routes.internal.httpx.AsyncClient", _FakeAsyncClient)
    client = TestClient(app)
    r = client.post(
        "/internal/library/retrieve",
        json={"user_id": "u1", "limit": 1},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["items"] == [{"id": "x"}]
