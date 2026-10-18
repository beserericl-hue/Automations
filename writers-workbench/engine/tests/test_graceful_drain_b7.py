"""B7 — graceful drain: readiness flip → finish in-flight → terminate.

A redeploy went straight to SIGTERM, so everything in flight died with the container (CR-010 C1).
The order is the whole point: a shutdown that is still accepting work is worse than a hard kill, so
the flag goes up and is given time to be observed BEFORE anything is torn down.
"""

from __future__ import annotations

import asyncio
import sys
import time

import pytest

from writer_engine import drain
from writer_engine.health import DRAIN_CHECK, CheckResult, probe_drain, summarise
from writer_engine.queues import HEAVY, INTERACTIVE
from writer_engine.supervisor import ManagedProcess, Supervisor


class TestFlag:
    def test_an_instance_is_not_draining_until_it_says_so(self) -> None:
        assert drain.is_draining() is False

    def test_begin_and_clear(self) -> None:
        assert drain.begin_drain(reason="deploy") is True
        assert drain.is_draining() is True
        drain.clear_drain()
        assert drain.is_draining() is False

    def test_the_flag_records_when_the_drain_started(self) -> None:
        drain.begin_drain(reason="deploy")
        since = drain.draining_since()
        assert since is not None and abs(time.time() - since) < 5

    def test_clearing_a_flag_that_is_not_there_is_not_an_error(self) -> None:
        drain.clear_drain()
        drain.clear_drain()

    def test_an_unwritable_flag_is_reported_not_raised(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A container that cannot write its own flag must still shut down — but the caller has to
        know the readiness flip did not happen, rather than waiting out a delay that bought nothing.
        """
        monkeypatch.setenv("DRAIN_FLAG_PATH", "/nonexistent-dir-xyz/flag")
        assert drain.begin_drain(reason="deploy") is False
        assert drain.is_draining() is False

    def test_a_garbled_flag_still_reads_as_draining(self, monkeypatch: pytest.MonkeyPatch) -> None:
        drain.flag_path().write_text("not a timestamp", encoding="utf-8")
        assert drain.is_draining() is True
        assert drain.draining_since() is None


class TestReadiness:
    def test_draining_fails_readiness(self) -> None:
        drain.begin_drain(reason="deploy")
        check = asyncio.run(probe_drain())
        assert check.ok is False and check.required is True
        assert "draining" in check.detail

    def test_a_drain_is_reported_as_draining_not_unhealthy(self) -> None:
        """Opposite remedies: withdraw this instance from the load balancer, do NOT restart it. The
        watchdog pages CRITICAL on `unhealthy`, so conflating the two emails on every deploy."""
        body, servable = summarise(
            "orchestrator",
            [
                CheckResult(name="redis", ok=True),
                CheckResult(name=DRAIN_CHECK, ok=False, detail="draining for 2s", required=True),
            ],
        )
        assert body["status"] == "draining"
        assert servable is False  # still 503 — that is what withdraws it from the LB

    def test_a_real_fault_is_still_unhealthy(self) -> None:
        body, servable = summarise(
            "orchestrator",
            [
                CheckResult(name="redis", ok=False, required=True),
                CheckResult(name=DRAIN_CHECK, ok=True),
            ],
        )
        assert body["status"] == "unhealthy"
        assert servable is False

    def test_a_fault_during_a_drain_does_not_hide_the_drain(self) -> None:
        """Both failed; the response an operator reads should say the instance is going away, since
        that explains the dependency failures that follow from it."""
        body, _ = summarise(
            "orchestrator",
            [
                CheckResult(name="step:chapter", ok=False, required=True),
                CheckResult(name=DRAIN_CHECK, ok=False, required=True),
            ],
        )
        assert body["status"] == "draining"
        assert set(body["failed_required"]) == {"step:chapter", DRAIN_CHECK}


class TestWatchdogIsQuietDuringADrain:
    def test_no_alerts_are_raised_while_draining(self) -> None:
        from writer_engine.watchdog import Watchdog

        sent: list[object] = []

        async def _evaluate() -> dict[str, object]:
            raise AssertionError("a draining instance must not be probed at all")

        async def _alert(alert: object, force: bool = False) -> bool:
            sent.append(alert)
            return True

        drain.begin_drain(reason="deploy")
        dog = Watchdog(_evaluate, interval_s=1, service="orchestrator", alert=_alert)
        body = asyncio.run(dog.tick())
        assert body["status"] == "draining"
        assert sent == []


class TestSupervisorSequence:
    @staticmethod
    def _sleeper(name: str, seconds: int = 30) -> ManagedProcess:
        return ManagedProcess(name=name, argv=(sys.executable, "-c", f"import time; time.sleep({seconds})"))

    def test_the_flag_goes_up_before_the_children_are_signalled(self) -> None:
        """The ordering IS the feature, so it is observed from inside `terminate()`: at the moment
        the first child is signalled, the flag must already be up and the readiness delay already
        slept. A shutdown that signals first is a shutdown still taking traffic."""
        observed: list[tuple[bool, float]] = []
        sup = Supervisor([self._sleeper("a")], drain_timeout_s=5, readiness_delay_s=0.3)
        sup.start()
        child = sup._children[0]
        real_terminate = child.popen.terminate
        flipped_at = time.monotonic()

        def _terminate() -> None:
            observed.append((drain.is_draining(), time.monotonic() - flipped_at))
            real_terminate()

        child.popen.terminate = _terminate  # type: ignore[method-assign]
        assert drain.is_draining() is False
        sup.shutdown(reason="received SIGTERM")

        assert observed, "the child was never signalled"
        was_draining, elapsed = observed[0]
        assert was_draining is True
        assert elapsed >= 0.3  # the flip was given time to be observed by a readiness probe
        assert drain.is_draining() is True

    def test_a_restarted_container_is_not_born_draining(self) -> None:
        """The flag is a file. On a platform that restarts a process in place or reuses a volume, a
        leftover flag would make the instance come up permanently not-ready."""
        drain.begin_drain(reason="previous life")
        sup = Supervisor([self._sleeper("a", 1)], drain_timeout_s=5, readiness_delay_s=0.0)
        sup.start()
        assert drain.is_draining() is False
        sup.shutdown(reason="test over")

    def test_a_crash_does_not_announce_a_drain(self) -> None:
        """A child that died takes the container down; there is nothing to drain, and pausing for a
        readiness flip would only delay the restart that fixes it."""
        sup = Supervisor([self._sleeper("a")], drain_timeout_s=5, readiness_delay_s=5.0)
        sup.start()
        started = time.monotonic()
        sup.shutdown(reason="a exited (rc=1)", flip_readiness=False)
        assert drain.is_draining() is False
        assert time.monotonic() - started < 5.0  # the delay was not slept


class TestWorkerWaitsForItsJobs:
    def test_both_queues_wait_for_in_flight_work(self) -> None:
        assert HEAVY.drain_wait_s > 0
        assert INTERACTIVE.drain_wait_s > 0

    def test_the_wait_is_not_the_job_ceiling(self) -> None:
        """A 5400s wait would be theatre: the platform SIGKILLs long before that, and arq re-queues
        what it cancels."""
        assert HEAVY.drain_wait_s < HEAVY.job_timeout
        assert INTERACTIVE.drain_wait_s < INTERACTIVE.job_timeout

    def test_the_worker_settings_carry_it_to_arq(self) -> None:
        """arq only switches to the wait-for-completion signal handler when this is non-zero, so a
        settings class that drops it silently reverts to cancel-on-SIGTERM."""
        from orchestrator.worker import WorkerSettingsHeavy, WorkerSettingsInteractive

        assert WorkerSettingsHeavy.job_completion_wait == HEAVY.drain_wait_s  # type: ignore[attr-defined]
        assert WorkerSettingsInteractive.job_completion_wait == INTERACTIVE.drain_wait_s  # type: ignore[attr-defined]


class TestTheWindowIsCoherent:
    """The numbers have to fit inside each other, or the drain cancels the work it is draining."""

    def test_the_supervisor_waits_longer_than_the_slowest_worker(self) -> None:
        from writer_engine.supervisor import DEFAULT_DRAIN_TIMEOUT_S

        assert max(HEAVY.drain_wait_s, INTERACTIVE.drain_wait_s) < DEFAULT_DRAIN_TIMEOUT_S

    def test_the_whole_sequence_fits_in_the_platform_grace_period_we_set(self) -> None:
        """Railway's `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to **0** — SIGKILL immediately
        after SIGTERM — so the drain is dead code unless the service sets it. It is 60 on DEV; this
        pins that 60 is actually enough for the sequence the code asks for."""
        from writer_engine.drain import DRAIN_READINESS_DELAY_S
        from writer_engine.supervisor import DEFAULT_DRAIN_TIMEOUT_S

        assert DRAIN_READINESS_DELAY_S + DEFAULT_DRAIN_TIMEOUT_S <= 60
