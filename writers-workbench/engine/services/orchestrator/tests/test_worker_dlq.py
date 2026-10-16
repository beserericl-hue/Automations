"""B5 — a terminal job failure leaves a record behind.

arq keeps a failed job's result for ``keep_result`` seconds and then forgets it entirely, so without
this a chapter that failed last night is indistinguishable from one never requested. The recording
deliberately happens inside the job rather than in arq's ``after_job_end`` hook: that hook's ctx has
no exception and no args (so it cannot tell failure from success), and arq's "max retries exceeded"
branch returns before the hook runs at all.
"""

from __future__ import annotations

from typing import Any

import pytest

from orchestrator import worker as worker_mod
from writer_engine.queues import (
    HEAVY,
    INTERACTIVE,
    KIND_CRASH,
    KIND_STEP_ERROR,
    QUEUE_HEAVY,
    QUEUE_INTERACTIVE,
)


@pytest.fixture
def recorded(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    async def _record(**kwargs: Any) -> None:
        entries.append(kwargs)

    monkeypatch.setattr(worker_mod, "record_dead_letter", _record)
    return entries


# --- worker settings --------------------------------------------------------------------------


def test_each_worker_carries_its_own_profile() -> None:
    for settings, profile in (
        (worker_mod.WorkerSettingsHeavy, HEAVY),
        (worker_mod.WorkerSettingsInteractive, INTERACTIVE),
    ):
        assert settings.queue_name == profile.name
        assert settings.job_timeout == profile.job_timeout
        assert settings.max_jobs == profile.max_jobs
        assert settings.max_tries == profile.max_tries
        assert settings.keep_result == profile.keep_result


def test_both_workers_run_the_same_functions() -> None:
    """A function registered on only one worker is a job that hangs forever on the other queue."""
    heavy = {f.__name__ for f in worker_mod.WorkerSettingsHeavy.functions}
    interactive = {f.__name__ for f in worker_mod.WorkerSettingsInteractive.functions}
    assert heavy == interactive == {"advance_newsletter_saga", "run_write_tool_job"}


def test_the_legacy_symbol_still_starts_a_worker() -> None:
    """`arq orchestrator.worker.WorkerSettings` must not break mid-deploy."""
    assert worker_mod.WorkerSettings is worker_mod.WorkerSettingsHeavy


@pytest.mark.asyncio
async def test_startup_puts_the_profile_in_the_job_ctx() -> None:
    """arq's job ctx carries no queue name, so a failing job could not otherwise name its queue."""
    ctx: dict[str, Any] = {}
    await worker_mod.WorkerSettingsInteractive.on_startup(ctx)
    assert ctx["queue_profile"] is INTERACTIVE


# --- recording --------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_crashed_write_job_is_recorded_and_still_raises(
    recorded: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(*_a: Any, **_k: Any) -> Any:
        raise TimeoutError("step did not answer")

    monkeypatch.setattr(worker_mod, "run_step_via_http", _boom)
    ctx = {"queue_profile": HEAVY, "job_id": "job-42"}
    body = {"op": "write", "chapter_number": 7, "project_id": "p1", "user_id": "u1"}

    with pytest.raises(TimeoutError):
        await worker_mod.run_write_tool_job(ctx, "chapter", body)

    assert len(recorded) == 1
    entry = recorded[0]
    assert entry["queue"] == QUEUE_HEAVY
    assert entry["function"] == "run_write_tool_job"
    assert entry["job_id"] == "job-42"
    assert "TimeoutError" in entry["error"]
    # Enough to answer "which chapter of whose project?" without the original request.
    assert entry["args"]["chapter_number"] == 7
    assert entry["args"]["op"] == "write"
    assert entry["args"]["project_id"] == "p1"
    assert entry["args"]["user_id"] == "u1"


@pytest.mark.asyncio
async def test_an_interactive_failure_names_the_interactive_queue(
    recorded: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("nope")

    monkeypatch.setattr(worker_mod, "run_step_via_http", _boom)
    with pytest.raises(RuntimeError):
        await worker_mod.run_write_tool_job(
            {"queue_profile": INTERACTIVE, "job_id": "j"}, "chapter", {"op": "qa"}
        )
    assert recorded[0]["queue"] == QUEUE_INTERACTIVE


@pytest.mark.asyncio
async def test_a_successful_job_records_nothing(
    recorded: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Out:
        def model_dump(self, **_: Any) -> dict[str, Any]:
            return {"status": "ok", "payload": {"result": {}}}

    async def _ok(*_a: Any, **_k: Any) -> Any:
        return _Out()

    monkeypatch.setattr(worker_mod, "run_step_via_http", _ok)
    out = await worker_mod.run_write_tool_job(
        {"queue_profile": HEAVY, "job_id": "j"}, "chapter", {"op": "write"}
    )
    assert out["status"] == "ok"
    assert recorded == []


@pytest.mark.asyncio
async def test_an_unknown_tool_is_not_a_dead_letter(recorded: list[dict[str, Any]]) -> None:
    """A bad tool name is a caller error returned to the caller, not a lost job."""
    out = await worker_mod.run_write_tool_job({"queue_profile": HEAVY}, "not-a-tool", {})
    assert out["error"]["code"] == "UNKNOWN_TOOL"
    assert recorded == []


@pytest.mark.asyncio
async def test_a_crashed_saga_advance_is_recorded(
    recorded: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    from uuid import uuid4

    execution_id = str(uuid4())

    class _Driver:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            pass

        async def advance(self, _eid: Any) -> Any:
            raise ValueError("saga state unreadable")

    monkeypatch.setattr(worker_mod, "NewsletterSagaDriver", _Driver)
    monkeypatch.setattr(worker_mod, "RedisSagaRepo", lambda *a, **k: None)

    with pytest.raises(ValueError):
        await worker_mod.advance_newsletter_saga({"queue_profile": HEAVY}, execution_id)

    assert recorded[0]["function"] == "advance_newsletter_saga"
    assert recorded[0]["args"] == {"execution_id": execution_id}


@pytest.mark.asyncio
async def test_recording_works_even_without_a_profile_in_ctx(
    recorded: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A job run outside a configured worker (a test, a one-off) must still record, not crash."""

    async def _boom(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("x")

    monkeypatch.setattr(worker_mod, "run_step_via_http", _boom)
    with pytest.raises(RuntimeError):
        await worker_mod.run_write_tool_job({}, "chapter", {"op": "write"})
    assert recorded[0]["queue"] == ""


# --- a step that returns an error is also a lost chapter --------------------------------------


@pytest.mark.asyncio
async def test_a_returned_step_error_is_recorded_with_its_own_kind(
    recorded: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Found by probing DEV: two chapter ops failed, and the DLQ was empty.

    The step returned StepOutput(status=error) rather than raising, so the job "succeeded" and the
    only record was an arq result that expires after keep_result. The user's chapter still did not
    get made.
    """

    class _ErrOut:
        def model_dump(self, **_: Any) -> dict[str, Any]:
            return {
                "status": "error",
                "error": {"code": "TypeError", "message": "unexpected keyword argument"},
                "payload": {},
            }

    async def _returns_error(*_a: Any, **_k: Any) -> Any:
        return _ErrOut()

    monkeypatch.setattr(worker_mod, "run_step_via_http", _returns_error)
    out = await worker_mod.run_write_tool_job(
        {"queue_profile": HEAVY, "job_id": "job-7"}, "chapter", {"op": "qa", "chapter_number": 3}
    )
    assert out["status"] == "error"  # still returned to the caller, unchanged

    assert len(recorded) == 1
    entry = recorded[0]
    assert entry["kind"] == KIND_STEP_ERROR
    assert "TypeError" in entry["error"]
    assert entry["args"]["chapter_number"] == 3


@pytest.mark.asyncio
async def test_a_crash_and_a_step_error_are_distinguishable(
    recorded: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """An operator triaging the DLQ needs to know which half of the system failed."""

    async def _boom(*_a: Any, **_k: Any) -> Any:
        raise TimeoutError("x")

    monkeypatch.setattr(worker_mod, "run_step_via_http", _boom)
    with pytest.raises(TimeoutError):
        await worker_mod.run_write_tool_job({"queue_profile": HEAVY}, "chapter", {"op": "write"})
    assert recorded[0]["kind"] == KIND_CRASH


@pytest.mark.asyncio
async def test_a_successful_step_records_nothing_either_way(
    recorded: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Ok:
        def model_dump(self, **_: Any) -> dict[str, Any]:
            return {"status": "ok", "payload": {"result": {}}}

    async def _ok(*_a: Any, **_k: Any) -> Any:
        return _Ok()

    monkeypatch.setattr(worker_mod, "run_step_via_http", _ok)
    await worker_mod.run_write_tool_job({"queue_profile": HEAVY}, "chapter", {"op": "write"})
    assert recorded == []
