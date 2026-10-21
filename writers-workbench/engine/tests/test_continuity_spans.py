"""A named character who outlives what a person can outlive.

Found by a reader, not by the engine: "Strikes-Twice" appears in chapters 2 and 3 (ca. 10,500 BCE)
and again in chapter 4 (ca. 10,200 BCE) — three hundred years. Nothing flagged it and nothing could
have, because every quality check in this engine scores ONE chapter against its own brief. The craft
QA never sees a sibling chapter, and the deterministic name check only compares against the
project's character roster, which on that book is six modern people.
"""

from __future__ import annotations

from writer_engine.continuity import find_impossible_spans, names_in, parse_period_year


class TestPeriodParsing:
    def test_deep_time_is_negative(self) -> None:
        assert parse_period_year("ca. 10,500 BCE") == -10500
        assert parse_period_year("10,200 BCE") == -10200
        assert parse_period_year("ca. 3,000 BCE") == -3000

    def test_historical_and_modern(self) -> None:
        assert parse_period_year("1655") == 1655
        assert parse_period_year("March 2011") == 2011
        assert parse_period_year("ca. AD 1300") == 1300

    def test_bc_as_well_as_bce(self) -> None:
        assert parse_period_year("1200 BC") == -1200

    def test_unreadable_is_none_not_a_guess(self) -> None:
        """A guessed year would invent a span, which is worse than reporting nothing."""
        assert parse_period_year("") is None
        assert parse_period_year("the distant past") is None

    def test_contemporary_resolves_to_now(self) -> None:
        assert (parse_period_year("contemporary") or 0) > 2000


class TestNameExtraction:
    def test_a_hyphenated_name_is_kept_whole(self) -> None:
        text = "Strikes-Twice went down to the water. Strikes-Twice did not look back."
        assert "Strikes-Twice" in names_in(text)

    def test_ordinary_capitalised_words_are_not_names(self) -> None:
        text = "Three hundred years is a long time. Without the spring they would not have stayed. " * 2
        got = names_in(text)
        assert "Three" not in got and "Without" not in got

    def test_a_single_mention_is_not_tracked(self) -> None:
        """One mention is as likely a place or a walk-on as a character worth following."""
        assert "Flintknapper" not in names_in("The Flintknapper came once and left.")

    def test_months_and_titles_are_excluded(self) -> None:
        text = "March was cold. March was colder still. Father spoke. Father said nothing more."
        got = names_in(text)
        assert "March" not in got and "Father" not in got


# The real case, reduced: the same name 300 years apart.
REAL: list[tuple[int, str, str]] = [
    (2, "ca. 10,500 BCE", "Strikes-Twice reached the bluff. Strikes-Twice read the near bank."),
    (3, "ca. 10,500 BCE", "Strikes-Twice slept. Strikes-Twice would wake and know."),
    (4, "ca. 10,200 BCE", "The boy's name was Strikes-Twice. He let the boy be Strikes-Twice."),
]


class TestImpossibleSpans:
    def test_it_catches_the_case_a_reader_had_to_find(self) -> None:
        spans = find_impossible_spans(REAL)
        assert [s.name for s in spans] == ["Strikes-Twice"]
        assert spans[0].gap_years == 300
        assert spans[0].chapters == (2, 3, 4)

    def test_the_report_names_the_chapters_and_the_years(self) -> None:
        d = find_impossible_spans(REAL)[0].describe()
        assert "10,500 BCE" in d and "10,200 BCE" in d and "300 years" in d

    def test_a_name_within_one_lifetime_is_not_flagged(self) -> None:
        """Chapters 2 and 3 share a period — a character in both is simply a character."""
        spans = find_impossible_spans(REAL[:2])
        assert spans == []

    def test_a_modern_character_across_a_few_years_is_fine(self) -> None:
        rows = [
            (1, "March 2011", "Marcus Tayac drove south. Marcus Tayac did not open it."),
            (5, "2011", "Marcus Tayac waited. Marcus Tayac signed."),
            (9, "2004", "Marcus Tayac remembered. Marcus Tayac had been there."),
        ]
        assert find_impossible_spans(rows) == []

    def test_an_unparseable_period_is_skipped_not_guessed(self) -> None:
        rows = [
            (1, "ca. 10,500 BCE", "Koss carried it. Koss set it down."),
            (2, "some time later", "Koss carried it. Koss set it down."),
        ]
        assert find_impossible_spans(rows) == []

    def test_widest_gap_comes_first(self) -> None:
        rows = [
            (1, "ca. 10,000 BCE", "Alpha walked. Alpha stopped."),
            (2, "ca. 9,000 BCE", "Alpha walked. Alpha stopped."),
            (3, "ca. 3,000 BCE", "Beta walked. Beta stopped."),
            (4, "ca. 2,900 BCE", "Beta walked. Beta stopped."),
        ]
        spans = find_impossible_spans(rows)
        assert [s.name for s in spans] == ["Alpha", "Beta"]
        assert spans[0].gap_years > spans[1].gap_years

    def test_the_threshold_is_adjustable(self) -> None:
        rows = [
            (1, "1900", "Winifred spoke. Winifred waited."),
            (2, "1980", "Winifred spoke. Winifred waited."),
        ]
        assert find_impossible_spans(rows) == []  # 80 years, within a life
        assert len(find_impossible_spans(rows, lifespan_years=50)) == 1

    def test_no_chapters_is_no_findings(self) -> None:
        assert find_impossible_spans([]) == []


