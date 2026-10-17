"""A7 — the drift detector files findings that are not findings.

Measured across the Burial Mound run: 300 telemetry rows, 325 `character_drift` entries, and
`aligned=False` on 174 of them. Three kinds of entry are not drift at all, and each one is
expensive, because `aligned` is False whenever either list is non-empty and that triggers the
QA-cycle-2 streamed revision of the entire chapter — the same pass the vault flagged as a
scene-break risk.

Every string in this file is copied from the live `chapter_qa_v2` rows. Inventing plausible
examples would have tested the filter against my idea of the problem instead of the problem.
"""

from __future__ import annotations

from typing import Any

import pytest
from chapter_step.main import clean_drift

from writer_engine.schemas.chapter import DriftReport

# --- verbatim from the run ---------------------------------------------------------------------

SELF_CANCELLING = [
    "Roster notes Marcus 'drinks too much coffee and not enough water'; the chapter is consistent "
    "with this, no issue — flagging only to confirm no drift here.",
    "Wren's behavior (meticulous, non-rushing, understands documentation/argument distinction) is "
    "fully consistent with her roster entry; no drift.",
    "No character has been renamed, regendered, or given a contradictory trait; no off-roster "
    "main-cast character has been introduced.",
    "The roster describes Piri as 'one of Yanu's younger sons' who 'sleeps late, slow to wake' — "
    "fully consistent with the chapter. No drift.",
]

REAL_FINDINGS = [
    "Chapter states Nora made the hidden panel in 1963 when she was nineteen, but the roster gives "
    "her age as 82 in the present (2024), which would make her a different age.",
    "The attorney character: the outline names the attorney 'Lester Pruitt' at a Prince Frederick "
    "firm; the chapter introduces 'Hendricks' at an Annapolis firm.",
    "Chapter gives Nora's mug as reading 'Piscataway Nation' in one passage and 'Piscataway Conoy "
    "Nation' in a second passage describing the same mug.",
    "Nora's private worry per the roster is losing words and racing against her own mind; the "
    "chapter replaces this with a different private fear.",
]

DICT_SHAPED: list[Any] = [
    {"character": "Waya", "inconsistency": "The outline states Waya gives the gorget to her oldest daughter"},
    {"character": "Thomas", "inconsistency": "The roster gives Thomas's age as forty-one"},
]


# --- the three non-findings --------------------------------------------------------------------


@pytest.mark.parametrize("finding", SELF_CANCELLING, ids=range(len(SELF_CANCELLING)))
def test_a_self_cancelling_finding_is_dropped(finding: str) -> None:
    """The model used the array as a notes field. An entry that says "no drift" is not drift."""
    out = clean_drift(DriftReport(aligned=False, character_drift=[finding]))
    assert out is not None
    assert out.character_drift == []
    assert out.aligned is True  # and so the chapter is NOT rewritten for nothing


def test_a_dict_shaped_finding_is_flattened_not_stringified() -> None:
    """The schema says list[str]; a dict reached the UI and the bible as a Python dict repr."""
    out = clean_drift(DriftReport(aligned=False, character_drift=DICT_SHAPED))  # type: ignore[arg-type]
    assert out is not None
    assert out.character_drift[0].startswith("Waya: The outline states Waya gives the gorget")
    assert "{" not in "".join(out.character_drift)
    assert out.aligned is False  # these ARE findings, so alignment stands


def test_empty_entries_are_dropped() -> None:
    out = clean_drift(DriftReport(aligned=False, character_drift=["", "   ", None]))  # type: ignore[list-item]
    assert out is not None
    assert out.character_drift == []
    assert out.aligned is True


# --- what must NOT be filtered -----------------------------------------------------------------


@pytest.mark.parametrize("finding", REAL_FINDINGS, ids=range(len(REAL_FINDINGS)))
def test_a_real_contradiction_survives(finding: str) -> None:
    """The run's genuinely valuable findings. A phrase filter must not reach these.

    The age/date one in particular is the detector earning its cost: a panel made in 1963 "when she
    was nineteen" against a roster age of 82 in 2024 is an arithmetic contradiction no human would
    have caught on a 96-chapter read.
    """
    out = clean_drift(DriftReport(aligned=False, character_drift=[finding]))
    assert out is not None
    assert out.character_drift == [finding]
    assert out.aligned is False


def test_a_mixed_report_keeps_only_the_real_findings() -> None:
    report = DriftReport(
        aligned=False,
        character_drift=[SELF_CANCELLING[0], REAL_FINDINGS[0], SELF_CANCELLING[1]],
        story_drift=[REAL_FINDINGS[1]],
    )
    out = clean_drift(report)
    assert out is not None
    assert out.character_drift == [REAL_FINDINGS[0]]
    assert out.story_drift == [REAL_FINDINGS[1]]
    assert out.aligned is False


def test_the_word_consistent_alone_does_not_trigger_the_filter() -> None:
    """ "Consistent" appears in real findings too; only the assertions of no-drift are dropped."""
    finding = "Marcus's voice is not consistent with the roster's description of him as terse."
    out = clean_drift(DriftReport(aligned=False, character_drift=[finding]))
    assert out is not None
    assert out.character_drift == [finding]


# --- alignment is recomputed, not trusted ------------------------------------------------------


def test_alignment_is_recomputed_from_what_remains() -> None:
    """The saving: a chapter whose only "drift" was a non-finding is not rewritten end to end."""
    out = clean_drift(DriftReport(aligned=False, character_drift=[SELF_CANCELLING[2]]))
    assert out is not None
    assert out.aligned is True


def test_a_clean_report_is_left_alone() -> None:
    report = DriftReport(aligned=True, research_gaps=["verify the 1743 land record"])
    out = clean_drift(report)
    assert out is not None
    assert out.aligned is True
    assert out.research_gaps == ["verify the 1743 land record"]


def test_none_stays_none() -> None:
    """A parse failure must keep returning None — the chapter is never lost to QA."""
    assert clean_drift(None) is None
