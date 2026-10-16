"""Shared pytest fixtures for writer_engine + services."""

from __future__ import annotations

import copy
import os
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest

# Force-set defaults BEFORE any writer_engine import so settings pick them up.
os.environ.setdefault("SERVICE_SHARED_SECRET", "test-secret")
os.environ.setdefault("ADMIN_TOKEN", "test-admin-token")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
# A1: the suite runs key-less, so step services MUST be allowed to substitute fixtures. In DEV/PROD
# this is unset, which makes a missing provider key fail loudly instead of persisting placeholder
# content as real work. Tests that assert the fail-loud path turn it off explicitly.
os.environ.setdefault("ALLOW_FIXTURE_FALLBACK", "true")

# Override any provider/Supabase keys that may be in .env so tests use fixtures (no real API calls).
# Tests that want real keys should opt in by clearing these in their own setup.
for _isolated_key in (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "PERPLEXITY_API_KEY",
    "OPENAI_API_KEY",
    "FIRECRAWL_API_KEY",
    "POSTAL_API_KEY",
    "POSTAL_API_URL",
    # These were MISSING, so the "no real API calls" contract above was not actually upheld on any
    # machine with a populated .env (found while adding the A1 tests):
    #   KIEAI_API_KEY        -> media.cover-art made real, paid image-generation calls
    #   ELEVENLABS_*         -> writer_engine.eve is gated on both being present; with both set a
    #                           test could place a REAL outbound phone call to a real number
    #   WORKBENCH_API_URL /  -> gather/notify reach the live DEV Workbench
    #   INGESTION_SECRET
    "KIEAI_API_KEY",
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_AGENT_ID",
    "WORKBENCH_API_URL",
    "INGESTION_SECRET",
    # Added after tests/test_anthropic_workspace.py failed only on a developer machine: pydantic
    # falls back to the .env FILE when an env var is absent, so monkeypatch.delenv could not make a
    # setting look unconfigured while .env defined it. The suite's result must not depend on what
    # happens to be in a local .env.
    "ANTHROPIC_WORKSPACE_ID",
):
    os.environ[_isolated_key] = ""

# Bust the lru_cache so the (already-imported) settings module rereads with the cleared values.
try:
    from writer_engine.config import get_settings as _gs

    _gs.cache_clear()
except ImportError:
    pass


# --- a fake PostgREST (B6 and anything else that needs to count rows) -------------------------
#
# Enough of the supabase-py async query builder to exercise the persist helpers and the run ledger
# against real row counts. A mock that records calls cannot answer "did this write two rows?", which
# is the only question B6 asks.

# The run ledger's primary key (writer_engine.idempotency.run_ledger.TABLE). Spelled out rather
# than imported so this conftest stays importable before writer_engine is on the path;
# tests/test_idempotency_b6.py asserts the two agree.
LEDGER_TABLE = "engine_job_runs"


class FakeResp:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class FakeQuery:
    """Enough of the supabase-py query builder to exercise select/insert/update/eq/order/limit."""

    def __init__(self, db: FakeSupabase, table: str) -> None:
        self.db = db
        self.table_name = table
        self.filters: list[tuple[str, Any]] = []
        self._op = ""
        self._payload: Any = None
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None

    # -- builders
    def select(self, *_a: Any, **_k: Any) -> FakeQuery:
        self._op = "select"
        return self

    def insert(self, payload: Any) -> FakeQuery:
        self._op = "insert"
        self._payload = payload
        return self

    def update(self, payload: Any) -> FakeQuery:
        self._op = "update"
        self._payload = payload
        return self

    def eq(self, col: str, val: Any) -> FakeQuery:
        self.filters.append((col, val))
        return self

    def order(self, col: str, desc: bool = False) -> FakeQuery:
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> FakeQuery:
        self._limit = n
        return self

    # -- execution
    def _matching(self) -> list[dict[str, Any]]:
        rows = self.db.tables.setdefault(self.table_name, [])
        return [r for r in rows if all(r.get(c) == v for c, v in self.filters)]

    async def execute(self) -> FakeResp:
        rows = self.db.tables.setdefault(self.table_name, [])
        if self._op == "select":
            out = self._matching()
            if self._order:
                col, desc = self._order
                out = sorted(out, key=lambda r: (r.get(col) is None, r.get(col)), reverse=desc)
            if self._limit is not None:
                out = out[: self._limit]
            return FakeResp([copy.deepcopy(r) for r in out])
        if self._op == "insert":
            items = self._payload if isinstance(self._payload, list) else [self._payload]
            made = []
            for item in items:
                row = {**item}
                pk = self.db.primary_keys.get(self.table_name)
                if pk:
                    if any(r.get(pk) == row.get(pk) for r in rows):
                        raise RuntimeError(
                            f'duplicate key value violates unique constraint "{self.table_name}_pkey"'
                        )
                else:
                    row.setdefault("id", f"{self.table_name}-{len(rows) + 1}")
                rows.append(row)
                made.append(copy.deepcopy(row))
            return FakeResp(made)
        if self._op == "update":
            touched = self._matching()
            for r in touched:
                r.update(self._payload)
            return FakeResp([copy.deepcopy(r) for r in touched])
        raise AssertionError(f"unsupported op {self._op!r}")


class FakeSupabase:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {}
        # Only the ledger has a real primary key that must conflict.
        self.primary_keys: dict[str, str] = {LEDGER_TABLE: "run_id"}

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(self, name)

    def count(self, name: str) -> int:
        return len(self.tables.get(name, []))


@pytest.fixture
def fake_supabase() -> FakeSupabase:
    """An in-memory stand-in for the service-role Supabase client."""
    return FakeSupabase()


@pytest.fixture(autouse=True)
def _no_progress_publish(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, Any]]]:
    """Replace publish_progress with an in-memory recorder so tests don't need real Redis.

    Yields the list of published events so tests can assert on them.
    """
    captured: list[dict[str, Any]] = []

    async def fake_publish(execution_id: Any, event: dict[str, Any]) -> None:
        captured.append({"execution_id": str(execution_id), **event})

    # Patch at every import path.
    import writer_engine.redis_client.client as redis_client
    import writer_engine.state_machine.progress as progress_mod

    monkeypatch.setattr(redis_client, "publish_progress", fake_publish)
    monkeypatch.setattr(progress_mod, "publish_progress", fake_publish)
    yield captured


@pytest.fixture
async def fake_redis(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Any]:
    """Provide an in-process Redis substitute via fakeredis when a test really needs one."""
    fakeredis = pytest.importorskip("fakeredis")
    from fakeredis import aioredis  # type: ignore[attr-defined]

    server = fakeredis.FakeServer()
    client = aioredis.FakeRedis(server=server, decode_responses=True)

    async def _get_redis() -> Any:
        return client

    import writer_engine.redis_client.client as redis_module

    monkeypatch.setattr(redis_module, "get_redis", _get_redis)
    try:
        yield client
    finally:
        await client.aclose()
