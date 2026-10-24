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

A weekday can also be stated explicitly, because the UI asks for one: the edition editor's
``cadence_send_time`` field is a free-text box whose own placeholder reads **"09:00 fri"**. Until now
that string matched none of the accepted formats, so ``parse_send_time`` logged a warning and
returned MIDNIGHT — a user who typed exactly what the placeholder suggested lost the weekday *and*
had their 09:00 moved to 00:00. The parser now reads an optional trailing (or leading) weekday and
the due moment lands on it.
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


WEEKDAYS: dict[str, int] = {
    "mon": 0,
    "monday": 0,
    "tue": 1,
    "tues": 1,
    "tuesday": 1,
    "wed": 2,
    "weds": 2,
    "wednesday": 2,
    "thu": 3,
    "thur": 3,
    "thurs": 3,
    "thursday": 3,
    "fri": 4,
    "friday": 4,
    "sat": 5,
    "saturday": 5,
    "sun": 6,
    "sunday": 6,
}
"""Accepted weekday spellings for ``cadence_send_time``, matching Python's Monday=0."""


def parse_schedule(value: object) -> tuple[time, int | None]:
    """Parse ``cadence_send_time`` into ``(time_of_day, weekday_or_None)``.

    Accepts "09:00", "09:00:00", "9", a ``time`` object, and — because the UI's own placeholder says
    so — a weekday alongside the time in either order: "09:00 fri", "fri 09:00", "Friday 9".
    A bare weekday ("fri") means that day at the default time.

    Junk still falls back to the default rather than raising: refusing to send a newsletter over an
    unparseable minute field is the wrong trade. But a RECOGNISED time is never discarded because
    something unrecognised sat next to it, which is the bug this replaces.
    """
    if isinstance(value, time):
        return value, None
    text = str(value or "").strip()
    if not text:
        return DEFAULT_SEND_TIME, None

    weekday: int | None = None
    time_of_day: time | None = None
    unknown: list[str] = []
    for token in text.replace(",", " ").split():
        key = token.strip().lower()
        if key in WEEKDAYS:
            weekday = WEEKDAYS[key]
            continue
        parsed = None
        for fmt in ("%H:%M:%S", "%H:%M", "%H"):
            try:
                parsed = datetime.strptime(key, fmt).time()
                break
            except ValueError:
                continue
        if parsed is not None:
            time_of_day = parsed
        else:
            unknown.append(token[:16])

    if unknown:
        # Still warned, because a typo'd weekday ("friady") should be visible — but it no longer
        # costs the user the time they typed correctly.
        logger.warning("cadence.bad_send_time", value=text[:32], unparsed=unknown[:3])
    if time_of_day is None and weekday is None:
        return DEFAULT_SEND_TIME, None
    return (time_of_day or DEFAULT_SEND_TIME), weekday


def parse_send_time(value: object) -> time:
    """Just the time of day. Kept for callers that do not care about the weekday."""
    return parse_schedule(value)[0]


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
    at, weekday = parse_schedule(send_time)
    local_baseline_date: date = baseline.astimezone(zone).date()
    due_date = local_baseline_date + timedelta(days=days)
    if weekday is not None:
        # Land on the requested weekday at or after the interval. Never earlier: a "weekly, Friday"
        # edition whose interval lands on a Wednesday waits until Friday rather than going out two
        # days early, because early is the direction that reaches subscribers before the operator
        # expects it.
        due_date += timedelta(days=(weekday - due_date.weekday()) % 7)
    return datetime.combine(due_date, at, tzinfo=zone)


def latest_baseline(*candidates: object) -> datetime | None:
    """The most recent readable timestamp among ``candidates``, or None if none can be read.

    The cadence baseline is "when this edition last ran", and a completed send is not the only
    evidence of that. A run pauses at the stories approval gate and only writes its send at the very
    end, so measuring from the last SEND alone made an edition whose gate nobody answered due again on
    every tick: The Wasteland Wire, weekly, started a new run every 15 minutes for five days. The
    tick passes the last send, the last approval the edition's run opened, and the last time the tick
    itself started a run; whichever is newest is when it last ran.
    """
    parsed = [p for p in (parse_baseline(c) for c in candidates if c) if p is not None]
    return max(parsed) if parsed else None


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
    "WEEKDAYS",
    "is_due",
    "next_due_at",
    "parse_baseline",
    "parse_schedule",
    "parse_send_time",
    "resolve_zone",
]
