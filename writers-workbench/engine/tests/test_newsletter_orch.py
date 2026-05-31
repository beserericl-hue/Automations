"""L2 — newsletter orchestrator end-to-end with mocked step services.

We patch :class:`httpx.AsyncClient` to dispatch to the actual step apps in-process over an ASGI transport — same
trick the F0 library_retrieve test uses. The HITL gates auto-approve via a test hook so the saga flows
synchronously without a UI in the loop.
"""

from __future__ import annotations

import httpx
import pytest
from assemble_step.main import app as assemble_app
from deliver_step.main import app as deliver_app

# Import each step app so the ASGI transport can route to it
from gather_step.main import app as gather_app
from image_step.main import app as image_app
from persist_step.main import app as persist_app
from pick_step.main import app as pick_app
from render_step.main import app as render_app
from scrape_step.main import app as scrape_app
from segment_step.main import app as segment_app
from subject_step.main import app as subject_app

from orchestrator.newsletter_orch import NewsletterOrchestrator, set_resolution_hook
from writer_engine.schemas import Stage
from writer_engine.state_machine.hitl import ApprovalDecision, HitlGate
from writer_engine.state_machine.orchestrator import InMemoryStateStore

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
    """Point every step URL env var at an in-process host, and dispatch httpx to the right step app."""
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
        # Choose the transport per-request via a routing transport.
        kwargs.setdefault("transport", _RoutingTransport())
        # base_url unused because we always pass full URLs.
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", _init)


class _RoutingTransport(httpx.AsyncBaseTransport):
    """Route httpx requests to the matching step ASGI app."""

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


@pytest.mark.asyncio
async def test_newsletter_orch_runs_end_to_end(fake_redis) -> None:  # type: ignore[no-untyped-def]
    # Auto-approve every HITL gate as the UI would.
    async def auto_approve(gate: HitlGate) -> HitlGate:
        gate.decision = ApprovalDecision.APPROVE
        return gate

    set_resolution_hook(auto_approve)
    try:
        store = InMemoryStateStore()
        orch = NewsletterOrchestrator(store)
        eid = await orch.start(initial_state={"edition_id": "ai-news", "send_date": "2026-05-30"})
        result = await orch.run(
            eid,
            payload={"edition_id": "ai-news", "send_date": "2026-05-30", "max_stories": 2},
        )

        assert result["status"] == "sent"
        assert "send_row" in result
        assert "delivery" in result
        state = await store.load(eid)
        assert state.stage is Stage.SENT
    finally:
        set_resolution_hook(None)
