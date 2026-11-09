"""Email a draft to its owner (preview), and email the week's slate as a digest.

Ports ``Studio - Email Post with Featured Image`` (oYxlkOY7J0eK4yxo) and the on-demand path of
``Dev Roundup - Weekly Digest Email`` (WiG2AmTTf6rUj6gS). Differences on purpose: the recipient is the
owner's own address (app_config recipient_email, then users_v2.email) instead of a hard-coded one, mail
goes through Postal like every other engine email, and no image is generated just to preview a draft
(the sketchnote is made once, when the post is published).
"""

from __future__ import annotations

from datetime import datetime
from html import escape
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

from writer_engine.config import get_settings
from writer_engine.library_helpers.email_recipients import load_recipient_config, resolve_recipients
from writer_engine.library_helpers.markdown_html import markdown_to_html

from .core import StudioEdition, StudioError, slate

_WRAP = (
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1f2937">'
    '<div style="background:#111827;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0">'
    '<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.75">{kicker}</div>'
    '<div style="font-size:20px;font-weight:bold;margin-top:4px">{title}</div></div>'
    '<div style="background:#fff;border:1px solid #e5e7eb;border-top:0;padding:22px;border-radius:0 0 8px 8px">'
    '{body}</div><p style="font-size:12px;color:#6b7280">{footer}</p></div>'
)


async def _recipient(client: Any, user_id: str) -> tuple[str, str | None]:
    cfg = await load_recipient_config(client, user_id)
    r = resolve_recipients(config=cfg)
    if not r.to:
        raise StudioError("NO_RECIPIENT", "No email address on your account to send it to")
    return r.to, r.bcc


def post_email_html(post: dict[str, Any]) -> str:
    parts: list[str] = []
    if str(post.get("body_md") or "").strip():
        parts.append(
            f'<p style="color:#6b7280;font-size:13px">SEO title: {escape(str(post.get("seo_title") or ""))}<br>'
            f"Meta: {escape(str(post.get('meta_description') or ''))}<br>Category: "
            f"{escape(str(post.get('category') or ''))}</p><h2>Blog</h2>{markdown_to_html(str(post.get('body_md')))}"
        )
    if str(post.get("linkedin_content") or "").strip():
        text = str(post.get("linkedin_content"))
        parts.append(
            f'<h2>LinkedIn ({len(text)} characters)</h2><div style="white-space:pre-wrap;border-left:3px solid '
            f'#2563eb;padding-left:12px">{escape(text)}</div>'
        )
    image = "a generated sketchnote when published" if post.get("include_image") else "none"
    if post.get("image_url"):
        # The chosen image is shown, not just linked: this preview is where the owner checks it.
        url = escape(str(post["image_url"]))
        parts.insert(
            0,
            f'<p><img src="{url}" alt="Chosen image" style="max-width:100%;height:auto;border-radius:6px"></p>',
        )
        image = f'<a href="{url}">the chosen image</a> (shown above)'
    parts.append(
        f'<p style="font-size:13px;color:#6b7280">Image: {image}. State: {escape(str(post.get("state")))}.</p>'
    )
    return _WRAP.format(
        kicker=f"Content Studio draft #{escape(str(post.get('display_number') or ''))}",
        title=escape(str(post.get("title") or "")),
        body="".join(parts),
        footer="Drafted in the Content Studio. Review before publishing.",
    )


async def email_post(client: Any, ed: StudioEdition, post: dict[str, Any]) -> dict[str, Any]:
    from writer_engine.postal.client import send_email

    to, bcc = await _recipient(client, ed.user_id)
    subject = f"Draft #{post.get('display_number')}: {str(post.get('title') or '')[:120]}"
    res = await send_email(
        to=[to],
        bcc=[bcc] if bcc else None,
        from_addr=get_settings().newsletter_from_address,
        subject=subject,
        html=post_email_html(post),
    )
    await _record_email(client, ed, post, to=to, subject=subject, message_id=res.message_id)
    return {
        "to": to,
        "subject": subject,
        "message_id": res.message_id,
        "message": f"Emailed #{post.get('display_number')} to {to}.",
    }


