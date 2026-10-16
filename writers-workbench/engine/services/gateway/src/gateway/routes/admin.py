"""Admin routes — X-Admin-Token gated."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends

from writer_engine.auth import require_admin_token
from writer_engine.config import get_settings
from writer_engine.prompt_store import get_prompt_store
from writer_engine.telemetry.logging import get_logger

router = APIRouter(dependencies=[Depends(require_admin_token)])
logger = get_logger("gateway.admin")


@router.get("/info")
async def info() -> dict[str, Any]:
    settings = get_settings()
    return {
        "service": "gateway",
        "picker_model": settings.picker_model,
        "orchestrator_url": settings.orchestrator_url,
    }


@router.post("/reload-prompts")
async def reload_prompts() -> dict[str, Any]:
    """Hot-reload prompt overrides from Supabase, everywhere they are used (A5).

    ``PromptStore`` is a module global, so a reload only affects the process it runs in. This route
    used to reload the *gateway's* copy only — and the gateway generates no text, so prompt tuning,
    the main quality lever, had no production path at all.

    The gateway cannot reach the steps process directly (that binds to localhost inside the runtime
    container), so the fan-out is one hop: gateway → orchestrator → steps. Each service reloads its
    own store; ``loaded`` reports the count that reached the steps process, since that is the one
    that matters.
    """
    settings = get_settings()
    local = await get_prompt_store().reload_from_supabase()
    result: dict[str, Any] = {"gateway_loaded": local, "loaded": local}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{settings.orchestrator_url.rstrip('/')}/admin/reload-prompts",
                headers={"x-admin-token": settings.admin_token},
            )
            resp.raise_for_status()
            downstream = resp.json() or {}
    except Exception as exc:
        # The gateway's own reload succeeded, which is still worth reporting — but the caller must
        # know the generating code did NOT pick up the change.
        logger.warning("gateway.reload_prompts.fanout_failed", error=str(exc)[:200])
        result["fanout_error"] = f"{type(exc).__name__}: {str(exc)[:160]}"
        return result

    result["orchestrator_loaded"] = downstream.get("orchestrator_loaded")
    result["steps_loaded"] = downstream.get("steps_loaded")
    if "steps_error" in downstream:
        result["steps_error"] = downstream["steps_error"]
    if isinstance(downstream.get("steps_loaded"), int):
        result["loaded"] = downstream["steps_loaded"]
    return result
