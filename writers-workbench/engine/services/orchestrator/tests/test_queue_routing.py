"""B4/B5 at the route level: what queue a job lands on, and how it is found again.

The two failure modes these pin down:

* a job enqueued onto the heavy queue but polled on the interactive one reports ``not_found``, i.e.
  a running chapter write looks lost to the UI;
* a job enqueued before the split (queue ``newsletter``) becomes unpollable the moment we deploy.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest
from arq.jobs import JobStatus
from fastapi.testclient import TestClient

from orchestrator import main as orch_main
from writer_engine.queues import (
    HEAVY,
    INTERACTIVE,
    POLL_QUEUES,
    QUEUE_HEAVY,
    QUEUE_INTERACTIVE,
    QUEUE_LEGACY,
)

SECRET = {"X-Service-Secret": "test-secret"}
ADMIN = {"X-Admin-Token": "test-admin-token"}


class _FakeJob:
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id


class _FakePool:
    """Records every enqueue so a test can assert which queue took the job."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def enqueue_job(self, function: str, *args: Any, _queue_name: str = "", **_: Any) -> _FakeJob:
        self.calls.append({"function": function, "args": args, "queue": _queue_name})
        return _FakeJob(f"job-{len(self.calls)}")


@pytest.fixture
def client() -> Iterator[TestClient]:
    """A client whose app has a recording arq pool.

    Constructed WITHOUT the context manager on purpose: entering it runs the lifespan, which dials a
    real Redis for the arq pool and would both slow the suite and overwrite the fake.
    """
    pool = _FakePool()
    previous = getattr(orch_main.app.state, "arq_pool", None)
    orch_main.app.state.arq_pool = pool
    c = TestClient(orch_main.app)
    c.pool = pool  # type: ignore[attr-defined]
    try:
        yield c
    finally:
        orch_main.app.state.arq_pool = previous


def _fake_redis(
    client: TestClient,
    depths: dict[str, int],
    *,
    ongoing: dict[str, int] | None = None,
    oldest_age_s: float = 5.0,
    stalls: int = 0,
) -> None:
    """Give the app's arq pool the three reads the queue sampler makes: ZCARD, GET (the worker
    heartbeat) and ZRANGE WITHSCORES (the oldest item's eligible-at score)."""
    import time as _time

    ongoing = ongoing or {}

    async def _zcard(key: str) -> int:
        return depths.get(key, 0)

    async def _get(key: str) -> bytes | None:
        for queue, n in ongoing.items():
            if key.endswith(queue):
                return (
                    f"Oct-18 17:00:00 j_complete=9 j_failed=0 j_retried=0 j_ongoing={n} "
                    f"queued={depths.get(queue, 0)}"
                ).encode()
        return None

    async def _zrange(key: str, start: int, stop: int, withscores: bool = False) -> list[Any]:
        if not depths.get(key):
            return []
        return [(b"job-1", (_time.time() - oldest_age_s) * 1000)]

    # The budget-stall window (window.STALL_KEY) is read with zremrangebyscore + zrangebyscore.
    # `stalls` members mean that many LLM calls actually waited for token capacity; the default of
    # none is what distinguishes plain backlog from a real token ceiling.
    async def _zremrangebyscore(_key: str, _lo: Any, _hi: Any) -> int:
        return 0

    async def _zrangebyscore(_key: str, _lo: Any, _hi: Any) -> list[str]:
        # str, not bytes: get_redis() sets decode_responses=True, so this matches production.
        return [f"t{i}:1" for i in range(stalls)]

    pool = client.app.state.arq_pool  # type: ignore[attr-defined]
    pool.zcard = _zcard
    pool.get = _get
    pool.zrange = _zrange
    pool.zremrangebyscore = _zremrangebyscore
    pool.zrangebyscore = _zrangebyscore


def _run(client: TestClient, tool: str, body: dict[str, Any]) -> dict[str, Any]:
    r = client.post(f"/pipelines/write/{tool}/run", json={**body, "async": True}, headers=SECRET)
    assert r.status_code == 200, r.text
    return r.json()


# --- enqueue routing --------------------------------------------------------------------------


def test_a_chapter_write_goes_to_the_heavy_queue(client: TestClient) -> None:
    out = _run(client, "chapter", {"op": "write", "chapter_number": 1})
    assert out["queue"] == QUEUE_HEAVY
    assert client.pool.calls[-1]["queue"] == QUEUE_HEAVY  # type: ignore[attr-defined]


def test_a_chapter_qa_goes_to_the_interactive_queue(client: TestClient) -> None:
    """Same tool, different op — this is the starvation B4 is about."""
    out = _run(client, "chapter", {"op": "qa", "chapter_number": 1})
    assert out["queue"] == QUEUE_INTERACTIVE
    assert client.pool.calls[-1]["queue"] == QUEUE_INTERACTIVE  # type: ignore[attr-defined]


