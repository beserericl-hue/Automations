"""A13: sub-chapter scene breaks must survive the em-dash backstop.

A13 joined sub-chapters with ``SCENE_BREAK`` ("\\n\\n---\\n\\n") so N sub-chapters deterministically
yield N-1 breaks, instead of relying on an advisory prompt instruction. The vault recorded the
drift-correct pass as the residual risk to "confirm on the next live run".

The next live run was a chapter 6 write on 2026-10-17: 5 sub-chapters, **0** scene breaks, and 5
instances of the literal text ", -" sitting in the middle of the prose. craft_passes was 0 and
drift was clean, so no revision pass had run.

The culprit was `_strip_em_dashes`, called on the very next line after the join. Its ``--``
alternative matched the first two hyphens of ``---``, and because ``\\s*`` sits outside the group it
ate the surrounding newlines as well:

    "…through the gate.\\n\\n---\\n\\nThe receiver swept…"  ->  "…through the gate., -  The receiver swept…"

So the structural fix was deleted by the sanitiser on every chapter, drift or no drift, and replaced
with visible punctuation garbage.
"""

from __future__ import annotations

import pytest
from chapter_step.main import SCENE_BREAK, _strip_em_dashes

_EM = "\u2014"  # em dash, written as an escape so the literal cannot be mistaken for a hyphen
_EN = "\u2013"  # en dash


def test_the_scene_separator_survives_the_backstop() -> None:
    """The exact regression: joined sub-chapters, then sanitised."""
    joined = SCENE_BREAK.join(["End of sub one.", "Start of sub two.", "Third."])
    out = _strip_em_dashes(joined)
    assert out.count("---") == 2, out
    assert ", -" not in out


def test_the_artifact_string_is_gone() -> None:
    """ ", -" in prose is the signature of this bug; it must not appear for any sub-chapter count."""
    for subs in range(2, 7):
        joined = SCENE_BREAK.join(f"Sub {i} prose." for i in range(subs))
        out = _strip_em_dashes(joined)
        assert ", -" not in out
        assert out.count("---") == subs - 1


def test_n_sub_chapters_still_yield_n_minus_1_breaks_end_to_end() -> None:
    """A13's actual promise, asserted after the sanitiser rather than before it."""
    subs = ["one", "two", "three", "four", "five"]
    out = _strip_em_dashes(SCENE_BREAK.join(subs))
    assert len([line for line in out.splitlines() if line.strip() == "---"]) == len(subs) - 1


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (f"a{_EM}b", "a, b"),
        (f"a {_EM} b", "a, b"),
        (f"a{_EN}b", "a, b"),
        ("a--b", "a, b"),
        ("a -- b", "a, b"),
    ],
)
def test_real_dashes_are_still_replaced(raw: str, expected: str) -> None:
    """The backstop's actual job: the writing directive bans these characters outright."""
    assert _strip_em_dashes(raw) == expected


def test_a_hyphen_run_is_a_separator_not_a_dash() -> None:
    assert _strip_em_dashes("---") == "---"
    assert _strip_em_dashes("----") == "----"
    # A single hyphen is legitimate punctuation and was never in scope.
    assert _strip_em_dashes("well-known") == "well-known"


def test_a_dash_adjacent_to_a_separator_is_still_cleaned() -> None:
    """Fixing the separator must not create a hole next to it."""
    text = f"She paused{_EM}then spoke.{SCENE_BREAK}He left--quickly."
    out = _strip_em_dashes(text)
    assert _EM not in out
    assert "--" not in out.replace("---", "")
    assert out.count("---") == 1


def test_a_break_the_writer_adds_inside_a_sub_chapter_is_kept() -> None:
    """Verified live on 2026-10-17: a real 5-sub-chapter write produced 5 breaks, not 4.

    The join contributes N-1; the sixth segment was the writer splitting one sub-chapter into two
    scenes of 501 and 1062 words, which is exactly what follett_seeds.scene.bme_check asks for. So
    the live criterion is "at least N-1 breaks and no artifact", not "exactly N-1" — the structural
    floor is the guarantee, and additional scene construction on top of it is the point.
    """
    joined = SCENE_BREAK.join(["one", "two", "three"])
    with_extra = joined.replace("two", "two part one" + SCENE_BREAK + "two part two")
    out = _strip_em_dashes(with_extra)
    assert out.count("---") == 3  # 2 from the join, 1 from the writer
    assert ", -" not in out
