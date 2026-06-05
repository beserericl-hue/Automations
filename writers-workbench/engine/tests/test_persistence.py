"""CR-001 engine DB persistence — guard logic (no DB): persist flags + ops registered + helpers importable."""

from __future__ import annotations

import asyncio

from brainstorm_step.main import OPS as B_OPS
from brainstorm_step.main import _persist_outline_if_requested


def test_create_project_op_registered() -> None:
    assert "create-project" in B_OPS


def test_persist_outline_noop_when_not_requested() -> None:
    assert asyncio.run(_persist_outline_if_requested({}, {"chapters": []})) is None


def test_persist_outline_requires_ids() -> None:
    out = asyncio.run(_persist_outline_if_requested({"persist": True}, {"chapters": []}))
    assert out["persisted"] is False and "missing" in out["reason"]


def test_create_project_requires_user() -> None:
    out = asyncio.run(B_OPS["create-project"]({"title": "X"}))
    assert out["created"] is False


def test_persist_helpers_importable() -> None:
    from writer_engine import persist_helpers

    for fn in ("create_project", "persist_outline", "persist_chapter", "persist_bible", "persist_research"):
        assert hasattr(persist_helpers, fn)


def test_chapter_persist_guard_importable() -> None:
    from chapter_step.main import _persist_chapter_if_requested

    assert asyncio.run(_persist_chapter_if_requested({}, {"title": "t"}, _DummyOut())) is None


class _DummyOut:
    content_text = "x"
    chapter_run_id = "00000000-0000-0000-0000-000000000000"
    word_count = 1
    sub_chapter_count = 1
    craft_qa = None
