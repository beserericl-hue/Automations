"""B2 — /admin/health and /admin/ready actually check their dependencies.

Before this, /admin/health returned {"status":"ok"} unconditionally, so Railway could not detect a
dead in-container step service (B1). These tests pin the semantics:

* health  = liveness; 503 when ANY in-container step service is unreachable (restart fixes that).
* ready   = readiness; adds Redis (required) + arq heartbeat and Supabase (optional → degraded).
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from orchestrator import main as orch_main
from orchestrator.write_tools import ALL_STEP_URLS
from writer_engine.health import CheckResult, summarise
from writer_engine.queues import ALL_QUEUES


@pytest.fixture
def client() -> TestClient:
    return TestClient(orch_main.app)


def _all_steps_healthy(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every step probe succeed, leaving the non-step probes to the test."""

    async def _ok(name: str, url: str, **_: Any) -> CheckResult:
        return CheckResult(name=name, ok=True)

    monkeypatch.setattr(orch_main, "probe_http", _ok)


def test_health_503_when_a_step_is_unreachable(client: TestClient) -> None:
    """The real bug: nothing listens on the step ports in-process, so health must refuse."""
    r = client.get("/admin/health")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "unhealthy"
    assert body["service"] == "orchestrator"
    # Every step is required, so all of them should be named.
    assert len(body["failed_required"]) == len(ALL_STEP_URLS)
    assert "step:chapter" in body["checks"]


def test_health_probes_every_registered_step(client: TestClient) -> None:
    """Guards against a step being added to the entrypoint but not to ALL_STEP_URLS."""
    r = client.get("/admin/health")
    probed = {k for k in r.json()["checks"] if k.startswith("step:")}
    assert probed == {f"step:{name}" for name in ALL_STEP_URLS}
    # The 8 write tools + 10 newsletter steps + library_retrieve.
    assert len(probed) == 19


