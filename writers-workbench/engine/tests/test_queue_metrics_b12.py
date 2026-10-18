"""B12 — queue-depth metrics and the scaling policy they drive.

Two things were missing before this: a sample cheap enough to take on a timer, and a rule for what
the sample means. The rule is the part worth testing, because the obvious one is wrong here: depth
on the heavy queue is bounded by account-wide Anthropic TPM (B9), so adding replicas buys nothing,
while the same shape of number on the interactive queue is exactly what a replica fixes.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from writer_engine import queue_metrics as Q
from writer_engine.queues import QUEUE_HEAVY, QUEUE_INTERACTIVE


class _Redis:
    """The three reads the sampler makes, and a count of them."""

    def __init__(
        self,
        depth: int = 0,
        *,
        health: str | bytes | None = None,
        oldest_age_s: float = 0.0,
        boom: bool = False,
    ) -> None:
        self.depth = depth
        self.health = health
        self.oldest_age_s = oldest_age_s
        self.boom = boom
        self.calls = 0

    async def zcard(self, _key: str) -> int:
        self.calls += 1
        if self.boom:
            raise ConnectionError("redis down")
        return self.depth

    async def get(self, _key: str) -> Any:
        self.calls += 1
        return self.health

    async def zrange(self, _key: str, _start: int, _stop: int, withscores: bool = False) -> Any:
        self.calls += 1
        return [(b"job-1", (time.time() - self.oldest_age_s) * 1000)]


def _health(*, ongoing: int, queued: int = 0, complete: int = 7, failed: int = 0) -> bytes:
    return (
        f"Oct-18 17:00:00 j_complete={complete} j_failed={failed} j_retried=0 "
        f"j_ongoing={ongoing} queued={queued}"
    ).encode()


class TestParseHealth:
    def test_the_worker_heartbeat_yields_its_counters(self) -> None:
        got = Q.parse_health(_health(ongoing=2, queued=5, complete=12, failed=1))
        assert got == {
            "j_complete": 12,
            "j_failed": 1,
            "j_retried": 0,
            "j_ongoing": 2,
            "queued": 5,
        }

    def test_a_missing_or_unparseable_record_is_empty_not_an_error(self) -> None:
        """arq writes this line for humans, so its format is not a contract. A sampler must degrade
        to "running unknown" rather than raise."""
        for raw in (None, b"", "no counters here", b"j_ongoing=", "Oct-18 17:00:00"):
            assert Q.parse_health(raw) == {}, raw


class TestSample:
    def test_running_and_waiting_are_split_by_the_heartbeat(self) -> None:
        """Depth alone cannot tell busy from backed-up: arq keeps a job in the sorted set while it
        runs."""
        r = _Redis(depth=10, health=_health(ongoing=8))
        s = asyncio.run(Q.sample_queue(r, QUEUE_HEAVY, health_key="k"))
        assert (s.depth, s.running, s.waiting) == (10, 8, 2)
        assert s.saturation == 1.0  # heavy is 8 slots

    def test_the_sample_is_three_round_trips_regardless_of_depth(self) -> None:
        r = _Redis(depth=5000, health=_health(ongoing=8))
        asyncio.run(Q.sample_queue(r, QUEUE_HEAVY, health_key="k"))
        assert r.calls == 3

    def test_an_empty_queue_does_not_ask_for_its_oldest_item(self) -> None:
        r = _Redis(depth=0, health=_health(ongoing=0))
        s = asyncio.run(Q.sample_queue(r, QUEUE_HEAVY, health_key="k"))
        assert r.calls == 2
        assert s.oldest_wait_s is None

    def test_a_deferred_job_is_not_a_backlog(self) -> None:
        """arq's score is when the job becomes ELIGIBLE, so a job scheduled for the future would
        otherwise read as a negative wait."""
        r = _Redis(depth=1, health=_health(ongoing=0), oldest_age_s=-600)
        s = asyncio.run(Q.sample_queue(r, QUEUE_HEAVY, health_key="k"))
        assert s.oldest_wait_s == 0.0

    def test_a_dead_worker_is_unknown_running_not_zero(self) -> None:
        """No heartbeat with depth 12 could be a stalled worker or a worker with nothing to do, and
        reporting running=0 would assert the second."""
        r = _Redis(depth=12, health=None)
        s = asyncio.run(Q.sample_queue(r, QUEUE_HEAVY, health_key="k"))
        assert s.depth == 12
        assert s.running is None and s.waiting is None and s.saturation is None

    def test_redis_down_is_reported_not_raised(self) -> None:
        s = asyncio.run(Q.sample_queue(_Redis(boom=True), QUEUE_HEAVY, health_key="k"))
        assert "ConnectionError" in s.error
        assert s.as_dict()["error"]

    def test_a_healthy_sample_carries_no_error_field(self) -> None:
        r = _Redis(depth=1, health=_health(ongoing=1))
        assert "error" not in asyncio.run(Q.sample_queue(r, QUEUE_HEAVY, health_key="k")).as_dict()


def _s(queue: str, **kw: Any) -> Q.QueueSample:
    from writer_engine.queues import profile_for

    base: dict[str, Any] = {
        "queue": queue,
        "depth": 0,
        "running": 0,
        "waiting": 0,
        "max_jobs": profile_for(queue).max_jobs,
        "saturation": 0.0,
        "oldest_wait_s": 0.0,
        "completed": 0,
        "failed": 0,
    }
    base.update(kw)
    return Q.QueueSample(**base)


class TestPolicy:
    def test_a_full_heavy_queue_is_tpm_bound_not_a_reason_to_add_an_instance(self) -> None:
        """The whole point of the policy. A 96-chapter batch fills the heavy queue for hours by
        design; a second instance shares the same account-wide output TPM and writes no faster."""
        advice = Q.scaling_advice(
            [
                _s(QUEUE_HEAVY, depth=40, running=8, waiting=32, saturation=1.0, oldest_wait_s=900),
                _s(QUEUE_INTERACTIVE),
            ]
        )
        assert advice["verdict"] == "tpm_bound"
        assert "TPM" in advice["reason"]

    def test_queued_interactive_work_is_a_reason_to_add_an_instance(self) -> None:
        advice = Q.scaling_advice(
            [
                _s(QUEUE_HEAVY),
                _s(
                    QUEUE_INTERACTIVE,
                    depth=30,
                    running=24,
                    waiting=6,
                    saturation=1.0,
                    oldest_wait_s=120,
                ),
            ]
        )
        assert advice["verdict"] == "scale_out"

    def test_a_full_queue_that_turns_over_fast_is_not_a_problem(self) -> None:
        """Saturation alone is not a signal — a queue at 24/24 slots that clears in seconds is a
        queue doing its job."""
        advice = Q.scaling_advice(
            [
                _s(QUEUE_HEAVY),
                _s(QUEUE_INTERACTIVE, depth=24, running=24, saturation=1.0, oldest_wait_s=2),
            ]
        )
        assert advice["verdict"] == "hold"

    def test_waiting_work_with_free_slots_is_not_a_capacity_problem(self) -> None:
        """Slots free and work waiting means the worker is blocked on something else (the LLM
        budget, a provider). Another instance would queue on the same thing."""
        advice = Q.scaling_advice(
            [
                _s(QUEUE_HEAVY, depth=4, running=1, waiting=3, saturation=0.125, oldest_wait_s=600),
                _s(QUEUE_INTERACTIVE),
            ]
        )
        assert advice["verdict"] == "hold"

    def test_an_idle_engine_can_scale_in(self) -> None:
        assert Q.scaling_advice([_s(QUEUE_HEAVY), _s(QUEUE_INTERACTIVE)])["verdict"] == "scale_in"

    def test_no_heartbeat_is_unknown_not_scale_in(self) -> None:
        """Reading a dead worker as "idle, scale in" is how an outage becomes a smaller fleet."""
        advice = Q.scaling_advice([_s(QUEUE_HEAVY, running=None, waiting=None, saturation=None, depth=12)])
        assert advice["verdict"] == "unknown"

    def test_the_thresholds_cannot_oscillate(self) -> None:
        assert Q.SCALE_IN_SATURATION < Q.SATURATION_SCALE_OUT

    def test_every_sample_is_reported_even_when_it_failed(self) -> None:
        advice = Q.scaling_advice([_s(QUEUE_HEAVY), _s(QUEUE_INTERACTIVE, error="boom")])
        assert len(advice["queues"]) == 2
