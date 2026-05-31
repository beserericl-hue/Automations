"""Shared pytest fixtures for writer_engine + services."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest

# Force-set defaults BEFORE any writer_engine import so settings pick them up.
os.environ.setdefault("SERVICE_SHARED_SECRET", "test-secret")
os.environ.setdefault("ADMIN_TOKEN", "test-admin-token")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

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
):
    os.environ[_isolated_key] = ""

# Bust the lru_cache so the (already-imported) settings module rereads with the cleared values.
try:
    from writer_engine.config import get_settings as _gs

    _gs.cache_clear()
except ImportError:
    pass


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
