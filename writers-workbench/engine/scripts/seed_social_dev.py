"""Set up the post calendar on DEV, and copy the n8n queue and slates into it (read-only on n8n).

    python scripts/seed_social_dev.py --seed          channels, radar subscriptions, the two editions
    python scripts/seed_social_dev.py --import-n8n    scheduled_blogs history + this week's slates

Reads from the environment, never from a file in the repo:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   must be DEV (gvbvwcnmjkdpclcisqrr); PROD is refused
    N8N_API_URL, N8N_API_KEY                  only for --import-n8n; only GET requests are made

Idempotent: channels / subscriptions / editions / feed sources are upserts, and imported posts keep
their n8n externalId, so a second import adds only rows that are new since the first.

Imported posts keep their n8n "#N" and state. Their deliveries are reconstructed from n8n's result
strings: n8n stored one free-text line per post, so a channel counts as delivered when its line does
not say FAILED, and the original text is kept in the delivery's ``detail``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

DEV_REF = "gvbvwcnmjkdpclcisqrr"
PROD_REF = "faklxfakgzkpkbxfihzh"
USER = "+14105914612"
ET = ZoneInfo("America/New_York")

TABLES = {
    "scheduled_blogs": "bp9vxcmZY1KuJPqZ",
    "content_topics": "w4v46dVFfcqT0GEn",
    "dev_content_topics": "SAlxHCkg8CG8JJHj",
    "dev_video_archive": "D7joILMPMDustkCv",
}

CHANNELS = [
    {"channel": "website", "kind": "website", "label": "TechAhir website",
     "config": {"endpoint": "https://www.techahir.com/api/blog", "public_base": "https://www.techahir.com/blog/",
                "author": "Tech Ahir", "auth_header": os.environ.get("TECHAHIR_BLOG_API_HEADER", "Authorization"),
                "auth_env": "TECHAHIR_BLOG_API_KEY"}},
    {"channel": "li_techahir", "kind": "linkedin", "label": "TechAhir LinkedIn page",
     "config": {"account_id": "9115", "page_id": "104364682"}},
    {"channel": "li_agile", "kind": "linkedin", "label": "Agile Ad Testing LinkedIn page",
     "config": {"account_id": "9115", "page_id": "109837978"}},
    {"channel": "li_personal", "kind": "linkedin", "label": "Personal LinkedIn profile",
     "config": {"account_id": "9115"}},
]

EDITIONS = [
    {"id": "ai-mvp", "display_name": "The MVP Brief", "subheader": "What founders need to ship before they pitch",
     "genre": "ai", "newsletter_name": "A TechAhir Weekly", "cadence": "weekly", "cadence_send_time": "09:00 fri",
     "description": "Weekly: the Trend Radar slate and the TechAhir blog posts that went out this week.",
     "feeds": [("Trend Radar", "radar://trend", "radar"), ("TechAhir blog posts", "social://trend_batch", "social_queue")]},
    {"id": "ai-dev-roundup", "display_name": "AI Dev Roundup", "subheader": "This week in AI + software development",
     "genre": "ai", "newsletter_name": "A TechAhir Weekly", "cadence": "weekly", "cadence_send_time": "09:00 fri",
     "description": "Weekly: the Dev Radar slate and the roundup posts that went out this week.",
     "feeds": [("Dev Radar", "radar://dev", "radar"), ("Roundup posts", "social://roundup_batch", "social_queue")]},
]


def _env(name: str) -> str:
    value = (os.environ.get(name) or "").strip().strip('"')
    if not value:
        sys.exit(f"{name} is not set")
    return value


def _sb() -> tuple[str, dict[str, str]]:
    url = _env("SUPABASE_URL").rstrip("/")
    if PROD_REF in url or DEV_REF not in url:
        sys.exit(f"refusing: SUPABASE_URL is not DEV ({DEV_REF})")
    key = _env("SUPABASE_SERVICE_ROLE_KEY")
    return url, {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _req(method: str, url: str, headers: dict[str, str], body: Any = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={**headers, "User-Agent": "seed-social-dev"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


def upsert(table: str, rows: list[dict[str, Any]], on_conflict: str) -> int:
    if not rows:
        return 0
    url, headers = _sb()
    out = _req("POST", f"{url}/rest/v1/{table}?on_conflict={on_conflict}",
               {**headers, "Prefer": "resolution=merge-duplicates,return=representation"}, rows)
    return len(out or [])


def select(table: str, query: str) -> list[dict[str, Any]]:
    url, headers = _sb()
    return _req("GET", f"{url}/rest/v1/{table}?{query}", headers) or []


def seed() -> None:
    n = upsert("social_channels_v2", [{"user_id": USER, "enabled": True, **c} for c in CHANNELS], "user_id,channel")
    print(f"channels: {n}")
    subs = [
        {"user_id": USER, "radar": "trend", "enabled": True,
         "settings": {"channels": ["website", "li_techahir", "li_agile", "li_personal"], "edition_id": "ai-mvp"}},
        {"user_id": USER, "radar": "dev", "enabled": True,
         "settings": {"channels": ["li_techahir", "li_agile", "li_personal"], "edition_id": "ai-dev-roundup"}},
    ]
    print(f"radar subscriptions: {upsert('radar_subscriptions_v2', subs, 'user_id,radar')}")
    for e in EDITIONS:
        feeds = e["feeds"]
        row = {k: v for k, v in e.items() if k != "feeds"}
        upsert("newsletter_editions_v2", [{**row, "user_id": USER, "enabled": True}], "id")
        existing = {r["url"] for r in select("newsletter_feed_sources_v2",
                                             f"select=url&user_id=eq.{urllib.parse.quote(USER)}&edition_id=eq.{e['id']}")}
        new = [{"user_id": USER, "edition_id": e["id"], "name": name, "url": url, "url_type": kind, "active": True,
                "fetch_interval_minutes": 1440} for name, url, kind in feeds if url not in existing]
        if new:
            u, h = _sb()
            _req("POST", f"{u}/rest/v1/newsletter_feed_sources_v2", {**h, "Prefer": "return=minimal"}, new)
        print(f"edition {e['id']}: sources +{len(new)}")


def n8n_rows(table_id: str) -> list[dict[str, Any]]:
    base = _env("N8N_API_URL").rstrip("/")
    base = base if base.endswith("/api/v1") else f"{base}/api/v1"
    headers = {"X-N8N-API-KEY": _env("N8N_API_KEY"), "Accept": "application/json", "User-Agent": "Mozilla/5.0"}
    out: list[dict[str, Any]] = []
    cursor = ""
    while True:
        url = f"{base}/data-tables/{table_id}/rows?limit=100" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
        page = _req("GET", url, headers)
        out.extend(page.get("data") or [])
        cursor = page.get("nextCursor") or ""
        if not cursor:
            return out


def _channels(row: dict[str, Any]) -> list[str]:
    chans = [c.strip() for c in str(row.get("channels") or "").lower().split(",") if c.strip()]
    results = f"{row.get('resultUrl') or ''} {row.get('linkedinResult') or ''}".lower()
    # n8n posted LinkedIn rows to the personal profile too, but only from some point on. Count the
    # profile as a channel of the post only where n8n's result says it went there.
    if "personal" in results and "li_personal" not in chans:
        chans.append("li_personal")
    return chans or ["website"]


def _scheduled_at(day: str, slot: str) -> str:
    d = date.fromisoformat(day)
    return datetime(d.year, d.month, d.day, 14 if slot == "afternoon" else 9, tzinfo=ET).isoformat()


def _deliveries(row: dict[str, Any], channels: list[str], schedule_id: str) -> list[dict[str, Any]]:
    if row.get("state") not in ("posted", "failed"):
        return []
    web = str(row.get("resultUrl") or "")
    li_parts = [p.strip() for p in str(row.get("linkedinResult") or row.get("resultUrl") or "").split("|") if p.strip()]
    out = []
    for c in channels:
        if c == "website":
            text = web if "website" in web.lower() else ""
        else:
            name = {"li_techahir": "techahir", "li_agile": "agile", "li_personal": "personal"}.get(c, c)
            text = next((p for p in li_parts if name in p.lower()), "")
        ok = bool(text) and "failed" not in text.lower()
        url = next((w for w in text.replace("—", " ").split() if w.startswith("https://") and "localhost" not in w), None)
        out.append({"schedule_id": schedule_id, "channel": c, "status": "published" if ok else "failed",
                    "attempts": 1, "public_url": url.rstrip(".") if url else None,
                    "detail": ("imported from n8n: " + text)[:1000] if text else "imported from n8n: no result recorded"})
    return out


def import_n8n() -> None:
    rows = n8n_rows(TABLES["scheduled_blogs"])
    have = {r["external_id"] for r in select("social_schedule_v2", f"select=external_id&user_id=eq.{urllib.parse.quote(USER)}&limit=5000")}
    numbers = {r["display_number"] for r in select("social_schedule_v2", f"select=display_number&user_id=eq.{urllib.parse.quote(USER)}&limit=5000")}
    added = 0
    for r in sorted(rows, key=lambda x: int(x.get("id") or 0)):
        ext = str(r.get("externalId") or f"n8n-{r.get('id')}")
        if ext in have or not r.get("scheduledDate"):
            continue
        chans = _channels(r)
        num = int(r.get("displayNumber") or 0)
        state = {"posted": "posted", "failed": "failed", "pending": "pending"}.get(str(r.get("state")), "failed")
        post = {
            "user_id": USER, "external_id": ext, "display_number": num if num and num not in numbers else 0,
            "title": str(r.get("title") or "Untitled")[:500], "body_md": str(r.get("body") or ""),
            "linkedin_content": str(r.get("linkedinContent") or ""), "seo_title": str(r.get("seoTitle") or "")[:120],
            "meta_description": str(r.get("metaDescription") or "")[:300],
            "category": str(r.get("category") or "INSIGHTS").upper()[:60],
            "include_image": str(r.get("includeImage") or "").lower() == "yes",
            "post_status": "draft" if r.get("postStatus") == "draft" else "published", "channels": chans,
            "scheduled_date": str(r["scheduledDate"])[:10], "slot": "afternoon" if r.get("slot") == "afternoon" else "morning",
            "scheduled_at": _scheduled_at(str(r["scheduledDate"])[:10], str(r.get("slot") or "")),
            # A pending n8n row is still n8n's to post: imported as cancelled so DEV never posts it too.
            "state": "cancelled" if state == "pending" else state,
            # No retries left: an imported failure is history, never something to post again on its own.
            "posted_at": r.get("postedAt") or None, "attempts": 3 if state == "failed" else (1 if state != "pending" else 0),
            "source": "n8n_import",
            "item_type": "video" if str(r.get("category")).upper() == "VIDEO" else ("blog" if r.get("body") else "article"),
        }
        u, h = _sb()
        made = _req("POST", f"{u}/rest/v1/social_schedule_v2", {**h, "Prefer": "return=representation"}, post)[0]
        numbers.add(made["display_number"])
        dels = _deliveries(r, chans, made["id"])
        if dels:
            _req("POST", f"{u}/rest/v1/social_schedule_deliveries_v2", {**h, "Prefer": "return=minimal"}, dels)
        added += 1
    print(f"scheduled_blogs: {len(rows)} in n8n, {added} imported")

    week = _monday(datetime.now(ET).date())
    trend = n8n_rows(TABLES["content_topics"])
    trend_rows = [{"user_id": USER, "radar": "trend", "week_of": week.isoformat(), "rank": int(t["rank"]),
                   "title": t.get("title") or "", "url": t.get("link") or "", "source": t.get("source") or "",
                   "angle": t.get("angle") or "", "category": t.get("driverType") or "", "driver_type": t.get("driverType"),
                   "client_relevance": t.get("clientRelevance"), "score": int(t["score"]) if str(t.get("score") or "").isdigit() else None,
                   "summary": t.get("summary") or ""} for t in trend if str(t.get("rank") or "").isdigit() and t.get("link")]
    dev = n8n_rows(TABLES["dev_content_topics"])
    dev_rows = [{"user_id": USER, "radar": "dev", "week_of": week.isoformat(), "rank": int(t["rank"]),
                 "title": t.get("title") or "", "url": t.get("url") or "", "source": t.get("source") or "",
                 "item_type": "video" if t.get("type") == "video" else "article", "angle": t.get("angle") or "",
                 "category": t.get("category") or ""} for t in dev if str(t.get("rank") or "").isdigit() and t.get("url")]
    print(f"slates: trend {upsert('radar_topics_v2', trend_rows, 'user_id,radar,week_of,rank')}, "
          f"dev {upsert('radar_topics_v2', dev_rows, 'user_id,radar,week_of,rank')} (week of {week})")
    vids = n8n_rows(TABLES["dev_video_archive"])
    arch = [{"user_id": USER, "video_id": v["videoId"], "title": v.get("title") or "", "url": v.get("url") or "",
             "source": v.get("source") or "", "channel": v.get("channel") or "", "published_at": v.get("date") or None,
             "pulled_at": v.get("pulledAt") or datetime.now(ET).isoformat()} for v in vids if v.get("videoId")]
    print(f"video archive: {upsert('radar_video_archive_v2', arch, 'user_id,video_id')}")


def _monday(d: date) -> date:
    return d + timedelta(days=1) if d.weekday() == 6 else d - timedelta(days=d.weekday())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--import-n8n", action="store_true")
    args = ap.parse_args()
    if not (args.seed or args.import_n8n):
        ap.error("pick --seed and/or --import-n8n")
    if args.seed:
        seed()
    if args.import_n8n:
        import_n8n()
