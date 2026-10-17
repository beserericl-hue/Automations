"""Publishing content whose scheduled time has arrived (E1 / Gate 4).

A gap found while enumerating what the DEV n8n workflows actually do, not from the inventory. Both
the Workbench and the engine can **schedule** a piece of content — ``library.lifecycle`` with
``action=schedule`` sets ``published_content_v2.status='scheduled'`` and
``metadata.schedule_date`` — and nothing in either of them ever **published** it. The only thing
that did was ``17 Cron: Scheduled Publisher``, an hourly n8n workflow.

So turning n8n off without this would have left every scheduled post sitting at ``scheduled``
forever: no error, no failed job, just content that never goes out on the date the user picked. That
is the same shape of silent failure as E1's ingestion, and it is why this module exists.

The publish mechanics are **not** re-implemented here. ``library.lifecycle`` with
``action=publish`` already snapshots the current text into ``content_versions_v2``, flips the status
and ``published_at``, and emails the user via the recipient precedence in
``notifications.task_email`` — which is the same precedence the n8n cron used
(``app_config_v2.recipient_email`` per user). This module only answers *which rows are due*, and the
scheduler hands each one to that op. One publish path, not two that can drift.

Two differences from the n8n cron, both deliberate:

* **It does not hardcode a Supabase service key.** The n8n version carried
  ``sb_secret_…`` in a code node, in the workflow JSON, retrievable by anyone with API access.
* **``metadata.schedule_date`` is kept, and ``auto_published`` recorded.** n8n deleted the
  ``schedule_date`` on publish, which erases the evidence of what the user actually asked for —
  after the fact there is no way to tell a scheduled publish from a manual one, or to see that it
  went out late.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from writer_engine.telemetry.logging import get_logger

logger = get_logger("publisher")

TABLE = "published_content_v2"
SCHEDULED = "scheduled"

MAX_PER_TICK = 50
"""Ceiling on one tick's publishes. A runaway (a bad bulk schedule, a clock jump) should send fifty
emails and stop, not several hundred."""


@dataclass
class DueItem:
    """One scheduled row whose time has come."""

    content_id: str
    user_id: str
    title: str
    content_type: str
    schedule_date: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "content_id": self.content_id,
            "user_id": self.user_id,
            "title": self.title,
            "content_type": self.content_type,
            "schedule_date": self.schedule_date,
        }


def parse_schedule_date(value: object) -> datetime | None:
    """Parse ``metadata.schedule_date``. ``None`` when it cannot be read.

    A row with an unreadable date is **not** published — the same direction as ``cadence.is_due``,
    and for the same reason: publishing is outward-facing, so a late send is recoverable and a wrong
    one is not. The row stays ``scheduled`` and is reported, rather than going out now or never
    being looked at again.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        # A date with no time ("2026-10-20") is what the UI's date picker sends.
        try:
            parsed = datetime.strptime(text[:10], "%Y-%m-%d")
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


async def find_due(
    *, now: datetime | None = None, limit: int = MAX_PER_TICK
) -> tuple[list[DueItem], list[str]]:
    """``(due, unreadable)`` — the scheduled rows whose time has arrived, and the ids that could not
    be read.

    The ``schedule_date`` lives inside a JSONB ``metadata`` column, so the filtering is done here
    rather than in PostgREST: a row with no ``schedule_date`` at all is simply not scheduled for
    anything, which is why those are skipped silently rather than reported.
    """
    from writer_engine.supabase.client import get_supabase_admin

    moment = now or datetime.now(UTC)
    client = await get_supabase_admin()
    resp = await (
        client.table(TABLE)
        .select("id,user_id,title,content_type,metadata")
        .eq("status", SCHEDULED)
        .is_("deleted_at", "null")
        .limit(500)
        .execute()
    )

    due: list[DueItem] = []
    unreadable: list[str] = []
    for row in getattr(resp, "data", None) or []:
        meta = row.get("metadata")
        meta = meta if isinstance(meta, dict) else {}
        raw = meta.get("schedule_date")
        if raw in (None, ""):
            continue  # scheduled status with no date — nothing to be due
        when = parse_schedule_date(raw)
        if when is None:
            unreadable.append(str(row.get("id")))
            continue
        if when <= moment:
            due.append(
                DueItem(
                    content_id=str(row.get("id")),
                    user_id=str(row.get("user_id") or ""),
                    title=str(row.get("title") or "Untitled"),
                    content_type=str(row.get("content_type") or "content"),
                    schedule_date=str(raw),
                )
            )
    due.sort(key=lambda d: d.schedule_date)
    if unreadable:
        # C4: a row stuck at `scheduled` because nobody can read its date would otherwise be
        # invisible — it is not an error anywhere, just content that never goes out.
        logger.warning("publisher.unreadable_schedule_date", ids=unreadable[:10], count=len(unreadable))
    return due[:limit], unreadable


def publish_payload(item: DueItem) -> dict[str, Any]:
    """The ``library.lifecycle`` payload that publishes one item.

    ``auto_published`` is what tells a reader of the row that the scheduler did this rather than a
    person, and it is the flag the n8n cron set too.
    """
    return {
        "op": "lifecycle",
        "action": "publish",
        "content_id": item.content_id,
        "user_id": item.user_id,
        "auto_published": True,
        "auto_published_at": datetime.now(UTC).isoformat(),
        "scheduled_for": item.schedule_date,
    }


__all__ = [
    "MAX_PER_TICK",
    "SCHEDULED",
    "TABLE",
    "DueItem",
    "find_due",
    "parse_schedule_date",
    "publish_payload",
]
