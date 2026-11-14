"""CR-009 — email the result + task metadata when an engine write task completes (n8n parity).

Every n8n writing workflow emailed its result on completion (recipient from the per-user record or the
``app_config`` recipient_email/bcc_email). The engine has the transport (Postal + notify_step) but no
write tool invoked it, so engine tasks completed silently. This module is the single completion-email
builder, called from the arq worker after any load-bearing write tool finishes. Best-effort: a mail
failure must never affect the job.
"""

from __future__ import annotations

from html import escape
from typing import Any

from writer_engine.config import get_settings
from writer_engine.library_helpers.email_recipients import resolve_recipients
from writer_engine.postal import send_email
from writer_engine.telemetry.logging import get_logger

logger = get_logger("task_email")

# Tools whose completion produces a user-facing artifact worth emailing.
_EMAIL_TOOLS = {"chapter", "brainstorm", "research", "media"}
_LABELS = {"chapter": "Chapter", "brainstorm": "Outline", "research": "Research report", "media": "Media"}
_BODY_SNIPPET_CHARS = 20000  # cap the inlined prose so the email isn't enormous


async def _load_recipients(client: Any, user_id: str | None):
    """Recipient precedence: app_config_v2.recipient_email (user) > users_v2.email > the global
    app_config_global_v2 value. See ``load_recipient_config``."""
    from writer_engine.library_helpers.email_recipients import load_recipient_config

    return resolve_recipients(config=await load_recipient_config(client, user_id))


def _deliverable_html(tool: str, op: str, result: dict) -> str:
    """G1: render the ACTUAL produced work as HTML for the completion email — not a bare 'ready' notice.

    Each tool stores its deliverable in a different place, so a single ``result.content_text`` check
    (the old behaviour) only ever caught chapter prose:
      * research.run   → ``result.row.report_markdown`` (the full report + citations)
      * brainstorm.*   → ``result.outline`` (premise + characters + chapters) — rendered from JSON
      * media.cover-art→ ``result.image_url`` — embedded as an <img> so the art is IN the email
      * media.social-posts → ``{platform: post}`` — each post rendered
      * chapter.* / blog / newsletter / short-story → ``result.content_text``
    """
    from writer_engine.library_helpers.markdown_html import markdown_to_html

    # research report
    if tool == "research":
        row = result.get("row") or {}
        md = row.get("report_markdown") or result.get("report_markdown") or result.get("content") or ""
        if md:
            return "<hr>" + markdown_to_html(str(md))

    # brainstormed outline
    if tool == "brainstorm":
        outline = result.get("outline")
        if isinstance(outline, dict) and outline:
            from writer_engine.library_helpers.outline_render import render_outline_markdown

            return "<hr>" + markdown_to_html(render_outline_markdown(outline))

    # media: cover art image / social posts
    if tool == "media":
        if op == "cover-art" or result.get("image_url"):
            url = result.get("image_url") or ""
            if url and url.startswith("http"):
                return (
                    "<hr><p style='font-family:system-ui,sans-serif'>Generated cover art:</p>"
                    f"<p><img src='{escape(url)}' alt='cover art' "
                    "style='max-width:480px;width:100%;border-radius:8px'/></p>"
                    f"<p style='font-size:12px;color:#888'>{escape(url)}</p>"
                )
        # social-posts: result is a {platform: post} mapping
        posts = {
            k: v
            for k, v in result.items()
            if isinstance(v, str) and k not in {"note", "provider", "prompt", "error"}
        }
        if posts:
            blocks = "".join(
                f"<h3 style='font-family:system-ui,sans-serif;margin:12px 0 4px'>{escape(k.title())}</h3>"
                f"<div style='font-family:system-ui,sans-serif;white-space:pre-wrap'>{escape(str(v))}</div>"
                for k, v in posts.items()
            )
            return "<hr>" + blocks

    # everything with inline prose (chapters, blog, newsletter, short story)
    prose = result.get("content_text") or result.get("content") or ""
    if prose:
        snippet = str(prose)[:_BODY_SNIPPET_CHARS] + (
            "\n\n… (truncated; open in the Workbench for the full text)"
            if len(str(prose)) > _BODY_SNIPPET_CHARS
            else ""
        )
        return (
            "<hr><div style='font-family:Georgia,serif;font-size:15px;line-height:1.6;"
            f"white-space:pre-wrap'>{escape(snippet)}</div>"
        )
    return ""


_SERIES_PIECE_OPS = {
    "draft-book-coda": "Closing scene",
    "draft-book-recap": "Recap",
    "check-book-coda": "Closing scene check",
}


