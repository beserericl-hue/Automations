"""Internal routes — Workbench Express server + n8n hub call here with X-Service-Secret."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from writer_engine.auth import require_service_secret
from writer_engine.config import get_settings

router = APIRouter(dependencies=[Depends(require_service_secret)])


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
