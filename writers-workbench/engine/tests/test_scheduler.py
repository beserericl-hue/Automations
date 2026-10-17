"""E1 — the engine's own clock.

``/cron/newsletter-cadence`` and ``/cron/ingestion`` are both endpoints that something has to call.
That something was an n8n schedule trigger, so "n8n off" would have stopped the newsletter from ever
being generated and the corpus from ever being refilled — with no error in either case, because an
endpoint nobody calls looks exactly like an endpoint with nothing to do.
"""

from __future__ import annotations

import asyncio

import pytest

from writer_engine import scheduler


def _job(name: str, run: object, interval_s: float = 60.0) -> scheduler.Job:
    return scheduler.Job(name=name, interval_s=interval_s, run=run)  # type: ignore[arg-type]


class TestJobSelection:
    def test_a_zero_interval_disables_a_job(self) -> None:
        """How an operator opts back out to an external cron without a code change."""

        async def noop() -> None:
            return None

        sched = scheduler.Scheduler([_job("off", noop, 0), _job("on", noop, 300)])
        assert [j.name for j in sched.jobs] == ["on"]

    def test_a_negative_interval_disables_a_job(self) -> None:
        async def noop() -> None:
            return None

        assert scheduler.Scheduler([_job("off", noop, -1)]).jobs == []

    @pytest.mark.asyncio
    async def test_no_enabled_jobs_means_run_returns_immediately(self) -> None:
        sched = scheduler.Scheduler([])
        await asyncio.wait_for(sched.run(), timeout=1.0)


class TestTick:
    @pytest.mark.asyncio
    async def test_a_successful_tick_is_recorded(self) -> None:
        calls: list[int] = []

        async def work() -> None:
            calls.append(1)

        sched = scheduler.Scheduler([])
        job = _job("ingestion", work)
        await sched.tick(job)
        assert calls == [1]
        status = sched.status()
        assert status["jobs"] == []  # the job was not registered, only ticked
        assert sched._ticks["ingestion"] == 1

    @pytest.mark.asyncio
    async def test_a_raising_tick_does_not_propagate(self) -> None:
        """A scheduler that dies on a bad feed is how a month of ingestion disappears."""

        async def boom() -> None:
            raise RuntimeError("feed exploded")

        sched = scheduler.Scheduler([_job("ingestion", boom)])
        await sched.tick(sched.jobs[0])
        reported = sched.status()["jobs"][0]
        assert reported["last_error"] == "RuntimeError: feed exploded"
        assert reported["ticks"] == 1
        assert reported["last_run"] is not None

    @pytest.mark.asyncio
    async def test_a_later_success_clears_the_error(self) -> None:
        state = {"fail": True}

        async def flaky() -> None:
            if state["fail"]:
                raise RuntimeError("transient")

        sched = scheduler.Scheduler([_job("ingestion", flaky)])
        await sched.tick(sched.jobs[0])
        assert sched.status()["jobs"][0]["last_error"] is not None
        state["fail"] = False
        await sched.tick(sched.jobs[0])
        assert sched.status()["jobs"][0]["last_error"] is None

    @pytest.mark.asyncio
    async def test_cancellation_is_not_swallowed(self) -> None:
        """Shutdown must actually stop the loop rather than being logged as a tick failure."""

        async def cancelled() -> None:
            raise asyncio.CancelledError

        sched = scheduler.Scheduler([_job("ingestion", cancelled)])
        with pytest.raises(asyncio.CancelledError):
            await sched.tick(sched.jobs[0])


class TestLoop:
    @pytest.mark.asyncio
    async def test_ticks_do_not_overlap(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A 40-minute ingestion tick on a 30-minute interval must delay the next one, not run two
        at once against the same feeds."""
        monkeypatch.setattr(scheduler, "MIN_INTERVAL_S", 0.0)
        concurrent = {"now": 0, "max": 0}

        async def slow() -> None:
            concurrent["now"] += 1
            concurrent["max"] = max(concurrent["max"], concurrent["now"])
            await asyncio.sleep(0.02)
            concurrent["now"] -= 1

        sched = scheduler.Scheduler([_job("ingestion", slow, 0.001)], startup_delay_s=0)
        task = scheduler.start(sched)
        await asyncio.sleep(0.12)
        await scheduler.stop(task)
        assert concurrent["max"] == 1
        assert sched.status()["jobs"][0]["ticks"] >= 2

    @pytest.mark.asyncio
    async def test_both_jobs_run_independently(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(scheduler, "MIN_INTERVAL_S", 0.0)
        seen: list[str] = []

        async def a() -> None:
            seen.append("a")

        async def b() -> None:
            seen.append("b")

        sched = scheduler.Scheduler(
            [_job("ingestion", a, 0.001), _job("newsletter-cadence", b, 0.001)], startup_delay_s=0
        )
        task = scheduler.start(sched)
        await asyncio.sleep(0.05)
        await scheduler.stop(task)
        assert "a" in seen and "b" in seen

    @pytest.mark.asyncio
    async def test_startup_delay_is_honoured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The first tick waits for the container to finish booting."""
        monkeypatch.setattr(scheduler, "MIN_INTERVAL_S", 0.0)
        calls: list[int] = []

        async def work() -> None:
            calls.append(1)

        sched = scheduler.Scheduler([_job("ingestion", work, 0.001)], startup_delay_s=5.0)
        task = scheduler.start(sched)
        await asyncio.sleep(0.03)
        assert calls == []
        await scheduler.stop(task)

    @pytest.mark.asyncio
    async def test_interval_floor_is_enforced(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A misconfigured ``INGESTION_POLL_SECONDS=1`` must not hammer Supabase forever."""
        slept: list[float] = []
        real_sleep = asyncio.sleep

        async def spy(seconds: float) -> None:
            slept.append(seconds)
            await real_sleep(0)

        async def work() -> None:
            return None

        monkeypatch.setattr(scheduler.asyncio, "sleep", spy)
        sched = scheduler.Scheduler([_job("ingestion", work, 1.0)], startup_delay_s=0)
        task = scheduler.start(sched)
        await real_sleep(0.02)
        await scheduler.stop(task)
        # The first sleep is the startup delay (0); every interval sleep is the floor.
        assert scheduler.MIN_INTERVAL_S in slept
        assert 1.0 not in slept


class TestStop:
    @pytest.mark.asyncio
    async def test_stopping_none_is_safe(self) -> None:
        await scheduler.stop(None)

    @pytest.mark.asyncio
    async def test_stopping_a_finished_task_is_safe(self) -> None:
        sched = scheduler.Scheduler([])
        task = scheduler.start(sched)
        await asyncio.sleep(0)
        await scheduler.stop(task)
        await scheduler.stop(task)
