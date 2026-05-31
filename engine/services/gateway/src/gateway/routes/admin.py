"""Admin routes — X-Admin-Token gated."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from writer_engine.auth import require_admin_token
from writer_engine.config import get_settings
from writer_engine.prompt_store import get_prompt_store

router = APIRouter(dependencies=[Depends(require_admin_token)])


@router.get("/info")
async def info() -> dict[str, Any]:
    settings = get_settings()
    return {
        "service": "gateway",
        "picker_model": settings.picker_model,
        "orchestrator_url": settings.orchestrator_url,
    }


@router.post("/reload-prompts")
async def reload_prompts() -> dict[str, int]:
    """Hot-reload prompt overrides from Supabase."""
    count = await get_prompt_store().reload_from_supabase()
    return {"loaded": count}