class TestPeriodParsingPicksTheYearNotTheFirstNumber:
    def test_a_day_before_the_year(self) -> None:
        """ "9 January 2012" parsed as year 9 under first-match, which put every modern chapter two
        thousand years before the rest of the book and invented a 2,003-year span for every
        present-day character in it."""
        assert parse_period_year("9 January 2012") == 2012

    def test_late_february(self) -> None:
        assert parse_period_year("late February 2012") == 2012

    def test_deep_time_is_unaffected(self) -> None:
        assert parse_period_year("ca. 10,500 BCE") == -10500


class TestPlacesPeoplesAndOrdinaryWords:
    """The first run of this check reported 120 spans on a 96-chapter book. Almost all were place
    names, peoples, or ordinary words that happened to start a sentence — a report nobody reads
    twice. The filters are drawn from the book itself rather than a word list to maintain."""

    def test_a_word_used_in_lower_case_elsewhere_is_not_a_name(self) -> None:
        rows = [
            (1, "ca. 10,000 BCE", "Good hunting. Good weather. the good ground held."),
            (2, "ca. 1,000 BCE", "Good hunting again. Good weather. a good day for it."),
        ]
        assert [s.name for s in find_impossible_spans(rows)] == []

    def test_a_people_or_a_river_is_not_a_character(self) -> None:
        """ "the English", "the Potomac" — capitalised, never lower case, and they legitimately
        recur across four hundred years. The article is what separates them from a person."""
        rows = [
            (1, "ca. 1,600", "The Potomac ran grey. The Potomac was wide. They watched the Potomac."),
            (2, "ca. 1,000 BCE", "The Potomac ran grey then too. The Potomac held them."),
        ]
        assert [s.name for s in find_impossible_spans(rows)] == []

    def test_a_place_after_a_preposition_is_not_a_character(self) -> None:
        rows = [
            (1, "1650", "He rode to Annapolis. In Annapolis the session sat. From Annapolis he wrote."),
            (2, "ca. 1,000 BCE", "To Annapolis they would not go. In Annapolis nothing stood yet."),
        ]
        assert [s.name for s in find_impossible_spans(rows)] == []

    def test_a_real_character_survives_the_filters(self) -> None:
        rows = [
            (1, "ca. 10,500 BCE", "Strikes-Twice reached the bluff. Strikes-Twice read the bank."),
            (2, "ca. 10,200 BCE", "The boy's name was Strikes-Twice. He let the boy be Strikes-Twice."),
        ]
        assert [s.name for s in find_impossible_spans(rows)] == ["Strikes-Twice"]


class TestAdjacencyIsWhatMakesItReadAsAnError:
    def test_carrying_straight_across_a_chapter_boundary_is_flagged(self) -> None:
        """The reader is still holding the person from the previous page."""
        rows = [
            (3, "ca. 10,500 BCE", "Strikes-Twice slept. Strikes-Twice would wake."),
            (4, "ca. 10,200 BCE", "The boy was Strikes-Twice. He let the boy be Strikes-Twice."),
        ]
        span = find_impossible_spans(rows)[0]
        assert span.reads_as_an_error is True
        assert span.adjacent_jump == (3, 4, 300)

    def test_a_name_returning_many_chapters_later_reads_as_an_echo(self) -> None:
        """Twenty chapters on, a repeated name is a naming tradition or a descendant — which is the
        deliberate device this book is built on, so it must not be called a defect."""
        rows = [
            (7, "ca. 2,800 BCE", "Crow-Sits watched. Crow-Sits waited."),
            (41, "1550", "Crow-Sits watched again. Crow-Sits waited."),
        ]
        span = find_impossible_spans(rows)[0]
        assert span.reads_as_an_error is False
        assert span.adjacent_jump is None

    def test_an_alternating_timeline_is_not_an_error_in_either_direction(self) -> None:
        """This book alternates a present-day thread with a historical one, so chapter 53 (2011)
        sits between chapters 52 and 54 (both 1640). Characters in 2011 discuss seventeenth-century
        figures because that is the subject of the book — forwards and backwards both."""
        rows = [
            (52, "1640", "Kittamaquund signed it. Kittamaquund was baptised."),
            (53, "2011", "Kittamaquund's name was in the record. Kittamaquund, the chief."),
            (54, "1640", "Kittamaquund spoke. Kittamaquund waited."),
        ]
        assert [s for s in find_impossible_spans(rows) if s.reads_as_an_error] == []

    def test_errors_sort_above_echoes(self) -> None:
        rows = [
            (1, "ca. 9,000 BCE", "Echo walked. Echo stopped."),
            (30, "1500", "Echo walked. Echo stopped."),
            (3, "ca. 10,500 BCE", "Close slept. Close woke."),
            (4, "ca. 10,200 BCE", "Close slept again. Close woke."),
        ]
        spans = find_impossible_spans(rows)
        assert spans[0].name == "Close", "the adjacent jump outranks the far wider echo"
        assert spans[0].gap_years < spans[1].gap_years
