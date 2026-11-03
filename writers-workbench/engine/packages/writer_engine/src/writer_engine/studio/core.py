"""Studio editions, the slate, posts, their states, and scheduling.

A **studio edition** is a newsletter edition the caller owns whose radar the caller subscribes to:
``radar_subscriptions_v2.settings.edition_id`` names it, or the edition has an active ``radar://<radar>``
feed source. Every function here takes the caller's ``user_id`` and filters on it; nothing reads or
writes another user's rows.

Post states (``social_schedule_v2.state``, migration 050):

    draft ──approve──▶ approved ──schedule──▶ pending ─▶ posting ─▶ posted / partial / failed
      ▲   ◀─unapprove──     │                    │
      └──── discard (delete) ┘                    └── cancel ─▶ cancelled

``draft`` and ``approved`` have no day or slot, so the publisher (which claims ``pending`` only) and
the calendar (which reads by date) never see them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from writer_engine.social import schedule as S

SCHEDULE = "social_schedule_v2"
TOPICS = "radar_topics_v2"
SUBSCRIPTIONS = "radar_subscriptions_v2"
FEEDS = "newsletter_feed_sources_v2"
EDITIONS = "newsletter_editions_v2"
CHANNELS = "social_channels_v2"

PRE_CALENDAR = ("draft", "approved")
QUEUE = ("pending", "posting", "failed", "partial")
EDITABLE = ("draft", "approved", "pending", "failed", "partial", "cancelled")
DEFAULT_CHANNELS = {
    "trend": ("website", "li_techahir", "li_agile", "li_personal"),
    "dev": ("li_techahir", "li_agile", "li_personal"),
}

POST_FIELDS = (
    "id,display_number,external_id,title,body_md,linkedin_content,seo_title,meta_description,category,"
    "include_image,image_url,post_status,channels,scheduled_date,slot,scheduled_at,post_at,state,attempts,"
    "posted_at,last_error,source,item_type,source_url,radar_topic_id,edition_id,humanize,studio,"
    "created_at,updated_at"
)


class StudioError(Exception):
    """A request the studio refuses, with a code the server maps to an HTTP status."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class StudioEdition:
    user_id: str
    edition_id: str
    radar: str
    name: str
    channels: tuple[str, ...] = field(default_factory=tuple)


async def _rows(query: Any) -> list[dict[str, Any]]:
    resp = await query.execute()
    return list(getattr(resp, "data", None) or [])


async def studio_editions(client: Any, user_id: str) -> list[StudioEdition]:
    """Every edition the user owns that one of the user's radars feeds."""
    if not user_id:
        return []
    editions = await _rows(
        client.table(EDITIONS).select("id,display_name,user_id,enabled").eq("user_id", user_id)
    )
    if not editions:
        return []
    subs = await _rows(client.table(SUBSCRIPTIONS).select("*").eq("user_id", user_id))
    feeds = await _rows(
        client.table(FEEDS)
        .select("edition_id,url,url_type,active")
        .eq("user_id", user_id)
        .eq("url_type", "radar")
    )
    out: list[StudioEdition] = []
    for e in editions:
        eid = str(e["id"])
        radar_urls = {
            str(f.get("url") or "").lower()
            for f in feeds
            if str(f.get("edition_id")) == eid and f.get("active", True)
        }
        for sub in subs:
            radar = str(sub.get("radar") or "")
            settings = sub.get("settings") or {}
            if settings.get("edition_id") == eid or f"radar://{radar}" in radar_urls:
                chans = tuple(settings.get("channels") or DEFAULT_CHANNELS.get(radar, ("website",)))
                out.append(
                    StudioEdition(
                        user_id=user_id,
                        edition_id=eid,
                        radar=radar,
                        name=str(e.get("display_name") or eid),
                        channels=chans,
                    )
                )
                break
    return out


async def resolve_edition(client: Any, user_id: str, edition_id: str) -> StudioEdition:
    """The caller's studio edition, or StudioError NOT_FOUND (never says whether someone else has it)."""
    if not user_id or not edition_id:
        raise StudioError("NOT_FOUND", "No such studio edition")
    for ed in await studio_editions(client, user_id):
        if ed.edition_id == edition_id:
            return ed
    raise StudioError("NOT_FOUND", "No such studio edition")


