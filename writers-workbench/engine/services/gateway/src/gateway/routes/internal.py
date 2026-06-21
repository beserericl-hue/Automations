"""Internal routes — Workbench Express server + n8n hub call here with X-Service-Secret."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from writer_engine.auth import require_service_secret
from writer_engine.config import get_settings
from writer_engine.hub import (
    HubRequest,
    HubResponse,
    build_dispatch_plan,
    route_message,
    split_tasks,
)
from writer_engine.telemetry.logging import get_logger

router = APIRouter(dependencies=[Depends(require_service_secret)])
logger = get_logger("hub.gateway")


def _write_url(tool: str) -> str:
    return f"{get_settings().orchestrator_url}/pipelines/write/{tool}/run"


async def _execute_eve_callback(req: HubRequest, plan: Any) -> HubResponse:
    """V30: resolve the target content SYNCHRONOUSLY first; only queue the real callback when found, so
    a not-found request returns kind=data with NO job_id and NO outbound call / KB op."""
    url = _write_url("notify")
    resolve = await _forward("POST", url, json={**plan.body, "resolve_only": True, "async": False}, timeout_s=60.0)
    result = (resolve.get("payload") or {}).get("result") or {}
    if not result.get("found"):
        logger.info("hub.eve_callback.not_found", user_id=req.user_id)
        return HubResponse(
            kind="data", tool="notify", op="eve-callback", data=result,
            assistant_message=result.get("message") or "I couldn't find that to call you back about.",
        )
    body = {**plan.body}
    for k in ("content_type", "content_title", "content_text", "callback_mode", "phone"):
        if result.get(k):
            body[k] = result[k]
    enq = await _forward("POST", url, json={**body, "async": True}, timeout_s=30.0)
    logger.info("hub.eve_callback.queued", user_id=req.user_id, job_id=enq.get("job_id"))
    return HubResponse(
        kind="queued", tool="notify", op="eve-callback", assistant_message=plan.assistant_message,
        job_id=enq.get("job_id"), status=enq.get("status", "queued"),
    )


async def _execute_multi(req: HubRequest, clauses: list[str]) -> HubResponse:
    """V31: a message that fans out to several tasks. Route + enqueue each clause independently and
    return one queued response carrying every job (job_id mirrors the first for single-poll callers)."""
    jobs: list[dict[str, Any]] = []
    msgs: list[str] = []
    for clause in clauses:
        creq = HubRequest(message=clause, user_id=req.user_id, context=req.context, source=req.source)
        plan = build_dispatch_plan(await route_message(creq), creq)
        if plan.action == "reply":
            if plan.assistant_message:
                msgs.append(plan.assistant_message)
            continue
        url = _write_url(plan.tool)
        try:
            if plan.action == "call_sync":
                await _forward("POST", url, json=plan.body, timeout_s=120.0)
            else:
                enq = await _forward("POST", url, json={**plan.body, "async": True}, timeout_s=30.0)
                jobs.append({"tool": plan.tool, "op": plan.op,
                             "job_id": enq.get("job_id"), "status": enq.get("status", "queued")})
            if plan.assistant_message:
                msgs.append(plan.assistant_message)
        except HTTPException as exc:
            logger.error("hub.multi.failed", tool=plan.tool, op=plan.op, detail=str(exc.detail)[:200])
    logger.info("hub.multi", user_id=req.user_id, tasks=len(clauses), jobs=len(jobs))
    return HubResponse(
        kind="queued", assistant_message=" ".join(msgs) or "Working on those — I'll let you know.",
        job_id=(jobs[0]["job_id"] if jobs else None), jobs=jobs, status="queued",
    )


async def _execute_hub(req: HubRequest) -> HubResponse:
    """Route + dispatch one hub request. Shared by the chat (``/hub``) and voice (``/hub/voice``)
    surfaces so both go through the identical Gemini-router → sync/async-dispatch path."""
    logger.info("hub.request", source=req.source, user_id=req.user_id, msg_preview=req.message[:160])

    # V31: fan a multi-task message ("… and also …") out to one job per task.
    clauses = split_tasks(req.message)
    if len(clauses) > 1:
        return await _execute_multi(req, clauses)

    decision = await route_message(req)
    plan = build_dispatch_plan(decision, req)
    logger.info(
        "hub.dispatch", action=plan.action, tool=plan.tool, op=plan.op,
        params=list(plan.body.keys()), user_id=req.user_id,
    )

    if plan.action == "reply":
        return HubResponse(kind="reply", assistant_message=plan.assistant_message)

    # V30: eve-callback resolves content existence synchronously before it queues anything.
    if plan.tool == "notify" and plan.op == "eve-callback":
        try:
            return await _execute_eve_callback(req, plan)
        except HTTPException as exc:
            logger.error("hub.dispatch_failed", tool="notify", op="eve-callback",
                         status_code=exc.status_code, detail=str(exc.detail)[:300])
            raise

    url = _write_url(plan.tool)
    try:
        if plan.action == "call_sync":
            data = await _forward("POST", url, json=plan.body, timeout_s=120.0)
            logger.info("hub.sync_ok", tool=plan.tool, op=plan.op, user_id=req.user_id)
            return HubResponse(
                kind="data", assistant_message=plan.assistant_message,
                tool=plan.tool, op=plan.op, data=data,
            )

        # enqueue — heavy generation; orchestrator returns {job_id, status, tool}
        enq = await _forward("POST", url, json=plan.body, timeout_s=30.0)
        logger.info(
            "hub.enqueued", tool=plan.tool, op=plan.op, job_id=enq.get("job_id"),
            user_id=req.user_id, chapter=plan.body.get("chapter_number"),
            project=plan.body.get("project_id") or plan.body.get("project_title"),
        )
        return HubResponse(
            kind="queued", assistant_message=plan.assistant_message,
            tool=plan.tool, op=plan.op,
            job_id=enq.get("job_id"), status=enq.get("status", "queued"),
        )
    except HTTPException as exc:
        logger.error(
            "hub.dispatch_failed", action=plan.action, tool=plan.tool, op=plan.op,
            status_code=exc.status_code, detail=str(exc.detail)[:300], user_id=req.user_id,
        )
        raise


@router.post("/hub")
async def hub(body: dict[str, Any]) -> dict[str, Any]:
    """CR-004 Path B — the engine hub. The UI chat (via the Workbench server) and the Eve voice
    webhook POST a message here; a Gemini router picks the tool, info ops run synchronously and return
    data, load-bearing ops are queued (arq, CR-003) and return ``{job_id, status:"queued"}``.

    Accepts both the native ``{message,...}`` shape and the legacy n8n ``{user_message_request, user_id}``
    shape so the server can forward verbatim (zero front-end change at cutover)."""
    req = HubRequest(
        message=body.get("message") or body.get("user_message_request") or "",
        user_id=body.get("user_id"),
        conversation_id=body.get("conversation_id"),
        source=body.get("source") or "chat",
        context=body.get("context") or {},
    )
    return (await _execute_hub(req)).model_dump(mode="json")


@router.post("/hub/voice")
async def hub_voice(body: dict[str, Any]) -> dict[str, Any]:
    """Eve voice webhook (CR-004 Path B voice surface). The ElevenLabs agent's server-tool posts here.

    Differs from ``/hub`` only at the edges: it accepts the ElevenLabs caller fields
    (``system__caller_id`` / ``caller_id`` → ``user_id``; ``user_message_request`` → message) and
    returns a FLAT, voice-friendly shape — ``{response, job_id?, status?, tool?, op?}`` — where
    ``response`` is the single line Eve should speak. The agent holds the conversation turns itself,
    so this stays stateless per turn (``conversation_id`` is threaded through for correlation only)."""
    user_id = (
        body.get("user_id")
        or body.get("system__caller_id")
        or body.get("caller_id")
        or body.get("phone_number")
    )
    req = HubRequest(
        message=body.get("message") or body.get("user_message_request") or "",
        user_id=str(user_id) if user_id else None,
        conversation_id=body.get("conversation_id") or body.get("system__conversation_id"),
        source="voice",
        context=body.get("context") or {},
    )
    resp = await _execute_hub(req)
    # Flat shape ElevenLabs reads without nested-field config. For an info op with data, hand back a
    # short spoken line plus the data so the agent can summarise it aloud.
    spoken = resp.assistant_message or (
        "Here's what I found." if resp.kind == "data" else "Okay."
    )
    out: dict[str, Any] = {"response": spoken, "kind": resp.kind}
    if resp.tool:
        out["tool"] = resp.tool
        out["op"] = resp.op
    if resp.job_id:
        out["job_id"] = resp.job_id
        out["status"] = resp.status
    if resp.kind == "data" and resp.data is not None:
        out["data"] = resp.data
    return out


@router.post("/library/retrieve")
async def library_retrieve(body: dict[str, Any]) -> dict[str, Any]:
    """F0-8 vertical slice — forward to orchestrator's library.retrieve endpoint."""
    settings = get_settings()
    return await _forward("POST", f"{settings.orchestrator_url}/pipelines/library_retrieve/run", json=body)


