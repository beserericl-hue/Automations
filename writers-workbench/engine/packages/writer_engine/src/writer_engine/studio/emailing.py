"""Email a draft to its owner (preview), and email the week's slate as a digest.

Ports ``Studio - Email Post with Featured Image`` (oYxlkOY7J0eK4yxo) and the on-demand path of
``Dev Roundup - Weekly Digest Email`` (WiG2AmTTf6rUj6gS). Differences on purpose: the recipient is the
owner's own address (app_config recipient_email, then users_v2.email) instead of a hard-coded one, mail
goes through Postal like every other engine email, and no image is generated just to preview a draft
(the sketchnote is made once, when the post is published).
"""

from __future__ import annotations

from html import escape
from typing import Any

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
    image = "a generated sketchnote" if post.get("include_image") else "none"
    if post.get("image_url"):
        image = f'<a href="{escape(str(post["image_url"]))}">chosen image</a>'
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
    res = await send_email(
        to=[to],
        bcc=[bcc] if bcc else None,
        from_addr=get_settings().newsletter_from_address,
        subject=f"Draft #{post.get('display_number')}: {str(post.get('title') or '')[:120]}",
        html=post_email_html(post),
    )
    return {
        "to": to,
        "message_id": res.message_id,
        "message": f"Emailed #{post.get('display_number')} to {to}.",
    }


def digest_html(name: str, week_of: str | None, topics: list[dict[str, Any]]) -> str:
    arts = [t for t in topics if t.get("item_type") != "video" and t.get("url")]
    vids = [t for t in topics if t.get("item_type") == "video" and t.get("url")]

    def rows(items: list[dict[str, Any]], verb: str) -> str:
        return "".join(
            f'<tr><td style="padding:8px 0;border-bottom:1px solid #f3f4f6"><b>{t.get("rank")}. '
            f'{escape(str(t.get("title") or ""))}</b><br><span style="color:#6b7280;font-size:13px">'
            f"{escape(str(t.get('source') or ''))} · {escape(str(t.get('angle') or ''))}</span><br>"
            f'<a href="{escape(str(t.get("url")))}">{verb} →</a></td></tr>'
            for t in items
        )

    body = ""
    if arts:
        body += f'<h2>📰 Articles</h2><table width="100%">{rows(arts, "🔗 Read")}</table>'
    if vids:
        body += f'<h2>🎥 Videos</h2><table width="100%">{rows(vids, "🎥 Watch")}</table>'
    return _WRAP.format(
        kicker=escape(name),
        title=f"Week of {escape(week_of or '')} · {len(arts)} articles + {len(vids)} videos",
        body=body or "<p>No slate this week.</p>",
        footer="The week's radar slate, from the Content Studio.",
    )


async def email_digest(client: Any, ed: StudioEdition, week_of: str | None = None) -> dict[str, Any]:
    from writer_engine.postal.client import send_email

    view = await slate(client, ed, week_of)
    to, bcc = await _recipient(client, ed.user_id)
    topics = view["topics"]
    arts = sum(1 for t in topics if t.get("item_type") != "video")
    res = await send_email(
        to=[to],
        bcc=[bcc] if bcc else None,
        from_addr=get_settings().newsletter_from_address,
        subject=f"{ed.name} — week of {view['week_of']} ({arts}+{len(topics) - arts})",
        html=digest_html(ed.name, view["week_of"], topics),
    )
    return {"to": to, "message_id": res.message_id, "message": f"Emailed the week's slate to {to}."}
