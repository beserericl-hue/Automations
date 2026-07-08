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


def test_persist_chapter_merges_metadata_preserving_qa_report() -> None:
    """Regression (2026-07-08): a rewrite/repair persisted a fresh metadata dict, and the old code
    OVERWROTE the whole metadata column — wiping qa_report (the Q/A Consistency Report the user ran),
    dismissed_annotations, etc. persist_chapter must MERGE: refresh write-time keys, preserve the rest."""
    from writer_engine.persist_helpers import persist_chapter

    prior = {"qa_report": {"checks": [{"name": "x", "status": "NEEDS_REVIEW"}]},
             "dismissed_annotations": ["drift_scan:3:name_variant:Meara"],
             "craft_qa": {"prose_transparent": 0.5}, "word_count": 100}
    captured: dict = {}

    class _Q:
        def __init__(self, kind): self.kind = kind
        def select(self, *_a, **_k): return self
        def eq(self, *_a, **_k): return self
        def order(self, *_a, **_k): return self
        def limit(self, *_a, **_k): return self
        def update(self, row):
            if self.kind == "published_content_v2":
                captured["metadata"] = row.get("metadata")
            return self
        def insert(self, *_a, **_k): return self
        async def execute(self):
            class _R:
                data = [{"id": "cid-1", "metadata": prior}] if self.kind == "published_content_v2" else []
            return _R()

    class _Client:
        def table(self, name): return _Q(name)

    asyncio.run(persist_chapter(
        _Client(), project_id="p", user_id="u", chapter_number=3, title="t", content_text="body",
        metadata={"craft_qa": {"prose_transparent": 0.9}, "word_count": 200, "drift_report": {}},
    ))
    md = captured.get("metadata") or {}
    # preserved:
    assert "qa_report" in md and md["qa_report"]["checks"][0]["status"] == "NEEDS_REVIEW"
    assert md.get("dismissed_annotations") == ["drift_scan:3:name_variant:Meara"]
    # refreshed:
    assert md["craft_qa"]["prose_transparent"] == 0.9 and md["word_count"] == 200
