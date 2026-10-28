"""Volume planning: the page cap is a constraint, the story is the objective.

A 600,000-word novel is 1,500-2,000 pages at any honest type size, and KDP stops at 828. So it is
physically three books. The naive response — cut every 200 pages — is how volume one ends in the
middle of a conversation, which is why the splits are chosen by ending strength and merely
CONSTRAINED by pages.
"""

from __future__ import annotations

from itertools import pairwise

from writer_engine.volumes import (
    KDP_MAX_PAGES,
    SAFE_MAX_PAGES,
    WORDS_PER_PAGE,
    ChapterInfo,
    break_indices,
    compare_trims,
    estimate_pages,
    minimum_volumes,
    plan_volumes,
    split_candidates,
)


def ch(n: int, words: int = 6000, *, turn: float = 0.5, tail: str = "") -> ChapterInfo:
    return ChapterInfo(number=n, title=f"Chapter {n}", words=words, story_turn_density=turn, tail=tail)


class TestPageEstimates:
    def test_a_real_book_is_three_volumes(self) -> None:
        """The Ossuary: 600,790 words over 96 chapters."""
        pages = estimate_pages(600_790, 96, "6x9")
        assert pages > 1_700
        assert pages > KDP_MAX_PAGES * 2, "two volumes would not fit either"

    def test_a_bigger_trim_fits_more(self) -> None:
        assert estimate_pages(100_000, 20, "6.69x9.61") < estimate_pages(100_000, 20, "5x8")

    def test_chapter_openers_cost_pages(self) -> None:
        """Each chapter starts on a fresh page, so many short chapters cost more than few long ones."""
        assert estimate_pages(60_000, 60, "6x9") > estimate_pages(60_000, 6, "6x9")

    def test_front_and_back_matter_are_counted(self) -> None:
        assert estimate_pages(50_000, 10, "6x9") > estimate_pages(50_000, 10, "6x9", matter=False)

    def test_minimum_volumes_for_a_short_book_is_one(self) -> None:
        assert minimum_volumes([ch(i) for i in range(1, 11)], "6x9") == 1

    def test_minimum_volumes_for_a_long_one_is_more(self) -> None:
        assert minimum_volumes([ch(i) for i in range(1, 97)], "6x9") >= 3


class TestTheCapIsAConstraint:
    def test_no_volume_exceeds_the_safe_cap(self) -> None:
        plan = plan_volumes([ch(i) for i in range(1, 97)], trim="6x9")
        assert plan.volumes
        for v in plan.volumes:
            assert v.estimated_pages <= SAFE_MAX_PAGES, f"volume {v.index} busts the cap"

    def test_a_single_volume_that_is_too_long_is_reported_not_silently_produced(self) -> None:
        plan = plan_volumes([ch(i) for i in range(1, 97)], trim="6x9", volume_count=1)
        assert plan.volumes[0].estimated_pages > KDP_MAX_PAGES
        assert any("maximum" in w for w in plan.warnings)

    def test_an_impossible_request_warns_instead_of_returning_junk(self) -> None:
        plan = plan_volumes([ch(i) for i in range(1, 97)], trim="6x9", volume_count=2)
        assert plan.volumes == []
        assert any("under" in w for w in plan.warnings)

    def test_every_chapter_lands_in_exactly_one_volume(self) -> None:
        chapters = [ch(i) for i in range(1, 97)]
        plan = plan_volumes(chapters, trim="6x9")
        seen = [c for v in plan.volumes for c in v.chapters]
        assert seen == [c.number for c in chapters]

    def test_volumes_are_contiguous_and_in_order(self) -> None:
        plan = plan_volumes([ch(i) for i in range(1, 97)], trim="6x9")
        for a, b in pairwise(plan.volumes):
            assert a.last_chapter + 1 == b.first_chapter


class TestTheStoryIsTheObjective:
    def test_it_ends_a_volume_on_the_stronger_hook(self) -> None:
        """Two legal split points, one of which is a strong series ending. It must choose that one."""
        chapters = [ch(i, 6000, turn=0.4) for i in range(1, 61)]
        chapters[29].judged = 0.95  # chapter 30 — a real hook
        chapters[31].judged = 0.10  # chapter 32 — resolves everything
        plan = plan_volumes(chapters, trim="6x9", volume_count=2)
        assert plan.volumes[0].last_chapter == 30

    def test_it_will_take_an_uneven_split_to_get_a_better_ending(self) -> None:
        """A reader forgives a shorter volume; they do not forgive stopping mid-scene."""
        chapters = [ch(i, 6000, turn=0.4) for i in range(1, 61)]
        chapters[23].judged = 0.99  # chapter 24: well off-centre, but the right place to stop
        plan = plan_volumes(chapters, trim="6x9", volume_count=2)
        assert plan.volumes[0].last_chapter == 24

    def test_but_not_an_absurdly_uneven_one(self) -> None:
        """Balance still has a vote — a hook in chapter 3 does not make a 3-chapter volume."""
        chapters = [ch(i, 6000, turn=0.4) for i in range(1, 61)]
        chapters[2].judged = 0.99
        plan = plan_volumes(chapters, trim="6x9", volume_count=2)
        assert plan.volumes[0].last_chapter > 10

    def test_a_weak_final_hook_is_flagged(self) -> None:
        chapters = [ch(i, 6000, turn=0.2) for i in range(1, 61)]
        for c in chapters:
            c.judged = 0.2
        plan = plan_volumes(chapters, trim="6x9", volume_count=2)
        assert any("weak hook" in w for w in plan.warnings)

    def test_the_last_volume_is_not_required_to_cliffhang(self) -> None:
        """The end of the book is allowed to be an ending."""
        chapters = [ch(i, 6000, turn=0.2) for i in range(1, 61)]
        for c in chapters:
            c.judged = 0.9
        chapters[-1].judged = 0.05
        plan = plan_volumes(chapters, trim="6x9", volume_count=2)
        assert not any("weak hook" in w for w in plan.warnings)


