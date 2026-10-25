"""humanize-passage: one selected passage through StealthGPT, for the editor's Humanizer tab.

Nothing is written; the author compares and decides. What this guards: the size cap (a stray
select-all must not bill a novel), the not-configured answer, and that the passage's own names are
handed to the humanizer to protect.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from chapter_step import main as M

from writer_engine import humanize as H


def test_an_empty_passage_is_refused() -> None:
    assert "no passage" in asyncio.run(M._op_humanize_passage({"text": "  "}))["skipped"]


def test_a_passage_over_the_cap_is_refused_before_anything_is_billed(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    async def never(*a: Any, **k: Any) -> Any:
        nonlocal called
        called = True

    monkeypatch.setattr(H, "humanize_text", never)
    monkeypatch.setattr(H, "enabled", lambda: True)
    out = asyncio.run(M._op_humanize_passage({"text": "word " * (M.HUMANIZE_PASSAGE_MAX_WORDS + 1)}))
    assert "up to" in out["skipped"]
    assert called is False


def test_says_plainly_when_the_humanizer_is_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(H, "enabled", lambda: False)
    assert (
        "not configured"
        in asyncio.run(M._op_humanize_passage({"text": "He walked to the river."}))["skipped"]
    )


def test_protects_the_passages_names_and_reports_the_result(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    async def fake(text: str, *, protect: list[str], **_k: Any) -> H.HumanizeResult:
        seen["protect"] = protect
        return H.HumanizeResult(
            text="He went down to the river.", chunks=1, humanized_chunks=1, detectability=12
        )

    monkeypatch.setattr(H, "enabled", lambda: True)
    monkeypatch.setattr(H, "humanize_text", fake)
    text = "Marcus walked to the river. Later Marcus sat down by the water and waited for Sylvia."
    out = asyncio.run(M._op_humanize_passage({"text": text}))
    assert "Marcus" in seen["protect"] and "Sylvia" in seen["protect"]
    assert out["changed"] is True
    assert out["text"] == "He went down to the river."
    assert out["detectability"] == 12
    assert out["original"] == text
