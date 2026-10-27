"""A newsletter generated just after midnight UTC still finds stories.

DEV 2026-10-27 00:05 UTC: the send day had nothing ingested yet, the saga ended at
skipped_no_content, and the six stories ingested on 2026-10-26 sat unused.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from gather_step import main as G


def _days(monkeypatch: pytest.MonkeyPatch, by_day: dict[str, list[dict[str, Any]]]) -> list[str]:
    asked: list[str] = []

    async def fake(day: str, _user: str, _limit: int) -> list[dict[str, Any]]:
        asked.append(day)
        return by_day.get(day, [])

    monkeypatch.setattr(G, "_fetch_day", fake)
    return asked


def test_the_send_days_stories_are_used_when_there_are_any(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _days(monkeypatch, {"2026-10-27": [{"id": "a"}], "2026-10-26": [{"id": "old"}]})
    assert asyncio.run(G._fetch("2026-10-27", "u", 50)) == [{"id": "a"}]
    assert asked == ["2026-10-27"]


def test_an_empty_send_day_falls_back_to_the_most_recent_earlier_day(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _days(monkeypatch, {"2026-10-26": [{"id": "y1"}, {"id": "y2"}]})
    assert asyncio.run(G._fetch("2026-10-27", "u", 50)) == [{"id": "y1"}, {"id": "y2"}]
    assert asked == ["2026-10-27", "2026-10-26"]


def test_it_looks_back_two_days_and_no_further(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _days(monkeypatch, {"2026-10-24": [{"id": "too-old"}]})
    assert asyncio.run(G._fetch("2026-10-27", "u", 50)) == []
    assert asked == ["2026-10-27", "2026-10-26", "2026-10-25"]


def test_a_malformed_date_does_not_look_back(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _days(monkeypatch, {})
    assert asyncio.run(G._fetch("", "u", 50)) == []
    assert asked == [""]
