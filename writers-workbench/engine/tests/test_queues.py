"""B4/B5 — the queue split, the per-queue sizing invariants, and the DLQ."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from writer_engine import queues
from writer_engine.config import EngineSettings
from writer_engine.queues import (
    ALL_QUEUES,
    DLQ_KEY,
    DLQ_MAX,
    HEAVY,
    HEAVY_OPS,
    INTERACTIVE,
    POLL_QUEUES,
    QUEUE_HEAVY,
    QUEUE_INTERACTIVE,
    QUEUE_LEGACY,
    profile_for,
    queue_for,
    read_dead_letters,
    record_dead_letter,
)

# --- routing ----------------------------------------------------------------------------------


def test_every_heavy_op_routes_heavy() -> None:
    for tool, op in HEAVY_OPS:
        assert queue_for(tool, op) == QUEUE_HEAVY, f"{tool}.{op}"


def test_the_interactive_ops_a_user_waits_on_do_not_share_the_batch_queue() -> None:
    """The point of B4: these must not queue behind a 96-chapter write."""
    for tool, op in [
        ("chapter", "qa"),
        ("chapter", "scan-drift"),
        ("chapter", "evaluate-genre"),
        ("chapter", "extract-bible"),
        ("brainstorm", "create-project"),
        ("library", "retrieve"),
        ("library", "lifecycle"),
        ("story_bible", "list"),
        ("media", "social-posts"),
        ("notify", "eve-callback"),
    ]:
        assert queue_for(tool, op) == QUEUE_INTERACTIVE, f"{tool}.{op}"


def test_an_unknown_op_defaults_to_interactive() -> None:
    """A new op gets the tight ceiling, not a silent 90-minute one."""
    assert queue_for("chapter", "a-new-op-nobody-classified") == QUEUE_INTERACTIVE
    assert queue_for("brand-new-tool") == QUEUE_INTERACTIVE
    assert queue_for("chapter", None) == QUEUE_INTERACTIVE


def test_routing_is_per_op_not_per_tool() -> None:
    """The spread within `chapter` is the whole reason routing is keyed on (tool, op)."""
    assert queue_for("chapter", "write") != queue_for("chapter", "qa")


def test_every_catalogued_task_op_is_classified_deliberately() -> None:
    """Drift guard: a new async-dispatched op in the hub catalog must be considered here.

    The catalog is what the hub can actually route to, so an op added there and forgotten here
    silently inherits the 600s interactive ceiling. This test does not demand a particular queue —
    it demands that the pair appear in this file, so adding an op forces the sizing decision.
    """
    catalog = Path(queues.__file__).parents[1] / "writer_engine" / "hub" / "catalog.py"
    src = catalog.read_text()
    task_ops = {
        (m.group(1), m.group(2))
        for m in re.finditer(r'ToolSpec\(\s*"([a-z_]+)",\s*"([a-z0-9-]+)",\s*"task"', src)
    }
    assert task_ops, "catalog parse failed — the ToolSpec shape changed"
    mine = Path(queues.__file__).read_text()
    unconsidered = [
        f"{tool}.{op}"
        for tool, op in sorted(task_ops)
        if (tool, op) not in HEAVY_OPS and f'("{tool}", "{op}")' not in mine
    ]
    assert not unconsidered, (
        "these hub ops are dispatched async but never classified in queues.py, so they default "
        f"to the interactive ceiling by accident: {unconsidered}. Add them to HEAVY_OPS, or to "
        "INTERACTIVE_OPS below it, to record the decision."
    )


# --- sizing invariants ------------------------------------------------------------------------


def test_the_two_queues_are_distinct_and_both_have_workers() -> None:
    assert QUEUE_HEAVY != QUEUE_INTERACTIVE
    assert set(ALL_QUEUES) == {QUEUE_HEAVY, QUEUE_INTERACTIVE}
    assert profile_for(QUEUE_HEAVY) is HEAVY
    assert profile_for(QUEUE_INTERACTIVE) is INTERACTIVE


def test_interactive_ceiling_is_much_tighter_than_heavy() -> None:
    """B5 exists because one 5400s ceiling fitted nothing."""
    assert INTERACTIVE.job_timeout < HEAVY.job_timeout / 5


def test_interactive_ceiling_survives_the_full_llm_budget_wait() -> None:
    """The subtle failure: a job queued on the token budget has not started generating yet.

    `llm_budget_max_wait_s` is how long a call may wait for an output-token grant. If the queue's
    job_timeout is below that, interactive jobs are killed under exactly the contention the split
    exists to survive — and they would be killed *before doing any work*, which looks like a
    mysterious timeout rather than a capacity problem.
    """
    budget_wait = EngineSettings().llm_budget_max_wait_s
    assert INTERACTIVE.job_timeout > budget_wait, (
        f"interactive ceiling {INTERACTIVE.job_timeout}s <= budget wait {budget_wait}s"
    )
    # Plus room for an actual generation pass after the grant.
    assert INTERACTIVE.job_timeout - budget_wait >= 120


def test_interactive_has_more_slots_and_no_retries() -> None:
    assert INTERACTIVE.max_jobs > HEAVY.max_jobs
    assert INTERACTIVE.max_tries == 1  # a retry the user waits through is worse than an error


def test_results_outlive_the_jobs_that_produce_them() -> None:
    """keep_result below job_timeout means a long job's result can expire before it is polled."""
    for profile in (HEAVY, INTERACTIVE):
        assert profile.keep_result >= profile.job_timeout, profile.name


