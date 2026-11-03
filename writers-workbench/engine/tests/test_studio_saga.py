"""The newsletter saga with a Content Studio selection: the chosen stories ARE the issue (no gather, no
LLM pick), and the publisher uses a post's chosen image instead of a sketchnote."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

import orchestrator.newsletter_saga as saga_mod
from orchestrator.newsletter_saga import NewsletterSagaDriver, SagaResult
from writer_engine.schemas import Stage
from writer_engine.state_machine.durable import InMemorySagaRepo
from writer_engine.state_machine.hitl import _in_memory


@pytest.fixture(autouse=True)
def _clear_hitl_state() -> None:
    _in_memory.clear()


@pytest.mark.asyncio
async def test_a_studio_selection_skips_gather_and_pick(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    chosen = [
        {
            "id": "ci2",
            "key": "2026-11-06/b.ai-dev-roundup",
            "user_id": "+1",
            "type": "article",
            "title": "Second chosen",
            "source_url": "https://b",
            "_summary": "b",
        },
        {
            "id": "ci1",
            "key": "2026-11-06/a.ai-dev-roundup",
            "user_id": "+1",
            "type": "article",
            "title": "First chosen",
            "source_url": None,
            "_summary": "a",
        },
    ]
    seen: dict[str, Any] = {}

    async def selection(cfg: dict[str, Any], execution_id: Any) -> list[dict[str, Any]]:
        seen["cfg"] = cfg
        return chosen

    async def no_steps(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("gather / pick must not run for a chosen selection")

    monkeypatch.setattr(saga_mod, "_studio_selection", selection)
    monkeypatch.setattr(NewsletterSagaDriver, "_run_step", no_steps)
    repo = InMemorySagaRepo()
    driver = NewsletterSagaDriver(repo)
    eid = await driver.start(cfg={"edition_id": "ai-dev-roundup", "send_date": "2026-11-06", "user_id": "+1"})
    assert await driver.advance(eid) is SagaResult.PAUSED
    state = await repo.load(eid)
    assert state.stage is Stage.AWAITING_STORIES_APPROVAL
    stories = state.state["picked"]["top_selected_stories"]
    assert [s["title"] for s in stories] == ["Second chosen", "First chosen"]
    assert stories[0]["identifiers"] == ["ci2"] and stories[0]["external_source_links"] == ["https://b"]
    assert seen["cfg"]["edition_id"] == "ai-dev-roundup"


@pytest.mark.asyncio
async def test_the_publisher_uses_a_chosen_image_and_says_so_in_a_dry_run() -> None:
    from writer_engine.integrations import UserCredentials
    from writer_engine.social import channels as ch
    from writer_engine.social import poster

    chan = ch.Channel(user_id="+1", channel="website", kind="website", label="w", config={}, enabled=True)
    async with httpx.AsyncClient() as http:
        t = poster.Transport(http=http)
        cover, media, note = await poster._cover(
            t,
            {"include_image": True, "image_url": "https://img.example/x.png", "title": "T", "body_md": ""},
            [chan],
            live=False,
            creds=UserCredentials(user_id="+1"),
        )
    assert cover is None and media is None and "chosen image https://img.example/x.png" in note
