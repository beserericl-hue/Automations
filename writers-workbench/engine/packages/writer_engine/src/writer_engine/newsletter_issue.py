"""Newsletter issue numbers — the number a send will carry, known before it is saved.

The database assigns issue numbers (migration 041: a per-edition, advisory-locked trigger on
``newsletter_sends_v2``). The saga renders the email *before* it persists the row, so it asks
``newsletter_peek_issue_number`` for the number a save for that edition + date would get, renders
"Issue #N" with it, and proposes N on the save. If another send of the edition took N in the
meantime, the trigger assigns the next free number and the saga re-renders with that one — see
:func:`saved_issue_number`.
"""

from __future__ import annotations

from typing import Any

from writer_engine.config import get_settings
from writer_engine.telemetry.logging import get_logger

logger = get_logger("newsletter_issue")


async def peek_issue_number(edition_id: str, send_date: str) -> int | None:
    """The issue number a save for ``edition_id`` + ``send_date`` would get, or ``None``.

    ``None`` when Supabase isn't configured or the lookup fails: the render then leaves the number
    out and the trigger still numbers the row when it is saved.
    """
    if not edition_id or not send_date:
        return None
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return None
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        resp = await client.rpc(
            "newsletter_peek_issue_number", {"p_edition_id": edition_id, "p_send_date": send_date}
        ).execute()
        return _as_int(getattr(resp, "data", None))
    except Exception as exc:
        logger.warning(
            "newsletter_issue.peek_failed",
            edition_id=edition_id,
            send_date=send_date,
            error=f"{type(exc).__name__}: {exc}"[:200],
        )
        return None


def saved_issue_number(send_row: dict[str, Any] | None) -> int | None:
    """The issue number the database gave a saved ``newsletter_sends_v2`` row."""
    if not isinstance(send_row, dict):
        return None
    return _as_int(send_row.get("issue_number"))


def _as_int(value: Any) -> int | None:
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = next(iter(value.values()), None)
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.strip().isdigit():
        n = int(value.strip())
        return n if n > 0 else None
    return None
