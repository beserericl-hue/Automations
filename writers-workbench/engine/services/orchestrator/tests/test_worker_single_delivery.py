"""Item 16 — each job executes once across the fleet.

DEV runs two runtime replicas, each with an arq worker per queue. Three questions, each answered by
a test rather than by reading arq's source:

1. **Does arq itself ever hand one job to two workers?** No — ``test_two_arq_workers_run_each_job_once``
   runs two real arq ``Worker``s against one (fake) Redis, enqueues many jobs and counts executions.

2. **Can a retry overlap the attempt it replaces?** It could, before the run lease. arq cancels the
   *worker coroutine* on SIGTERM; the step service on the other end of that HTTP request keeps
   running until its container dies, while arq re-queues the job for another replica immediately.
   That is what DEV's run a8855eae… did on 2026-11-02 (see ``writer_engine.idempotency.run_lease``).
   ``test_a_retry_after_a_cancel_waits_for_the_orphaned_step`` reproduces it and proves the retry no
   longer overlaps.

3. **Can two jobs carrying the same caller-supplied run_id both execute?** Before the lease, yes: the
   ledger treats ``in_progress`` as "the previous owner died" and lets the second one run.
"""

from __future__ import annotations

import asyncio
import itertools
from typing import Any

import fakeredis
import pytest
from fakeredis import aioredis

from orchestrator import worker as worker_mod
from writer_engine.idempotency import run_lease
from writer_engine.idempotency.run_ledger import TABLE


class _Out:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._dump = {"status": "ok", "payload": payload}

    def model_dump(self, **_: Any) -> dict[str, Any]:
        return self._dump


@pytest.fixture
def redis() -> Any:
    return aioredis.FakeRedis(server=fakeredis.FakeServer())


@pytest.fixture
def fast_lease(monkeypatch: pytest.MonkeyPatch) -> None:
    """Production timings are a minute; the behaviour is the same at a fraction of a second."""
    monkeypatch.setattr(run_lease, "LEASE_TTL_S", 0.6)
    monkeypatch.setattr(run_lease, "REFRESH_S", 0.15)
    monkeypatch.setattr(run_lease, "WAIT_S", 2.0)
    monkeypatch.setattr(run_lease, "POLL_S", 0.05)


