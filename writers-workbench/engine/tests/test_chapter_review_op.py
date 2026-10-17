"""E7 — the ``chapter.review`` op, and the boundary it must not cross.

The Q/A panel reads ``metadata.qa_report``, and ``POST /api/content/:id/rewrite-to-fix-qa`` turns its
``NEEDS_REVIEW`` rows into a ``chapter.repair``. Review findings are deliberately the same *shape*
so the panel can render them — and deliberately stored under a different key, so "Hemingway thinks
paragraph two is wordy" can never trigger an automated rewrite of a chapter that passes every rubric
the product actually promises. That separation is the test.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from conftest import FakeSupabase

PROJECT = "62cc734f-c861-4210-bc12-e9ea002fcf66"


@pytest.fixture
def chapter_row(monkeypatch: pytest.MonkeyPatch, fake_supabase: FakeSupabase) -> Iterator[FakeSupabase]:
    """A persisted chapter with an existing craft qa_report already on it.

    The Supabase settings have to be non-empty as well as patched: both ``_load_persisted_chapter``
    and ``_persist_review_report`` check them before touching the client, so a blank URL (which
    conftest sets, to keep the suite off real APIs) short-circuits the whole path.
    """
    from writer_engine.config import get_settings

    async def _client() -> FakeSupabase:
        return fake_supabase

    monkeypatch.setenv("SUPABASE_URL", "https://fake.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key")
    get_settings.cache_clear()
    monkeypatch.setattr("writer_engine.supabase.client.get_supabase_admin", _client)
    fake_supabase.tables["published_content_v2"] = [
        {
            "id": "chapter-row-1",
            "project_id": PROJECT,
            "content_type": "chapter",
            "chapter_number": 1,
            "content_text": "The permit was in her hands. She had read it many times, very carefully.",
            "metadata": {
                "qa_report": {
                    "generated_at": "2026-10-01T00:00:00Z",
                    "checks": [{"name": "Character consistency", "status": "PASS", "details": "ok"}],
                }
            },
        }
    ]
    yield fake_supabase
    get_settings.cache_clear()


@pytest.fixture
def stub_review(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace the LLM pass with a scripted lens result."""
    from writer_engine.review import runner

    seen: dict[str, Any] = {"drafts": [], "lenses": []}

    async def fake_run_lens(lens: str, draft: str, **_kw: Any) -> tuple[runner.LensReport | None, str]:
        seen["lenses"].append(lens)
        seen["drafts"].append(draft)
        return runner.LensReport.model_validate(
            {"findings": [{"severity": "medium", "title": "Qualifiers", "detail": "Cut 'very'."}]}
        ), ""

    monkeypatch.setattr(runner, "run_lens", fake_run_lens)
    return seen


class TestOpReview:
    @pytest.mark.asyncio
    async def test_it_loads_the_persisted_chapter(
        self, chapter_row: FakeSupabase, stub_review: dict[str, Any]
    ) -> None:
        """The hub passes a reference, not the prose — same as ``chapter.qa`` (R119)."""
        from chapter_step.main import OPS

        out = await OPS["review"]({"project_id": PROJECT, "chapter_number": 1, "lenses": ["hemingway"]})
        assert "The permit was in her hands." in stub_review["drafts"][0]
        assert out["finding_count"] == 1
        assert out["lenses"] == ["hemingway"]

    @pytest.mark.asyncio
    async def test_it_persists_under_review_report_not_qa_report(
        self, chapter_row: FakeSupabase, stub_review: dict[str, Any]
    ) -> None:
        """The boundary. A critique lens must not be able to drive *Rewrite to fix Q/A*."""
        from chapter_step.main import OPS

        out = await OPS["review"]({"project_id": PROJECT, "chapter_number": 1, "lenses": ["hemingway"]})
        assert out["persist"] == {"persisted": True, "checks": 1}
        meta = chapter_row.tables["published_content_v2"][0]["metadata"]
        assert meta["review_report"]["finding_count"] == 1
        # The craft rubric is untouched — same one PASS check it had before.
        assert meta["qa_report"]["checks"] == [
            {"name": "Character consistency", "status": "PASS", "details": "ok"}
        ]

    @pytest.mark.asyncio
    async def test_a_single_lens_may_be_a_string(
        self, chapter_row: FakeSupabase, stub_review: dict[str, Any]
    ) -> None:
        from chapter_step.main import OPS

        out = await OPS["review"]({"project_id": PROJECT, "chapter_number": 1, "lens": "mom"})
        assert out["lenses"] == ["mom"]

    @pytest.mark.asyncio
    async def test_no_lens_runs_the_default(
        self, chapter_row: FakeSupabase, stub_review: dict[str, Any]
    ) -> None:
        from chapter_step.main import OPS

        from writer_engine.review import lenses

        out = await OPS["review"]({"project_id": PROJECT, "chapter_number": 1})
        assert out["lenses"] == list(lenses.DEFAULT_LENSES)

    @pytest.mark.asyncio
    async def test_an_unknown_lens_is_refused_before_any_model_call(
        self, chapter_row: FakeSupabase, stub_review: dict[str, Any]
    ) -> None:
        from chapter_step.main import OPS

        out = await OPS["review"]({"project_id": PROJECT, "chapter_number": 1, "lenses": ["shakespeare"]})
        assert "unknown review lens" in out["error"]
        assert "hemingway" in out["available_lenses"]
        assert stub_review["lenses"] == []

    @pytest.mark.asyncio
    async def test_inline_text_needs_no_chapter_row(self, stub_review: dict[str, Any]) -> None:
        from chapter_step.main import OPS

        out = await OPS["review"]({"chapter_text": "Some prose, very carefully written.", "lenses": ["mom"]})
        assert out["finding_count"] == 1
        assert out["persist"] is None  # nothing to attach it to

    @pytest.mark.asyncio
    async def test_a_missing_chapter_says_so_rather_than_reviewing_nothing(
        self, chapter_row: FakeSupabase, stub_review: dict[str, Any]
    ) -> None:
        from chapter_step.main import OPS

        out = await OPS["review"]({"project_id": PROJECT, "chapter_number": 99, "lenses": ["mom"]})
        assert out["finding_count"] == 0
        assert out["review_report"]["errors"] == {"_draft": "empty"}
        assert stub_review["lenses"] == []


def test_review_is_a_registered_op() -> None:
    from chapter_step.main import OPS

    assert "review" in OPS


def test_the_hub_can_route_to_it() -> None:
    """Without a catalog entry the hub cannot pick the tool, so the op would be unreachable by chat."""
    from writer_engine.hub.catalog import CATALOG

    specs = [t for t in CATALOG if t.tool == "chapter" and t.op == "review"]
    assert len(specs) == 1
    assert "lenses" in specs[0].params
