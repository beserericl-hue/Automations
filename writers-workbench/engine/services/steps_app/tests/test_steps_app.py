"""B10 — the aggregator must expose every step at exactly the URL the orchestrator dials.

``run_step_via_http`` POSTs ``{<NAME>_STEP_URL}/run``, so for a mounted step that is
``/steps/<name>/run``. If a mount path and the exported URL ever disagree, every call to that step
404s — which is why these are asserted against the shared registry rather than hand-written paths.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from steps_app.main import STEP_APPS, app, mount_path
from writer_engine.runtime_processes import STEP_NAMES

SECRET = "test-secret"  # conftest sets SERVICE_SHARED_SECRET to this


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_aggregator_health(client: TestClient) -> None:
    r = client.get("/admin/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "steps", "steps": len(STEP_APPS)}


@pytest.mark.parametrize("name", STEP_NAMES)
def test_every_step_health_is_reachable_at_its_mount(client: TestClient, name: str) -> None:
    """This is the exact URL /admin/health probes (B2) once the steps are collapsed."""
    r = client.get(f"{mount_path(name)}/admin/health")
    assert r.status_code == 200, f"{name} not reachable at {mount_path(name)}"
    assert r.json()["step"] == name


@pytest.mark.parametrize("name", STEP_NAMES)
def test_every_step_run_requires_the_service_secret(client: TestClient, name: str) -> None:
    """Mounting must not drop the sub-app's auth dependency."""
    r = client.post(f"{mount_path(name)}/run", json={})
    assert r.status_code == 401, f"{name}/run is unauthenticated"


def test_run_dispatches_to_the_right_step(client: TestClient) -> None:
    """A real step contract through the mount: the step_name guard proves routing is correct."""
    r = client.post(
        f"{mount_path('library')}/run",
        headers={"x-service-secret": SECRET},
        json={
            "execution_id": str(uuid.uuid4()),
            "step_name": "library",
            "payload": {"op": "list-outlines"},
        },
    )
    assert r.status_code == 200
    assert r.json()["step_name"] == "library"


def test_mount_rejects_a_mismatched_step_name(client: TestClient) -> None:
    """Posting library's payload to chapter's mount must 400, not silently run the wrong step."""
    r = client.post(
        f"{mount_path('chapter')}/run",
        headers={"x-service-secret": SECRET},
        json={
            "execution_id": str(uuid.uuid4()),
            "step_name": "library",
            "payload": {"op": "list-outlines"},
        },
    )
    assert r.status_code == 400
    assert "step_name mismatch" in r.json()["detail"]


def test_unknown_mount_404s(client: TestClient) -> None:
    r = client.get("/steps/not_a_step/admin/health")
    assert r.status_code == 404


def test_reload_prompts_requires_admin_token(client: TestClient) -> None:
    assert client.post("/admin/reload-prompts").status_code == 401
