"""B6 — prove idempotency, rather than assert it.

Two halves:

1. **A measurement** of every persist helper: run it twice with identical input against a fake
   Supabase and count the rows. This is what B6 asked for — the inventory recorded "only
   chapter.write is keyed on chapter_run_id" as an unverified belief, and the measurement is what
   turns it into a fact. The expectations below are therefore written as the MEASURED behaviour,
   including the paths that duplicate, with the consequence of each spelled out.

2. **The run ledger** (migration 028), which is what makes the duplicating paths safe: a job whose
   run_id is already recorded complete does not execute again at all.
"""

from __future__ import annotations

from typing import Any

import pytest

from writer_engine import persist_helpers as ph
from writer_engine.idempotency import (
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_IN_PROGRESS,
    claim_run,
    complete_run,
    fail_run,
)
from writer_engine.idempotency.run_ledger import MAX_RESULT_BYTES, TABLE


@pytest.fixture
def db(fake_supabase: Any) -> Any:
    """The shared in-memory Supabase stand-in (conftest.FakeSupabase), under a shorter name."""
    return fake_supabase


def test_the_fake_knows_the_ledgers_primary_key() -> None:
    """conftest spells the table name out; a drift would silently stop conflicts from conflicting."""
    from conftest import LEDGER_TABLE

    assert LEDGER_TABLE == TABLE


# --- part 1: which persist paths duplicate ------------------------------------------------------


@pytest.mark.asyncio
async def test_persist_chapter_is_idempotent_on_project_and_chapter(db: Any) -> None:
    """The one path the inventory believed was safe. It is — for the content row."""
    for _ in range(2):
        await ph.persist_chapter(
            db,
            project_id="p1",
            user_id="u1",
            chapter_number=4,
            title="Chapter 4",
            content_text="prose",
        )
    assert db.count("published_content_v2") == 1
    # A version snapshot per run is the intended history model, NOT a duplicate bug — but it does
    # mean a retried write leaves an extra identical version behind.
    assert db.count("content_versions_v2") == 2


@pytest.mark.asyncio
async def test_persist_chapter_merges_metadata_instead_of_replacing_it(db: Any) -> None:
    await ph.persist_chapter(
        db,
        project_id="p1",
        user_id="u1",
        chapter_number=1,
        title="t",
        content_text="x",
        metadata={"qa_report": {"kept": True}},
    )
    await ph.persist_chapter(
        db,
        project_id="p1",
        user_id="u1",
        chapter_number=1,
        title="t",
        content_text="y",
        metadata={"word_count": 10},
    )
    row = db.tables["published_content_v2"][0]
    assert row["metadata"]["qa_report"] == {"kept": True}
    assert row["metadata"]["word_count"] == 10


@pytest.mark.asyncio
async def test_persist_bible_is_idempotent(db: Any) -> None:
    entries = [{"name": "Tayak", "entry_type": "character", "description": "d"}]
    for _ in range(2):
        await ph.persist_bible(db, project_id="p1", user_id="u1", entries=entries)
    assert db.count("story_bible_v2") == 1


@pytest.mark.asyncio
async def test_persist_canon_is_idempotent(db: Any) -> None:
    outline = {"premise": "a", "chapters": [{}, {}]}
    for _ in range(2):
        await ph.persist_canon(db, project_id="p1", user_id="u1", outline=outline)
    assert db.count("story_bible_v2") == 1


@pytest.mark.asyncio
async def test_persist_outline_updates_rather_than_duplicates(db: Any) -> None:
    db.tables["writing_projects_v2"] = [{"id": "p1", "outline": None}]
    for _ in range(2):
        await ph.persist_outline(db, project_id="p1", user_id="u1", outline={"chapters": [{}]})
    assert db.count("writing_projects_v2") == 1
    # The second run snapshots the first run's outline — one extra version, no lost data.
    assert db.count("outline_versions_v2") == 1