@router.post("/newsletter/generate")
async def newsletter_generate(body: dict[str, Any]) -> dict[str, Any]:
    """Forward to the durable newsletter pipeline; the response carries execution_id immediately."""
    settings = get_settings()
    return await _forward("POST", f"{settings.orchestrator_url}/pipelines/newsletter/run-durable", json=body)


@router.post("/write/{tool}")
async def write_tool(tool: str, body: dict[str, Any]) -> dict[str, Any]:
    """F1-B: the n8n hub's ai_tool nodes call here (X-Service-Secret) to dispatch a write-workshop
    tool to the engine instead of executeWorkflow. Forwards to the orchestrator's write-tool route.

    Write tools are synchronous and LLM-heavy (a chapter draft + craft-revision loop can run minutes),
    so the forward timeout is generous — well above the default used for the fast newsletter calls."""
    settings = get_settings()
    return await _forward(
        "POST",
        f"{settings.orchestrator_url}/pipelines/write/{tool}/run",
        json=body,
        timeout_s=600.0,
    )


@router.get("/write/jobs/{job_id}")
async def write_job(job_id: str) -> dict[str, Any]:
    """Poll an async write-tool job (returns {status, result?})."""
    settings = get_settings()
    return await _forward("GET", f"{settings.orchestrator_url}/pipelines/write/jobs/{job_id}")


