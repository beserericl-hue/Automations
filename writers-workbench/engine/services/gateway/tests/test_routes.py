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


# --------------------------------------------------------------------------- CR-004 hub

def test_hub_requires_service_secret() -> None:
    client = TestClient(app)
    r = client.post("/internal/hub", json={"message": "hi"})
    assert r.status_code == 401


def test_hub_conversation_does_not_call_orchestrator() -> None:
    """Chit-chat routes to a reply with no downstream call (router degrades to heuristic in tests)."""
    client = TestClient(app)
    r = client.post(
        "/internal/hub",
        json={"message": "hello there", "user_id": "u1"},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 200
    assert r.json()["kind"] == "reply"


def _patch_orch(monkeypatch: pytest.MonkeyPatch, capture: dict[str, Any], response_json: dict) -> None:
    class _Fake:
        def __init__(self, *a: object, **k: object) -> None:
            pass

        async def __aenter__(self) -> "_Fake":
            return self

        async def __aexit__(self, *a: object) -> None:
            return None

        async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
            capture["url"] = url
            capture["body"] = kwargs.get("json")
            return httpx.Response(200, json=response_json)

    monkeypatch.setattr("gateway.routes.internal.httpx.AsyncClient", _Fake)


def test_hub_task_enqueues_async_with_persist(monkeypatch: pytest.MonkeyPatch) -> None:
    cap: dict[str, Any] = {}
    _patch_orch(monkeypatch, cap, {"job_id": "job-123", "status": "queued", "tool": "chapter"})
    client = TestClient(app)
    r = client.post(
        "/internal/hub",
        json={"message": "write chapter 5", "user_id": "u1"},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "queued" and body["job_id"] == "job-123"
    assert body["tool"] == "chapter" and body["op"] == "write"
    # forwarded to the uniform write route, async + persist set
    assert "/pipelines/write/chapter/run" in cap["url"]
    assert cap["body"]["async"] is True and cap["body"]["persist"] is True
    assert cap["body"]["op"] == "write"


def test_hub_info_runs_sync_and_returns_data(monkeypatch: pytest.MonkeyPatch) -> None:
    cap: dict[str, Any] = {}
    _patch_orch(monkeypatch, cap, {"op": "list-outlines", "result": {"outlines": [{"title": "A"}]}})
    client = TestClient(app)
    r = client.post(
        "/internal/hub",
        json={"message": "list all my outlines", "user_id": "u1"},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "data"
    assert body["data"]["result"]["outlines"] == [{"title": "A"}]
    assert "/pipelines/write/library/run" in cap["url"]
    assert cap["body"]["async"] is False


def test_hub_voice_maps_caller_id_and_returns_flat(monkeypatch: pytest.MonkeyPatch) -> None:
    """Eve voice surface: system__caller_id -> user_id, and a flat {response, job_id} the agent speaks."""
    cap: dict[str, Any] = {}
    _patch_orch(monkeypatch, cap, {"job_id": "job-9", "status": "queued", "tool": "chapter"})
    client = TestClient(app)
    r = client.post(
        "/internal/hub/voice",
        json={"user_message_request": "write chapter 5", "system__caller_id": "+14105914612"},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 200
    body = r.json()
    # flat voice shape: a spoken line + the queued job, no nested HubResponse envelope
    assert isinstance(body["response"], str) and body["response"]
    assert body["kind"] == "queued" and body["job_id"] == "job-9"
    # caller id became the user_id forwarded to the orchestrator
    assert cap["body"]["user_id"] == "+14105914612"


def test_hub_voice_requires_service_secret() -> None:
    client = TestClient(app)
    r = client.post("/internal/hub/voice", json={"user_message_request": "hi"})
    assert r.status_code == 401
