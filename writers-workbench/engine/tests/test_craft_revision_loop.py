"""The craft-revision loop never ran on a real chapter.

It existed only on the single-call path (`n_sub == 1`), and every real chapter is five
sub-chapters — so the assembled prose was scored for telemetry and the score was never acted on.
`craft_passes` was None for all 96 chapters of the Ossuary run.

The correlation across that run is the whole argument for wiring it in. Dimensions the DRIFT pass
corrects scored near-perfect; dimensions nothing corrected scored worst:

    character_follows_guide  1.00   (drift pass covers it)
    character_consistency    1.00   (drift pass covers it)
    outline_follows_guide    0.92   (drift pass covers it)
    period_language_ok       0.91   (drift pass covers it)
    prose_transparent        0.88   nothing corrected it
    dialogue_follows_guide   0.88   nothing corrected it
    no_boring_paragraphs     0.81   under threshold in 39 of 96 chapters
    story_turn_density       0.79   under threshold in 51 of 96 chapters

The chapter was fixed for exactly what it was checked against, and for nothing else.
"""

from __future__ import annotations

import inspect

from chapter_step.main import (
    CRAFT_MIN_LENGTH_RATIO,
    SCENE_BREAK,
    _revise_max_tokens,
    craft_revision_rejected,
)


def _chapter(words: int, breaks: int = 4) -> str:
    """A stand-in chapter of `words` words with `breaks` scene separators."""
    per = max(1, words // (breaks + 1))
    parts = [" ".join(["word"] * per) for _ in range(breaks + 1)]
    return SCENE_BREAK.join(parts)


class TestTheOutputCeilingScales:
    def test_a_real_chapter_gets_more_than_the_old_fixed_ceiling(self) -> None:
        """6,400 words is about 9,000 output tokens. The old fixed 8192 would have truncated the
        revision and replaced the chapter with a fragment — the fourth instance of this failure
        here, after the 96-chapter outline, the guardrails lens and the craft QA."""
        assert _revise_max_tokens(_chapter(6400)) > 8192

    def test_a_short_chapter_keeps_a_sane_floor(self) -> None:
        assert _revise_max_tokens(_chapter(500)) == 8192

    def test_an_enormous_chapter_is_capped(self) -> None:
        assert _revise_max_tokens(_chapter(40_000)) == 32_000

    def test_the_ceiling_is_never_the_old_hardcoded_value_for_long_text(self) -> None:
        src = inspect.getsource(__import__("chapter_step.main", fromlist=["x"]))
        assert "max_tokens=_revise_max_tokens(text)" in src


class TestTheGuardRejectsARuinedRevision:
    def test_a_faithful_revision_is_accepted(self) -> None:
        before = _chapter(6400, breaks=4)
        after = _chapter(6350, breaks=4)
        assert craft_revision_rejected(before, after) == ""

    def test_a_shortened_revision_is_rejected(self) -> None:
        """Post-hoc rewrites shorten. A craft polish has no business cutting a tenth of a chapter."""
        before = _chapter(6400, breaks=4)
        after = _chapter(int(6400 * (CRAFT_MIN_LENGTH_RATIO - 0.05)), breaks=4)
        why = craft_revision_rejected(before, after)
        assert "shorter" in why

    def test_a_revision_that_loses_scene_breaks_is_rejected(self) -> None:
        """A13/J2: the em-dash backstop once deleted the separators and left ", -" in the prose."""
        before = _chapter(6400, breaks=4)
        after = _chapter(6400, breaks=1)
        why = craft_revision_rejected(before, after)
        assert "lost scene breaks" in why

    def test_a_truncated_revision_is_caught_by_the_length_floor(self) -> None:
        before = _chapter(6400, breaks=4)
        after = " ".join(before.split()[:3000])  # cut off mid-chapter
        assert craft_revision_rejected(before, after)

    def test_an_empty_revision_is_rejected(self) -> None:
        assert craft_revision_rejected(_chapter(6400), "") == "empty"

    def test_more_scene_breaks_is_not_a_rejection(self) -> None:
        """Adding a break is a legitimate pacing fix; only LOSING them is the failure."""
        assert craft_revision_rejected(_chapter(6400, breaks=4), _chapter(6400, breaks=6)) == ""


class TestTheLoopIsWiredIntoTheRealPath:
    @staticmethod
    def _write_src() -> str:
        from chapter_step import main as M

        src = inspect.getsource(M)
        start = src.index("plan = model_plan(req.llm_strategy, settings)")
        return src[start : src.index('result["persist"] = await _persist_chapter_if_requested', start)]

    def test_the_multi_subchapter_path_revises(self) -> None:
        """The defect was that this loop existed only in the `else` (single-call) branch."""
        src = self._write_src()
        i_join = src.index("text = SCENE_BREAK.join(sub_texts)")
        i_loop = src.index("while craft_done < max_craft")
        assert i_join < i_loop, "the craft loop must run on the ASSEMBLED chapter"

    def test_it_revises_with_the_polish_model(self) -> None:
        assert "model=plan.polish," in self._write_src()

    def test_it_rescoring_after_revising(self) -> None:
        """Without a re-score the loop cannot know whether it helped, and `craft_qa` would report
        the pre-revision numbers."""
        src = self._write_src()
        assert src.count("_score_chapter(text, period, roster_text, beat=beat)") >= 2

    def test_it_is_bounded_and_can_be_switched_off(self) -> None:
        src = self._write_src()
        assert 'payload.get("max_craft_passes")' in src
        assert "max(0, _coerce_int" in src

    def test_the_rejection_path_breaks_rather_than_retrying_forever(self) -> None:
        src = self._write_src()
        i = src.index("rejected = craft_revision_rejected(text, revised)")
        assert "break" in src[i : i + 400]


class TestTheRevisionHasALengthContract:
    """The first version of this pass shortened every chapter it touched, because the craft rules it
    applies say to: the remedy for a boring paragraph is listed as "(a) cut it" and the remedy for
    loose pacing is "demote or remove" turns. Both are correct for a reviser with room to grow and
    wrong for a 6,000-word chapter that must stay 6,000 words.

    Measured on the three worst-paced Ossuary chapters: 2,596 words against 5,363, 4,178 against
    5,223, 4,694 against 6,602. All three were rejected by the floor — the chapters were safe, and
    the pass had cost money and changed nothing.
    """

    @staticmethod
    def _prompt_for(text: str) -> str:
        """The user prompt `_revise_chapter` would send, without making an LLM call."""
        import asyncio
        from unittest.mock import patch

        captured: dict[str, str] = {}

        class _Resp:
            text = "revised"

        class _Router:
            async def complete(self, **kw: object) -> _Resp:
                captured["prompt"] = str(kw.get("prompt"))
                return _Resp()

        from chapter_step import main as M

        with patch.object(M, "get_router", lambda service=None: _Router()):
            asyncio.run(
                M._revise_chapter(
                    text,
                    low_dims=["story_turn_density", "no_boring_paragraphs"],
                    findings=[{"dimension": "story_turn_density", "problem": "p", "fix": "f"}],
                    model="claude-sonnet-4-6",
                    genre_slug="historical-time-travel",
                )
            )
        return captured["prompt"]

    def test_it_states_the_word_count_and_the_floor(self) -> None:
        chapter = _chapter(6400, breaks=4)
        words = len(chapter.split())  # the separators count as words, so compute rather than assume
        prompt = self._prompt_for(chapter)
        assert "LENGTH IS A HARD CONSTRAINT" in prompt
        assert f"{words:,} words" in prompt
        assert f"{int(words * CRAFT_MIN_LENGTH_RATIO):,}" in prompt

    def test_it_forbids_fixing_by_deletion(self) -> None:
        prompt = self._prompt_for(_chapter(6400))
        assert "Do NOT satisfy these notes by deletion" in prompt
        assert "dramatised material in its place" in prompt

    def test_it_warns_that_a_short_answer_is_discarded(self) -> None:
        """The model should know the cost of ignoring the constraint, since the guard will."""
        assert "will be rejected" in self._prompt_for(_chapter(6400))

    def test_it_names_the_scene_breaks_to_keep(self) -> None:
        prompt = self._prompt_for(_chapter(6400, breaks=4))
        assert "Keep all 4 scene-break separators" in prompt

    def test_the_findings_still_reach_the_model(self) -> None:
        prompt = self._prompt_for(_chapter(6400))
        assert "CRAFT ISSUES TO FIX" in prompt
        assert "story_turn_density" in prompt