# --------------------------------------------------------------------------- slate


async def slate_weeks(client: Any, ed: StudioEdition, limit: int = 12) -> list[str]:
    rows = await _rows(
        client.table(TOPICS)
        .select("week_of")
        .eq("user_id", ed.user_id)
        .eq("radar", ed.radar)
        .order("week_of", desc=True)
        .limit(60 * limit)
    )
    return list(dict.fromkeys(str(r["week_of"])[:10] for r in rows))[:limit]


async def slate(client: Any, ed: StudioEdition, week_of: str | None = None) -> dict[str, Any]:
    """One week's ranked topics (the newest week by default) with the post each became, if any."""
    weeks = await slate_weeks(client, ed)

    async def week_topics(week: str) -> list[dict[str, Any]]:
        rows = await _rows(
            client.table(TOPICS)
            .select("*")
            .eq("user_id", ed.user_id)
            .eq("radar", ed.radar)
            .eq("week_of", week)
            .order("rank")
        )
        return sorted(rows, key=lambda t: int(t.get("rank") or 0))

    # The asked-for week whenever it has a slate (it may be older than the recent list), else the newest.
    week = str(week_of)[:10] if week_of else None
    topics = await week_topics(week) if week else []
    if not topics:
        week = weeks[0] if weeks else None
        topics = await week_topics(week) if week else []
    posts: dict[str, dict[str, Any]] = {}
    if topics:
        for p in await _rows(
            client.table(SCHEDULE)
            .select("id,display_number,state,scheduled_date,slot,radar_topic_id,title")
            .eq("user_id", ed.user_id)
            .in_("radar_topic_id", [str(t["id"]) for t in topics])
        ):
            if p.get("state") == "cancelled" and str(p.get("radar_topic_id")) in posts:
                continue
            posts[str(p["radar_topic_id"])] = p
    for t in topics:
        t["post"] = posts.get(str(t["id"]))
    return {"radar": ed.radar, "week_of": week, "weeks": weeks, "topics": topics}


async def topics_by_rank(
    client: Any, ed: StudioEdition, spec: str | Sequence[int] | None, week_of: str | None = None
) -> tuple[str | None, list[dict[str, Any]]]:
    from writer_engine.radar.drafts import expand_selection

    view = await slate(client, ed, week_of)
    topics = view["topics"]
    wanted = expand_selection(spec, [int(t["rank"]) for t in topics]) if topics else []
    by_rank = {int(t["rank"]): t for t in topics}
    return view["week_of"], [by_rank[n] for n in wanted if n in by_rank]


async def topics_by_id(client: Any, ed: StudioEdition, ids: Iterable[str]) -> list[dict[str, Any]]:
    ids = [str(i) for i in ids if i]
    if not ids:
        return []
    rows = await _rows(
        client.table(TOPICS).select("*").eq("user_id", ed.user_id).eq("radar", ed.radar).in_("id", ids)
    )
    order = {i: n for n, i in enumerate(ids)}
    return sorted(rows, key=lambda r: order.get(str(r["id"]), 0))


# --------------------------------------------------------------------------- posts

_POST_REF = re.compile(r"#?\s*(\d+)\s*(?:-\s*#?\s*(\d+))?")


def parse_post_numbers(spec: str | Sequence[int] | None) -> list[int]:
    """ "#3, 5-7" / [3, 5] → display numbers, in order, without repeats."""
    if spec is None:
        return []
    if isinstance(spec, (list, tuple)):
        return list(dict.fromkeys(int(n) for n in spec))
    out: list[int] = []
    for part in str(spec).split(","):
        m = _POST_REF.fullmatch(part.strip())
        if not m:
            continue
        a = int(m.group(1))
        b = int(m.group(2)) if m.group(2) else a
        lo, hi = sorted((a, b))
        out.extend(range(lo, min(hi, lo + 99) + 1))
    return list(dict.fromkeys(out))


