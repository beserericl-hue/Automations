"""E2E-4 — chapter.plan dual-arc depth + arc fidelity (offline structural coverage).

The arc-beat *wording* is LLM-driven (validated live), but the structural foundation is offline-testable:
the story-arc loader, the rich sub-chapter schema, the dual-arc wiring (book arc + per-chapter override
loaded + emitted + persisted), and the auto-plan guard.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from uuid import uuid4

import chapter_step.main as ch

from writer_engine.schemas.chapter import SubChapterBrief, SubChapterPlan
from writer_engine.story_arcs import load_story_arc

# --------------------------------------------------------------------------- arc loader

class _ArcQuery:
    def __init__(self, rows):
        self._rows = rows

    def __getattr__(self, _n):
        return lambda *a, **k: self

    async def execute(self):
        return SimpleNamespace(data=self._rows)


class _ArcClient:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _n):
        return _ArcQuery(self._rows)


def test_load_story_arc_resolves_prompt_text():
    client = _ArcClient([{"name": "The Hero's Journey", "prompt_text": "Call to Adventure; Crossing the Threshold"}])
    name, text = asyncio.run(load_story_arc(client, "hero"))
    assert name == "The Hero's Journey" and "Call to Adventure" in text


def test_load_story_arc_no_client_or_name():
    assert asyncio.run(load_story_arc(None, "x")) == ("x", "")
    assert asyncio.run(load_story_arc(_ArcClient([]), "")) == ("", "")


# --------------------------------------------------------------------------- rich schema

def test_sub_chapter_brief_fields_and_brief_beat_alias():
    b = SubChapterBrief.model_validate({
        "number": 1, "title": "t", "brief": "the beat", "arc_beat": "Climax",
        "characters": ["Mara"], "setting": "shore", "emotional_tone": "tense",
        "connects_to_book_arc": "Resolution",
    })
    assert b.beat == "the beat" and b.brief == "the beat"  # alias kept in sync
    assert b.arc_beat == "Climax" and b.characters == ["Mara"]
    # legacy beat-only input still populates brief
    assert SubChapterBrief(beat="legacy").brief == "legacy"


# --------------------------------------------------------------------------- dual-arc plan

def test_plan_loads_override_arc_emits_rich_subchapters_and_persists(monkeypatch):
    outline = {"story_arc_name": "The Hero's Journey", "chapters": [
        {"chapter_number": 1, "title": "A", "beat": "a"},
        {"chapter_number": 2, "title": "B", "beat": "b"},
        {"chapter_number": 3, "title": "C", "beat": "c"},
    ]}

    async def fake_ctx(pid, payload):
        return {"genre_slug": "post-apocalyptic", "title": "The Signal Beneath",
                "outline": outline, "roster": [{"name": "Mara", "description": "the keeper"}]}

    async def fake_cs(router, *, provider, model, system, prompt, schema, max_tokens):
        # assert both arcs reached the prompt (no cross-contamination check is live)
        assert "Book arc: The Hero's Journey" in system
        assert "Chapter arc: Fichtean Curve" in system
        return SubChapterPlan(subchapters=[
            SubChapterBrief(title="s1", brief="beat one", arc_beat="Rising Action",
                            characters=["Mara"], setting="shore", emotional_tone="tense",
                            connects_to_book_arc="Tests, Allies, Enemies"),
            SubChapterBrief(title="s2", brief="beat two", arc_beat="Crisis", characters=["Mara"]),
            SubChapterBrief(title="s3", brief="beat three", arc_beat="Climax", characters=["Mara"]),
        ]), None

    async def fake_arc(client, name):
        return (name or "", f"{name} beats") if name else ("", "")

    captured: dict = {}

    async def fake_persist(pid, cn, subs, carc, barc):
        captured.update(pid=pid, cn=cn, subs=subs, carc=carc, barc=barc)
        return {"persisted": True}

    async def fake_admin():
        return object()

    monkeypatch.setattr(ch, "_load_context", fake_ctx)
    monkeypatch.setattr(ch, "complete_structured", fake_cs)
    monkeypatch.setattr(ch, "_persist_chapter_outline", fake_persist)
    monkeypatch.setattr("writer_engine.story_arcs.load_story_arc", fake_arc)
    monkeypatch.setattr("writer_engine.supabase.client.get_supabase_admin", fake_admin)

    out = asyncio.run(ch._op_plan({
        "project_id": str(uuid4()), "chapter_number": 2, "chapter_story_arc": "Fichtean Curve",
        "persist": True, "user_id": "u1",
    }))

    assert out["chapter_story_arc"] == "Fichtean Curve"  # per-chapter override
    assert out["book_arc"] == "The Hero's Journey"
    sc = out["sub_chapter_briefs"]
    assert len(sc) == 3
    assert sc[0]["number"] == 1 and sc[0]["arc_beat"] == "Rising Action"
    assert sc[0]["brief"] == "beat one" and sc[0]["beat"] == "beat one"
    assert sc[0]["characters"] == ["Mara"] and sc[0]["connects_to_book_arc"]
    # persisted with both arcs recorded
    assert captured["carc"] == "Fichtean Curve" and captured["barc"] == "The Hero's Journey"


# --------------------------------------------------------------------------- auto-plan guard

def test_write_auto_plan_guard_plans_not_writes(monkeypatch):
    outline = {"story_arc_name": "X", "chapters": [{"chapter_number": 3, "title": "C", "beat": "c"}]}

    async def fake_ctx(pid, payload):
        return {"genre_slug": "g", "title": "T", "outline": outline, "roster": []}

    async def fake_plan(payload):
        return {"chapter_number": 3, "persist": {"persisted": True}}

    monkeypatch.setattr(ch, "_load_context", fake_ctx)
    monkeypatch.setattr(ch, "_op_plan", fake_plan)

    out = asyncio.run(ch._op_write({
        "project_id": str(uuid4()), "chapter_number": 3, "require_chapter_outline": True,
    }))
    assert out["planned"] is True and out["wrote"] is False
    assert "review" in out["message"].lower()
