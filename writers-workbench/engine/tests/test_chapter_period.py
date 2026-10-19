"""The era a chapter is set in was never derived — it defaulted to "contemporary".

Found while checking readiness for a 96-chapter batch. `period` drives the period-language craft
seeds, the research query and the QA's `period_language_ok` score, and every caller had to supply it
by hand. A batch that forgot would have rendered The Ossuary's deep-time half — twelve thousand
years of it — in modern idiom, scored the correct period language as wrong, and reported success.

The information was in the outline the whole time: all 96 chapters carry a research period, from
`ca. 10,500 BCE` to `March 2011`.
"""

from __future__ import annotations

from chapter_step.main import chapter_period

OUTLINE = {
    "chapters": [
        {"chapter_number": 0, "title": "Prologue", "research": {"period": "March 2011"}},
        {"chapter_number": 2, "title": "Chert biface", "research": {"period": "ca. 10,500 BCE"}},
        {"chapter_number": 45, "title": "Copper bead", "research": {"period": "ca. AD 1590"}},
        {"chapter_number": 50, "title": "No research at all"},
        {"chapter_number": 51, "title": "Empty period", "research": {"period": "   "}},
    ]
}


class TestChapterPeriod:
    def test_it_reads_the_chapters_own_era(self) -> None:
        assert chapter_period(OUTLINE, 2) == "ca. 10,500 BCE"
        assert chapter_period(OUTLINE, 45) == "ca. AD 1590"
        assert chapter_period(OUTLINE, 0) == "March 2011"

    def test_an_explicit_value_wins(self) -> None:
        """A caller rewriting one chapter in another era means it."""
        assert chapter_period(OUTLINE, 2, "1850") == "1850"

    def test_a_blank_explicit_value_does_not_win(self) -> None:
        """The common case: a payload that simply omits period, or sends an empty string."""
        assert chapter_period(OUTLINE, 2, "") == "ca. 10,500 BCE"
        assert chapter_period(OUTLINE, 2, "   ") == "ca. 10,500 BCE"

    def test_a_chapter_without_a_period_falls_back(self) -> None:
        assert chapter_period(OUTLINE, 50) == "contemporary"
        assert chapter_period(OUTLINE, 51) == "contemporary"

    def test_a_top_level_outline_period_is_used_before_the_fallback(self) -> None:
        outline = {"period": "1640s", "chapters": [{"chapter_number": 1, "title": "x"}]}
        assert chapter_period(outline, 1) == "1640s"

    def test_an_unknown_chapter_number_does_not_raise(self) -> None:
        assert chapter_period(OUTLINE, 999) == "contemporary"

    def test_an_empty_outline_does_not_raise(self) -> None:
        assert chapter_period({}, 1) == "contemporary"
        assert chapter_period({"chapters": []}, 1) == "contemporary"

    def test_the_write_qa_and_drift_paths_all_derive_it(self) -> None:
        """A helper nothing calls is worth nothing — this was a 96-chapter-wide silent defect."""
        import inspect

        from chapter_step import main as M

        src = inspect.getsource(M)
        # the definition plus write, qa, drift and repair
        assert src.count("chapter_period(") >= 5
        # The only surviving "contemporary" default is the standalone-content path (blog / short
        # story), which has no chapter number and no outline entry to read an era from.
        assert src.count('payload.get("period") or "contemporary"') == 1
