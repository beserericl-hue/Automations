"""L3 — durable newsletter saga end-to-end with auto-resolved gates.

Drives :class:`NewsletterSagaDriver` against an :class:`InMemorySagaRepo` + the same in-process routing transport
the synchronous E2E test uses. After every advance() the test grabs the latest pending HITL token and resolves
it with ``approve``, then advance()s again — simulating the UI's resolve POST.

Together this proves the durable resume model: each advance() persists state, gates pause cleanly, and the
saga reaches ``SENT`` over multiple driver calls (the same pattern an arq worker uses in production).
"""

from __future__ import annotations

import httpx
import pytest
from assemble_step.main import app as assemble_app
from deliver_step.main import app as deliver_app
from gather_step.main import app as gather_app
from image_step.main import app as image_app
from persist_step.main import app as persist_app
from pick_step.main import app as pick_app
from render_step.main import app as render_app
from scrape_step.main import app as scrape_app
from segment_step.main import app as segment_app
from subject_step.main import app as subject_app

from orchestrator.newsletter_saga import NewsletterSagaDriver, SagaResult
from writer_engine.schemas import Stage
from writer_engine.state_machine.durable import InMemorySagaRepo
from writer_engine.state_machine.hitl import ApprovalDecision, _in_memory, resolve_approval

STEP_URL_TO_APP = {
    "http://gather-step": gather_app,
    "http://pick-step": pick_app,
    "http://subject-step": subject_app,
    "http://scrape-step": scrape_app,
    "http://segment-step": segment_app,
    "http://image-step": image_app,
    "http://assemble-step": assemble_app,
    "http://render-step": render_app,
    "http://persist-step": persist_app,
    "http://deliver-step": deliver_app,
}


@pytest.fixture(autouse=True)
def _patch_step_urls_and_httpx(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "GATHER",
        "PICK",
        "SUBJECT",
        "SCRAPE",
        "SEGMENT",
        "IMAGE",
        "ASSEMBLE",
        "RENDER",
        "PERSIST",
        "DELIVER",
    ):
        monkeypatch.setenv(f"{name}_STEP_URL", f"http://{name.lower()}-step")

    real_init = httpx.AsyncClient.__init__

    def _init(self: httpx.AsyncClient, *args: object, **kwargs: object) -> None:
        kwargs.setdefault("transport", _RoutingTransport())
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", _init)


class _RoutingTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self._asgi_transports: dict[str, httpx.ASGITransport] = {
            host: httpx.ASGITransport(app=app) for host, app in STEP_URL_TO_APP.items()
        }

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = f"{request.url.scheme}://{request.url.host}"
        transport = self._asgi_transports.get(host)
        if transport is None:
            return httpx.Response(404, text=f"no in-process app for {host}")
        return await transport.handle_async_request(request)


@pytest.fixture(autouse=True)
def _clear_hitl_state() -> None:
    _in_memory.clear()


@pytest.mark.asyncio
async def test_durable_saga_runs_through_three_gates(fake_redis) -> None:  # type: ignore[no-untyped-def]
    repo = InMemorySagaRepo()
    driver = NewsletterSagaDriver(repo)
    eid = await driver.start(
        cfg={"edition_id": "ai-news", "send_date": "2026-05-30", "user_id": "+1", "max_stories": 2}
    )

    # Round 1: advance through GATHERING -> PICKING -> AWAITING_STORIES_APPROVAL.
    result = await driver.advance(eid)
    assert result is SagaResult.PAUSED
    state = await repo.load(eid)
    assert state.stage is Stage.AWAITING_STORIES_APPROVAL
    stories_token = state.state["stories_gate_token"]

    # The UI's resolve endpoint would call resolve_approval + driver.apply_decision + driver.advance.
    await resolve_approval(stories_token, decision=ApprovalDecision.APPROVE)
    await driver.apply_decision(
        eid, gate_stage="awaiting_stories_approval", decision=ApprovalDecision.APPROVE, feedback=None
    )

    # Round 2: STORIES_APPROVED -> SUBJECT -> AWAITING_SUBJECT_APPROVAL.
    result = await driver.advance(eid)
    assert result is SagaResult.PAUSED
    state = await repo.load(eid)
    assert state.stage is Stage.AWAITING_SUBJECT_APPROVAL
    subject_token = state.state["subject_gate_token"]

    await resolve_approval(subject_token, decision=ApprovalDecision.APPROVE)
    await driver.apply_decision(
        eid, gate_stage="awaiting_subject_approval", decision=ApprovalDecision.APPROVE, feedback=None
    )

    # Round 3: SUBJECT_APPROVED -> WRITING_SEGMENTS -> PROPOSING_IMAGES -> AWAITING_IMAGE_APPROVAL.
    result = await driver.advance(eid)
    assert result is SagaResult.PAUSED
    state = await repo.load(eid)
    assert state.stage is Stage.AWAITING_IMAGE_APPROVAL
    image_token = state.state["image_gate_token"]

    await resolve_approval(image_token, decision=ApprovalDecision.APPROVE)
    await driver.apply_decision(
        eid,
        gate_stage="awaiting_image_approval",
        decision=ApprovalDecision.APPROVE,
        feedback=None,
        chosen_images={},
    )

    # Round 4: IMAGES_APPROVED -> ASSEMBLING -> RENDERING -> SAVED -> SENDING -> SENT.
    result = await driver.advance(eid)
    assert result is SagaResult.DONE
    state = await repo.load(eid)
    assert state.stage is Stage.SENT
    assert state.state.get("delivery") is not None


@pytest.mark.asyncio
async def test_durable_saga_revision_loop(fake_redis) -> None:  # type: ignore[no-untyped-def]
    """A 'revise' decision on the stories gate re-runs PICKING with the feedback in state."""
    repo = InMemorySagaRepo()
    driver = NewsletterSagaDriver(repo)
    eid = await driver.start(
        cfg={"edition_id": "e", "send_date": "2026-05-30", "user_id": "+1", "max_stories": 2}
    )

    await driver.advance(eid)  # → AWAITING_STORIES_APPROVAL
    state = await repo.load(eid)
    assert state.stage is Stage.AWAITING_STORIES_APPROVAL

    # Revise once with feedback.
    await driver.apply_decision(
        eid,
        gate_stage="awaiting_stories_approval",
        decision=ApprovalDecision.REVISE,
        feedback="please focus on AI policy",
    )
    state = await repo.load(eid)
    assert state.stage is Stage.PICKING
    assert state.state["pick_feedback"] == "please focus on AI policy"
    assert state.state["revision_counts"]["stories"] == 1

    # Advance again: should re-run pick + go back to AWAITING_STORIES_APPROVAL.
    await driver.advance(eid)
    state = await repo.load(eid)
    assert state.stage is Stage.AWAITING_STORIES_APPROVAL
