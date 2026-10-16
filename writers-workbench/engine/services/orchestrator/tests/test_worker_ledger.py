"""B6 wired into the job: an async write tool persists its work at most once.

The unit the ledger protects is the JOB, not the step. A chapter write that finished and was then
re-queued by a worker restart must not run its persist path again — and, just as importantly, must
not burn the LLM spend again.
"""

from __future__ import annotations

from typing import Any

import pytest

from orchestrator import worker as worker_mod
from writer_engine.idempotency import claim_run, complete_run
from writer_engine.idempotency.run_ledger import TABLE


class _Out:
    def __init__(self, payload: dict[str, Any] | None = None, status: str = "ok") -> None:
        self._dump = {"status": status, "payload": payload or {"result": {"content_id": "c1"}}}

    def model_dump(self, **_: Any) -> dict[str, Any]:
        return self._dump


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, fake_supabase: Any) -> dict[str, Any]:
    """Point the worker at the in-memory ledger and count step invocations."""
    calls: list[dict[str, Any]] = []
    state: dict[str, Any] = {"db": fake_supabase, "calls": calls, "out": _Out(), "raise": None}

    async def _ledger() -> Any:
        return fake_supabase

    async def _step(ref: Any, **kwargs: Any) -> Any:
        calls.append({"name": getattr(ref, "name", None), "payload": kwargs.get("payload")})
        if state["raise"] is not None:
            raise state["raise"]
        return state["out"]

    monkeypatch.setattr(worker_mod, "_ledger", _ledger)
    monkeypatch.setattr(worker_mod, "run_step_via_http", _step)
    # Keep the success-path email out of it.
    monkeypatch.setenv("POSTAL_API_KEY", "")
    return state


async def _run(job_id: str = "job-1", **body: Any) -> dict[str, Any]:
    return await worker_mod.run_write_tool_job({"job_id": job_id}, "chapter", {"op": "write", **body})


# --- the claim --------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_first_run_claims_the_ledger_and_completes_it(wired: dict[str, Any]) -> None:
    out = await _run()
    assert out["status"] == "ok"
    assert len(wired["calls"]) == 1

    row = wired["db"].tables[TABLE][0]
    assert row["run_id"] == "job-1"
    assert row["status"] == "complete"
    assert row["tool"] == "chapter" and row["op"] == "write"
    assert row["result"] == out  # small enough to replay verbatim


@pytest.mark.asyncio
async def test_a_retry_of_a_finished_job_does_not_run_the_step_again(wired: dict[str, Any]) -> None:
    """The whole point: arq re-queues on CancelledError, and the work must not be redone."""
    first = await _run()
    second = await _run()
    assert len(wired["calls"]) == 1, "the step ran twice — the persist paths would duplicate"
    assert second == first
    assert wired["db"].count(TABLE) == 1


@pytest.mark.asyncio
async def test_a_different_job_id_runs_again(wired: dict[str, Any]) -> None:
    """Two deliberate requests are two runs; only a retry shares a job id."""
    await _run(job_id="job-1")
    await _run(job_id="job-2")
    assert len(wired["calls"]) == 2


@pytest.mark.asyncio
async def test_a_caller_supplied_run_id_wins_over_the_job_id(wired: dict[str, Any]) -> None:
    """Lets the Workbench make a user-level submission idempotent across retried POSTs."""
    await _run(job_id="job-1", run_id="user-key-7")
    await _run(job_id="job-2", run_id="user-key-7")
    assert len(wired["calls"]) == 1
    assert [r["run_id"] for r in wired["db"].tables[TABLE]] == ["user-key-7"]


@pytest.mark.asyncio
async def test_the_claim_records_who_and_what(wired: dict[str, Any]) -> None:
    await worker_mod.run_write_tool_job(
        {"job_id": "job-1", "queue_profile": None},
        "chapter",
        {"op": "write", "chapter_number": 12, "project_id": "p9", "user_id": "u3"},
    )
    row = wired["db"].tables[TABLE][0]
    assert row["chapter_number"] == 12
    assert row["project_id"] == "p9"
    assert row["user_id"] == "u3"


# --- failures release the claim ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_crash_releases_the_claim_so_a_retry_can_run(wired: dict[str, Any]) -> None:
    wired["raise"] = TimeoutError("step died")
    with pytest.raises(TimeoutError):
        await _run()
    assert wired["db"].tables[TABLE][0]["status"] == "error"

    wired["raise"] = None
    out = await _run()
    assert out["status"] == "ok"
    assert len(wired["calls"]) == 2, "a crashed run must not be permanently un-rerunnable"


@pytest.mark.asyncio
async def test_a_step_error_is_not_replayed_as_a_success(wired: dict[str, Any]) -> None:
    """A step that returns status=error is a real outcome, but a retry should get another chance."""
    wired["out"] = _Out(status="error", payload={"result": {}})
    out = await _run()
    assert out["status"] == "error"
    assert wired["db"].tables[TABLE][0]["status"] == "error"

    wired["out"] = _Out()
    assert (await _run())["status"] == "ok"
    assert len(wired["calls"]) == 2


# --- fail-open --------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_job_runs_when_the_ledger_is_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bookkeeping outage must not stop a user's chapter from being written."""
    calls: list[int] = []

    async def _no_ledger() -> Any:
        return None

    async def _step(_ref: Any, **_k: Any) -> Any:
        calls.append(1)
        return _Out()

    monkeypatch.setattr(worker_mod, "_ledger", _no_ledger)
    monkeypatch.setattr(worker_mod, "run_step_via_http", _step)
    out = await _run()
    assert out["status"] == "ok"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_an_unknown_tool_claims_nothing(wired: dict[str, Any]) -> None:
    """The claim must not outlive a request that never reached a step."""
    out = await worker_mod.run_write_tool_job({"job_id": "job-1"}, "not-a-tool", {"op": "x"})
    assert out["error"]["code"] == "UNKNOWN_TOOL"
    assert wired["db"].count(TABLE) == 0


# --- the replay envelope ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_replay_with_no_stored_result_is_labelled_as_one(
    wired: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A chapter's prose is too big to keep in the ledger, so the replay says what it is.

    The Workbench polls a job only for `status` and then refetches from the database
    (client/src/hooks/useEngineJobQueue.ts), so this envelope does not change what a user sees.
    """
    db = wired["db"]
    await claim_run(db, run_id="job-1", tool="chapter", op="write")
    # Simulate the large-output case: complete, but nothing recorded to replay.
    await complete_run(db, run_id="job-1", result=None)

    out = await _run()
    assert out["status"] == "ok"
    assert out["payload"]["result"]["idempotent_replay"] is True
    assert out["payload"]["result"]["run_id"] == "job-1"
    assert wired["calls"] == []
