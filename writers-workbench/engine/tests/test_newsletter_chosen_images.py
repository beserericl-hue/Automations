"""The image gate's choice reaches the email (2026-11-03).

The Workbench never sent a choice (no picker, and its resolve route dropped ``chosen_images``), so
the engine side had never been exercised by a real decision. Now that it is: the chosen image must be
one the gate offered (it is put in front of every subscriber), "" means "no image", and the choice is
what the assembled markdown carries.
"""

from __future__ import annotations

from typing import Any

import pytest

import orchestrator.newsletter_saga as saga_mod
from orchestrator.newsletter_saga import NewsletterSagaDriver
from writer_engine.schemas import Stage, StepOutput, StepStatus
from writer_engine.state_machine.durable import InMemorySagaRepo
from writer_engine.state_machine.hitl import ApprovalDecision, _in_memory

A = "https://img.example/a.png"
B = "https://img.example/b.png"
C = "https://img.example/c.png"


@pytest.fixture(autouse=True)
def _clear() -> None:
    _in_memory.clear()


async def _at_image_gate(
    monkeypatch: pytest.MonkeyPatch, *, section_title: str | None = None
) -> tuple[Any, Any, Any, list[dict[str, Any]]]:
    async def selection(cfg: dict[str, Any], execution_id: Any) -> list[dict[str, Any]]:
        return [{"id": "ci1", "key": "k1", "title": "Story one", "image_urls": [A, B, C], "_summary": "a"}]

    async def count(_e: str) -> int:
        return 0

    assembled: list[dict[str, Any]] = []

    async def run_step(self: Any, st: Any, step: Any, *, execution_id: Any, payload: Any, **_k: Any) -> Any:
        name = str(getattr(step, "name", step))
        out: dict[str, Any] = {}
        if name == "subject":
            out = {"subject_line": "S", "pre_header_text": "P"}
        elif name == "scrape":
            out = {"scraped": []}
        elif name == "image":
            opts = list(payload["scraped_images"])
            out = {"story_title": payload["story"]["title"], "options": opts, "auto_pick": opts[0]}
        elif name == "segment":
            # The section writer picked the first option itself.
            out = {
                "story_title": section_title or payload["story"]["title"],
                "newsletter_section_content": "x",
                "chosen_image_url": A,
            }
        elif name == "assemble":
            assembled.append(payload)
            segs = payload["segments"]
            md = "\n".join(f"![]({s['chosen_image_url']})" for s in segs if s.get("chosen_image_url"))
            out = {"intro": "i", "segments": segs, "markdown_body": md}
        elif name == "render":
            out = {"html_body": "<html></html>"}
        elif name == "persist":
            out = {"send_row": {"id": "send-1"}}
        return StepOutput(execution_id=execution_id, step_name=name, status=StepStatus.OK, payload=out)

    monkeypatch.setattr(saga_mod, "_studio_selection", selection)
    monkeypatch.setattr(saga_mod, "count_active_subscribers", count)
    monkeypatch.setattr(NewsletterSagaDriver, "_run_step", run_step)
    repo = InMemorySagaRepo()
    driver = NewsletterSagaDriver(repo)
    eid = await driver.start(cfg={"edition_id": "e", "send_date": "2026-11-03", "user_id": "+1"})
    await driver.advance(eid)
    for gate in ("awaiting_stories_approval", "awaiting_subject_approval"):
        await driver.apply_decision(eid, gate_stage=gate, decision=ApprovalDecision.APPROVE, feedback=None)
        await driver.advance(eid)
    assert (await repo.load(eid)).stage is Stage.AWAITING_IMAGE_APPROVAL
    return driver, repo, eid, assembled


async def _approve(driver: Any, eid: Any, chosen: Any) -> None:
    await driver.apply_decision(
        eid,
        gate_stage="awaiting_image_approval",
        decision=ApprovalDecision.APPROVE,
        feedback=None,
        chosen_images=chosen,
    )
    await driver.advance(eid)


@pytest.mark.asyncio
async def test_a_non_default_choice_is_the_image_in_the_assembled_email(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    driver, repo, eid, assembled = await _at_image_gate(monkeypatch)
    await _approve(driver, eid, {"Story one": C})
    assert assembled[0]["segments"][0]["chosen_image_url"] == C
    assert (await repo.load(eid)).stage is Stage.AWAITING_SEND_APPROVAL


@pytest.mark.asyncio
async def test_a_choice_reaches_a_section_whose_writer_rewrote_the_title(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    """Found verifying live on DEV (run d75ad9db): the section writer titled "Story 1" as "Send Gate
    Check: What We Learned", so the reviewer's pick, keyed by the gate's story title, was dropped and
    the email kept the section's own image. Options and sections pair by position."""
    driver, _repo, eid, assembled = await _at_image_gate(monkeypatch, section_title="A Rewritten Headline")
    await _approve(driver, eid, {"Story one": C})
    assert assembled[0]["segments"][0]["story_title"] == "A Rewritten Headline"
    assert assembled[0]["segments"][0]["chosen_image_url"] == C


@pytest.mark.asyncio
async def test_a_choice_keyed_by_the_sections_own_title_still_applies(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    driver, _repo, eid, assembled = await _at_image_gate(monkeypatch, section_title="A Rewritten Headline")
    await _approve(driver, eid, {"A Rewritten Headline": B})
    assert assembled[0]["segments"][0]["chosen_image_url"] == B


@pytest.mark.asyncio
async def test_an_image_the_gate_did_not_offer_is_refused(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    driver, _repo, eid, assembled = await _at_image_gate(monkeypatch)
    await _approve(driver, eid, {"Story one": "https://evil.example/tracker.png"})
    assert assembled[0]["segments"][0]["chosen_image_url"] == A  # the section's own pick stands


@pytest.mark.asyncio
async def test_an_empty_choice_means_no_image(monkeypatch: pytest.MonkeyPatch, fake_redis: Any) -> None:
    driver, _repo, eid, assembled = await _at_image_gate(monkeypatch)
    await _approve(driver, eid, {"Story one": ""})
    assert assembled[0]["segments"][0]["chosen_image_url"] is None


@pytest.mark.asyncio
async def test_a_malformed_choice_is_ignored(monkeypatch: pytest.MonkeyPatch, fake_redis: Any) -> None:
    driver, _repo, eid, assembled = await _at_image_gate(monkeypatch)
    await _approve(driver, eid, ["not", "a", "map"])
    assert assembled[0]["segments"][0]["chosen_image_url"] == A


@pytest.mark.asyncio
async def test_the_assemble_step_puts_the_chosen_image_in_the_markdown() -> None:
    from uuid import uuid4

    from assemble_step import main as assemble

    from writer_engine.schemas import StepInput

    out = await assemble.handler(
        StepInput(
            execution_id=uuid4(),
            step_name="assemble",
            payload={
                "segments": [
                    {"story_title": "Story one", "newsletter_section_content": "Body.", "chosen_image_url": C}
                ],
                "remaining_items": [],
            },
        )
    )
    assert f"![]({C})" in out.payload["markdown_body"]
