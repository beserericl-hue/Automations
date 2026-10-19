"""A11 — a newsletter goes out at its send time, not whenever the cron happens to notice.

The old arithmetic was `(now - baseline).total_seconds() / 86400 >= days`, which never read
`cadence_send_time` at all. Measured on DEV: the one live edition is `weekly` at `"09:00"`, so both
of these were real for it —

* **drift**: the baseline is the previous send's INSTANT, so a cron firing at 09:40 one week makes
  the next week due at 09:40, then later still. A "Tuesday 09:00" newsletter wanders.
* **wrong hour**: seven days after a send, the edition is due the moment the cron runs after
  midnight, so it goes out at 00:05.

`newsletter_editions_v2` has no timezone and no weekday column, so the send time is interpreted in
one configured zone and "weekly" keeps the baseline's weekday by construction.
"""

from __future__ import annotations

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

import pytest

from writer_engine.cadence import (
    DEFAULT_SEND_TIME,
    INTERVAL_DAYS,
    is_due,
    next_due_at,
    parse_baseline,
    parse_schedule,
    parse_send_time,
    resolve_zone,
)

NY = ZoneInfo("America/New_York")


def _at(y: int, m: int, d: int, hh: int = 0, mm: int = 0, tz: object = UTC) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=tz)  # type: ignore[arg-type]


# --- the two bugs ------------------------------------------------------------------------------


def test_a_weekly_edition_does_not_drift_later_each_week() -> None:
    """The headline bug. A send that happened at 09:40 must not move next week's due time."""
    late_send = _at(2026, 10, 6, 9, 40)
    due = next_due_at(cadence="weekly", baseline=late_send, send_time="09:00")
    assert due == _at(2026, 10, 13, 9, 0)  # same weekday, back at 09:00, not 09:40


def test_an_edition_is_not_due_before_its_send_time() -> None:
    """Seven days later at 00:05 is not 09:00, so it waits."""
    baseline = _at(2026, 10, 6, 9, 0)
    due, reason = is_due(cadence="weekly", baseline=baseline, send_time="09:00", now=_at(2026, 10, 13, 0, 5))
    assert due is False
    assert "not due until" in reason


def test_it_becomes_due_at_the_send_time() -> None:
    baseline = _at(2026, 10, 6, 9, 0)
    due, reason = is_due(cadence="weekly", baseline=baseline, send_time="09:00", now=_at(2026, 10, 13, 9, 0))
    assert due is True
    assert "due since" in reason


def test_a_weekly_edition_keeps_its_weekday() -> None:
    """A 7-day step from a date-anchored baseline lands on the same weekday, every time."""
    baseline = _at(2026, 10, 6, 9, 0)  # a Tuesday
    for _ in range(6):
        due = next_due_at(cadence="weekly", baseline=baseline, send_time="09:00")
        assert due is not None
        assert due.weekday() == 1, due  # still Tuesday
        baseline = due


# --- timezone ----------------------------------------------------------------------------------


def test_the_send_time_is_read_in_the_configured_zone() -> None:
    """A stored "09:00" means 09:00 where the operator lives, if they set the zone."""
    baseline = _at(2026, 10, 6, 13, 0)
    due = next_due_at(cadence="weekly", baseline=baseline, send_time="09:00", timezone="America/New_York")
    assert due is not None
    assert due.astimezone(NY).hour == 9
    assert due.astimezone(UTC).hour == 13  # 09:00 EDT


def test_utc_is_the_default_and_a_bad_zone_falls_back_to_it() -> None:
    assert resolve_zone(None).key == "UTC"
    assert resolve_zone("   ").key == "UTC"
    assert resolve_zone("Mars/Olympus_Mons").key == "UTC"


# --- parsing the real column shapes -----------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "hh", "mm"),
    [("09:00", 9, 0), ("09:00:00", 9, 0), ("17:30", 17, 30), ("7", 7, 0)],
)
def test_send_time_formats(raw: str, hh: int, mm: int) -> None:
    """DEV stores it as the string "09:00"; tolerate the other shapes rather than failing to send."""
    t = parse_send_time(raw)
    assert (t.hour, t.minute) == (hh, mm)


def test_a_missing_send_time_means_midnight_not_an_invented_default() -> None:
    """Keeps the old behaviour for the rows that have no time, instead of inventing 09:00."""
    assert parse_send_time(None).hour == 0
    assert parse_send_time("").hour == 0
    assert parse_send_time("not a time").hour == 0


def test_baseline_parsing_handles_the_postgrest_shapes() -> None:
    assert parse_baseline("2026-10-06T09:00:00Z") == _at(2026, 10, 6, 9, 0)
    assert parse_baseline("2026-10-06T09:00:00+00:00") == _at(2026, 10, 6, 9, 0)
    # A naive timestamp is treated as UTC rather than rejected.
    assert parse_baseline("2026-10-06T09:00:00") == _at(2026, 10, 6, 9, 0)
    assert parse_baseline(None) is None
    assert parse_baseline("whenever") is None


# --- the fail direction ------------------------------------------------------------------------


