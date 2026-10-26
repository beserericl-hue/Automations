"""The engine's own clock (E1 / E7).

Two things in this system are supposed to happen on a schedule with nobody asking:

* **ingestion** — poll the feed list and fill ``content_ingestion_v2``
* **the newsletter cadence** — find editions whose interval has elapsed and enqueue a generate

Both existed as HTTP endpoints (``/cron/newsletter-cadence``, and now ``/cron/ingestion``) guarded by
``X-Cron-Secret``, and in both cases **the thing that called them was n8n** — a schedule trigger on a
canvas. So "turn n8n off" would have silently stopped the newsletter from ever being generated and
the corpus from ever being refilled, with no error anywhere: an endpoint nobody calls looks exactly
like an endpoint with nothing to do.

Moving the clock inside the engine removes the last scheduled dependency on n8n and the need for a
Railway cron or cron-job.org as a replacement. The HTTP endpoints stay, because a manual kick and a
debug re-run are worth having, and because an external cron is still a legitimate way to drive this
if one is ever preferred — set the interval to 0 and the internal task does not start.

Design, deliberately the same shape as :mod:`writer_engine.watchdog`:

* **the loop never raises.** A tick that throws is logged and the next one still fires. A scheduler
  that dies on a bad feed is how you lose a month of ingestion without noticing.
* **ticks never overlap.** Each job awaits its own previous run; a 40-minute ingestion tick on a
  30-minute interval delays the next one rather than running two at once against the same feeds.
* **one replica per tick (C1).** Every replica runs the loop, and that used to be called safe
  because ingestion and the cadence cron claim their own rows. The scheduled publisher does not: two
  replicas reading the same due post both enqueued it, a double publish and a double email. So a job
  is ``singleton`` by default and takes a Redis lock (``fleet.run_once``) whose TTL is just under its
  interval: whichever replica ticks first runs it, the rest skip. Per-instance jobs (the queue-metrics
  sampler, which publishes this process's own gauges) opt out.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from writer_engine.telemetry.logging import get_logger

Lock = Callable[[str, float], Awaitable[bool]]
"""``lock(name, ttl_s) -> bool``: True if this replica should run the job now."""

LOCK_TTL_FRACTION = 0.95
"""A singleton's lock lives for this share of its interval, so runs stay at least that far apart
across the fleet while the next interval's tick, on any replica, can still take it."""

logger = get_logger("scheduler")

MIN_INTERVAL_S = 30.0
"""Floor on any job's interval. A misconfigured ``INGESTION_POLL_SECONDS=1`` would otherwise hammer
Supabase with claim queries forever."""

STARTUP_DELAY_S = 20.0
"""Grace period before the first tick. Lets the container finish booting — Redis pool, step app
listening — so the first ingestion run is not racing startup."""


@dataclass
class Job:
    """One scheduled job: a name, an interval, and something to await."""

    name: str
    interval_s: float
    run: Callable[[], Awaitable[object]]
    singleton: bool = True

    @property
    def enabled(self) -> bool:
        return self.interval_s > 0


class Scheduler:
    """Runs a set of :class:`Job` s on their own intervals inside one asyncio task."""

    def __init__(
        self,
        jobs: list[Job],
        *,
        startup_delay_s: float = STARTUP_DELAY_S,
        lock: Lock | None = None,
    ) -> None:
        self.jobs = [j for j in jobs if j.enabled]
        self.startup_delay_s = max(0.0, startup_delay_s)
        self.lock = lock
        self._last_run: dict[str, datetime] = {}
        self._ticks: dict[str, int] = {}
        self._skipped: dict[str, int] = {}
        self._errors: dict[str, str] = {}

    def status(self) -> dict[str, object]:
        """What ``/admin/scheduler`` reports: is the clock actually ticking, and did it work?"""
        return {
            "jobs": [
                {
                    "name": j.name,
                    "interval_s": j.interval_s,
                    "singleton": j.singleton,
                    "ticks": self._ticks.get(j.name, 0),
                    # Ticks another replica took. Non-zero on every replica but one is the lock working.
                    "skipped": self._skipped.get(j.name, 0),
                    "last_run": self._last_run[j.name].isoformat() if j.name in self._last_run else None,
                    "last_error": self._errors.get(j.name),
                }
                for j in self.jobs
            ]
        }

    async def tick(self, job: Job) -> None:
        """Run one job once, swallowing everything it throws. A singleton another replica holds is
        skipped."""
        if job.singleton and self.lock is not None:
            ttl = max(MIN_INTERVAL_S, job.interval_s) * LOCK_TTL_FRACTION
            if not await self.lock(job.name, ttl):
                self._skipped[job.name] = self._skipped.get(job.name, 0) + 1
                logger.debug("scheduler.skipped", job=job.name, reason="another replica holds it")
                return
        started = datetime.now(UTC)
        self._ticks[job.name] = self._ticks.get(job.name, 0) + 1
        try:
            await job.run()
            self._errors.pop(job.name, None)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._errors[job.name] = f"{type(exc).__name__}: {exc}"[:240]
            logger.warning("scheduler.tick_failed", job=job.name, error=self._errors[job.name])
        finally:
            self._last_run[job.name] = started
            logger.info(
                "scheduler.tick",
                job=job.name,
                seconds=round((datetime.now(UTC) - started).total_seconds(), 1),
                ok=job.name not in self._errors,
            )

    async def _loop(self, job: Job) -> None:
        interval = max(MIN_INTERVAL_S, job.interval_s)
        await asyncio.sleep(self.startup_delay_s)
        while True:
            await self.tick(job)
            # Sleep AFTER the work, so a slow tick pushes the next one out instead of stacking.
            await asyncio.sleep(interval)

    async def run(self) -> None:
        if not self.jobs:
            logger.info("scheduler.disabled")
            return
        logger.info("scheduler.start", jobs=[j.name for j in self.jobs])
        await asyncio.gather(*(self._loop(job) for job in self.jobs))


def start(scheduler: Scheduler) -> asyncio.Task[None]:
    """Spawn the scheduler as a background task. The caller cancels it on shutdown."""
    return asyncio.create_task(scheduler.run(), name="engine-scheduler")


async def stop(task: asyncio.Task[None] | None) -> None:
    """Cancel and await the loop, tolerating a task that already finished."""
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


__all__ = [
    "LOCK_TTL_FRACTION",
    "MIN_INTERVAL_S",
    "STARTUP_DELAY_S",
    "Job",
    "Lock",
    "Scheduler",
    "start",
    "stop",
]