def test_nothing_is_enqueued_onto_the_pre_split_queue(client: TestClient) -> None:
    for tool, op in [("chapter", "write"), ("chapter", "qa"), ("research", "run"), ("media", "cover-art")]:
        _run(client, tool, {"op": op})
    queues = {c["queue"] for c in client.pool.calls}  # type: ignore[attr-defined]
    assert QUEUE_LEGACY not in queues
    assert queues <= {QUEUE_HEAVY, QUEUE_INTERACTIVE}


# --- polling ----------------------------------------------------------------------------------


def _patch_job(monkeypatch: pytest.MonkeyPatch, *, lives_on: str | None) -> list[str]:
    """Replace arq's Job so only the queue named ``lives_on`` recognises the id."""
    asked: list[str] = []

    class _Job:
        def __init__(self, job_id: str, *, redis: Any = None, _queue_name: str = "") -> None:
            self.job_id = job_id
            self._queue_name = _queue_name

        async def status(self) -> JobStatus:
            asked.append(self._queue_name)
            if lives_on is not None and self._queue_name == lives_on:
                return JobStatus.queued
            return JobStatus.not_found

        async def abort(self, **_: Any) -> bool:
            return True

    import arq.jobs

    monkeypatch.setattr(arq.jobs, "Job", _Job)
    return asked


@pytest.mark.parametrize("queue", [QUEUE_HEAVY, QUEUE_INTERACTIVE, QUEUE_LEGACY])
def test_a_job_is_found_whichever_queue_holds_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, queue: str
) -> None:
    _patch_job(monkeypatch, lives_on=queue)
    r = client.get("/pipelines/write/jobs/job-1", headers=SECRET)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "queued"
    assert body["queue"] == queue  # queued comes from THIS queue's sorted set, so it is attributable


