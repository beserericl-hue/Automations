"""C2 — something has to look at the readiness endpoint on a schedule.

/admin/ready has told the truth since B2, but only to whoever asked it. Nobody asked, which is how
the 2026-05-19 Redis outage ran for nine days. These tests pin the behaviour that makes a monitor
usable rather than ignorable: alert on the transition, say when it is over, keep one condition's
noise away from another, and never take down the host you are watching.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from writer_engine.watchdog import KEY_DLQ, Watchdog


def _body(status: str = "ok", **checks: Any) -> dict[str, Any]:
    return {"status": status, "service": "orchestrator", "checks": checks}


def _ok(required: bool = True) -> dict[str, Any]:
    return {"ok": True, "required": required}


def _bad(detail: str = "boom", required: bool = True) -> dict[str, Any]:
    return {"ok": False, "detail": detail, "required": required}


class _Recorder:
    """Stands in for send_alert, recording what would have gone out."""

    def __init__(self) -> None:
        self.alerts: list[Any] = []
        self.forced: list[bool] = []

    async def __call__(self, alert: Any, **kwargs: Any) -> bool:
        self.alerts.append(alert)
        self.forced.append(bool(kwargs.get("force")))
        return True

    @property
    def keys(self) -> list[str]:
        return [a.key for a in self.alerts]

    @property
    def titles(self) -> list[str]:
        return [a.title for a in self.alerts]


def _dog(bodies: list[dict[str, Any]], recorder: _Recorder, **kw: Any) -> Watchdog:
    """A watchdog that walks a scripted sequence of readiness bodies, one per tick."""
    seq = list(bodies)

    async def _evaluate() -> dict[str, Any]:
        return seq.pop(0) if seq else bodies[-1]

    return Watchdog(_evaluate, interval_s=10, alert=recorder, **kw)


# --- transitions -------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_healthy_system_is_silent(fake_redis: Any) -> None:
    rec = _Recorder()
    dog = _dog([_body("ok", redis=_ok(), supabase=_ok(False))], rec)
    await dog.tick()
    assert rec.alerts == []


@pytest.mark.asyncio
async def test_a_newly_failing_check_alerts_once(fake_redis: Any) -> None:
    """Once, not once per tick — this is the difference between a monitor and a mail flood."""
    rec = _Recorder()
    failing = _body("unhealthy", redis=_bad("ConnectionError"))
    dog = _dog([failing, failing, failing], rec)
    for _ in range(3):
        await dog.tick()
    assert rec.keys == ["check:redis"]
    assert "redis" in rec.titles[0]


@pytest.mark.asyncio
async def test_the_alert_carries_the_detail(fake_redis: Any) -> None:
    rec = _Recorder()
    dog = _dog([_body("unhealthy", redis=_bad("ConnectionError: connect call failed"))], rec)
    await dog.tick()
    assert "ConnectionError" in rec.alerts[0].detail


@pytest.mark.asyncio
async def test_recovery_is_reported(fake_redis: Any) -> None:
    """An inbox should tell the whole story without anyone opening a dashboard."""
    rec = _Recorder()
    dog = _dog([_body("unhealthy", redis=_bad()), _body("ok", redis=_ok())], rec)
    await dog.tick()
    await dog.tick()
    assert rec.keys == ["check:redis", "check:redis:recovered"]
    assert "recovered" in rec.titles[1]


@pytest.mark.asyncio
async def test_a_second_outage_after_a_recovery_alerts_again(fake_redis: Any) -> None:
    """The failure alert's debounce window must not swallow the NEXT real failure."""
    rec = _Recorder()
    dog = _dog(
        [_body("unhealthy", redis=_bad()), _body("ok", redis=_ok()), _body("unhealthy", redis=_bad())],
        rec,
    )
    for _ in range(3):
        await dog.tick()
    assert rec.keys == ["check:redis", "check:redis:recovered", "check:redis"]


@pytest.mark.asyncio
async def test_each_condition_is_its_own_alert(fake_redis: Any) -> None:
    """ "Redis is down" and "the chapter step is down" need different responses."""
    rec = _Recorder()
    dog = _dog([_body("unhealthy", redis=_bad(), **{"step:chapter": _bad()})], rec)
    await dog.tick()
    assert sorted(rec.keys) == ["check:redis", "check:step:chapter"]


@pytest.mark.asyncio
async def test_a_required_failure_is_critical_and_an_optional_one_is_a_warning(fake_redis: Any) -> None:
    """Paging on a degraded-but-serving instance trains people to ignore the critical ones too."""
    rec = _Recorder()
    dog = _dog(
        [_body("unhealthy", redis=_bad(required=True), supabase=_bad(required=False))],
        rec,
    )
    await dog.tick()
    levels = {a.key: a.level for a in rec.alerts}
    assert levels["check:redis"] == "critical"
    assert levels["check:supabase"] == "warning"


