"""A4 — every step records token usage, not just chapter_step.

CR-007 wired begin()/flush() into chapter_step only, so brainstorm, research, media and all ten
newsletter steps recorded nothing: CostDashboard under-reported and the credit model
(tokens-per-credit) had no basis. Accounting now lives in the step template, so it covers all 19
steps and any added later.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app
from writer_engine.telemetry import token_accounting

SECRET = "test-secret"


def _client(handler: Any, name: str = "demo") -> TestClient:
    return TestClient(build_step_app(name, handler))


def _post(client: TestClient, name: str = "demo", payload: dict | None = None):  # type: ignore[no-untyped-def]
    return client.post(
        "/run",
        headers={"x-service-secret": SECRET},
        json={
            "execution_id": str(uuid.uuid4()),
            "step_name": name,
            "payload": payload if payload is not None else {},
        },
    )


def test_template_opens_an_accounting_context_for_every_step() -> None:
    """The handler must see a live context — that is what router.complete records into."""
    seen: dict[str, Any] = {}

    async def handler(inp: StepInput) -> StepOutput:
        token_accounting.record(
            provider="anthropic", model="claude-sonnet-4-6", input_tokens=100, output_tokens=50
        )
        seen["snapshot"] = token_accounting.snapshot()
        return StepOutput(execution_id=inp.execution_id, step_name=inp.step_name, payload={})

    assert _post(_client(handler)).status_code == 200
    assert seen["snapshot"]["calls"] == 1
    assert seen["snapshot"]["input_tokens"] == 100
    assert seen["snapshot"]["cost_usd"] > 0


def test_usage_is_attached_where_the_completion_email_reads_it() -> None:
    """task_email reads result["token_usage"], so usage lands in payload["result"]."""

    async def handler(inp: StepInput) -> StepOutput:
        token_accounting.record(
            provider="anthropic", model="claude-sonnet-4-6", input_tokens=10, output_tokens=5
        )
        return StepOutput(
            execution_id=inp.execution_id, step_name=inp.step_name, payload={"result": {"ok": True}}
        )

    body = _post(_client(handler)).json()
    usage = body["payload"]["result"]["token_usage"]
    assert usage["calls"] == 1
    assert usage["total_tokens"] == 15


def test_usage_falls_back_to_the_payload_root_when_there_is_no_result() -> None:
    async def handler(inp: StepInput) -> StepOutput:
        token_accounting.record(
            provider="anthropic", model="claude-sonnet-4-6", input_tokens=10, output_tokens=5
        )
        return StepOutput(execution_id=inp.execution_id, step_name=inp.step_name, payload={})

    body = _post(_client(handler)).json()
    assert body["payload"]["token_usage"]["calls"] == 1


def test_no_usage_key_when_no_llm_calls_were_made() -> None:
    """CRUD-only steps must not grow a noisy empty token_usage block."""

    async def handler(inp: StepInput) -> StepOutput:
        return StepOutput(
            execution_id=inp.execution_id, step_name=inp.step_name, payload={"result": {"items": []}}
        )

    body = _post(_client(handler)).json()
    assert "token_usage" not in body["payload"]["result"]
    assert "token_usage" not in body["payload"]


def test_usage_is_flushed_even_when_the_step_fails() -> None:
    """A step that burned tokens then failed still cost money; dropping the record is how the
    recorded cost silently diverges from the Anthropic bill."""
    flushed: list[dict[str, Any]] = []
    real_flush = token_accounting.flush

    async def spy() -> dict[str, Any]:
        snap = await real_flush()
        flushed.append(snap)
        return snap

    async def handler(inp: StepInput) -> StepOutput:
        token_accounting.record(
            provider="anthropic", model="claude-sonnet-4-6", input_tokens=900, output_tokens=400
        )
        raise RuntimeError("provider exploded mid-op")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(token_accounting, "flush", spy)
        body = _post(_client(handler)).json()

    assert body["status"] == StepStatus.ERROR.value
    assert flushed and flushed[0]["calls"] == 1, "usage from a failed step must still be flushed"
    assert flushed[0]["input_tokens"] == 900


def test_workflow_label_identifies_the_step_and_op() -> None:
    """token_usage_v2.workflow is how cost is attributed per tool, so the label must be specific."""
    seen: dict[str, Any] = {}

    async def handler(inp: StepInput) -> StepOutput:
        token_accounting.record(
            provider="anthropic", model="claude-sonnet-4-6", input_tokens=1, output_tokens=1
        )
        seen["ctx"] = token_accounting.snapshot()
        seen["workflow"] = token_accounting._ctx.get()["workflow"]
        return StepOutput(execution_id=inp.execution_id, step_name=inp.step_name, payload={})

    _post(_client(handler, "media"), "media", {"op": "cover-art"})
    assert seen["workflow"] == "media.cover-art"


def test_workflow_label_without_an_op() -> None:
    seen: dict[str, Any] = {}

    async def handler(inp: StepInput) -> StepOutput:
        token_accounting.record(
            provider="anthropic", model="claude-sonnet-4-6", input_tokens=1, output_tokens=1
        )
        seen["workflow"] = token_accounting._ctx.get()["workflow"]
        return StepOutput(execution_id=inp.execution_id, step_name=inp.step_name, payload={})

    _post(_client(handler, "render"), "render", {})
    assert seen["workflow"] == "render"


def test_chapter_step_no_longer_double_accounts() -> None:
    """chapter_step's own begin()/flush() is gone — a second begin() would reset the template's
    context mid-request and lose every call recorded before it."""
    from pathlib import Path

    src = Path("services/chapter_step/src/chapter_step/main.py").read_text()
    assert "token_accounting.begin(" not in src
    assert "token_accounting.flush(" not in src