def _series_piece_email(op: str, body: dict, result: dict) -> tuple[str, str]:
    """The email for a drafted closing scene or recap: the text itself, what the engine checked, and what to do
    next. A refusal says why, because a job that ends quietly looks like nothing happened."""
    label = _SERIES_PIECE_OPS[op]
    raw_book = body.get("book")
    book: dict[str, Any] = raw_book if isinstance(raw_book, dict) else {}
    where = f"Book {book.get('index')}" if book.get("index") is not None else "your book"
    project = body.get("title") or body.get("series_name") or body.get("project_id") or "your project"
    sans = "font-family:system-ui,sans-serif"
    if not result.get("ok"):
        reason = escape(str(result.get("reason") or "no reason was given"))
        subject = f"[Writer's Workbench] {label} for {where} could not be drafted — {project}"
        html = (
            f"<h2 style='{sans}'>The {label.lower()} for {escape(where)} could not be drafted</h2>"
            f"<p style='{sans}'>{reason}</p>"
            f"<p style='{sans}'>Nothing in your book changed. You can try again from the Series panel on the Publish page.</p>"
        )
        return subject, html
    if op == "check-book-coda":
        problems = result.get("problems") or []
        subject = f"[Writer's Workbench] Closing scene checked for {where} — {project}"
        verdict = (
            "<p style='" + sans + "'>The continuity check passed. It can be added to the book.</p>"
            if not problems
            else "<p style='"
            + sans
            + "'>Still to fix before it can be added:</p><ul style='"
            + sans
            + "'>"
            + "".join(f"<li>{escape(str(x))}</li>" for x in problems)
            + "</ul>"
        )
        return subject, f"<h2 style='{sans}'>Closing scene check for {escape(where)}</h2>{verdict}"
    qa = result.get("qa") or {}
    qa_vals = {k: v for k, v in qa.items() if isinstance(v, (int, float))}
    weakest = min(qa_vals.items(), key=lambda kv: kv[1]) if qa_vals else None
    drift = result.get("drift") or {}
    findings = len(drift.get("findings") or []) if isinstance(drift, dict) else 0
    rows = [
        ("For", f"{where}, chapter {result.get('chapter_number')}: {result.get('chapter_title')}"),
        ("Words", f"{result.get('words'):,}" if result.get("words") else None),
        ("Ends on", result.get("hook")),
        ("Settles", result.get("resolved")),
        ("Carries forward", result.get("carried")),
        ("Researched", ", ".join(map(str, result.get("research_topics") or [])) or None),
        (
            "Already in your book, not caused by this scene",
            "; ".join(result.get("existing_inconsistencies") or []) or None,
        ),
        (
            "Drift check",
            (f"{findings} finding(s) corrected or noted" if findings else "no drift found")
            if op == "draft-book-coda"
            else None,
        ),
        ("Weakest craft score", f"{weakest[0].replace('_', ' ')} {weakest[1]:.2f}" if weakest else None),
        ("Names not yet in the book", ", ".join(result.get("new_names") or []) or None),
    ]
    table = "".join(
        f"<tr><td style='padding:2px 12px 2px 0;color:#666;vertical-align:top'>{escape(k)}</td><td style='padding:2px 0'>{escape(str(v))}</td></tr>"
        for k, v in rows
        if v
    )
    subject = f"[Writer's Workbench] {label} drafted for {where} — {project}"
    html = (
        f"<h2 style='{sans}'>The {label.lower()} for {escape(where)} is drafted</h2>"
        f"<table style='{sans};font-size:14px'>{table}</table>"
        "<p style='font-family:system-ui,sans-serif'>It is in the Series panel on the Publish page, ready to read and edit. "
        "It goes into the book when you add it.</p>"
        "<hr><div style='font-family:Georgia,serif;font-size:15px;line-height:1.6;white-space:pre-wrap'>"
        f"{escape(str(result.get('text') or ''))}</div>"
    )
    return subject, html


def build_task_email(tool: str, body: dict, result: dict) -> tuple[str, str]:
    """Return (subject, html) for a completed task — the deliverable + a metadata block."""
    op = str(body.get("op") or "")
    if tool == "chapter" and op in _SERIES_PIECE_OPS:
        return _series_piece_email(op, body, result)
    chapter = body.get("chapter_number")
    # G8: thread the work's own title (research topic / outline title / content title) into the label.
    result_title = (
        (result.get("row") or {}).get("topic")
        or (result.get("outline") or {}).get("title")
        or result.get("title")
    )
    project = (
        body.get("title")
        or body.get("project_title")
        or result_title
        or body.get("project_id")
        or "your project"
    )
    label = _LABELS.get(tool, tool.title())
    what = f"{label} {chapter}".strip() if chapter is not None else label
    subject = f"[Writer's Workbench] {what} — {project} is ready"

    drift = result.get("drift_report") or {}
    qa = result.get("craft_qa") or {}
    qa_vals = [v for v in qa.values() if isinstance(v, (int, float))]
    qa_avg = round(sum(qa_vals) / len(qa_vals), 2) if qa_vals else None
    tok = result.get("token_usage") or {}
    research_used = result.get("research_used") or result.get("research_gaps_filled") or []
    command = body.get("directive") or body.get("originalUserPrompt") or body.get("message") or ""

    meta = [
        ("Task", f"{tool}.{op}" if op else tool),
        ("Project", project),
        ("Chapter", chapter) if chapter is not None else None,
        ("Words", f"{result.get('word_count'):,}") if result.get("word_count") else None,
        ("Aligned to outline", drift.get("aligned")) if drift else None,
        ("Craft QA", qa_avg) if qa_avg is not None else None,
        ("Research used", ", ".join(map(str, research_used))) if research_used else None,
        ("Tokens", f"{tok.get('total_tokens'):,} (${tok.get('cost_usd')})")
        if tok.get("total_tokens")
        else None,
        ("Your request", command) if command else None,
    ]
    rows_html = "".join(
        f"<tr><td style='padding:2px 12px 2px 0;color:#666'>{escape(str(k))}</td>"
        f"<td style='padding:2px 0'>{escape(str(v))}</td></tr>"
        for item in meta
        if item
        for k, v in [item]
    )
    html = (
        f"<h2 style='font-family:system-ui,sans-serif'>{escape(what)} is ready</h2>"
        f"<table style='font-family:system-ui,sans-serif;font-size:14px'>{rows_html}</table>"
    )
    html += _deliverable_html(tool, op, result)  # G1: embed the actual produced work
    return subject, html


