"""Base class for orchestrators.

An ``OrchestratorBase`` owns: the durable state machine (Supabase row), step invocation, HITL gates, and SSE
progress. It is intentionally I/O-light — subclasses encode the pipeline as a sequence of steps.

The state store interface is split out so tests can use an in-memory fake.
"""

from __future__ import annotations

import time
from typing import Any, Protocol
from uuid import UUID, uuid4

from writer_engine.schemas.step_contract import ExecutionState, Stage, StepError, StepStatus
from writer_engine.state_machine.progress import emit_progress


class StateStore(Protocol):
    async def create(self, *, execution_id: UUID, pipeline: str, state: dict[str, Any]) -> ExecutionState: ...
    async def load(self, execution_id: UUID) -> ExecutionState: ...
    async def save(self, state: ExecutionState) -> None: ...


class InMemoryStateStore:
    """Reference implementation used by tests + the docker-compose demo (no Supabase needed)."""

    def __init__(self) -> None:
        self._rows: dict[UUID, ExecutionState] = {}

    async def create(self, *, execution_id: UUID, pipeline: str, state: dict[str, Any]) -> ExecutionState:
        now = int(time.time() * 1000)
        row = ExecutionState(
            execution_id=execution_id,
            pipeline=pipeline,
            state=state,
            created_at_ms=now,
            updated_at_ms=now,
        )
        self._rows[execution_id] = row
        return row

    async def load(self, execution_id: UUID) -> ExecutionState:
        if execution_id not in self._rows:
            raise KeyError(f"unknown execution: {execution_id}")
        return self._rows[execution_id]

    async def save(self, state: ExecutionState) -> None:
        state = state.model_copy(update={"updated_at_ms": int(time.time() * 1000)})
        self._rows[state.execution_id] = state


class OrchestratorBase:
    """Subclass and override :meth:`run` to express a pipeline."""

    pipeline_name: str = "unnamed"

    def __init__(self, store: StateStore) -> None:
        self._store = store

    async def start(
        self, *, initial_state: dict[str, Any] | None = None, execution_id: UUID | None = None
    ) -> UUID:
        eid = execution_id or uuid4()
        await self._store.create(execution_id=eid, pipeline=self.pipeline_name, state=initial_state or {})
        await emit_progress(eid, Stage.INIT, message=f"{self.pipeline_name} started")
        return eid

    async def state(self, execution_id: UUID) -> ExecutionState:
        return await self._store.load(execution_id)

    async def advance(
        self,
        execution_id: UUID,
        stage: Stage,
        *,
        message: str | None = None,
        patch: dict[str, Any] | None = None,
    ) -> None:
        state = await self._store.load(execution_id)
        merged = {**state.state, **(patch or {})}
        new_state = state.model_copy(update={"stage": stage, "state": merged})
        await self._store.save(new_state)
        await emit_progress(execution_id, stage, message=message)

    async def fail(self, execution_id: UUID, *, code: str, message: str) -> None:
        state = await self._store.load(execution_id)
        new_state = state.model_copy(
            update={
                "stage": Stage.ERROR,
                "status": StepStatus.ERROR,
                "error": StepError(code=code, message=message),
            }
        )
        await self._store.save(new_state)
        await emit_progress(execution_id, Stage.ERROR, message=message)

    async def run(self, execution_id: UUID) -> None:  # pragma: no cover — overridden
        raise NotImplementedError
