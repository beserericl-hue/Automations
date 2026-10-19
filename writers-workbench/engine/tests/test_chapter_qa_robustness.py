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


class TestUnassessableDimensionsAreNotZero:
    """Found by running the B9 comparison. Three dimensions came back 0.0 in BOTH runs of the same
    chapter — character_follows_guide, outline_follows_guide and character_consistency — and neither
    was a quality judgement:

    * `_score_chapter` never sent the planned beat, so `outline_follows_guide` was unanswerable by
      construction and the model scored it 0.0 rather than null;
    * The Ossuary spans 12,000 years, so chapter 2's protagonist (Strikes-Twice) is in none of the
      six roster entries. A roster that does not mention this era's cast is not evidence the chapter
      got them wrong.

    0.0 means "does this badly"; null means "nothing to judge against", and the schema already
    coerces null to 1.0 (not flagged). Scoring the gap as 0.0 dragged a sound chapter to a mean of
    0.458 and invites craft revisions aimed at nothing."""

    def test_the_prompt_demands_null_rather_than_zero(self) -> None:
        system = M._build_qa_system()
        assert "MUST BE null, NOT 0.0" in system

    def test_the_prompt_names_both_unassessable_cases(self) -> None:
        system = M._build_qa_system()
        assert "no PLANNED BEAT was supplied" in system
        assert "not in the CHARACTER ROSTER" in system

    def test_the_beat_is_sent_when_the_caller_knows_it(
        self, monkeypatch: pytest.MonkeyPatch, logged: _Recorder
    ) -> None:
        calls = _stub_structured(monkeypatch, [ChapterCraftQa()])
        asyncio.run(M._score_chapter("prose", "ca. 10,500 BCE", "roster", beat="He knaps a biface."))
        assert "PLANNED BEAT FOR THIS CHAPTER:" in calls[0]["prompt"]
        assert "He knaps a biface." in calls[0]["prompt"]

    def test_no_beat_block_is_sent_when_there_is_no_beat(
        self, monkeypatch: pytest.MonkeyPatch, logged: _Recorder
    ) -> None:
        """An empty heading would invite the model to score against nothing, which is the bug."""
        calls = _stub_structured(monkeypatch, [ChapterCraftQa()])
        asyncio.run(M._score_chapter("prose", "1850", "roster", beat="   "))
        assert "PLANNED BEAT" not in calls[0]["prompt"]

    def test_the_write_and_qa_paths_both_pass_a_beat(self) -> None:
        """A parameter nothing supplies is the same as no parameter."""
        import inspect

        src = inspect.getsource(M)
        assert src.count("beat=_chapter_outline_beat(") >= 2
        assert "beat=beat)" in src

    def test_a_null_dimension_still_coerces_to_not_flagged(self) -> None:
        """The schema's existing contract, which is what makes null the right answer."""
        qa = ChapterCraftQa.model_validate(
            {"outline_follows_guide": None, "character_consistency": None, "prose_transparent": 0.8}
        )
        assert qa.outline_follows_guide == 1.0
        assert qa.character_consistency == 1.0
        assert qa.prose_transparent == 0.8