async def posts_for(
    client: Any, ed: StudioEdition, states: Sequence[str] | None = None, *, limit: int = 300
) -> list[dict[str, Any]]:
    q = client.table(SCHEDULE).select(POST_FIELDS).eq("user_id", ed.user_id).eq("edition_id", ed.edition_id)
    if states:
        q = q.in_("state", list(states))
    rows = await _rows(q.order("display_number", desc=True).limit(limit))
    return rows


async def own_posts(
    client: Any,
    ed: StudioEdition,
    *,
    ids: Sequence[str] | None = None,
    numbers: Sequence[int] | None = None,
) -> list[dict[str, Any]]:
    """The caller's posts in this edition, by id or by #N, in the order asked."""
    q = client.table(SCHEDULE).select(POST_FIELDS).eq("user_id", ed.user_id).eq("edition_id", ed.edition_id)
    if ids:
        rows = await _rows(q.in_("id", [str(i) for i in ids]))
        order = {str(i): n for n, i in enumerate(ids)}
        return sorted(rows, key=lambda r: order.get(str(r["id"]), 0))
    if numbers:
        rows = await _rows(q.in_("display_number", [int(n) for n in numbers]))
        rank = {int(n): i for i, n in enumerate(numbers)}
        return sorted(rows, key=lambda r: rank.get(int(r.get("display_number") or 0), 0))
    return []


def _summary(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": p.get("id"),
        "display_number": p.get("display_number"),
        "title": p.get("title"),
        "state": p.get("state"),
    }


async def _update(
    client: Any, ed: StudioEdition, post: dict[str, Any], patch: dict[str, Any]
) -> dict[str, Any]:
    rows = await _rows(
        client.table(SCHEDULE)
        .update(patch)
        .eq("id", str(post["id"]))
        .eq("user_id", ed.user_id)
        .eq("state", str(post.get("state")))
    )
    if not rows:
        raise StudioError("CONFLICT", f"#{post.get('display_number')} changed while you were looking at it")
    return rows[0]


TRANSITIONS: dict[str, tuple[tuple[str, ...], dict[str, Any] | None]] = {
    "approve": (("draft",), {"state": "approved"}),
    "unapprove": (("approved",), {"state": "draft"}),
    "discard": (PRE_CALENDAR, None),  # delete: a draft never went anywhere
    "cancel": (("pending", "failed", "partial"), {"state": "cancelled"}),
    "requeue": (("failed", "partial", "cancelled"), {"state": "pending", "attempts": 0, "last_error": None}),
    "unschedule": (("pending",), {"state": "approved", "scheduled_date": None, "post_at": None}),
    "image_on": (EDITABLE, {"include_image": True}),
    "image_off": (EDITABLE, {"include_image": False, "image_url": None}),
}


async def apply_action(
    client: Any, ed: StudioEdition, posts: Sequence[dict[str, Any]], action: str
) -> dict[str, Any]:
    """Move each post through ``action``. Posts in the wrong state are skipped and listed, not failed."""
    if action not in TRANSITIONS:
        raise StudioError("VALIDATION", f"Unknown action {action!r}")
    allowed, patch = TRANSITIONS[action]
    done: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for p in posts:
        if p.get("state") not in allowed:
            skipped.append({**_summary(p), "reason": f"it is {p.get('state')}"})
            continue
        if patch is None:
            await (
                client.table(SCHEDULE)
                .delete()
                .eq("id", str(p["id"]))
                .eq("user_id", ed.user_id)
                .in_("state", list(PRE_CALENDAR))
                .execute()
            )
            done.append({**_summary(p), "state": "discarded"})
            continue
        row = await _update(client, ed, p, dict(patch))
        done.append(_summary(row))
    verb = {
        "approve": "Approved",
        "unapprove": "Back to draft",
        "discard": "Discarded",
        "cancel": "Cancelled",
        "requeue": "Requeued",
        "unschedule": "Taken off the calendar",
        "image_on": "Image on",
        "image_off": "Image off",
    }[action]
    message = f"{verb}:{', '.join('#' + str(d['display_number']) for d in done) or 'nothing'}."
    if skipped:
        message += " Skipped " + ", ".join(f"#{s['display_number']} ({s['reason']})" for s in skipped) + "."
    return {"done": done, "skipped": skipped, "message": message}


