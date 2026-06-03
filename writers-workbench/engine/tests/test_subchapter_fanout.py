"""Sub-chapter fan-out (F1-1): a chapter is written as N sub-chapters for depth.

The plan schema must tolerate the LLM's shapes; fan-out vs single-call is chosen by
sub_chapter_count. (Live generation is exercised in the async Burial Mound re-run, not unit tests.)
"""

from __future__ import annotations

import pytest
from chapter_step.main import _plan_subchapters, _plan_system

from writer_engine.schemas.chapter import SubChapterBrief, SubChapterPlan
from writer_engine.schemas.chapter import WriteChapterRequest as Req


def test_plan_schema_tolerates_shapes() -> None:
    # bare list of strings
    p = SubChapterPlan.model_validate(["Arrival", "The dig", "The vision"])
    assert [b.beat for b in p.subchapters] == ["Arrival", "The dig", "The vision"]
    # {sub_chapters: [...]} alias + dict items
    p2 = SubChapterPlan.model_validate({"sub_chapters": [{"title": "T", "beat": "B", "pov_character": "Ana"}]})
    assert p2.subchapters[0].title == "T" and p2.subchapters[0].pov_character == "Ana"
    # {chapters: [...]} alias
    p3 = SubChapterPlan.model_validate({"chapters": [{"beat": "x"}]})
    assert p3.subchapters[0].beat == "x"


def test_plan_system_has_event_list_seed() -> None:
    s = _plan_system("ancient-history", {"story_arc": "Three-Act"})
    assert "SubChapterPlan" in s
    assert "atomic events" in s or "numbered list" in s  # scene.event_list seed
    assert "GENRE: ancient-history" in s


@pytest.mark.asyncio
async def test_plan_fixture_path_returns_n_briefs() -> None:
    # No provider -> deterministic fixture briefs (length n).
    req = Req(project_id="00000000-0000-4000-8000-000000000001", chapter_number=1,
              chapter_run_id="00000000-0000-4000-8000-0000000000aa")
    ctx = {"genre_slug": "ancient-history", "title": "T", "outline": {}, "roster": []}
    briefs = await _plan_subchapters(ctx, req, 5, "claude-sonnet-4-6")
    assert len(briefs) == 5
    assert all(isinstance(b, SubChapterBrief) for b in briefs)
