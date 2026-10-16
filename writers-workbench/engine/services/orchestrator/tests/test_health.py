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

    async def _worker_missing(**_: Any) -> CheckResult:
        return CheckResult(name="arq_worker", ok=False, detail="no heartbeat", required=False)

    async def _supabase_ok(**_: Any) -> CheckResult:
        return CheckResult(name="supabase", ok=True, required=False)

    monkeypatch.setattr(orch_main, "probe_redis", _redis_ok)
    monkeypatch.setattr(orch_main, "probe_arq_worker", _worker_missing)
    monkeypatch.setattr(orch_main, "probe_supabase", _supabase_ok)

    r = client.get("/admin/ready")
    assert r.status_code == 200
    assert r.json()["status"] == "degraded"
    assert r.json()["failed_optional"] == ["arq_worker"]


def test_ready_uses_the_same_key_the_worker_writes() -> None:
    """Reader/writer drift on the heartbeat key would silently always report 'no heartbeat'."""
    from orchestrator.worker import ARQ_HEALTH_CHECK_KEY, WorkerSettings

    assert WorkerSettings.health_check_key == ARQ_HEALTH_CHECK_KEY
    # arq's 3600s default would let a dead worker look alive for an hour.
    assert WorkerSettings.health_check_interval <= 60


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
