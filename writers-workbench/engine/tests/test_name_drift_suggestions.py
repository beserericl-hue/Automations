"""Character-name drift: what is offered as a one-click fix has to be right.

Apply performs a literal span replacement in the author's manuscript, so a wrong suggestion is not
a cosmetic problem — it writes nonsense into the book. All three defects below were found by asking
a simple question of real data: for every chapter the approval gate blocks, what exactly would a
human be clicking?

The answers were, on a 96-chapter book:
  * "the Tayacs" -> "the Marcus"   (plural of a surname treated as a rename, then mis-replaced)
  * "Koss"       -> "Dr."          (a deep-time character read as a typo of "Dr. Renata Voss")
"""

from __future__ import annotations

from chapter_step.main import _character_name_consistency, _drift_scan_from_namecheck

ROSTER = [
    {"name": "Marcus Tayac"},
    {"name": "Dr. Renata Voss"},
    {"name": "Winifred Tayac"},
]


class TestPluralsAreNotRenames:
    def test_a_family_plural_is_left_alone(self) -> None:
        """ "The Tayacs had farmed it for generations" is ordinary English about a family. It sits
        one edit from "Tayac" with a length difference of one, so the distance guard passes it
        straight through — and the fix offered was "Marcus"."""
        text = "The Tayacs had farmed the bluff for generations. Marcus Tayac knew every foot of it."
        got = _character_name_consistency(text, ROSTER)
        assert [r["found"] for r in got["possible_renames"]] == []
        assert got["consistent"] is True

    def test_a_possessive_plural_too(self) -> None:
        text = "The Tayacs' land ran to the creek. Marcus Tayac walked it."
        assert _character_name_consistency(text, ROSTER)["possible_renames"] == []

    def test_a_real_near_miss_is_still_caught(self) -> None:
        """The guard must not blind the scanner: a genuine one-letter slip still has to surface.

        (A transposition like "Tyaac" is TWO edits in plain Levenshtein, and the scanner allows only
        one for a token under 7 characters — so it is out of scope by design, not by this change.)
        """
        text = "Marcus Tayak stood at the edge."
        found = [r["found"] for r in _character_name_consistency(text, ROSTER)["possible_renames"]]
        assert "Tayak" in found


class TestAnEstablishedNameIsNotATypo:
    def test_a_name_the_chapter_uses_throughout_is_not_drift(self) -> None:
        """A rename slip appears once or twice; a chapter's own character appears throughout. On a
        book spanning 12,000 years the 6-entry roster is all modern, so a deep-time character named
        Koss sat one edit from Voss and was offered as a correction to it."""
        text = (
            "Koss carried the bundle to the water. Koss had done this before, and Koss would do it "
            "again when the ice broke. The others watched Koss go."
        )
        got = _character_name_consistency(text, ROSTER)
        assert [r["found"] for r in got["possible_renames"]] == []

    def test_but_a_rare_variant_against_a_common_canonical_IS_drift(self) -> None:
        """The discriminator is relative frequency, not a blanket exemption."""
        text = (
            "Dr. Renata Voss opened the file. Voss had catalogued it herself. Voss initialled the "
            "margin, and Voss closed the drawer. A note in the file read Koss."
        )
        found = [r["found"] for r in _character_name_consistency(text, ROSTER)["possible_renames"]]
        assert "Koss" in found


class TestTheReplacementIsTheMatchedToken:
    @staticmethod
    def _flag(text: str) -> dict:
        nc = _character_name_consistency(text, ROSTER)
        scan = _drift_scan_from_namecheck(nc, text, 7)
        assert scan, "expected a drift flag"
        return scan["characters"][0]["drift_flags"][0]

    def test_a_surname_slip_is_replaced_with_the_surname(self) -> None:
        """Not with the first word of the full name. `canonical.split()[0]` offered "Dr." for a
        drift of "Dr. Renata Voss" — a title, pasted over a character's name."""
        text = (
            "Dr. Renata Voss opened the file. Voss had catalogued it. Voss initialled the margin "
            "and Voss closed the drawer. The label read Koss."
        )
        flag = self._flag(text)
        assert flag["variant"] == "Koss"
        assert flag["replacement"] == "Voss"
        assert flag["replacement"] != "Dr."

    def test_the_replacement_keeps_the_canonical_casing(self) -> None:
        text = (
            "Marcus Tayac signed it. Tayac had waited. Tayac waited still, and Tayac said nothing. "
            "The clerk wrote Tayax."
        )
        flag = self._flag(text)
        assert flag["replacement"] == "Tayac"

    def test_the_variant_is_a_real_span_so_apply_can_find_it(self) -> None:
        text = (
            "Marcus Tayac signed it. Tayac had waited. Tayac waited still, and Tayac said nothing. "
            "The clerk wrote Tayax."
        )
        flag = self._flag(text)
        assert flag["variant"] in text


