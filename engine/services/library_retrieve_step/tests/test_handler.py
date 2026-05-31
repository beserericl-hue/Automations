"""L1 — the library_retrieve handler returns fixture items when Supabase isn't configured."""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from library_retrieve_step.main import app, handler
from writer_engine.schemas import StepInput, StepStatus


@pytest.mark.asyncio
async def test_handler_returns_fixture_items(fake_redis) -> None:  # type: ignore[no-untyped-def]
    out = await handler(
        StepInput(
            execution_id=uuid4(),
            step_name="library_retrieve",
            payload={"user_id": "u1", "limit": 5},
        )
    )
    assert out.status is StepStatus.OK
    assert out.payload["count"] >= 1
    assert all(item["user_id"] == "u1" for item in out.payload["items"])


def test_step_health() -> None:
    client = TestClient(app)
    r = client.get("/admin/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "step": "library_retrieve"}
