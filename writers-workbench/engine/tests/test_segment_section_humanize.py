"""Newsletter section humanize keeps the section template: headings and bold labels never reach the
humanizer (StealthGPT dropped every one of them on DEV) and are put back by position; a rewrite that
changes the paragraph or bullet layout is not used."""

from __future__ import annotations

from typing import Any

import pytest
from segment_step import main as M

from writer_engine import humanize as hz
from writer_engine.config import get_settings
from writer_engine.schemas.newsletter import StorySegment

SECTION = (
    "# Seed Banks After the Collapse\n\n"
    "**The Recap:** Communities are rebuilding seed libraries so a failed harvest is not the end of a crop.\n\n"
    "**Unpacked:**\n\n"
    "- Gardeners borrow seed in spring and return saved seed after the harvest is in.\n"
    "- Heirloom varieties adapt to the local climate over many generations of growing.\n\n"
    "**Bottom line:** Seed libraries put food resilience in the hands of the people who grow it."
)


@pytest.fixture(autouse=True)
def _key(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("STEALTHGPT_API_KEY", "test-token")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_split_and_join_round_trip() -> None:
    layout, prose = M._split_section(SECTION)
    assert all("**" not in p and not p.startswith("#") for p in prose)
    assert len(prose) == 3  # recap text, the bullet block, bottom-line text
    assert M._join_section(layout, prose) == SECTION


@pytest.mark.asyncio
async def test_labels_survive_a_rewrite_that_would_have_dropped_them(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[str] = []

    async def _stub(chunk: str, **kw: Any) -> dict[str, Any]:
        sent.append(chunk)
        return {"result": chunk.replace("rebuilding", "restoring"), "wordsSpent": 50}

    monkeypatch.setattr(hz, "_stealthify", _stub)
    seg = StorySegment(story_title="t", newsletter_section_content=SECTION)
    report = await M._humanize_section(seg, {})
    assert report is not None and report["applied"] is True
    assert "**" not in sent[0] and "# Seed" not in sent[0]
    assert "restoring" in seg.newsletter_section_content
    assert M.section_labels(seg.newsletter_section_content) == [
        "**The Recap:**",
        "**Unpacked:**",
        "**Bottom line:**",
    ]
    assert seg.newsletter_section_content.startswith("# Seed Banks After the Collapse")


@pytest.mark.asyncio
async def test_a_rewrite_that_merges_the_bullets_keeps_the_original(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _stub(chunk: str, **kw: Any) -> dict[str, Any]:
        return {"result": chunk.replace("\n- ", " ").replace("- Gardeners", "Gardeners"), "wordsSpent": 50}

    monkeypatch.setattr(hz, "_stealthify", _stub)
    seg = StorySegment(story_title="t", newsletter_section_content=SECTION)
    report = await M._humanize_section(seg, {})
    assert report is not None and report["applied"] is False
    assert seg.newsletter_section_content == SECTION


# --- the layout rejection says why (it used to record applied=false with no reason) --------------


class _Log:
    def __init__(self) -> None:
        self.warnings: list[tuple[str, dict[str, Any]]] = []

    def warning(self, event: str, **kw: Any) -> None:
        self.warnings.append((event, kw))


@pytest.mark.asyncio
async def test_a_layout_rejection_records_its_reason_in_the_report_the_log_and_the_send_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from orchestrator.newsletter_saga import _humanize_summary

    # Two list items run together on one line: the paragraph count holds (so humanize_text's own
    # structure guard passes) but the bullet block lost an item marker.
    async def _stub(chunk: str, **kw: Any) -> dict[str, Any]:
        return {"result": chunk.replace("\n- Heirloom", " Heirloom"), "wordsSpent": 50}

    log = _Log()
    monkeypatch.setattr(hz, "_stealthify", _stub)
    monkeypatch.setattr(M, "logger", log)
    seg = StorySegment(story_title="Seed Banks", newsletter_section_content=SECTION)
    report = await M._humanize_section(seg, {})
    assert report is not None and report["applied"] is False
    assert report["rejected"] == {"layout": "layout_changed:bullets[1]:2->1"}
    assert report["rejected_layout"]["reason"] == "layout_changed:bullets[1]:2->1"
    assert log.warnings == [
        (
            "humanize.rejected",
            {
                "content_type": "newsletter_segment",
                "story_title": "Seed Banks",
                "chunk": "layout",
                "reason": "layout_changed:bullets[1]:2->1",
            },
        )
    ]
    summary = _humanize_summary([{"story_title": "Seed Banks", "humanize": report}])["humanize"]
    section = summary["sections"][0]
    assert section["applied"] is False
    assert section["rejected"] == {"layout": "layout_changed:bullets[1]:2->1"}
    assert section["rejected_layout"]["paragraphs"] == [3, 3]


@pytest.mark.asyncio
async def test_a_rewrite_that_merges_two_paragraphs_is_rejected_with_the_paragraph_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _stub(chunk: str, **kw: Any) -> dict[str, Any]:
        first, rest = chunk.split("\n\n", 1)
        return {"result": first + " " + rest, "wordsSpent": 50}

    monkeypatch.setattr(hz, "_stealthify", _stub)
    monkeypatch.setattr(hz, "judge_rewrite", lambda *a, **k: "")  # isolate the section-layout check
    seg = StorySegment(story_title="t", newsletter_section_content=SECTION)
    report = await M._humanize_section(seg, {})
    assert report is not None and report["applied"] is False
    assert report["rejected"]["layout"] == "layout_changed:paragraphs:3->2"
    assert seg.newsletter_section_content == SECTION


@pytest.mark.asyncio
async def test_list_items_split_by_blank_lines_are_put_back_together_and_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same items, same order, just a blank line between them: an acceptable rewrite, not a reject."""

    async def _stub(chunk: str, **kw: Any) -> dict[str, Any]:
        out = chunk.replace("rebuilding", "restoring").replace("\n- ", "\n\n- ")
        return {"result": out, "wordsSpent": 50}

    monkeypatch.setattr(hz, "_stealthify", _stub)
    seg = StorySegment(story_title="t", newsletter_section_content=SECTION)
    report = await M._humanize_section(seg, {})
    assert report is not None and report["applied"] is True
    assert "layout" not in (report.get("rejected") or {})
    assert seg.newsletter_section_content == SECTION.replace("rebuilding", "restoring")


@pytest.mark.asyncio
async def test_split_list_items_with_one_marker_dropped_are_still_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The re-join must not let a lost list item through: the bullet count is still checked."""

    async def _stub(chunk: str, **kw: Any) -> dict[str, Any]:
        return {"result": chunk.replace("\n- Heirloom", "\n\nHeirloom"), "wordsSpent": 50}

    monkeypatch.setattr(hz, "_stealthify", _stub)
    monkeypatch.setattr(hz, "judge_rewrite", lambda *a, **k: "")
    seg = StorySegment(story_title="t", newsletter_section_content=SECTION)
    report = await M._humanize_section(seg, {})
    assert report is not None and report["applied"] is False
    assert report["rejected"]["layout"].startswith("layout_changed:")
    assert seg.newsletter_section_content == SECTION


def test_merge_split_bullets_only_joins_list_paragraphs() -> None:
    assert M._merge_split_bullets(["Intro.", "- a", "- b", "Outro."]) == ["Intro.", "- a\n- b", "Outro."]
    assert M._merge_split_bullets(["- a", "Not a list.", "- b"]) == ["- a", "Not a list.", "- b"]
