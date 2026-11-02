"""E6 coverage + rejection economics.

* A ``structure_collapsed`` chunk is retried ONCE in HUMANIZE_COLLAPSE_RETRY_MODE (default Medium)
  before the original is kept; ``terms_lost`` is never retried.
* A rewrite that drops a link is rejected (``links_lost``).
* The newsletter saga's story sections and the radar-drafted calendar posts are humanized, with the
  spend ceiling applied across the whole job, LinkedIn's character cap, a per-surface switch, and the
  outcome recorded.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from segment_step import main as segment_main

from orchestrator.newsletter_saga import _humanize_budget_left, _humanize_summary
from writer_engine import humanize as hz
from writer_engine.config import get_settings
from writer_engine.radar import drafts
from writer_engine.schemas import StepInput
from writer_engine.social.schedule import row_for

PARAS = "\n\n".join(f"Paragraph {n} talks about the harbour at Ugarit and its trade." for n in range(6))


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("STEALTHGPT_API_KEY", "test-token")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class _Stub:
    """Per-mode canned answers: 'collapse' merges every paragraph, 'keep' keeps the structure."""

    def __init__(self, by_mode: dict[str, str], *, words: int = 100) -> None:
        self.by_mode = by_mode
        self.words = words
        self.modes: list[str] = []

    async def __call__(self, chunk: str, **kw: Any) -> dict[str, Any]:
        mode = kw["mode"]
        self.modes.append(mode)
        how = self.by_mode.get(mode, "keep")
        if how == "collapse":
            result = " ".join(chunk.split("\n\n"))
        elif how == "drop_term":
            result = chunk.replace("Ugarit", "the city")
        else:
            result = chunk.replace("talks about", "covers")
        return {"result": result, "wordsSpent": self.words, "meteredChargedCredits": self.words}


def _use(monkeypatch: pytest.MonkeyPatch, stub: _Stub) -> _Stub:
    monkeypatch.setattr(hz, "_stealthify", stub)
    return stub


# --- the collapse retry ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_collapsed_chunk_is_retried_once_in_medium_and_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _use(monkeypatch, _Stub({"Low": "collapse", "Medium": "keep"}))
    out = await hz.humanize_text(PARAS, protect=["Ugarit"])
    assert stub.modes == ["Low", "Medium"]
    assert out.humanized_chunks == 1
    assert out.rejected == {}
    assert out.retried == {0: "Medium:accepted"}
    assert "covers" in out.text
    assert out.words_spent == 200  # both calls billed
    assert out.as_report()["retried"] == {0: "Medium:accepted"}


@pytest.mark.asyncio
async def test_a_retry_that_also_fails_keeps_the_original(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _use(monkeypatch, _Stub({"Low": "collapse", "Medium": "collapse"}))
    out = await hz.humanize_text(PARAS, protect=["Ugarit"])
    assert stub.modes == ["Low", "Medium"]
    assert out.humanized_chunks == 0
    assert out.rejected[0].startswith("structure_collapsed:6->1;retry_Medium:structure_collapsed")
    assert out.retried[0].startswith("Medium:structure_collapsed")
    assert out.text == PARAS


@pytest.mark.asyncio
async def test_terms_lost_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _use(monkeypatch, _Stub({"Low": "drop_term"}))
    out = await hz.humanize_text(PARAS, protect=["Ugarit"])
    assert stub.modes == ["Low"]
    assert out.rejected[0].startswith("terms_lost:Ugarit")
    assert out.retried == {}


@pytest.mark.asyncio
async def test_no_retry_when_disabled_or_same_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUMANIZE_COLLAPSE_RETRY_MODE", "")
    get_settings.cache_clear()
    stub = _use(monkeypatch, _Stub({"Low": "collapse"}))
    await hz.humanize_text(PARAS)
    assert stub.modes == ["Low"]

    monkeypatch.setenv("HUMANIZE_COLLAPSE_RETRY_MODE", "low")
    get_settings.cache_clear()
    stub = _use(monkeypatch, _Stub({"Low": "collapse"}))
    await hz.humanize_text(PARAS)
    assert stub.modes == ["Low"]


@pytest.mark.asyncio
async def test_no_retry_once_the_ceiling_is_spent(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _use(monkeypatch, _Stub({"Low": "collapse", "Medium": "keep"}, words=500))
    out = await hz.humanize_text(PARAS, budget_words=400)
    assert stub.modes == ["Low"]
    assert 0 in out.rejected


@pytest.mark.asyncio
async def test_an_explicit_zero_budget_means_spent_not_unlimited(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _use(monkeypatch, _Stub({}))
    out = await hz.humanize_text(PARAS, budget_words=0)
    assert stub.modes == []
    assert out.stopped_at_budget
    assert out.text == PARAS


# --- links ----------------------------------------------------------------------------------------


def test_a_rewrite_that_drops_a_link_is_rejected() -> None:
    original = "Read the piece at https://example.com/a-story. It is good."
    assert hz.judge_rewrite(original, "Read the piece. It is good.") == "links_lost:1"
    assert hz.judge_rewrite(original, "The piece is at https://example.com/a-story and it is good.") == ""
    md = "[Get your MVP built](https://www.techahir.com/3day-mvp)"
    assert hz.judge_rewrite(md, "[Get an MVP](https://www.techahir.com/3day-mvp)") == ""


# --- newsletter segment ---------------------------------------------------------------------------


async def _fake_write(*args: Any, **kwargs: Any) -> Any:
    return segment_main.StorySegment(story_title="Ugarit", newsletter_section_content=PARAS)


def _seg_input(**payload: Any) -> StepInput:
    return StepInput(
        execution_id=uuid4(), step_name="segment", payload={"story": {"title": "Ugarit"}, **payload}
    )


@pytest.mark.asyncio
async def test_the_newsletter_section_is_humanized_and_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, _Stub({"Low": "keep"}))
    monkeypatch.setattr(segment_main, "_write", _fake_write)
    out = await segment_main.handler(_seg_input(humanize_budget_words=5000))
    assert "covers" in out.payload["newsletter_section_content"]
    assert out.payload["humanize"]["applied"] is True
    assert out.payload["humanize"]["content_type"] == "newsletter_segment"


@pytest.mark.asyncio
async def test_the_section_switch_and_the_per_run_opt_out(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _use(monkeypatch, _Stub({"Low": "keep"}))
    monkeypatch.setattr(segment_main, "_write", _fake_write)
    out = await segment_main.handler(_seg_input(humanize=False))
    assert out.payload["humanize"] is None
    monkeypatch.setenv("HUMANIZE_NEWSLETTER_SEGMENTS", "false")
    get_settings.cache_clear()
    out = await segment_main.handler(_seg_input())
    assert out.payload["humanize"] is None
    assert out.payload["newsletter_section_content"] == PARAS
    assert stub.modes == []


@pytest.mark.asyncio
async def test_a_spent_newsletter_budget_stops_the_next_section(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _use(monkeypatch, _Stub({"Low": "keep"}))
    monkeypatch.setattr(segment_main, "_write", _fake_write)
    out = await segment_main.handler(_seg_input(humanize_budget_words=0))
    assert stub.modes == []
    assert out.payload["humanize"]["stopped_at_budget"] is True
    assert out.payload["humanize"]["applied"] is False


def test_saga_budget_and_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUMANIZE_MAX_WORDS_PER_RUN", "1000")
    get_settings.cache_clear()
    segs = [
        {
            "story_title": "A",
            "humanize": {"applied": True, "words_spent": 300, "chunks": 1, "humanized_chunks": 1},
        },
        {
            "story_title": "B",
            "humanize": {"applied": False, "words_spent": 900, "rejected": {"0": "terms_lost:X"}},
        },
        {"story_title": "C", "humanize": None},
    ]
    assert _humanize_budget_left(segs[:1]) == 700
    assert _humanize_budget_left(segs) == 0
    summary = _humanize_summary(segs)["humanize"]
    assert summary["applied"] is True
    assert summary["words_spent"] == 1200
    assert [s["story_title"] for s in summary["sections"]] == ["A", "B"]
    assert _humanize_summary([{"story_title": "x"}]) == {}
    monkeypatch.setenv("HUMANIZE_MAX_WORDS_PER_RUN", "0")
    get_settings.cache_clear()
    assert _humanize_budget_left(segs) is None


# --- radar drafts ---------------------------------------------------------------------------------


def _blog_post() -> dict[str, Any]:
    return {
        "title": "Ugarit",
        "body_md": PARAS + "\n\n[Get your MVP built](https://www.techahir.com/3day)",
        "linkedin_content": PARAS,
        "item_type": "blog",
    }


@pytest.mark.asyncio
async def test_radar_drafts_are_humanized_and_recorded_on_the_row(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, _Stub({"Low": "keep"}))
    posts = [_blog_post()]
    summary = await drafts.humanize_drafts(posts)
    assert summary == {"posts": 1, "applied": 1, "words_spent": 200}
    assert "covers" in posts[0]["body_md"]
    assert "https://www.techahir.com/3day" in posts[0]["body_md"]
    assert posts[0]["humanize"]["applied"] is True
    assert set(posts[0]["humanize"]) == {"applied", "body_md", "linkedin_content"}
    from datetime import date

    row = row_for(
        "+1",
        {**posts[0], "channels": ["website"]},
        date(2026, 11, 3),
        "morning",
        source="trend_batch",
        prefix="batch",
    )
    assert row["humanize"]["applied"] is True
    assert "humanize" not in row_for(
        "+1", {"title": "t"}, date(2026, 11, 3), "morning", source="manual", prefix="m"
    )


@pytest.mark.asyncio
async def test_a_linkedin_rewrite_over_the_cap_keeps_the_draft(monkeypatch: pytest.MonkeyPatch) -> None:
    long_tail = " extra" * 600

    class _Grows(_Stub):
        async def __call__(self, chunk: str, **kw: Any) -> dict[str, Any]:
            out = await super().__call__(chunk, **kw)
            out["result"] = out["result"] + long_tail
            return out

    _use(monkeypatch, _Grows({"Low": "keep"}))
    post = {"title": "t", "body_md": "", "linkedin_content": PARAS}
    await drafts.humanize_drafts([post])
    assert post["linkedin_content"] == PARAS
    assert post["humanize"]["applied"] is False
    assert post["humanize"]["linkedin_content"]["rejected_for_length"]["limit"] == drafts.LINKEDIN_CHAR_LIMIT


@pytest.mark.asyncio
async def test_the_ceiling_holds_across_the_whole_slate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUMANIZE_MAX_WORDS_PER_RUN", "250")
    get_settings.cache_clear()
    stub = _use(monkeypatch, _Stub({"Low": "keep"}))
    posts = [{"title": f"p{n}", "body_md": "", "linkedin_content": PARAS} for n in range(5)]
    summary = await drafts.humanize_drafts(posts)
    assert len(stub.modes) == 3  # 100 + 100 + 100 crosses 250; the rest are not sent
    assert summary is not None and summary["words_spent"] == 300
    assert posts[4]["linkedin_content"] == PARAS


@pytest.mark.asyncio
async def test_radar_switch_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUMANIZE_RADAR_DRAFTS", "false")
    get_settings.cache_clear()
    stub = _use(monkeypatch, _Stub({"Low": "keep"}))
    posts = [_blog_post()]
    assert await drafts.humanize_drafts(posts) is None
    assert stub.modes == []
    assert "humanize" not in posts[0]
