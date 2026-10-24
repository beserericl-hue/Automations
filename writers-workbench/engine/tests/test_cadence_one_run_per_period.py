"""One newsletter run per scheduled period, even when nobody answers the approval gate.

Found on DEV: The Wasteland Wire (weekly) started a new run every 15 minutes for five days and
opened ~300 stories approvals nobody answered. "Due" was measured from the last completed SEND,
and a run writes its send only after its gates are approved, so an unanswered run never moved the
baseline. The baseline is now the latest of: last send, last approval the edition's run opened,
and the tick's own record of starting a run.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any, ClassVar
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from writer_engine.cadence import latest_baseline

NOW = datetime.now(UTC)
EDITION = {
    "id": "wasteland-wire",
    "user_id": "+14105914612",
    "cadence": "weekly",
    "cadence_send_time": "",
    "created_at": (NOW - timedelta(days=10)).isoformat(),
}


class FakeQuery:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def __getattr__(self, _name: str) -> Any:
        return lambda *a, **k: self  # select / eq / neq / order / limit

    async def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=self.rows)


class FakeSupabase:
    def __init__(self, sends: list[dict[str, Any]], approvals: list[dict[str, Any]]) -> None:
        self.tables = {
            "newsletter_editions_v2": [EDITION],
            "newsletter_sends_v2": sends,
            "newsletter_approvals_v2": approvals,
        }

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(self.tables[name])


class FakeRedis:
    def __init__(self) -> None:
        self.kv: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self.kv.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.kv[key] = value


class FakeDriver:
    started: ClassVar[list[dict[str, Any]]] = []

    def __init__(self, *a: Any, **k: Any) -> None: ...

    async def start(self, *, cfg: dict[str, Any]) -> Any:
        FakeDriver.started.append(cfg)
        return uuid4()

    async def advance(self, _eid: Any) -> None: ...


@pytest.fixture
def tick(monkeypatch: pytest.MonkeyPatch):
    import writer_engine.redis_client.client as redis_client
    import writer_engine.supabase.client as sb
    from orchestrator import main as M

    redis = FakeRedis()
    FakeDriver.started = []
    monkeypatch.setattr(M, "NewsletterSagaDriver", FakeDriver)
    monkeypatch.setattr(redis_client, "get_redis", lambda: _value(redis))

    def run(sends: list[dict[str, Any]], approvals: list[dict[str, Any]]) -> dict[str, Any]:
        monkeypatch.setattr(sb, "get_supabase_admin", lambda: _value(FakeSupabase(sends, approvals)))
        client = TestClient(M.app)
        client.app.state.arq_pool = None  # type: ignore[attr-defined]
        r = client.post("/cron/newsletter-cadence", headers={"x-cron-secret": "test-admin-token"})
        assert r.status_code == 200, r.text
        return r.json()

    return SimpleNamespace(run=run, redis=redis)


async def _value(v: Any) -> Any:
    return v


def test_latest_baseline_takes_the_newest_readable_moment() -> None:
    older, newer = "2026-10-19T09:00:00+00:00", "2026-10-24T16:00:00Z"
    assert latest_baseline(older, None, "junk", newer) == datetime(2026, 10, 24, 16, tzinfo=UTC)
    assert latest_baseline(None, "") is None


def test_a_run_waiting_at_its_gate_holds_back_the_next(tick: SimpleNamespace) -> None:
    body = tick.run(sends=[], approvals=[{"created_at": (NOW - timedelta(hours=1)).isoformat()}])
    assert body["enqueued"] == 0
    assert FakeDriver.started == []


def test_a_run_that_failed_before_the_gate_still_counts(tick: SimpleNamespace) -> None:
    tick.redis.kv["newsletter:cadence:started:wasteland-wire"] = (NOW - timedelta(hours=1)).isoformat()
    assert tick.run(sends=[], approvals=[])["enqueued"] == 0


def test_a_due_edition_starts_once_and_the_next_tick_does_not_start_another(tick: SimpleNamespace) -> None:
    first = tick.run(sends=[], approvals=[])
    assert first["enqueued"] == 1
    assert FakeDriver.started[0]["edition_id"] == "wasteland-wire"
    assert "newsletter:cadence:started:wasteland-wire" in tick.redis.kv

    # Fifteen minutes later nothing has been approved or sent — the case that used to restart.
    assert tick.run(sends=[], approvals=[])["enqueued"] == 0
    assert len(FakeDriver.started) == 1


def test_a_week_after_the_last_run_it_is_due_again(tick: SimpleNamespace) -> None:
    last_week = (NOW - timedelta(days=8)).isoformat()
    tick.redis.kv["newsletter:cadence:started:wasteland-wire"] = last_week
    assert tick.run(sends=[], approvals=[{"created_at": last_week}])["enqueued"] == 1
