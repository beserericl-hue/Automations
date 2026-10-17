"""The Draft Review Kit's 13 lenses, as engine review prompts (E7).

The kit is EveryInc's `draft-review-kit <https://github.com/EveryInc/draft-review-kit>`_ (MIT, Katie
Parrott), vendored at ``writers-workbench/draft-review-kit/`` and copied into this package's
``skills/`` so it ships inside the engine image — the repo copy is outside
``packages/writer_engine/src`` and no Dockerfile copies it.

These are **review**, not generation: run them over prose that already exists. The engine already
scores craft automatically (``chapter.qa``, nine Follett dimensions) and already runs a pass/fail
consistency rubric. What these add is a named, opinionated critique voice a user picks on purpose —
"what would Hemingway cut", "where does this stand and explain instead of walking and talking".

Three adaptations, because a ``SKILL.md`` is written for an interactive coding agent and not for a
single API call:

* **The invocation sections are stripped.** They describe slash commands (``/hemingway [text]``) and
  tell the agent to *ask the user* what needs cutting. Left in, the model asks a question instead of
  reviewing — there is nobody to answer.
* **``panel`` and ``debate`` are not prompts.** They are orchestrators: the kit has them convene
  other reviewers and synthesize. They map to a multi-lens run plus a synthesis pass, which is what
  :data:`MULTI_LENS_MEMBERS` describes.
* **``guardrails`` runs its fiction mode only.** The skill is dual-mode and its non-fiction half
  references EveryInc's "Working Overtime" column and companion skills that do not exist here. The
  fiction half scans against the Ken Follett style guide — the same craft rules
  ``follett_seeds`` writes to — so that reference file is vendored alongside and appended.

Scope, deliberately: these **critique only**. They do not feed the nine-dimension rubric. Coupling a
subjective lens to the score that gates ``chapter.repair`` would let "Hemingway thinks this is
wordy" fail a chapter, and the rubric is what the product promises. Findings come back in the
``{name, status, details}`` shape the Q/A panel already renders.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

SKILLS_DIR = Path(__file__).parent / "skills"

READER_LENSES: tuple[str, ...] = ("asshole", "mom", "eli5")
"""Reader-response: who gets lost, and what a hostile reader attacks."""

CRAFT_LENSES: tuple[str, ...] = ("hemingway", "sorkin", "hitchcock", "vonnegut", "sedaris")
"""One master's obsession each."""

STRUCTURE_LENSES: tuple[str, ...] = ("dev-edit", "line-edit")
"""Big-picture developmental edit, and the sentence-level pass."""

GUARDRAILS = "guardrails"

SINGLE_LENSES: tuple[str, ...] = (*READER_LENSES, *CRAFT_LENSES, *STRUCTURE_LENSES, GUARDRAILS)
"""Every lens that is one LLM pass over the prose."""

MULTI_LENS_MEMBERS: dict[str, tuple[str, ...]] = {
    # The kit's "Default Panels by Piece Type" for a narrative draft, mapped to what exists here:
    # structure first (while it can still move), then a hostile reader, then a craft cut, then the
    # publication gate. `debate` convenes the same voices; what differs is the synthesis prompt.
    "panel": ("dev-edit", "asshole", "hemingway", GUARDRAILS),
    "debate": ("dev-edit", "asshole", "hemingway", GUARDRAILS),
}

ALL_LENSES: tuple[str, ...] = (*SINGLE_LENSES, *MULTI_LENS_MEMBERS)

DEFAULT_LENSES: tuple[str, ...] = (GUARDRAILS,)
"""What a bare ``chapter.review`` runs. The kit's own advice is "the *right* pressure, not every lens
every time", and guardrails is the publication gate — the one that maps to rules the engine already
writes to, so its findings are actionable rather than a matter of taste."""

LENS_LABELS: dict[str, str] = {
    "asshole": "Hostile reader",
    "mom": "General reader",
    "eli5": "Jargon check",
    "hemingway": "Hemingway (cut)",
    "sorkin": "Sorkin (momentum)",
    "hitchcock": "Hitchcock (tension)",
    "vonnegut": "Vonnegut (8 rules)",
    "sedaris": "Sedaris (humor)",
    "dev-edit": "Developmental edit",
    "line-edit": "Line edit",
    GUARDRAILS: "Follett guardrails",
    "panel": "Review panel",
    "debate": "Review debate",
}

# Sections of a SKILL.md that address an interactive agent rather than describe the critique.
# "Invocation" is the harmful one — it instructs the model to ask the user what to review.
_DROP_SECTIONS = (
    "invocation",
    "when to use",
    "when this skill auto-triggers",
    "example session",
    "example output",
    "integration",
    "related skills",
)

