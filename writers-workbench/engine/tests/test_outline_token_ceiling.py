"""The story-outline output ceiling, and the truncation that produced it.

A 96-chapter `brainstorm.story` run hit a hard-coded `max_tokens=32768`, emitted 119,838 characters
of valid JSON — roughly 72 of the 96 chapters — and was cut off mid-object. `json.loads` failed, the
step errored, and the job went to the dead-letter queue after eleven minutes and $0.51.

Truncation is the worst failure shape available here: the money is spent by the time it is detected,
and the output is unusable rather than degraded. So the ceiling is derived from the chapter count.
"""

from __future__ import annotations

import pytest
from brainstorm_step.main import (
    OUTLINE_CEILING_TOKENS,
    OUTLINE_FLOOR_TOKENS,
    OUTLINE_TOKENS_PER_CHAPTER,
    _outline_max_tokens,
)


class TestCeiling:
    def test_the_measured_failure_case_now_fits(self) -> None:
        """96 chapters truncated at 32,768. It must now be asked for more than that."""
        got = _outline_max_tokens(96)
        assert got > 32_768
        # And enough for the ~450 tokens/chapter the truncation measured, plus the preamble.
        assert got >= 96 * 450

    def test_a_short_outline_is_unchanged(self) -> None:
        """The old ceiling becomes the floor, so nothing that worked before changes behaviour."""
        for chapters in (0, 1, 12, 40):
            assert _outline_max_tokens(chapters) == OUTLINE_FLOOR_TOKENS

    def test_it_never_exceeds_what_the_model_can_emit(self) -> None:
        assert _outline_max_tokens(500) == OUTLINE_CEILING_TOKENS
        assert _outline_max_tokens(10_000) == OUTLINE_CEILING_TOKENS

    def test_it_scales_between_the_floor_and_the_ceiling(self) -> None:
        a, b = _outline_max_tokens(70), _outline_max_tokens(96)
        assert OUTLINE_FLOOR_TOKENS <= a <= b <= OUTLINE_CEILING_TOKENS
        assert b - a == 26 * OUTLINE_TOKENS_PER_CHAPTER

    @pytest.mark.parametrize("bad", [None, 0, -5])
    def test_a_missing_or_absurd_count_falls_back_to_the_floor(self, bad: object) -> None:
        assert _outline_max_tokens(bad) == OUTLINE_FLOOR_TOKENS  # type: ignore[arg-type]