async def _record_email(
    client: Any, ed: StudioEdition, post: dict[str, Any], *, to: str, subject: str, message_id: str | None
) -> None:
    """Keep a record of the preview on the post (``studio.emails``, last 10): when, to whom, which
    Postal message, and which version of the text and image went out. Nothing recorded the send before,
    so "did my preview go out, and with which image?" had no answer outside Postal's own logs."""
    from datetime import UTC, datetime

    studio = dict(post.get("studio") or {})
    sent = list(studio.get("emails") or [])[-9:]
    sent.append(
        {
            "at": datetime.now(UTC).isoformat(),
            "to": to,
            "subject": subject,
            "message_id": message_id,
            "image_url": post.get("image_url"),
            "include_image": bool(post.get("include_image")),
            "state": post.get("state"),
            "updated_at": post.get("updated_at"),
        }
    )
    studio["emails"] = sent
    try:
        await (
            client.table("social_schedule_v2")
            .update({"studio": studio})
            .eq("id", str(post["id"]))
            .eq("user_id", ed.user_id)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001 - the email went out; failing to note it must not report a failed send
        from writer_engine.telemetry.logging import get_logger

        get_logger("studio.emailing").warning("studio.email_record_failed", error=str(exc)[:200])


_ET = ZoneInfo("America/New_York")


def _studio_url(edition_id: str) -> str:
    """Where the email's button goes: this edition's Content Studio chat in the Workbench."""
    base = (get_settings().workbench_api_url or "").rstrip("/")
    return f"{base}/newsletter/studio/{quote(edition_id, safe='')}" if base else ""


def _long_date(d: datetime) -> str:
    return f"{d.strftime('%A, %B')} {d.day}, {d.year}"


TREND_KICKER = "AI & Software Engineering Radar"
TREND_TITLE = "Weekly AI & Software Engineering Slate"


def _short_date(d: datetime) -> str:
    return f"{d.strftime('%b')} {d.day}, {d.year}"


def _score_colour(score: int) -> str:
    return "#b91c1c" if score >= 85 else "#c2410c" if score >= 70 else "#4b5563"


def trend_digest_html(
    name: str,
    week_of: str | None,
    topics: list[dict[str, Any]],
    *,
    studio_url: str = "",
    sent_on: datetime | None = None,
) -> str:
    """The Trend radar's slate email, as n8n's "AI & Software Engineering Radar" one was: a dark header,
    a "Want a draft?" box linking the studio, then a ranked table (#, score, title, driver · category)."""
    when = _short_date(sent_on) if sent_on else f"week of {week_of or ''}"
    rows = ""
    for t in topics:
        score = t.get("score")
        why = " · ".join(str(x) for x in (t.get("driver_type"), t.get("category")) if x)
        link = escape(str(t.get("url") or ""))
        title = escape(str(t.get("title") or ""))
        covered = t.get("also_covered_by") or []
        also = f" · also covered by {escape(', '.join(str(c) for c in covered))}" if covered else ""
        rows += (
            '<tr><td style="padding:8px 6px;border-bottom:1px solid #f3f4f6;color:#6b7280;vertical-align:top">'
            f'{t.get("rank")}</td><td style="padding:8px 6px;border-bottom:1px solid #f3f4f6;font-weight:bold;'
            f'vertical-align:top;color:{_score_colour(int(score or 0))}">{"" if score is None else score}</td>'
            '<td style="padding:8px 6px;border-bottom:1px solid #f3f4f6">'
            f'<a href="{link}" style="color:#111827;font-weight:bold;text-decoration:none">{title}</a><br>'
            f'<span style="color:#6b7280;font-size:12px">{escape(why)}{also}</span></td></tr>'
        )
    button = (
        f'<p style="margin:0 0 16px;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;'
        f'border-radius:6px;font-size:14px">📝 <b>Want a draft?</b> Open the '
        f'<a href="{escape(studio_url)}" style="color:#1d4ed8;font-weight:bold">Content Studio</a> and just '
        "tell it a topic number below — it researches the topic and drafts a blog post + LinkedIn post for you.</p>"
        if studio_url
        else ""
    )
    body = (
        f'{button}<div style="font-size:12px;letter-spacing:.08em;color:#6b7280;margin-bottom:6px">RANKED TOPICS</div>'
        '<table width="100%" cellspacing="0" style="font-size:14px"><tr style="font-size:11px;color:#9ca3af;'
        'text-align:left"><th style="padding:4px 6px">#</th><th style="padding:4px 6px">Score</th>'
        f"<th>Topic</th></tr>{rows}</table>"
    )
    return _WRAP.format(
        kicker=escape(TREND_KICKER),
        title=f'{escape(TREND_TITLE)}<br><span style="font-size:13px;font-weight:normal">Week of {escape(when)}'
        f" · {len(topics)} ranked topics</span>",
        body=body if topics else "<p>No slate this week.</p>",
        footer="Sent by your Writer's Workbench. The week's radar slate, from the Content Studio.",
    )


def digest_html(
    name: str,
    week_of: str | None,
    topics: list[dict[str, Any]],
    *,
    studio_url: str = "",
    sent_on: datetime | None = None,
    radar: str = "dev",
) -> str:
    """The slate email, as n8n's "This week in AI + software development" one was: a dated header, a
    button into the studio chat, then articles and videos, each with its link in full. The Trend radar
    has its own layout (``trend_digest_html``): a ranked, scored table."""
    if radar == "trend":
        return trend_digest_html(name, week_of, topics, studio_url=studio_url, sent_on=sent_on)
    arts = [t for t in topics if t.get("item_type") != "video" and t.get("url")]
    vids = [t for t in topics if t.get("item_type") == "video" and t.get("url")]

    def rows(items: list[dict[str, Any]], verb: str) -> str:
        return "".join(
            f'<tr><td style="padding:8px 0;border-bottom:1px solid #f3f4f6"><b>{t.get("rank")}. '
            f'{escape(str(t.get("title") or ""))}</b><br><span style="color:#6b7280;font-size:13px">'
            f"{escape(str(t.get('source') or ''))} · {escape(str(t.get('angle') or ''))}</span><br>"
            f'<a href="{escape(str(t.get("url")))}">{verb} → {escape(str(t.get("url")))}</a></td></tr>'
            for t in items
        )

    body = ""
    if studio_url:
        body += (
            f'<p style="margin:0 0 14px"><a href="{escape(studio_url)}" style="display:inline-block;'
            "background:#2563eb;color:#fff;text-decoration:none;font-weight:bold;padding:12px 18px;"
            f'border-radius:6px">✍️ Open the {escape(name)} studio → draft &amp; post</a></p>'
            '<p style="margin:0 0 18px;font-size:14px;color:#374151">In the studio, type a number to draft '
            "a post from that story (<i>generate 3</i>), then <i>approve</i>, <i>revise</i>, <i>post it</i> or "
            "<i>schedule for Tuesday afternoon</i>. <i>Commands</i> lists everything.</p>"
        )
    if arts:
        body += f'<h2>📰 Articles</h2><table width="100%">{rows(arts, "🔗 Read")}</table>'
    if vids:
        body += f'<h2>🎥 Videos</h2><table width="100%">{rows(vids, "🎥 Watch")}</table>'
    when = _long_date(sent_on) if sent_on else f"Week of {week_of or ''}"
    return _WRAP.format(
        kicker=escape(name),
        title=f"{escape(when)} · {len(arts)} articles + {len(vids)} videos",
        body=body or "<p>No slate this week.</p>",
        footer="Sent by your Writer's Workbench. The week's radar slate, from the Content Studio.",
    )


async def email_digest(client: Any, ed: StudioEdition, week_of: str | None = None) -> dict[str, Any]:
    from writer_engine.postal.client import send_email

    view = await slate(client, ed, week_of)
    to, bcc = await _recipient(client, ed.user_id)
    topics = view["topics"]
    arts = sum(1 for t in topics if t.get("item_type") != "video")
    sent_on = datetime.now(_ET)
    subject = (
        f"{TREND_KICKER} — {_short_date(sent_on)} — {len(topics)} topics"
        if ed.radar == "trend"
        else f"{ed.name} — {_long_date(sent_on)} ({arts}+{len(topics) - arts})"
    )
    res = await send_email(
        to=[to],
        bcc=[bcc] if bcc else None,
        from_addr=get_settings().newsletter_from_address,
        subject=subject,
        html=digest_html(
            ed.name,
            view["week_of"],
            topics,
            studio_url=_studio_url(ed.edition_id),
            sent_on=sent_on,
            radar=ed.radar,
        ),
    )
    record = await _record_digest(
        client,
        ed,
        to=to,
        subject=subject,
        message_id=res.message_id,
        week_of=view["week_of"],
        topics=len(topics),
        bcc=bcc,
    )
    return {
        "to": to,
        "subject": subject,
        "week_of": view["week_of"],
        "message_id": res.message_id,
        "sent_at": (record or {}).get("sent_at"),
        "recorded": record is not None,
        "message": f"Emailed the week's slate to {to}.",
    }


async def _record_digest(
    client: Any,
    ed: StudioEdition,
    *,
    to: str,
    subject: str,
    message_id: str | None,
    week_of: str | None,
    topics: int,
    bcc: str | None = None,
) -> dict[str, Any] | None:
    """Keep a record of the slate email (``newsletter_owner_emails_v2``, kind ``slate``, migration 052):
    to whom, which subject, which Postal message, when, for which edition and week. Mirrors the record
    a draft's email keeps on its post (``studio.emails``); a slate has no row of its own to hang it on,
    so it gets one. The email has gone out by now, so a failed record is logged, not raised."""
    from writer_engine.newsletter_send import record_owner_email

    return await record_owner_email(
        {
            "user_id": ed.user_id,
            "edition_id": ed.edition_id,
            "kind": "slate",
            "to_email": to,
            "subject": subject,
            "postal_message_id": message_id,
            "week_of": str(week_of)[:10] if week_of else None,
            "metadata": {"topics": topics, "radar": ed.radar, **({"bcc": bcc} if bcc else {})},
        },
        client=client,
    )
