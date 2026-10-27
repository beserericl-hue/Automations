"""Running the radars each week, and scheduling a slate onto the post calendar.

n8n ran Trend Radar on Mondays 06:00 and Dev Radar on Sundays 06:00 (US Eastern). The engine's
scheduler is interval-based, so ``radar_tick`` runs hourly and starts each enabled subscription's
run once that week's time has passed and no run for the week exists yet. ``radar_runs_v2`` is unique
per (user, radar, week), so two replicas or two ticks cannot both run the same week; a restart in the
middle of Monday picks up the run rather than missing the week.

A slate is stored per week (``radar_topics_v2``), so last week's slate is still there for the UI and
for history, where n8n overwrote one 24-row table in place.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from writer_engine.config import get_settings
from writer_engine.radar import dev, sources, trend
from writer_engine.social.feed import feed_radar_slate
from writer_engine.social.schedule import ET
from writer_engine.telemetry.logging import get_logger

logger = get_logger("radar.run")

SUBSCRIPTIONS = "radar_subscriptions_v2"
RUNS = "radar_runs_v2"
TOPICS = "radar_topics_v2"
ARCHIVE = "radar_video_archive_v2"

RUN_HOUR = 6
STALE_RUN = timedelta(hours=2)


def week_of(now: datetime) -> date:
    """The Monday (Eastern) of the week a slate made now is for. A Sunday run is for the next day's week."""
    d = now.astimezone(ET).date()
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d - timedelta(days=d.weekday())


def due_at(radar: str, week: date) -> datetime:
    """Trend: that Monday 06:00 ET. Dev: the Sunday before, 06:00 ET."""
    day = week if radar == "trend" else week - timedelta(days=1)
    return datetime(day.year, day.month, day.day, RUN_HOUR, tzinfo=ET)


async def _claim_run(
    client: Any, user_id: str, radar: str, week: date, *, force: bool
) -> dict[str, Any] | None:
    existing = await (
        client.table(RUNS)
        .select("*")
        .eq("user_id", user_id)
        .eq("radar", radar)
        .eq("week_of", week.isoformat())
        .limit(1)
        .execute()
    )
    now = datetime.now(UTC)
    if existing.data:
        run = existing.data[0]
        stale = (
            run.get("status") == "running"
            and str(run.get("started_at") or "") < (now - STALE_RUN).isoformat()
        )
        if not force and not stale:
            return None
        updated = await (
            client.table(RUNS)
            .update({"status": "running", "started_at": now.isoformat(), "error": None, "finished_at": None})
            .eq("id", run["id"])
            .eq("status", run["status"])
            .execute()
        )
        return (updated.data or [None])[0]
    try:
        made = (
            await client.table(RUNS)
            .insert({"user_id": user_id, "radar": radar, "week_of": week.isoformat(), "status": "running"})
            .execute()
        )
    except Exception:  # another tick inserted the same week first
        return None
    return (made.data or [None])[0]


async def _finish(
    client: Any, run: dict[str, Any], status: str, stats: dict[str, Any], error: str | None = None
) -> None:
    await (
        client.table(RUNS)
        .update(
            {"status": status, "stats": stats, "error": error, "finished_at": datetime.now(UTC).isoformat()}
        )
        .eq("id", run["id"])
        .execute()
    )


async def run_radar(
    client: Any,
    http: httpx.AsyncClient,
    *,
    user_id: str,
    radar: str,
    settings_row: dict[str, Any] | None = None,
    now: datetime | None = None,
    force: bool = False,
) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    week = week_of(now)
    run = await _claim_run(client, user_id, radar, week, force=force)
    if run is None:
        return {"radar": radar, "week_of": week.isoformat(), "skipped": "already run this week"}
    cfg = dict(settings_row or {})
    try:
        if radar == "trend":
            feeds = [tuple(f) for f in cfg.get("feeds") or sources.TREND_FEEDS]
            slate, stats = await trend.build_slate(http, feeds=feeds, now=now)  # type: ignore[arg-type]
            rows = trend.topic_rows(slate)
        else:
            archive = (await client.table(ARCHIVE).select("*").eq("user_id", user_id).execute()).data or []
            pool, fresh, stats = await dev.gather(
                http,
                feeds=cfg.get("feeds") or sources.DEV_FEEDS,
                youtube_queries=cfg.get("youtube_queries") or sources.YOUTUBE_QUERIES,
                hn_queries=cfg.get("hn_queries") or sources.HN_QUERIES,
                youtube_key=get_settings().youtube_api_key,
                archive=archive,
                now=now,
            )
            for row in dev.archive_rows(user_id, fresh, now):
                await client.table(ARCHIVE).upsert(row, on_conflict="user_id,video_id").execute()
            rows = dev.topic_rows(dev.select(pool))
        if not rows:
            # n8n's guard: an outage week (HN down, feeds empty) keeps last week's slate.
            await _finish(client, run, "kept_previous", stats)
            return {"radar": radar, "week_of": week.isoformat(), "status": "kept_previous", "stats": stats}
        stored: list[dict[str, Any]] = []
        await (
            client.table(TOPICS)
            .delete()
            .eq("user_id", user_id)
            .eq("radar", radar)
            .eq("week_of", week.isoformat())
            .execute()
        )
        for r in rows:
            made = (
                await client.table(TOPICS)
                .insert({**r, "user_id": user_id, "radar": radar, "week_of": week.isoformat()})
                .execute()
            )
            stored.extend(made.data or [])
        stats["topics"] = len(stored)
        stats["newsletter_items"] = await feed_radar_slate(
            client, user_id, radar, stored, now.astimezone(UTC).date()
        )
        await _finish(client, run, "ok", stats)
        logger.info("radar.done", radar=radar, user_id=user_id, week_of=week.isoformat(), topics=len(stored))
        return {"radar": radar, "week_of": week.isoformat(), "status": "ok", "stats": stats}
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"[:500]
        logger.error("radar.failed", radar=radar, user_id=user_id, error=err)
        await _finish(client, run, "failed", {}, err)
        return {"radar": radar, "week_of": week.isoformat(), "status": "failed", "error": err}


async def radar_tick(client: Any, http: httpx.AsyncClient, *, now: datetime | None = None) -> dict[str, Any]:
    """Run every enabled subscription whose week is due and not yet run."""
    now = now or datetime.now(UTC)
    subs = (await client.table(SUBSCRIPTIONS).select("*").eq("enabled", True).execute()).data or []
    results = []
    for sub in subs:
        radar = str(sub.get("radar"))
        week = week_of(now)
        if now < due_at(radar, week):
            continue
        results.append(
            await run_radar(
                client,
                http,
                user_id=str(sub["user_id"]),
                radar=radar,
                settings_row=sub.get("settings") or {},
                now=now,
            )
        )
    return {"ran": [r for r in results if not r.get("skipped")], "checked": len(subs)}


async def latest_slate(client: Any, user_id: str, radar: str) -> list[dict[str, Any]]:
    resp = await (
        client.table(TOPICS)
        .select("*")
        .eq("user_id", user_id)
        .eq("radar", radar)
        .order("week_of", desc=True)
        .limit(200)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return []
    newest = max(str(r["week_of"]) for r in rows)
    return sorted((r for r in rows if str(r["week_of"]) == newest), key=lambda r: int(r["rank"]))
