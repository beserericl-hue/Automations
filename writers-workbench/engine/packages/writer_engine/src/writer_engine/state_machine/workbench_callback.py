"""Best-effort stage callback to the Writer's Workbench Express server (F2-8 SSE bridge).

n8n drives the in-app Execution Status SSE strip by POSTing each stage to the WW
``/api/callback/newsletter-stage`` endpoint (auth ``X-Callback-Secret``), which rebroadcasts a
``newsletter.stage`` event on the user's ``sse:{userId}`` channel. Engine-backed runs have no n8n,
so the orchestrator calls this helper as it advances — same endpoint, same SSE result, no UI change.

Always best-effort: a missing config or a failed POST never affects the saga (the gateway's own
Redis SSE relay remains the primary channel; this is the bridge to the existing per-user WW channel).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx

from writer_engine.config import get_settings

# Engine verbose stage → the WW NewsletterStageSchema enum (server/src/schemas.ts). The WW enum is
# coarser; map each engine stage to the closest valid value so the client progress strip advances.
_WW_STAGE: dict[str, str] = {
    "gathering": "gathering",
    "picking": "selecting_stories",
    "awaiting_stories_approval": "awaiting_stories_approval",
    "stories_approved": "stories_approved",
    "subject": "awaiting_subject_approval",
    "awaiting_subject_approval": "awaiting_subject_approval",
    "subject_approved": "subject_approved",
    "writing_segments": "writing_segment",
    "proposing_images": "writing_segment",
    "awaiting_image_approval": "writing_segment",
    "images_approved": "segments_done",
    "assembling": "segments_done",
    "rendering": "segments_done",
    "saved": "saved",
    "sending": "saved",
    "sent": "saved",
    "skipped_no_content": "saved",
    "error": "error",
}


def _ww_stage(stage: str) -> str | None:
    """Map an engine stage to the WW enum, or None if it has no UI representation."""
    return _WW_STAGE.get(stage)


async def notify_workbench_stage(
    execution_id: UUID | str,
    stage: str,
    *,
    cfg: dict[str, Any] | None,
    message: str | None = None,
) -> bool:
    """POST a stage update to the WW newsletter-stage callback. Returns True on a 2xx, else False.

    No-ops (returns False) when WORKBENCH_API_URL / NEWSLETTER_CALLBACK_SECRET are unset, when the
    cfg lacks user_id/edition_id, or when the stage has no WW-enum mapping. Never raises.
    """
    settings = get_settings()
    base = settings.workbench_api_url
    secret = settings.newsletter_callback_secret
    if not base or not secret:
        return False
    cfg = cfg or {}
    user_id = cfg.get("user_id")
    edition_id = cfg.get("edition_id")
    if not user_id or not edition_id:
        return False
    ww_stage = _ww_stage(stage)
    if ww_stage is None:
        return False

    body = {
        "userId": str(user_id),
        "executionId": str(execution_id),
        "editionId": str(edition_id),
        "stage": ww_stage,
        "detail": message or "",
        "ts": datetime.now(UTC).isoformat(),
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            resp = await client.post(
                f"{base.rstrip('/')}/api/callback/newsletter-stage",
                json=body,
                headers={"X-Callback-Secret": secret, "Content-Type": "application/json"},
            )
        return resp.status_code < 300
    except Exception:
        return False