@router.post("/write/jobs/{job_id}/abort")
async def write_job_abort(job_id: str) -> dict[str, Any]:
    """Cancel an async write-tool job (Fix Drift "Cancel" button) — returns {job_id, aborted}.

    A still-queued job is dropped before it runs; a running job is cancelled at its next await. Idempotent:
    a job that already finished returns aborted:false rather than erroring."""
    settings = get_settings()
    return await _forward("POST", f"{settings.orchestrator_url}/pipelines/write/jobs/{job_id}/abort")


@router.get("/newsletter/executions/{execution_id}/review/{stage}")
async def newsletter_review(execution_id: str, stage: str) -> dict[str, Any]:
    """UI calls here when the operator opens an approval gate — returns the review payload from saga state."""
    settings = get_settings()
    return await _forward(
        "GET",
        f"{settings.orchestrator_url}/pipelines/newsletter/executions/{execution_id}/review/{stage}",
    )


@router.post("/newsletter/approvals/{token}/resolve")
async def newsletter_resolve(token: str, body: dict[str, Any]) -> dict[str, Any]:
    """UI's resolve POST — gateway forwards to orchestrator which resumes the saga."""
    settings = get_settings()
    return await _forward("POST", f"{settings.orchestrator_url}/approvals/{token}/resolve", json=body)


@router.get("/newsletter/executions/{execution_id}/state")
async def newsletter_state(execution_id: str) -> dict[str, Any]:
    settings = get_settings()
    return await _forward(
        "GET",
        f"{settings.orchestrator_url}/pipelines/newsletter/saga-state/{execution_id}",
    )


async def _forward(
    method: str, url: str, *, json: dict[str, Any] | None = None, timeout_s: float = 30.0
) -> dict[str, Any]:
    settings = get_settings()
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        try:
            resp = await client.request(
                method,
                url,
                headers={
                    "x-service-secret": settings.service_shared_secret,
                    "content-type": "application/json",
                },
                json=json,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=f"orchestrator unreachable: {exc}"
            ) from exc
    if resp.status_code >= 300:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()
