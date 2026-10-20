"""The craft seeds are fill-in templates and nothing ever filled them in.

Found scoring 91 chapters in a single run. The seeds are written with `{period}`,
`{locked_character_roster}`, `{place}` and `{specific_question}` slots, but `compose_craft_system`
joined them verbatim — so every system prompt the engine has ever sent carried literal braces.

Usually harmless: the real period and roster appear in the user message a few lines later and the
model infers what was meant. Once in 91 it did not, and answered

    "I need to fill in the template variables before proceeding. The prompt contains `{period}` and
     `{locked_character_roster}` as unfilled placeholders"

on BOTH the first attempt and the retry, so that chapter came back with no scores at all. A ~1%
failure rate is invisible on one chapter and costs a chapter a book.
"""

from __future__ import annotations

from writer_engine.prompt_store.follett_seeds import compose_craft_system, fill_seed_placeholders

SEEDS = ["follett_seeds.character.locked_roster", "follett_seeds.research.period_language"]


class TestFill:
    def test_a_supplied_value_is_used(self) -> None:
        assert (
            fill_seed_placeholders("set in {period}.", {"period": "ca. 2,400 BCE"}) == "set in ca. 2,400 BCE."
        )

    def test_an_unsupplied_slot_points_at_where_the_value_IS(self) -> None:
        """The fallback has to be better than a brace and better than silence: the value really is
        in the user message, so say so."""
        got = fill_seed_placeholders("set in {period}.")
        assert "{" not in got
        assert "given below" in got

    def test_an_empty_value_falls_back_rather_than_blanking_the_sentence(self) -> None:
        """`period=""` would otherwise render "This manuscript is set in ." — worse than the brace."""
        got = fill_seed_placeholders("set in {period}.", {"period": "   "})
        assert "given below" in got

    def test_an_unknown_brace_is_left_alone(self) -> None:
        """Prose and code samples contain braces. Only the seeds' own slot names are substituted."""
        assert fill_seed_placeholders("use {whatever} here") == "use {whatever} here"

    def test_every_known_slot_is_covered(self) -> None:
        text = "{period} {place} {locked_character_roster} {specific_question}"
        assert "{" not in fill_seed_placeholders(text)


class TestComposedPromptsAreClean:
    def test_no_literal_placeholder_survives_composition(self) -> None:
        out = compose_craft_system(seed_keys=SEEDS)
        for slot in ("{period}", "{locked_character_roster}", "{place}", "{specific_question}"):
            assert slot not in out, f"{slot} reached the model"

    def test_the_real_values_are_substituted_when_known(self) -> None:
        out = compose_craft_system(
            seed_keys=SEEDS,
            placeholders={"period": "March 2011", "locked_character_roster": "Makaya — bone-tender"},
        )
        assert "March 2011" in out
        assert "Makaya — bone-tender" in out

    def test_the_qa_system_prompt_is_clean(self) -> None:
        from chapter_step.main import _build_qa_system

        assert "{period}" not in _build_qa_system()
        assert "{locked_character_roster}" not in _build_qa_system()

    def test_the_qa_system_prompt_carries_the_chapter_period(self) -> None:
        from chapter_step.main import _build_qa_system

        assert "ca. 10,500 BCE" in _build_qa_system("ca. 10,500 BCE", "Kaya — potter")
