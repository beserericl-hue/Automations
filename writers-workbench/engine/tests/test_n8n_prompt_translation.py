"""A2 — the real n8n editorial briefs become renderable engine prompts.

The briefs shipped in `n8n_seeds/` under `n8n_baseline.*` but nothing used them: the steps ran on
minimal placeholder seeds. The picker's live prompt was two lines against a 15.7k-char brief encoding
catchiest-first ordering, "avoid AI-safety stories", "avoid course ads", no duplicate
company/subject, and source-dedup into one slot.
"""

from __future__ import annotations

import pytest

from writer_engine.prompt_store import get_prompt_store, seed_default_prompts
from writer_engine.prompt_store.n8n_seeds import N8N_SEED_KEYS
from writer_engine.prompt_store.n8n_translate import (
    adapt,
    fields_in,
    live_template,
    render,
    translate,
)
from writer_engine.schemas.newsletter import PickedStories


@pytest.fixture(autouse=True)
def _seeded() -> None:
    seed_default_prompts()


# --- translation ------------------------------------------------------------------------------


def test_every_baseline_prompt_translates_with_nothing_unmapped() -> None:
    """An unmapped n8n expression becomes ${unmapped_N} and would blow up at render time."""
    store = get_prompt_store()
    for key in N8N_SEED_KEYS:
        baseline = store.get(f"n8n_baseline.{key}")
        assert baseline, f"missing baseline seed for {key}"
        _t, _f, unmapped = translate(baseline)
        assert unmapped == [], f"{key} has unmapped n8n expressions: {unmapped}"


def test_no_literal_n8n_tokens_survive_translation() -> None:
    store = get_prompt_store()
    for key in N8N_SEED_KEYS:
        translated, _f, _u = translate(store.get(f"n8n_baseline.{key}"))
        assert "{{" not in translated, f"{key} still contains a raw n8n token"
        assert "$(" not in translated or "${" in translated


def test_expression_mode_prefix_is_stripped() -> None:
    out, _f, _u = translate("=# Task\n{{ $('x').item.json.Date }}")
    assert out.startswith("# Task")


def test_distinct_subfields_map_to_distinct_fields() -> None:
    """subject_line and pre_header_text come from the same node; they must not collapse."""
    out, fields, _ = translate(
        'A {{ $node["set_selected_stories"].json.subject_line }} '
        'B {{ $node["set_selected_stories"].json.pre_header_text }}'
    )
    assert "subject_line" in fields and "pre_header" in fields
    assert "${subject_line}" in out and "${pre_header}" in out


# --- rendering --------------------------------------------------------------------------------


def test_render_is_strict_about_missing_fields() -> None:
    """A forgotten field must raise, not leave a literal ${field} in the model's prompt."""
    with pytest.raises(KeyError):
        render("give me ${articles} and ${not_supplied_anywhere}", articles="a")


def test_render_fills_documented_defaults() -> None:
    """The n8n expressions defaulted tweets to "N/A" themselves; we keep that contract."""
    out = render("tweets: ${tweets}")
    assert out == "tweets: N/A"


def test_render_leaves_literal_braces_alone() -> None:
    """Three briefs contain JSON examples. str.format would misparse these; Template must not.

    This is why the renderer is string.Template and not .format.
    """
    tpl = 'Return {"top_selected_stories": [{"title": "..."}]} for ${articles}'
    out = render(tpl, articles="X")
    assert '{"top_selected_stories": [{"title": "..."}]}' in out
    assert "X" in out


def test_the_real_pick_brief_renders_end_to_end() -> None:
    store = get_prompt_store()
    key = "newsletter.pick_top_stories.user_template"
    template, _fields, unmapped = live_template(key, store.get(f"n8n_baseline.{key}"))
    assert unmapped == []
    out = render(template, articles="- (id1) A story — Src", max_stories=5, newsletter_date="2026-10-16")
    # The editorial criteria the placeholder threw away are now actually in the prompt.
    assert "AI safety" in out or "AI safety stories" in out
    assert "duplicate" in out.lower()
    assert "2026-10-16" in out
    assert "${" not in out, "an unrendered field reached the prompt"
    assert len(out) > 10_000, "the real brief should be ~15k chars, not the 2-line stub"


# --- adaptations ------------------------------------------------------------------------------


def test_story_count_adaptation_replaces_the_hardcoded_four() -> None:
    """The n8n brief hardcodes four stories; the engine takes max_stories from the edition."""
    store = get_prompt_store()
    key = "newsletter.pick_top_stories.user_template"
    template, fields, _ = live_template(key, store.get(f"n8n_baseline.{key}"))
    assert "max_stories" in fields
    out = render(template, articles="a", max_stories=7, newsletter_date="2026-10-16")
    assert "*7-item* list" in out
    assert "four-item" not in out


