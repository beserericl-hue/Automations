"""When is a newsletter edition actually due? (A11)

The cadence cron used to compare elapsed SECONDS against the interval:

    if (now - baseline).total_seconds() / 86400.0 >= days: due

which ignores ``cadence_send_time`` entirely — the column was read from the row and never used. Two
consequences, both visible to a subscriber:

* **A weekly newsletter drifts later every week.** The baseline is the previous send's timestamp, so
  if the cron fires at 09:40 one week, the next week is not due until 09:40, then 10:20, and the
  "09:00 Tuesday" newsletter arrives at a different time each week.
* **It can send at any hour.** A 09:00 edition whose last send was 7 days ago is due the moment the
  cron runs after midnight, so it goes out at 00:05.

Anchoring to the send time fixes both, and needs no new column: the due moment is the baseline DATE
plus the interval, AT the configured send time.

TIMEZONE. ``newsletter_editions_v2`` has ``cadence`` and ``cadence_send_time`` and nothing else —
no per-edition timezone, no weekday. So "09:00" is interpreted in one global zone,
``NEWSLETTER_TIMEZONE`` (default UTC). That is a real limitation rather than a design: a per-edition
zone needs a column, and these are feature-table columns a later migration can add. Set the env var
to the operator's own zone to make the stored times mean what the UI implies.

WEEKDAY. "Weekly" keeps the weekday of the baseline, because a 7-day interval from a date-anchored
baseline lands on the same weekday by construction. That is the behaviour a user expects from
"weekly" and it is why the drift above mattered.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from writer_engine.telemetry.logging import get_logger

logger = get_logger("cadence")

# Interval in days per cadence. `monthly` stays at 30 days rather than a calendar month, which is
# what the previous implementation did and what the UI copy implies ("every 30 days").
INTERVAL_DAYS: dict[str, int] = {"daily": 1, "weekly": 7, "biweekly": 14, "monthly": 30}

DEFAULT_SEND_TIME = time(0, 0)
"""Used when an edition has no ``cadence_send_time``. Midnight keeps the old behaviour — due as soon
as the interval has elapsed — rather than silently inventing a 09:00 default for existing rows."""


def resolve_zone(name: str | None) -> ZoneInfo:
    """The configured timezone, falling back to UTC rather than raising on a bad name."""
    raw = (name or "").strip() or "UTC"
    try:
        return ZoneInfo(raw)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        logger.warning("cadence.bad_timezone", configured=raw, using="UTC")
        return ZoneInfo("UTC")


def parse_send_time(value: object) -> time:
    """Parse ``cadence_send_time``. It is stored as a string like "09:00" (measured on DEV).

    Tolerates "09:00:00", a ``time`` object, and junk — junk falls back to midnight, because
    refusing to send a newsletter over an unparseable minute field is the wrong trade.
    """
    if isinstance(value, time):
        return value
    text = str(value or "").strip()
    if not text:
        return DEFAULT_SEND_TIME
    for fmt in ("%H:%M:%S", "%H:%M", "%H"):
        try:
            return datetime.strptime(text, fmt).time()
        except ValueError:
            continue
    logger.warning("cadence.bad_send_time", value=text[:32])
    return DEFAULT_SEND_TIME


def parse_baseline(value: object) -> datetime | None:
    """Parse the last-send (or created_at) timestamp. None when it cannot be read."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def next_due_at(
    *,
    cadence: str,
    baseline: datetime,
    send_time: object = None,
    timezone: str | None = None,
) -> datetime | None:
    """The instant this edition next becomes due, or None when it has no cadence.

    Date-anchored on purpose: the baseline's DATE in the configured zone, plus the interval, at the
    send time. Adding seconds to the baseline instant is what made a weekly send creep later.
    """
    days = INTERVAL_DAYS.get(str(cadence or "").strip().lower())
    if not days:
        return None
    zone = resolve_zone(timezone)
    local_baseline_date: date = baseline.astimezone(zone).date()
    due_date = local_baseline_date + timedelta(days=days)
    return datetime.combine(due_date, parse_send_time(send_time), tzinfo=zone)


def is_due(
    *,
    cadence: str,
    baseline: object,
    send_time: object = None,
    timezone: str | None = None,
    now: datetime | None = None,
) -> tuple[bool, str]:
    """``(due, reason)`` for one edition.

    An unreadable baseline is NOT due. The previous implementation treated it as due and sent
    immediately — the wrong direction for an outbound action that reaches subscribers, where the
    cost of a wrong send is far higher than the cost of a late one.
    """
    days = INTERVAL_DAYS.get(str(cadence or "").strip().lower())
    if not days:
        return False, f"cadence {cadence!r} has no interval"

    moment = now or datetime.now(UTC)
    parsed = parse_baseline(baseline)
    if parsed is None:
        return False, "baseline timestamp unreadable"

    due_at = next_due_at(cadence=cadence, baseline=parsed, send_time=send_time, timezone=timezone)
    if due_at is None:
        return False, f"cadence {cadence!r} has no interval"
    if moment >= due_at:
        return True, f"due since {due_at.isoformat()}"
    return False, f"not due until {due_at.isoformat()}"


__all__ = [
    "DEFAULT_SEND_TIME",
    "INTERVAL_DAYS",
    "is_due",
    "next_due_at",
    "parse_baseline",
    "parse_send_time",
    "resolve_zone",
]
