"""State machine — start, advance, fail, durable state."""

from __future__ import annotations

import pytest

from writer_engine.schemas import Stage, StepStatus
from writer_engine.state_machine.orchestrator import InMemoryStateStore, OrchestratorBase


class _Orch(OrchestratorBase):
    pipeline_name = "test"


@pytest.mark.asyncio
async def test_start_creates_execution_and_emits_init(_no_progress_publish: list[dict]) -> None:
    orch = _Orch(InMemoryStateStore())
    eid = await orch.start(initial_state={"a": 1})
    state = await orch.state(eid)
    assert state.pipeline == "test"
    assert state.state == {"a": 1}
    assert any(ev.get("stage") == Stage.INIT.value for ev in _no_progress_publish)


@pytest.mark.asyncio
async def test_advance_merges_state(_no_progress_publish: list[dict]) -> None:
    orch = _Orch(InMemoryStateStore())
    eid = await orch.start(initial_state={"a": 1})
    await orch.advance(eid, Stage.GATHERING, patch={"b": 2})
    state = await orch.state(eid)
    assert state.stage is Stage.GATHERING
    assert state.state == {"a": 1, "b": 2}


@pytest.mark.asyncio
async def test_fail_sets_error(_no_progress_publish: list[dict]) -> None:
    orch = _Orch(InMemoryStateStore())
    eid = await orch.start()
    await orch.fail(eid, code="X", message="boom")
    state = await orch.state(eid)
    assert state.status is StepStatus.ERROR
    assert state.error and state.error.code == "X"
