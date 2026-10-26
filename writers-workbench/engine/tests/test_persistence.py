"""CR-001 engine DB persistence — guard logic (no DB): persist flags + ops registered + helpers importable."""

from __future__ import annotations

import asyncio

from brainstorm_step.main import OPS as B_OPS
from brainstorm_step.main import _persist_outline_if_requested


def test_create_project_op_registered() -> None:
    assert "create-project" in B_OPS


def test_persist_outline_noop_when_not_requested() -> None:
    assert asyncio.run(_persist_outline_if_requested({}, {"chapters": []})) is None


def test_persist_outline_requires_ids() -> None:
    out = asyncio.run(_persist_outline_if_requested({"persist": True}, {"chapters": []}))
    assert out["persisted"] is False and "missing" in out["reason"]


def test_create_project_requires_user() -> None:
    out = asyncio.run(B_OPS["create-project"]({"title": "X"}))
    assert out["created"] is False


def test_persist_helpers_importable() -> None:
    from writer_engine import persist_helpers

    for fn in ("create_project", "persist_outline", "persist_chapter", "persist_bible", "persist_research"):
        assert hasattr(persist_helpers, fn)


def test_chapter_persist_guard_importable() -> None:
    from chapter_step.main import _persist_chapter_if_requested

    assert asyncio.run(_persist_chapter_if_requested({}, {"title": "t"}, _DummyOut())) is None


class _DummyOut:
    content_text = "x"
    chapter_run_id = "00000000-0000-0000-0000-000000000000"
    word_count = 1
    sub_chapter_count = 1
    craft_qa = None


def test_persist_chapter_merges_metadata_preserving_qa_report() -> None:
    """Regression (2026-07-08): a rewrite/repair persisted a fresh metadata dict, and the old code
    OVERWROTE the whole metadata column — wiping qa_report (the Q/A Consistency Report the user ran),
    dismissed_annotations, etc. persist_chapter must MERGE: refresh write-time keys, preserve the rest."""
    from writer_engine.persist_helpers import persist_chapter

    prior = {
        "qa_report": {"checks": [{"name": "x", "status": "NEEDS_REVIEW"}]},
        "dismissed_annotations": ["drift_scan:3:name_variant:Meara"],
        "craft_qa": {"prose_transparent": 0.5},
        "word_count": 100,
    }
    captured: dict = {}

    class _Q:
        def __init__(self, kind):
            self.kind = kind

        def select(self, *_a, **_k):
            return self

        def eq(self, *_a, **_k):
            return self

        def is_(self, *_a, **_k):
            return self

        def order(self, *_a, **_k):
            return self

        def limit(self, *_a, **_k):
            return self

        def update(self, row):
            if self.kind == "published_content_v2":
                captured["metadata"] = row.get("metadata")
            return self

        def insert(self, *_a, **_k):
            return self

        async def execute(self):
            class _R:
                data = [{"id": "cid-1", "metadata": prior}] if self.kind == "published_content_v2" else []

            return _R()

    class _Client:
        def table(self, name):
            return _Q(name)

    asyncio.run(
        persist_chapter(
            _Client(),
            project_id="p",
            user_id="u",
            chapter_number=3,
            title="t",
            content_text="body",
            metadata={"craft_qa": {"prose_transparent": 0.9}, "word_count": 200, "drift_report": {}},
        )
    )
    md = captured.get("metadata") or {}
    # preserved:
    assert "qa_report" in md and md["qa_report"]["checks"][0]["status"] == "NEEDS_REVIEW"
    assert md.get("dismissed_annotations") == ["drift_scan:3:name_variant:Meara"]
    # refreshed:
    assert md["craft_qa"]["prose_transparent"] == 0.9 and md["word_count"] == 200


class _Table:
    """Just enough of a Supabase table for persist_chapter: filters, order, limit, insert, update."""

    def __init__(self, db: dict, name: str) -> None:
        self.db, self.name = db, name
        self.filters: list = []
        self._order: tuple | None = None
        self._limit: int | None = None
        self._op: tuple | None = None

    def select(self, *_a, **_k):
        return self

    def eq(self, k, v):
        self.filters.append(lambda r: r.get(k) == v)
        return self

    def is_(self, k, v):
        self.filters.append(lambda r: r.get(k) is None)
        return self

    def order(self, k, desc=False):
        self._order = (k, desc)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def insert(self, row):
        self._op = ("insert", row)
        return self

    def update(self, row):
        self._op = ("update", row)
        return self

    async def execute(self):
        rows = self.db.setdefault(self.name, [])
        if self._op and self._op[0] == "insert":
            row = {"id": f"{self.name}-{len(rows) + 1}", "deleted_at": None, **self._op[1]}
            rows.append(row)
            return type("R", (), {"data": [row]})()
        hit = [r for r in rows if all(f(r) for f in self.filters)]
        if self._op and self._op[0] == "update":
            for r in hit:
                r.update(self._op[1])
            return type("R", (), {"data": hit})()
        if self._order:
            hit = sorted(hit, key=lambda r: r.get(self._order[0]) or 0, reverse=self._order[1])
        return type("R", (), {"data": hit[: self._limit] if self._limit else hit})()


