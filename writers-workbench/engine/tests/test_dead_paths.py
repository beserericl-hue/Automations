"""A9/A10 — paths that silently succeeded must not be reachable.

Both of these returned (or would return) a plausible success while doing the wrong thing, which is
the same failure class as A1: the user cannot tell that nothing real happened.
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from writer_engine.schemas import StepInput, StepStatus

SECRET = "test-secret"


# --- A9: brainstorm.chapter returned {"beats": []} unconditionally ---------------------------


async def test_brainstorm_chapter_op_is_gone() -> None:
    from brainstorm_step.main import OPS, handler

    assert "chapter" not in OPS, "the stub that returned empty beats must stay removed"

    out = await handler(
        StepInput(
            execution_id=uuid.uuid4(),
            step_name="brainstorm",
            payload={"op": "chapter", "chapter_number": 3},
        )
    )
    assert out.status is StepStatus.ERROR
    assert out.error is not None
    assert out.error.code == "UNKNOWN_OP"


async def test_brainstorm_still_serves_its_real_ops() -> None:
    from brainstorm_step.main import OPS

    for op in ("story", "short-story", "edit-outline", "revise-outline", "create-project"):
        assert op in OPS


# --- A10: the sync newsletter route auto-approves every HITL gate ----------------------------


def test_sync_newsletter_route_refuses_outside_tests() -> None:
    """It auto-resolves the stories/subject/images gates — sending with no human review."""
    from orchestrator.main import app
    from orchestrator.newsletter_orch import resolution_hook_installed, set_resolution_hook

    set_resolution_hook(None)
    assert resolution_hook_installed() is False
    try:
        r = TestClient(app).post(
            "/pipelines/newsletter/run",
            headers={"x-service-secret": SECRET},
            json={"edition_id": "e1"},
        )
        assert r.status_code == 410
        assert "run-durable" in r.json()["detail"]
    finally:
        set_resolution_hook(None)


def test_sync_newsletter_route_is_available_with_the_test_hook() -> None:
    """The L2 test path must keep working."""
    from orchestrator.newsletter_orch import resolution_hook_installed, set_resolution_hook

    set_resolution_hook(lambda *a, **k: None)
    try:
        assert resolution_hook_installed() is True
    finally:
        set_resolution_hook(None)


def test_durable_route_is_the_production_path() -> None:
    """Guard the wiring: the gateway must forward newsletter generation to run-durable."""
    from pathlib import Path

    src = Path("services/gateway/src/gateway/routes/internal.py").read_text()
    assert "/pipelines/newsletter/run-durable" in src
    assert '/pipelines/newsletter/run"' not in src, "gateway must not call the test-only route"
