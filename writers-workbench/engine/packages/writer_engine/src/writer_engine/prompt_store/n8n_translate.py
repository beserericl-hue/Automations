"""Translate the verbatim n8n newsletter prompts into renderable engine templates (A2).

The real editorial briefs from the working n8n newsletter ship in ``n8n_seeds/`` under the
``n8n_baseline.*`` prefix, but nothing used them: the step services ran on the minimal placeholder
seeds instead. The gap was severe — the picker's live prompt was two lines ("Pick the top
{max_stories} stories") against a **15.7k-char** brief encoding catchiest-first ordering, no
AI-safety stories, no course ads, no duplicate company/subject, and source-dedup into one slot.

The blocker was that the baseline prompts carry n8n expression tokens
(``{{ $('set_trigger_inputs').item.json.Date }}``), which are not Python format fields. Two decisions
make the translation safe:

1. **Classify each ``{{ … }}`` block by a distinctive marker, don't regex the whole JS expression.**
   Those expressions are long, nested and quote-heavy; matching a marker inside them is far more
   robust than trying to parse them.
2. **Render with ``string.Template``, never ``str.format``.** Three of the eight prompts contain
   literal ``{``/``}`` (JSON examples). ``.format`` would misparse them and force error-prone brace
   doubling; ``Template`` ignores braces entirely and only touches ``$name``.

Anything unrecognised becomes ``${unmapped_N}`` and is reported by :func:`translate`, so a
translation gap shows up as a missing field at render time instead of leaving a literal ``{{ … }}``
in the prompt for the model to puzzle over.
"""

from __future__ import annotations

import re
from string import Template
from typing import Any

# A distinctive marker inside the n8n expression -> the engine field that supplies the same value.
# Order matters: the first marker found in a block wins, so put the more specific markers first.
MARKER_TO_FIELD: list[tuple[str, str]] = [
    # Dates
    (".json.Date", "newsletter_date"),
    # Corpus / sources
    ('"Previous Newsletter Content"', "previous_newsletter"),
    ("combine_markdown_content", "articles"),
    ("combine_tweet_content", "tweets"),
    ("aggregate_segment_external_source_content", "external_sources"),
    ("aggregate_segment_text_content", "segment_sources"),
    # Stories
    ("set_current_stories", "stories_json"),
    ("set_current_segment", "current_story"),
    ("set_combined_sections_content", "story_sections"),
    # Subject
    ("subject_examples", "subject_examples"),
    ("set_selected_stories", "selected_stories_field"),
    # Revision loops
    ("share_stories_approval_feedback", "feedback"),
    ("share_subject_line_approval_feedback", "feedback"),
    ("stories_prompt", "original_prompt"),
    ("set_subject_line_prompt", "original_prompt"),
    ("pick_top_stories", "prior_output"),
    ("write_subject_line", "prior_output"),
]

# Some n8n blocks select a sub-field of a node (subject_line vs pre_header_text, title vs summary).
# Resolve those to distinct engine fields so the prompt still distinguishes them.
SUBFIELD_TO_FIELD: list[tuple[str, str]] = [
    ("subject_line", "subject_line"),
    ("pre_header_text", "pre_header"),
    ("current_story.title", "story_title"),
    ("current_story.summary", "story_summary"),
]

# Values the engine genuinely has no source for. The n8n expressions already defaulted these to
# "N/A" themselves (`$('combine_tweet_content').isExecuted ? … : "N/A"`), so matching that keeps the
# prompt's own contract rather than inventing content.
FIELD_DEFAULTS: dict[str, str] = {
    "tweets": "N/A",
    "previous_newsletter": "N/A",
    "subject_examples": "",
    "external_sources": "",
    "feedback": "",
    "original_prompt": "",
    "prior_output": "",
}

_BLOCK = re.compile(r"\{\{(.*?)\}\}", re.S)
_FIELD = re.compile(r"\$\{([a-z_][a-z0-9_]*)\}")


def _field_for(expr: str) -> str | None:
    """Which engine field an n8n expression maps to, or None when unrecognised."""
    for marker, field in MARKER_TO_FIELD:
        if marker in expr:
            if field == "selected_stories_field" or field == "current_story":
                for sub, resolved in SUBFIELD_TO_FIELD:
                    if sub in expr:
                        return resolved
                return None
            return field
    return None


