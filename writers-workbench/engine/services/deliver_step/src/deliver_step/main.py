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


def _is_uuid(value: str) -> bool:
    from uuid import UUID

    try:
        UUID(value)
        return True
    except (ValueError, AttributeError):
        return False


async def _mark_sent(send_id: str, recipient_count: int, provider_message_id: str | None) -> None:
    """Write the send-row lifecycle columns after delivery: status→sent, sent_at, counts, msg id.

    Best-effort and only when ``send_id`` is the real ``newsletter_sends_v2`` UUID (persist ran with
    Supabase). Without this the row would linger at status='draft' even though the edition shipped.
    """
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key or not _is_uuid(send_id):
        return
    from datetime import UTC, datetime

    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    patch: dict[str, Any] = {
        "status": "sent",
        "sent_at": datetime.now(UTC).isoformat(),
        "recipient_count": recipient_count,
    }
    if provider_message_id:
        patch["provider_message_id"] = provider_message_id
    await client.table("newsletter_sends_v2").update(patch).eq("id", send_id).execute()


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
    settings = get_settings()
    edition_id = str(inp.payload.get("edition_id") or "")
    send_id = str(inp.payload.get("send_id") or inp.execution_id)
    html_body = str(inp.payload.get("html_body") or "")
    subject = str(inp.payload.get("subject") or "Newsletter")
    # Postal authenticates the From domain — the default must be an authorised courseworx.media
    # sender, not a placeholder .local address (which Postal rejects as UnauthenticatedFromAddress).
    from_addr = str(inp.payload.get("from_addr") or settings.newsletter_from_address)

    # Prefer the caller-supplied permalink (the Workbench view route, which serves html_body as
    # text/html so it renders in a browser). Only archive to Supabase Storage when no permalink was
    # supplied — that storage URL can't render (Supabase serves user HTML as text/plain) but keeps a
    # raw archive for older callers.
    permalink = str(inp.payload.get("permalink_url") or "")
    if not permalink:
        permalink = await _publish_permalink(edition_id, send_id, html_body)
    subscribers = await _fetch_subscribers(edition_id)

    message_ids: list[str] = []
    if settings.postal_api_key and subscribers:
        permalink_block = (
            f'<p style="font-size:12px;color:#555">Read on web: <a href="{permalink}">{permalink}</a></p>'
        )
        html_with_link = (
            html_body.replace("</body>", permalink_block + "</body>")
            if "</body>" in html_body
            else (html_body + permalink_block)
        )
        errors: list[str] = []
        client = PostalClient()
        try:
            for sub in subscribers:
                # Resilient per-recipient: one bad address shouldn't drop the whole edition.
                try:
                    res = await client.send(
                        to=[sub["email"]],
                        from_addr=from_addr,
                        subject=subject,
                        html=html_with_link,
                    )
                    if res.message_id:
                        message_ids.append(res.message_id)
                except Exception as exc:  # collect + decide after the loop
                    errors.append(f"{sub.get('email')}: {exc}")
        finally:
            await client.aclose()
        # A total failure (every send errored) is a real delivery failure — fail the step so the
        # saga surfaces it rather than reaching SENT having mailed no one.
        if not message_ids and errors:
            raise RuntimeError(f"all {len(errors)} Postal send(s) failed: {errors[:3]}")

    # Advance the send row's lifecycle to 'sent' now that the edition has actually shipped.
    await _mark_sent(send_id, len(message_ids), message_ids[0] if message_ids else None)

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
