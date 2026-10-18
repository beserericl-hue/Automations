"""chapter.qa came back `craft_qa: null` on a real chapter while chapter.review read the same text
fine ("craft-QA JSON could not be parsed", Burial Mound ch.1).

The scoring call swallowed the parse failure and returned None with no log line at all, so the only
symptom was a null in the response and there was no way to find out why. Three changes, and the
tests below are about all three: it is logged, it is retried once, and the two things that make the
JSON unparseable in the first place — an unbounded findings list and an unbounded chapter — are
capped.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from chapter_step import main as M

from writer_engine.schemas.chapter import ChapterCraftQa


class _Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def names(self) -> list[str]:
        return [e for e, _ in self.events]


@pytest.fixture
def logged(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    rec = _Recorder()
    for level in ("info", "warning", "error"):
        monkeypatch.setattr(M.logger, level, rec)
    return rec


def _stub_structured(monkeypatch: pytest.MonkeyPatch, outcomes: list[Any]) -> list[dict[str, Any]]:
    """Feed `_score_chapter` a sequence of outcomes. An Exception instance is raised; anything else
    is returned. Records the kwargs of each call so the test can inspect the prompt."""
    calls: list[dict[str, Any]] = []

    async def _fake(_router: Any, **kw: Any) -> Any:
        calls.append(kw)
        out = outcomes[min(len(calls) - 1, len(outcomes) - 1)]
        if isinstance(out, Exception):
            raise out
        return out, object()

    monkeypatch.setattr(M, "complete_structured", _fake)
    monkeypatch.setattr(M, "get_router", lambda service=None: object())
    return calls


class TestUnparseableQaIsNotSilent:
    def test_a_parse_failure_is_logged_at_error_when_it_finally_gives_up(
        self, monkeypatch: pytest.MonkeyPatch, logged: _Recorder
    ) -> None:
        _stub_structured(monkeypatch, [ValueError("LLM did not return valid JSON: Unterminated string")])
        out = asyncio.run(M._score_chapter("chapter text", "1850"))
        assert out is None
        assert "chapter.qa.unparseable" in logged.names()
        last = [kw for e, kw in logged.events if e == "chapter.qa.unparseable"][-1]
        assert "Unterminated string" in last["error"]
        assert last["attempt"] == last["of"]

    def test_it_retries_once_with_a_stricter_instruction(
        self, monkeypatch: pytest.MonkeyPatch, logged: _Recorder
    ) -> None:
        """The common failure is prose around the JSON or an over-long answer; a reminder fixes both,
        and the alternative is discarding all eight scores."""
        good = ChapterCraftQa(prose_transparent=0.9)
        calls = _stub_structured(monkeypatch, [ValueError("prose, not JSON"), good])

        out = asyncio.run(M._score_chapter("chapter text", "1850"))
        assert out is not None and out.prose_transparent == 0.9
        assert len(calls) == 2
        assert "could not be parsed" in calls[1]["system"]
        assert "could not be parsed" not in calls[0]["system"]
        assert "chapter.qa.recovered_on_retry" in logged.names()

    def test_it_does_not_retry_forever(self, monkeypatch: pytest.MonkeyPatch, logged: _Recorder) -> None:
        calls = _stub_structured(monkeypatch, [ValueError("nope")])
        assert asyncio.run(M._score_chapter("chapter text", "1850")) is None
        assert len(calls) == 2

    def test_a_successful_first_attempt_makes_one_call_and_no_noise(
        self, monkeypatch: pytest.MonkeyPatch, logged: _Recorder
    ) -> None:
        calls = _stub_structured(monkeypatch, [ChapterCraftQa()])
        assert asyncio.run(M._score_chapter("chapter text", "1850")) is not None
        assert len(calls) == 1
        assert "chapter.qa.unparseable" not in logged.names()


class TestTheInputsAreBounded:
    def test_a_very_long_chapter_is_truncated_rather_than_sent_whole(
        self, monkeypatch: pytest.MonkeyPatch, logged: _Recorder
    ) -> None:
        calls = _stub_structured(monkeypatch, [ChapterCraftQa()])
        huge = "word " * 40_000  # 200k chars
        asyncio.run(M._score_chapter(huge, "1850"))
        assert len(calls[0]["prompt"]) < len(huge)
        assert "chapter.qa.text_truncated" in logged.names()

    def test_a_normal_chapter_is_sent_whole(self, monkeypatch: pytest.MonkeyPatch, logged: _Recorder) -> None:
        calls = _stub_structured(monkeypatch, [ChapterCraftQa()])
        chapter = "word " * 7_000  # ~35k chars, a real chapter
        asyncio.run(M._score_chapter(chapter, "1850"))
        assert chapter in calls[0]["prompt"]
        assert "chapter.qa.text_truncated" not in logged.names()

    def test_the_output_ceiling_is_raised_above_the_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = _stub_structured(monkeypatch, [ChapterCraftQa()])
        asyncio.run(M._score_chapter("chapter", "1850"))
        assert calls[0]["max_tokens"] == M.QA_MAX_TOKENS
        assert M.QA_MAX_TOKENS > 8192

    def test_the_prompt_caps_the_findings_it_asks_for(self) -> None:
        """An unbounded findings list is what pushes the answer past the ceiling."""
        system = M._build_qa_system()
        assert f"AT MOST {M.QA_MAX_FINDINGS}" in system


class TestNoProviderStillYieldsAFixture:
    def test_a_missing_provider_is_not_a_parse_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from writer_engine.llm.router import ProviderNotRegistered

        _stub_structured(monkeypatch, [ProviderNotRegistered("anthropic")])
        out = asyncio.run(M._score_chapter("chapter", "1850"))
        assert out is not None, "the fixture path must still answer when no key is configured"