@pytest.mark.asyncio
async def test_persist_research_duplicates_without_the_ledger(db: Any) -> None:
    """MEASURED: a retried research.run produces two identical reports in the user's library."""
    for _ in range(2):
        await ph.persist_research(db, project_id="p1", user_id="u1", topic="Rome", content="c")
    assert db.count("research_reports_v2") == 2


@pytest.mark.asyncio
async def test_persist_content_duplicates_without_the_ledger(db: Any) -> None:
    """MEASURED: a retried blog/short-story/newsletter write produces two library entries."""
    for _ in range(2):
        await ph.persist_content(db, user_id="u1", title="A post", content_type="blog_post", content_text="c")
    assert db.count("published_content_v2") == 2


@pytest.mark.asyncio
async def test_persist_token_usage_duplicates_without_the_ledger(db: Any) -> None:
    """MEASURED, and the worst of them: this is billing data, so a retry over-reports what is owed."""
    calls = [{"model": "m", "input_tokens": 10, "output_tokens": 20, "cost_usd": 0.5}]
    for _ in range(2):
        await ph.persist_token_usage(db, user_id="u1", workflow="chapter.write", calls=calls)
    assert db.count("token_usage_v2") == 2
    assert sum(r["cost_usd"] for r in db.tables["token_usage_v2"]) == 1.0  # double-billed


@pytest.mark.asyncio
async def test_persist_chapter_qa_duplicates_without_the_ledger(db: Any) -> None:
    """MEASURED: one telemetry row per run by design, so a retry adds a second row for one chapter."""
    telemetry = {"chapter_run_id": "run-1", "word_count": 100}
    for _ in range(2):
        await ph.persist_chapter_qa(db, project_id="p1", user_id="u1", chapter_number=1, telemetry=telemetry)
    assert db.count("chapter_qa_v2") == 2
    # Same run id on both rows — the column exists but nothing dedupes on it.
    assert {r["chapter_run_id"] for r in db.tables["chapter_qa_v2"]} == {"run-1"}


# --- part 2: the ledger -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_fresh_run_is_claimed(db: Any) -> None:
    claim = await claim_run(db, run_id="r1", tool="chapter", op="write", user_id="u1")
    assert claim.won is True
    assert claim.should_skip is False
    row = db.tables[TABLE][0]
    assert row["status"] == STATUS_IN_PROGRESS
    assert row["tool"] == "chapter" and row["op"] == "write"


@pytest.mark.asyncio
async def test_a_completed_run_is_not_run_again(db: Any) -> None:
    """The property that makes every duplicating path above safe under an arq retry."""
    await claim_run(db, run_id="r1", tool="research", op="run")
    await complete_run(db, run_id="r1", result={"status": "ok", "payload": {"result": {"id": "x"}}})

    again = await claim_run(db, run_id="r1", tool="research", op="run")
    assert again.should_skip is True
    assert again.replay == {"status": "ok", "payload": {"result": {"id": "x"}}}
    assert db.count(TABLE) == 1


@pytest.mark.asyncio
async def test_a_failed_run_may_be_claimed_again(db: Any) -> None:
    """A crashed run must not be permanently un-rerunnable."""
    await claim_run(db, run_id="r1", tool="chapter", op="write")
    await fail_run(db, run_id="r1", error="TimeoutError: boom")
    assert db.tables[TABLE][0]["status"] == STATUS_ERROR

    again = await claim_run(db, run_id="r1", tool="chapter", op="write")
    assert again.won is True
    assert again.should_skip is False
    row = db.tables[TABLE][0]
    assert row["status"] == STATUS_IN_PROGRESS
    assert row["attempts"] == 2
    assert row["error"] is None


@pytest.mark.asyncio
async def test_an_in_progress_run_is_rerun_not_blocked(db: Any) -> None:
    """arq only re-queues after a cancel, so an in_progress row means the previous owner died.

    Blocking here would be the worse failure: the user's chapter would never be written, and
    nothing would ever clear the row.
    """
    await claim_run(db, run_id="r1", tool="chapter", op="write")
    again = await claim_run(db, run_id="r1", tool="chapter", op="write")
    assert again.won is True
    assert again.should_skip is False
    assert db.tables[TABLE][0]["attempts"] == 2


