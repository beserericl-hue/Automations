"""What a newsletter issue carries to its readers — found by running a Content Studio issue end to end on
DEV 2026-11-03 (edition e2e-studio-lv3, execution 332ae413):

* the "Other top stories" roundup was the model's refusal ("I cannot complete this task… What I Need to
  Proceed") because a chosen issue leaves nothing to round up;
* the save failed (a one-send-per-user-per-day index) and the run still delivered and reported "sent";
* the first line read "Good morning, {{first_name | AI enthusiast}}." — nothing filled the merge tag.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from writer_engine.merge_tags import fill_merge_tags, first_name_of
from writer_engine.schemas import StepInput, StepOutput, StepStatus

# ----------------------------------------------------------------------------- merge tag


def test_the_first_name_tag_is_filled_with_the_name_or_its_fallback() -> None:
    text = "**Good morning, {{first_name | AI enthusiast}}.** Hi {{ FIRST_NAME }}!"
    assert fill_merge_tags(text, "Ada") == "**Good morning, Ada.** Hi Ada!"
    assert fill_merge_tags(text) == "**Good morning, AI enthusiast.** Hi there!"
    assert fill_merge_tags("{{subject}} stays") == "{{subject}} stays"
    assert first_name_of("Ada Lovelace") == "Ada"
    assert first_name_of("ada@example.com") is None and first_name_of(None) is None


@pytest.mark.asyncio
async def test_deliver_fills_the_tag_per_reader(monkeypatch: pytest.MonkeyPatch) -> None:
    from deliver_step import main as deliver

    sent: list[dict[str, Any]] = []

    class _Res:
        message_id = "m1"

    class _Postal:
        async def send(self, **kw: Any) -> _Res:
            sent.append(kw)
            return _Res()

        async def aclose(self) -> None:
            return None

    async def subscribers(_edition: str) -> list[dict[str, Any]]:
        return [
            {"email": "ada@example.invalid", "status": "active", "display_name": "Ada Lovelace"},
            {"email": "anon@example.invalid", "status": "active", "display_name": None},
        ]

    async def no_mark(*_a: Any, **_k: Any) -> None:
        return None

    class _Settings:
        postal_api_key = "k"
        newsletter_from_address = "news@example.com"

    monkeypatch.setattr(deliver, "PostalClient", _Postal)
    monkeypatch.setattr(deliver, "_fetch_subscribers", subscribers)
    monkeypatch.setattr(deliver, "_mark_sent", no_mark)
    monkeypatch.setattr(deliver, "get_settings", lambda: _Settings())
    out = await deliver.handler(
        StepInput(
            execution_id=uuid4(),
            step_name="deliver",
            payload={
                "edition_id": "ed",
                "send_id": "s",
                "subject": "Hi {{first_name | friend}}",
                "html_body": "<body><b>Good morning, {{first_name | AI enthusiast}}.</b></body>",
                "permalink_url": "https://example.com/view",
            },
        )
    )
    assert out.status is StepStatus.OK
    assert "Good morning, Ada." in sent[0]["html"] and sent[0]["subject"] == "Hi Ada"
    assert "Good morning, AI enthusiast." in sent[1]["html"] and sent[1]["subject"] == "Hi friend"
    assert all("{{" not in s["html"] for s in sent)


# ----------------------------------------------------------------------------- the roundup


class _Resp:
    def __init__(self, text: str) -> None:
        self.text = text


class _Router:
    def __init__(self, other: str) -> None:
        self.other = other
        self.prompts: list[str] = []

    async def complete(self, **kw: Any) -> _Resp:
        self.prompts.append(str(kw.get("prompt")))
        return _Resp(
            "**Good morning, {{first_name | AI enthusiast}}.** Intro."
            if len(self.prompts) == 1
            else self.other
        )


async def _assemble(
    monkeypatch: pytest.MonkeyPatch, remaining: list[dict[str, Any]], other: str
) -> tuple[Any, _Router]:
    from assemble_step import main as assemble

    router = _Router(other)
    monkeypatch.setattr(assemble, "get_router", lambda **_k: router)
    out = await assemble.handler(
        StepInput(
            execution_id=uuid4(),
            step_name="assemble",
            payload={
                "segments": [{"story_title": "Chosen", "newsletter_section_content": "Body."}],
                "remaining_items": remaining,
            },
        )
    )
    return out, router


@pytest.mark.asyncio
async def test_a_chosen_issue_with_nothing_left_has_no_roundup(monkeypatch: pytest.MonkeyPatch) -> None:
    out, router = await _assemble(monkeypatch, [], "I cannot complete this task as specified.")
    assert len(router.prompts) == 1  # the intro only: no roundup call with an empty list
    assert out.payload["other_top_stories"] == ""
    assert "Other top stories" not in out.payload["markdown_body"]


@pytest.mark.asyncio
async def test_a_roundup_reply_with_no_links_is_not_published(monkeypatch: pytest.MonkeyPatch) -> None:
    refusal = (
        "I appreciate the detailed instructions, but… ## What I Need to Proceed:\nPlease provide the list."
    )
    out, _ = await _assemble(monkeypatch, [{"id": "a", "title": "Left over"}], refusal)
    assert "What I Need to Proceed" not in out.payload["markdown_body"]
    linked = "- **Left over** — [Read](https://example.com/a)"
    out, _ = await _assemble(monkeypatch, [{"id": "a", "title": "Left over"}], linked)
    assert "## Other top stories" in out.payload["markdown_body"] and linked in out.payload["markdown_body"]


# ----------------------------------------------------------------------------- saving before sending


@pytest.mark.asyncio
async def test_a_send_that_could_not_be_saved_is_not_delivered(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    import orchestrator.newsletter_saga as saga_mod
    from orchestrator.newsletter_saga import NewsletterSagaDriver, SagaResult
    from writer_engine.schemas import Stage
    from writer_engine.state_machine.durable import InMemorySagaRepo

    calls: list[str] = []

    async def run_step(
        self: Any, st: Any, step: Any, *, execution_id: Any, payload: Any, **_k: Any
    ) -> StepOutput:
        name = str(getattr(step, "name", step))
        calls.append(name)
        if "render" in name:
            out: dict[str, Any] = {"html_body": "<p>{{first_name | reader}}</p>"}
            return StepOutput(execution_id=execution_id, step_name=name, status=StepStatus.OK, payload=out)
        if "persist" in name:
            return StepOutput(
                execution_id=execution_id,
                step_name=name,
                status=StepStatus.ERROR,
                error={"code": "23505", "message": "duplicate key (user_id, send_date)"},  # type: ignore[arg-type]
            )
        return StepOutput(execution_id=execution_id, step_name=name, status=StepStatus.OK, payload={})

    async def peek(*_a: Any) -> int:
        return 1

    monkeypatch.setattr(NewsletterSagaDriver, "_run_step", run_step)
    monkeypatch.setattr(saga_mod, "peek_issue_number", peek)
    repo = InMemorySagaRepo()
    driver = NewsletterSagaDriver(repo)
    eid = await driver.start(cfg={"edition_id": "ed", "send_date": "2026-11-03", "user_id": "+1"})
    await repo.update(
        eid,
        stage=Stage.RENDERING,
        patch={
            "subject_proposal": {"subject_line": "S", "pre_header_text": "P", "subject_line_reasoning": "r"},
            "assembled": {"intro": "", "segments": [], "other_top_stories": "", "markdown_body": "x"},
            "picked": {"top_selected_stories": [], "chain_of_thought": ""},
        },
    )
    assert await driver.advance(eid) is SagaResult.ERROR
    assert (await repo.load(eid)).stage is Stage.ERROR
    assert any("persist" in c for c in calls), calls  # it got as far as the save
    assert not any("deliver" in c for c in calls)
