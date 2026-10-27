"""The post calendar's publisher: posts each due ``social_schedule_v2`` row to its channels.

The port of n8n's ``Cron - Post Scheduled Website Blogs`` (Se2X0fmkLUFK6CCq), which ran at 09:00
and 14:00 ET and handed every pending row whose slot had passed to ``Sub - Publish Blog All
Channels v2``. One tick here:

1. **Reconciles** LinkedIn deliveries Blotato accepted earlier (``submitted``): published, failed
   with Blotato's reason, or still working. n8n looked once, 40s after posting, and counted
   "in-progress" as success forever.
2. **Claims** each due row by moving it ``pending`` → ``posting`` with an UPDATE that only matches
   while the row is still ``pending``. Two ticks (or two replicas) cannot both post it; n8n had no
   lock at all.
3. **Delivers** each channel that has no successful delivery yet, so a retry re-sends only what
   failed. One row per post per channel (``social_schedule_deliveries_v2``, unique).
4. **Settles** the row: ``posted`` (every channel ok), ``partial`` (some), ``failed`` (none).
   ``partial`` and ``failed`` rows are retried up to ``MAX_ATTEMPTS`` times with a growing wait;
   n8n never retried, and wrote ``posted`` if any one channel worked.

Nothing leaves the engine unless ``SOCIAL_POSTING_MODE=live``. In any other mode each channel gets
a ``dry_run`` delivery holding the exact request that would have been sent. That is the default
because n8n is still posting the same calendar: two live posters would publish everything twice.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from writer_engine.config import get_settings
from writer_engine.social import channels as ch
from writer_engine.telemetry.logging import get_logger

logger = get_logger("social.poster")

SCHEDULE = "social_schedule_v2"
DELIVERIES = "social_schedule_deliveries_v2"

MAX_PER_TICK = 20
"""n8n's twice-daily run handed out a whole slot at once. Twenty a tick, every five minutes, is
more than any slot has held, and a bad bulk schedule stops at twenty posts instead of hundreds."""

MAX_ATTEMPTS = 3
RETRY_BASE = timedelta(minutes=15)
STALE_CLAIM = timedelta(minutes=15)
"""A row left in ``posting`` this long belongs to a tick that died. It is reclaimed; the delivery
rows say which channels already went out, so only the rest are sent."""


@dataclass
class TickResult:
    mode: str
    claimed: int = 0
    posted: int = 0
    partial: int = 0
    failed: int = 0
    reconciled: int = 0
    rows: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "claimed": self.claimed,
            "posted": self.posted,
            "partial": self.partial,
            "failed": self.failed,
            "reconciled": self.reconciled,
            "rows": self.rows,
        }


def is_live(mode: str | None = None) -> bool:
    return (mode if mode is not None else get_settings().social_posting_mode).strip().lower() == "live"


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


def settle_state(channels: list[str], deliveries: dict[str, dict[str, Any]]) -> str:
    ok = [c for c in channels if (deliveries.get(c) or {}).get("status") in ch.OK_DELIVERY]
    if len(ok) == len(channels):
        return "posted"
    return "partial" if ok else "failed"


async def _deliveries_for(client: Any, schedule_id: str) -> dict[str, dict[str, Any]]:
    resp = await client.table(DELIVERIES).select("*").eq("schedule_id", schedule_id).execute()
    return {str(r["channel"]): r for r in (resp.data or [])}


async def _write_delivery(
    client: Any,
    schedule_id: str,
    channel: str,
    existing: dict[str, Any] | None,
    *,
    status: str,
    request: dict[str, Any] | None,
    result: ch.SendResult | None = None,
    detail: str = "",
) -> dict[str, Any]:
    row = {
        "schedule_id": schedule_id,
        "channel": channel,
        "status": status,
        "attempts": int((existing or {}).get("attempts") or 0) + 1,
        "provider_ref": result.provider_ref if result else None,
        "public_url": result.public_url if result else None,
        "detail": (result.detail if result else detail)[:1000],
        "request": ch.redact_request(request) if request else None,
        "response": result.response if result else None,
    }
    if existing:
        await client.table(DELIVERIES).update(row).eq("id", existing["id"]).execute()
        return {**existing, **row}
    resp = await client.table(DELIVERIES).insert(row).execute()
    return (resp.data or [row])[0]


async def _claim(client: Any, row: dict[str, Any], now: datetime) -> bool:
    q = (
        client.table(SCHEDULE)
        .update({"state": "posting", "claimed_at": _iso(now), "attempts": int(row.get("attempts") or 0) + 1})
        .eq("id", row["id"])
        .eq("state", row["state"])
    )
    if row["state"] == "posting":
        q = q.eq("claimed_at", row.get("claimed_at"))
    resp = await q.execute()
    return bool(resp.data)


async def due_rows(client: Any, now: datetime, *, limit: int = MAX_PER_TICK) -> list[dict[str, Any]]:
    """Pending rows whose slot has passed, failed/partial rows whose retry wait is over, and rows a
    dead tick left in ``posting``. Oldest slot first."""
    out: list[dict[str, Any]] = []
    pending = await (
        client.table(SCHEDULE)
        .select("*")
        .eq("state", "pending")
        .lte("scheduled_at", _iso(now))
        .order("scheduled_at")
        .limit(limit)
        .execute()
    )
    out.extend(pending.data or [])
    retry = await (
        client.table(SCHEDULE)
        .select("*")
        .in_("state", ["failed", "partial"])
        .lt("attempts", MAX_ATTEMPTS)
        .order("scheduled_at")
        .limit(limit)
        .execute()
    )
    for row in retry.data or []:
        wait = RETRY_BASE * max(1, int(row.get("attempts") or 1))
        if str(row.get("updated_at") or "") <= _iso(now - wait):
            out.append(row)
    stale = await (
        client.table(SCHEDULE)
        .select("*")
        .eq("state", "posting")
        .lte("claimed_at", _iso(now - STALE_CLAIM))
        .limit(limit)
        .execute()
    )
    out.extend(stale.data or [])
    out.sort(key=lambda r: str(r.get("scheduled_at") or ""))
    return out[:limit]


Sender = Callable[..., Awaitable[ch.SendResult]]


@dataclass
class Transport:
    """The outside world, swappable in tests."""

    http: httpx.AsyncClient
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep


async def _cover(
    transport: Transport, row: dict[str, Any], wanted: list[ch.Channel], *, live: bool
) -> tuple[tuple[bytes, str] | None, str | None, str]:
    """The sketchnote for this post: (website cover, Blotato media url, note). Made once, shared."""
    if not row.get("include_image") or not wanted:
        return None, None, ""
    if not live:
        return None, None, "would generate a sketchnote image (dry run: no image made)"
    settings = get_settings()
    if not settings.kieai_api_key:
        return None, None, "KIEAI_API_KEY not set: posted without an image"
    made = await ch.kie_sketchnote(
        transport.http,
        ch.sketchnote_prompt(str(row.get("title") or ""), str(row.get("body_md") or "")),
        api_key=settings.kieai_api_key,
        sleep=transport.sleep,
    )
    if made is None:
        return None, None, "image generation failed or timed out: posted without an image"
    data, content_type, src = made
    media = None
    if any(c.kind == "linkedin" for c in wanted) and settings.blotato_api_key:
        media = await ch.blotato_upload_media(
            transport.http, src, api_key=settings.blotato_api_key, base_url=settings.blotato_base_url
        )
    return (data, content_type), media, ""


async def post_row(
    client: Any, transport: Transport, row: dict[str, Any], now: datetime, *, live: bool
) -> dict[str, dict[str, Any]]:
    """Send every channel of a claimed row that has not gone out yet. Returns the deliveries."""
    settings = get_settings()
    configured = await ch.load_channels(client, str(row["user_id"]))
    deliveries = await _deliveries_for(client, str(row["id"]))
    todo = [
        c for c in row.get("channels") or [] if (deliveries.get(c) or {}).get("status") not in ch.OK_DELIVERY
    ]

    wanted: list[ch.Channel] = []
    for name in todo:
        channel = configured.get(name)
        if channel is None or not channel.enabled:
            reason = "not configured" if channel is None else "disabled"
            deliveries[name] = await _write_delivery(
                client,
                row["id"],
                name,
                deliveries.get(name),
                status="failed",
                request=None,
                detail=f"channel {name} is {reason} for this user",
            )
            continue
        wanted.append(channel)

    cover, media_url, image_note = await _cover(transport, row, wanted, live=live)

    for channel in wanted:
        if channel.kind == "website":
            request = ch.website_request(row, channel, cover=cover, now=now)
        else:
            request = ch.linkedin_request(row, channel, media_url=media_url)
        existing = deliveries.get(channel.channel)
        if not live:
            note = "dry run: nothing sent" + (f"; {image_note}" if image_note else "")
            deliveries[channel.channel] = await _write_delivery(
                client, row["id"], channel.channel, existing, status="dry_run", request=request, detail=note
            )
            continue
        try:
            if channel.kind == "website":
                result = await ch.send_website(transport.http, channel, request)
            else:
                result = await ch.send_linkedin(
                    transport.http,
                    channel,
                    request,
                    api_key=settings.blotato_api_key,
                    base_url=settings.blotato_base_url,
                )
        except Exception as exc:
            result = ch.SendResult("failed", detail=f"{type(exc).__name__}: {exc}"[:500])
        if image_note and result.status != "failed":
            result.detail = f"{result.detail}; {image_note}"
        deliveries[channel.channel] = await _write_delivery(
            client, row["id"], channel.channel, existing, status=result.status, request=request, result=result
        )
    return deliveries


async def _settle(
    client: Any, row: dict[str, Any], deliveries: dict[str, dict[str, Any]], now: datetime
) -> str:
    channels = list(row.get("channels") or [])
    state = settle_state(channels, deliveries)
    errors = [
        f"{c}: {(deliveries.get(c) or {}).get('detail') or 'no result'}"
        for c in channels
        if (deliveries.get(c) or {}).get("status") not in ch.OK_DELIVERY
    ]
    patch: dict[str, Any] = {
        "state": state,
        "last_error": "; ".join(errors)[:1000] or None,
        "claimed_at": None,
    }
    if state != "failed" and not row.get("posted_at"):
        patch["posted_at"] = _iso(now)
    await client.table(SCHEDULE).update(patch).eq("id", row["id"]).execute()
    return state


async def reconcile_submitted(
    client: Any, transport: Transport, *, min_age: timedelta = timedelta(seconds=40)
) -> int:
    """Ask Blotato about LinkedIn posts it accepted but had not finished. Returns rows changed."""
    settings = get_settings()
    if not settings.blotato_api_key:
        return 0
    now = datetime.now(UTC)
    resp = await (
        client.table(DELIVERIES)
        .select("*")
        .eq("status", "submitted")
        .lte("updated_at", _iso(now - min_age))
        .limit(50)
        .execute()
    )
    changed = 0
    touched: set[str] = set()
    for d in resp.data or []:
        if not d.get("provider_ref"):
            continue
        try:
            result = await ch.blotato_status(
                transport.http,
                str(d["provider_ref"]),
                api_key=settings.blotato_api_key,
                base_url=settings.blotato_base_url,
            )
        except Exception as exc:
            logger.warning("social.reconcile_failed", ref=d.get("provider_ref"), error=str(exc)[:200])
            continue
        if result.status == "submitted":
            continue
        await (
            client.table(DELIVERIES)
            .update(
                {
                    "status": result.status,
                    "public_url": result.public_url,
                    "detail": result.detail[:1000],
                    "response": result.response,
                }
            )
            .eq("id", d["id"])
            .execute()
        )
        touched.add(str(d["schedule_id"]))
        changed += 1
    for schedule_id in touched:
        rows = (await client.table(SCHEDULE).select("*").eq("id", schedule_id).execute()).data or []
        if rows and rows[0].get("state") != "posting":
            await _settle(client, rows[0], await _deliveries_for(client, schedule_id), now)
    return changed


AfterPosted = Callable[[dict[str, Any], dict[str, dict[str, Any]]], Awaitable[None]]


async def run_tick(
    client: Any,
    transport: Transport,
    *,
    now: datetime | None = None,
    mode: str | None = None,
    after_posted: AfterPosted | None = None,
) -> TickResult:
    now = now or datetime.now(UTC)
    live = is_live(mode)
    result = TickResult(mode="live" if live else "dry_run")
    result.reconciled = await reconcile_submitted(client, transport) if live else 0
    for row in await due_rows(client, now):
        if not await _claim(client, row, now):
            continue  # another tick took it
        result.claimed += 1
        try:
            deliveries = await post_row(client, transport, row, now, live=live)
        except Exception as exc:
            logger.error(
                "social.post_row_failed", schedule_id=row["id"], error=f"{type(exc).__name__}: {exc}"[:300]
            )
            deliveries = await _deliveries_for(client, str(row["id"]))
        state = await _settle(client, row, deliveries, now)
        setattr(result, state, getattr(result, state) + 1)
        result.rows.append(
            {
                "id": row["id"],
                "display_number": row.get("display_number"),
                "title": row.get("title"),
                "state": state,
                "channels": {c: (deliveries.get(c) or {}).get("status") for c in row.get("channels") or []},
                "detail": {c: (deliveries.get(c) or {}).get("detail") for c in row.get("channels") or []},
                "urls": {c: (deliveries.get(c) or {}).get("public_url") for c in row.get("channels") or []},
            }
        )
        if after_posted is not None and state != "failed":
            try:
                await after_posted(row, deliveries)
            except Exception as exc:  # feeding the newsletter must never undo a post
                logger.warning("social.after_posted_failed", schedule_id=row["id"], error=str(exc)[:200])
    if result.claimed:
        logger.info("social.tick", **{k: v for k, v in result.as_dict().items() if k != "rows"})
    return result


def summary_email(result: TickResult, now: datetime) -> tuple[str, str]:
    """(subject, html) of the run summary, like n8n's Build Summary."""
    from html import escape
    from zoneinfo import ZoneInfo

    et = now.astimezone(ZoneInfo("America/New_York"))
    attention = result.partial + result.failed
    subject = f"Scheduled posts: {result.posted} ok" + (f", {attention} NEED ATTENTION" if attention else "")
    subject += f" — {et.strftime('%b %-d, %-I:%M %p')} ET"
    if result.mode != "live":
        subject = "[DRY RUN] " + subject
    icon = {"posted": "✅ Posted", "partial": "⚠️ Partly posted", "failed": "❌ FAILED"}
    lines = []
    for r in result.rows:
        detail = " | ".join(
            f"{c}: {r['channels'][c]}"
            + (f" {r['urls'][c]}" if r["urls"].get(c) else "")
            + (
                f" ({r['detail'][c]})"
                if r["channels"][c] not in ("published", "dry_run") and r["detail"].get(c)
                else ""
            )
            for c in r["channels"]
        )
        lines.append(
            f"<tr><td style='padding:6px 10px'>#{escape(str(r['display_number']))}</td>"
            f"<td style='padding:6px 10px'>{icon.get(r['state'], r['state'])}</td>"
            f"<td style='padding:6px 10px'>{escape(str(r['title']))}</td>"
            f"<td style='padding:6px 10px;font-size:12px;color:#555'>{escape(detail)[:600]}</td></tr>"
        )
    html = (
        "<div style='font-family:Arial,sans-serif'>"
        f"<h2 style='color:{'#b91c1c' if attention else '#065f46'}'>Scheduled publishing run — "
        f"{result.posted} ok, {attention} need attention</h2>"
        f"<p>{et.strftime('%A, %B %-d, %Y %-I:%M %p')} (Eastern) · mode: {result.mode}</p>"
        "<table style='border-collapse:collapse;font-size:14px'>" + "".join(lines) + "</table></div>"
    )
    return subject, html


__all__ = [
    "MAX_ATTEMPTS",
    "TickResult",
    "Transport",
    "due_rows",
    "is_live",
    "post_row",
    "reconcile_submitted",
    "run_tick",
    "settle_state",
    "summary_email",
]
