"""L2 — orchestrator runs the library.retrieve pipeline; step service is in-process via ASGI httpx transport."""

from __future__ import annotations

import os

import httpx
import pytest
from fastapi.testclient import TestClient

from library_retrieve_step.main import app as step_app
from orchestrator.library_orch import LibraryRetrieveOrchestrator
from writer_engine.schemas import Stage
from writer_engine.state_machine.orchestrator import InMemoryStateStore


@pytest.fixture(autouse=True)
def _patch_httpx_to_inprocess_step(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make ``httpx.AsyncClient`` POST to the step app over an in-process ASGI transport."""
    transport = httpx.ASGITransport(app=step_app)
    real_init = httpx.AsyncClient.__init__

    def _init(self: httpx.AsyncClient, *args: object, **kwargs: object) -> None:
        kwargs.setdefault("transport", transport)
        kwargs.setdefault("base_url", "http://library-retrieve-step")
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", _init)
    os.environ["LIBRARY_RETRIEVE_STEP_URL"] = "http://library-retrieve-step"


@pytest.mark.asyncio
async def test_orchestrator_runs_library_retrieve(fake_redis, _no_progress_publish: list[dict]) -> None:  # type: ignore[no-untyped-def]
    store = InMemoryStateStore()
    orch = LibraryRetrieveOrchestrator(store, step_url="http://library-retrieve-step")
    eid = await orch.start(initial_state={"user_id": "u1", "limit": 3})
    result = await orch.run(eid, payload={"user_id": "u1", "limit": 3})

    assert result["status"] == "ok"
    assert len(result["items"]) >= 1
    state = await store.load(eid)
    assert state.stage is Stage.SAVED
    # SSE events: at least INIT + GATHERING + SAVED
    stages = {ev["stage"] for ev in _no_progress_publish}
    assert {Stage.INIT.value, Stage.GATHERING.value, Stage.SAVED.value}.issubset(stages)


def test_orchestrator_health() -> None:
    from orchestrator.main import app as orch_app

    client = TestClient(orch_app)
    r = client.get("/admin/health")
    assert r.status_code == 200
    assert r.json()["service"] == "orchestrator"
