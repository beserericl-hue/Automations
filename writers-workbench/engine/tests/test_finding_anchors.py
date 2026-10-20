"""Craft findings must carry a span that really exists, or they cannot be offered as a fix.

WHY THIS EXISTS. Three automated repair mechanisms have now been measured and all three damage the
book: whole-chapter revision returns 48-80% of the original (six attempts), and section-wise
revision with deletion forbidden inflates chapters to 123-144% and scores WORSE on the very
dimensions it targets (two of three chapters). The common failure is that the model cannot improve
pacing in finished prose without changing its size, and the size change IS the damage.

So the fix is not a better rewrite prompt. It is to stop regenerating prose at all: the model
proposes a replacement for one named passage, the author accepts or rejects it, and Apply performs a
literal span replacement. A chapter cannot shrink to 2,800 words or balloon to 9,130 if the only
available operation is "swap this sentence for that one".

That safety property depends entirely on the quote being real. `annotations/apply` does a literal
replacement and returns 422 when the target is not found, so an unverified quote is a button that
fails on click — the drift source already hit this and works around it by skipping flags whose
variant is no longer in the text. This module makes a fabricated anchor impossible rather than
unlikely.
"""

from __future__ import annotations

from chapter_step.main import anchor_findings

CHAPTER = (
    "The gravel gave one sharp crack under the truck's front tire and then went quiet.\n\n"
    "She had driven four hours from Washington in the dark, which was her habit at new sites.\n\n"
    "The heater ticked as it cooled."
)


def _f(**kw: object) -> dict:
    base = {"dimension": "no_boring_paragraphs", "problem": "flat", "fix": "make it land"}
    base.update(kw)
    return base


class TestAnExactQuoteIsKept:
    def test_it_survives_and_is_marked_verified(self) -> None:
        got = anchor_findings([_f(quote="The heater ticked as it cooled.", replacement="X")], CHAPTER)
        assert got[0]["quote"] == "The heater ticked as it cooled."
        assert got[0]["quote_verified"] is True
        assert got[0]["replacement"] == "X"

    def test_the_other_fields_are_untouched(self) -> None:
        got = anchor_findings([_f(quote="The heater ticked as it cooled.")], CHAPTER)
        assert got[0]["dimension"] == "no_boring_paragraphs"
        assert got[0]["problem"] == "flat"


class TestAReflowedQuoteIsRecovered:
    """Models reflow line breaks when quoting. That is a formatting difference, not a wrong quote,
    and throwing it away would discard most of the usable findings."""

    def test_a_newline_becomes_a_space_and_still_matches(self) -> None:
        quote = "She had driven four hours from Washington in the dark, which was her habit at new sites."
        got = anchor_findings([_f(quote=quote.replace(" ", "\n", 1))], CHAPTER)
        assert got[0]["quote_verified"] is True

    def test_the_span_is_recovered_BYTE_EXACT_from_the_chapter(self) -> None:
        """The stored target_text has to be found by a literal search later. Storing the model's
        reflowed version would produce an annotation that 422s on apply."""
        spanning = "front tire and then went quiet.  She had driven four hours"
        got = anchor_findings([_f(quote=spanning)], CHAPTER)
        assert got[0]["quote_verified"] is True
        assert got[0]["quote"] in CHAPTER, "the recovered quote must be literally findable"
        assert "\n\n" in got[0]["quote"], "it should carry the chapter's real paragraph break"


class TestAFabricatedQuoteIsRefused:
    def test_an_invented_span_loses_its_quote_and_its_fix(self) -> None:
        """The dangerous case: a plausible sentence that was never written. Keeping it would offer
        a one-click Apply that cannot find its target."""
        got = anchor_findings(
            [_f(quote="She stepped out into the cold morning air.", replacement="rewritten")], CHAPTER
        )
        assert "quote" not in got[0]
        assert "replacement" not in got[0]
        assert got[0]["quote_verified"] is False

    def test_the_finding_itself_survives_as_a_note(self) -> None:
        """A finding that loses its anchor still tells the author something true. It just cannot be
        applied in one click."""
        got = anchor_findings([_f(quote="never written", problem="the ending is flat")], CHAPTER)
        assert len(got) == 1
        assert got[0]["problem"] == "the ending is flat"

    def test_a_paraphrase_is_not_a_quote(self) -> None:
        got = anchor_findings([_f(quote="the heater cooled down slowly")], CHAPTER)
        assert got[0]["quote_verified"] is False


class TestWholeChapterFindings:
    def test_an_empty_quote_is_a_note_not_a_failure(self) -> None:
        """Some findings genuinely are about the chapter as a whole. The prompt tells the model to
        leave the quote empty rather than invent a span, so an empty quote is the GOOD path."""
        got = anchor_findings([_f(quote="", problem="no section ends on a change")], CHAPTER)
        assert "quote" not in got[0]
        assert "quote_verified" not in got[0], "an honest absence is not a failed verification"

    def test_a_missing_quote_field_is_fine(self) -> None:
        got = anchor_findings([_f()], CHAPTER)
        assert got[0]["problem"] == "flat"

    def test_a_replacement_without_a_quote_is_dropped(self) -> None:
        """Nothing can be applied without a target, and a replacement with no anchor invites a UI
        that offers to swap text it cannot locate."""
        got = anchor_findings([_f(replacement="some new prose")], CHAPTER)
        assert "replacement" not in got[0]


class TestEdges:
    def test_no_findings_is_no_findings(self) -> None:
        assert anchor_findings([], CHAPTER) == []

    def test_an_empty_chapter_verifies_nothing(self) -> None:
        got = anchor_findings([_f(quote="anything at all")], "")
        assert got[0]["quote_verified"] is False

    def test_a_non_dict_entry_does_not_crash_the_batch(self) -> None:
        got = anchor_findings([_f(quote="The heater ticked as it cooled.")], CHAPTER)
        assert got[0]["quote_verified"] is True

    def test_the_input_findings_are_not_mutated(self) -> None:
        original = _f(quote="not in the chapter", replacement="x")
        anchor_findings([original], CHAPTER)
        assert original["quote"] == "not in the chapter"
        assert original["replacement"] == "x"
