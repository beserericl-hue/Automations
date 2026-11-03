"""Cost/run defects from the Ossuary cost audit (DEV, 2026-11-03).

(a) Chapter write rows had no project and no content id: the project is resolved from a title INSIDE
    the op and the content row exists only after every paid call, both after the step's accounting
    context was opened. ``token_accounting.annotate`` fills them in, on later rows and (on flush) on
    rows already written under the same run id.
(b) 47 rows had no provider, operation or source: the pre-044 row form put the provider only in
    metadata. ``persist_token_usage`` now labels every row and logs loudly when it had to default.
(c) 22 QA runs stayed "in progress" forever: a job arq kills on job_timeout (or fails after repeated
    cancels) never reaches fail_run. ``run_reaper`` closes such rows when no live lease holds them.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from writer_engine import persist_helpers
from writer_engine.idempotency import run_reaper
from writer_engine.idempotency.run_lease import lease_key
from writer_engine.telemetry import token_accounting

# ------------------------------------------------------------------------- a tiny supabase fake


class _Resp:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _Query:
    def __init__(self, table: _Table, kind: str, payload: Any = None) -> None:
        self.table, self.kind, self.payload = table, kind, payload
        self.filters: list[tuple[str, str, Any]] = []

    def select(self, *_: Any) -> _Query:
        return self

    def eq(self, col: str, val: Any) -> _Query:
        self.filters.append(("eq", col, val))
        return self

    def lt(self, col: str, val: Any) -> _Query:
        self.filters.append(("lt", col, val))
        return self

    def is_(self, col: str, val: Any) -> _Query:
        self.filters.append(("is", col, val))
        return self

    def order(self, *_: Any, **__: Any) -> _Query:
        return self

    def limit(self, *_: Any) -> _Query:
        return self

    def _match(self, row: dict[str, Any]) -> bool:
        for op, col, val in self.filters:
            if op == "eq" and row.get(col) != val:
                return False
            if op == "lt" and not str(row.get(col)) < str(val):
                return False
            if op == "is" and val == "null" and row.get(col) is not None:
                return False
        return True

    async def execute(self) -> _Resp:
        self.table.log.append((self.kind, self.payload, list(self.filters)))
        if self.kind == "insert":
            rows = [
                {"id": str(uuid.uuid4()), **r}
                for r in (self.payload if isinstance(self.payload, list) else [self.payload])
            ]
            self.table.rows.extend(rows)
            return _Resp(rows)
        hit = [r for r in self.table.rows if self._match(r)]
        if self.kind == "update":
            for r in hit:
                r.update(self.payload)
        return _Resp(hit)


class _Table:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.log: list[tuple[str, Any, list[Any]]] = []

    def select(self, *a: Any) -> _Query:
        return _Query(self, "select").select(*a)

    def insert(self, payload: Any) -> _Query:
        return _Query(self, "insert", payload)

    def update(self, payload: dict[str, Any]) -> _Query:
        return _Query(self, "update", payload)


class _Client:
    def __init__(self) -> None:
        self.tables: dict[str, _Table] = {}

    def table(self, name: str) -> _Table:
        return self.tables.setdefault(name, _Table())


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> _Client:
    """Route token_accounting's writes into an in-memory token_usage_v2."""
    client = _Client()

    async def _admin() -> _Client:
        return client

    import writer_engine.supabase.client as sb

    monkeypatch.setattr(sb, "get_supabase_admin", _admin)
    monkeypatch.setattr(token_accounting, "_persistence_enabled", lambda: True)
    token_accounting.reset()
    return client


def _record() -> None:
    token_accounting.record(provider="anthropic", model="claude-sonnet-4-6", input_tokens=10, output_tokens=5)


# ------------------------------------------------------------------------------------------ (a)


@pytest.mark.asyncio
async def test_annotate_stamps_rows_written_before_the_project_and_content_were_known(db: _Client) -> None:
    async with token_accounting.scope(workflow="chapter.write", user_id="+1", run_id="run-1"):
        _record()
        await token_accounting.wait_for_writes()  # this row is already in the table
        token_accounting.annotate(project_id="proj-9", chapter_number="3")
        _record()
        token_accounting.annotate(content_id="content-7")
    await token_accounting.wait_for_writes()

    rows = db.tables["token_usage_v2"].rows
    assert len(rows) == 2
    assert {r["run_id"] for r in rows} == {"run-1"}
    assert all(r["project_id"] == "proj-9" for r in rows)
    assert all(r["chapter_number"] == 3 for r in rows)
    assert all(r["content_id"] == "content-7" for r in rows)


@pytest.mark.asyncio
async def test_annotate_never_overrides_a_value_from_the_payload(db: _Client) -> None:
    async with token_accounting.scope(workflow="chapter.repair", run_id="run-2", project_id="explicit"):
        _record()
        token_accounting.annotate(project_id="other")
    await token_accounting.wait_for_writes()
    assert db.tables["token_usage_v2"].rows[0]["project_id"] == "explicit"


@pytest.mark.asyncio
async def test_late_stamp_only_touches_this_runs_rows(db: _Client) -> None:
    table = db.table("token_usage_v2")
    table.rows.append({"run_id": "someone-else", "operation": "chapter.write", "content_id": None})
    async with token_accounting.scope(workflow="chapter.write", run_id="run-3"):
        _record()
        await token_accounting.wait_for_writes()
        token_accounting.annotate(content_id="c-3")
    await token_accounting.wait_for_writes()
    assert table.rows[0]["content_id"] is None
    assert table.rows[1]["content_id"] == "c-3"