def test_worker_step_http_timeout_is_not_the_authority() -> None:
    """arq must be the ceiling, not a mid-flight httpx ReadTimeout (which loses the error shape)."""
    from orchestrator.write_tools import WORKER_STEP_TIMEOUT_S

    assert HEAVY.job_timeout <= WORKER_STEP_TIMEOUT_S


def test_poll_queues_include_the_pre_split_queue() -> None:
    """Jobs enqueued before the deploy are on `newsletter`; polling must still find them."""
    assert QUEUE_LEGACY in POLL_QUEUES
    assert set(ALL_QUEUES) <= set(POLL_QUEUES)
    assert QUEUE_LEGACY not in ALL_QUEUES  # nothing new is ever enqueued there


# --- DLQ --------------------------------------------------------------------------------------
#
# These run against fakeredis (the shared `fake_redis` fixture in conftest.py) rather than a hand
# written stub, so LPUSH/LTRIM/LRANGE have real semantics — the cap test in particular is only
# meaningful if LTRIM behaves like LTRIM.


@pytest.mark.asyncio
async def test_dead_letter_round_trip(fake_redis: Any) -> None:
    await record_dead_letter(
        queue=QUEUE_HEAVY,
        function="run_write_tool_job",
        args={"tool": "chapter", "op": "write", "chapter_number": 7},
        error="TimeoutError: step timed out",
        job_id="job-1",
    )
    entries = await read_dead_letters()
    assert len(entries) == 1
    entry = entries[0]
    assert entry["queue"] == QUEUE_HEAVY
    assert entry["job_id"] == "job-1"
    assert "TimeoutError" in entry["error"]
    # The args are what make an entry actionable — which chapter of whose project failed.
    assert "chapter" in entry["args"] and "7" in entry["args"]
    assert entry["ts"] > 0


@pytest.mark.asyncio
async def test_dead_letters_are_most_recent_first(fake_redis: Any) -> None:
    for i in range(3):
        await record_dead_letter(queue=QUEUE_INTERACTIVE, function="f", args={"i": i}, error=f"e{i}")
    entries = await read_dead_letters()
    assert [e["error"] for e in entries] == ["e2", "e1", "e0"]


@pytest.mark.asyncio
async def test_limit_is_honoured(fake_redis: Any) -> None:
    for i in range(5):
        await record_dead_letter(queue=QUEUE_HEAVY, function="f", args=None, error=str(i))
    assert len(await read_dead_letters(limit=2)) == 2
    assert len(await read_dead_letters(limit=0)) == 1  # clamped, never a negative range


@pytest.mark.asyncio
async def test_the_dlq_is_capped(fake_redis: Any) -> None:
    """An unbounded failure log is its own outage: Redis carries the queue too."""
    for i in range(DLQ_MAX + 10):
        await record_dead_letter(queue=QUEUE_HEAVY, function="f", args=None, error=str(i))
    assert await fake_redis.llen(DLQ_KEY) == DLQ_MAX
    # The cap drops the OLDEST entries, not the newest.
    assert (await read_dead_letters(limit=1))[0]["error"] == str(DLQ_MAX + 9)


@pytest.mark.asyncio
async def test_a_dlq_write_failure_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """The DLQ write happens on a failure path; raising there would replace the real error."""

    class _Broken:
        def lpush(self, *_a: Any, **_k: Any) -> Any:
            raise ConnectionError("redis down")

        def lrange(self, *_a: Any, **_k: Any) -> Any:
            raise ConnectionError("redis down")

    async def _get_redis() -> Any:
        return _Broken()

    monkeypatch.setattr("writer_engine.redis_client.client.get_redis", _get_redis)
    await record_dead_letter(queue=QUEUE_HEAVY, function="f", args=None, error="boom")
    assert await read_dead_letters() == []


@pytest.mark.asyncio
async def test_unparseable_entries_are_skipped_not_fatal(fake_redis: Any) -> None:
    await fake_redis.lpush(DLQ_KEY, json.dumps({"error": "real"}))
    await fake_redis.lpush(DLQ_KEY, "not json")
    entries = await read_dead_letters()
    assert [e["error"] for e in entries] == ["real"]