@pytest.fixture
def step(monkeypatch: pytest.MonkeyPatch, fake_supabase: Any) -> dict[str, Any]:
    """A step "service" that, like the real one, keeps working when its caller is cancelled.

    Each call records the interval during which the step was doing work, so a test can check that no
    two executions of one run overlapped.
    """
    state: dict[str, Any] = {"intervals": [], "duration": 0.3, "db": fake_supabase}

    async def _ledger() -> Any:
        return fake_supabase

    async def _call(ref: Any, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()

        async def _server_side() -> Any:
            start = loop.time()
            await asyncio.sleep(state["duration"])
            state["intervals"].append((start, loop.time(), (kwargs.get("payload") or {}).get("run_id")))
            return _Out({"result": {"n": len(state["intervals"])}})

        # The caller's cancel stops the await, not the server: shield models exactly that.
        return await asyncio.shield(asyncio.ensure_future(_server_side()))

    monkeypatch.setattr(worker_mod, "_ledger", _ledger)
    monkeypatch.setattr(worker_mod, "run_step_via_http", _call)
    monkeypatch.setenv("POSTAL_API_KEY", "")
    return state


def _overlaps(intervals: list[tuple[float, float, Any]]) -> list[tuple[Any, Any]]:
    ordered = sorted(intervals)
    return [(a, b) for a, b in itertools.pairwise(ordered) if b[0] < a[1]]


# --- the lease itself -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_only_one_holder_at_a_time(redis: Any, fast_lease: None) -> None:
    a = await run_lease.acquire(redis, "r1", "A", wait_s=0)
    b = await run_lease.acquire(redis, "r1", "B", wait_s=0.2)
    assert a.acquired and not b.acquired
    assert b.holder == "A"


@pytest.mark.asyncio
async def test_a_released_lease_is_free_immediately(redis: Any, fast_lease: None) -> None:
    await run_lease.acquire(redis, "r1", "A", wait_s=0)
    assert await run_lease.release(redis, "r1", "A")
    assert (await run_lease.acquire(redis, "r1", "B", wait_s=0)).acquired


@pytest.mark.asyncio
async def test_a_stranger_cannot_release_or_extend_a_lease(redis: Any, fast_lease: None) -> None:
    await run_lease.acquire(redis, "r1", "A", wait_s=0)
    assert not await run_lease.release(redis, "r1", "B")
    assert not await run_lease.refresh(redis, "r1", "B")
    assert (await redis.get(run_lease.lease_key("r1"))) == b"A"


@pytest.mark.asyncio
async def test_a_dead_holders_lease_lapses_and_the_waiter_proceeds(redis: Any, fast_lease: None) -> None:
    await run_lease.acquire(redis, "r1", "dead", wait_s=0)  # never refreshed: its owner "died"
    b = await run_lease.acquire(redis, "r1", "B")
    assert b.acquired
    assert 0.3 < b.waited_s < 1.5


@pytest.mark.asyncio
async def test_a_live_holder_keeps_its_lease_past_the_ttl(redis: Any, fast_lease: None) -> None:
    lease = await run_lease.acquire(redis, "r1", "A", wait_s=0)
    async with run_lease.held(redis, lease):
        await asyncio.sleep(1.0)  # well past the 0.6s TTL — the keepalive must have refreshed it
        assert (await redis.get(run_lease.lease_key("r1"))) == b"A"
    assert await redis.get(run_lease.lease_key("r1")) is None  # released on a clean exit


@pytest.mark.asyncio
async def test_a_cancelled_holder_leaves_the_lease_to_expire(redis: Any, fast_lease: None) -> None:
    lease = await run_lease.acquire(redis, "r1", "A", wait_s=0)

    async def _body() -> None:
        async with run_lease.held(redis, lease):
            await asyncio.sleep(10)

    task = asyncio.create_task(_body())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # Still there: the step it was calling may still be running.
    assert (await redis.get(run_lease.lease_key("r1"))) == b"A"
    await asyncio.sleep(0.8)
    assert await redis.get(run_lease.lease_key("r1")) is None


@pytest.mark.asyncio
async def test_an_unreachable_redis_fails_open() -> None:
    class _Broken:
        async def set(self, *a: Any, **k: Any) -> Any:
            raise ConnectionError("redis down")

    lease = await run_lease.acquire(_Broken(), "r1", "A", wait_s=0)
    assert not lease.available and not lease.acquired


# --- the worker -------------------------------------------------------------------------------


async def _job(redis: Any, job_id: str, **body: Any) -> dict[str, Any]:
    return await worker_mod.run_write_tool_job(
        {"job_id": job_id, "redis": redis}, "library", {"op": "list-outlines", **body}
    )


@pytest.mark.asyncio
async def test_a_retry_after_a_cancel_waits_for_the_orphaned_step(
    redis: Any, fast_lease: None, step: dict[str, Any]
) -> None:
    """The DEV incident of 2026-11-02, reproduced: SIGTERM cancels attempt 1 while its step is still
    running; arq hands the job to another replica; attempt 2 must not run alongside the orphan."""
    step["duration"] = 0.4
    first = asyncio.create_task(_job(redis, "job-x"))
    await asyncio.sleep(0.1)  # the step is mid-flight
    first.cancel()  # what arq's drain does on SIGTERM
    with pytest.raises(asyncio.CancelledError):
        await first

    second = await _job(redis, "job-x")  # arq's retry, same job id, "another replica"
    await asyncio.sleep(0.45)  # let the orphaned step's server side finish recording

    assert second["status"] == "ok"
    assert len(step["intervals"]) == 2, "the orphan and the retry each ran once"
    assert _overlaps(step["intervals"]) == [], (
        "the retry ran while the cancelled attempt's step was still working"
    )
    row = step["db"].tables[TABLE][0]
    assert row["status"] == "complete" and row["attempts"] == 2


@pytest.mark.asyncio
async def test_two_jobs_with_one_run_id_execute_once(
    redis: Any, fast_lease: None, step: dict[str, Any]
) -> None:
    """Two concurrent submissions sharing a caller run_id: one executes, the other replays it."""
    a, b = await asyncio.gather(
        _job(redis, "job-a", run_id="caller-run-1"),
        _job(redis, "job-b", run_id="caller-run-1"),
    )
    assert len(step["intervals"]) == 1, "a duplicate submission executed the step a second time"
    assert a == b  # the loser waited for the lease, then replayed the winner's recorded result
    assert step["db"].count(TABLE) == 1
    assert step["db"].tables[TABLE][0].get("attempts", 1) == 1  # the DB default is 1


@pytest.mark.asyncio
async def test_a_live_duplicate_stands_down_rather_than_running(
    redis: Any, fast_lease: None, step: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A holder still refreshing after a full wait is genuinely running the work: do not run it twice."""
    monkeypatch.setattr(run_lease, "WAIT_S", 0.3)
    step["duration"] = 1.0
    a, b = await asyncio.gather(
        _job(redis, "job-a", run_id="caller-run-2"),
        _job(redis, "job-b", run_id="caller-run-2"),
    )
    assert len(step["intervals"]) == 1
    skipped = [r for r in (a, b) if r["payload"]["result"].get("duplicate_in_flight")]
    assert len(skipped) == 1


# --- the fleet: two real arq workers, one Redis -----------------------------------------------


@pytest.mark.asyncio
async def test_two_arq_workers_run_each_job_once(
    fast_lease: None, step: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Many jobs, two workers on one queue (two replicas): every job executes exactly once."""
    import arq.worker as arq_worker
    from arq.connections import ArqRedis
    from arq.worker import Worker

    async def _no_info(*_a: Any, **_k: Any) -> None:  # fakeredis has no INFO; arq only logs it
        return None

    monkeypatch.setattr(arq_worker, "log_redis_info", _no_info)

    server = fakeredis.FakeServer()

    def _pool() -> ArqRedis:
        return ArqRedis(connection_pool=aioredis.FakeRedis(server=server).connection_pool)

    step["duration"] = 0.02
    n_jobs = 60
    producer = _pool()
    for i in range(n_jobs):
        await producer.enqueue_job(
            "run_write_tool_job", "library", {"op": "list-outlines", "run_id": f"fleet-{i}"}, _queue_name="q"
        )

    def _worker() -> Worker:
        return Worker(
            functions=[worker_mod.run_write_tool_job],
            redis_pool=_pool(),
            queue_name="q",
            burst=True,
            max_jobs=8,
            poll_delay=0.01,
            handle_signals=False,
        )

    w1, w2 = _worker(), _worker()
    await asyncio.wait_for(asyncio.gather(w1.main(), w2.main()), timeout=60)

    ran = [r for _s, _e, r in step["intervals"]]
    assert sorted(ran) == sorted(f"fleet-{i}" for i in range(n_jobs)), "a job ran twice or not at all"
    assert w1.jobs_complete + w2.jobs_complete == n_jobs
    assert w1.jobs_complete > 0 and w2.jobs_complete > 0, "both replicas should have taken work"
    rows = step["db"].tables[TABLE]
    assert len(rows) == n_jobs and all(r.get("attempts", 1) == 1 and r["status"] == "complete" for r in rows)
    for w in (w1, w2):
        await w.close()
