"""arq settings builder so any service can spin up a worker with the engine queue."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from arq.connections import RedisSettings

from writer_engine.config import get_settings


def build_redis_settings() -> RedisSettings:
    """Convert REDIS_URL into arq's typed settings object."""
    return RedisSettings.from_dsn(get_settings().redis_url)


def build_arq_settings(
    functions: Sequence[Callable[..., Any]],
    *,
    queue_name: str = "engine",
    max_jobs: int = 16,
    on_startup: Callable[[Any], Any] | None = None,
    on_shutdown: Callable[[Any], Any] | None = None,
) -> type:
    """Return a class arq's Worker accepts. Use ``WorkerSettings = build_arq_settings([...])`` in a module."""

    class WorkerSettings:
        pass

    WorkerSettings.redis_settings = build_redis_settings()  # type: ignore[attr-defined]
    WorkerSettings.functions = list(functions)  # type: ignore[attr-defined]
    WorkerSettings.queue_name = queue_name  # type: ignore[attr-defined]
    WorkerSettings.max_jobs = max_jobs  # type: ignore[attr-defined]
    if on_startup is not None:
        WorkerSettings.on_startup = staticmethod(on_startup)  # type: ignore[attr-defined]
    if on_shutdown is not None:
        WorkerSettings.on_shutdown = staticmethod(on_shutdown)  # type: ignore[attr-defined]
    return WorkerSettings
