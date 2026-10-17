"""E7 — the Draft Review Kit lenses as engine prompts.

The kit's ``SKILL.md`` files are written for an interactive coding agent. Handed to an API call
unmodified, the most load-bearing thing they say is "ask the user what needs cutting" — so what this
pins is mostly the adaptation: the right sections gone, the orchestrators kept separate from the
single-pass lenses, and the guardrails lens pointed at fiction with its catalogue inlined.
"""

from __future__ import annotations

import pytest

from writer_engine.review import lenses


class TestVendoredFiles:
    def test_every_lens_has_a_vendored_skill(self) -> None:
        """A packaging regression (the .md files not shipping in the image) would otherwise only
        surface as a failing review in production."""
        for lens in lenses.ALL_LENSES:
            assert lenses.load_skill(lens).strip(), lens

    def test_the_kit_licence_travels_with_the_copies(self) -> None:
        """MIT, EveryInc / Katie Parrott. Vendored code keeps its licence."""
        licence = lenses.SKILLS_DIR / "LICENSE"
        assert licence.exists()
        assert "MIT" in licence.read_text(encoding="utf-8")

    def test_the_follett_catalogue_is_vendored_too(self) -> None:
        text = lenses.load_skill("guardrails-follett")
        assert "Follett" in text

    def test_there_are_thirteen_lenses(self) -> None:
        assert len(lenses.ALL_LENSES) == 13
        assert len(lenses.SINGLE_LENSES) == 11
        assert set(lenses.MULTI_LENS_MEMBERS) == {"panel", "debate"}


class TestSectionStripping:
    def test_the_invocation_section_is_dropped(self) -> None:
        """The harmful one: it tells the model to ask the user what to review, and there is nobody
        to answer a question asked inside a step service."""
        assert "## Invocation" in lenses.load_skill("hemingway")
        prompt = lenses.lens_prompt("hemingway")
        assert "## Invocation" not in prompt
        assert "/hemingway [text]" not in prompt

    def test_the_substance_survives(self) -> None:
        prompt = lenses.lens_prompt("hemingway")
        assert "Adverbs" in prompt
        assert "The Hemingway Test" in prompt
        assert "Strip your writing to the bone" in prompt

    def test_frontmatter_is_dropped(self) -> None:
        prompt = lenses.lens_prompt("sorkin")
        assert "user_invocable" not in prompt
        assert not prompt.startswith("---")

    def test_a_skill_with_no_headings_survives_intact(self) -> None:
        assert lenses.strip_agent_sections("Just a paragraph.") == "Just a paragraph."

    def test_the_purpose_paragraph_before_the_first_heading_is_kept(self) -> None:
        text = "Lead paragraph.\n\n## Invocation\nignore me\n\n## Keep\nkept\n"
        out = lenses.strip_agent_sections(text)
        assert "Lead paragraph." in out
        assert "ignore me" not in out
        assert "kept" in out


class TestGuardrails:
    def test_fiction_mode_is_forced(self) -> None:
        """The skill is dual-mode and its non-fiction half references EveryInc columns and companion
        skills that do not exist in this repo."""
        prompt = lenses.lens_prompt(lenses.GUARDRAILS)
        assert "Run the FICTION mode only" in prompt
        assert "do not apply" in prompt

    def test_the_catalogue_is_inlined_not_referenced(self) -> None:
        """The SKILL.md points at ``references/follett-style-guardrails.md``; a model cannot follow
        a file path at inference time."""
        prompt = lenses.lens_prompt(lenses.GUARDRAILS)
        assert len(prompt) > len(lenses.strip_agent_sections(lenses.load_skill("guardrails")))
        assert "Follett" in prompt


class TestNames:
    @pytest.mark.parametrize(
        ("given", "expected"),
        [
            ("dev_edit", "dev-edit"),
            ("Dev-Edit", "dev-edit"),
            ("DEV EDIT", "dev-edit"),
            ("  panel  ", "panel"),
        ],
    )
    def test_normalisation(self, given: str, expected: str) -> None:
        assert lenses.normalise(given) == expected

    def test_an_unknown_lens_raises(self) -> None:
        with pytest.raises(lenses.UnknownLens):
            lenses.normalise("shakespeare")

    def test_every_lens_has_a_label(self) -> None:
        for lens in lenses.ALL_LENSES:
            assert lenses.label(lens) != lens or lens in lenses.LENS_LABELS

    def test_an_unknown_label_falls_back_to_the_input(self) -> None:
        assert lenses.label("shakespeare") == "shakespeare"


class TestOrchestrators:
    def test_an_orchestrator_is_not_a_single_prompt(self) -> None:
        """``panel`` and ``debate`` convene other reviewers; there is no prose for them to read on
        their own."""
        for name in ("panel", "debate"):
            with pytest.raises(lenses.UnknownLens):
                lenses.lens_prompt(name)

    def test_panel_expands_to_its_members(self) -> None:
        singles, orchestrators = lenses.expand(["panel"])
        assert orchestrators == ("panel",)
        assert singles == lenses.MULTI_LENS_MEMBERS["panel"]

    def test_a_member_requested_twice_runs_once(self) -> None:
        singles, orchestrators = lenses.expand(["panel", "hemingway"])
        assert singles.count("hemingway") == 1
        assert orchestrators == ("panel",)

    def test_order_is_preserved(self) -> None:
        singles, _ = lenses.expand(["line-edit", "mom", "hemingway"])
        assert singles == ("line-edit", "mom", "hemingway")

    def test_no_request_runs_the_default(self) -> None:
        singles, orchestrators = lenses.expand(None)
        assert singles == lenses.DEFAULT_LENSES
        assert orchestrators == ()

    def test_both_orchestrators_together_dedupe_their_shared_members(self) -> None:
        singles, orchestrators = lenses.expand(["panel", "debate"])
        assert orchestrators == ("panel", "debate")
        assert len(singles) == len(set(singles))
