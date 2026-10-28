"""The marketing review loop: intake, draft, review, instruct, revise.

Two rules shape all of it.

A BIO CANNOT BE WRITTEN FROM THE MANUSCRIPT. Everything in one is a fact about a person, so a model
asked for a bio without those facts either invents credentials — a false claim printed in a book —
or writes "This is his debut novel", which is what happened on the first real run. The facts are
collected and the writer is forbidden to add any.

A REVISION IS A DIFF, NOT A REWRITE. Asked to write the copy again, a model returns different copy
and the author loses the parts they had already approved. That turns a review loop into a slot
machine, and an author stops using it after the second time it makes something worse.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from chapter_step import main as M

from writer_engine.schemas.chapter import AuthorProfile, BookMarketing


class TestTheBioAsksBeforeItInvents:
    def test_no_facts_is_refused_rather_than_fabricated(self) -> None:
        got = asyncio.run(M._op_author_bio({"profile": {"name": "Eric L Beser"}}))
        assert got["ok"] is False
        assert got["author_bio"] == ""
        assert "cannot be written from the manuscript" in got["reason"]

    def test_it_names_exactly_what_it_needs(self) -> None:
        got = asyncio.run(M._op_author_bio({"profile": {}}))
        joined = " ".join(got["gaps"])
        assert "background" in joined
        assert "why this book" in joined

    def test_the_prompt_forbids_invention_in_terms(self) -> None:
        s = M._build_bio_system()
        assert "Invent nothing" in s
        assert "fabricated credential is a false claim" in s

    def test_it_keeps_each_fact_on_its_own_event(self) -> None:
        # A real bio moved "Piscataway" from the author's friend onto the dig he worked on.
        s = M._build_bio_system()
        assert "KEEP EACH FACT WHERE IT WAS GIVEN" in s
        assert "never move it onto a different one" in s

    def test_it_bans_the_stock_phrases(self) -> None:
        s = M._build_bio_system()
        for banned in ("award-winning", "acclaimed", "passionate about"):
            assert banned in s, f"the prompt should name {banned!r} as forbidden"

    def test_supplied_facts_reach_the_writer(self) -> None:
        seen: dict[str, str] = {}

        async def fake(router, **kw):
            seen["prompt"] = kw["prompt"]
            from writer_engine.schemas.chapter import BioOnly

            return BioOnly(author_bio="A bio."), None

        with (
            patch.object(M, "complete_structured", fake),
            patch.object(M, "get_router", lambda service=None: object()),
        ):
            got = asyncio.run(
                M._op_author_bio(
                    {
                        "profile": {
                            "name": "Eric L Beser",
                            "lives": "Maryland",
                            "background": "Thirty years in signal processing.",
                            "why_this_book": "His grandmother worked the 1935 dig.",
                        }
                    }
                )
            )
        assert got["ok"] is True
        assert "Maryland" in seen["prompt"]
        assert "signal processing" in seen["prompt"]
        assert "grandmother" in seen["prompt"]

    def test_an_empty_profile_is_detected_by_the_schema(self) -> None:
        assert AuthorProfile(name="X").is_empty() is True
        assert AuthorProfile(name="X", background="Archaeologist").is_empty() is False


class TestRevisionIsADiff:
    def test_the_prompt_says_to_change_only_what_was_asked(self) -> None:
        s = M._build_marketing_revision_system("historical")
        assert "CHANGE ONLY WHAT THE INSTRUCTIONS ASK FOR" in s
        assert "comes back unchanged" in s

    def test_it_prefers_the_smaller_change_when_unclear(self) -> None:
        assert "make the smaller change" in M._build_marketing_revision_system("")

    def test_it_may_refuse_an_instruction_it_cannot_honour(self) -> None:
        """An instruction asking for a credential nobody supplied must be declined, not invented."""
        s = M._build_marketing_revision_system("")
        assert "do not follow it" in s
        assert "credential that was not supplied" in s

    def test_it_demands_an_audit_trail(self) -> None:
        s = M._build_marketing_revision_system("")
        assert "`changed` lists exactly the field names" in s
        assert "whether you understood" in s


class TestTheRevisionSchemaCarriesItsTrail:
    def test_a_revision_reports_what_it_touched(self) -> None:
        from writer_engine.schemas.chapter import RevisedMarketing

        r = RevisedMarketing(blurb="new", changed=["blurb"], note="shortened as asked")
        assert r.changed == ["blurb"]
        assert r.note

    def test_it_is_still_listing_copy(self) -> None:
        from writer_engine.schemas.chapter import RevisedMarketing

        assert isinstance(RevisedMarketing(), BookMarketing)

    def test_a_blank_revision_claims_no_changes(self) -> None:
        """Silence must not read as 'I changed everything'."""
        from writer_engine.schemas.chapter import RevisedMarketing

        assert RevisedMarketing().changed == []
