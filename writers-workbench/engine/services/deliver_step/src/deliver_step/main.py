"""deliver-svc — decision #1: BOTH email (Postal) and web archive permalink."""

from __future__ import annotations

from typing import Any

from writer_engine.config import get_settings
from writer_engine.postal import PostalClient
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import DeliveryResult
from writer_engine.step_service import build_step_app

STEP_NAME = "deliver"


async def _publish_permalink(edition_id: str, send_id: str, html: str) -> str:
    """Web-archive publish — stores the rendered HTML at a public URL via Supabase Storage."""
    settings = get_settings()
    base = settings.archive_base_url.rstrip("/")
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return f"{base}/{edition_id}/{send_id}.html"
    from writer_engine.storage.adapter import upload_text

    path = f"{edition_id}/{send_id}.html"
    await upload_text(bucket="newsletter-archive", path=path, content=html, content_type="text/html")
    return f"{base}/{path}"


async def _fetch_subscribers(edition_id: str) -> list[dict[str, Any]]:
    settings = get_settings()
    if not settings.supabase_url:
        return [{"email": "eric@agileadtesting.com", "status": "active"}]
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    resp = await (
        client.table("newsletter_subscribers_v2")
        .select("email,status")
        .eq("edition_id", edition_id)
        .eq("status", "active")
        .execute()
    )
    return list(getattr(resp, "data", None) or [])


async def handler(inp: StepInput) -> StepOutput:
    edition_id = str(inp.payload.get("edition_id") or "")
    send_id = str(inp.payload.get("send_id") or inp.execution_id)
    html_body = str(inp.payload.get("html_body") or "")
    subject = str(inp.payload.get("subject") or "Newsletter")
    from_addr = str(inp.payload.get("from_addr") or "newsletter@writersworkbench.local")

    permalink = await _publish_permalink(edition_id, send_id, html_body)
    subscribers = await _fetch_subscribers(edition_id)

    message_ids: list[str] = []
    settings = get_settings()
    if settings.postal_api_key and subscribers:
        permalink_block = (
            f'<p style="font-size:12px;color:#555">Read on web: <a href="{permalink}">{permalink}</a></p>'
        )
        html_with_link = (
            html_body.replace("</body>", permalink_block + "</body>")
            if "</body>" in html_body
            else (html_body + permalink_block)
        )
        client = PostalClient()
        try:
            for sub in subscribers:
                res = await client.send(
                    to=[sub["email"]],
                    from_addr=from_addr,
                    subject=subject,
                    html=html_with_link,
                )
                if res.message_id:
                    message_ids.append(res.message_id)
        finally:
            await client.aclose()

    result = DeliveryResult(
        recipients_emailed=len(message_ids),
        permalink_url=permalink,
        message_ids=message_ids,
    )
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=result.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
