"""Idempotency cache — second call returns the first call's result."""

from __future__ import annotations

import pytest

from writer_engine.idempotency import idempotent_call


@pytest.mark.asyncio
async def test_idempotent_cache_round_trip(fake_redis) -> None:  # type: ignore[no-untyped-def]
    calls = {"n": 0}

    async def work() -> dict[str, int]:
        calls["n"] += 1
        return {"value": 42}

    first = await idempotent_call("k", ttl_seconds=10, func=work)
    second = await idempotent_call("k", ttl_seconds=10, func=work)

    assert first == {"value": 42}
    assert second == {"value": 42}
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_idempotent_distinct_keys(fake_redis) -> None:  # type: ignore[no-untyped-def]
    counter = {"n": 0}

    async def work() -> dict[str, int]:
        counter["n"] += 1
        return {"v": counter["n"]}

    a = await idempotent_call("a", ttl_seconds=10, func=work)
    b = await idempotent_call("b", ttl_seconds=10, func=work)
    assert a != b
    assert counter["n"] == 2