def translate(text: str) -> tuple[str, set[str], list[str]]:
    """Convert n8n expression tokens into ``${field}`` placeholders.

    Returns ``(template_text, fields_used, unmapped_expressions)``. Unmapped blocks become
    ``${unmapped_N}`` so they surface as a missing field at render time rather than silently
    remaining as raw ``{{ … }}`` in the prompt.
    """
    fields: set[str] = set()
    unmapped: list[str] = []

    def _sub(m: re.Match[str]) -> str:
        expr = m.group(1)
        field = _field_for(expr)
        if field is None:
            unmapped.append(" ".join(expr.split())[:120])
            name = f"unmapped_{len(unmapped)}"
            fields.add(name)
            return f"${{{name}}}"
        fields.add(field)
        return f"${{{field}}}"

    out = _BLOCK.sub(_sub, text)
    # n8n prefixes an expression-mode string with '='; it is not part of the prompt.
    if out.startswith("="):
        out = out[1:]
    return out, fields, unmapped


def fields_in(template_text: str) -> set[str]:
    """The ``${field}`` names a translated template expects."""
    return set(_FIELD.findall(template_text))


def render(template_text: str, **values: Any) -> str:
    """Render a translated template strictly.

    ``Template.substitute`` (not ``safe_substitute``) so a field the step forgot to supply raises
    instead of leaving a literal ``${field}`` in the prompt sent to the model. Fields with a
    documented default are filled from :data:`FIELD_DEFAULTS` first.
    """
    merged: dict[str, Any] = {}
    for name in fields_in(template_text):
        if name in values:
            merged[name] = values[name]
        elif name in FIELD_DEFAULTS:
            merged[name] = FIELD_DEFAULTS[name]
    return Template(template_text).substitute(merged)


# --- documented engine adaptations ------------------------------------------------------------
#
# The ``n8n_baseline.*`` seeds stay VERBATIM — they are the L5 parity reference, so they must not be
# edited. The live prompt is produced by translation plus this small, reviewable set of deltas where
# the n8n prompt disagrees with the engine's contract. Each entry says why.
ADAPTATIONS: list[tuple[str, str, str]] = [
    (
        "newsletter.pick_top_stories.user_template",
        "a *four-item* list",
        "a *${max_stories}-item* list",
    ),
    (
        "newsletter.pick_top_stories.user_template",
        "(array of up to four objects",
        "(array of up to ${max_stories} objects",
    ),
]
# Why: the n8n prompt hardcodes four stories, but the engine takes `max_stories` from the edition
# (pick_step defaults to 5). Hardcoding would silently ignore the caller's request.

# Field renames: the n8n prompt asks for `top_selected_stories_chain_of_thought`, the engine schema
# field is `chain_of_thought`. Handled by an alias on the schema rather than by rewriting the prompt,
# so the model still sees the n8n field name it was tuned on.


def adapt(key: str, template_text: str) -> str:
    """Apply the documented deltas for ``key``. Raises if a delta no longer matches.

    Failing loudly matters: a silently-missed adaptation means the live prompt quietly reverts to
    n8n's hardcoded behaviour (e.g. always four stories regardless of the edition's setting).
    """
    out = template_text
    for k, old, new in ADAPTATIONS:
        if k != key:
            continue
        if old not in out:
            raise ValueError(
                f"adaptation for {key} no longer matches the baseline prompt: {old!r}. "
                "The n8n seed changed; re-check the delta instead of dropping it."
            )
        out = out.replace(old, new)
    return out


def live_template(key: str, baseline_text: str) -> tuple[str, set[str], list[str]]:
    """Baseline -> the template the step service actually renders: translate, then adapt."""
    translated, _fields, unmapped = translate(baseline_text)
    adapted = adapt(key, translated)
    return adapted, fields_in(adapted), unmapped


def render_live_prompt(key: str, store: Any, **fields: Any) -> str:
    """Render the live prompt for ``key`` from the verbatim n8n baseline (A2).

    Shared by every newsletter step so the translate -> adapt -> render pipeline is defined once.
    Falls back to the placeholder seed when a baseline is unavailable, so a missing seed degrades to
    the old behaviour rather than breaking the pipeline.
    """
    try:
        baseline = store.get(f"n8n_baseline.{key}")
    except KeyError:
        # PromptStore.get RAISES on an unknown key rather than returning None, so the fallback has
        # to catch — without this the documented "degrades to the placeholder seed" never happened
        # and an absent baseline would crash the step instead.
        baseline = ""
    if not baseline:
        return str(store.get(key)).format(**fields)
    template, _fields, _unmapped = live_template(key, baseline)
    return render(template, **fields)


__all__ = [
    "ADAPTATIONS",
    "FIELD_DEFAULTS",
    "MARKER_TO_FIELD",
    "adapt",
    "fields_in",
    "live_template",
    "render",
    "render_live_prompt",
    "translate",
]