_H2 = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)
_FRONTMATTER = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)


class UnknownLens(KeyError):
    """Raised for a lens name that is not in :data:`ALL_LENSES`."""


def _strip_frontmatter(text: str) -> str:
    return _FRONTMATTER.sub("", text, count=1)


def strip_agent_sections(markdown: str) -> str:
    """Drop the ``##`` sections that talk to an interactive agent.

    Keeps everything before the first ``##`` (the purpose paragraph) and every section whose title
    is not in :data:`_DROP_SECTIONS`.
    """
    body = _strip_frontmatter(markdown)
    matches = list(_H2.finditer(body))
    if not matches:
        return body.strip()

    out = [body[: matches[0].start()]]
    for index, match in enumerate(matches):
        title = match.group("title").strip().lower().rstrip(":")
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        if any(title == dropped or title.startswith(dropped) for dropped in _DROP_SECTIONS):
            continue
        out.append(body[match.start() : end])
    return "\n".join(part.strip() for part in out if part.strip()).strip()


@lru_cache(maxsize=32)
def load_skill(name: str) -> str:
    """The raw vendored ``SKILL.md`` for one lens."""
    path = SKILLS_DIR / f"{name}.md"
    if not path.exists():
        raise UnknownLens(name)
    return path.read_text(encoding="utf-8")


@lru_cache(maxsize=32)
def lens_prompt(name: str) -> str:
    """The review instruction for one lens: its skill body, agent sections removed.

    ``guardrails`` gets the Follett catalogue appended, because its SKILL.md describes the fiction
    mode by reference ("Catalog: references/follett-style-guardrails.md") and the engine cannot
    follow a file path at inference time.
    """
    lens = normalise(name)
    if lens in MULTI_LENS_MEMBERS:
        raise UnknownLens(f"{lens} is an orchestrator, not a single prompt; see MULTI_LENS_MEMBERS")
    body = strip_agent_sections(load_skill(lens))
    if lens == GUARDRAILS:
        catalogue = strip_agent_sections(load_skill("guardrails-follett"))
        body = (
            f"{body}\n\n"
            "Run the FICTION mode only. This draft is a novel chapter from the Writers Workbench, so "
            "the non-fiction categories and the Every-specific 'Working Overtime' checks do not "
            "apply — ignore them entirely. The Ken Follett catalogue the fiction mode refers to "
            f"follows in full.\n\n---\n\n{catalogue}"
        )
    return body


def normalise(name: str) -> str:
    """Accept ``dev_edit``, ``Dev-Edit``, ``DEV EDIT`` for ``dev-edit``."""
    slug = re.sub(r"[\s_]+", "-", str(name or "").strip().lower())
    if slug not in ALL_LENSES:
        raise UnknownLens(slug or name)
    return slug


def label(name: str) -> str:
    """Human label for the Q/A panel. Falls back to the slug for an unlabelled lens."""
    try:
        lens = normalise(name)
    except UnknownLens:
        return str(name)
    return LENS_LABELS.get(lens, lens)


def expand(names: list[str] | tuple[str, ...] | None) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """``(single_lenses_to_run, orchestrators_requested)``.

    ``panel`` and ``debate`` expand to their member lenses; the orchestrator name is returned
    separately so the caller knows a synthesis pass is wanted. Order is preserved and duplicates are
    dropped, so ``["panel", "hemingway"]`` does not run Hemingway twice.
    """
    requested = list(names or DEFAULT_LENSES)
    singles: list[str] = []
    orchestrators: list[str] = []
    for raw in requested:
        lens = normalise(raw)
        if lens in MULTI_LENS_MEMBERS:
            if lens not in orchestrators:
                orchestrators.append(lens)
            for member in MULTI_LENS_MEMBERS[lens]:
                if member not in singles:
                    singles.append(member)
        elif lens not in singles:
            singles.append(lens)
    return tuple(singles), tuple(orchestrators)


__all__ = [
    "ALL_LENSES",
    "CRAFT_LENSES",
    "DEFAULT_LENSES",
    "GUARDRAILS",
    "LENS_LABELS",
    "MULTI_LENS_MEMBERS",
    "READER_LENSES",
    "SINGLE_LENSES",
    "SKILLS_DIR",
    "STRUCTURE_LENSES",
    "UnknownLens",
    "expand",
    "label",
    "lens_prompt",
    "load_skill",
    "normalise",
    "strip_agent_sections",
]
