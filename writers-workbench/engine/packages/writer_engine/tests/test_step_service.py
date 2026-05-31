"""L1 — step service template wiring (auth + handler dispatch + error envelope)."""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app


async def _echo_handler(inp: StepInput) -> StepOutput:
    return StepOutput(execution_id=inp.execution_id, step_name=inp.step_name, payload={"echo": inp.payload})


async def _bad_handler(_: StepInput) -> StepOutput:
    raise RuntimeError("simulated handler failure")


@pytest.fixture
def echo_client() -> TestClient:
    app = build_step_app("test_step", _echo_handler)
    return TestClient(app)


def test_health_open(echo_client: TestClient) -> None:
    r = echo_client.get("/admin/health")
    assert r.status_code == 200
    assert r.json()["step"] == "test_step"


def test_metrics_open(echo_client: TestClient) -> None:
    r = echo_client.get("/metrics")
    assert r.status_code == 200
    # Prometheus exposition uses text/plain; version=0.0.4
    assert b"engine_http_requests_total" in r.content


def test_run_requires_service_secret(echo_client: TestClient) -> None:
    eid = str(uuid4())
    r = echo_client.post("/run", json={"execution_id": eid, "step_name": "test_step"})
    assert r.status_code == 401


def test_run_dispatches_handler(echo_client: TestClient) -> None:
    eid = str(uuid4())
    r = echo_client.post(
        "/run",
        json={"execution_id": eid, "step_name": "test_step", "payload": {"k": 1}},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == StepStatus.OK.value
    assert body["payload"] == {"echo": {"k": 1}}


def test_run_step_name_mismatch(echo_client: TestClient) -> None:
    eid = str(uuid4())
    r = echo_client.post(
        "/run",
        json={"execution_id": eid, "step_name": "wrong"},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 400


def test_run_handler_exception_returns_error_envelope() -> None:
    app = build_step_app("flaky_step", _bad_handler)
    client = TestClient(app)
    eid = str(uuid4())
    r = client.post(
        "/run",
        json={"execution_id": eid, "step_name": "flaky_step"},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 200  # the envelope itself is success; status field carries the error
    body = r.json()
    assert body["status"] == StepStatus.ERROR.value
    assert body["error"]["code"] == "RuntimeError"
