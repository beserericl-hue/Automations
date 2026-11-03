"""The newsletter's final "Send to subscribers" gate, and the owner's test copy (Eric, 2026-11-03).

Until 2026-11-03 approving the image gate rendered the issue and mailed every active subscriber in
the same breath, so the first time anyone saw the finished email was in their inbox. The saga now
stops after it saves the rendered issue and opens a fourth gate, ``awaiting_send_approval``, whose
payload carries what the owner needs to decide: the saved send row, the subject, the issue number
and how many active subscribers it will reach. Nothing is delivered until that gate is approved;
declining it marks the send row ``cancelled`` and the saga ends at ``Stage.CANCELLED``.

While the gate is open the owner can mail themself a test copy: the same rendered HTML through the
same deliver step and Postal path, with ``[TEST]`` in the subject, addressed ONLY to the owner's own
``users_v2.email``. Each test copy is recorded in ``newsletter_owner_emails_v2`` (kind
``test_copy``, migration 052) with who, when and the Postal message id.

There is no auto-approval anywhere in the durable saga: a cadence (cron) run pauses at each of the
four gates exactly like a run started from the Workbench, so a scheduled edition never reaches its
subscribers without a person pressing "Send to subscribers".
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from writer_engine.config import get_settings
from writer_engine.errors import SUPABASE_ERRORS
from writer_engine.telemetry.logging import get_logger

logger = get_logger("newsletter_send")

# How many test copies one issue may send. A button that mails on every click needs a ceiling.
MAX_TEST_COPIES_PER_ISSUE = 10
TEST_SUBJECT_PREFIX = "[TEST] "
OWNER_EMAILS_TABLE = "newsletter_owner_emails_v2"


class OwnerCopyError(RuntimeError):
    """A test copy that was refused. ``code`` is what the HTTP layer maps to a status."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _supabase_configured() -> bool:
    settings = get_settings()
    return bool(settings.supabase_url and settings.supabase_service_role_key)


async def count_active_subscribers(edition_id: str) -> int | None:
    """Active subscribers of an edition: who "Send to subscribers" will mail. None when unknown."""
    if not edition_id or not _supabase_configured():
        return None
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        resp = await (
            client.table("newsletter_subscribers_v2")
            .select("id", count="exact")  # type: ignore[arg-type]
            .eq("edition_id", edition_id)
            .eq("status", "active")
            .limit(1)
            .execute()
        )
        total = getattr(resp, "count", None)
        if isinstance(total, int):
            return total
        return len(getattr(resp, "data", None) or [])
    except SUPABASE_ERRORS as exc:
        logger.warning("newsletter_send.count_failed", edition_id=edition_id, error=str(exc)[:200])
        return None


async def owner_email(user_id: str) -> str | None:
    """The owner's own address (``users_v2.email``) — the only place a test copy may go."""
    if not user_id or not _supabase_configured():
        return None
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    resp = await client.table("users_v2").select("email").eq("user_id", user_id).limit(1).execute()
    rows = list(getattr(resp, "data", None) or [])
    email = str((rows[0] if rows else {}).get("email") or "").strip()
    return email if "@" in email else None


async def count_test_copies(execution_id: str) -> int:
    if not _supabase_configured():
        return 0
    from writer_engine.supabase.client import get_supabase_admin

    client = await get_supabase_admin()
    resp = await (
        client.table(OWNER_EMAILS_TABLE)
        .select("id", count="exact")  # type: ignore[arg-type]
        .eq("execution_id", execution_id)
        .eq("kind", "test_copy")
        .execute()
    )
    total = getattr(resp, "count", None)
    return total if isinstance(total, int) else len(getattr(resp, "data", None) or [])


async def record_owner_email(row: dict[str, Any], *, client: Any = None) -> dict[str, Any] | None:
    """Insert one ``newsletter_owner_emails_v2`` row. Returns the stored row, or None (logged).

    ``client`` is the caller's Supabase client when it has one (the studio ops do); otherwise the
    service-role client is used, and nothing is recorded where Supabase isn't configured. The email
    has already gone out when this runs, so a failure to record it is logged and does not turn a
    delivered email into a reported failure.
    """
    if client is None and not _supabase_configured():
        return None
    record = {"sent_at": datetime.now(UTC).isoformat(), **row}
    try:
        if client is None:
            from writer_engine.supabase.client import get_supabase_admin

            client = await get_supabase_admin()
        resp = await client.table(OWNER_EMAILS_TABLE).insert(record).execute()
        rows = list(getattr(resp, "data", None) or [])
        return rows[0] if rows else record
    except SUPABASE_ERRORS as exc:
        logger.error("newsletter_send.record_failed", kind=row.get("kind"), error=str(exc)[:200])
        return None


def tagged_subject(subject: str) -> str:
    subject = str(subject or "Newsletter")
    return subject if subject.startswith(TEST_SUBJECT_PREFIX) else f"{TEST_SUBJECT_PREFIX}{subject}"


async def mark_send_cancelled(send_id: str) -> None:
    """The owner declined the final gate: the saved issue stays as a record but is never sent."""
    if not send_id or not _supabase_configured():
        return
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        await (
            client.table("newsletter_sends_v2")
            .update({"status": "cancelled"})
            .eq("id", send_id)
            .neq("status", "sent")
            .execute()
        )
    except SUPABASE_ERRORS as exc:
        logger.warning("newsletter_send.cancel_mark_failed", send_id=send_id, error=str(exc)[:200])


__all__ = [
    "MAX_TEST_COPIES_PER_ISSUE",
    "OWNER_EMAILS_TABLE",
    "TEST_SUBJECT_PREFIX",
    "OwnerCopyError",
    "count_active_subscribers",
    "count_test_copies",
    "mark_send_cancelled",
    "owner_email",
    "record_owner_email",
    "tagged_subject",
]