def test_an_unreadable_baseline_is_not_due() -> None:
    """The old code treated it as DUE and sent immediately.

    A newsletter reaches subscribers. The cost of a wrong send is much higher than a late one, so
    this fails closed on purpose — the opposite of the engine's other fail-open guards, which
    protect work that only the author sees.
    """
    due, reason = is_due(cadence="weekly", baseline="garbage", send_time="09:00")
    assert due is False
    assert "unreadable" in reason


def test_cadence_none_is_never_due() -> None:
    for cadence in ("none", "", "fortnightly", None):
        due, _ = is_due(cadence=cadence, baseline=_at(2020, 1, 1), send_time="09:00")  # type: ignore[arg-type]
        assert due is False


@pytest.mark.parametrize("cadence", sorted(INTERVAL_DAYS))
def test_every_supported_cadence_becomes_due_after_its_interval(cadence: str) -> None:
    baseline = _at(2026, 1, 1, 9, 0)
    due_at = next_due_at(cadence=cadence, baseline=baseline, send_time="09:00")
    assert due_at is not None
    assert (due_at.date() - baseline.date()).days == INTERVAL_DAYS[cadence]
    assert is_due(cadence=cadence, baseline=baseline, send_time="09:00", now=due_at)[0] is True


class TestWeekdayInSendTime:
    """The edition editor's `cadence_send_time` box is free text and its own placeholder reads
    "09:00 fri". That string matched none of the accepted formats, so the parser warned and returned
    MIDNIGHT: a user who typed exactly what the UI suggested lost the weekday AND had their 09:00
    moved to 00:00. The scheduling UI was not merely ignoring a field — it was moving the send."""

    def test_the_placeholder_the_ui_suggests_now_works(self) -> None:
        at, weekday = parse_schedule("09:00 fri")
        assert at == time(9, 0)
        assert weekday == 4

    def test_either_order_and_long_names(self) -> None:
        assert parse_schedule("fri 09:00") == (time(9, 0), 4)
        assert parse_schedule("Friday 9") == (time(9, 0), 4)
        assert parse_schedule("Tuesday, 17:30") == (time(17, 30), 1)

    def test_a_bare_time_still_has_no_weekday(self) -> None:
        assert parse_schedule("09:00") == (time(9, 0), None)

    def test_a_bare_weekday_uses_the_default_time(self) -> None:
        assert parse_schedule("sat") == (DEFAULT_SEND_TIME, 5)

    def test_a_recognised_time_survives_an_unrecognised_neighbour(self) -> None:
        """The specific regression: junk beside the time must not discard the time."""
        at, weekday = parse_schedule("09:00 friady")
        assert at == time(9, 0)
        assert weekday is None

    def test_junk_alone_still_falls_back(self) -> None:
        assert parse_schedule("whenever") == (DEFAULT_SEND_TIME, None)
        assert parse_schedule("") == (DEFAULT_SEND_TIME, None)
        assert parse_schedule(None) == (DEFAULT_SEND_TIME, None)

    def test_parse_send_time_still_answers_for_old_callers(self) -> None:
        assert parse_send_time("09:00 fri") == time(9, 0)

    def test_a_weekly_friday_edition_lands_on_friday(self) -> None:
        # Baseline Wednesday 2026-10-14; the weekly interval lands on Wednesday the 21st...
        baseline = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
        due = next_due_at(cadence="weekly", baseline=baseline, send_time="09:00 fri")
        assert due is not None
        # ...and is carried on to Friday the 23rd at 09:00 instead of sending on the Wednesday.
        assert (due.year, due.month, due.day) == (2026, 10, 23)
        assert due.weekday() == 4
        assert (due.hour, due.minute) == (9, 0)

    def test_it_never_moves_the_send_earlier(self) -> None:
        """Early is the direction that reaches subscribers before the operator expects it."""
        baseline = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
        interval_only = next_due_at(cadence="weekly", baseline=baseline, send_time="09:00")
        with_weekday = next_due_at(cadence="weekly", baseline=baseline, send_time="09:00 mon")
        assert interval_only is not None and with_weekday is not None
        assert with_weekday >= interval_only

    def test_a_weekday_matching_the_interval_day_does_not_add_a_week(self) -> None:
        baseline = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)  # Wednesday
        due = next_due_at(cadence="weekly", baseline=baseline, send_time="09:00 wed")
        assert due is not None and (due.year, due.month, due.day) == (2026, 10, 21)

    def test_is_due_respects_the_weekday(self) -> None:
        baseline = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
        on_wednesday = datetime(2026, 10, 21, 10, 0, tzinfo=UTC)  # interval elapsed, not Friday yet
        due, reason = is_due(cadence="weekly", baseline=baseline, send_time="09:00 fri", now=on_wednesday)
        assert due is False and "not due until" in reason

        on_friday = datetime(2026, 10, 23, 9, 1, tzinfo=UTC)
        due2, _ = is_due(cadence="weekly", baseline=baseline, send_time="09:00 fri", now=on_friday)
        assert due2 is True
