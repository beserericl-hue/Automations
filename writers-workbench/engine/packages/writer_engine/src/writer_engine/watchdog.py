"""The thing that actually looks at the readiness endpoint (C2).

``/admin/ready`` has told the truth since B2 and ``alerting`` can send mail, but neither does
anything unless something checks on a schedule. This is that something: a background task inside the
orchestrator that re-runs the readiness probes every ``WATCHDOG_INTERVAL_SECONDS`` and emails on a
**transition** — the tick where a check starts failing, and the tick where it starts passing again.

Three deliberate choices:

* **Per-check alert keys.** "Redis is down" and "the chapter step is down" are different outages
  with different responses, so they debounce independently. One alert per *condition*, not one per
  tick and not one per incident-wide summary.
* **Recovery is an alert too.** An inbox should tell the whole story — started at 14:02, over at
  14:09 — without anyone opening a dashboard.
* **It lives inside the engine, which cannot catch the engine being dead.** That gap is real and
  not fixable from here: a process cannot report its own absence. It needs an external uptime check
  against ``/admin/health``. What this *does* cover is the failure we actually had — a container
  that is up and answering while a dependency underneath it is gone — which is precisely the shape
  of the 2026-05-19 Redis outage that ran nine days.

The loop never raises. A watchdog that can crash its host is worse than no watchdog, because the
host is the thing being watched.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Any

from writer_engine.alerting import LEVEL_CRITICAL, LEVEL_WARNING, Alert, clear_alert, send_alert
from writer_engine.drain import is_draining
from writer_engine.telemetry.logging import get_logger

logger = get_logger("watchdog")

# Condition keys. Stable strings, because they are what the debounce is keyed on — renaming one
# re-alerts an outage that was already reported.
KEY_CHECK = "check"
KEY_DLQ = "dlq"


class Watchdog:
    """Evaluates a readiness body on a schedule and alerts on changes.

    ``evaluate`` returns the same shape ``/admin/ready`` serves: ``{"status", "checks": {name: {ok,
    required}}}``. Passing it in rather than importing the route keeps this testable and keeps the
    step registry where it belongs (in the orchestrator).
    """

    def __init__(
        self,
        evaluate: Callable[[], Awaitable[dict[str, Any]]],
        *,
        interval_s: float = 60.0,
        service: str = "engine",
        alert: Callable[..., Awaitable[bool]] = send_alert,
        dead_letters: Callable[..., Awaitable[list[dict[str, Any]]]] | None = None,
    ) -> None:
        self._evaluate = evaluate
        self._interval_s = max(10.0, float(interval_s))
        self._service = service
        self._alert = alert
        self._dead_letters = dead_letters
        self._failing: set[str] = set()
        self._last_dlq_ts: float | None = None

    async def tick(self) -> dict[str, Any]:
        """One evaluation. Returns the body it evaluated, for logging and tests."""
        if is_draining():
            # B7: a draining instance is being taken out of service on purpose. Its steps will stop
            # answering and its readiness is already 503 — alerting on that would page CRITICAL on
            # every deploy, which is how an inbox gets ignored.
            logger.info("watchdog.skipped_draining")
            return {"status": "draining", "checks": {}}
        body = await self._evaluate()
        checks = body.get("checks") or {}
        now_failing = {name for name, c in checks.items() if not (c or {}).get("ok", True)}

        for name in sorted(now_failing - self._failing):
            check = checks.get(name) or {}
            required = bool(check.get("required", True))
            await self._alert(
                Alert(
                    key=f"{KEY_CHECK}:{name}",
                    # A required check failing means work cannot be done here; an optional one
                    # means it is degraded. Paging on the second would train people to ignore both.
                    level=LEVEL_CRITICAL if required else LEVEL_WARNING,
                    title=f"{name} is failing",
                    detail=str(check.get("detail") or ""),
                    context={"service": self._service, "overall": body.get("status", "")},
                )
            )

        for name in sorted(self._failing - now_failing):
            # Clear first so this condition's NEXT failure is reported immediately rather than
            # being swallowed by the window the failure alert opened.
            await clear_alert(f"{KEY_CHECK}:{name}")
            await self._alert(
                Alert(
                    key=f"{KEY_CHECK}:{name}:recovered",
                    level=LEVEL_WARNING,
                    title=f"{name} recovered",
                    context={"service": self._service, "overall": body.get("status", "")},
                ),
                force=True,
            )
            await clear_alert(f"{KEY_CHECK}:{name}:recovered")

        self._failing = now_failing
        await self._check_dead_letters()
        return body

    async def _check_dead_letters(self) -> None:
        """Alert when a job has newly failed.

        The DLQ is a capped list, so its LENGTH is not a usable signal — it stops growing at 500 and
        says nothing about recency. The newest entry's timestamp is, and it answers the question a
        user is about to ask: did my chapter fail? Debounced like everything else, so a burst of
        twelve failed chapters is one email, not twelve.
        """
        if self._dead_letters is None:
            return
        try:
            entries = await self._dead_letters(limit=1)
        except Exception as exc:  # pragma: no cover - the DLQ read is already best-effort
            logger.warning("watchdog.dlq_read_failed", error=str(exc)[:160])
            return
        if not entries:
            return
        newest = entries[0]
        try:
            ts = float(newest.get("ts") or 0)
        except (TypeError, ValueError):
            return
        # The first tick after a restart establishes a baseline instead of alerting: the newest
        # entry may be days old, and "a job failed at some point" is not news.
        if self._last_dlq_ts is None:
            self._last_dlq_ts = ts
            return
        if ts <= self._last_dlq_ts:
            return
        self._last_dlq_ts = ts
        await self._alert(
            Alert(
                key=KEY_DLQ,
                level=LEVEL_WARNING,
                title="a job failed (dead letter recorded)",
                detail=str(newest.get("error") or "")[:400],
                context={
                    "service": self._service,
                    "kind": str(newest.get("kind") or ""),
                    "queue": str(newest.get("queue") or ""),
                    "job": str(newest.get("args") or "")[:200],
                },
            )
        )

    async def run(self) -> None:
        """Loop until cancelled. Never raises — the host is the thing being watched."""
        logger.info("watchdog.start", interval_s=self._interval_s, service=self._service)
        while True:
            try:
                body = await self.tick()
                logger.debug("watchdog.tick", status=body.get("status"))
            except asyncio.CancelledError:
                logger.info("watchdog.stop")
                raise
            except Exception as exc:
                logger.warning("watchdog.tick_failed", error=f"{type(exc).__name__}: {str(exc)[:200]}")
            await asyncio.sleep(self._interval_s)


def start(watchdog: Watchdog) -> asyncio.Task[None]:
    """Spawn the loop as a background task. The caller cancels it on shutdown."""
    return asyncio.create_task(watchdog.run(), name="engine-watchdog")


async def stop(task: asyncio.Task[None] | None) -> None:
    """Cancel and await the loop, tolerating a task that already finished."""
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


__all__ = ["KEY_CHECK", "KEY_DLQ", "Watchdog", "start", "stop"]
