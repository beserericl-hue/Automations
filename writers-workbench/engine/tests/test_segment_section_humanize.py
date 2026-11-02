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