# Map a lifecycle ACTION (not status) to the past-tense verb used in the email. Actions that don't
# notify (plain back-to-draft, unschedule) are absent → no email, matching n8n.
_LIFECYCLE_VERB = {
    "approve": "approved",
    "publish": "published",
    "reject": "rejected",
    "schedule": "scheduled",
    "delete": "deleted",
    "undelete": "restored to drafts",
}


async def send_lifecycle_email(
    client: Any, user_id: str | None, content: dict, new_status: str, action: str | None = None
) -> bool:
    """Notify the user that a piece of content changed lifecycle state (approve/publish/reject/schedule/
    delete/undelete). Mirrors n8n manage_library's Gmail node. Best-effort: a mail failure must never
    affect the lifecycle DB write. ``content`` is the post-update row; ``action`` selects the verb."""
    verb = _LIFECYCLE_VERB.get((action or "").lower())
    if verb is None:  # draft / unschedule — no notification, matching n8n
        return False
    try:
        settings = get_settings()
        rec = await _load_recipients(client, user_id)
        if not rec.to:
            logger.info("lifecycle_email.no_recipient", status=new_status)
            return False
        title = escape(str(content.get("title") or "Untitled"))
        ctype = escape(str(content.get("content_type") or "content"))
        when = content.get("metadata", {})
        sched = ""
        if new_status == "scheduled" and isinstance(when, dict) and when.get("schedule_date"):
            sched = f" for {escape(str(when['schedule_date']))}"
        subject = f'[Writer\'s Workbench] "{content.get("title") or "Untitled"}" {verb}'
        html = (
            f"<p>Your {ctype} <strong>{title}</strong> has been <strong>{verb}</strong>{sched}.</p>"
            f"<p>Status: {escape(new_status)}</p>"
        )
        res = await send_email(
            to=[rec.to],
            from_addr=settings.newsletter_from_address,
            subject=subject,
            html=html,
            bcc=[rec.bcc] if rec.bcc else None,
        )
        logger.info(
            "lifecycle_email.sent", to=rec.to, status=new_status, message_id=getattr(res, "message_id", None)
        )
        return True
    except Exception as exc:  # noqa: BLE001 - a mail failure must never touch the DB write; Postal errors vary
        logger.warning("lifecycle_email.failed", status=new_status, error=str(exc)[:200])
        return False


async def send_task_completion_email(tool: str, body: dict, result: dict | None) -> bool:
    """Email the configured recipient that ``tool`` finished. Returns True if a mail was sent.
    Best-effort and opt-out-able (``body['notify'] is False``)."""
    if tool not in _EMAIL_TOOLS or not result or body.get("notify") is False:
        return False
    # Don't email the user for E2E-fixture projects. The regression suite runs chapter.write etc.
    # against disposable projects titled "E2E …" (e.g. "E2E Write 1783…"), which are intentionally
    # tiny (a single-sub-chapter outline for speed) — a real user shouldn't get "Chapter 1 … ready"
    # mails for those 1,300-word test artifacts. Real projects are never named this way.
    _title = str(body.get("title") or body.get("project_title") or body.get("project") or "")
    if _title[:4].lower() == "e2e ":
        return False
    settings = get_settings()
    if not (settings.supabase_url and settings.supabase_service_role_key):
        return False
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        rec = await _load_recipients(client, body.get("user_id"))
        if not rec.to:
            logger.info("task_email.no_recipient", tool=tool, chapter=body.get("chapter_number"))
            return False
        subject, html = build_task_email(tool, body, result)
        res = await send_email(
            to=[rec.to],
            from_addr=settings.newsletter_from_address,
            subject=subject,
            html=html,
            bcc=[rec.bcc] if rec.bcc else None,
        )
        logger.info(
            "task_email.sent",
            to=rec.to,
            tool=tool,
            chapter=body.get("chapter_number"),
            message_id=getattr(res, "message_id", None),
        )
        return True
    except Exception as exc:  # noqa: BLE001 - a mail failure must never touch the job; Postal errors vary
        logger.warning("task_email.failed", tool=tool, error=str(exc)[:200])
        return False