def test_health_200_when_all_steps_healthy(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _all_steps_healthy(monkeypatch)
    r = client.get("/admin/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_health_does_not_check_external_deps(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Liveness must not gate on Redis/Supabase, or a blip becomes a container restart loop."""
    _all_steps_healthy(monkeypatch)
    checks = client.get("/admin/health").json()["checks"]
    assert "redis" not in checks
    assert "supabase" not in checks
    assert "arq_worker" not in checks


def test_ready_503_when_redis_down(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _all_steps_healthy(monkeypatch)

    async def _redis_down(**_: Any) -> CheckResult:
        return CheckResult(name="redis", ok=False, detail="ConnectionError", required=True)

    async def _optional_ok(**kwargs: Any) -> CheckResult:
        return CheckResult(name="x", ok=True, required=False)

    monkeypatch.setattr(orch_main, "probe_redis", _redis_down)
    monkeypatch.setattr(orch_main, "probe_arq_worker", _optional_ok)
    monkeypatch.setattr(orch_main, "probe_supabase", _optional_ok)

    r = client.get("/admin/ready")
    assert r.status_code == 503
    assert r.json()["status"] == "unhealthy"
    assert "redis" in r.json()["failed_required"]


def test_ready_degraded_not_503_when_only_optional_fails(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing arq heartbeat is worth reporting, not worth withdrawing the instance."""
    _all_steps_healthy(monkeypatch)

    async def _redis_ok(**_: Any) -> CheckResult:
        return CheckResult(name="redis", ok=True, required=True)

    async def _worker_missing(**kwargs: Any) -> CheckResult:
        return CheckResult(name=kwargs["name"], ok=False, detail="no heartbeat", required=False)

    async def _supabase_ok(**_: Any) -> CheckResult:
        return CheckResult(name="supabase", ok=True, required=False)

    monkeypatch.setattr(orch_main, "probe_redis", _redis_ok)
    monkeypatch.setattr(orch_main, "probe_arq_worker", _worker_missing)
    monkeypatch.setattr(orch_main, "probe_supabase", _supabase_ok)

    r = client.get("/admin/ready")
    assert r.status_code == 200
    assert r.json()["status"] == "degraded"
    # One entry per queue (B4): a dead interactive worker is a different outage from a dead heavy one.
    assert r.json()["failed_optional"] == [f"arq_worker:{q}" for q in ALL_QUEUES]


def test_ready_uses_the_same_keys_the_workers_write(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reader/writer drift on the heartbeat key would silently always report 'no heartbeat'.

    Compares the keys /admin/ready actually probes against the keys the worker classes declare,
    rather than re-deriving the format in the test — the format living in two places is the drift.
    """
    from orchestrator.worker import WorkerSettingsHeavy, WorkerSettingsInteractive

    probed: set[str] = set()

    async def _capture(**kwargs: Any) -> CheckResult:
        probed.add(kwargs["health_check_key"])
        return CheckResult(name=kwargs["name"], ok=True, required=False)

    async def _ok(**_: Any) -> CheckResult:
        return CheckResult(name="x", ok=True, required=False)

    _all_steps_healthy(monkeypatch)
    monkeypatch.setattr(orch_main, "probe_arq_worker", _capture)
    monkeypatch.setattr(orch_main, "probe_redis", _ok)
    monkeypatch.setattr(orch_main, "probe_supabase", _ok)
    client.get("/admin/ready")

    written = {WorkerSettingsHeavy.health_check_key, WorkerSettingsInteractive.health_check_key}
    assert probed == written
    assert len(written) == 2, "both workers writing one key makes either one look alive"
    # arq's 3600s default would let a dead worker look alive for an hour.
    assert WorkerSettingsHeavy.health_check_interval <= 60
    assert WorkerSettingsInteractive.health_check_interval <= 60


# --- summarise() status mapping -------------------------------------------------------------


def test_summarise_ok() -> None:
    body, ok = summarise("svc", [CheckResult("a", True), CheckResult("b", True, required=False)])
    assert ok is True
    assert body["status"] == "ok"
    assert "failed_required" not in body


def test_summarise_degraded_is_servable() -> None:
    body, ok = summarise("svc", [CheckResult("a", True), CheckResult("b", False, required=False)])
    assert ok is True, "an optional failure must not take the instance out of service"
    assert body["status"] == "degraded"
    assert body["failed_optional"] == ["b"]


def test_summarise_unhealthy_on_required_failure() -> None:
    body, ok = summarise("svc", [CheckResult("a", False), CheckResult("b", False, required=False)])
    assert ok is False
    assert body["status"] == "unhealthy"
    assert body["failed_required"] == ["a"]


# --- A5: prompt reload must reach the process that generates text ---------------------------


def test_reload_prompts_requires_admin_token(client: TestClient) -> None:
    assert client.post("/admin/reload-prompts").status_code == 401


def test_reload_prompts_fans_out_to_the_steps_process(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A5: the orchestrator is the only service that can reach the steps app (localhost-bound),
    so it owns that hop. Reloading only its own store would leave every prompt unchanged."""
    called: list[str] = []

    class _Resp:
        status_code = 200

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, int]:
            return {"loaded": 7}

    class _Client:
        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def post(self, url: str, **_: object) -> _Resp:
            called.append(url)
            return _Resp()

    monkeypatch.setattr(orch_main.httpx, "AsyncClient", lambda **_: _Client())
    r = client.post("/admin/reload-prompts", headers={"x-admin-token": "test-admin-token"})
    assert r.status_code == 200
    assert r.json()["steps_loaded"] == 7
    assert called and called[0].endswith("/admin/reload-prompts")
    assert "8030" in called[0], "must target the steps process, not itself"


def test_reload_prompts_reports_a_steps_failure(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed fan-out must be reported, not swallowed — otherwise prompt tuning silently no-ops."""

    class _Boom:
        async def __aenter__(self) -> _Boom:
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def post(self, *_: object, **__: object) -> None:
            raise RuntimeError("connection refused")

    monkeypatch.setattr(orch_main.httpx, "AsyncClient", lambda **_: _Boom())
    r = client.post("/admin/reload-prompts", headers={"x-admin-token": "test-admin-token"})
    assert r.status_code == 200
    assert "steps_error" in r.json()
    assert "connection refused" in r.json()["steps_error"]