def test_adapt_raises_when_a_delta_stops_matching() -> None:
    """If a seed changes under us, a silently-skipped adaptation reverts live behaviour to n8n's
    hardcoded four stories. Fail loudly instead."""
    with pytest.raises(ValueError, match="no longer matches"):
        adapt("newsletter.pick_top_stories.user_template", "a prompt without the expected phrases")


def test_adapt_is_a_noop_for_unlisted_keys() -> None:
    assert adapt("newsletter.image.user_template", "unchanged") == "unchanged"


# --- schema compatibility ---------------------------------------------------------------------


def test_picked_stories_accepts_the_n8n_chain_of_thought_field_name() -> None:
    """The brief demands reasoning for EVERY story considered under its own field name.

    Without the alias that reasoning silently defaults to "" and is thrown away.
    """
    row = {"top_selected_stories": [{"title": "t", "summary": "s"}]}
    assert (
        PickedStories.model_validate({**row, "top_selected_stories_chain_of_thought": "why"}).chain_of_thought
        == "why"
    )
    assert PickedStories.model_validate({**row, "chain_of_thought": "legacy"}).chain_of_thought == "legacy"


def test_fields_in_finds_every_placeholder() -> None:
    assert fields_in("${a} text ${b_c} ${a}") == {"a", "b_c"}


# --- every wired step renders its real brief with the fields it actually supplies ---------------
#
# The failure this prevents: render() is strict, so a step that forgets a field raises at generation
# time rather than at import. These cases mirror exactly what each step passes.

WIRED_PROMPTS = [
    (
        "newsletter.pick_top_stories.user_template",
        {"articles": "- (1) A — Src", "max_stories": 5, "newsletter_date": "2026-10-16"},
        10_000,
    ),
    (
        "newsletter.subject.user_template",
        {"stories_json": "[]", "articles": "- (1) A — Src", "newsletter_date": "2026-10-16"},
        4_000,
    ),
    (
        "newsletter.segment.user_template",
        {
            "story_title": "T",
            "story_summary": "S",
            "segment_sources": "src",
            "external_sources": "src",
            "subject_line": "SL",
            "pre_header": "PH",
            "newsletter_date": "2026-10-16",
        },
        10_000,
    ),
    (
        "newsletter.intro.user_template",
        {
            "story_sections": "## A\nbody",
            "subject_line": "SL",
            "pre_header": "PH",
            "newsletter_date": "2026-10-16",
        },
        4_000,
    ),
    (
        "newsletter.other_top_stories.user_template",
        {
            "story_sections": "A",
            "articles": "- (2) B",
            "subject_line": "SL",
            "newsletter_date": "2026-10-16",
        },
        6_000,
    ),
]


@pytest.mark.parametrize(("key", "fields", "min_len"), WIRED_PROMPTS)
def test_wired_prompt_renders_with_the_steps_field_set(key: str, fields: dict, min_len: int) -> None:
    from writer_engine.prompt_store.n8n_translate import render_live_prompt

    out = render_live_prompt(key, get_prompt_store(), **fields)
    assert "${" not in out, f"{key}: an unrendered field reached the prompt"
    assert "{{" not in out, f"{key}: a raw n8n token reached the prompt"
    assert len(out) >= min_len, f"{key}: got {len(out)} chars — looks like the placeholder, not the brief"
    for value in fields.values():
        if isinstance(value, str) and len(value) > 1:
            assert value in out, f"{key}: supplied value {value!r} did not reach the prompt"


def test_render_live_prompt_falls_back_to_the_placeholder_seed() -> None:
    """A missing baseline must degrade to the placeholder, not crash the step.

    PromptStore.get RAISES on an unknown key, so the helper has to catch it — this test is what
    caught that the documented fallback was unreachable.
    """
    from writer_engine.prompt_store.n8n_translate import render_live_prompt

    store = get_prompt_store()
    # A *.system key has a placeholder seed and no n8n baseline (only the 8 user_templates do).
    out = render_live_prompt("newsletter.subject.system", store)
    assert out
    assert "${" not in out


def test_render_live_prompt_raises_on_a_wholly_unknown_key() -> None:
    """Fallback covers a missing BASELINE, not a missing prompt entirely — a typo'd key must fail."""
    from writer_engine.prompt_store.n8n_translate import render_live_prompt

    with pytest.raises(KeyError):
        render_live_prompt("definitely.not.a.key", get_prompt_store(), a="x")