def test_annotate_outside_a_context_is_a_no_op() -> None:
    token_accounting.reset()
    token_accounting.annotate(project_id="p")  # must not raise


@pytest.mark.asyncio
async def test_persist_content_ties_the_runs_cost_rows_to_the_new_content(db: _Client) -> None:
    async with token_accounting.scope(workflow="chapter.blog", user_id="+1", run_id="run-4"):
        _record()
        cid = await persist_helpers.persist_content(
            db, user_id="+1", title="T", content_type="blog_post", content_text="body"
        )
    await token_accounting.wait_for_writes()
    usage = db.tables["token_usage_v2"].rows
    assert cid and usage[0]["content_id"] == cid


# ------------------------------------------------------------------------------------------ (b)


def test_label_token_rows_defaults_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    errors: list[dict[str, Any]] = []
    monkeypatch.setattr(
        persist_helpers.logger, "error", lambda event, **kw: errors.append({"event": event, **kw})
    )

    rows = persist_helpers.label_token_rows(
        [
            {"workflow_name": "research.run", "model": "sonar-pro", "metadata": {"provider": "perplexity"}},
            {"model": "x", "metadata": {}},
            {"operation": "chapter.write", "provider": "anthropic", "workflow_name": "chapter.write"},
        ]
    )
    assert rows[0]["provider"] == "perplexity" and rows[0]["operation"] == "research.run"
    assert rows[0]["metadata"]["label_defaulted"] == ["provider", "operation"]
    assert rows[1]["provider"] == "unknown" and rows[1]["operation"] == "unattributed.unknown"
    assert rows[1]["workflow_name"] == "unattributed.unknown"
    assert all(r["source"] == "engine" for r in rows)
    assert "label_defaulted" not in (rows[2].get("metadata") or {})
    assert [e["event"] for e in errors] == ["token_usage.unlabelled_row"] * 2


@pytest.mark.asyncio
async def test_no_row_reaches_the_table_without_provider_and_operation() -> None:
    """The pre-044 calls/workflow form wrote provider/operation/source NULL — 47 rows on DEV."""
    client = _Client()
    n = await persist_helpers.persist_token_usage(
        client,
        user_id="+1",
        workflow="chapter.repair",
        calls=[{"provider": "anthropic", "model": "claude-sonnet-4-6", "input_tokens": 1}],
    )
    assert n == 1
    row = client.tables["token_usage_v2"].rows[0]
    assert (row["provider"], row["operation"], row["source"]) == ("anthropic", "chapter.repair", "engine")

    await persist_helpers.persist_token_usage(client, rows=[{"model": "m", "metadata": {}}])
    row = client.tables["token_usage_v2"].rows[1]
    assert row["provider"] and row["operation"] and row["source"]


# ------------------------------------------------------------------------------------------ (c)


class _Redis:
    def __init__(self, held: set[str]) -> None:
        self.held = held

    async def exists(self, key: str) -> int:
        return int(key in self.held)


NOW = datetime(2026, 11, 3, 12, 0, tzinfo=UTC)


def _run(run_id: str, queue: str, age: timedelta) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "tool": "chapter",
        "op": "qa",
        "queue": queue,
        "status": "in_progress",
        "updated_at": (NOW - age).isoformat(),
    }


def test_stale_limits_cover_every_try_at_full_timeout() -> None:
    assert run_reaper.stale_after_s("engine-heavy") == 5400 * 2 + run_reaper.GRACE_S
    assert run_reaper.stale_after_s("engine-interactive") == 900 * 1 + run_reaper.GRACE_S
    assert run_reaper.stale_after_s("") == run_reaper.stale_after_s("engine-heavy")


@pytest.mark.asyncio
async def test_reaper_closes_dead_runs_and_leaves_live_ones() -> None:
    client = _Client()
    t = client.table("engine_job_runs")
    t.rows += [
        _run("dead-qa", "engine-interactive", timedelta(days=14)),  # the 2026-10-20 shape
        _run("young-heavy", "engine-heavy", timedelta(hours=2)),  # under 3h30: may still run
        _run("old-heavy", "engine-heavy", timedelta(hours=4)),
        _run("leased", "engine-interactive", timedelta(hours=5)),  # lease still refreshed
        {**_run("done", "engine-interactive", timedelta(days=3)), "status": "complete"},
    ]
    out = await run_reaper.reap_stale_runs(client, redis=_Redis({lease_key("leased")}), now=NOW)

    by_id = {r["run_id"]: r for r in t.rows}
    assert sorted(out["reaped_run_ids"]) == ["dead-qa", "old-heavy"]
    assert out["lease_held"] == ["leased"]
    assert by_id["dead-qa"]["status"] == "error" and "abandoned" in by_id["dead-qa"]["error"]
    assert by_id["young-heavy"]["status"] == "in_progress"
    assert by_id["leased"]["status"] == "in_progress"
    assert by_id["done"]["status"] == "complete"


@pytest.mark.asyncio
async def test_reaper_update_is_conditional_on_still_in_progress() -> None:
    """A run that completes between the select and the update must keep its result."""
    client = _Client()
    t = client.table("engine_job_runs")
    t.rows.append(_run("racy", "engine-interactive", timedelta(days=1)))
    await run_reaper.reap_stale_runs(client, now=NOW)
    updates = [entry for entry in t.log if entry[0] == "update"]
    assert updates and ("eq", "status", "in_progress") in updates[0][2]


def test_orchestrator_registers_the_reaper() -> None:
    from orchestrator.main import app

    jobs = {j.name: j for j in app.state.cron_jobs}
    assert jobs["run-reaper"].interval_s == 900.0 and jobs["run-reaper"].singleton