@pytest.mark.asyncio
async def test_a_check_that_disappears_counts_as_recovered(fake_redis: Any) -> None:
    """A probe dropped from the list should close its incident, not leave it open forever."""
    rec = _Recorder()
    dog = _dog([_body("unhealthy", gone=_bad()), _body("ok", redis=_ok())], rec)
    await dog.tick()
    await dog.tick()
    assert rec.keys[-1] == "check:gone:recovered"


# --- dead letters ------------------------------------------------------------------------------


def _dlq_reader(entries: list[list[dict[str, Any]]]) -> Any:
    seq = list(entries)

    async def _read(limit: int = 1) -> list[dict[str, Any]]:
        return seq.pop(0) if seq else (entries[-1] if entries else [])

    return _read


@pytest.mark.asyncio
async def test_the_first_tick_does_not_alert_on_an_old_dead_letter(fake_redis: Any) -> None:
    """After a restart the newest entry may be days old. "A job failed once" is not news."""
    rec = _Recorder()
    dog = _dog(
        [_body("ok"), _body("ok")],
        rec,
        dead_letters=_dlq_reader([[{"ts": 1000.0, "error": "old"}], [{"ts": 1000.0, "error": "old"}]]),
    )
    await dog.tick()
    await dog.tick()
    assert rec.alerts == []


@pytest.mark.asyncio
async def test_a_new_dead_letter_alerts(fake_redis: Any) -> None:
    """This is the alert that answers "did my chapter fail?" before the user has to ask."""
    rec = _Recorder()
    dog = _dog(
        [_body("ok"), _body("ok")],
        rec,
        dead_letters=_dlq_reader(
            [
                [{"ts": 1000.0, "error": "old"}],
                [
                    {
                        "ts": 2000.0,
                        "kind": "step_error",
                        "queue": "engine-heavy",
                        "error": "AuthenticationError: 401",
                        "args": "{'tool': 'chapter', 'op': 'write', 'chapter_number': 7}",
                    }
                ],
            ]
        ),
    )
    await dog.tick()
    await dog.tick()
    assert rec.keys == [KEY_DLQ]
    alert = rec.alerts[0]
    assert "401" in alert.detail
    assert "chapter" in str(alert.context)


@pytest.mark.asyncio
async def test_an_unchanged_dlq_does_not_re_alert(fake_redis: Any) -> None:
    rec = _Recorder()
    same = [{"ts": 2000.0, "error": "x"}]
    dog = _dog([_body("ok")] * 3, rec, dead_letters=_dlq_reader([[{"ts": 1000.0}], same, same]))
    for _ in range(3):
        await dog.tick()
    assert rec.keys == [KEY_DLQ]


@pytest.mark.asyncio
async def test_an_empty_or_unreadable_dlq_is_not_an_alert(fake_redis: Any) -> None:
    rec = _Recorder()

    async def _broken(limit: int = 1) -> list[dict[str, Any]]:
        raise ConnectionError("redis down")

    dog = _dog([_body("ok")], rec, dead_letters=_broken)
    await dog.tick()
    assert rec.alerts == []

    rec2 = _Recorder()
    dog2 = _dog([_body("ok")], rec2, dead_letters=_dlq_reader([[]]))
    await dog2.tick()
    assert rec2.alerts == []


# --- the loop ----------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_loop_survives_a_failing_evaluation(fake_redis: Any) -> None:
    """A watchdog that can crash its host is worse than no watchdog."""
    rec = _Recorder()
    calls = {"n": 0}

    async def _evaluate() -> dict[str, Any]:
        calls["n"] += 1
        raise RuntimeError("probe exploded")

    dog = Watchdog(_evaluate, interval_s=10, alert=rec)
    task = asyncio.create_task(dog.run())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls["n"] >= 1  # it ran, and the exception did not propagate out of run()


@pytest.mark.asyncio
async def test_the_interval_has_a_floor() -> None:
    """A misconfigured 0.1s interval would hammer 19 step probes 10x a second."""
    rec = _Recorder()
    dog = Watchdog(lambda: _async(_body("ok")), interval_s=0.001, alert=rec)
    assert dog._interval_s >= 10.0


async def _async(value: Any) -> Any:
    return value


@pytest.mark.asyncio
async def test_stop_tolerates_a_missing_task() -> None:
    from writer_engine.watchdog import stop

    await stop(None)