class _Db:
    def __init__(self, data: dict) -> None:
        self.data = data

    def table(self, name):
        return _Table(self.data, name)


def _write(db: _Db, text: str) -> str:
    from writer_engine.persist_helpers import persist_chapter

    return asyncio.run(
        persist_chapter(db, project_id="p", user_id="u", chapter_number=4, title="Ch 4", content_text=text)
    )


def test_a_rewrite_keeps_the_hand_edited_text_it_replaces() -> None:
    """CR-001 audit: versions held only engine writes, so a chapter last edited by hand was overwritten
    with no copy of what the author had written."""
    db = _Db({"published_content_v2": [], "content_versions_v2": []})
    cid = _write(db, "engine draft one")
    db.data["published_content_v2"][0]["content_text"] = "the author's own edit"  # a hand edit, no version
    assert _write(db, "engine draft two") == cid
    versions = sorted(db.data["content_versions_v2"], key=lambda v: v["version_number"])
    assert [v["content_text"] for v in versions] == [
        "engine draft one",
        "the author's own edit",
        "engine draft two",
    ]
    assert "before the engine rewrote it" in versions[1]["change_note"]


def test_an_unchanged_chapter_is_not_versioned_twice() -> None:
    db = _Db({"published_content_v2": [], "content_versions_v2": []})
    _write(db, "draft one")
    _write(db, "draft two")
    assert [v["content_text"] for v in db.data["content_versions_v2"]] == ["draft one", "draft two"]


def test_a_rewrite_does_not_land_in_a_trashed_chapter() -> None:
    db = _Db({"published_content_v2": [], "content_versions_v2": []})
    old = _write(db, "draft one")
    db.data["published_content_v2"][0]["deleted_at"] = "2026-10-26T00:00:00Z"
    new = _write(db, "draft two")
    assert new != old
    live = [r for r in db.data["published_content_v2"] if r["deleted_at"] is None]
    assert [r["content_text"] for r in live] == ["draft two"]


def test_a_chapter_rewrite_updates_its_research_instead_of_adding_a_copy() -> None:
    """114 duplicate "— Chapter N research" reports on DEV, one per rewrite."""
    from writer_engine.persist_helpers import persist_research

    db = _Db({"research_reports_v2": [], "research_report_projects_v2": []})

    def go(content: str, replace: bool) -> str:
        return asyncio.run(
            persist_research(
                db,
                project_id="p",
                user_id="u",
                topic="X — Chapter 4 research",
                content=content,
                replace_same_topic=replace,
            )
        )

    first = go("facts v1", True)
    assert go("facts v2", True) == first
    assert [r["content"] for r in db.data["research_reports_v2"]] == ["facts v2"]
    assert len(db.data["research_report_projects_v2"]) == 1
    go("a standalone report", False)  # the research screen still adds a new report every time
    assert len(db.data["research_reports_v2"]) == 2


