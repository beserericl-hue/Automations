"""approval-step — issue / validate / resolve approval tokens (thin wrapper over writer_engine.state_machine.hitl)."""

from __future__ import annotations

from uuid import UUID

from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.state_machine.hitl import ApprovalDecision, create_approval, resolve_approval
from writer_engine.step_service import build_step_app

STEP_NAME = "approval"


async def _op_issue(payload: dict) -> dict:
    gate = await create_approval(
        execution_id=UUID(str(payload.get("execution_id"))),
        stage=str(payload.get("stage") or "generic"),
        payload=payload.get("payload") or {},
        ttl_seconds=int(payload.get("ttl_seconds") or 7 * 24 * 60 * 60),
    )
    return {"token": gate.token, "stage": gate.stage, "expires_at_ms": gate.expires_at_ms}


async def _op_resolve(payload: dict) -> dict:
    decision_str = str(payload.get("decision") or "approve")
    try:
        decision = ApprovalDecision(decision_str)
    except ValueError as exc:
        raise ValueError(f"unknown decision: {decision_str}") from exc
    gate = await resolve_approval(
        token=str(payload.get("token") or ""),
        decision=decision,
        feedback=payload.get("feedback"),
    )
    return {
        "token": gate.token,
        "decision": gate.decision.value if gate.decision else None,
        "resolved_at_ms": gate.resolved_at_ms,
    }


OPS = {"issue": _op_issue, "resolve": _op_resolve}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "issue")
    if op not in OPS:
        return StepOutput(
            execution_id=inp.execution_id,
            step_name=STEP_NAME,
            status=StepStatus.ERROR,
            error={"code": "UNKNOWN_OP", "message": op},  # type: ignore[arg-type]
        )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload={"op": op, "result": await OPS[op](inp.payload)},
    )


app = build_step_app(STEP_NAME, handler)