def test_a_finished_jobs_queue_is_not_guessed(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Seen on DEV: an interactive job reported "queue": "engine-heavy" once it completed.

    `complete` and `in_progress` come from queue-independent keys, so the first queue asked answers
    for a job that ran anywhere. Naming it would be a guess dressed as a fact, so the field is
    omitted instead.
    """

    class _Done:
        def __init__(self, job_id: str, *, redis: Any = None, _queue_name: str = "") -> None:
            pass

        async def status(self) -> JobStatus:
            return JobStatus.complete

        async def result(self, **_: Any) -> dict[str, Any]:
            return {"status": "ok"}

    import arq.jobs

    monkeypatch.setattr(arq.jobs, "Job", _Done)
    body = client.get("/pipelines/write/jobs/job-1", headers=SECRET).json()
    assert body["status"] == "complete"
    assert "queue" not in body


def test_every_queue_is_tried_before_reporting_not_found(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked = _patch_job(monkeypatch, lives_on=None)
    r = client.get("/pipelines/write/jobs/nope", headers=SECRET)
    assert r.json()["status"] == "not_found"
    assert "queue" not in r.json()
    assert asked == list(POLL_QUEUES), "a queue skipped here is a job reported lost"


def test_polling_stops_at_the_queue_that_has_it(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _patch_job(monkeypatch, lives_on=QUEUE_HEAVY)
    client.get("/pipelines/write/jobs/job-1", headers=SECRET)
    assert asked == [QUEUE_HEAVY]


def test_abort_resolves_the_queue_too(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _patch_job(monkeypatch, lives_on=QUEUE_INTERACTIVE)
    r = client.post("/pipelines/write/jobs/job-1/abort", headers=SECRET)
    assert r.status_code == 200
    assert r.json()["aborted"] is True
    assert QUEUE_INTERACTIVE in asked


# --- /admin/dlq -------------------------------------------------------------------------------


def test_dlq_requires_the_admin_token(client: TestClient) -> None:
    assert client.get("/admin/dlq").status_code == 401


def test_dlq_returns_what_was_recorded(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Route wiring only — the DLQ read itself is covered against fakeredis in tests/test_queues.py."""
    seen: dict[str, Any] = {}

    async def _read(limit: int = 50) -> list[dict[str, Any]]:
        seen["limit"] = limit
        return [
            {"queue": QUEUE_HEAVY, "function": "run_write_tool_job", "job_id": "job-9"},
            {"queue": QUEUE_INTERACTIVE, "function": "run_write_tool_job", "job_id": "job-8"},
        ]

    monkeypatch.setattr(orch_main, "read_dead_letters", _read)
    r = client.get("/admin/dlq", headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    assert [e["job_id"] for e in body["entries"]] == ["job-9", "job-8"]
    assert seen["limit"] == 50


def test_dlq_limit_is_clamped(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A caller must not be able to ask Redis for an unbounded LRANGE."""
    seen: list[int] = []

    async def _read(limit: int = 50) -> list[dict[str, Any]]:
        seen.append(limit)
        return []

    monkeypatch.setattr(orch_main, "read_dead_letters", _read)
    for asked in (0, -5, 10_000):
        client.get(f"/admin/dlq?limit={asked}", headers=ADMIN)
    assert seen == [1, 1, 500]


# --- /admin/dashboard (C1) --------------------------------------------------------------------


def test_dashboard_requires_the_admin_token(client: TestClient) -> None:
    """Queue contents and job arguments name users and projects."""
    assert client.get("/admin/dashboard").status_code == 401


def test_dashboard_answers_the_three_incident_questions(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """is it up / is it working / what broke — in one request, because four was nobody."""

    async def _ready() -> tuple[dict[str, Any], bool]:
        return {
            "status": "degraded",
            "checks": {"redis": {"ok": True, "required": True}},
        }, True

    async def _dlq(limit: int = 10) -> list[dict[str, Any]]:
        return [{"kind": "crash", "error": "TimeoutError", "queue": QUEUE_HEAVY}]

    monkeypatch.setattr(orch_main, "_readiness_with_verdict", _ready)
    monkeypatch.setattr(orch_main, "read_dead_letters", _dlq)

    body = client.get("/admin/dashboard", headers=ADMIN).json()
    assert body["status"] == "degraded"
    assert body["servable"] is True
    assert body["checks"]["redis"]["ok"] is True
    assert set(body["queues"]) == set(POLL_QUEUES)
    assert body["dead_letters"]["shown"] == 1


def test_dashboard_separates_running_from_waiting(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """arq keeps a RUNNING job in the queue's sorted set.

    Counting the set alone would report busy-but-fine as backed-up, which is the one distinction
    the number exists to make. The split comes from the worker's own heartbeat (`j_ongoing`) rather
    than from a status call per job — B12 made that per-job loop the dashboard's cost driver, so a
    500-deep queue cost 500 round trips to render.
    """

    async def _ready() -> tuple[dict[str, Any], bool]:
        return {"status": "ok", "checks": {}}, True

    async def _dlq(limit: int = 10) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(orch_main, "_readiness_with_verdict", _ready)
    monkeypatch.setattr(orch_main, "read_dead_letters", _dlq)
    _fake_redis(client, {QUEUE_HEAVY: 3}, ongoing={QUEUE_HEAVY: 1})

    heavy = client.get("/admin/dashboard", headers=ADMIN).json()["queues"][QUEUE_HEAVY]
    assert heavy["depth"] == 3
    assert heavy["running"] == 1
    assert heavy["waiting"] == 2


def test_dashboard_shows_each_queues_sizing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """The timeout and slot count are half of reading a depth number correctly."""

    async def _ready() -> tuple[dict[str, Any], bool]:
        return {"status": "ok", "checks": {}}, True

    async def _dlq(limit: int = 10) -> list[dict[str, Any]]:
        return []

    monkeypatch.setattr(orch_main, "_readiness_with_verdict", _ready)
    monkeypatch.setattr(orch_main, "read_dead_letters", _dlq)
    queues = client.get("/admin/dashboard", headers=ADMIN).json()["queues"]
    assert queues[QUEUE_HEAVY]["job_timeout_s"] == HEAVY.job_timeout
    assert queues[QUEUE_INTERACTIVE]["max_jobs"] == INTERACTIVE.max_jobs
    # The pre-split queue is marked as such rather than given a profile it no longer has.
    assert queues[QUEUE_LEGACY].get("legacy") is True


def test_dashboard_survives_an_unreachable_queue(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A dashboard that 500s during an incident is worse than one that reports a gap."""

    async def _ready() -> tuple[dict[str, Any], bool]:
        return {"status": "ok", "checks": {}}, True

    async def _dlq(limit: int = 10) -> list[dict[str, Any]]:
        return []

    async def _boom(*_a: Any, **_k: Any) -> Any:
        raise ConnectionError("redis down")

    monkeypatch.setattr(orch_main, "_readiness_with_verdict", _ready)
    monkeypatch.setattr(orch_main, "read_dead_letters", _dlq)
    client.app.state.arq_pool.zcard = _boom  # type: ignore[attr-defined]
    client.app.state.arq_pool.get = _boom  # type: ignore[attr-defined]

    r = client.get("/admin/dashboard", headers=ADMIN)
    assert r.status_code == 200
    assert "ConnectionError" in r.json()["queues"][QUEUE_HEAVY]["error"]


# --- B12: the queue endpoint and its gauges ----------------------------------------------------


def test_admin_queues_reports_depth_and_a_verdict(client: TestClient) -> None:
    _fake_redis(client, {QUEUE_HEAVY: 40}, ongoing={QUEUE_HEAVY: 8}, oldest_age_s=900)
    body = client.get("/admin/queues", headers=ADMIN).json()
    heavy = next(q for q in body["queues"] if q["queue"] == QUEUE_HEAVY)
    assert (heavy["depth"], heavy["running"], heavy["waiting"]) == (40, 8, 32)
    # A full heavy queue is bounded by account-wide output TPM, not by this instance (B9), so the
    # verdict must NOT be "add a replica".
    # No call waited for token capacity, so a deep queue is backlog — NOT a reason to go and buy a
    # higher Anthropic tier. Measured for real during the 96-chapter run: 89 waiting, 429s oldest,
    # zero stalls.
    assert body["verdict"] == "backlog"
    assert body["budget_stalls_last_minute"] == 0
    assert body["thresholds"]["heavy_wait_tpm_bound_s"] > 0


def test_admin_queues_needs_the_admin_token(client: TestClient) -> None:
    assert client.get("/admin/queues").status_code in (401, 403)


def test_the_sampler_tick_publishes_the_gauges(client: TestClient) -> None:
    """The gauges are set on a timer, so /metrics stays a cheap read with no Redis hop in it."""
    from prometheus_client import REGISTRY

    from writer_engine.queue_metrics import sample_all

    _fake_redis(client, {QUEUE_INTERACTIVE: 9}, ongoing={QUEUE_INTERACTIVE: 4}, oldest_age_s=12)

    async def _go() -> None:
        await sample_all(
            client.app.state.arq_pool,  # type: ignore[attr-defined]
            health_key_for=lambda q: f"engine:arq:health-check:{q}",
        )

    asyncio.run(_go())
    labels = {"queue": QUEUE_INTERACTIVE}
    assert REGISTRY.get_sample_value("engine_queue_depth", labels) == 9
    assert REGISTRY.get_sample_value("engine_queue_running", labels) == 4
    assert REGISTRY.get_sample_value("engine_queue_waiting", labels) == 5
    assert REGISTRY.get_sample_value("engine_queue_oldest_wait_seconds", labels) >= 11


# --- C2: the capacity verdict reaches a person, not just a log line ----------------------------


def test_a_capacity_verdict_sends_one_debounced_alert(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Queue depth was measured (B12) and then only logged. A log line nobody reads is the same
    failure as the 2026-05 Redis outage: the system knew, and nobody was told."""
    sent: list[Any] = []
    cleared: list[str] = []

    async def _send(alert: Any, **_kw: Any) -> bool:
        sent.append(alert)
        return True

    async def _clear(key: str) -> None:
        cleared.append(key)

    monkeypatch.setattr(orch_main, "send_alert", _send)
    monkeypatch.setattr(orch_main, "clear_alert", _clear)
    # A full heavy queue whose oldest job has waited 15 minutes AND whose calls are waiting on the
    # token budget: that is the TPM ceiling, and a replica would share it.
    _fake_redis(client, {QUEUE_HEAVY: 40}, ongoing={QUEUE_HEAVY: 8}, oldest_age_s=900, stalls=17)

    async def _go() -> dict[str, Any]:
        for job in client.app.state.cron_jobs:  # type: ignore[attr-defined]
            if job.name == "queue-metrics":
                return await job.run()
        raise AssertionError("the queue-metrics job is not registered")

    out = asyncio.run(_go())
    assert out["verdict"] == "tpm_bound"
    assert len(sent) == 1
    # The lever must be named: a replica would NOT help here.
    assert "token budget" in sent[0].title
    assert sent[0].level == "warning"  # nothing is broken; work is queueing
    assert sent[0].key.endswith("tpm_bound")


def test_a_healthy_queue_clears_the_alert_instead_of_sending_one(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Clearing matters as much as sending: without it, the debounce window opened by one episode
    swallows the next one."""
    sent: list[Any] = []
    cleared: list[str] = []

    async def _send(alert: Any, **_kw: Any) -> bool:
        sent.append(alert)
        return True

    async def _clear(key: str) -> None:
        cleared.append(key)

    monkeypatch.setattr(orch_main, "send_alert", _send)
    monkeypatch.setattr(orch_main, "clear_alert", _clear)
    _fake_redis(client, {QUEUE_HEAVY: 0}, ongoing={QUEUE_HEAVY: 0})

    async def _go() -> dict[str, Any]:
        for job in client.app.state.cron_jobs:  # type: ignore[attr-defined]
            if job.name == "queue-metrics":
                return await job.run()
        raise AssertionError("the queue-metrics job is not registered")

    asyncio.run(_go())
    assert sent == []
    assert any(k.endswith("scale_out") for k in cleared)
    assert any(k.endswith("tpm_bound") for k in cleared)