class TestCharacterVariants:
    """CR-002: one person, one bible entry."""

    def test_an_alias_in_brackets_is_the_same_person(self) -> None:
        from writer_engine.persist_helpers import resolve_character_variant as R

        assert R("Adaeze Okonkwo (A. Okonkwo)", ["Adaeze Okonkwo", "Osei Asante"]) == "Adaeze Okonkwo"
        assert R("Slade (Garrett Slade)", ["Garrett Slade"]) == "Garrett Slade"

    def test_a_descriptive_bracket_keeps_people_apart(self) -> None:
        from writer_engine.persist_helpers import resolve_character_variant as R

        assert R("Taya (child)", ["Taya (the first, deceased)"]) is None

    def test_a_first_name_with_one_full_name_is_that_person_and_with_several_is_nobody(self) -> None:
        from writer_engine.persist_helpers import resolve_character_variant as R

        assert R("Osei", ["Osei Asante", "Delia Marsh"]) == "Osei Asante"
        assert R("Delia", ["Delia Marsh", "Delia Swann", "Delia Okafor"]) is None
        assert R("Marcus Tayac", ["Marcus Tayac", "Renata Voss"]) is None  # itself, not a variant

    def test_a_new_full_name_takes_over_a_lone_first_name(self) -> None:
        from writer_engine.persist_helpers import first_name_entry_to_rename as F

        assert F("Osei Asante", ["Osei", "Renata Voss"]) == "Osei"
        assert F("Delia Swann", ["Delia", "Delia Marsh"]) is None
        assert F("Osei", ["Osei"]) is None

    def test_persist_writes_a_variant_to_the_entry_it_names(self) -> None:
        from writer_engine.persist_helpers import persist_bible

        db = _Db(
            {
                "story_bible_v2": [
                    {
                        "id": "b1",
                        "project_id": "p",
                        "entry_type": "character",
                        "name": "Osei Asante",
                        "description": "Ghanaian surveyor who mapped the bluff grid",
                        "deleted_at": None,
                    },
                ]
            }
        )
        n = asyncio.run(
            persist_bible(
                db,
                project_id="p",
                user_id="u",
                entries=[
                    {
                        "entry_type": "character",
                        "name": "Osei",
                        "description": "the surveyor who mapped the grid",
                    },
                    {"entry_type": "character", "name": "Renata Voss", "description": "anthropologist"},
                ],
            )
        )
        names = sorted(r["name"] for r in db.data["story_bible_v2"] if r["deleted_at"] is None)
        assert n == 2 and names == ["Osei Asante", "Renata Voss"]
        assert (
            next(r for r in db.data["story_bible_v2"] if r["name"] == "Osei Asante")["description"]
            == "the surveyor who mapped the grid"
        )

    def test_persist_renames_a_lone_first_name_to_the_full_name(self) -> None:
        from writer_engine.persist_helpers import persist_bible

        db = _Db(
            {
                "story_bible_v2": [
                    {
                        "id": "b1",
                        "project_id": "p",
                        "entry_type": "character",
                        "name": "Osei",
                        "description": "x",
                        "deleted_at": None,
                    },
                ]
            }
        )
        asyncio.run(
            persist_bible(
                db,
                project_id="p",
                user_id="u",
                entries=[
                    {"entry_type": "character", "name": "Osei Asante", "description": "the surveyor"},
                ],
            )
        )
        assert [r["name"] for r in db.data["story_bible_v2"]] == ["Osei Asante"]


class TestVariantsThatAreNotTheSamePerson:
    """Each one a wrong merge in the DEV dry run, 2026-10-26."""

    def test_bearers_of_a_name_and_pairs_stay_apart(self) -> None:
        from writer_engine.persist_helpers import resolve_character_variant as R

        assert R("Kittamaquund", ["Kittamaquund (ancestor)"]) is None
        assert R("Strikes-Twice", ["Strikes-Twice (first/original bearer)"]) is None
        assert R("Maka", ["Maka and Maka-Small"]) is None
        assert R("Kaia-Tayac", ["Kaia-Tayac (first)", "Kaia-Tayac Moyaone"]) is None

    def test_a_surname_alone_is_nobody_in_particular(self) -> None:
        from writer_engine.persist_helpers import resolve_character_variant as R

        assert R("Voss", ["Dorothy Voss", "Renata Voss"]) is None
        assert R("Voss", ["Voss Halloran", "Elliot Voss"]) is None

    def test_a_first_name_with_an_unrelated_description_is_someone_else(self) -> None:
        from writer_engine.persist_helpers import resolve_character_variant as R

        d = {
            "Stewart": "Co-author with Ferguson of 1940 field notes on the ossuary excavation.",
            "Stewart Udall": "Secretary of the Interior who signed the 1960s land agreement.",
            "Osei": "Surveyor who mapped the bluff grid.",
            "Osei Asante": "Ghanaian surveyor; mapped the bluff grid in the spring.",
        }
        assert R("Stewart", ["Stewart Udall"], descriptions=d) is None
        assert R("Osei", ["Osei Asante"], descriptions=d) == "Osei Asante"

    def test_the_fullest_plain_spelling_wins(self) -> None:
        from writer_engine.persist_helpers import resolve_character_variant as R

        assert R("Kaya-Tayac (Kaya)", ["Kaya-Tayac", "Kaya"]) == "Kaya-Tayac"