# --------------------------------------------------------------------------- scheduling

_DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def parse_day(text: str | None, now: datetime) -> date | None:
    """ "today" / "tomorrow" / "tuesday" / "2026-11-10" / "nov 10" → the Eastern date it names."""
    t = (text or "").strip().lower()
    if not t:
        return None
    today = now.astimezone(S.ET).date()
    if t == "today":
        return today
    if t == "tomorrow":
        return today + timedelta(days=1)
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    for i, name in enumerate(_DAYS):
        if t in (name, name[:3], "next " + name):
            # The next one after today ("tuesday" said on a Tuesday means a week out).
            ahead = (i - today.weekday()) % 7 or 7
            return today + timedelta(days=ahead)
    try:
        parsed = datetime.strptime(f"{t} {today.year}", "%b %d %Y").date()
    except ValueError:
        try:
            parsed = datetime.strptime(f"{t} {today.year}", "%B %d %Y").date()
        except ValueError:
            return None
    return parsed if parsed >= today else parsed.replace(year=today.year + 1)


async def enabled_channels(client: Any, user_id: str) -> set[str]:
    rows = await _rows(client.table(CHANNELS).select("channel,enabled").eq("user_id", user_id))
    return {str(r["channel"]) for r in rows if r.get("enabled", True)}


