"""Durable saga state repository.

The saga state is persisted to Redis (default) or an in-memory store (tests). When a worker advances a stage,
it writes the new state + enqueues the next ``advance`` job. When an approval gate is reached the worker stops
(no job held); the resolve endpoint enqueues a new ``advance`` to continue.

Two implementations:

- :class:`RedisSagaRepo` — production. Stores the full :class:`ExecutionState` as a JSON blob in a Redis hash
  keyed by ``saga:{pipeline}:{execution_id}``. Optionally mirrors ``status``/``stage`` to
  ``newsletter_sends_v2.metadata`` so the UI can poll without going through the engine.
- :class:`InMemorySagaRepo` — tests + the docker-compose demo when Redis isn't reachable.
"""

from __future__ import annotations

import time
from typing import Any, Protocol
from uuid import UUID

from writer_engine.redis_client import client as _redis_module
from writer_engine.schemas.step_contract import ExecutionState, Stage, StepError, StepStatus


def _now_ms() -> int:
    return int(time.time() * 1000)


class SagaStateRepo(Protocol):
    async def create(
        self, *, execution_id: UUID, pipeline: str, initial_state: dict[str, Any]
    ) -> ExecutionState: ...
    async def load(self, execution_id: UUID) -> ExecutionState: ...
    async def update(
        self,
        execution_id: UUID,
        *,
        stage: Stage | None = None,
        status: StepStatus | None = None,
        patch: dict[str, Any] | None = None,
        error: StepError | None = None,
        bump_revision: bool = False,
    ) -> ExecutionState: ...


class InMemorySagaRepo:
    """Reference implementation used by tests + the docker-compose demo."""

    def __init__(self) -> None:
        self._rows: dict[UUID, ExecutionState] = {}

    async def create(
        self, *, execution_id: UUID, pipeline: str, initial_state: dict[str, Any]
    ) -> ExecutionState:
        now = _now_ms()
        row = ExecutionState(
            execution_id=execution_id,
            pipeline=pipeline,
            state=dict(initial_state),
            created_at_ms=now,
            updated_at_ms=now,
        )
        self._rows[execution_id] = row
        return row

    async def load(self, execution_id: UUID) -> ExecutionState:
        if execution_id not in self._rows:
            raise KeyError(f"unknown execution: {execution_id}")
        return self._rows[execution_id]

    async def update(
        self,
        execution_id: UUID,
        *,
        stage: Stage | None = None,
        status: StepStatus | None = None,
        patch: dict[str, Any] | None = None,
        error: StepError | None = None,
        bump_revision: bool = False,
    ) -> ExecutionState:
        row = self._rows[execution_id]
        updates: dict[str, Any] = {"updated_at_ms": _now_ms()}
        if stage is not None:
            updates["stage"] = stage
        if status is not None:
            updates["status"] = status
        if error is not None:
            updates["error"] = error
        if bump_revision:
            updates["revision_count"] = row.revision_count + 1
        if patch:
            updates["state"] = {**row.state, **patch}
        new_row = row.model_copy(update=updates)
        self._rows[execution_id] = new_row
        return new_row


def _key(execution_id: UUID, pipeline: str = "newsletter") -> str:
    return f"saga:{pipeline}:{execution_id}"


class RedisSagaRepo:
    """Persist the saga state as a JSON blob in Redis. The redis client is module-scoped (see
    :mod:`writer_engine.redis_client`)."""

    def __init__(self, *, pipeline: str = "newsletter") -> None:
        self._pipeline = pipeline

    async def create(
        self, *, execution_id: UUID, pipeline: str, initial_state: dict[str, Any]
    ) -> ExecutionState:
        now = _now_ms()
        row = ExecutionState(
            execution_id=execution_id,
            pipeline=pipeline,
            state=dict(initial_state),
            created_at_ms=now,
            updated_at_ms=now,
        )
        client = await _redis_module.get_redis()
        await client.set(_key(execution_id, pipeline), row.model_dump_json(), ex=30 * 24 * 60 * 60)
        return row

    async def load(self, execution_id: UUID) -> ExecutionState:
        client = await _redis_module.get_redis()
        raw = await client.get(_key(execution_id, self._pipeline))
        if raw is None:
            raise KeyError(f"unknown execution: {execution_id}")
        return ExecutionState.model_validate_json(raw)

    async def update(
        self,
        execution_id: UUID,
        *,
        stage: Stage | None = None,
        status: StepStatus | None = None,
        patch: dict[str, Any] | None = None,
        error: StepError | None = None,
        bump_revision: bool = False,
    ) -> ExecutionState:
        row = await self.load(execution_id)
        updates: dict[str, Any] = {"updated_at_ms": _now_ms()}
        if stage is not None:
            updates["stage"] = stage
        if status is not None:
            updates["status"] = status
        if error is not None:
            updates["error"] = error
        if bump_revision:
            updates["revision_count"] = row.revision_count + 1
        if patch:
            updates["state"] = {**row.state, **patch}
        new_row = row.model_copy(update=updates)
        client = await _redis_module.get_redis()
        await client.set(_key(execution_id, self._pipeline), new_row.model_dump_json(), ex=30 * 24 * 60 * 60)
        return new_row


def serialize_for_redis(state: ExecutionState) -> str:
    """Helper for ad-hoc inspection (e.g. /admin/saga-state/{id})."""
    return state.model_dump_json()


def deserialize_from_redis(raw: str) -> ExecutionState:
    return ExecutionState.model_validate_json(raw)


__all__ = [
    "InMemorySagaRepo",
    "RedisSagaRepo",
    "SagaStateRepo",
    "deserialize_from_redis",
    "serialize_for_redis",
]
