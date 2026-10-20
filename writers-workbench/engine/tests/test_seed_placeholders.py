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

import pytest

from writer_engine.prompt_store.follett_seeds import (
    compose_craft_system,
    fill_seed_placeholders,
    load_follett_seeds,
)


@pytest.fixture(autouse=True)
def _seeds_registered() -> None:
    """`compose_craft_system` reads from the prompt store, and the seeds are registered by an
    import side effect elsewhere. Without this these tests pass or fail depending on which other
    test file ran first, which is worse than failing."""
    load_follett_seeds()


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


class TestTheQaPromptDoesNotAskForProse:
    """The reviewer must return strict JSON, so it must not carry a seed that tells it to write a
    prose section first.

    `character.locked_roster` is a WRITING seed and it ends with a COPY-FIRST RULE: "before writing
    anything new, copy the LOCKED CHARACTERS roster above into your output verbatim, as a section
    labeled 'Confirmed cast'". It sat in the QA prompt harmlessly for as long as the roster was an
    unsubstituted `{locked_character_roster}` placeholder — template noise the model ignored. The
    moment the placeholder started carrying a real roster, the instruction became actionable and the
    model followed it: scoring 96 chapters, an answer came back as

        "# Confirmed Cast\\n\\n- **Marcus Tayac**: Protagonist; Piscataway Historic Preservation..."

    instead of JSON, and that chapter lost all eight scores. Fixing one prompt bug switched another
    one on.
    """

    @staticmethod
    def _system() -> str:
        from chapter_step.main import _build_qa_system

        return _build_qa_system("March 2011", "Marcus Tayac — preservation officer")

    def test_the_copy_first_rule_is_absent(self) -> None:
        assert "COPY-FIRST RULE" not in self._system()
        assert "Confirmed cast" not in self._system()

    def test_the_reviewer_is_still_told_to_return_json(self) -> None:
        assert "strict JSON" in self._system()

    def test_the_roster_still_reaches_the_reviewer_elsewhere(self) -> None:
        """Dropping the seed must not cost the reviewer the roster — it comes in the user prompt,
        which is where a reviewer needs it."""
        from chapter_step.main import _score_chapter

        assert callable(_score_chapter)
        # The user prompt is built in _score_chapter as "CHARACTER ROSTER (check consistency ...)".
        import inspect

        src = inspect.getsource(_score_chapter)
        assert "CHARACTER ROSTER" in src

    def test_the_period_substitution_that_started_this_still_works(self) -> None:
        assert "March 2011" in self._system()
