"""Putting posts on the calendar (``social_schedule_v2``).

Ports of the n8n queue writers: ``Sub - Schedule Blog (queue)`` (kw8qbViDZjaiDPeV), the slot rule
of ``Batch - Generate & Schedule Week`` (FaxRBqptjRfk8YuB), and ``Sub - Schedule Roundup Batch (LI
only)`` (hZq4ix2Te4vtPIuo). Slots are US Eastern: morning 09:00, afternoon 14:00.

Unlike n8n, a slot that already holds a post is skipped instead of double-booked, an insert with
an ``external_id`` that already exists is a no-op rather than a duplicate row, and the "#N" number
comes from the database (a locked max+1) rather than from a read-then-insert race.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from writer_engine.telemetry.logging import get_logger

logger = get_logger("social.schedule")

ET = ZoneInfo("America/New_York")
TABLE = "social_schedule_v2"
SLOT_HOUR = {"morning": 9, "afternoon": 14}


def slugish(title: str, n: int = 40) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", (title or "").lower()))[:n] or "post"


def normalise_channels(
    raw: str | Sequence[str] | None, *, default: Sequence[str] = ("website",)
) -> list[str]:
    """Free text or a list to channel keys. ``both``/``linkedin`` means both company pages.

    Unknown tokens that look like channel keys are kept, so a user's own channels work too.
    """
    if raw is None or raw == "" or raw == []:
        return list(default)
    tokens = [t.strip().lower() for t in (raw.split(",") if isinstance(raw, str) else raw) if str(t).strip()]
    out: list[str] = []

    def add(c: str) -> None:
        if c not in out:
            out.append(c)

    for t in tokens:
        if t in ("both", "linkedin"):
            add("li_techahir")
            add("li_agile")
        elif "website" in t:
            add("website")
        elif "techahir" in t:
            add("li_techahir")
        elif "agile" in t:
            add("li_agile")
        elif "personal" in t or t in ("profile", "me"):
            add("li_personal")
        elif re.fullmatch(r"[a-z0-9_]{2,40}", t):
            add(t)
    return out or list(default)


def slot_at(day: date, slot: str) -> datetime:
    return datetime(day.year, day.month, day.day, SLOT_HOUR.get(slot, 9), tzinfo=ET)


def next_slots(
    now: datetime,
    count: int,
    *,
    weekdays_only: bool,
    taken: set[tuple[str, str]] | None = None,
    start: date | None = None,
    per_day: int = 2,
) -> list[tuple[date, str]]:
    """The next ``count`` free slots after ``now`` (Eastern).

    Batch Week used every day; the Roundup Batch only Monday to Friday and starts tomorrow. A slot in
    ``taken`` (an already queued post) is skipped rather than double-booked.
    """
    taken = taken or set()
    slots = ["morning", "afternoon"][: max(1, min(2, per_day))]
    day = start or now.astimezone(ET).date()
    out: list[tuple[date, str]] = []
    guard = 0
    while len(out) < count and guard < 400:
        guard += 1
        if not (weekdays_only and day.weekday() >= 5):
            for s in slots:
                if slot_at(day, s) > now and (day.isoformat(), s) not in taken:
                    out.append((day, s))
                    if len(out) >= count:
                        break
        day += timedelta(days=1)
    return out


def interleave(posts: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Alternate articles and videos evenly across the week, starting with an article (n8n's rule)."""
    arts = [p for p in posts if str(p.get("item_type") or p.get("type") or "article").lower() != "video"]
    vids = [p for p in posts if str(p.get("item_type") or p.get("type") or "article").lower() == "video"]
    if not arts or not vids:
        return list(posts)
    merged: list[dict[str, Any]] = []
    ai = vi = 0
    a, v = len(arts), len(vids)
    for _ in range(a + v):
        take_article = vi >= v or (ai < a and ai * v <= vi * a)
        if take_article:
            merged.append(arts[ai])
            ai += 1
        else:
            merged.append(vids[vi])
            vi += 1
    return merged


async def taken_slots(client: Any, user_id: str, since: date) -> set[tuple[str, str]]:
    resp = await (
        client.table(TABLE)
        .select("scheduled_date,slot,state")
        .eq("user_id", user_id)
        .gte("scheduled_date", since.isoformat())
        .execute()
    )
    return {
        (str(r["scheduled_date"])[:10], str(r["slot"]))
        for r in (resp.data or [])
        if r.get("state") != "cancelled"
    }


def row_for(
    user_id: str, post: dict[str, Any], day: date, slot: str, *, source: str, prefix: str
) -> dict[str, Any]:
    title = str(post.get("title") or "Untitled").strip()[:500]
    return {
        "user_id": user_id,
        "external_id": str(post.get("external_id") or f"{prefix}-{day.isoformat()}-{slot}-{slugish(title)}"),
        "title": title,
        "body_md": str(post.get("body_md") or ""),
        "linkedin_content": str(post.get("linkedin_content") or ""),
        "seo_title": (str(post.get("seo_title") or "") or title)[:120],
        "meta_description": str(post.get("meta_description") or "")[:300],
        "category": (str(post.get("category") or "") or "INSIGHTS").upper()[:60],
        "include_image": bool(post.get("include_image", False)),
        "post_status": "draft" if str(post.get("post_status") or "") == "draft" else "published",
        "channels": list(post.get("channels") or ["website"]),
        "scheduled_date": day.isoformat(),
        "slot": slot,
        # The trigger recomputes this from date + slot; sent so the row is valid without it too.
        "scheduled_at": slot_at(day, slot).isoformat(),
        "state": "pending",
        "source": source,
        "item_type": str(post.get("item_type") or "article"),
        "source_url": post.get("source_url") or None,
        "radar_topic_id": post.get("radar_topic_id") or None,
    }


async def enqueue(client: Any, rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Insert rows, skipping any whose ``external_id`` the user already has. Returns what was added."""
    added: list[dict[str, Any]] = []
    for row in rows:
        existing = await (
            client.table(TABLE)
            .select("id")
            .eq("user_id", row["user_id"])
            .eq("external_id", row["external_id"])
            .limit(1)
            .execute()
        )
        if existing.data:
            continue
        resp = await client.table(TABLE).insert(row).execute()
        added.extend(resp.data or [])
    return added


__all__ = [
    "ET",
    "SLOT_HOUR",
    "enqueue",
    "interleave",
    "next_slots",
    "normalise_channels",
    "row_for",
    "slot_at",
    "slugish",
    "taken_slots",
]
