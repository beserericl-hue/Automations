"""C2 — the engine tells a human when it is degraded.

The bar this has to clear is set by history: Redis died on 2026-05-19 and took the queue and SSE
with it for NINE DAYS before anyone noticed, by using the product. B2 gave the engine a readiness
endpoint, but an endpoint only helps someone already looking at it.

So the tests here are mostly about the ways a monitor fails people rather than about the happy path:
alerting so often that it gets filtered, alerting N times for one outage because N instances
noticed, going silent exactly when its own dependency is the thing that broke, or throwing an
exception on the failure path and becoming a second outage.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from writer_engine import alerting
from writer_engine.alerting import LEVEL_CRITICAL, LEVEL_WARNING, Alert, clear_alert, send_alert
from writer_engine.config import get_settings


@pytest.fixture(autouse=True)
def _clear_local_debounce() -> Any:
    """The per-process debounce is module state; without this, test order decides outcomes."""
    from writer_engine import alerting as alerting_mod

    alerting_mod._local_last_sent.clear()
    yield
    alerting_mod._local_last_sent.clear()


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Capture what would have been emailed."""
    outbox: list[dict[str, Any]] = []

    class _Result:
        status = "ok"

    class _Postal:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            pass

        async def send(self, **kwargs: Any) -> Any:
            outbox.append(kwargs)
            return _Result()

    monkeypatch.setattr("writer_engine.postal.client.PostalClient", _Postal)
    monkeypatch.setenv("ALERT_EMAIL", "ops@example.test")
    get_settings.cache_clear()
    yield outbox
    get_settings.cache_clear()


def _alert(key: str = "redis-down", level: str = LEVEL_CRITICAL) -> Alert:
    return Alert(
        key=key,
        level=level,
        title="Redis unreachable",
        detail="ConnectionError: connect call failed",
        context={"queue_depth": 12},
    )


# --- the happy path ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_alert_is_emailed(sent: list[dict[str, Any]], fake_redis: Any) -> None:
    assert await send_alert(_alert()) is True
    assert len(sent) == 1
    mail = sent[0]
    assert mail["to"] == ["ops@example.test"]
    assert "Redis unreachable" in mail["subject"]
    assert mail["tag"] == "engine-alert"


@pytest.mark.asyncio
async def test_the_subject_alone_is_enough_to_triage(sent: list[dict[str, Any]], fake_redis: Any) -> None:
    """Most alerts are read on a phone, as a notification, with no body visible."""
    await send_alert(_alert(level=LEVEL_CRITICAL))
    subject = sent[0]["subject"]
    assert "CRITICAL" in subject
    assert "Redis unreachable" in subject


@pytest.mark.asyncio
async def test_the_body_carries_the_context_and_the_instance(
    sent: list[dict[str, Any]], fake_redis: Any
) -> None:
    """With several instances up, "Redis is down" needs to say which one is reporting."""
    await send_alert(_alert())
    body = sent[0]["html"]
    assert "queue_depth" in body and "12" in body
    assert "instance" in body
    assert "ConnectionError" in body


@pytest.mark.asyncio
async def test_the_body_escapes_what_it_interpolates(sent: list[dict[str, Any]], fake_redis: Any) -> None:
    """Alert details come from provider errors and exception strings, i.e. not from us."""
    await send_alert(Alert(key="k", level=LEVEL_WARNING, title="<script>x</script>", detail="a & b <tag>"))
    body = sent[0]["html"]
    assert "<script>" not in body
    assert "&lt;script&gt;" in body
    assert "a &amp; b" in body


# --- debounce ----------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_condition_is_reported_once_per_window(sent: list[dict[str, Any]], fake_redis: Any) -> None:
    """A mail every 30 seconds during an outage is a mail people filter into a folder."""
    for _ in range(5):
        await send_alert(_alert(), repeat_after_s=600)
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_different_conditions_do_not_suppress_each_other(
    sent: list[dict[str, Any]], fake_redis: Any
) -> None:
    await send_alert(_alert(key="redis-down"), repeat_after_s=600)
    await send_alert(_alert(key="worker-missing"), repeat_after_s=600)
    assert len(sent) == 2


@pytest.mark.asyncio
async def test_several_instances_send_one_email(sent: list[dict[str, Any]], fake_redis: Any) -> None:
    """The claim is SET NX + EX, so two instances noticing in the same second cannot both send."""
    import asyncio

    results = await asyncio.gather(*[send_alert(_alert(), repeat_after_s=600) for _ in range(6)])
    assert sum(1 for r in results if r) == 1
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_the_window_expires(sent: list[dict[str, Any]], fake_redis: Any) -> None:
    """An outage that is still going an hour later is worth saying again."""
    await send_alert(_alert(), repeat_after_s=600)
    await clear_alert("redis-down")  # stands in for the key's TTL elapsing
    await send_alert(_alert(), repeat_after_s=600)
    assert len(sent) == 2