class TestEndingHeuristic:
    def test_a_closing_question_reads_as_open(self) -> None:
        a = ch(1, tail="She looked at the door. Who else had known?")
        b = ch(2, tail="She looked at the door. It was over, and at last she slept.")
        assert a.heuristic_ending_score > b.heuristic_ending_score

    def test_valediction_reads_as_closed(self) -> None:
        c = ch(1, turn=0.9, tail="It was done. For the last time, she closed her eyes.")
        assert c.heuristic_ending_score < 0.6

    def test_the_llm_judgement_overrides_the_heuristic(self) -> None:
        c = ch(1, turn=0.1, tail="It was over. Finally, peace.")
        assert c.heuristic_ending_score < 0.4
        c.judged = 0.9
        assert c.ending_score == 0.9


class TestCandidateShortlist:
    def test_it_shortlists_rather_than_scoring_the_whole_book(self) -> None:
        """Judging all 96 chapters to decide two boundaries is most of a book's worth of calls."""
        chapters = [ch(i) for i in range(1, 97)]
        cands = split_candidates(chapters, trim="6x9", volume_count=3)
        assert 0 < len(cands) < 60
        assert all(0 <= i < len(chapters) for i in cands)


class TestTrimIsAChoiceWithAConsequence:
    """Trim is not only an aesthetic decision — it decides how many books the manuscript becomes."""

    def test_it_reports_every_trim(self) -> None:
        rows = compare_trims([ch(i) for i in range(1, 97)])
        assert {r["trim"] for r in rows} == set(WORDS_PER_PAGE)

    def test_a_larger_trim_needs_fewer_or_equal_volumes(self) -> None:
        rows = {r["trim"]: r for r in compare_trims([ch(i) for i in range(1, 97)])}
        assert rows["6.69x9.61"]["minimum_volumes"] <= rows["5x8"]["minimum_volumes"]

    def test_it_says_outright_whether_one_volume_is_possible(self) -> None:
        long_book = compare_trims([ch(i) for i in range(1, 97)])
        assert all(r["fits_one_volume"] is False for r in long_book)
        short_book = compare_trims([ch(i, 4000) for i in range(1, 16)])
        assert any(r["fits_one_volume"] for r in short_book)

    def test_fewest_volumes_is_listed_first(self) -> None:
        rows = compare_trims([ch(i) for i in range(1, 97)])
        assert rows[0]["minimum_volumes"] <= rows[-1]["minimum_volumes"]


class TestAuthorBreaks:
    """The author picks where each book ends; the planner reports the cost but never moves it."""

    def test_the_breaks_are_used_as_given(self) -> None:
        chapters = [ch(i, 6000) for i in range(0, 96)]
        chapters[40].judged = 0.95  # the planner would like this one
        plan = plan_volumes(chapters, trim="6x9", breaks=[28, 59])
        assert [(v.first_chapter, v.last_chapter) for v in plan.volumes] == [(0, 28), (29, 59), (60, 95)]

    def test_volume_count_follows_the_breaks(self) -> None:
        chapters = [ch(i, 3000) for i in range(1, 41)]
        plan = plan_volumes(chapters, trim="6x9", volume_count=5, breaks=[20])
        assert len(plan.volumes) == 2

    def test_an_over_long_book_is_warned_not_moved(self) -> None:
        chapters = [ch(i, 6000) for i in range(1, 97)]
        plan = plan_volumes(chapters, trim="6x9", breaks=[90])
        assert plan.volumes[0].last_chapter == 90
        assert any("over the" in w for w in plan.warnings)

    def test_the_last_chapter_cannot_end_a_book(self) -> None:
        chapters = [ch(i) for i in range(1, 11)]
        assert "last chapter" in str(break_indices(chapters, [10]))
        assert plan_volumes(chapters, breaks=[10]).volumes == []

    def test_breaks_must_be_in_order(self) -> None:
        chapters = [ch(i) for i in range(1, 11)]
        assert "after the one before" in str(break_indices(chapters, [6, 3]))
        assert "after the one before" in str(break_indices(chapters, [4, 4]))

    def test_an_unknown_chapter_is_refused(self) -> None:
        assert "not in the book" in str(break_indices([ch(i) for i in range(1, 11)], [42]))
