"""Each sub-chapter must name the change it delivers, and the writer must be told it.

The pacing weakness the 96-chapter benchmark exposed was not a missing instruction. The planner
prompt already said "Together the sub-chapters cover the chapter beginning/middle/end with at least
one story turn each" — as a trailing clause in a long sentence, with no field to put the answer in.
So nothing forced the model to name a turn, and the writer never received one: it was told what each
section was ABOUT, never what had to CHANGE by its end.

Measured: `story_turn_density` 0.79 median, under threshold in 51 of 96 chapters, and the commonest
finding was a final section of five or six pages in which nothing new arose.

The post-hoc alternative was tried first and does not work at this length — six whole-chapter
revisions across three chapters, under two prompts, all rejected at 48-80% of the original. This
shapes the draft instead of patching it, and costs nothing per chapter.
"""

from __future__ import annotations

from writer_engine.schemas.chapter import SubChapterBrief


class TestTheBriefCarriesATurn:
    def test_the_field_exists_and_defaults_empty(self) -> None:
        """Default empty so the 96 chapters already planned without it still load."""
        assert SubChapterBrief().story_turn == ""

    def test_it_round_trips(self) -> None:
        b = SubChapterBrief.model_validate(
            {
                "beat": "She fires the vessel",
                "story_turn": "The vessel cracks; the winter's water store is lost.",
            }
        )
        assert b.story_turn.startswith("The vessel cracks")

    def test_an_older_plan_without_the_field_still_validates(self) -> None:
        old = {"number": 1, "title": "t", "beat": "b", "arc_beat": "setup", "characters": ["Kaya"]}
        assert SubChapterBrief.model_validate(old).story_turn == ""


class TestThePlannerRequiresIt:
    @staticmethod
    def _system() -> str:
        from chapter_step.main import _plan_system

        return _plan_system("historical-time-travel", {"chapters": []})

    def test_the_field_is_in_the_required_list(self) -> None:
        assert "story_turn" in self._system()

    def test_it_says_what_a_turn_is_and_is_not(self) -> None:
        system = self._system()
        assert "what is DIFFERENT at the end" in system
        # The two non-turns taken from real findings.
        assert "is not a turn" in system
        assert "reflects on her mother" in system

    def test_it_demands_a_turn_in_the_FINAL_section(self) -> None:
        """The commonest finding across the book: a closing section of five or six pages in which
        nothing happens."""
        system = self._system()
        assert "THE LAST SUB-CHAPTER NEEDS ONE TOO" in system
        assert "aftermath, summary or reflection" in system

    def test_it_offers_merging_rather_than_inventing_a_fake_turn(self) -> None:
        """A planner that cannot name a change should plan fewer sections, not fabricate drama."""
        assert "merge it into its neighbour" in self._system()

    def test_a_non_conflict_arc_is_still_allowed_a_quiet_turn(self) -> None:
        """Kishōtenketsu chapters must not be pushed into confrontation by this rule."""
        system = self._system()
        assert "a turn there can be quiet" in system


class TestTheWriterIsToldTheTurn:
    @staticmethod
    def _prompt(brief: SubChapterBrief) -> str:
        import asyncio
        from unittest.mock import patch

        captured: dict[str, str] = {}

        class _Resp:
            text = "prose"
            cache_read_tokens = 0
            cache_write_tokens = 0

        class _Router:
            async def complete(self, **kw: object) -> _Resp:
                captured["prompt"] = str(kw.get("prompt"))
                return _Resp()

        from chapter_step import main as M

        with patch.object(M, "get_router", lambda service=None: _Router()):
            asyncio.run(
                M._write_subchapter(
                    system="sys",
                    brief=brief,
                    idx=0,
                    total=5,
                    prior_tail="",
                    chapter_number=12,
                    model="claude-sonnet-4-6",
                )
            )
        return captured["prompt"]

    def test_the_turn_reaches_the_writer(self) -> None:
        prompt = self._prompt(
            SubChapterBrief(
                beat="She fires the vessel", story_turn="The vessel cracks and the water store is lost."
            )
        )
        assert "THIS SECTION MUST END WITH A CHANGE" in prompt
        assert "The vessel cracks and the water store is lost." in prompt
        assert "has to occur on the page" in prompt

    def test_a_brief_without_a_turn_adds_nothing(self) -> None:
        """The 96 chapters already planned have no turns recorded; they must not get an empty
        instruction telling them to end with nothing."""
        prompt = self._prompt(SubChapterBrief(beat="She fires the vessel"))
        assert "MUST END WITH A CHANGE" not in prompt
        assert "She fires the vessel" in prompt

    def test_whitespace_is_not_a_turn(self) -> None:
        prompt = self._prompt(SubChapterBrief(beat="b", story_turn="   "))
        assert "MUST END WITH A CHANGE" not in prompt


class TestTheWriterIsToldWhoIsThere:
    """Two fields the plan filled in and the writer never saw.

    `characters` was asked for by the planner prompt and then read by nothing — paid for in output
    tokens on every plan call and discarded. `pov_character` was the mirror image: the writer prompt
    had a `(POV: …)` clause, but the planner was never asked for the field, so on every real chapter
    it was empty and the clause could not fire. The beat text names its people in passing, which is
    not the same thing: it does not say whose eyes the section is seen through.
    """

    def test_the_planner_asks_for_the_pov(self) -> None:
        from chapter_step.main import _plan_system

        system = _plan_system("historical-time-travel", {"chapters": []})
        assert "pov_character" in system
        assert "which ONE of them the section is seen through" in system

    def test_the_cast_reaches_the_writer(self) -> None:
        prompt = TestTheWriterIsToldTheTurn._prompt(
            SubChapterBrief(beat="b", characters=["Makaya", "Kaya"], pov_character="Makaya")
        )
        assert "ON THE PAGE: Makaya, Kaya" in prompt
        assert "(POV: Makaya)" in prompt

    def test_an_empty_cast_adds_no_line(self) -> None:
        prompt = TestTheWriterIsToldTheTurn._prompt(SubChapterBrief(beat="b"))
        assert "ON THE PAGE" not in prompt

    def test_blank_names_are_dropped_not_printed_as_commas(self) -> None:
        prompt = TestTheWriterIsToldTheTurn._prompt(SubChapterBrief(beat="b", characters=["Kaya", "  ", ""]))
        assert "ON THE PAGE: Kaya\n" in prompt

    def test_the_output_ban_on_a_cast_label_survives(self) -> None:
        """Naming the cast in the prompt is exactly what makes a model print a 'Confirmed cast:'
        header, which _strip_scaffolding was written for."""
        prompt = TestTheWriterIsToldTheTurn._prompt(SubChapterBrief(beat="b", characters=["Kaya"]))
        assert "'Confirmed cast' / 'POV character' label" in prompt

    def test_an_era_cast_outside_the_roster_is_allowed(self) -> None:
        """The Ossuary's roster holds 6 modern entries for a book spanning 12,000 years. "names taken
        EXACTLY from the CHARACTER ROSTER — never invent" made the planner return [] for every
        deep-time chapter, which is obedient and useless."""
        from chapter_step.main import _plan_system

        system = _plan_system("historical-time-travel", {"chapters": []})
        assert "may name its own cast" in system
        assert "never contradict it" in system