async def schedule_posts(
    client: Any,
    ed: StudioEdition,
    posts: Sequence[dict[str, Any]],
    *,
    mode: str = "next",
    at: datetime | None = None,
    day: date | None = None,
    slot: str | None = None,
    channels: Sequence[str] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Put drafts / approved posts (or move pending ones) on the calendar.

    ``next``  the next free slots: Trend posts any day from today, Dev Radar posts two a weekday from
              tomorrow (the n8n batch rules); a slot that already holds a post is skipped.
    ``slot``  a given day + morning/afternoon.
    ``at``    an exact time; ``now`` = now (the publisher takes it on its next five-minute tick).
    """
    now = now or datetime.now(UTC)
    if channels is not None:
        chans = list(dict.fromkeys(channels))
        unknown = [c for c in chans if c not in await enabled_channels(client, ed.user_id)]
        if not chans or unknown:
            raise StudioError(
                "UNKNOWN_CHANNEL", f"Not one of your channels: {', '.join(unknown) or '(none)'}"
            )
    movable = [p for p in posts if p.get("state") in (*PRE_CALENDAR, "pending")]
    skipped = [
        {**_summary(p), "reason": f"it is {p.get('state')}"}
        for p in posts
        if p.get("state") not in (*PRE_CALENDAR, "pending")
    ]
    plan: list[tuple[dict[str, Any], dict[str, Any]]] = []
    if mode in ("now", "at"):
        when = now if mode == "now" else at
        if when is None:
            raise StudioError("VALIDATION", "A time is needed to schedule at")
        if when.tzinfo is None:
            when = when.replace(tzinfo=S.ET)
        if mode == "at" and when < now - timedelta(minutes=1):
            raise StudioError("VALIDATION", "That time has passed")
        local = when.astimezone(S.ET)
        for p in movable:
            plan.append(
                (
                    p,
                    {
                        "post_at": when.astimezone(UTC).isoformat(),
                        "scheduled_date": local.date().isoformat(),
                        "slot": "afternoon" if local.hour >= 12 else "morning",
                        "scheduled_at": when.astimezone(UTC).isoformat(),
                    },
                )
            )
    elif mode == "slot":
        if day is None or slot not in S.SLOT_HOUR:
            raise StudioError("VALIDATION", "A day and a slot (morning or afternoon) are needed")
        for p in movable:
            plan.append(
                (
                    p,
                    {
                        "post_at": None,
                        "scheduled_date": day.isoformat(),
                        "slot": slot,
                        "scheduled_at": S.slot_at(day, slot).isoformat(),
                    },
                )
            )
    elif mode == "next":
        weekdays = ed.radar == "dev"
        start = (now.astimezone(S.ET) + timedelta(days=1)).date() if weekdays else now.astimezone(S.ET).date()
        taken = await S.taken_slots(client, ed.user_id, start)
        ordered = S.interleave(list(movable)) if weekdays else list(movable)
        slots = S.next_slots(now, len(ordered), weekdays_only=weekdays, taken=taken, start=start)
        for p, (d, s) in zip(ordered, slots, strict=False):
            plan.append(
                (
                    p,
                    {
                        "post_at": None,
                        "scheduled_date": d.isoformat(),
                        "slot": s,
                        "scheduled_at": S.slot_at(d, s).isoformat(),
                    },
                )
            )
    else:
        raise StudioError("VALIDATION", f"Unknown schedule mode {mode!r}")
    done: list[dict[str, Any]] = []
    for p, patch in plan:
        patch["state"] = "pending"
        patch["attempts"] = 0
        patch["last_error"] = None
        if channels is not None:
            patch["channels"] = list(dict.fromkeys(channels))
        row = await _update(client, ed, p, patch)
        done.append(
            {
                **_summary(row),
                "scheduled_date": row.get("scheduled_date"),
                "slot": row.get("slot"),
                "post_at": row.get("post_at"),
                "channels": row.get("channels"),
            }
        )
    when_txt = ", ".join(
        f"#{d['display_number']} {'now' if mode == 'now' else d['scheduled_date']} "
        f"{'' if mode in ('now', 'at') else ('2:00 PM' if d['slot'] == 'afternoon' else '9:00 AM')}".strip()
        for d in done
    )
    message = f"Scheduled {len(done)}: {when_txt}." if done else "Nothing to schedule."
    if mode == "now" and done:
        message += " The publisher sends it within five minutes."
    if skipped:
        message += " Skipped " + ", ".join(f"#{s['display_number']} ({s['reason']})" for s in skipped) + "."
    return {"scheduled": done, "skipped": skipped, "message": message}


EDIT_FIELDS = (
    "title",
    "body_md",
    "linkedin_content",
    "seo_title",
    "meta_description",
    "category",
    "include_image",
    "image_url",
    "channels",
    "post_status",
)


async def edit_post(
    client: Any, ed: StudioEdition, post: dict[str, Any], changes: dict[str, Any]
) -> dict[str, Any]:
    if post.get("state") not in EDITABLE:
        raise StudioError("ALREADY_POSTED", f"A {post.get('state')} post cannot be edited")
    patch = {k: v for k, v in changes.items() if k in EDIT_FIELDS}
    if "channels" in patch:
        unknown = [c for c in patch["channels"] if c not in await enabled_channels(client, ed.user_id)]
        if unknown or not patch["channels"]:
            raise StudioError(
                "UNKNOWN_CHANNEL", f"Not one of your channels: {', '.join(unknown) or '(none)'}"
            )
    if patch.get("category"):
        patch["category"] = str(patch["category"]).upper()[:60]
    if len(str(patch.get("linkedin_content") or "")) > 3000:
        raise StudioError("VALIDATION", "LinkedIn posts are limited to 3,000 characters")
    if not patch:
        return post
    return await _update(client, ed, post, patch)


def queue_message(posts: Sequence[dict[str, Any]]) -> str:
    """The n8n "list" line per post: #N | date slot | state | title | channels."""
    if not posts:
        return "Nothing here yet."
    lines = []
    for p in posts:
        when = (
            "not scheduled"
            if not p.get("scheduled_date")
            else f"{p.get('scheduled_date')} {'2:00 PM' if p.get('slot') == 'afternoon' else '9:00 AM'}"
        )
        lines.append(
            f"#{p.get('display_number')} | {when} | {p.get('state')} | {p.get('title')} | "
            f"{', '.join(p.get('channels') or [])}"
        )
    return "\n".join(lines)