@pytest.mark.asyncio
async def test_distinct_runs_do_not_interfere(db: Any) -> None:
    """Two deliberate submissions are two runs — re-running a blog post on purpose must work."""
    a = await claim_run(db, run_id="r1", tool="chapter", op="blog")
    b = await claim_run(db, run_id="r2", tool="chapter", op="blog")
    assert a.won and b.won
    assert db.count(TABLE) == 2


@pytest.mark.asyncio
async def test_a_large_result_is_recorded_as_truncated(db: Any) -> None:
    """A chapter's prose belongs in published_content_v2, not in a control table."""
    await claim_run(db, run_id="r1", tool="chapter", op="write")
    big = {"status": "ok", "payload": {"result": {"chapter_text": "x" * (MAX_RESULT_BYTES + 1)}}}
    await complete_run(db, run_id="r1", result=big)
    row = db.tables[TABLE][0]
    assert row["status"] == STATUS_COMPLETE
    assert row["result"] is None
    assert row["result_truncated"] is True

    # It is still a skip — the work was done; only the payload was too big to keep.
    again = await claim_run(db, run_id="r1", tool="chapter", op="write")
    assert again.should_skip is True
    assert again.replay is None


@pytest.mark.asyncio
async def test_a_small_result_is_kept_verbatim(db: Any) -> None:
    await claim_run(db, run_id="r1", tool="chapter", op="qa")
    out = {"status": "ok", "payload": {"result": {"score": 9}}}
    await complete_run(db, run_id="r1", result=out)
    assert db.tables[TABLE][0]["result"] == out
    assert db.tables[TABLE][0]["result_truncated"] is False


@pytest.mark.asyncio
async def test_an_empty_run_id_is_never_claimed(db: Any) -> None:
    claim = await claim_run(db, run_id="", tool="chapter")
    assert claim.available is False
    assert claim.should_skip is False
    assert db.count(TABLE) == 0


# --- fail-open ---------------------------------------------------------------------------------


class _BrokenDB:
    """A ledger that cannot be reached at all."""

    def table(self, _name: str) -> Any:
        raise ConnectionError("supabase unreachable")


@pytest.mark.asyncio
async def test_an_unreachable_ledger_lets_the_work_proceed() -> None:
    """Refusing to write a user's chapter because a bookkeeping table is down is the worse bug."""
    claim = await claim_run(_BrokenDB(), run_id="r1", tool="chapter", op="write")
    assert claim.available is False
    assert claim.should_skip is False


@pytest.mark.asyncio
async def test_ledger_writes_never_raise() -> None:
    broken = _BrokenDB()
    await complete_run(broken, run_id="r1", result={"ok": True})
    await fail_run(broken, run_id="r1", error="x")


class _NoTableDB:
    """The ledger table does not exist yet — the state between deploying 028's code and running it."""

    def table(self, name: str) -> Any:
        class _Q:
            def select(self, *_a: Any, **_k: Any) -> Any:
                return self

            def insert(self, *_a: Any, **_k: Any) -> Any:
                return self

            def eq(self, *_a: Any, **_k: Any) -> Any:
                return self

            def limit(self, *_a: Any, **_k: Any) -> Any:
                return self

            async def execute(self) -> Any:
                raise RuntimeError(f'relation "public.{name}" does not exist')

        return _Q()


@pytest.mark.asyncio
async def test_code_may_ship_before_the_migration_runs() -> None:
    """Deploy order matters: the code reaches DEV/PROD before someone applies 028 by hand.

    A missing table must look exactly like an unreachable ledger — fail open, log, keep working —
    or the deploy itself would break every async write job.
    """
    claim = await claim_run(_NoTableDB(), run_id="r1", tool="chapter", op="write")
    assert claim.available is False
    assert claim.should_skip is False