class TestNoFlagsNoScan:
    def test_a_clean_chapter_produces_nothing_to_click(self) -> None:
        text = "Marcus Tayac walked the bluff. Dr. Renata Voss met him at the trench."
        nc = _character_name_consistency(text, ROSTER)
        assert nc["consistent"] is True
        assert _drift_scan_from_namecheck(nc, text, 1) is None

    def test_a_missing_roster_name_is_not_an_inconsistency(self) -> None:
        """A 12,000-year book has a different cast in each era. A modern character not appearing in
        a Late Archaic chapter is not drift, and must not block that chapter's approval."""
        text = "Koss carried the bundle. Koss set it in the pit. Koss covered it with earth."
        nc = _character_name_consistency(text, ROSTER)
        assert nc["names_missing"], "they really are absent"
        assert nc["consistent"] is True, "but absence is not inconsistency"


PRIEST = [{"name": "Father Declan Murtagh"}, {"name": "Marcus Tayac"}]


class TestHonorificsAreNotNames:
    """ "Father Declan Murtagh" contributed the roster token "father", which sits one edit from the
    ordinary word "Feather" — so a chapter using that word was flagged as character drift and
    blocked from approval, with a one-click fix offering to rewrite it. A title is not a name."""

    def test_an_ordinary_word_near_a_title_is_not_drift(self) -> None:
        text = "A Feather lay on the stone where the bird had been. Marcus Tayac picked it up."
        got = _character_name_consistency(text, PRIEST)
        assert [r["found"] for r in got["possible_renames"]] == []
        assert got["consistent"] is True

    def test_the_real_name_tokens_are_still_matched(self) -> None:
        """Dropping "father" must not drop "Declan" or "Murtagh" — the actual name.

        Shaped like a real slip: the correct spelling throughout and the wrong one once. (Written
        the other way round first, which the frequency guard correctly suppressed — a name used
        three times with the canonical absent is the chapter's own name, not a typo.)"""
        text = (
            "Murtagh came up the path. Murtagh had the folder. Marcus Tayac waited for Murtagh, "
            "and Murtagh sat down. The note was signed Murtagj."
        )
        found = [r["found"] for r in _character_name_consistency(text, PRIEST)["possible_renames"]]
        assert "Murtagj" in found

    def test_a_roster_that_is_only_a_title_yields_no_tokens(self) -> None:
        got = _character_name_consistency("The Doctor arrived. The Doctor left.", [{"name": "Doctor"}])
        assert got["possible_renames"] == []


class TestQaHonoursPersistFalse:
    """`persist: false` was accepted by the API and silently ignored by the Q/A op.

    A read-only probe of the deployed engine therefore wrote its findings over two chapters whose
    reports had just been corrected, re-blocking both for approval. A flag that is accepted and
    disregarded is worse than one that is rejected, because the caller believes it has done nothing.
    """

    @staticmethod
    def _run(payload_extra: dict) -> list:
        import asyncio
        from unittest.mock import patch

        from chapter_step import main as M

        wrote: list = []

        async def fake_persist(payload, scores, findings, nc, text):
            wrote.append(payload.get("chapter_number"))
            return {"ok": True}

        async def fake_resolve(payload, create=False):
            return None

        async def fake_ctx(pid, pl):
            return {"genre_slug": "g", "title": "t", "outline": {"chapters": []}, "roster": []}

        async def fake_score(text, period, roster_text="", beat=""):
            from writer_engine.schemas.chapter import ChapterCraftQa

            return ChapterCraftQa()

        body = {
            "project_id": "11111111-2222-3333-4444-555555555555",
            "chapter_number": 7,
            "chapter_text": "Some prose that is long enough to score.",
            **payload_extra,
        }
        with (
            patch.object(M, "_persist_qa_artifacts", fake_persist),
            patch.object(M, "_resolve_project_for_payload", fake_resolve),
            patch.object(M, "_load_context", fake_ctx),
            patch.object(M, "_score_chapter", fake_score),
        ):
            asyncio.run(M._op_qa(body))
        return wrote

    def test_persist_false_writes_nothing(self) -> None:
        assert self._run({"persist": False}) == []

    def test_persist_true_writes(self) -> None:
        assert self._run({"persist": True}) == [7]

    def test_the_default_still_writes(self) -> None:
        """The UI's Run Q/A and the hub do not pass the flag and rely on persistence."""
        assert self._run({}) == [7]
