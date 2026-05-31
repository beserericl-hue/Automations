"""L0 contract — schemas round-trip."""

from __future__ import annotations

from uuid import uuid4

from writer_engine.schemas import (
    ExecutionState,
    Progress,
    Stage,
    StepError,
    StepInput,
    StepOutput,
    StepStatus,
)


def test_step_input_roundtrip() -> None:
    eid = uuid4()
    inp = StepInput(execution_id=eid, step_name="pick", payload={"k": 1})
    js = inp.model_dump_json()
    rt = StepInput.model_validate_json(js)
    assert rt.execution_id == eid
    assert rt.payload == {"k": 1}


def test_step_output_error_envelope() -> None:
    out = StepOutput(
        execution_id=uuid4(),
        step_name="pick",
        status=StepStatus.ERROR,
        error=StepError(code="X", message="bad"),
    )
    assert out.status is StepStatus.ERROR
    assert out.error and out.error.code == "X"


def test_progress_event_shape() -> None:
    e = Progress(execution_id=uuid4(), stage=Stage.GATHERING, ts_ms=123)
    js = e.model_dump_json()
    rt = Progress.model_validate_json(js)
    assert rt.stage is Stage.GATHERING


def test_execution_state_defaults() -> None:
    s = ExecutionState(execution_id=uuid4(), pipeline="library_retrieve")
    assert s.stage is Stage.INIT
    assert s.revision_count == 0
