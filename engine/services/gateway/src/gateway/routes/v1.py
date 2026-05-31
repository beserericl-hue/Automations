"""Public B2B routes — X-Api-Key gated, multi-tenant. F0 stub; real keys arrive in Sprint 23."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from writer_engine.auth import ApiKeyIdentity, require_api_key

router = APIRouter()


@router.get("/whoami")
async def whoami(identity: ApiKeyIdentity = Depends(require_api_key)) -> dict[str, Any]:
    return {"tenant_id": identity.tenant_id, "key_prefix": identity.key_prefix}
