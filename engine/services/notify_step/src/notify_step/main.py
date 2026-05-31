"""notify-step — eve-callback / eve-reset-greeting / email."""

from __future__ import annotations

from writer_engine.postal import send_email
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "notify"


async def _op_email(payload: dict) -> dict:
    to = list(payload.get("to") or [])
    if not to:
        return {"sent": 0}
    res = await send_email(
        to=to,
        from_addr=str(payload.get("from_addr") or "engine@writersworkbench.local"),
        subject=str(payload.get("subject") or "Notification"),
        html=str(payload.get("html") or ""),
    )
    return {"sent": len(to), "message_id": res.message_id}


async def _op_eve_callback(payload: dict) -> dict:
    """Web-vs-phone routing happens in Sprint 19 / S22-5. F1 placeholder echoes the decision."""
    has_web_session = bool(payload.get("has_web_session"))
    return {"routed_via": "sse" if has_web_session else "phone"}


async def _op_eve_reset_greeting(payload: dict) -> dict:
    return {"agent_id": payload.get("agent_id"), "reset": True}


OPS = {"email": _op_email, "eve-callback": _op_eve_callback, "eve-reset-greeting": _op_eve_reset_greeting}


async def handler(inp: StepInput) -> StepOutput:
    op = str(inp.payload.get("op") or "email")
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
