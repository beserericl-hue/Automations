"""Shared pytest fixtures for writer_engine + services."""

from __future__ import annotations

import copy
import os
from collections.abc import AsyncIterator, Callable, Iterator
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
    # Same reason as KIEAI: StealthGPT bills per word and returns `wordsSpent`/`remainingCredits`,
    # so a test that reached it would quietly spend the account's credits.
    "STEALTHGPT_API_KEY",
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
    def __init__(self, data: list[dict[str, Any]], count: int | None = None) -> None:
        self.data = data
        # PostgREST only populates `.count` when the request asked for it (`count="exact"`).
        self.count = count


class FakeQuery:
    """Enough of the supabase-py query builder to exercise select/insert/update/eq/order/limit."""

    def __init__(self, db: FakeSupabase, table: str) -> None:
        self.db = db
        self.table_name = table
        self.filters: list[tuple[str, Any]] = []
        # E1's ingestion store filters with in_/is_/neq as well as eq, and a predicate list is the
        # only way to express those without rewriting `filters` (which other tests read).
        self.predicates: list[Callable[[dict[str, Any]], bool]] = []
        self._op = ""
        self._payload: Any = None
        self._conflict: str = ""
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None
        self._count = False

    # -- builders
    def select(self, *_a: Any, **_k: Any) -> FakeQuery:
        self._op = "select"
        # `count="exact"` asks for the total BEFORE limit/offset, which is the only way to count
        # past PostgREST's 1,000-row response cap.
        self._count = bool(_k.get("count"))
        return self

    def insert(self, payload: Any) -> FakeQuery:
        self._op = "insert"
        self._payload = payload
        return self

    def update(self, payload: Any) -> FakeQuery:
        self._op = "update"
        self._payload = payload
        return self

    def upsert(self, payload: Any, on_conflict: str = "") -> FakeQuery:
        self._op = "upsert"
        self._payload = payload
        self._conflict = on_conflict
        return self

    def eq(self, col: str, val: Any) -> FakeQuery:
        self.filters.append((col, val))
        return self

    def neq(self, col: str, val: Any) -> FakeQuery:
        self.predicates.append(lambda r, c=col, v=val: r.get(c) != v)
        return self

    def in_(self, col: str, values: Any) -> FakeQuery:
        wanted = set(values or [])
        self.predicates.append(lambda r, c=col, w=wanted: r.get(c) in w)
        return self

    def is_(self, col: str, val: Any) -> FakeQuery:
        # PostgREST spells IS NULL as `.is_(col, "null")`.
        if str(val).lower() == "null":
            self.predicates.append(lambda r, c=col: r.get(c) is None)
        else:
            self.filters.append((col, val))
        return self

    def like(self, col: str, pattern: str) -> FakeQuery:
        prefix = str(pattern).rstrip("%")
        self.predicates.append(lambda r, c=col, p=prefix: str(r.get(c) or "").startswith(p))
        return self

    def order(self, col: str, desc: bool = False, nullsfirst: bool = False) -> FakeQuery:
        self._order = (col, desc)
        return self

    def limit(self, n: int) -> FakeQuery:
        self._limit = n
        return self

    # -- execution
    def _matching(self) -> list[dict[str, Any]]:
        rows = self.db.tables.setdefault(self.table_name, [])
        return [
            r
            for r in rows
            if all(r.get(c) == v for c, v in self.filters) and all(p(r) for p in self.predicates)
        ]

    async def execute(self) -> FakeResp:
        rows = self.db.tables.setdefault(self.table_name, [])
        if self._op == "select":
            out = self._matching()
            total = len(out)
            if self._order:
                col, desc = self._order
                out = sorted(out, key=lambda r: (r.get(col) is None, r.get(col)), reverse=desc)
            if self._limit is not None:
                out = out[: self._limit]
            return FakeResp([copy.deepcopy(r) for r in out], count=total if self._count else None)
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
        if self._op == "upsert":
            items = self._payload if isinstance(self._payload, list) else [self._payload]
            key = self._conflict or self.db.primary_keys.get(self.table_name) or "id"
            made = []
            for item in items:
                existing = next((r for r in rows if r.get(key) == item.get(key)), None)
                if existing is not None:
                    existing.update(item)
                    made.append(copy.deepcopy(existing))
                else:
                    rows.append({**item})
                    made.append(copy.deepcopy(rows[-1]))
            return FakeResp(made)
        raise AssertionError(f"unsupported op {self._op!r}")


class FakeBucket:
    """Enough of ``client.storage.from_(bucket)`` to assert what landed where (E1).

    The ingestion store writes two blobs then a row and deletes the blobs if the row fails, so a
    test needs to see the bucket's contents — not just that upload was called.
    """

    def __init__(self, db: FakeSupabase, bucket: str) -> None:
        self.db = db
        self.bucket = bucket

    async def upload(self, path: str, content: bytes, file_options: dict[str, str] | None = None) -> Any:
        if path in self.db.fail_uploads:
            raise RuntimeError(f"storage upload failed: {path}")
        self.db.objects[(self.bucket, path)] = (content, dict(file_options or {}))
        return {"path": path}

    async def remove(self, paths: list[str]) -> Any:
        for path in paths:
            self.db.objects.pop((self.bucket, path), None)
        return [{"name": p} for p in paths]

    async def download(self, path: str) -> bytes | None:
        found = self.db.objects.get((self.bucket, path))
        return found[0] if found else None


class FakeStorage:
    def __init__(self, db: FakeSupabase) -> None:
        self.db = db

    def from_(self, bucket: str) -> FakeBucket:
        return FakeBucket(self.db, bucket)


class FakeSupabase:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {}
        # Only the ledger has a real primary key that must conflict.
        self.primary_keys: dict[str, str] = {LEDGER_TABLE: "run_id"}
        # (bucket, path) -> (bytes, file_options)
        self.objects: dict[tuple[str, str], tuple[bytes, dict[str, str]]] = {}
        self.fail_uploads: set[str] = set()
        self.storage = FakeStorage(self)

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(self, name)

    def count(self, name: str) -> int:
        return len(self.tables.get(name, []))

    def paths(self, bucket: str) -> set[str]:
        return {p for b, p in self.objects if b == bucket}


@pytest.fixture
def fake_supabase() -> FakeSupabase:
    """An in-memory stand-in for the service-role Supabase client."""
    return FakeSupabase()


@pytest.fixture(autouse=True)
def _isolated_drain_flag(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the B7 drain flag at this test's tmp_path.

    The flag is a file, by design (it must be readable by three processes in one container and
    invisible to every other instance). Without this, a test that drains leaves a real
    `/tmp/engine-draining` behind and every later readiness test in the session returns 503 —
    which is exactly what happened the first time these tests ran together.
    """
    monkeypatch.setenv("DRAIN_FLAG_PATH", str(tmp_path / "engine-draining"))


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