@pytest.mark.asyncio
async def test_force_bypasses_the_debounce(sent: list[dict[str, Any]], fake_redis: Any) -> None:
    await send_alert(_alert(), repeat_after_s=600)
    await send_alert(_alert(), repeat_after_s=600, force=True)
    assert len(sent) == 2


# --- the failure modes that matter -------------------------------------------------------------


@pytest.mark.asyncio
async def test_it_still_alerts_when_redis_is_the_thing_that_is_down(
    sent: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The debounce lives in Redis, and Redis is the most likely subject of an alert.

    Failing open here means a possible duplicate email. Failing closed means the one outage we have
    actually had goes unreported again — so the FIRST report must get through.

    This test originally asserted that BOTH consecutive sends went out, on the reasoning that no
    debounce was available. That reasoning was wrong in production: the watchdog ticks every 60s, so
    "no debounce" meant an email a minute for the whole outage. Fails open, bounded locally.
    """

    async def _no_redis() -> Any:
        raise ConnectionError("redis down")

    monkeypatch.setattr("writer_engine.redis_client.client.get_redis", _no_redis)
    assert await send_alert(_alert(), repeat_after_s=600) is True
    assert await send_alert(_alert(), repeat_after_s=600) is False  # bounded by the local window
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_no_recipient_configured_is_logged_not_raised(
    monkeypatch: pytest.MonkeyPatch, fake_redis: Any
) -> None:
    """An unconfigured alert channel must not take down the thing it was watching."""
    monkeypatch.setenv("ALERT_EMAIL", "")
    get_settings.cache_clear()
    assert await send_alert(_alert()) is False
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_a_send_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch, fake_redis: Any) -> None:
    """Postal being down during an outage is likely; it must not raise into the caller."""

    class _Broken:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            raise RuntimeError("Postal not configured")

    monkeypatch.setattr("writer_engine.postal.client.PostalClient", _Broken)
    monkeypatch.setenv("ALERT_EMAIL", "ops@example.test")
    get_settings.cache_clear()
    assert await send_alert(_alert()) is False
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_a_rejected_send_reports_failure(monkeypatch: pytest.MonkeyPatch, fake_redis: Any) -> None:
    """Postal answering with status=error is not a delivered alert, and must not be reported as one."""

    class _Rejected:
        status = "error"

    class _Postal:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            pass

        async def send(self, **_: Any) -> Any:
            return _Rejected()

    monkeypatch.setattr("writer_engine.postal.client.PostalClient", _Postal)
    monkeypatch.setenv("ALERT_EMAIL", "ops@example.test")
    get_settings.cache_clear()
    assert await send_alert(_alert()) is False
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_clear_alert_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _no_redis() -> Any:
        raise ConnectionError("down")

    monkeypatch.setattr("writer_engine.redis_client.client.get_redis", _no_redis)
    await clear_alert("anything")


def test_the_alert_level_constants_are_what_the_subject_uses() -> None:
    """A typo'd level would still render, just uselessly ("[LEVEL_CRITICAL] ...")."""
    assert alerting.LEVEL_CRITICAL == "critical"
    assert alerting.LEVEL_WARNING == "warning"


# --- the flood (2026-10-17) --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_redis_outage_does_not_email_every_tick(
    sent: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The failure this was written for.

    DEV's old Redis was retired out from under the engine. The watchdog correctly noticed, and
    because the debounce lives in Redis the fail-open path had no window at all — so it emailed once
    per tick, per instance, for as long as the outage lasted. Failing open is still right; it just
    has to be bounded by a process-local window.
    """

    async def _no_redis() -> Any:
        raise ConnectionError("Name or service not known")

    monkeypatch.setattr("writer_engine.redis_client.client.get_redis", _no_redis)
    for _ in range(10):  # ten watchdog ticks during one outage
        await send_alert(_alert(key="redis-down"), repeat_after_s=600)
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_the_local_window_still_expires(
    sent: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bounded is not silent: a continuing outage is still worth repeating eventually."""

    async def _no_redis() -> Any:
        raise ConnectionError("down")

    monkeypatch.setattr("writer_engine.redis_client.client.get_redis", _no_redis)
    await send_alert(_alert(key="redis-down"), repeat_after_s=0.01)
    await asyncio.sleep(0.02)
    await send_alert(_alert(key="redis-down"), repeat_after_s=0.01)
    assert len(sent) == 2


@pytest.mark.asyncio
async def test_clear_alert_clears_the_local_window_too(
    sent: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Recovery clears the condition; a relapse must not be suppressed by a stale local window."""

    async def _no_redis() -> Any:
        raise ConnectionError("down")

    monkeypatch.setattr("writer_engine.redis_client.client.get_redis", _no_redis)
    await send_alert(_alert(key="redis-down"), repeat_after_s=600)
    await clear_alert("redis-down")
    await send_alert(_alert(key="redis-down"), repeat_after_s=600)
    assert len(sent) == 2
